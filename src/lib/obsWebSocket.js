// src/lib/obsWebSocket.js - Connect to OBS WebSocket and auto-configure WHIP stream settings
// OBS 28+ ships with obs-websocket v5 on port 4455 by default.

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

function formatEncoderLabel(encoderId) {
    const labels = {
        obs_nvenc_av1_tex: 'AV1 NVENC',
        jim_av1_nvenc: 'AV1 NVENC (legacy)',
        obs_nvenc_h264_tex: 'H.264 NVENC',
        jim_nvenc: 'H.264 NVENC (legacy)',
        obs_amf_av1: 'AV1 AMF',
        amd_av1: 'AV1 AMF',
        obs_amf_h264: 'H.264 AMF',
        h264_texture_amf: 'H.264 AMF',
        obs_qsv_av1: 'AV1 QSV',
        obs_qsv11_av1: 'AV1 QSV',
        ffmpeg_svt_av1: 'SVT-AV1',
        obs_svt_av1: 'SVT-AV1',
        ffmpeg_aom_av1: 'AOM-AV1',
        obs_x264: 'x264',
    };

    if (labels[encoderId]) {
        return labels[encoderId];
    }

    return String(encoderId || '')
        .replace(/^(jim_|obs_|ffmpeg_|h264_texture_)/, '')
        .replace(/_tex$/, '')
        .replace(/_/g, ' ')
        .toUpperCase();
}

function getEncoderKind(encoderId) {
    const normalized = String(encoderId || '').toLowerCase();

    if (normalized.includes('x264')) return 'x264';
    if (normalized.includes('svt')) return 'svt';
    if (normalized.includes('aom')) return 'aom';
    if (normalized.includes('nvenc') || normalized.startsWith('jim_')) return 'nvenc';
    if (normalized.includes('amf') || normalized.startsWith('amd_')) return 'amf';
    if (normalized.includes('qsv')) return 'qsv';
    return 'other';
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

        async function setProfile(category, name, value) {
            const response = await sendRequest('SetProfileParameter', {
                parameterCategory: category,
                parameterName: name,
                parameterValue: String(value),
            });
            return response.requestStatus?.result === true;
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
                preset = 'ultrafast',
                // TODO: OBS WHIP doesn't support AV1 SDP negotiation yet — re-enable when OBS adds support
                // encoder = 'h264',
                obsEncoderIds = [],
                obsEncoderId,
            } = encoderSettings;
            // const isAv1 = encoder === 'av1';
            const encoderCandidates = [...new Set([
                ...obsEncoderIds,
                ...(obsEncoderId ? [obsEncoderId] : []),
                // TODO: re-enable AV1 software fallbacks when WHIP supports AV1
                // ...(isAv1 ? ['ffmpeg_svt_av1', 'obs_svt_av1', 'ffmpeg_aom_av1'] : ['obs_x264']),
                'obs_x264',
            ].filter(Boolean))];

            if (await setProfile('Output', 'Mode', 'Advanced')) {
                applied.push('Advanced mode');
            }

            const selectedEncoderId = encoderCandidates[0];
            const encoderLabel = formatEncoderLabel(selectedEncoderId);
            const encoderKind = getEncoderKind(selectedEncoderId);

            if (!selectedEncoderId || !(await setProfile('AdvOut', 'Encoder', selectedEncoderId))) {
                done({
                    success: false,
                    message: `Failed to set OBS stream encoder. Tried: ${encoderCandidates.map(formatEncoderLabel).join(', ')}`,
                });
                return;
            }

            applied.push(encoderLabel);

            await setProfile('AdvOut', 'AudioEncoder', 'ffmpeg_aac');
            await setProfile('AdvOut', 'AudioBitrate', '192');
            await setProfile('Audio', 'SampleRate', '48000');

            if (encoderKind === 'nvenc') {
                const section = selectedEncoderId;
                await setProfile(section, 'bitrate', bitrateKbps);
                await setProfile(section, 'rate_control', 'CBR');
                await setProfile(section, 'keyint_sec', keyframeIntervalSec);
                await setProfile(section, 'lookahead', 'false');
                await setProfile(section, 'multipass', 'disabled');
                await setProfile(section, 'preset2', 'p4');
                await setProfile(section, 'tune', 'll');
                // TODO: when AV1 WHIP is supported, skip profile for AV1
                // if (!isAv1) await setProfile(section, 'profile', 'high');
                await setProfile(section, 'profile', 'high');
                applied.push(`${bitrateKbps} kbps`);
            } else if (encoderKind === 'amf') {
                // TODO: when AV1 WHIP is supported, use: const section = isAv1 ? 'amd_av1' : 'h264_texture_amf';
                const section = 'h264_texture_amf';
                await setProfile(section, 'bitrate', bitrateKbps);
                await setProfile(section, 'rate_control', 'CBR');
                await setProfile(section, 'keyint_sec', keyframeIntervalSec);
                await setProfile(section, 'profile', 'high');
                applied.push(`${bitrateKbps} kbps`);
            } else if (encoderKind === 'qsv') {
                // TODO: when AV1 WHIP is supported, use: const section = isAv1 ? 'obs_qsv11_av1' : 'obs_qsv11';
                const section = 'obs_qsv11';
                await setProfile(section, 'bitrate', bitrateKbps);
                await setProfile(section, 'rate_control', 'CBR');
                await setProfile(section, 'keyint_sec', keyframeIntervalSec);
                applied.push(`${bitrateKbps} kbps`);
            } else if (encoderKind === 'x264') {
                await setProfile('obs_x264', 'bitrate', bitrateKbps);
                await setProfile('obs_x264', 'rate_control', 'CBR');
                await setProfile('obs_x264', 'keyint_sec', keyframeIntervalSec);
                await setProfile('obs_x264', 'preset', preset);
                await setProfile('obs_x264', 'profile', 'high');
                await setProfile('obs_x264', 'tune', 'zerolatency');
                await setProfile('obs_x264', 'x264opts', 'bframes=0');
                applied.push(`${bitrateKbps} kbps`);
            }

            applied.push(`keyframe: ${keyframeIntervalSec}s`);
            applied.push('low-latency tuning');

            await setProfile('Video', 'ColorSpace', '709');
            await setProfile('Video', 'ColorRange', 'Full');
            applied.push('color: 709/Full');
        }

        if (autoStart) {
            const startResult = await sendRequest('StartStream');
            if (startResult.requestStatus?.result === true) {
                applied.push('streaming started');
            } else {
                warnings.push(`auto-start failed: ${startResult.requestStatus?.comment || 'unknown'}`);
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
