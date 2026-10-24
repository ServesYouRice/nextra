// src/lib/obsWebSocket.js - Connect to OBS WebSocket and auto-configure WHIP stream settings
// OBS 28+ ships with obs-websocket v5 on port 4455 by default.

import {
    buildLiveOutputPatch,
    buildStreamEncoderSettings,
    chooseEncoderCandidates,
    formatEncoderLabel,
    getEncoderKind,
    getSimpleOutputEncoderId,
    normalizeObsEncoderRequest,
} from './obsOutputModel.mjs';

const OBS_WS_PORT = 4455;
const OBS_WS_CONNECT_TIMEOUT = 5000;
const OBS_WS_REQUEST_TIMEOUT = 5000;
const OBS_WS_TRANSACTION_TIMEOUT = 30000;
// How long and how often to wait for a stopped output to report itself idle.
const STREAM_STOP_POLL_INTERVAL_MS = 250;
const STREAM_STOP_POLL_ATTEMPTS = 10;
// The short test stream that makes OBS release a stale encoder: how often its
// status is read, how long it may take to run and to stop, and the pause
// before a second try.
const TEST_STREAM_POLL_INTERVAL_MS = 100;
const TEST_STREAM_START_POLL_ATTEMPTS = 60;
const TEST_STREAM_STOP_POLL_ATTEMPTS = 40;
const TEST_STREAM_RETRY_DELAY_MS = 300;
// OBS needs a moment to finish resetting its video pipeline after the video
// settings change; starting the encoder before then can crash OBS.
const VIDEO_SETTLE_MS = 1200;
// What a transaction's deadline handler (the rollback) gets, after the deadline,
// before the connection is closed on it: the stop gate at its slowest (every
// poll, 2.5 s) and the video settle time before a restart (1.2 s), plus room
// for three requests that run into their own deadline. Past that OBS is not
// answering and more waiting restores nothing.
const OBS_WS_DEADLINE_GRACE = STREAM_STOP_POLL_INTERVAL_MS * STREAM_STOP_POLL_ATTEMPTS
    + VIDEO_SETTLE_MS
    + 3 * OBS_WS_REQUEST_TIMEOUT;

async function sha256Base64(input) {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

/**
 * Connect to OBS WebSocket, authenticate, and run a callback with the ws + a request helper.
 * Pass a non-finite `transactionTimeoutMs` to hold the connection open until the
 * callback settles it; see openObsControlChannel().
 *
 * The callback's third argument is `{ signal, onDeadline }`. When the transaction
 * deadline passes, a callback that registered a handler with `onDeadline` is
 * not cut off: `signal` is aborted and the handler is called with the timeout
 * result, to clean up over the still-open connection and settle through
 * `done`. It has `deadlineGraceMs` for that; after it the connection is closed
 * and the transaction settles with the timeout. Without a handler the deadline
 * settles the transaction at once.
 *
 * The returned promise has an `abort(result)` method that ends the transaction
 * from outside, at any stage: it closes the socket and settles with `result`
 * (a failure by default) at once, without running a deadline handler. Once the
 * transaction has settled, nothing else runs on it: a handshake message that
 * arrives later is ignored and the callback is never called. `abort()` after the
 * transaction settled does nothing.
 * @returns {Promise<{ success: boolean, message: string }> & { abort: (result?: { success: boolean, message: string }) => void }}
 */
export function withObsConnection(password, callback, {
    WebSocketImpl = globalThis.WebSocket,
    url = `ws://127.0.0.1:${OBS_WS_PORT}`,
    connectTimeoutMs = OBS_WS_CONNECT_TIMEOUT,
    requestTimeoutMs = OBS_WS_REQUEST_TIMEOUT,
    transactionTimeoutMs = OBS_WS_TRANSACTION_TIMEOUT,
    deadlineGraceMs = OBS_WS_DEADLINE_GRACE,
} = {}) {
    let abortTransaction = () => {};
    const transaction = new Promise((resolve) => {
        if (typeof WebSocketImpl !== 'function') {
            resolve({ success: false, message: 'WebSocket is unavailable in this browser.' });
            return;
        }

        const ws = new WebSocketImpl(url);
        let identified = false;
        let settled = false;
        let connectTimeout = null;
        let transactionTimeout = null;
        let deadlineGraceTimeout = null;
        let deadlineHandler = null;
        const deadlineController = new AbortController();
        const pendingRequests = new Map();
        let reqCounter = 0;

        const rejectPendingRequests = (error) => {
            for (const pending of pendingRequests.values()) {
                clearTimeout(pending.timeout);
                pending.reject(error);
            }
            pendingRequests.clear();
        };

        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimeout);
            clearTimeout(transactionTimeout);
            clearTimeout(deadlineGraceTimeout);
            rejectPendingRequests(new Error(result?.message || 'OBS WebSocket transaction ended.'));
            try { ws.close(); } catch {}
            resolve(result);
        };
        abortTransaction = (result) => done(result ?? {
            success: false,
            message: 'OBS WebSocket transaction was aborted.',
        });

        const expireTransaction = () => {
            const timedOut = {
                success: false,
                message: `OBS setup timed out after ${transactionTimeoutMs}ms.`,
            };
            if (!deadlineHandler) {
                done(timedOut);
                return;
            }
            // The handler settles the transaction itself, over the open
            // connection. If it does not in time, the connection goes anyway.
            deadlineGraceTimeout = setTimeout(() => {
                done({
                    ...timedOut,
                    message: `${timedOut.message} Rollback incomplete: not finished ${deadlineGraceMs}ms later, so the connection was closed.`,
                });
            }, deadlineGraceMs);
            deadlineController.abort(new Error(timedOut.message));
            Promise.resolve()
                .then(() => deadlineHandler(timedOut))
                .catch(() => done(timedOut));
        };

        connectTimeout = setTimeout(() => {
            done({
                success: false,
                message: 'OBS WebSocket connection timed out. Make sure OBS is running and WebSocket server is enabled (Tools > WebSocket Server Settings).',
            });
        }, connectTimeoutMs);

        function sendRequest(requestType, requestData) {
            return new Promise((reqResolve, reqReject) => {
                if (settled || !identified) {
                    reqReject(new Error('OBS WebSocket is not connected.'));
                    return;
                }

                const requestId = `req-${++reqCounter}`;
                const requestTimeout = setTimeout(() => {
                    pendingRequests.delete(requestId);
                    reqReject(new Error(`OBS request ${requestType} timed out after ${requestTimeoutMs}ms.`));
                }, requestTimeoutMs);
                pendingRequests.set(requestId, {
                    resolve: reqResolve,
                    reject: reqReject,
                    timeout: requestTimeout,
                });

                try {
                    ws.send(JSON.stringify({
                        op: 6,
                        d: { requestType, requestId, ...(requestData ? { requestData } : {}) },
                    }));
                } catch (error) {
                    clearTimeout(requestTimeout);
                    pendingRequests.delete(requestId);
                    reqReject(error);
                }
            });
        }

        ws.onopen = () => {};

        ws.onerror = () => {
            done({
                success: false,
                message: 'Cannot connect to OBS WebSocket. Make sure OBS is running and WebSocket server is enabled (Tools > WebSocket Server Settings).',
            });
        };

        ws.onclose = (event) => {
            let msg = identified
                ? 'OBS WebSocket disconnected before setup completed.'
                : 'OBS WebSocket connection closed before setup completed.';
            if (event.code === 4005) msg = 'OBS WebSocket authentication failed. Please check your password.';
            else if (event.code === 4006) msg = 'OBS WebSocket payload was invalid.';
            else if (event.code === 4009) msg = 'OBS WebSocket authentication required but none provided.';
            done({ success: false, message: msg });
        };

        ws.onmessage = async (event) => {
            // The transaction is over (closed, aborted or timed out); a handshake
            // that was still on its way must not start anything on it.
            if (settled) return;
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }

            const op = msg.op;

            if (op === 0) {
                const authRequired = msg.d?.authentication;
                const identify = { rpcVersion: msg.d?.rpcVersion || 1, eventSubscriptions: 0 };

                if (authRequired && password) {
                    try {
                        const { challenge, salt } = authRequired;
                        const secret = await sha256Base64(password + salt);
                        identify.authentication = await sha256Base64(secret + challenge);
                    } catch {
                        done({ success: false, message: 'Failed to compute OBS auth hash.' });
                        return;
                    }
                } else if (authRequired && !password) {
                    done({ success: false, message: 'OBS WebSocket requires a password. Enter it in the OBS WebSocket password field.' });
                    return;
                }

                // The password hash took time; the transaction may have ended meanwhile.
                if (settled) return;
                ws.send(JSON.stringify({ op: 1, d: identify }));
            }

            if (op === 2) {
                if (identified) return;
                identified = true;
                clearTimeout(connectTimeout);
                if (Number.isFinite(transactionTimeoutMs)) {
                    transactionTimeout = setTimeout(expireTransaction, transactionTimeoutMs);
                }
                Promise.resolve()
                    // Settled in the meantime (aborted right behind Identified):
                    // the callback must not run on a connection that is gone.
                    .then(() => (settled ? undefined : callback(sendRequest, done, {
                        signal: deadlineController.signal,
                        onDeadline: (handler) => { deadlineHandler = handler; },
                    })))
                    .catch((error) => done({
                        success: false,
                        message: error instanceof Error ? error.message : String(error),
                    }));
            }

            if (op === 7) {
                const reqId = msg.d?.requestId;
                const pending = pendingRequests.get(reqId);
                if (pending) {
                    pendingRequests.delete(reqId);
                    clearTimeout(pending.timeout);
                    pending.resolve(msg.d);
                }
            }
        };
    });
    // The executor has run by now, so `abortTransaction` is the real one.
    transaction.abort = (result) => abortTransaction(result);
    return transaction;
}

