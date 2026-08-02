// src/lib/obsWebSocket.js - Connect to OBS WebSocket and auto-configure WHIP stream settings
// OBS 28+ ships with obs-websocket v5 on port 4455 by default.

import {
    buildLiveOutputPatch,
    formatEncoderLabel,
    getEncoderKind,
    getSimpleOutputEncoderId,
    normalizeObsEncoderRequest,
} from './obsOutputModel.mjs';

const OBS_WS_PORT = 4455;
const OBS_WS_CONNECT_TIMEOUT = 5000;
const OBS_WS_REQUEST_TIMEOUT = 5000;
const OBS_WS_TRANSACTION_TIMEOUT = 30000;

async function sha256Base64(input) {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

/**
 * Connect to OBS WebSocket, authenticate, and run a callback with the ws + a request helper.
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export function withObsConnection(password, callback, {
    WebSocketImpl = globalThis.WebSocket,
    url = `ws://127.0.0.1:${OBS_WS_PORT}`,
    connectTimeoutMs = OBS_WS_CONNECT_TIMEOUT,
    requestTimeoutMs = OBS_WS_REQUEST_TIMEOUT,
    transactionTimeoutMs = OBS_WS_TRANSACTION_TIMEOUT,
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
            rejectPendingRequests(new Error(result?.message || 'OBS WebSocket transaction ended.'));
            try { ws.close(); } catch {}
            resolve(result);
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
                transactionTimeout = setTimeout(() => {
                    done({
                        success: false,
                        message: `OBS setup timed out after ${transactionTimeoutMs}ms.`,
                    });
                }, transactionTimeoutMs);
                Promise.resolve()
                    .then(() => callback(sendRequest, done))
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

async function stopActiveStream(sendRequest) {
    const status = await getStreamStatus(sendRequest);
    if (!status?.outputActive && !status?.outputReconnecting) {
        return { stopped: false, ok: true };
    }

    const stopResponse = await sendRequest('StopStream');
    if (stopResponse.requestStatus?.result !== true) {
        return {
            stopped: false,
            ok: false,
            message: stopResponse.requestStatus?.comment || 'unknown error',
        };
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
        await delay(250);
        const nextStatus = await getStreamStatus(sendRequest);
        if (!nextStatus?.outputActive && !nextStatus?.outputReconnecting) {
            return { stopped: true, ok: true };
        }
    }

    return {
        stopped: true,
        ok: false,
        message: 'OBS did not stop the previous stream in time.',
    };
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

async function setOneOf(sendRequest, categories, name, value) {
    for (const category of [...new Set(categories.filter(Boolean))]) {
        if (await trySetProfile(sendRequest, category, name, value)) {
            return true;
        }
    }
    return false;
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

/**
 * Wrap mutating OBS requests with a snapshot of the value they replace. The
 * resulting rollback runs successful mutations in reverse order and deliberately
 * uses the raw request function so rollback operations are not recorded again.
 */
export function createObsConfigurationTransaction(sendRequest) {
    const rollbackSteps = [];
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
            return {
                requestType: 'SetProfileParameter',
                requestData: {
                    ...identity,
                    parameterValue: String(previous.responseData?.parameterValue ?? ''),
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

        const response = await sendRequest(requestType, requestData);
        if (!successfulResponse(response)) return response;

        if (inverse) {
            rollbackSteps.push(inverse);
        } else if (requestType === 'StopStream') {
            rollbackSteps.push({ requestType: 'StartStream' });
        } else if (requestType === 'StartStream') {
            rollbackSteps.push({ requestType: 'StopStream' });
        }
        return response;
    }

    async function rollback() {
        if (finished) return [];
        finished = true;
        const failures = [];
        for (const step of rollbackSteps.reverse()) {
            try {
                const response = await sendRequest(step.requestType, step.requestData);
                if (!successfulResponse(response)) {
                    failures.push(`${step.requestType}: ${response?.requestStatus?.comment || 'rejected'}`);
                }
            } catch (error) {
                failures.push(`${step.requestType}: ${error instanceof Error ? error.message : String(error)}`);
            }
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
 */
export async function configureObsStream({ whipUrl, bearerToken, password = '', autoStart = false, videoSettings = null, encoderSettings = null }) {
    return withObsConnection(password, async (rawSendRequest, done) => {
        const transaction = createObsConfigurationTransaction(rawSendRequest);
        const requestedAv1 = String(encoderSettings?.videoCodec || encoderSettings?.encoder || '').toLowerCase() === 'av1';
        const sendRequest = transaction.request;
        let finishing = false;
        const finish = async (result) => {
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
                } else if (requestedAv1) {
                    result = {
                        ...result,
                        message: `${result.message} OBS settings were restored. Disable AV1 mode and retry to use H.264.`,
                    };
                }
            }
            done(result);
        };

        try {
        const applied = [];
        const warnings = [];

        if (autoStart) {
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
            const encoderCandidates = encoderRequest.encoderCandidates;

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

            if (encoderKind === 'nvenc') {
                const section = selectedEncoderId;
                await setAndVerifyProfile(sendRequest, section, 'bitrate', bitrateKbps);
                await setAndVerifyProfile(sendRequest, section, 'rate_control', 'CBR');
                await setAndVerifyProfile(sendRequest, section, 'keyint_sec', keyframeIntervalSec);
                await setAndVerifyProfile(sendRequest, section, 'lookahead', 'false');
                await setAndVerifyProfile(sendRequest, section, 'multipass', nvencMultipass);
                await setAndVerifyProfile(sendRequest, section, 'preset2', nvencPreset);
                if (selectedVideoCodec === 'h264') {
                    await setAndVerifyProfile(sendRequest, section, 'tune', 'll');
                    await setAndVerifyProfile(sendRequest, section, 'profile', 'high');
                }
                applied.push(`${bitrateKbps} kbps`);
                applied.push(`NVENC preset: ${nvencPreset} + ${nvencMultipass} multipass`);
            } else if (encoderKind === 'amf') {
                const sections = [selectedEncoderId, 'h264_texture_amf', 'obs_amf_h264'];
                const targetSections = selectedVideoCodec === 'av1'
                    ? [selectedEncoderId, 'av1_texture_amf', 'obs_amf_av1', 'amd_amf_av1']
                    : sections;
                await setOneOf(sendRequest, targetSections, 'bitrate', bitrateKbps);
                await setOneOf(sendRequest, targetSections, 'rate_control', 'CBR');
                await setOneOf(sendRequest, targetSections, 'keyint_sec', keyframeIntervalSec);
                if (selectedVideoCodec === 'h264') {
                    await setOneOf(sendRequest, targetSections, 'profile', 'high');
                }
                applied.push(`${bitrateKbps} kbps`);
            } else if (encoderKind === 'qsv') {
                const sections = selectedVideoCodec === 'av1'
                    ? [selectedEncoderId, 'obs_qsv11_av1', 'obs_qsv_av1']
                    : [selectedEncoderId, 'obs_qsv11', 'obs_qsv'];
                await setOneOf(sendRequest, sections, 'bitrate', bitrateKbps);
                await setOneOf(sendRequest, sections, 'rate_control', 'CBR');
                await setOneOf(sendRequest, sections, 'keyint_sec', keyframeIntervalSec);
                if (selectedVideoCodec === 'h264') {
                    await setOneOf(sendRequest, sections, 'profile', 'high');
                }
                applied.push(`${bitrateKbps} kbps`);
            } else if (encoderKind === 'x264') {
                if (selectedVideoCodec !== 'h264') {
                    await finish({
                        success: false,
                        message: 'x264 cannot be used for AV1 output.',
                    });
                    return;
                }
                await setAndVerifyProfile(sendRequest, 'obs_x264', 'bitrate', bitrateKbps);
                await setAndVerifyProfile(sendRequest, 'obs_x264', 'rate_control', 'CBR');
                await setAndVerifyProfile(sendRequest, 'obs_x264', 'keyint_sec', keyframeIntervalSec);
                await setAndVerifyProfile(sendRequest, 'obs_x264', 'preset', preset);
                await setAndVerifyProfile(sendRequest, 'obs_x264', 'profile', 'high');
                await setAndVerifyProfile(sendRequest, 'obs_x264', 'tune', 'zerolatency');
                await setAndVerifyProfile(sendRequest, 'obs_x264', 'x264opts', 'bframes=0');
                applied.push(`${bitrateKbps} kbps`);
                applied.push(`x264 preset: ${preset}`);
            }

            applied.push(`keyframe: ${keyframeIntervalSec}s`);
            applied.push('low-latency tuning');

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
            await delay(1200);
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
    });
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
