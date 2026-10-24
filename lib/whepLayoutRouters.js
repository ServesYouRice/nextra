// lib/whepLayoutRouters.js - routers that send a room's media on a WHEP viewer's payload types
'use strict';

const {
    WhepOfferError,
    buildLayoutMediaCodecs,
    payloadLayoutKey,
    routerServesPayloadLayout,
} = require('./whep');

// A WHEP viewer decodes only the payload types of its own offer, and a mediasoup consumer sends
// with its router's (see planViewerPayloadTypes in lib/whep.js). When the main router's numbers
// are not the offer's, the viewer is served from a "layout router": a router on the same worker
// whose mediaCodecs give the room's codecs the offer's numbers, with the room's producers piped
// into it (Router.pipeToRouter). Viewers whose offers number the codecs alike share one layout
// router (every Chromium-family browser numbers them the same); it is kept per room, closes with
// its last viewer or with the room, and the producers are piped again when the host replaces one.
//
// Each layout router costs a pipe transport pair on loopback and a second copy of the room's
// media (every simulcast layer) inside the worker, so a room and the server have a cap.

const DEFAULT_MAX_LAYOUT_ROUTERS_PER_ROOM = 4;
const DEFAULT_MAX_LAYOUT_ROUTERS = 16;

// The pipes bind loopback UDP ports. They come from the dynamic port range, where an OS puts a
// port-0 socket, not from the RTC range: that range is for viewers, and with the shared
// WebRtcServer an operator may have narrowed it to one port. mediasoup tries another port of the
// range when one is taken or excluded.
const PIPE_LISTEN_INFO = Object.freeze({
    protocol: 'udp',
    ip: '127.0.0.1',
    portRange: Object.freeze({ min: 49152, max: 65535 }),
});

/** No layout router can be opened now; status is the HTTP status to answer with. */
class WhepLayoutCapacityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WhepLayoutCapacityError';
        this.status = 503;
    }
}

// room -> Set of its open layouts (of any manager).
const layoutsByRoom = new WeakMap();

/**
 * @param {object} options
 * @param {(mediaCodecs: object[]) => Promise<object>} options.createRouter - a router on the
 *   main router's worker
 * @param {number} [options.maxPerRoom]
 * @param {number} [options.maxTotal]
 */
