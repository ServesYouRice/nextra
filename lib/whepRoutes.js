// lib/whepRoutes.js - WHEP HTTP endpoints for viewer egress
'use strict';

const { Router } = require('express');
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { findRoomByCode, getActiveRoomProducers, touchRoom, verifyRoomPassphrase } = require('./rooms');
const {
    parseViewerOffer,
    parseViewerDtls,
    createViewerAnswer,
    buildViewerRtpCapabilities,
    planViewerPayloadTypes,
    routerServesPayloadLayout,
    limitViewerRtxToOffer,
} = require('./whep');
const { createWebRtcTransport, createRouter: createMediasoupRouter } = require('./mediasoup');
const { createWhepLayoutRouters, closeRoomLayoutRouters } = require('./whepLayoutRouters');
const { normalizeIp, getTrustedForwardedClientIp, resolveTrustedHopCount } = require('./network');
const { setWhepSessionsCloser } = require('./roomLifecycle');
const { sessionRegistry } = require('./sessionRegistry');

/** Global session lookup for DELETE by sessionId. */

/** How long a freshly answered session may stay un-connected (no DTLS) before it is reaped. */
const WHEP_CONNECT_TIMEOUT_MS = 30_000;

// ── Per-IP rate limiter ──
const ipRequestLog = new Map(); // ip -> { count, resetAt }

let ipCleanupTimer = null;

function startIpCleanup() {
    if (ipCleanupTimer) return;
    ipCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of ipRequestLog) {
            if (now >= entry.resetAt) ipRequestLog.delete(ip);
        }
    }, 60_000);
    ipCleanupTimer.unref?.();
}

/**
 * Returns true if this IP should be rate-limited (denied).
 */
function isRateLimited(ip) {
    const now = Date.now();
    let entry = ipRequestLog.get(ip);
    if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + config.WHEP_RATE_LIMIT_WINDOW_MS };
        ipRequestLog.set(ip, entry);
        startIpCleanup();
    }
    entry.count += 1;
    return entry.count > config.WHEP_RATE_LIMIT_MAX;
}

// ── Global transport cap ──
let whepAllowedOriginCheck = null;

function setCorsHeaders(res) {
    // WHEP is consumed both by browser players (which send an Origin and enforce
    // CORS) and by non-browser players like ffmpeg/OBS (no Origin, unaffected by
    // CORS). For browser callers, reflect only origins the server already trusts
    // instead of a blanket '*'. Non-browser callers keep working because they
    // ignore CORS entirely.
    const origin = res.req?.headers?.origin;
    if (origin && (typeof whepAllowedOriginCheck !== 'function' || whepAllowedOriginCheck(origin))) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'POST, DELETE, PATCH, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Expose-Headers', 'Location');
}

/**
 * Idempotent cleanup of a single WHEP session.
 */
function closeWhepSession(room, sessionId) {
    const session = room.whepSessions?.get(sessionId);
    if (!session || session.state === 'closed') return;

    session.state = 'closing';

    if (session.connectTimer) {
        clearTimeout(session.connectTimer);
        session.connectTimer = null;
    }

    // Clear the ICE-disconnect reaper too. If a session is closed for any other
    // reason (DTLS failed, producer closed, room destroyed, explicit DELETE) while
    // an ICE-disconnect timer is pending, this prevents the timer + its closured
    // transport/consumer references from surviving up to 30s past teardown.
    if (session.iceDisconnectTimer) {
        clearTimeout(session.iceDisconnectTimer);
        session.iceDisconnectTimer = null;
    }

    for (const consumer of session.consumers) {
        try { consumer.close(); } catch { }
    }
    if (session.transport) {
        try { session.transport.close(); } catch { }
    }
    // A viewer served from a layout router lets go of it; the last one closes it.
    if (session.layoutLease) {
        try { session.layoutLease.release(); } catch { }
        session.layoutLease = null;
    }

    session.state = 'closed';
    session.closed = true;
    room.whepSessions.delete(sessionId);
    sessionRegistry.unregisterWhepSession(sessionId);
    room.whepViewerCount = room.whepSessions.size;
}

