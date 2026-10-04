// lib/rtpReorder.js - Puts an RTP stream back in sequence order.
//
// OBS sends a keyframe as a burst of a few hundred packets, and some of that
// burst gets dropped even on loopback. The sender retransmits what mediasoup
// NACKs, but the retransmission arrives after packets that were sent later. Fed
// straight to a depacketizer, that is a frame with a hole in it, and every frame
// up to OBS's next keyframe is then decoded from a damaged reference. Holding
// later packets for a moment until the missing one turns up avoids all of it.
'use strict';

// How long to wait for a missing packet. A NACK round trip on loopback takes a
// few milliseconds; beyond this the packet is not coming.
const DEFAULT_MAX_WAIT_MS = 120;
// Packets held while waiting, as a bound on memory and on added delay.
const DEFAULT_MAX_HELD = 1024;
// This many packets in a row from "the past" means the numbering restarted.
const STALE_RUN_RESYNC = 200;

function sequenceDelta(a, b) {
    // Signed distance from b to a on the 16-bit sequence circle.
    return ((a - b + 0x8000) & 0xffff) - 0x8000;
}

class RtpReorderBuffer {
    constructor({ maxWaitMs = DEFAULT_MAX_WAIT_MS, maxHeld = DEFAULT_MAX_HELD, now = Date.now } = {}) {
        this._maxWaitMs = maxWaitMs;
        this._maxHeld = maxHeld;
        this._now = now;
        this._expected = null;
        this._held = new Map();
        this._waitingSince = 0;
        this._staleRun = 0;
        this.lostPackets = 0;
        this.recoveredPackets = 0;
    }

    /**
     * Push one RTP packet; returns the packets that are now deliverable, in
     * sequence order. A packet that never arrives is skipped once the wait or the
     * hold limit runs out, leaving a sequence gap for the consumer to see.
     */
    push(packet) {
        const out = [];
        if (!Buffer.isBuffer(packet) || packet.length < 12) return out;
        const sequence = packet.readUInt16BE(2);

        if (this._expected === null) this._expected = sequence;
        let delta = sequenceDelta(sequence, this._expected);
        if (delta < 0) {
            // Already delivered or given up on — unless the sender started a new
            // numbering, which a long run of "old" packets gives away.
            this._staleRun = (this._staleRun || 0) + 1;
            if (this._staleRun < STALE_RUN_RESYNC) return out;
            this._held.clear();
            this._expected = sequence;
            delta = 0;
        }
        this._staleRun = 0;

        if (delta === 0) {
            if (this._held.size > 0) this.recoveredPackets += 1;
            out.push(packet);
            this._expected = (sequence + 1) & 0xffff;
            this._drain(out);
        } else {
            if (this._held.size === 0) this._waitingSince = this._now();
            this._held.set(sequence, packet);
        }

        if (this._held.size > 0
            && (this._held.size > this._maxHeld || this._now() - this._waitingSince > this._maxWaitMs)) {
            this._skipToNextHeld(out);
        }
        return out;
    }

    _drain(out) {
        while (this._held.size > 0) {
            const next = this._held.get(this._expected);
            if (!next) break;
            this._held.delete(this._expected);
            out.push(next);
            this._expected = (this._expected + 1) & 0xffff;
        }
        if (this._held.size > 0) this._waitingSince = this._now();
    }

    _skipToNextHeld(out) {
        let nearest = null;
        let nearestDelta = Infinity;
        for (const sequence of this._held.keys()) {
            const delta = sequenceDelta(sequence, this._expected);
            if (delta < nearestDelta) {
                nearestDelta = delta;
                nearest = sequence;
            }
        }
        if (nearest === null) return;
        this.lostPackets += nearestDelta;
        this._expected = nearest;
        this._drain(out);
    }
}

module.exports = { RtpReorderBuffer };
