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
const OBS_WS_TIMEOUT = 5000;

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
function withObsConnection(password, callback) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${OBS_WS_PORT}`);
        let identified = false;
        let settled = false;

        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            resolve(result);
        };

        const timeout = setTimeout(() => {
            done({
                success: false,
                message: 'OBS WebSocket connection timed out. Make sure OBS is running and WebSocket server is enabled (Tools > WebSocket Server Settings).',
            });
        }, OBS_WS_TIMEOUT);

        const pendingRequests = new Map();
        let reqCounter = 0;

        function sendRequest(requestType, requestData) {
            return new Promise((reqResolve) => {
                const requestId = `req-${++reqCounter}`;
                pendingRequests.set(requestId, reqResolve);
                ws.send(JSON.stringify({
                    op: 6,
                    d: { requestType, requestId, ...(requestData ? { requestData } : {}) },
                }));
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
            if (!identified) {
                let msg = 'OBS WebSocket connection closed before setup completed.';
                if (event.code === 4005) msg = 'OBS WebSocket authentication failed. Please check your password.';
                else if (event.code === 4006) msg = 'OBS WebSocket payload was invalid.';
                else if (event.code === 4009) msg = 'OBS WebSocket authentication required but none provided.';
                done({ success: false, message: msg });
            }
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
                identified = true;
                callback(sendRequest, done);
            }

            if (op === 7) {
                const reqId = msg.d?.requestId;
                const handler = pendingRequests.get(reqId);
                if (handler) {
                    pendingRequests.delete(reqId);
                    handler(msg.d);
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
    return withObsConnection(password, async (sendRequest, done) => {
        const applied = [];
        const warnings = [];

        if (autoStart) {
            const stopResult = await stopActiveStream(sendRequest);
            if (!stopResult.ok) {
                done({
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
            done({ success: false, message: `Failed to set OBS stream settings: ${setResult.requestStatus?.comment || 'unknown error'}` });
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
                done({
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
                done({
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

            let streamOutputName = null;
            if (await getOutputSettings(sendRequest, 'adv_stream') !== null) {
                streamOutputName = 'adv_stream';
            } else if (await getOutputSettings(sendRequest, 'simple_stream') !== null) {
                streamOutputName = 'simple_stream';
            }
            if (!streamOutputName) {
                warnings.push('could not find OBS stream output for live encoder settings');
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
                    done({
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
                done({
                    success: false,
                    message: `OBS configured, but auto-start failed: ${startResult.requestStatus?.comment || 'unknown error'}`,
                });
                return;
            }

            await delay(750);
            const streamStatus = await getStreamStatus(sendRequest);
            if (streamStatus && !streamStatus.outputActive && !streamStatus.outputReconnecting) {
                done({
                    success: false,
                    message: 'OBS configured, but streaming stopped immediately. Check the WHIP URL and local Nextra server status.',
                });
                return;
            }
        }

        const msg = `OBS configured: ${applied.join(', ')}${warnings.length ? '. Warnings: ' + warnings.join(', ') : ''}${!autoStart ? '. Click "Start Streaming" in OBS.' : ''}`;
        done({ success: true, message: msg });
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