/**
 * Close all WHEP sessions for a room. Called from destroyRoom().
 */
function closeAllWhepSessions(room) {
    if (!room.whepSessions) return;
    for (const sessionId of [...room.whepSessions.keys()]) {
        closeWhepSession(room, sessionId);
    }
    closeRoomLayoutRouters(room);
}

setWhepSessionsCloser(closeAllWhepSessions);

/**
 * The client of a request when createWhepRouter is given no getClientIp (server.js passes the request identity of
 * lib/requestIdentity.js). The same settings apply: the TRUST_PROXY hop count, and CF-Connecting-IP only under
 * TRUST_CLOUDFLARE_CONNECTING_IP, since this fallback knows nothing of a tunnel Nextra started.
 */
function getRequestIp(req) {
    const remoteAddress = normalizeIp(
        req?.socket?.remoteAddress
        || req?.connection?.remoteAddress
        || req?.ip
        || 'unknown'
    );
    const forwardedIp = getTrustedForwardedClientIp(
        req?.headers || {},
        remoteAddress,
        config.TRUST_X_FORWARDED_HEADERS,
        {
            trustedHopCount: resolveTrustedHopCount(config.TRUST_PROXY),
            trustCloudflareClientIp: config.TRUST_CLOUDFLARE_CONNECTING_IP === true,
        }
    );
    return forwardedIp || remoteAddress;
}

/**
 * Create a WHEP router that uses the given mediasoup router.
 * @param {object} mediasoupRouter - The mediasoup Router instance
 * @returns {Router} Express router
 */
