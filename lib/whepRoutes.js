// lib/whepRoutes.js - WHEP HTTP endpoints for viewer egress
'use strict';

const { Router } = require('express');
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { findRoomByCode, getActiveRoomProducers, touchRoom, verifyRoomPassphrase } = require('./rooms');
const { parseViewerOffer, parseViewerDtls, createViewerAnswer, buildViewerRtpCapabilities } = require('./whep');
const { createWebRtcTransport } = require('./mediasoup');
const { normalizeIp, getTrustedForwardedClientIp } = require('./network');
const { setWhepSessionsCloser } = require('./roomLifecycle');

/** Global session lookup for DELETE by sessionId. */
const whepSessionsById = new Map();
let pendingWhepSessions = 0;
const pendingWhepByRoom = new Map();

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
function getActiveWhepSessionCount() {
    // whepSessionsById tracks all live sessions across rooms
    return whepSessionsById.size;
}

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

    session.state = 'closed';
    session.closed = true;
    room.whepSessions.delete(sessionId);
    whepSessionsById.delete(sessionId);
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
}

setWhepSessionsCloser(closeAllWhepSessions);

/**
 * Helper: extract a usable client IP from an Express request.
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
        config.TRUST_X_FORWARDED_HEADERS
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
            let admissionReserved = false;

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
                if (getActiveWhepSessionCount() + pendingWhepSessions >= config.WHEP_MAX_GLOBAL_SESSIONS) {
                    setCorsHeaders(res);
                    return res.status(503).json({ error: 'Server WHEP capacity reached. Try again later.' });
                }

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
                const totalViewers = room.viewers.size
                    + (room.whepSessions?.size || 0)
                    + (pendingWhepByRoom.get(room.code) || 0);
                if (totalViewers >= config.MAX_VIEWERS_PER_ROOM) {
                    setCorsHeaders(res);
                    return res.status(503).json({ error: 'Room is full' });
                }
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

                pendingWhepSessions += 1;
                pendingWhepByRoom.set(room.code, (pendingWhepByRoom.get(room.code) || 0) + 1);
                room.whepPendingReservations = (room.whepPendingReservations || 0) + 1;
                admissionReserved = true;

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

                // Create transport
                const transportResult = await createWebRtcTransport(mediasoupRouter, { purpose: 'whep' });
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
                if (!mediasoupRouter.canConsume({ producerId: videoProducer.id, rtpCapabilities: viewerCapabilities })) {
                    transport.close();
                    transport = null;
                    setCorsHeaders(res);
                    return res.status(415).json({ error: 'Cannot consume video producer — codec mismatch with viewer' });
                }
                const videoConsumer = await transport.consume({
                    producerId: videoProducer.id,
                    rtpCapabilities: viewerCapabilities,
                    paused: true,
                });
                consumers.push(videoConsumer);

                // Audio consumer (optional — only if viewer offer includes audio)
                if (audioProducer) {
                    try {
                        if (mediasoupRouter.canConsume({ producerId: audioProducer.id, rtpCapabilities: viewerCapabilities })) {
                            const audioConsumer = await transport.consume({
                                producerId: audioProducer.id,
                                rtpCapabilities: viewerCapabilities,
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
                };

                room.whepSessions.set(sessionId, session);
                whepSessionsById.set(sessionId, session);
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
                if (admissionReserved) {
                    pendingWhepSessions = Math.max(0, pendingWhepSessions - 1);
                    const pendingForRoom = Math.max(0, (pendingWhepByRoom.get(room?.code) || 1) - 1);
                    if (pendingForRoom === 0) pendingWhepByRoom.delete(room?.code);
                    else pendingWhepByRoom.set(room.code, pendingForRoom);
                    if (room) room.whepPendingReservations = Math.max(0, (room.whepPendingReservations || 1) - 1);
                }
            }
        },
    );

    // DELETE /whep/watch/:sessionId — viewer signals end of session
    router.delete('/watch/:sessionId', (req, res) => {
        try {
            const { sessionId } = req.params;
            const session = whepSessionsById.get(sessionId);
            if (!session) {
                setCorsHeaders(res);
                return res.status(404).json({ error: 'WHEP session not found' });
            }

            const room = findRoomByCode(session.roomCode);
            if (room) {
                closeWhepSession(room, sessionId);
            } else {
                // Room already gone — clean up global map
                whepSessionsById.delete(sessionId);
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
