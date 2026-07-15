// @ts-check

/** @typedef {{ quality: 'excellent'|'good'|'fair'|'poor'|'unknown', rttMs: number|null, packetsLost: number, jitterMs: number|null }} ConnectionQuality */

/**
 * @param {Iterable<any>} reports
 * @returns {ConnectionQuality}
 */
export function summarizeConnectionQuality(reports) {
    let rttMs = null;
    let packetsLost = 0;
    let jitterMs = null;
    for (const report of reports || []) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && Number.isFinite(report.currentRoundTripTime)) {
            rttMs = report.currentRoundTripTime * 1000;
        }
        if (report.type === 'inbound-rtp' && !report.isRemote) {
            packetsLost += Math.max(0, Number(report.packetsLost) || 0);
            if (Number.isFinite(report.jitter)) jitterMs = Math.max(jitterMs || 0, report.jitter * 1000);
        }
    }
    /** @type {ConnectionQuality['quality']} */
    let quality = 'unknown';
    if (rttMs != null || jitterMs != null) {
        if ((rttMs ?? 0) > 500 || (jitterMs ?? 0) > 100) quality = 'poor';
        else if ((rttMs ?? 0) > 250 || (jitterMs ?? 0) > 60) quality = 'fair';
        else if ((rttMs ?? 0) > 120 || (jitterMs ?? 0) > 30) quality = 'good';
        else quality = 'excellent';
    }
    return { quality, rttMs, packetsLost, jitterMs };
}