function normalizeProfileValue(value) {
    return value == null ? null : String(value);
}

function normalizeOutputValue(value) {
    if (value == null) return null;
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    const maybeNumber = Number(value);
    if (!Number.isNaN(maybeNumber) && String(maybeNumber) === String(value)) {
        return maybeNumber;
    }
    return String(value);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStreamStatus(sendRequest) {
    const response = await sendRequest('GetStreamStatus');
    if (response.requestStatus?.result !== true) return null;
    return response.responseData || null;
}

/**
 * Poll until OBS reports the stream output idle. OBS answers StopStream before
 * the output has finished shutting down, so the answer alone proves nothing.
 *
 * With `failClosed`, only a status that says outputActive is false and does not
 * say it is reconnecting counts as idle: one that cannot be read (the request
 * failed, was refused or carried no data) is taken as still active, and
 * `statusKnown` tells whether the last poll could be read. Without it, any
 * status that does not say active or reconnecting counts as idle and a failing
 * request propagates. `throwOnRequestError` decides that last point on its own:
 * a fail-closed wait with it set ends at the first request that fails.
 *
 * @returns {Promise<{ inactive: boolean, statusKnown: boolean }>}
 */
async function waitForStreamInactive(sendRequest, {
    wait = delay,
    intervalMs = STREAM_STOP_POLL_INTERVAL_MS,
    attempts = STREAM_STOP_POLL_ATTEMPTS,
    failClosed = false,
    throwOnRequestError = !failClosed,
} = {}) {
    let statusKnown = true;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        await wait(intervalMs);
        let status = null;
        try {
            status = await getStreamStatus(sendRequest);
        } catch (error) {
            if (throwOnRequestError) throw error;
        }
        if (failClosed) {
            statusKnown = typeof status?.outputActive === 'boolean';
            if (status?.outputActive === false && status.outputReconnecting !== true) {
                return { inactive: true, statusKnown };
            }
        } else if (!status?.outputActive && !status?.outputReconnecting) {
            return { inactive: true, statusKnown };
        }
    }
    return { inactive: false, statusKnown };
}

async function stopActiveStream(sendRequest) {
    const status = await getStreamStatus(sendRequest);
    if (!status?.outputActive && !status?.outputReconnecting) {
        return { stopped: false, ok: true, wasLive: false };
    }
    // A stream that was really running hands its encoder back when it stops;
    // one that was only retrying does not.
    const wasLive = status.outputReconnecting !== true;

    const stopResponse = await sendRequest('StopStream');
    if (stopResponse.requestStatus?.result !== true) {
        return {
            stopped: false,
            ok: false,
            message: stopResponse.requestStatus?.comment || 'unknown error',
        };
    }

    const { inactive } = await waitForStreamInactive(sendRequest);
    if (inactive) {
        return { stopped: true, ok: true, wasLive };
    }

    return {
        stopped: true,
        ok: false,
        wasLive,
        message: 'OBS did not stop the previous stream in time.',
    };
}

/**
 * The address of the server's encoder-reset probe for a room's WHIP URL: the
 * same URL with `/probe` added to its path. The server (lib/whipRoutes.js)
 * answers a stream sent there as it answers a WHIP start, so OBS sees it run,
 * but makes nothing of it: no producer, no relay, nothing a viewer or the host
 * page receives. null when the URL cannot be read.
 *
 * @param {string} whipUrl
 * @returns {string | null}
 */
