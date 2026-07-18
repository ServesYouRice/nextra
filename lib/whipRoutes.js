// lib/whipRoutes.js - WHIP HTTP endpoints for OBS ingest
'use strict';

const { Router } = require('express');
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { findRoomByCode } = require('./rooms');
const { parseOffer, validateCodecs, toMediasoupRtpParameters, createAnswer, parseDtlsParameters } = require('./whip');
const { createWebRtcTransport } = require('./mediasoup');
const { normalizeIp, parseForwardedFirst, shouldTrustForwardedHeaders } = require('./network');
const { extractNalUnitsFromRtp, collectParameterSets, buildSpropParameterSets } = require('./h264Sprop');
const { setWhipSessionCloser } = require('./roomLifecycle');
const { sessionRegistry } = require('./sessionRegistry');

/** Socket.IO server reference — set via setIo() after server init. */
let io = null;
let startFallbackRelay = async () => {};
let stopFallbackRelay = (room) => {
    const pipeline = room?._mediaPipeline;
    try { pipeline?.closeFallback(); } catch { }
    try { room?.fallbackWorker?.stop(); } catch { }
    if (room) room.fallbackWorker = null;
};
let emitHostMetrics = () => {};

/**
 * Set the Socket.IO server instance so WHIP can emit new-producer events.
 */
function setIo(ioInstance) {
    io = ioInstance;
}

function setMediaLifecycle(controller = {}) {
    if (typeof controller.startFallbackRelay === 'function') startFallbackRelay = controller.startFallbackRelay;
    if (typeof controller.stopFallbackRelay === 'function') stopFallbackRelay = controller.stopFallbackRelay;
    if (typeof controller.emitHostMetrics === 'function') emitHostMetrics = controller.emitHostMetrics;
}

let whipAllowedOriginCheck = null;

function setCorsHeaders(res) {
    // OBS and other non-browser WHIP clients don't send an Origin and ignore CORS.
    // For browser-based callers, reflect only origins the server already trusts
    // instead of a blanket '*'. Bearer-token auth remains the primary protection.
    const origin = res.req?.headers?.origin;
    if (origin && (typeof whipAllowedOriginCheck !== 'function' || whipAllowedOriginCheck(origin))) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Expose-Headers', 'Location');
}

function getRemoteAddressForReq(req) {
    return normalizeIp(
        req?.socket?.remoteAddress
        || req?.connection?.remoteAddress
        || 'unknown'
    );
}

function parseHostHeader(value) {
    const host = parseForwardedFirst(value);
    if (!host || host.includes('/') || host.includes('\\') || /\s/.test(host)) return '';

    try {
        return new URL(`http://${host}`).host;
    } catch {
        return '';
    }
}

function getWhipLocationBase(req) {
    let proto = req?.socket?.encrypted ? 'https' : 'http';
    let host = parseHostHeader(req?.headers?.host) || `localhost:${config.WHIP_HTTP_PORT}`;

    if (shouldTrustForwardedHeaders(getRemoteAddressForReq(req), config.TRUST_X_FORWARDED_HEADERS)) {
        const forwardedProto = parseForwardedFirst(req?.headers?.['x-forwarded-proto']).toLowerCase();
        const forwardedHost = parseHostHeader(req?.headers?.['x-forwarded-host']);
        if (forwardedProto === 'http' || forwardedProto === 'https') proto = forwardedProto;
        if (forwardedHost) host = forwardedHost;
    }

    return `${proto}://${host}`;
}

/**
 * Close any existing WHIP transport and producers on a room.
 */
