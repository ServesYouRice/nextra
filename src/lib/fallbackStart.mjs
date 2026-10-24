// @ts-check

// The viewer's fallback-consume-start (the OBS relay's fMP4 stream): sent once,
// bounded by an ack timeout, and owned through the subscription ledger.
//
// The server answers `{ ok: true, fallbackAvailable }` on success and
// `{ error }` on a refusal, not the `{ success }` shape socketRequest needs, so
// the start goes through emitClaimedStart (claim and emit in one synchronous
// block, see subscriptionLedger.mjs) on top of the single-attempt
// emitWithTimedAck (timedAck.mjs), which hands the raw answer back.
//
// What a settled start means for the viewer is decided here, in one place:
//
// - started:      the answer came while the viewer that asked still wants it,
//                 and it holds no `error`. The claim stays in the ledger; the
//                 caller owns it from here (exitFallbackMode releases it).
// - rejected:     the answer holds an `error`. The server subscribed nobody, so
//                 the claim is released without a stop.
// - stale:        the answer came after the viewer that asked had left, its room
//                 had ended, its session was replaced or the start was given up.
//                 Nothing of the viewer is touched. The subscription the server
//                 may have made is stopped, but only when the ledger shows this
//                 claim is still the latest on this connection: fallback-consume-stop
//                 is socket-wide, so a stop after a newer start on the same
//                 connection would remove the newer subscription.
// - timeout:      no answer in time. The server may still process the start; a
//                 stop on the same connection is ordered after it, and is sent
//                 on the same terms as for a stale answer.
// - disconnected: the connection dropped first. The subscription went with the
//                 old socket.id, so no stop is sent.
//
// Pure module with no React dependency; the unit tests drive it with a fake socket.

import { DEFAULT_ACK_TIMEOUT_MS, isAckDisconnectError, isAckTimeoutError } from './timedAck.mjs';
import { emitClaimedStart, releaseSubscription } from './subscriptionLedger.mjs';

/** @typedef {import('./subscriptionLedger.mjs').SubscriptionClaim} SubscriptionClaim */
/** @typedef {import('./subscriptionLedger.mjs').SubscriptionLedger} SubscriptionLedger */
/** @typedef {import('./subscriptionLedger.mjs').LedgerSocket} LedgerSocket */

/**
 * @typedef {(
 *   | { status: 'started', response: any }
 *   | { status: 'rejected', response: any, error: unknown }
 *   | { status: 'stale', response: any }
 *   | { status: 'timeout', error: Error }
 *   | { status: 'disconnected', error: Error }
 * )} FallbackStartOutcome
 */

/**
 * Sends fallback-consume-start and settles it.
 *
 * Throws a SocketNotConnectedError, claiming and emitting nothing, while the
 * socket is disconnected. Otherwise returns the claim at once (the caller
 * records it as the start it is waiting for) and the promise of the outcome,
 * which never rejects for a timeout or a disconnect.
 *
 * @param {object} options
 * @param {SubscriptionLedger} options.ledger
 * @param {LedgerSocket} options.socket
 * @param {unknown} options.token Who sends the start (the viewer session's generation).
 * @param {(claim: SubscriptionClaim) => boolean} options.isCurrent Whether the viewer
 *   that sent this start still wants its answer: the same session, still joined to
 *   the same room, the room not ended, and the start not given up or replaced.
 * @param {number} [options.timeoutMs]
 * @returns {{ claim: SubscriptionClaim, settled: Promise<FallbackStartOutcome> }}
 */
export function beginFallbackStart({ ledger, socket, token, isCurrent, timeoutMs = DEFAULT_ACK_TIMEOUT_MS }) {
    const { claim, acknowledged } = emitClaimedStart(
        ledger, 'fallback', token, socket, 'fallback-consume-start', {}, { timeoutMs },
    );

    /** @returns {Promise<FallbackStartOutcome>} */
    const settled = acknowledged.then(
        (response) => {
            // Read as today: an answer holding `error` is a refusal, any other is a success.
            const refused = Boolean(response?.error);
            if (!isCurrent(claim)) {
                if (refused) ledger.release('fallback', claim);
                else releaseSubscription(ledger, 'fallback', claim, socket, 'fallback-consume-stop');
                return { status: 'stale', response };
            }
            if (refused) {
                ledger.release('fallback', claim);
                return { status: 'rejected', response, error: response.error };
            }
            return { status: 'started', response };
        },
        (err) => {
            if (isAckTimeoutError(err)) {
                releaseSubscription(ledger, 'fallback', claim, socket, 'fallback-consume-stop');
                return { status: 'timeout', error: err };
            }
            ledger.release('fallback', claim);
            if (isAckDisconnectError(err)) return { status: 'disconnected', error: err };
            throw err;
        },
    );
    return { claim, settled };
}
