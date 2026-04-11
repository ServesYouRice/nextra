// lib/whipRoutes.js - WHIP HTTP endpoints for OBS ingest
'use strict';

const { Router } = require('express');
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { findRoomByCode } = require('./rooms');
const { parseOffer, validateCodecs, toMediasoupRtpParameters, createAnswer, parseDtlsParameters } = require('./whip');
const { createWebRtcTransport } = require('./mediasoup');
const { stopFallbackRelay, emitHostMetrics } = require('./socket');

/** Map from WHIP resource ID to room code for DELETE lookups. */
const resourceToRoom = new Map();

/** Socket.IO server reference — set via setIo() after server init. */
let io = null;

/**
 * Set the Socket.IO server instance so WHIP can emit new-producer events.
 */
function setIo(ioInstance) {
    io = ioInstance;
}

function setCorsHeaders(res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Expose-Headers', 'Location');
}

/**
 * Close any existing WHIP transport and producers on a room.
 */
function closeWhipSession(room) {
    if (room.whipGraceTimer) {
        clearTimeout(room.whipGraceTimer);
        room.whipGraceTimer = null;
    }
    room.whipReconnecting = false;
    if (room.whipProducer) {
        try { room.whipProducer.close(); } catch { }
        room.whipProducer = null;
    }
    if (room.whipAudioProducer) {
        try { room.whipAudioProducer.close(); } catch { }
        room.whipAudioProducer = null;
    }
    if (room.whipTransport) {
        try { room.whipTransport.close(); } catch { }
        room.whipTransport = null;
    }
    if (room.whipResourceId) {
        resourceToRoom.delete(room.whipResourceId);
        room.whipResourceId = null;
    }
    room.whipSessionId = null;
    room.whipConnected = false;
    room.whipReconnecting = false;
}

/**
 * Create a WHIP router that uses the given mediasoup router.
 * @param {object} mediasoupRouter - The mediasoup Router instance
 * @returns {Router} Express router
 */
function createWhipRouter(mediasoupRouter) {
    const router = Router();

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
                const { transport, params } = await createWebRtcTransport(mediasoupRouter);
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
                            if (rtpParams.video) {
                                room.whipProducer = await transport.produce({
                                    kind: 'video',
                                    rtpParameters: rtpParams.video,
                                });
                                console.log(`[WHIP] Video producer created for room ${roomCode}`);
                            }
                            if (rtpParams.audio) {
                                room.whipAudioProducer = await transport.produce({
                                    kind: 'audio',
                                    rtpParameters: rtpParams.audio,
                                });
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
                            
                            // Start fallback relay immediately if there are already fallback viewers waiting
                            if (room.relayAllowed && room.fallbackViewers && room.fallbackViewers.size > 0) {
                                const { startFallbackRelay } = require('./socket');
                                startFallbackRelay(room, mediasoupRouter)
                                    .catch(err => console.error('[WHIP] Failed to start fallback relay on connect:', err));
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
                resourceToRoom.set(resourceId, room.code);

                const reqProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
                const reqHost = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.WHIP_HTTP_PORT}`;
                
                setCorsHeaders(res);
                res.status(201)
                    .set('Content-Type', 'application/sdp')
                    .set('Location', `${reqProto}://${reqHost}/whip/broadcast/${resourceId}`)
                    .send(sdpAnswer);

                console.log(`[WHIP] Session ${sessionId} started for room ${roomCode}`);
            } catch (err) {
                console.error('[WHIP] POST /broadcast error:', err);
                setCorsHeaders(res);
                res.status(500).json({ error: 'Internal server error' });
            }
        },
    );

    // DELETE /whip/broadcast/:resourceId — OBS signals end of session
    router.delete('/broadcast/:resourceId', (req, res) => {
        try {
            const { resourceId } = req.params;
            const roomCode = resourceToRoom.get(resourceId);
            if (!roomCode) {
                setCorsHeaders(res);
                return res.status(404).json({ error: 'WHIP session not found' });
            }

            const room = findRoomByCode(roomCode);
            if (!room) {
                resourceToRoom.delete(resourceId);
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

module.exports = { createWhipRouter, closeWhipSession, setIo };