function closeWhipSession(room) {
    room.whipGeneration = null;
    room.whipStarting = false;
    if (room.whipGraceTimer) {
        clearTimeout(room.whipGraceTimer);
        room.whipGraceTimer = null;
    }
    room.whipReconnecting = false;
    // Tear down the prewarmed fallback relay tied to this WHIP session.
    if (room.fallbackWorker) {
        try { stopFallbackRelay(room); } catch { }
    }
    if (room.whipProducer) {
        if (!room._mediaPipeline?.releaseWhip('video-producer')) {
            try { room.whipProducer.close(); } catch { }
        }
        room.whipProducer = null;
    }
    if (room.whipAudioProducer) {
        if (!room._mediaPipeline?.releaseWhip('audio-producer')) {
            try { room.whipAudioProducer.close(); } catch { }
        }
        room.whipAudioProducer = null;
    }
    if (room.whipTransport) {
        if (!room._mediaPipeline?.releaseWhip('transport')) {
            try { room.whipTransport.close(); } catch { }
        }
        room.whipTransport = null;
    }
    if (room.whipResourceId) {
        sessionRegistry.unregisterWhipResource(room.whipResourceId);
        room.whipResourceId = null;
    }
    room.whipSessionId = null;
    room.whipConnected = false;
    room.whipReconnecting = false;
}

setWhipSessionCloser(closeWhipSession);

/**
 * Capture H.264 SPS/PPS from the OBS producer's RTP stream and store them on the
 * room as sprop-parameter-sets. Used when the WHIP offer does not advertise them,
 * so the FFmpeg fallback relay can still learn the video dimensions. If a relay is
 * already running without sprop, it is restarted so it picks up the parameter sets.
 */
async function captureSpropFromStream(mediasoupRouter, room) {
    const producer = room.whipProducer;
    if (!producer) return;

    let transport = null;
    let consumer = null;
    let acc = { sps: null, pps: null };
    let finished = false;
    let packetCount = 0;
    let timer = null;
    let kfTimer = null;
    const nalTypesSeen = new Set();

    const cleanup = () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (kfTimer) clearInterval(kfTimer);
        try { if (consumer) consumer.close(); } catch {}
        try { if (transport) transport.close(); } catch {}
    };

    timer = setTimeout(() => {
        if (!room.fallbackH264Sprop) {
            console.warn(`[WHIP] sprop stream capture timed out for room ${room.code}: ${packetCount} RTP packets, NAL types seen [${[...nalTypesSeen].sort((a, b) => a - b).join(',')}] (no SPS/PPS)`);
        }
        cleanup();
    }, 12000);

    try {
        transport = await mediasoupRouter.createDirectTransport();
        consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: mediasoupRouter.rtpCapabilities,
        });
    } catch (err) {
        cleanup();
        throw err;
    }

    consumer.on('rtp', (packet) => {
        if (finished || room.fallbackH264Sprop) { cleanup(); return; }
        packetCount++;
        const nals = extractNalUnitsFromRtp(packet);
        for (const nal of nals) { if (nal.length) nalTypesSeen.add(nal[0] & 0x1f); }
        acc = collectParameterSets(nals, acc);
        if (acc.sps && acc.pps) {
            room.fallbackH264Sprop = buildSpropParameterSets(acc.sps, acc.pps);
            // Keep the raw NAL bytes so the relay's depacketizer can inject them
            // before every keyframe (OBS sends parameter sets only once at start).
            room.fallbackH264Sps = Buffer.from(acc.sps);
            room.fallbackH264Pps = Buffer.from(acc.pps);
            console.log(`[WHIP] Captured H264 sprop-parameter-sets from stream for room ${room.code} after ${packetCount} packets: sps=${acc.sps.length}B pps=${acc.pps.length}B`);
            // NOTE: do not touch the relay here. The prewarmed relay catches the same
            // keyframe (with in-band SPS) on its own consumer; stopping/restarting it
            // would kill the prewarm and lose the one keyframe OBS sends. This capture
            // only records the parameter sets as a seed for future use.
            cleanup();
        }
    });

    // Nudge OBS to emit a parameter-set-bearing keyframe, repeatedly until done.
    kfTimer = setInterval(() => {
        if (finished) { clearInterval(kfTimer); return; }
        consumer.requestKeyFrame().catch(() => {});
    }, 1000);
    try { await consumer.requestKeyFrame(); } catch {}
}

