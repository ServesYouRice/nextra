// lib/relayCapacityProbe.js - Measures what the public link can carry.
//
// Everyone watching through the public link gets the relay over that one path
// (for a Cloudflare quick tunnel, a single connection from this machine to the
// edge). A relay encoded faster than the path carries can never be watched: each
// second of video takes more than a second to arrive. So before anyone watches,
// the server downloads a few megabytes from itself through the public link and
// times it; the relay then starts at a bitrate that fits.
'use strict';

const crypto = require('crypto');

const PROBE_BYTES = 10 * 1024 * 1024;
const PROBE_CHUNK_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 8000;
// The first moments of a transfer are the transport ramping up, not its capacity.
const PROBE_RAMP_MS = 700;
const PROBE_MIN_MEASURED_MS = 1000;
const TOKEN_TTL_MS = 20_000;

function createRelayCapacityProbe({ fetchImpl = globalThis.fetch, now = Date.now, logger = console } = {}) {
    let armed = null; // { token, expiresAt }
    let running = null;
    let last = null; // { kbps, at, baseUrl }

    /** Express handler for GET <probe path>/:token. Serves one armed probe. */
    function handler(req, res) {
        const token = String(req.params?.token || '');
        const current = armed;
        if (!current || now() > current.expiresAt || token.length !== current.token.length
            || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(current.token))) {
            res.status(404).end();
            return;
        }
        armed = null;
        res.status(200);
        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(PROBE_BYTES),
            // no-transform keeps this server's own compression (and any proxy's)
            // off the response: the bytes on the wire are what is being timed.
            'Cache-Control': 'no-store, no-transform',
        });
        // Random bytes: nothing between here and the client can compress them.
        const chunk = crypto.randomBytes(PROBE_CHUNK_BYTES);
        let sent = 0;
        const pump = () => {
            while (sent < PROBE_BYTES) {
                const size = Math.min(PROBE_CHUNK_BYTES, PROBE_BYTES - sent);
                sent += size;
                if (!res.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
                    res.once('drain', pump);
                    return;
                }
            }
            res.end();
        };
        res.on('error', () => {});
        pump();
    }

    /**
     * Download the probe through `baseUrl`. Resolves to { status, kbps }:
     * 'measured' with the rate, 'fast' when the transfer finished too quickly to
     * need a limit, or 'failed' (with a `reason`) when the link could not be
     * reached. Concurrent calls share one measurement.
     */
    function measure(baseUrl, probePath) {
        if (running) return running;
        running = (async () => {
            if (typeof fetchImpl !== 'function' || !baseUrl) return { status: 'failed', kbps: null, reason: 'unavailable' };
            let completed = false;
            let reason = 'no data';
            const token = crypto.randomBytes(24).toString('hex');
            armed = { token, expiresAt: now() + TOKEN_TTL_MS };
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
            timeout.unref?.();
            let measuredBytes = 0;
            let measuredFrom = 0;
            let lastAt = 0;
            try {
                const response = await fetchImpl(`${baseUrl}${probePath}/${token}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                if (!response.ok || !response.body) return { status: 'failed', kbps: null, reason: `HTTP ${response.status}` };
                const startedAt = now();
                const reader = response.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const at = now();
                    if (at - startedAt < PROBE_RAMP_MS) continue;
                    if (!measuredFrom) {
                        measuredFrom = at;
                        continue;
                    }
                    measuredBytes += value.byteLength;
                    lastAt = at;
                }
                completed = true;
            } catch (err) {
                // A timeout still leaves whatever was measured before it.
                reason = controller.signal.aborted ? 'timed out' : (err?.cause?.code || err?.code || err?.message || 'request failed');
            } finally {
                clearTimeout(timeout);
                armed = null;
            }
            const elapsedMs = lastAt - measuredFrom;
            if (!measuredFrom || elapsedMs < PROBE_MIN_MEASURED_MS || measuredBytes <= 0) {
                // The whole download fitting inside the ramp-up window means the
                // link is faster than any relay bitrate.
                return completed ? { status: 'fast', kbps: null } : { status: 'failed', kbps: null, reason };
            }
            const kbps = Math.round((measuredBytes * 8) / elapsedMs);
            last = { kbps, at: now(), baseUrl };
            logger.log(`[Relay] The public link carries about ${(kbps / 1000).toFixed(1)} Mbps per connection.`);
            return { status: 'measured', kbps };
        })().finally(() => { running = null; });
        return running;
    }

    return { handler, measure, getLast: () => last };
}

module.exports = { createRelayCapacityProbe, PROBE_BYTES };