function createWhepRouter(mediasoupRouter, options = {}) {
    if (typeof options.isAllowedOrigin === 'function') {
        whepAllowedOriginCheck = options.isAllowedOrigin;
    }

    const router = Router();
    const getClientIp = typeof options.getClientIp === 'function'
        ? options.getClientIp
        : getRequestIp;
    const createTransport = typeof options.createWebRtcTransport === 'function'
        ? options.createWebRtcTransport
        : createWebRtcTransport;
    // Routers for viewers whose offers number the codecs differently from mediasoupRouter.
    const layoutRouters = createWhepLayoutRouters({
        createRouter: typeof options.createRouter === 'function' ? options.createRouter : createMediasoupRouter,
        maxPerRoom: options.maxLayoutRoutersPerRoom,
        maxTotal: options.maxLayoutRouters,
    });

    // CORS preflight
    router.options('/watch/:param', (req, res) => {
        setCorsHeaders(res);
        res.status(204).end();
    });

    // POST /whep/watch/:roomCode — viewer sends SDP offer
    router.post(
        '/watch/:roomCode',
        express.raw({ type: 'application/sdp', limit: '64kb' }),
        async (req, res) => {
            // Track resources for error-path cleanup (Finding 2)
            let transport = null;
            const consumers = [];
            let sessionId = null;
            let sessionRegistered = false;
            let room = null;
            let admissionReservation = null;
            // A layout router this request holds (see layoutRouters); the session keeps it.
            let layoutLease = null;

            try {
                if (!config.WHEP_ENABLED) {
                    setCorsHeaders(res);
                    return res.status(404).json({ error: 'WHEP is not enabled' });
                }

                // ── Finding 4: Per-IP rate limiting ──
                const clientIp = getClientIp(req);
                if (isRateLimited(clientIp)) {
                    setCorsHeaders(res);
                    return res.status(429).json({ error: 'Too many WHEP requests. Try again later.' });
                }

                // ── Finding 4: Global transport cap ──
                const { roomCode } = req.params;
                room = findRoomByCode(roomCode);
                if (!room) {
                    setCorsHeaders(res);
                    return res.status(404).json({ error: 'Room not found' });
                }

                const { videoProducer, audioProducer } = getActiveRoomProducers(room);
                if (!videoProducer) {
                    setCorsHeaders(res);
                    return res.status(409).json({ error: 'No active video producer in this room' });
                }

                // Capacity check: count Socket.IO viewers + WHEP viewers
                if (room.passphraseHash) {
                    const auth = String(req.headers.authorization || '');
                    const candidate = auth.startsWith('Bearer ') ? auth.slice(7) : '';
                    if (!(await verifyRoomPassphrase(room, candidate))) {
                        setCorsHeaders(res);
                        return res.status(401)
                            .set('WWW-Authenticate', 'Bearer realm="Nextra room"')
                            .json({ error: 'Room passphrase required or incorrect' });
                    }
                }

                admissionReservation = sessionRegistry.tryReserveWhep({
                    roomCode: room.code,
                    socketViewers: room.viewers.size,
                    activeRoomSessions: room.whepSessions?.size || 0,
                    globalLimit: config.WHEP_MAX_GLOBAL_SESSIONS,
                    roomLimit: config.MAX_VIEWERS_PER_ROOM,
                });
                if (!admissionReservation.ok) {
                    setCorsHeaders(res);
                    return res.status(503).json({
                        error: admissionReservation.reason === 'global-capacity'
                            ? 'Server WHEP capacity reached. Try again later.'
                            : 'Room is full',
                    });
                }
                room.whepPendingReservations = (room.whepPendingReservations || 0) + 1;

                // Parse SDP offer
                const sdpBody = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body);
                const parsedOffer = parseViewerOffer(sdpBody);

                // Extract DTLS
                const remoteDtls = parseViewerDtls(parsedOffer);
                if (!remoteDtls) {
                    setCorsHeaders(res);
                    return res.status(400).json({ error: 'No DTLS fingerprint in offer' });
                }

                // ── Finding 1: Build viewer-filtered RTP capabilities ──
                const viewerCapabilities = buildViewerRtpCapabilities(parsedOffer, mediasoupRouter.rtpCapabilities);
                if (!viewerCapabilities.codecs.some((c) => c.kind === 'video')) {
                    setCorsHeaders(res);
                    return res.status(415).json({ error: 'Viewer offer does not support any video codec the server produces' });
                }

                // The router to consume from: one whose payload types for the room's codecs are
                // the offer's, since the viewer decodes no other (see planViewerPayloadTypes).
                // The main router when its numbers agree, else a layout router for the offer's.
                let consumeRouter = mediasoupRouter;
                let consumeCapabilities = viewerCapabilities;
                let videoProducerId = videoProducer.id;
                let audioProducerId = audioProducer ? audioProducer.id : null;
                let plan;
                try {
                    plan = planViewerPayloadTypes(parsedOffer, { video: videoProducer, audio: audioProducer }, mediasoupRouter.rtpCapabilities);
                    if (plan && plan.entries.some((entry) => entry.kind === 'video')
                        && !plan.entries.every((entry) => routerServesPayloadLayout(mediasoupRouter.rtpCapabilities, entry))) {
                        layoutLease = await layoutRouters.acquire({ room, mainRouter: mediasoupRouter, plan });
                        consumeRouter = layoutLease.router;
                        consumeCapabilities = buildViewerRtpCapabilities(parsedOffer, consumeRouter.rtpCapabilities);
                        videoProducerId = layoutLease.producerIds.video;
                        audioProducerId = layoutLease.producerIds.audio || null;
                    }
                } catch (layoutErr) {
                    if (Number.isInteger(layoutErr?.status) && layoutErr.status >= 400 && layoutErr.status < 600) {
                        console.warn(`[WHEP] Offer for room ${room.code} not served (${layoutErr.status}): ${layoutErr.message}`);
                        setCorsHeaders(res);
                        return res.status(layoutErr.status).json({ error: layoutErr.message });
                    }
                    throw layoutErr;
                }
                // Only the RTX the offer can receive; without it NACK retransmits on the media stream.
                if (plan) consumeCapabilities = limitViewerRtxToOffer(consumeCapabilities, consumeRouter.rtpCapabilities, plan);

                // Create transport
                const transportResult = await createTransport(consumeRouter, { purpose: 'whep' });
                transport = transportResult.transport;
                const params = transportResult.params;

                // Connect transport
                try {
                    await transport.connect({ dtlsParameters: remoteDtls });
                } catch (connectErr) {
                    console.error('[WHEP] transport.connect() failed:', connectErr.message);
                    transport.close();
                    transport = null; // prevent double-close in outer catch
                    setCorsHeaders(res);
                    return res.status(500).json({ error: 'Transport connect failed' });
                }

                // Create consumers using viewer-filtered capabilities (Finding 1)

                // Video consumer (required)
                if (!consumeRouter.canConsume({ producerId: videoProducerId, rtpCapabilities: consumeCapabilities })) {
                    transport.close();
                    transport = null;
                    setCorsHeaders(res);
                    return res.status(415).json({ error: 'Cannot consume video producer — codec mismatch with viewer' });
                }
                const videoConsumer = await transport.consume({
                    producerId: videoProducerId,
                    rtpCapabilities: consumeCapabilities,
                    paused: true,
                });
                consumers.push(videoConsumer);

                // Audio consumer (optional — only if viewer offer includes audio)
                if (audioProducerId) {
                    try {
                        if (consumeRouter.canConsume({ producerId: audioProducerId, rtpCapabilities: consumeCapabilities })) {
                            const audioConsumer = await transport.consume({
                                producerId: audioProducerId,
                                rtpCapabilities: consumeCapabilities,
                                paused: true,
                            });
                            consumers.push(audioConsumer);
                        }
                    } catch (audioErr) {
                        console.warn('[WHEP] Audio consumer creation failed (continuing video-only):', audioErr.message);
                    }
                }

                // Build SDP answer
                const sdpAnswer = createViewerAnswer(parsedOffer, consumers, {
                    iceParameters: params.iceParameters,
                    iceCandidates: params.iceCandidates,
                    dtlsParameters: params.dtlsParameters,
                });

                // Create session
                sessionId = crypto.randomBytes(16).toString('hex');
                const session = {
                    id: sessionId,
                    roomCode: req.params.roomCode,
                    state: 'connecting',
                    transport,
                    consumers,
                    createdAt: Date.now(),
                    closed: false,
                    dtlsConnected: false,
                    connectTimer: null,
                    iceDisconnectTimer: null,
                    layoutLease,
                };

                room.whepSessions.set(sessionId, session);
                sessionRegistry.registerWhepSession(sessionId, session);
                admissionReservation.release();
                admissionReservation = null;
                room.whepPendingReservations = Math.max(0, (room.whepPendingReservations || 1) - 1);
                sessionRegistered = true;
                room.whepViewerCount = room.whepSessions.size;
                touchRoom(req.params.roomCode);

                // Resume consumers
                for (const consumer of consumers) {
                    await consumer.resume();
                }

                // Connect deadline: a peer that answers the offer but never
                // completes ICE/DTLS fires none of the lifecycle events below and
                // would otherwise hold a transport (and a slot in the global
                // session cap) until the room dies. Reap it after the deadline.
                session.connectTimer = setTimeout(() => {
                    session.connectTimer = null;
                    if (!session.dtlsConnected && session.state !== 'closed') {
                        console.warn(`[WHEP] Session ${sessionId} never completed DTLS within ${WHEP_CONNECT_TIMEOUT_MS}ms — closing`);
                        closeWhepSession(room, sessionId);
                    }
                }, WHEP_CONNECT_TIMEOUT_MS);
                session.connectTimer.unref?.();

                // Transport lifecycle handlers
                transport.on('dtlsstatechange', (dtlsState) => {
                    if (dtlsState === 'connected') {
                        session.dtlsConnected = true;
                        if (session.connectTimer) {
                            clearTimeout(session.connectTimer);
                            session.connectTimer = null;
                        }
                    } else if (dtlsState === 'failed' || dtlsState === 'closed') {
                        console.log(`[WHEP] DTLS ${dtlsState} for session ${sessionId}`);
                        closeWhepSession(room, sessionId);
                    }
                });
                transport.on('icestatechange', (iceState) => {
                    if (iceState === 'disconnected') {
                        if (session.iceDisconnectTimer) {
                            clearTimeout(session.iceDisconnectTimer);
                        }
                        session.iceDisconnectTimer = setTimeout(() => {
                            session.iceDisconnectTimer = null;
                            console.log(`[WHEP] ICE disconnected timeout for session ${sessionId}`);
                            closeWhepSession(room, sessionId);
                        }, 30000);
                        session.iceDisconnectTimer.unref?.();
                    } else if (iceState === 'connected' || iceState === 'completed') {
                        if (session.iceDisconnectTimer) {
                            clearTimeout(session.iceDisconnectTimer);
                            session.iceDisconnectTimer = null;
                        }
                    }
                });

                // Close transport when producer disappears (no signaling channel)
                for (const consumer of consumers) {
                    consumer.on('producerclose', () => {
                        console.log(`[WHEP] Producer closed for consumer ${consumer.id} — closing session ${sessionId}`);
                        closeWhepSession(room, sessionId);
                    });
                }

                session.state = 'connected';
                console.log(`[WHEP] Session ${sessionId} created for room ${req.params.roomCode} (${consumers.length} consumers)`);

                setCorsHeaders(res);
                res.status(201)
                    .set('Content-Type', 'application/sdp')
                    .set('Location', `/whep/watch/${sessionId}`)
                    .send(sdpAnswer);
            } catch (err) {
                console.error('[WHEP] POST /watch error:', err);

                // ── Finding 2: Clean up leaked mediasoup state ──
                // If a session was registered, closeWhepSession handles everything.
                if (sessionRegistered && room && sessionId) {
                    try { closeWhepSession(room, sessionId); } catch { }
                } else {
                    // Close consumers individually
                    for (const consumer of consumers) {
                        try { consumer.close(); } catch { }
                    }
                    // Close the transport
                    if (transport) {
                        try { transport.close(); } catch { }
                    }
                }

                setCorsHeaders(res);
                res.status(500).json({ error: 'Internal server error' });
            } finally {
                if (admissionReservation?.ok) {
                    admissionReservation.release();
                    if (room) room.whepPendingReservations = Math.max(0, (room.whepPendingReservations || 1) - 1);
                }
                // No session took the layout router over (an error or an early answer).
                if (layoutLease && !sessionRegistered) {
                    try { layoutLease.release(); } catch { }
                }
            }
        },
    );

    // DELETE /whep/watch/:sessionId — viewer signals end of session
    router.delete('/watch/:sessionId', (req, res) => {
        try {
            const { sessionId } = req.params;
            const session = sessionRegistry.getWhepSession(sessionId);
            if (!session) {
                setCorsHeaders(res);
                return res.status(404).json({ error: 'WHEP session not found' });
            }

            const room = findRoomByCode(session.roomCode);
            if (room) {
                closeWhepSession(room, sessionId);
            } else {
                // Room already gone — clean up global map
                sessionRegistry.unregisterWhepSession(sessionId);
            }

            setCorsHeaders(res);
            res.status(200).json({ ok: true });
        } catch (err) {
            console.error('[WHEP] DELETE /watch error:', err);
            setCorsHeaders(res);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // PATCH /whep/watch/:sessionId — trickle ICE not implemented in Phase 1
    router.patch('/watch/:sessionId', (req, res) => {
        setCorsHeaders(res);
        res.status(501).json({ error: 'Trickle ICE not implemented' });
    });

    return router;
}

module.exports = { createWhepRouter, closeWhepSession, closeAllWhepSessions };