/**
 * Create a WHIP router that uses the given mediasoup router.
 * @param {object} mediasoupRouter - The mediasoup Router instance
 * @returns {Router} Express router
 */
function createWhipRouter(mediasoupRouter, options = {}) {
    if (typeof options.isAllowedOrigin === 'function') {
        whipAllowedOriginCheck = options.isAllowedOrigin;
    }

    const router = Router();
    const createTransport = typeof options.createWebRtcTransport === 'function'
        ? options.createWebRtcTransport
        : createWebRtcTransport;

    // CORS preflight
    router.options('/broadcast/:roomCode', (req, res) => {
        setCorsHeaders(res);
        res.status(204).end();
    });

    // POST /whip/broadcast/:roomCode — OBS sends SDP offer
    router.post(
        '/broadcast/:roomCode',
        express.raw({ type: 'application/sdp', limit: '10kb' }),
        async (req, res) => {
            let pendingTransport = null;
            let claimedRoom = null;
            let sessionGeneration = null;
            try {
                if (!config.WHIP_ENABLED) {
                    setCorsHeaders(res);
                    return res.status(404).json({ error: 'WHIP ingest is not enabled' });
                }

                const { roomCode } = req.params;
                const room = findRoomByCode(roomCode);
                if (!room) {
                    setCorsHeaders(res);
                    return res.status(404).json({ error: 'Room not found' });
                }

                if (room.ingestMode !== 'obs') {
                    setCorsHeaders(res);
                    return res.status(403).json({ error: 'Room is not configured for OBS ingest' });
                }

                // Verify host ownership via Bearer token
                const authHeader = req.headers.authorization || '';
                const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
                if (!token || token !== room.hostToken) {
                    setCorsHeaders(res);
                    return res.status(403).json({ error: 'Invalid or missing authorization token' });
                }

                if (room.whipStarting) {
                    setCorsHeaders(res);
                    return res.status(409).json({ error: 'A WHIP session is already starting for this room' });
                }
                // Replace existing session if OBS reconnects
                if (room.whipSessionId) {
                    console.log(`[WHIP] Replacing session ${room.whipSessionId} for room ${roomCode}`);
                    if (room.whipGraceTimer) {
                        clearTimeout(room.whipGraceTimer);
                        room.whipGraceTimer = null;
                    }
                    room.whipReconnecting = false;
                    closeWhipSession(room);
                }

                room.whipStarting = true;
                sessionGeneration = crypto.randomBytes(12).toString('hex');
                room.whipGeneration = sessionGeneration;
                claimedRoom = room;

                // Parse and validate the SDP offer
                const sdpBody = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body);
                console.log(`[WHIP] SDP offer has audio: ${/m=audio/.test(sdpBody)}`);
                const parsed = parseOffer(sdpBody, { preferAv1: room.obsAv1Mode });
                if (parsed.audio) {
                    console.log(`[WHIP] Audio codecs:`, JSON.stringify(parsed.audio.codecs));
                    console.log(`[WHIP] Audio selectedCodec:`, JSON.stringify(parsed.audio.selectedCodec));
                } else {
                    // Log the raw audio section for debugging
                    const audioIdx = sdpBody.indexOf('m=audio');
                    if (audioIdx >= 0) console.log(`[WHIP] Raw audio SDP:\n${sdpBody.substring(audioIdx, audioIdx + 300)}`);
                }

                if (parsed.video) {
                    console.log(`[WHIP] Video codecs:`, JSON.stringify(parsed.video.codecs.map(c => c.name)));
                    console.log(`[WHIP] Video selectedCodec:`, JSON.stringify(parsed.video.selectedCodec));
                    console.log(`[WHIP] Video fmtp (raw):`, JSON.stringify(parsed.video.fmtp));
                }

                const codecCheck = validateCodecs(parsed, {
                    allowAv1: room.obsAv1Mode,
                    requiredVideoCodec: room.obsAv1Mode ? 'av1' : 'h264',
                });
                if (!codecCheck.valid) {
                    setCorsHeaders(res);
                    return res.status(409).json({
                        error: room.obsAv1Mode
                            ? 'OBS WHIP ingest currently requires AV1 video for this room.'
                            : 'OBS WHIP ingest currently requires H.264 video.',
                        warnings: codecCheck.warnings,
                    });
                }
                if (codecCheck.warnings.length > 0) {
                    console.log(`[WHIP] Codec warnings for room ${roomCode}:`, codecCheck.warnings);
                }

                // Create WebRtcTransport for the WHIP connection
                console.log(`[WHIP] Creating WebRtcTransport for room ${roomCode}...`);
                const { transport, params } = await createTransport(mediasoupRouter);
                pendingTransport = transport;
                if (room.whipGeneration !== sessionGeneration) {
                    transport.close();
                    pendingTransport = null;
                    throw new Error('WHIP session was superseded during startup');
                }
                room.whipTransport = transport;
                room._mediaPipeline?.ownWhip('transport', transport);
                console.log(`[WHIP] Transport created: ${transport.id}`);

                // Connect transport with remote DTLS parameters from the offer
                const remoteDtls = parseDtlsParameters(parsed);
                console.log(`[WHIP] remoteDtls:`, JSON.stringify(remoteDtls));
                console.log(`[WHIP] parsed.video fingerprint:`, JSON.stringify(parsed.video?.fingerprint));
                console.log(`[WHIP] parsed.video setup:`, parsed.video?.setup);
                if (!remoteDtls) {
                    console.log(`[WHIP] No DTLS fingerprint — returning 400`);
                    transport.close();
                    setCorsHeaders(res);
                    return res.status(400).json({ error: 'No DTLS fingerprint in offer' });
                }
                // Prepare producers once DTLS connects — register listener BEFORE
                // calling transport.connect() to avoid missing the 'connected' event.
                const rtpParams = toMediasoupRtpParameters(parsed);
                // Guard against null SSRC (valid in some offers)
                if (rtpParams.video?.encodings?.[0]?.ssrc == null) delete rtpParams.video.encodings[0].ssrc;
                if (rtpParams.audio?.encodings?.[0]?.ssrc == null) delete rtpParams.audio?.encodings?.[0]?.ssrc;

                transport.on('dtlsstatechange', async (dtlsState) => {
                    if (dtlsState === 'connected') {
                        try {
                            if (room.whipGeneration !== sessionGeneration || room.whipTransport !== transport) return;
                            if (rtpParams.video) {
                                room.whipProducer = await transport.produce({
                                    kind: 'video',
                                    rtpParameters: rtpParams.video,
                                });
                                room._mediaPipeline?.ownWhip('video-producer', room.whipProducer);
                                if (room.whipGeneration !== sessionGeneration) {
                                    room.whipProducer.close();
                                    room.whipProducer = null;
                                    return;
                                }
                                console.log(`[WHIP] Video producer created for room ${roomCode}; rtcpFeedback=${JSON.stringify(room.whipProducer.rtpParameters.codecs[0].rtcpFeedback)}`);
                            }
                            if (rtpParams.audio) {
                                room.whipAudioProducer = await transport.produce({
                                    kind: 'audio',
                                    rtpParameters: rtpParams.audio,
                                });
                                room._mediaPipeline?.ownWhip('audio-producer', room.whipAudioProducer);
                                if (room.whipGeneration !== sessionGeneration) {
                                    room.whipAudioProducer.close();
                                    room.whipAudioProducer = null;
                                    return;
                                }
                                console.log(`[WHIP] Audio producer created for room ${roomCode}`);
                            }
                            room.whipConnected = true;
                            room.obsVideoCodec = codecCheck.videoCodec;
                            room.fallbackCodec = codecCheck.videoCodec === 'h264' ? codecCheck.videoCodec : null;
                            room.fallbackAudioCodec = codecCheck.videoCodec === 'h264' && rtpParams.audio ? 'aac' : null;

                            // Immediately notify host that OBS connected
                            console.log(`[WHIP] Notifying host for room ${roomCode}, io=${!!io}, whipConnected=${room.whipConnected}`);
                            if (io) {
                                emitHostMetrics(io, roomCode);
                            }

                            // Notify already-joined viewers that producers are now available
                            if (io) {
                                if (room.whipProducer) {
                                    io.to(roomCode).emit('new-producer', {
                                        producerId: room.whipProducer.id,
                                        kind: 'video',
                                    });
                                }
                                if (room.whipAudioProducer) {
                                    io.to(roomCode).emit('new-producer', {
                                        producerId: room.whipAudioProducer.id,
                                        kind: 'audio',
                                    });
                                }
                            }
                            // Store actual H264 profile-level-id for correct MSE MIME type
                            if (codecCheck.videoCodec === 'h264' && parsed.video?.selectedCodec?.profileLevelId) {
                                room.fallbackH264Profile = parsed.video.selectedCodec.profileLevelId.toLowerCase();
                            } else {
                                room.fallbackH264Profile = null;
                            }
                            // Capture H264 SPS/PPS (sprop-parameter-sets) from the offer so the
                            // fallback relay can hand them to FFmpeg out-of-band. OBS does not
                            // always repeat parameter sets in-band, which leaves FFmpeg unable to
                            // determine video dimensions ("unspecified size") and blocks the MP4
                            // init segment. Requires both SPS and PPS (comma-separated) to be useful.
                            if (codecCheck.videoCodec === 'h264' && parsed.video?.selectedCodec) {
                                const videoFmtp = parsed.video.fmtp?.[parsed.video.selectedCodec.payloadType] || {};
                                const sprop = (videoFmtp['sprop-parameter-sets'] || '').trim();
                                room.fallbackH264Sprop = (sprop && sprop.includes(',')) ? sprop : null;
                            } else {
                                room.fallbackH264Sprop = null;
                            }
                            console.log(`[WHIP] Fallback H264 sprop-parameter-sets for room ${roomCode}: ${room.fallbackH264Sprop ? 'captured from offer' : 'NOT present in offer'}`);
                            // If the offer didn't advertise SPS/PPS, capture them from the
                            // producer's RTP so the relay can still set video dimensions.
                            if (codecCheck.videoCodec === 'h264' && !room.fallbackH264Sprop && room.whipProducer) {
                                captureSpropFromStream(mediasoupRouter, room)
                                    .catch((err) => console.warn(`[WHIP] sprop stream capture failed for room ${roomCode}: ${err.message}`));
                            }
                            
                            // Prewarm the fallback relay as soon as OBS connects so it
                            // catches OBS's initial keyframe. OBS emits parameter sets + an
                            // IDR once at stream start and does not reliably deliver a
                            // keyframe to late-joining consumers, so a relay started later
                            // (on viewer join) would never receive video. The relay buffers
                            // its output and serves viewers when they arrive.
                            if (room.relayAllowed && codecCheck.videoCodec === 'h264') {
                                startFallbackRelay(room, mediasoupRouter)
                                    .catch(err => console.error('[WHIP] Failed to prewarm fallback relay on connect:', err));
                            }
                        } catch (err) {
                            console.error(`[WHIP] Producer creation failed for room ${roomCode}:`, err);
                        }
                    } else if (dtlsState === 'failed' || dtlsState === 'closed') {
                        console.log(`[WHIP] DTLS ${dtlsState} for room ${roomCode} — starting grace period`);
                        room.whipConnected = false;
                        room.whipReconnecting = true;
                        if (io) emitHostMetrics(io, roomCode);

                        // Start grace timer — if OBS doesn't reconnect in time, clean up
                        if (room.whipGraceTimer) clearTimeout(room.whipGraceTimer);
                        room.whipGraceTimer = setTimeout(() => {
                            if (!room.whipConnected) {
                                console.log(`[WHIP] Grace period expired for room ${roomCode} — closing session`);
                                room.whipReconnecting = false;
                                stopFallbackRelay(room);
                                closeWhipSession(room);
                                room.fallbackAvailable = false;
                            }
                            room.whipGraceTimer = null;
                        }, config.WHIP_GRACE_TIMEOUT_MS);
                    }
                });

                console.log(`[WHIP] Connecting transport with DTLS role=${remoteDtls.role} fingerprint=${remoteDtls.fingerprints[0]?.algorithm}...`);
                try {
                    await transport.connect({ dtlsParameters: remoteDtls });
                    console.log(`[WHIP] Transport connected`);
                } catch (connectErr) {
                    console.error(`[WHIP] transport.connect() FAILED:`, connectErr.message, connectErr.stack);
                    throw connectErr;
                }

                // Build proper WebRTC SDP answer using transport's ICE/DTLS params
                const sdpAnswer = createAnswer(parsed, {
                    iceParameters: params.iceParameters,
                    iceCandidates: params.iceCandidates,
                    dtlsParameters: params.dtlsParameters,
                });
                console.log(`[WHIP] SDP answer created (${sdpAnswer.length} bytes)`);

                // Generate resource ID
                const resourceId = crypto.randomBytes(16).toString('hex');
                const sessionId = crypto.randomBytes(8).toString('hex');

                room.whipSessionId = sessionId;
                room.whipResourceId = resourceId;
                room.whipTransport = transport;
                sessionRegistry.registerWhipResource(resourceId, room.code);
                pendingTransport = null;

                setCorsHeaders(res);
                res.status(201)
                    .set('Content-Type', 'application/sdp')
                    .set('Location', `${getWhipLocationBase(req)}/whip/broadcast/${resourceId}`)
                    .send(sdpAnswer);

                console.log(`[WHIP] Session ${sessionId} started for room ${roomCode}`);
            } catch (err) {
                console.error('[WHIP] POST /broadcast error:', err);
                if (pendingTransport) {
                    try { pendingTransport.close(); } catch { }
                    if (claimedRoom?.whipTransport === pendingTransport) claimedRoom.whipTransport = null;
                    pendingTransport = null;
                }
                setCorsHeaders(res);
                res.status(500).json({ error: 'Internal server error' });
            } finally {
                if (claimedRoom && claimedRoom.whipGeneration === sessionGeneration) {
                    claimedRoom.whipStarting = false;
                }
            }
        },
    );

    // DELETE /whip/broadcast/:resourceId — OBS signals end of session
    router.delete('/broadcast/:resourceId', (req, res) => {
        try {
            const { resourceId } = req.params;
            const roomCode = sessionRegistry.roomCodeForWhipResource(resourceId);
            if (!roomCode) {
                setCorsHeaders(res);
                return res.status(404).json({ error: 'WHIP session not found' });
            }

            const room = findRoomByCode(roomCode);
            if (!room) {
                sessionRegistry.unregisterWhipResource(resourceId);
                setCorsHeaders(res);
                return res.status(404).json({ error: 'Room no longer exists' });
            }

            if (room.whipResourceId !== resourceId) {
                setCorsHeaders(res);
                return res.status(404).json({ error: 'WHIP session not found' });
            }

            console.log(`[WHIP] DELETE session for room ${roomCode}`);
            // Stop fallback relay — OBS session ending means no more media (Canonical Rule 6)
            stopFallbackRelay(room);
            closeWhipSession(room);

            setCorsHeaders(res);
            res.status(200).json({ ok: true });
        } catch (err) {
            console.error('[WHIP] DELETE /broadcast error:', err);
            setCorsHeaders(res);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}

module.exports = { createWhipRouter, closeWhipSession, setIo, setMediaLifecycle };