export function whipProbeUrl(whipUrl) {
    let url;
    try {
        url = new URL(whipUrl);
    } catch {
        return null;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/probe`;
    return url.toString();
}

/**
 * Make OBS let go of an encoder it set up for a stream that never connected.
 *
 * Each time OBS retries a target that is gone (the room ended, the server was
 * closed) it sets its stream encoder up again, and neither the failed attempt
 * nor stopping the retry releases it. An encoder left like that ignores new
 * settings and, worse, a new output resolution: it goes on encoding the old size
 * from a video pipeline that no longer exists, which is a green picture. OBS
 * does not say whether it holds one, so unless a running stream was just stopped
 * it has to be assumed. Only a stream that actually ran and was stopped releases
 * it — so run one, briefly. The caller points OBS at the server's probe first
 * (whipProbeUrl), so that whatever OBS is showing reaches no one.
 *
 * Every run's stream is stopped however the run ends, a request that fails
 * included, and counts as stopped only once OBS reports the output idle.
 * `holdStop()` is called before each start and returns a release function,
 * which is called once that run's stream is confirmed stopped; one that is not
 * keeps its stop held (see the transaction's `hold`). A request that fails
 * propagates after the cleanup.
 *
 * @returns {Promise<{ released: boolean, stopped: boolean, message?: string }>}
 *   `released`: a test stream ran and was stopped, so OBS let go of the
 *   encoder. `stopped`: no test stream is left running; when false, nothing may
 *   change the video or encoder settings, and `message` says what was seen.
 */
async function releaseStaleEncoder(sendRequest, {
    holdStop = () => () => {},
    stopPollIntervalMs = TEST_STREAM_POLL_INTERVAL_MS,
    stopPollAttempts = TEST_STREAM_STOP_POLL_ATTEMPTS,
} = {}) {
    // A test stream that fails to connect leaves exactly the encoder it was
    // meant to clear, so one that did not run is tried once more.
    for (let run = 0; run < 2; run += 1) {
        if (run > 0) await delay(TEST_STREAM_RETRY_DELAY_MS);
        const releaseHold = holdStop();
        let started;
        let ran = false;
        let stop;
        try {
            started = successfulResponse(await sendRequest('StartStream'));
            for (let attempt = 0; started && !ran && attempt < TEST_STREAM_START_POLL_ATTEMPTS; attempt += 1) {
                await delay(TEST_STREAM_POLL_INTERVAL_MS);
                const status = await getStreamStatus(sendRequest);
                // Retrying already: the target refused the stream, and waiting longer
                // only lets OBS set the encoder up once more.
                if (status?.outputReconnecting === true) break;
                ran = status?.outputActive === true;
            }
        } finally {
            // Also after a start OBS refused or whose answer never came: an
            // output may be up all the same, and the video must not change
            // under it.
            stop = await stopTestStream(sendRequest, { intervalMs: stopPollIntervalMs, attempts: stopPollAttempts });
            if (stop.stopped) releaseHold();
        }
        if (!stop.stopped) return { released: false, stopped: false, message: stop.message };
        if (ran) return { released: true, stopped: true };
        if (!started) return { released: false, stopped: true };
    }
    return { released: false, stopped: true };
}

/**
 * Stop a test stream and confirm that OBS reports the output idle. OBS answers
 * StopStream before the output is down, and refuses it for one that already
 * is, so the status decides; a refusal is named when the output stays up. A
 * status that cannot be read counts as still active, and a request that fails
 * ends the check unconfirmed rather than polling a connection that is gone.
 *
 * @returns {Promise<{ stopped: boolean, message?: string }>}
 */
async function stopTestStream(sendRequest, { intervalMs, attempts }) {
    let refusal = '';
    try {
        const response = await sendRequest('StopStream');
        if (!successfulResponse(response)) {
            refusal = `StopStream: ${response?.requestStatus?.comment || 'rejected'}; `;
        }
        const { inactive, statusKnown } = await waitForStreamInactive(sendRequest, {
            intervalMs,
            attempts,
            failClosed: true,
            throwOnRequestError: true,
        });
        if (inactive) return { stopped: true };
        return {
            stopped: false,
            message: `${refusal}${statusKnown ? `output still active after ${intervalMs * attempts}ms` : 'stream state unknown'}`,
        };
    } catch (error) {
        return { stopped: false, message: `${refusal}${error instanceof Error ? error.message : String(error)}` };
    }
}

async function getProfileValue(sendRequest, category, name) {
    const response = await sendRequest('GetProfileParameter', {
        parameterCategory: category,
        parameterName: name,
    });

    if (response.requestStatus?.result !== true) {
        return null;
    }

    return normalizeProfileValue(response.responseData?.parameterValue);
}

async function trySetProfile(sendRequest, category, name, value) {
    const response = await sendRequest('SetProfileParameter', {
        parameterCategory: category,
        parameterName: name,
        parameterValue: String(value),
    });
    return response.requestStatus?.result === true;
}

async function setAndVerifyProfile(sendRequest, category, name, value) {
    const wrote = await trySetProfile(sendRequest, category, name, value);
    if (!wrote) {
        return { wrote: false, verified: false, actual: null };
    }

    const actual = await getProfileValue(sendRequest, category, name);
    const expected = normalizeProfileValue(value);
    return {
        wrote: true,
        verified: actual === expected,
        actual,
    };
}

async function getOutputSettings(sendRequest, outputName) {
    const response = await sendRequest('GetOutputSettings', { outputName });
    if (response.requestStatus?.result !== true) {
        return null;
    }
    return response.responseData?.outputSettings || {};
}

/**
 * Find the name of OBS's streaming output. The internal name varies by OBS
 * version and output mode (and isn't always one of the legacy adv_stream/
 * simple_stream), so ask OBS via GetOutputList and match the streaming output by
 * kind (whip/rtmp/ftl/mpegts) or name, before falling back to the legacy probes.
 */
async function findStreamOutputName(sendRequest) {
    const listResponse = await sendRequest('GetOutputList');
    if (listResponse.requestStatus?.result === true) {
        const outputs = listResponse.responseData?.outputs || [];
        const isStreamKind = (kind) => /whip|rtmp|ftl|mpegts|stream/i.test(String(kind || ''));
        const match = outputs.find((o) => isStreamKind(o.outputKind))
            || outputs.find((o) => /stream/i.test(String(o.outputName || '')));
        if (match?.outputName) {
            return match.outputName;
        }
    }

    // Fallback: probe the legacy fixed names directly.
    for (const candidate of ['adv_stream', 'simple_stream']) {
        if (await getOutputSettings(sendRequest, candidate) !== null) {
            return candidate;
        }
    }
    return null;
}

const STREAM_OUTPUT_ENCODER_KEYS = new Set([
    'bitrate',
    'rate_control',
    'keyint_sec',
    'lookahead',
    'multipass',
    'preset2',
    'tune',
    'profile',
    'preset',
    'x264opts',
]);

async function setAndVerifyOutputSettings(sendRequest, outputName, patch) {
    const currentSettings = await getOutputSettings(sendRequest, outputName);
    if (!currentSettings) {
        return { wrote: false, verified: false, actual: null };
    }

    const retainedSettings = Object.fromEntries(
        Object.entries(currentSettings).filter(([key]) => !STREAM_OUTPUT_ENCODER_KEYS.has(key)),
    );
    const targetSettings = { ...retainedSettings, ...patch };
    const setResponse = await sendRequest('SetOutputSettings', {
        outputName,
        outputSettings: targetSettings,
    });

    if (setResponse.requestStatus?.result !== true) {
        return { wrote: false, verified: false, actual: null };
    }

    const actual = await getOutputSettings(sendRequest, outputName);
    if (!actual) {
        return { wrote: true, verified: false, actual: null };
    }

    const verified = Object.entries(patch).every(([key, expected]) => (
        normalizeOutputValue(actual[key]) === normalizeOutputValue(expected)
    ));

    return { wrote: true, verified, actual };
}

function successfulResponse(response) {
    return response?.requestStatus?.result === true;
}

// Starting the stream undoes stopping it and the other way round.
function streamInverse(requestType) {
    if (requestType === 'StopStream') return { requestType: 'StartStream' };
    if (requestType === 'StartStream') return { requestType: 'StopStream' };
    return null;
}

// Restores that reset OBS's video pipeline: the video settings, and the color
// space and range, which the profile keeps under Video.
function affectsVideo(step) {
    return step.requestType === 'SetVideoSettings'
        || (step.requestType === 'SetProfileParameter' && step.requestData?.parameterCategory === 'Video');
}

/**
 * Wrap mutating OBS requests with a snapshot of the value they replace. The
 * resulting rollback runs successful mutations, and ones whose answer never
 * arrived (or has not yet when the rollback begins), in reverse order and
 * deliberately uses the raw request function so rollback operations are not
 * recorded again. Once it has begun, no further request is sent through the
 * transaction.
 *
 * Rollback treats a StopStream as a gate: OBS answers it before the output has
 * really stopped, so it polls until the output is idle and, if that cannot be
 * confirmed, sends nothing more. After the video was restored it waits out the
 * settle time before starting the stream again.
 *
 * `hold(step)` journals the inverse of a change made outside the transaction,
 * over the raw channel, for as long as that change may be in effect: a
 * rollback that begins before the returned release function is called replays
 * it (as the newest step at that point). Call the release function once the
 * change is undone; one that could not be undone stays journaled.
 *
 * `registerUndo(label, undo)` journals a change that is no OBS request at all
 * (a file, say) the same way: a rollback calls `undo()` in its place in the
 * reverse order, and a call that throws or rejects is a failure reported as
 * `<label>: <message>`. It also runs when the stop gate has ended the rollback
 * for the OBS requests, which change nothing under a live output; a file
 * cannot. It returns a release function like `hold`'s.
 *
 * @param {Function} sendRequest
 * @param {object} [options] Timing seams for tests; the defaults are what runs.
 * @param {(ms: number) => Promise<void>} [options.delay]
 * @param {() => number} [options.now]
 * @param {number} [options.stopPollIntervalMs]
 * @param {number} [options.stopPollAttempts]
 * @param {number} [options.videoSettleMs]
 */
export function createObsConfigurationTransaction(sendRequest, {
    delay: wait = delay,
    now = () => Date.now(),
    stopPollIntervalMs = STREAM_STOP_POLL_INTERVAL_MS,
    stopPollAttempts = STREAM_STOP_POLL_ATTEMPTS,
    videoSettleMs = VIDEO_SETTLE_MS,
} = {}) {
    const rollbackSteps = [];
    // Steps for requests that were sent and have no answer yet. A rollback that
    // begins now treats them like ones that timed out: OBS may still apply them.
    const unanswered = new Set();
    let finished = false;

    async function snapshotMutation(requestType, requestData) {
        if (requestType === 'SetStreamServiceSettings') {
            const previous = await sendRequest('GetStreamServiceSettings');
            if (!successfulResponse(previous)) return null;
            return {
                requestType: 'SetStreamServiceSettings',
                requestData: {
                    streamServiceType: previous.responseData?.streamServiceType,
                    streamServiceSettings: previous.responseData?.streamServiceSettings || {},
                },
            };
        }

        if (requestType === 'SetVideoSettings') {
            const previous = await sendRequest('GetVideoSettings');
            if (!successfulResponse(previous)) return null;
            return {
                requestType: 'SetVideoSettings',
                requestData: previous.responseData || {},
            };
        }

        if (requestType === 'SetProfileParameter') {
            const identity = {
                parameterCategory: requestData?.parameterCategory,
                parameterName: requestData?.parameterName,
            };
            const previous = await sendRequest('GetProfileParameter', identity);
            if (!successfulResponse(previous)) return null;
            // OBS answers null for a parameter the user never set, and reads its
            // default instead. Sending null back deletes the parameter again;
            // an empty string would turn the default into an explicit empty value.
            const previousValue = previous.responseData?.parameterValue;
            return {
                requestType: 'SetProfileParameter',
                requestData: {
                    ...identity,
                    parameterValue: normalizeProfileValue(previousValue),
                },
            };
        }

        if (requestType === 'SetOutputSettings') {
            const outputName = requestData?.outputName;
            const previous = await sendRequest('GetOutputSettings', { outputName });
            if (!successfulResponse(previous)) return null;
            return {
                requestType: 'SetOutputSettings',
                requestData: {
                    outputName,
                    outputSettings: previous.responseData?.outputSettings || {},
                },
            };
        }

        return undefined;
    }

    async function request(requestType, requestData) {
        if (finished) {
            throw new Error('OBS configuration transaction is already complete.');
        }

        const inverse = await snapshotMutation(requestType, requestData);
        if (inverse === null) {
            return {
                requestStatus: {
                    result: false,
                    comment: `Could not snapshot OBS state before ${requestType}.`,
                },
            };
        }

        // The rollback may have begun while the snapshot was being read; a
        // mutation sent now would land after, and outside, the restore.
        if (finished) {
            throw new Error('OBS configuration transaction is already complete.');
        }

        const undo = inverse || streamInverse(requestType);
        // What a rollback replays if this request gets no answer; see the catch.
        const ifUnanswered = inverse || (requestType === 'StartStream' ? undo : null);
        if (ifUnanswered) unanswered.add(ifUnanswered);
        let response;
        try {
            response = await sendRequest(requestType, requestData);
        } catch (error) {
            // A request that timed out may still be applied by OBS after the
            // deadline, so the state captured before it was sent is journaled
            // and a rollback restores it. Restoring a value that never changed
            // is harmless; leaving an applied change in place is not. That holds
            // for a start too: the rollback verifies the output is stopped
            // before it restores anything, so a stop it did not need costs a
            // poll, and a start that did happen is not left running over the
            // restores. A stop that timed out is left out: its inverse is a
            // start, and one OBS refuses because the stream never stopped
            // would be reported as a failed rollback.
            // (If the rollback began first, it took the step along already.)
            if (ifUnanswered && !finished) rollbackSteps.push(ifUnanswered);
            throw error;
        } finally {
            unanswered.delete(ifUnanswered);
        }
        // OBS answered that it refused the request: nothing changed.
        if (!successfulResponse(response)) return response;

        if (undo && !finished) rollbackSteps.push(undo);
        return response;
    }

    async function rollback() {
        if (finished) return [];
        finished = true;
        const failures = [];
        // A request still waiting for its answer is the newest step, so it is
        // undone first.
        const steps = [...rollbackSteps, ...unanswered].reverse();
        unanswered.clear();
        let lastVideoRestoreAt = null;
        const runUndo = async (step) => {
            try {
                await step.undo();
            } catch (error) {
                failures.push(`${step.label}: ${error instanceof Error ? error.message : String(error)}`);
            }
        };
        for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index];
            if (step.undo) {
                await runUndo(step);
                continue;
            }
            if (step.requestType === 'StartStream' && lastVideoRestoreAt !== null) {
                // The video restore resets OBS's video pipeline; starting the
                // encoder while that is in flight can crash OBS. Wait out
                // whatever is left of the settle time since the last restore.
                const remainingMs = videoSettleMs - (now() - lastVideoRestoreAt);
                if (remainingMs > 0) await wait(remainingMs);
            }

            let failure = null;
            try {
                const response = await sendRequest(step.requestType, step.requestData);
                if (successfulResponse(response)) {
                    if (affectsVideo(step)) lastVideoRestoreAt = now();
                } else {
                    failure = `${step.requestType}: ${response?.requestStatus?.comment || 'rejected'}`;
                }
            } catch (error) {
                failure = `${step.requestType}: ${error instanceof Error ? error.message : String(error)}`;
                // No answer does not mean no change: count it from now.
                if (affectsVideo(step)) lastVideoRestoreAt = now();
            }

            if (step.requestType !== 'StopStream') {
                if (failure) failures.push(failure);
                continue;
            }

            // The answer to a StopStream is not the output being stopped. Nothing
            // that follows is safe to send until the output is confirmed idle,
            // and a status that cannot be read counts as not idle.
            const { inactive, statusKnown } = await waitForStreamInactive(sendRequest, {
                wait,
                intervalMs: stopPollIntervalMs,
                attempts: stopPollAttempts,
                failClosed: true,
            });
            // OBS refusing to stop an output that is already idle is not a failure.
            if (inactive) continue;
            if (failure) failures.push(failure);
            failures.push(statusKnown
                ? `StopStream: output still active after ${stopPollIntervalMs * stopPollAttempts}ms`
                : 'StopStream: stream state unknown');
            for (const skipped of steps.slice(index + 1)) {
                if (skipped.undo) await runUndo(skipped);
                else failures.push(`skipped ${skipped.requestType}`);
            }
            break;
        }
        rollbackSteps.length = 0;
        return failures;
    }

    function journal(step) {
        // A change made now would land after, and outside, the restore.
        if (finished) {
            throw new Error('OBS configuration transaction is already complete.');
        }
        rollbackSteps.push(step);
        return () => {
            const index = rollbackSteps.indexOf(step);
            if (index !== -1) rollbackSteps.splice(index, 1);
        };
    }

    function hold(step) {
        return journal(step);
    }

    function registerUndo(label, undo) {
        if (typeof undo !== 'function') {
            throw new TypeError('registerUndo needs a function that undoes the change.');
        }
        return journal({ label, undo });
    }

    function commit() {
        if (finished) return;
        finished = true;
        rollbackSteps.length = 0;
    }

    return { request, hold, registerUndo, rollback, commit };
}

const ENCODER_FILE_LABEL = 'encoder settings file';

/**
 * Store the encoder's settings through `writeEncoderSettings` and journal how
 * to put the file back, so that a setup which fails later takes the file along
 * with the OBS settings it restores.
 *
 * What the file held before is the server's to report: the answer to a
 * successful write may carry `previous`, the settings that restore the file
 * when they are passed to `writeEncoderSettings` again. Without it the file
 * cannot be put back, and the rollback says so, so that nothing claims OBS was
 * restored while the file was not. The same goes for a rollback that begins
 * while the write is still under way (the deadline): what the file will hold
 * is not known yet, and the write may land afterwards.
 *
 * @returns {Promise<boolean>} whether the settings were stored
 */
async function writeEncoderSettingsFile(transaction, writeEncoderSettings, { profileName, settings }) {
    const releaseUnderWay = transaction.registerUndo(ENCODER_FILE_LABEL, async () => {
        throw new Error('not restored (a write of it was still under way, so its previous contents are not known)');
    });
    let written = null;
    try {
        written = await writeEncoderSettings({ profileName, settings });
    } catch {
        // No answer is taken as no write, as it always was.
    } finally {
        releaseUnderWay();
    }
    if (written?.applied !== true) return false;

    const { previous } = written;
    const restorable = previous !== null && typeof previous === 'object'
        && !Array.isArray(previous) && Object.keys(previous).length > 0;
    transaction.registerUndo(ENCODER_FILE_LABEL, async () => {
        if (!restorable) throw new Error('not restored (its previous contents are not known)');
        let restored;
        try {
            restored = await writeEncoderSettings({ profileName, settings: previous });
        } catch (error) {
            throw new Error(`not restored (${error instanceof Error ? error.message : String(error)})`, { cause: error });
        }
        if (restored?.applied !== true) {
            throw new Error(`not restored (${restored?.reason || 'the server did not apply it'})`);
        }
    });
    return true;
}

/**
 * Auto-configure OBS stream settings via obs-websocket v5.
 *
 * @param {object} opts
 * @param {string} opts.whipUrl
 * @param {string} opts.bearerToken
 * @param {string} [opts.password]
 * @param {boolean} [opts.autoStart]
 * @param {object} [opts.videoSettings] - { outputWidth, outputHeight, fpsNumerator, fpsDenominator }
 * @param {object} [opts.encoderSettings] - { bitrateKbps, keyframeIntervalSec, preset, encoder }
 * @param {function} [opts.writeEncoderSettings] - async ({ profileName, settings }) =>
 *   { applied, reason, previous }; stores the encoder's settings where OBS reads them.
 *   `previous`, when the server can say what the file held before, is the settings
 *   that put it back when passed to this function; without it a rollback reports
 *   the file as not restored.
 * @param {function} [opts.listEncoders] - async () => the ids of the video encoders
 *   OBS has, or null when that is not known.
 * @param {object} [opts.transactionOptions] - timing seams for tests, passed to
 *   createObsConfigurationTransaction().
 * @param {object} [opts.connectionOptions] - timeouts and socket class for tests,
 *   passed to withObsConnection().
 * @param {object} [opts.encoderResetOptions] - how long to wait for the encoder-reset
 *   test stream to stop ({ stopPollIntervalMs, stopPollAttempts }), for tests.
 */
export async function configureObsStream({ whipUrl, bearerToken, password = '', autoStart = false, videoSettings = null, encoderSettings = null, writeEncoderSettings = null, listEncoders = null, transactionOptions = undefined, connectionOptions = undefined, encoderResetOptions = undefined }) {
    return withObsConnection(password, async (rawSendRequest, done, { signal, onDeadline }) => {
        const transaction = createObsConfigurationTransaction(rawSendRequest, transactionOptions);
        const requestedAv1 = String(encoderSettings?.videoCodec || encoderSettings?.encoder || '').toLowerCase() === 'av1';
        const sendRequest = transaction.request;
        // Housekeeping requests are not journaled (apart from the stop held
        // for a test stream, below), so a rollback cannot undo them. Once the
        // deadline has passed they stop, so that they do not run on while the
        // rollback has the connection.
        const housekeepingRequest = (requestType, requestData) => (signal.aborted
            ? Promise.reject(signal.reason)
            : rawSendRequest(requestType, requestData));
        let finishing = false;
        const finish = async (result, { timedOut = false } = {}) => {
            if (finishing) return;
            finishing = true;
            if (result.success) {
                transaction.commit();
            } else {
                const rollbackFailures = await transaction.rollback();
                if (rollbackFailures.length) {
                    result = {
                        ...result,
                        message: `${result.message} Rollback incomplete: ${rollbackFailures.join('; ')}`,
                    };
                } else if (timedOut || requestedAv1) {
                    result = {
                        ...result,
                        message: `${result.message} OBS settings were restored.${requestedAv1 ? ' Disable AV1 mode and retry to use H.264.' : ''}`,
                    };
                }
            }
            done(result);
        };
        // The deadline goes through finish like any other failure, so the
        // rollback runs over the open connection before it closes. A rollback
        // or failure already under way keeps going (finish ignores the call);
        // the connection's hard cap bounds it.
        onDeadline((timeoutResult) => finish(timeoutResult, { timedOut: true }));

        try {
        const applied = [];
        const warnings = [];
        // Set when OBS must restart before a new output mode or encoder applies;
        // the auto-start is then skipped (section-84098610a3c7f7be0c63f39f/Q-003).
        let restartRequired = false;

        // Always stop first, auto-start or not. Everything below rewrites the
        // stream service, video, and encoder settings the running output is
        // built on, and OBS can crash in obs.dll if those change underneath a
        // live output. A stream that outlived its target — the server was
        // killed, or the host page went away without a WHIP DELETE — is still
        // "active" as far as OBS is concerned, so this is the common case on
        // the second Start sharing rather than a rare one.
        const stopResult = await stopActiveStream(sendRequest);
        if (!stopResult.ok) {
            await finish({
                success: false,
                message: `OBS is still streaming to a previous target and could not be stopped: ${stopResult.message}`,
            });
            return;
        }
        if (stopResult.stopped) {
            applied.push('previous stream stopped');
        }

        const whipService = (server) => ({
            streamServiceType: 'whip_custom',
            streamServiceSettings: {
                server,
                bearer_token: bearerToken,
            },
        });
        const failedServiceWrite = (response) => finish({
            success: false,
            message: `Failed to set OBS stream settings: ${response?.requestStatus?.comment || 'unknown error'}`,
        });
        const resetNotRunWarning = 'OBS could not run the short test stream that clears the encoder settings of an earlier stream; if the picture or the delay is wrong, restart OBS';
        // Set once the service OBS had before the setup is journaled, by the
        // write that points OBS at the probe.
        let previousServiceJournaled = false;

        if (!stopResult.wasLive) {
            // The reset runs whether or not autoStart is set; only the final
            // start below depends on the flag. Decided in open questions
            // section-84098610a3c7f7be0c63f39f/Q-001 and
            // section-49e0545c60d121dd3e784d86/Q-002: skipping it brings back
            // the stale encoder and its green picture, so it is kept, and its
            // test stream goes to the server's probe, never to the room. The
            // probe answers like the room's WHIP endpoint but forwards nothing,
            // so whatever OBS is compositing (a whole desktop, say) reaches no
            // viewer before the host chose to go live. OBS is pointed at the
            // room only after the test stream is confirmed stopped.
            const probeUrl = whipProbeUrl(whipUrl);
            if (!probeUrl) {
                warnings.push(resetNotRunWarning);
            } else {
                const probeResult = await sendRequest('SetStreamServiceSettings', whipService(probeUrl));
                if (!successfulResponse(probeResult)) {
                    await failedServiceWrite(probeResult);
                    return;
                }
                previousServiceJournaled = true;

                // Uses the raw channel: this start/stop is housekeeping, not a
                // step a failed setup should roll back. Only while a test stream
                // may be running is a stop held in the journal: a rollback that
                // begins meanwhile (at the deadline, when housekeeping is
                // refused) stops it and sees it idle before it restores
                // anything, and so does the rollback after a stop that could not
                // be confirmed.
                const reset = await releaseStaleEncoder(housekeepingRequest, {
                    ...encoderResetOptions,
                    holdStop: () => transaction.hold({ requestType: 'StopStream' }),
                });
                if (!reset.stopped) {
                    await finish({
                        success: false,
                        message: `OBS could not confirm that the short test stream which clears the encoder of an earlier stream stopped (${reset.message}), so setup ended before changing the video or encoder settings.`,
                    });
                    return;
                }
                if (reset.released) {
                    applied.push('encoder reset');
                } else {
                    warnings.push(resetNotRunWarning);
                }
            }
        }

        // After the probe write the journal already holds the service OBS had
        // before the setup, which is what a rollback puts back, so this write
        // is not journaled again (its undo would put back the probe). Like the
        // housekeeping requests it is refused once the deadline has passed.
        const setResult = await (previousServiceJournaled ? housekeepingRequest : sendRequest)(
            'SetStreamServiceSettings',
            whipService(whipUrl),
        );

        if (!successfulResponse(setResult)) {
            await failedServiceWrite(setResult);
            return;
        }
        applied.push('WHIP URL + token');

        if (videoSettings) {
            const videoResult = await sendRequest('SetVideoSettings', videoSettings);
            if (videoResult.requestStatus?.result === true) {
                applied.push(`${videoSettings.outputWidth}x${videoSettings.outputHeight}@${videoSettings.fpsNumerator}fps`);
            } else {
                warnings.push(`resolution (${videoResult.requestStatus?.comment || 'failed'})`);
            }
        }

        if (encoderSettings) {
            const {
                bitrateKbps,
                keyframeIntervalSec = 2,
                preset = 'veryfast',
                videoCodec = encoderSettings.encoder || 'h264',
                obsEncoderIds = [],
                obsEncoderId,
                nvencPreset = 'p6',
                nvencMultipass = 'fullres',
                tuningLabel = '',
            } = encoderSettings;
            const encoderRequest = normalizeObsEncoderRequest({
                videoCodec,
                obsEncoderIds,
                obsEncoderId,
            });
            if (encoderRequest.error) {
                await finish({
                    success: false,
                    message: encoderRequest.error,
                });
                return;
            }
            const selectedVideoCodec = encoderRequest.videoCodec;
            // Setting an encoder always "succeeds", even one OBS does not have,
            // so the choice is made from OBS's own list when the server has it.
            let availableEncoders = null;
            if (typeof listEncoders === 'function') {
                try {
                    availableEncoders = await listEncoders();
                } catch {
                    availableEncoders = null;
                }
            }
            const encoderCandidates = chooseEncoderCandidates({
                videoCodec: selectedVideoCodec,
                candidates: encoderRequest.encoderCandidates,
                available: availableEncoders,
            });
            if (encoderCandidates.length === 0) {
                await finish({
                    success: false,
                    message: `OBS has no ${selectedVideoCodec.toUpperCase()} encoder on this machine that Nextra can use.`,
                });
                return;
            }

            // OBS builds its outputs — the mode and which encoder — when it starts
            // or when the profile changes, not when these values change. Remember
            // what they were so a change can be reported as needing a restart.
            const previousMode = await getProfileValue(sendRequest, 'Output', 'Mode');
            const previousEncoderId = await getProfileValue(sendRequest, 'AdvOut', 'Encoder');
            if ((await setAndVerifyProfile(sendRequest, 'Output', 'Mode', 'Advanced')).verified) {
                applied.push('Advanced mode');
            } else {
                warnings.push('could not verify Advanced output mode');
            }

            let selectedEncoderId = null;
            for (const candidate of encoderCandidates) {
                const result = await setAndVerifyProfile(sendRequest, 'AdvOut', 'Encoder', candidate);
                if (result.verified) {
                    selectedEncoderId = candidate;
                    break;
                }
            }
            const encoderLabel = formatEncoderLabel(selectedEncoderId);
            const encoderKind = getEncoderKind(selectedEncoderId);

            if (!selectedEncoderId) {
                await finish({
                    success: false,
                    message: `Failed to set OBS stream encoder. Tried: ${encoderCandidates.map(formatEncoderLabel).join(', ')}`,
                });
                return;
            }

            applied.push(encoderLabel);
            applied.push(selectedVideoCodec.toUpperCase());
            if (tuningLabel) applied.push(`tuning: ${tuningLabel}`);

            await setAndVerifyProfile(sendRequest, 'AdvOut', 'AudioEncoder', 'ffmpeg_aac');
            await setAndVerifyProfile(sendRequest, 'AdvOut', 'AudioBitrate', '256');
            await setAndVerifyProfile(sendRequest, 'Audio', 'SampleRate', '48000');
            await setAndVerifyProfile(sendRequest, 'Stream1', 'IgnoreRecommended', 'true');
            // Lets OBS's WHIP service turn B-frames off and repeat the stream's
            // parameter sets on every keyframe, as WebRTC needs.
            await setAndVerifyProfile(sendRequest, 'AdvOut', 'ApplyServiceSettings', 'true');
            if (String(previousMode || '').toLowerCase() !== 'advanced'
                || (previousEncoderId && previousEncoderId !== selectedEncoderId)) {
                restartRequired = true;
                warnings.push(`OBS switches to ${encoderLabel} in Advanced output mode only after it restarts: restart OBS once, then start sharing again`);
            }

            const streamOutputName = await findStreamOutputName(sendRequest);
            // Not fatal: the encoder is configured via the profile parameters above,
            // which apply on the next stream start. The live-output patch below is
            // only a best-effort supplement for an already-running output.
            if (!streamOutputName) {
                console.debug('[OBS] No queryable stream output found; relying on profile-parameter settings only.');
            }

            const liveOutputPatch = buildLiveOutputPatch({
                encoderKind,
                videoCodec: selectedVideoCodec,
                bitrateKbps,
                keyframeIntervalSec,
                preset,
                nvencPreset,
                nvencMultipass,
            });
            if (streamOutputName) {
                const liveOutputResult = await setAndVerifyOutputSettings(sendRequest, streamOutputName, liveOutputPatch);
                if (liveOutputResult.verified) {
                    applied.push(`live output: ${bitrateKbps} kbps`);
                } else if (liveOutputResult.wrote) {
                    warnings.push(`OBS kept different live output settings on ${streamOutputName}`);
                } else {
                    warnings.push(`failed to update live output settings on ${streamOutputName}`);
                }
            }

            if (selectedVideoCodec === 'h264') {
                const simpleOutputEncoderId = getSimpleOutputEncoderId(selectedEncoderId, encoderKind, selectedVideoCodec);
                await setAndVerifyProfile(sendRequest, 'SimpleOutput', 'VBitrate', bitrateKbps);
                await setAndVerifyProfile(sendRequest, 'SimpleOutput', 'ABitrate', '256');
                if (encoderKind === 'nvenc') {
                    await setAndVerifyProfile(sendRequest, 'SimpleOutput', 'NVENCPreset2', nvencPreset);
                    await setAndVerifyProfile(sendRequest, 'SimpleOutput', 'NVENCLookahead', 'false');
                }
                if (simpleOutputEncoderId) {
                    const simpleResult = await setAndVerifyProfile(sendRequest, 'SimpleOutput', 'StreamEncoder', simpleOutputEncoderId);
                    if (!simpleResult.verified) {
                        warnings.push(`could not mirror ${encoderLabel} into OBS Simple output page`);
                    }
                }
            }

            if (encoderKind === 'x264' && selectedVideoCodec !== 'h264') {
                await finish({
                    success: false,
                    message: 'x264 cannot be used for AV1 output.',
                });
                return;
            }

            // The encoder's own settings. OBS has no WebSocket request for them
            // and reads them from a file in its profile folder, so they go
            // through the Nextra server, which writes that file when OBS is on
            // the same machine.
            const encoderFileSettings = buildStreamEncoderSettings({
                encoderKind,
                videoCodec: selectedVideoCodec,
                bitrateKbps,
                keyframeIntervalSec,
                preset,
                nvencPreset,
                nvencMultipass,
            });
            let encoderSettingsApplied = false;
            if (typeof writeEncoderSettings === 'function') {
                const profileList = await sendRequest('GetProfileList');
                const profileName = profileList.requestStatus?.result === true
                    ? profileList.responseData?.currentProfileName
                    : '';
                if (profileName) {
                    encoderSettingsApplied = await writeEncoderSettingsFile(transaction, writeEncoderSettings, {
                        profileName,
                        settings: encoderFileSettings,
                    });
                }
            }
            if (encoderSettingsApplied) {
                applied.push(`${bitrateKbps} kbps`);
                if (encoderKind === 'nvenc') applied.push(`NVENC preset: ${nvencPreset} + ${nvencMultipass} multipass`);
                if (encoderKind === 'x264') applied.push(`x264 preset: ${preset}`);
                applied.push(`keyframe: ${keyframeIntervalSec}s`);
                applied.push('low-latency tuning');
            } else {
                warnings.push(`could not set the encoder's own settings (OBS is not on the Nextra server's machine, or its profile folder was not found): in OBS Settings > Output > Streaming set bitrate ${bitrateKbps} kbps, keyframe interval ${keyframeIntervalSec} s, no B-frames and no look-ahead`);
            }

            await setAndVerifyProfile(sendRequest, 'Video', 'ColorSpace', '709');
            await setAndVerifyProfile(sendRequest, 'Video', 'ColorRange', 'Full');
            applied.push('color: 709/Full');
        }

        // OBS would start with the old mode or encoder, so the start waits for the restart.
        if (autoStart && !restartRequired) {
            // Let OBS finish resetting its video pipeline before starting the output.
            // SetVideoSettings + ColorSpace/ColorRange above reinitialize the video
            // output; starting the encoder while that is in flight can crash OBS in
            // video_output_connect2 (access violation in obs.dll). A short settle
            // delay avoids that race.
            await delay(VIDEO_SETTLE_MS);
            const startResult = await sendRequest('StartStream');
            if (startResult.requestStatus?.result === true) {
                applied.push('streaming started');
            } else {
                await finish({
                    success: false,
                    message: `OBS configured, but auto-start failed: ${startResult.requestStatus?.comment || 'unknown error'}`,
                });
                return;
            }

            await delay(750);
            const streamStatus = await getStreamStatus(sendRequest);
            if (streamStatus && !streamStatus.outputActive && !streamStatus.outputReconnecting) {
                await finish({
                    success: false,
                    message: 'OBS configured, but streaming stopped immediately. Check the WHIP URL and local Nextra server status.',
                });
                return;
            }
        }

        const msg = `OBS configured: ${applied.join(', ')}${warnings.length ? '. Warnings: ' + warnings.join(', ') : ''}${!autoStart ? '. Click "Start Streaming" in OBS.' : ''}`;
        await finish({ success: true, message: msg, restartRequired });
        } catch (error) {
            await finish({
                success: false,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }, connectionOptions);
}

/**
 * Hold an authenticated obs-websocket connection open for the whole OBS session
 * so the stream can be stopped from a `pagehide` handler.
 *
 * stopObsStream() opens, identifies, and closes per call, and that handshake
 * cannot complete while the page is unloading — which is why closing the host
 * tab leaves OBS streaming into a room that no longer exists. An already
 * identified channel only has to write one frame.
 *
 * @returns {{ ready: Promise<{success: boolean, message: string}>, stopStream: () => Promise<boolean>, close: () => void }}
 */
export function openObsControlChannel({ password = '', ...options } = {}) {
    let sendRequest = null;
    let resolveReady = null;
    const ready = new Promise((resolve) => { resolveReady = resolve; });

    const connection = withObsConnection(password, (send) => {
        sendRequest = send;
        resolveReady({ success: true, message: 'OBS control channel open.' });
        // Never settles on its own; close() ends the transaction.
        return new Promise(() => {});
    }, { ...options, transactionTimeoutMs: Infinity });

    // A connection that fails, drops or is closed before identifying settles
    // without ever running the callback, so surface that as the ready result
    // instead. Once ready has resolved this changes nothing.
    connection.then((result) => {
        sendRequest = null;
        resolveReady(result);
    });

    return {
        ready,
        /**
         * Ask OBS to stop streaming. The frame is written at once, so a caller
         * on the unload path has done all it can by calling this. Resolves to
         * whether OBS answered. OBS drops a request whose connection closes
         * right behind it, so keep the channel open until this settles.
         */
        stopStream() {
            if (!sendRequest) return Promise.resolve(false);
            try {
                return sendRequest('StopStream').then(() => true, () => false);
            } catch {
                return Promise.resolve(false);
            }
        },
        /**
         * Close the socket and keep the channel closed, whatever stage the
         * connection is at: a handshake that completes later is ignored, and
         * stopStream() resolves false from here on. Safe to call again.
         */
        close() {
            const wasOpen = sendRequest !== null;
            sendRequest = null;
            connection.abort(wasOpen
                ? { success: true, message: 'OBS control channel closed.' }
                : { success: false, message: 'OBS control channel closed before it opened.' });
        },
    };
}

/**
 * Stop OBS streaming via obs-websocket v5.
 */
export async function stopObsStream({ password = '' } = {}) {
    return withObsConnection(password, async (sendRequest, done) => {
        const result = await sendRequest('StopStream');
        if (result.requestStatus?.result === true) {
            done({ success: true, message: 'OBS streaming stopped.' });
        } else {
            done({ success: true, message: 'OBS was not streaming.' });
        }
    });
}