function createWhepLayoutRouters({
    createRouter,
    maxPerRoom = DEFAULT_MAX_LAYOUT_ROUTERS_PER_ROOM,
    maxTotal = DEFAULT_MAX_LAYOUT_ROUTERS,
    pipeListenInfo = PIPE_LISTEN_INFO,
} = {}) {
    let openCount = 0;

    function findLayout(room, keys) {
        for (const layout of layoutsByRoom.get(room) || []) {
            if (!layout.closed && keys.every((key) => layout.keys.has(key))) return layout;
        }
        return null;
    }

    function closeLayout(layout) {
        if (layout.closed) return;
        layout.closed = true;
        layout.roomLayouts.delete(layout);
        openCount -= 1;
        // Closing the router closes its pipe transport, its pipe producers and the consumers on
        // them; mediasoup then closes the main router's end of the pipe as well.
        if (!layout.router) return;
        if (!layout.router.closed) {
            try { layout.router.close(); } catch { }
        }
        console.log(`[WHEP] Router for payload types ${layout.summary} closed (room ${layout.roomCode})`);
    }

    function openLayout(room, plan) {
        let roomLayouts = layoutsByRoom.get(room);
        if (!roomLayouts) {
            roomLayouts = new Set();
            layoutsByRoom.set(room, roomLayouts);
        }
        if (roomLayouts.size >= maxPerRoom) {
            throw new WhepLayoutCapacityError(`This room already serves ${roomLayouts.size} WHEP players that number codecs differently, the most it serves at once. Try again when one leaves.`);
        }
        if (openCount >= maxTotal) {
            throw new WhepLayoutCapacityError('Server WHEP capacity for players that number codecs differently is reached. Try again later.');
        }

        const layout = {
            roomCode: room.code,
            keys: new Set(plan.entries.map(payloadLayoutKey)),
            // For the log: 'video/VP8 96 (rtx 97), audio/opus 111'.
            summary: plan.entries.map((entry) => `${entry.codec.mimeType} ${entry.payloadType}${entry.rtxPayloadType != null ? ` (rtx ${entry.rtxPayloadType})` : ''}`).join(', '),
            roomLayouts,
            refs: 0,
            closed: false,
            router: null,
            ready: null,
            // source producer id -> Promise of its pipe producer in this router
            pipes: new Map(),
        };
        layout.close = () => closeLayout(layout);
        roomLayouts.add(layout);
        openCount += 1;

        layout.ready = (async () => {
            let router;
            try {
                router = await createRouter(buildLayoutMediaCodecs(plan));
            } catch (err) {
                // mediasoup refuses a codec list it cannot build; this one holds the offer's numbers.
                if (err instanceof TypeError || err?.name === 'UnsupportedError') {
                    throw new WhepOfferError(`The offer's payload types cannot be served: ${err.message}`);
                }
                throw err;
            }
            if (layout.closed) {
                router.close();
                throw new Error('WHEP layout router closed while it was being created');
            }
            layout.router = router;
            router.observer.once('close', () => closeLayout(layout));

            for (const entry of plan.entries) {
                if (routerServesPayloadLayout(router.rtpCapabilities, entry)) continue;
                if (routerServesPayloadLayout(router.rtpCapabilities, { ...entry, rtxPayloadType: null })) {
                    // The RTX number was steered (buildLayoutMediaCodecs) and did not land: this
                    // codec goes without RTX, NACK retransmitting on the media stream.
                    console.warn(`[WHEP] mediasoup did not give RTX payload type ${entry.rtxPayloadType} to ${entry.codec.mimeType} ${entry.payloadType}; serving it without RTX`);
                    continue;
                }
                throw new Error(`mediasoup did not give ${entry.codec.mimeType} payload type ${entry.payloadType} in a WHEP layout router`);
            }
            console.log(`[WHEP] Router for payload types ${layout.summary} created (room ${layout.roomCode})`);
            return router;
        })();
        // Failure reaches every acquirer through ready; close the layout here.
        layout.ready.catch(() => closeLayout(layout));
        return layout;
    }

    async function pipeProducerFor(layout, mainRouter, producer) {
        let pending = layout.pipes.get(producer.id);
        if (!pending) {
            const forget = () => {
                if (layout.pipes.get(producer.id) === pending) layout.pipes.delete(producer.id);
            };
            pending = mainRouter.pipeToRouter({
                producerId: producer.id,
                router: layout.router,
                // Both routers are on one worker, where a pipe producer needs an id of its own.
                keepId: false,
                enableSctp: false,
                listenInfo: pipeListenInfo,
            }).then(({ pipeProducer }) => {
                // The pipe producer closes when the host's producer does (a replaced producer).
                pipeProducer.observer.once('close', forget);
                return pipeProducer;
            });
            layout.pipes.set(producer.id, pending);
            pending.catch(forget);
        }
        const pipeProducer = await pending;
        if (pipeProducer.closed) throw new Error('The room producer closed while it was piped to a WHEP layout router');
        return pipeProducer;
    }

    /**
     * A router that sends the plan's codecs on the offer's numbers, shared with the room's other
     * viewers of that numbering, with the plan's producers piped into it.
     * Returns { router, producerIds: { video, audio }, release }: consume the pipe producers by
     * these ids on this router, and call release() once when the viewer is gone.
     * Throws WhepLayoutCapacityError or WhepOfferError (with an HTTP status) or another error.
     */
    async function acquire({ room, mainRouter, plan }) {
        const keys = plan.entries.map(payloadLayoutKey);
        const layout = findLayout(room, keys) || openLayout(room, plan);
        layout.refs += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            layout.refs -= 1;
            if (layout.refs <= 0) closeLayout(layout);
        };
        try {
            const router = await layout.ready;
            const producerIds = {};
            for (const entry of plan.entries) {
                producerIds[entry.kind] = (await pipeProducerFor(layout, mainRouter, entry.producer)).id;
            }
            if (layout.closed) throw new Error('WHEP layout router closed');
            return { router, producerIds, release };
        } catch (err) {
            release();
            throw err;
        }
    }

    return { acquire };
}

/** Close every layout router of a room (the room is closing). */
function closeRoomLayoutRouters(room) {
    const roomLayouts = layoutsByRoom.get(room);
    if (!roomLayouts) return;
    for (const layout of [...roomLayouts]) layout.close();
    layoutsByRoom.delete(room);
}

module.exports = { createWhepLayoutRouters, closeRoomLayoutRouters };
