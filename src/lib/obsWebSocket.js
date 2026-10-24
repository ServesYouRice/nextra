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
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export function withObsConnection(password, callback, {
    WebSocketImpl = globalThis.WebSocket,
    url = `ws://127.0.0.1:${OBS_WS_PORT}`,
    connectTimeoutMs = OBS_WS_CONNECT_TIMEOUT,
    requestTimeoutMs = OBS_WS_REQUEST_TIMEOUT,
    transactionTimeoutMs = OBS_WS_TRANSACTION_TIMEOUT,
    deadlineGraceMs = OBS_WS_DEADLINE_GRACE,
} = {}) {
    return new Promise((resolve) => {
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
                    .then(() => callback(sendRequest, done, {
                        signal: deadlineController.signal,
                        onDeadline: (handler) => { deadlineHandler = handler; },
                    }))
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
 * request propagates.
 *
 * @returns {Promise<{ inactive: boolean, statusKnown: boolean }>}
 */
async function waitForStreamInactive(sendRequest, {
    wait = delay,
    intervalMs = STREAM_STOP_POLL_INTERVAL_MS,
    attempts = STREAM_STOP_POLL_ATTEMPTS,
    failClosed = false,
} = {}) {
    let statusKnown = true;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        await wait(intervalMs);
        let status = null;
        try {
            status = await getStreamStatus(sendRequest);
        } catch (error) {
            if (!failClosed) throw error;
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
 * Make OBS let go of an encoder it set up for a stream that never connected.
 *
 * Each time OBS retries a target that is gone (the room ended, the server was
 * closed) it sets its stream encoder up again, and neither the failed attempt
 * nor stopping the retry releases it. An encoder left like that ignores new
 * settings and, worse, a new output resolution: it goes on encoding the old size
 * from a video pipeline that no longer exists, which is a green picture. OBS
 * does not say whether it holds one, so unless a running stream was just stopped
 * it has to be assumed. Only a stream that actually ran and was stopped releases
 * it — so run one, briefly, at the target that is about to be used anyway.
 */
async function releaseStaleEncoder(sendRequest) {
    // A test stream that fails to connect leaves exactly the encoder it was
    // meant to clear, so one that did not run is tried once more.
    for (let run = 0; run < 2; run += 1) {
        if (run > 0) await delay(300);
        const started = await sendRequest('StartStream');
        if (started.requestStatus?.result !== true) return false;
        let ran = false;
        for (let attempt = 0; attempt < 60 && !ran; attempt += 1) {
            await delay(100);
            const status = await getStreamStatus(sendRequest);
            // Retrying already: the target refused the stream, and waiting longer
            // only lets OBS set the encoder up once more.
            if (status?.outputReconnecting === true) break;
            ran = status?.outputActive === true;
        }
        await sendRequest('StopStream');
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await delay(100);
            const status = await getStreamStatus(sendRequest);
            if (!status?.outputActive && !status?.outputReconnecting) break;
        }
        if (ran) return true;
    }
    return false;
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
        for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index];
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
                failures.push(`skipped ${skipped.requestType}`);
            }
            break;
        }
        rollbackSteps.length = 0;
        return failures;
    }

    function commit() {
        if (finished) return;
        finished = true;
        rollbackSteps.length = 0;
    }

    return { request, rollback, commit };
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
 *   { applied, reason }; stores the encoder's settings where OBS reads them.
 * @param {function} [opts.listEncoders] - async () => the ids of the video encoders
 *   OBS has, or null when that is not known.
 * @param {object} [opts.transactionOptions] - timing seams for tests, passed to
 *   createObsConfigurationTransaction().
 * @param {object} [opts.connectionOptions] - timeouts and socket class for tests,
 *   passed to withObsConnection().
 */
export async function configureObsStream({ whipUrl, bearerToken, password = '', autoStart = false, videoSettings = null, encoderSettings = null, writeEncoderSettings = null, listEncoders = null, transactionOptions = undefined, connectionOptions = undefined }) {
    return withObsConnection(password, async (rawSendRequest, done, { signal, onDeadline }) => {
        const transaction = createObsConfigurationTransaction(rawSendRequest, transactionOptions);
        const requestedAv1 = String(encoderSettings?.videoCodec || encoderSettings?.encoder || '').toLowerCase() === 'av1';
        const sendRequest = transaction.request;
        // Housekeeping requests are not journaled, so a rollback cannot undo
        // them. Once the deadline has passed they stop, so that they do not
        // run on while the rollback has the connection.
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

        const setResult = await sendRequest('SetStreamServiceSettings', {
            streamServiceType: 'whip_custom',
            streamServiceSettings: {
                server: whipUrl,
                bearer_token: bearerToken,
            },
        });

        if (setResult.requestStatus?.result !== true) {
            await finish({ success: false, message: `Failed to set OBS stream settings: ${setResult.requestStatus?.comment || 'unknown error'}` });
            return;
        }
        applied.push('WHIP URL + token');

        if (!stopResult.wasLive) {
            // Uses the raw channel: this start/stop is housekeeping, not a step
            // a failed setup should roll back.
            if (await releaseStaleEncoder(housekeepingRequest)) {
                applied.push('encoder reset');
            } else {
                warnings.push('OBS could not run the short test stream that clears the encoder settings of an earlier stream; if the picture or the delay is wrong, restart OBS');
            }
        }

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
                    try {
                        const written = await writeEncoderSettings({ profileName, settings: encoderFileSettings });
                        encoderSettingsApplied = written?.applied === true;
                    } catch {
                        encoderSettingsApplied = false;
                    }
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

        if (autoStart) {
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
        await finish({ success: true, message: msg });
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
    let settleConnection = null;
    let resolveReady = null;
    const ready = new Promise((resolve) => { resolveReady = resolve; });

    const closed = withObsConnection(password, (send, done) => {
        sendRequest = send;
        settleConnection = done;
        resolveReady({ success: true, message: 'OBS control channel open.' });
        // Never settles on its own; close() ends the transaction.
        return new Promise(() => {});
    }, { ...options, transactionTimeoutMs: Infinity });

    // A connection that fails or drops before identifying settles without ever
    // running the callback, so surface that as the ready result instead.
    closed.then((result) => {
        sendRequest = null;
        settleConnection = null;
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
        close() {
            sendRequest = null;
            const settle = settleConnection;
            settleConnection = null;
            settle?.({ success: true, message: 'OBS control channel closed.' });
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
