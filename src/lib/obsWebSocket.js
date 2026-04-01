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
                message: 'OBS WebSocket connection timed out. Make sure OBS is running and WebSocket server is enabled (Tools → WebSocket Server Settings).',
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
                message: 'Cannot connect to OBS WebSocket. Make sure OBS is running and WebSocket server is enabled (Tools → WebSocket Server Settings).',
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

            // op 0 = Hello
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

            // op 2 = Identified
            if (op === 2) {
                identified = true;
                callback(sendRequest, done);
            }

            // op 7 = RequestResponse
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

        // Helper to set a profile parameter and track result
        async function setProfile(category, name, value) {
            const r = await sendRequest('SetProfileParameter', {
                parameterCategory: category,
                parameterName: name,
                parameterValue: String(value),
            });
            return r.requestStatus?.result === true;
        }

        // 1. Set WHIP stream service
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

        // 2. Apply video resolution + FPS
        if (videoSettings) {
            const vidResult = await sendRequest('SetVideoSettings', videoSettings);
            if (vidResult.requestStatus?.result === true) {
                applied.push(`${videoSettings.outputWidth}x${videoSettings.outputHeight}@${videoSettings.fpsNumerator}fps`);
            } else {
                warnings.push(`resolution (${vidResult.requestStatus?.comment || 'failed'})`);
            }
        }

        // 3. Apply encoder settings via SetProfileParameter
        if (encoderSettings) {
            const { bitrateKbps, keyframeIntervalSec = 2, preset = 'ultrafast', encoder = 'h264', obsEncoderId } = encoderSettings;
            const fps = videoSettings?.fpsNumerator || 30;
            const isAv1 = encoder === 'av1';

            // Use the specific OBS encoder ID if provided, otherwise fall back to software
            const finalEncoderId = obsEncoderId || (isAv1 ? 'obs_svt_av1' : 'obs_x264');
            const isHwEncoder = !finalEncoderId.includes('obs_x264') && !finalEncoderId.includes('obs_svt');
            const encoderLabel = finalEncoderId.replace(/^(jim_|obs_|h264_texture_)/, '').replace(/_/g, ' ').toUpperCase();

            // Switch to Simple output mode (gives us full control via profile params)
            // OBS preserves Advanced mode settings, so switching back later is safe
            if (await setProfile('Output', 'Mode', 'Simple')) {
                applied.push('Simple mode');
            }

            // Set encoder
            if (await setProfile('SimpleOutput', 'StreamEncoder', finalEncoderId)) {
                applied.push(encoderLabel);
            } else {
                // HW encoder might not be available — fall back to software
                const swFallback = isAv1 ? 'obs_svt_av1' : 'obs_x264';
                if (await setProfile('SimpleOutput', 'StreamEncoder', swFallback)) {
                    applied.push(isAv1 ? 'SVT-AV1 (software)' : 'x264 (software)');
                    warnings.push(`${encoderLabel} not available, using software encoder`);
                }
            }

            // Set bitrate
            if (bitrateKbps && await setProfile('SimpleOutput', 'VBitrate', bitrateKbps)) {
                applied.push(`${bitrateKbps} kbps`);
            }

            // Set preset
            if (await setProfile('SimpleOutput', 'Preset', preset)) {
                applied.push(`preset: ${preset}`);
            }

            // Set audio bitrate to 192k (good quality for Opus transcoding)
            await setProfile('SimpleOutput', 'ABitrate', '192');

            // Set audio sample rate to 48kHz (matches Opus, avoids resampling)
            await setProfile('Audio', 'SampleRate', '48000');

            // ── Low-latency encoder options ──
            const keyint = Math.round(fps * keyframeIntervalSec);

            if (isAv1) {
                // SVT-AV1: keyint + fast preset
                // svtav1-params format: colon-separated key=value pairs
                const svtOpts = `keyint=${keyint}`;
                await setProfile('SimpleOutput', 'x264Settings', svtOpts);
            } else if (isHwEncoder && finalEncoderId.includes('nvenc')) {
                // NVENC: low-latency tuning
                // - keyint for keyframe interval
                // - no-b-frames to reduce decode latency
                // - zerolatency preset for minimum encode latency
                // - profile=high for better compression
                const nvencOpts = [
                    `keyint=${keyint}`,
                    'bf=0',
                    'profile=high',
                ].join(' ');
                await setProfile('SimpleOutput', 'x264Settings', nvencOpts);
                // NVENC-specific: disable look-ahead (adds latency)
                await setProfile('SimpleOutput', 'NVENCLookahead', 'false');
            } else if (isHwEncoder && finalEncoderId.includes('amf')) {
                // AMF: low-latency tuning
                const amfOpts = [
                    `keyint=${keyint}`,
                    'bf=0',
                    'profile=high',
                ].join(' ');
                await setProfile('SimpleOutput', 'x264Settings', amfOpts);
            } else {
                // x264: full low-latency tuning
                // - tune=zerolatency: disables B-frames, reduces lookahead, minimal encode latency
                // - profile=high: better compression at same bitrate vs baseline/main
                // - keyint: keyframe interval in frames
                // - bframes=0: redundant with zerolatency but explicit
                // - rc=cbr: constant bitrate for stable streaming
                const x264Opts = [
                    `keyint=${keyint}`,
                    'tune=zerolatency',
                    'profile=high',
                    'bframes=0',
                    'rc=cbr',
                ].join(' ');
                await setProfile('SimpleOutput', 'x264Settings', x264Opts);
            }
            applied.push(`keyframe: ${keyframeIntervalSec}s`);
            applied.push('low-latency tuning');

            // ── Color settings for best quality ──
            // Rec. 709 color space (standard HD), Full range (no clipping)
            await setProfile('Video', 'ColorSpace', '709');
            await setProfile('Video', 'ColorRange', 'Full');
            applied.push('color: 709/Full');
        }

        // 4. Auto-start if requested
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
            // Code 500 = not streaming, which is fine
            done({ success: true, message: 'OBS was not streaming.' });
        }
    });
}
