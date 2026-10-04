const test = require('node:test');
const assert = require('node:assert/strict');

const obsWebSocketModule = import('../src/lib/obsWebSocket.js');

function fakeObsWebSocket(onRequest) {
    return class FakeObsWebSocket {
        constructor(url) {
            this.url = url;
            this.closed = false;
            queueMicrotask(() => {
                this.onopen?.();
                this.onmessage?.({ data: JSON.stringify({ op: 0, d: { rpcVersion: 1 } }) });
            });
        }

        send(payload) {
            const message = JSON.parse(payload);
            if (message.op === 1) {
                queueMicrotask(() => {
                    this.onmessage?.({ data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) });
                });
                return;
            }
            if (message.op === 6) onRequest(this, message.d);
        }

        close() {
            if (this.closed) return;
            this.closed = true;
            this.onclose?.({ code: 1000 });
        }

        respond(request, responseData = {}, requestStatus = { result: true }) {
            this.onmessage?.({
                data: JSON.stringify({
                    op: 7,
                    d: {
                        requestId: request.requestId,
                        requestType: request.requestType,
                        requestStatus,
                        responseData,
                    },
                }),
            });
        }
    };
}

// Gives a fake OBS the stream every setup now exercises: one that starts when
// asked and stops when asked. Everything else goes to `onRequest`.
function withStream(onRequest, status = { outputActive: false, outputReconnecting: false }) {
    return (ws, request) => {
        if (request.requestType === 'GetStreamStatus') {
            queueMicrotask(() => ws.respond(request, { ...status }));
            return;
        }
        if (request.requestType === 'StartStream' || request.requestType === 'StopStream') {
            status.outputActive = request.requestType === 'StartStream';
            status.outputReconnecting = false;
        }
        onRequest(ws, request);
    };
}

function connectionOptions(WebSocketImpl, overrides = {}) {
    return {
        WebSocketImpl,
        connectTimeoutMs: 100,
        requestTimeoutMs: 100,
        transactionTimeoutMs: 500,
        ...overrides,
    };
}

test('OBS requests are matched by ID when responses arrive out of order', async () => {
    const requests = [];
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
        requests.push(request);
        if (requests.length === 2) {
            queueMicrotask(() => {
                ws.respond(requests[1], { value: 'second' });
                ws.respond(requests[0], { value: 'first' });
            });
        }
    });
    const { withObsConnection } = await obsWebSocketModule;

    const result = await withObsConnection('', async (sendRequest, done) => {
        const [first, second] = await Promise.all([
            sendRequest('First'),
            sendRequest('Second'),
        ]);
        done({
            success: true,
            message: `${first.responseData.value}/${second.responseData.value}`,
        });
    }, connectionOptions(WebSocketImpl));

    assert.deepEqual(result, { success: true, message: 'first/second' });
});

test('OBS protocol-level request rejections are returned to the transaction', async () => {
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
        queueMicrotask(() => ws.respond(request, {}, { result: false, comment: 'denied' }));
    });
    const { withObsConnection } = await obsWebSocketModule;

    const result = await withObsConnection('', async (sendRequest, done) => {
        const response = await sendRequest('SetVideoSettings');
        done({
            success: response.requestStatus.result,
            message: response.requestStatus.comment,
        });
    }, connectionOptions(WebSocketImpl));

    assert.deepEqual(result, { success: false, message: 'denied' });
});

test('an OBS request gets its own deadline', async () => {
    const WebSocketImpl = fakeObsWebSocket(() => {});
    const { withObsConnection } = await obsWebSocketModule;

    const result = await withObsConnection('', async (sendRequest, done) => {
        await sendRequest('NeverResponds');
        done({ success: true, message: 'unexpected' });
    }, connectionOptions(WebSocketImpl, { requestTimeoutMs: 10 }));

    assert.equal(result.success, false);
    assert.match(result.message, /NeverResponds timed out after 10ms/);
});

test('disconnect rejects pending OBS requests and settles the transaction', async () => {
    const WebSocketImpl = fakeObsWebSocket((ws) => {
        queueMicrotask(() => ws.onclose?.({ code: 1006 }));
    });
    const { withObsConnection } = await obsWebSocketModule;

    const result = await withObsConnection('', async (sendRequest, done) => {
        await sendRequest('Disconnects');
        done({ success: true, message: 'unexpected' });
    }, connectionOptions(WebSocketImpl));

    assert.deepEqual(result, {
        success: false,
        message: 'OBS WebSocket disconnected before setup completed.',
    });
});

test('the complete OBS setup transaction has an overall deadline', async () => {
    const WebSocketImpl = fakeObsWebSocket(() => {});
    const { withObsConnection } = await obsWebSocketModule;

    const result = await withObsConnection('', () => new Promise(() => {}),
        connectionOptions(WebSocketImpl, { transactionTimeoutMs: 10 }));

    assert.deepEqual(result, {
        success: false,
        message: 'OBS setup timed out after 10ms.',
    });
});

test('a live OBS output is stopped before its settings are rewritten, without auto-start', async () => {
    const order = [];
    let outputActive = true;
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
        const { requestType } = request;
        if (requestType === 'GetStreamStatus') {
            queueMicrotask(() => ws.respond(request, { outputActive, outputReconnecting: false }));
            return;
        }
        if (requestType === 'StopStream') {
            outputActive = false;
            order.push('StopStream');
            queueMicrotask(() => ws.respond(request));
            return;
        }
        if (requestType === 'GetStreamServiceSettings') {
            queueMicrotask(() => ws.respond(request, {
                streamServiceType: 'rtmp_custom',
                streamServiceSettings: { server: 'rtmp://previous.example/live' },
            }));
            return;
        }
        if (requestType === 'SetStreamServiceSettings' || requestType === 'SetVideoSettings') {
            order.push(requestType);
        }
        if (requestType === 'GetVideoSettings') {
            queueMicrotask(() => ws.respond(request, { outputWidth: 1920, outputHeight: 1080 }));
            return;
        }
        queueMicrotask(() => ws.respond(request));
    });
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = WebSocketImpl;
    const { configureObsStream } = await obsWebSocketModule;

    try {
        const result = await configureObsStream({
            whipUrl: 'http://127.0.0.1:8889/whip/broadcast/ABC123',
            bearerToken: 'token',
            autoStart: false,
            videoSettings: { outputWidth: 1280, outputHeight: 720, fpsNumerator: 60, fpsDenominator: 1 },
        });

        assert.equal(result.success, true);
        assert.match(result.message, /previous stream stopped/);
        // The stale stream must be down before anything it depends on changes.
        assert.deepEqual(order, ['StopStream', 'SetStreamServiceSettings', 'SetVideoSettings']);
    } finally {
        globalThis.WebSocket = previousWebSocket;
    }
});

test('configuration is abandoned when a stale OBS stream refuses to stop', async () => {
    let serviceWritten = false;
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
        const { requestType } = request;
        if (requestType === 'GetStreamStatus') {
            queueMicrotask(() => ws.respond(request, { outputActive: true, outputReconnecting: false }));
            return;
        }
        if (requestType === 'StopStream') {
            queueMicrotask(() => ws.respond(request, {}, { result: false, comment: 'output busy' }));
            return;
        }
        if (requestType === 'SetStreamServiceSettings') serviceWritten = true;
        queueMicrotask(() => ws.respond(request));
    });
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = WebSocketImpl;
    const { configureObsStream } = await obsWebSocketModule;

    try {
        const result = await configureObsStream({
            whipUrl: 'http://127.0.0.1:8889/whip/broadcast/ABC123',
            bearerToken: 'token',
            autoStart: false,
        });

        assert.equal(result.success, false);
        assert.match(result.message, /still streaming to a previous target.*output busy/);
        assert.equal(serviceWritten, false);
    } finally {
        globalThis.WebSocket = previousWebSocket;
    }
});

test('the OBS control channel writes the stop at once and stays open until OBS answers', async () => {
    const requests = [];
    let socketRef = null;
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
        socketRef = ws;
        requests.push(request);
    });
    const { openObsControlChannel } = await obsWebSocketModule;

    const channel = openObsControlChannel(connectionOptions(WebSocketImpl, { requestTimeoutMs: 20 }));
    assert.deepEqual(await channel.ready, { success: true, message: 'OBS control channel open.' });

    // The frame must be written in the same task, with no awaiting in between:
    // a page that is unloading gets no later chance.
    const stopped = channel.stopStream();
    assert.deepEqual(requests.map((request) => request.requestType), ['StopStream']);
    // OBS drops a request whose connection closes right behind it, so the
    // channel is still open, and the caller is told when OBS has answered.
    assert.equal(socketRef.closed, false);
    socketRef.respond(requests[0]);
    assert.equal(await stopped, true);
    assert.equal(socketRef.closed, false);

    // An answer that never comes is reported instead of waited for.
    assert.equal(await channel.stopStream(), false);

    channel.close();
    assert.equal(socketRef.closed, true);
    assert.equal(await channel.stopStream(), false);
});

test('the OBS control channel reports a connection that never identifies', async () => {
    const WebSocketImpl = class {
        constructor() {
            queueMicrotask(() => this.onclose?.({ code: 4009 }));
        }
        send() {}
        close() {}
    };
    const { openObsControlChannel } = await obsWebSocketModule;

    const channel = openObsControlChannel(connectionOptions(WebSocketImpl));
    const state = await channel.ready;

    assert.equal(state.success, false);
    assert.match(state.message, /authentication required/);
    assert.equal(await channel.stopStream(), false);
});

test('OBS configuration rollback restores mutations in reverse order', async () => {
    const calls = [];
    const sendRequest = async (requestType, requestData) => {
        calls.push({ requestType, requestData });
        if (requestType === 'GetStreamServiceSettings') {
            return {
                requestStatus: { result: true },
                responseData: {
                    streamServiceType: 'rtmp_custom',
                    streamServiceSettings: { server: 'rtmp://previous.example/live' },
                },
            };
        }
        if (requestType === 'GetVideoSettings') {
            return {
                requestStatus: { result: true },
                responseData: { outputWidth: 1920, outputHeight: 1080 },
            };
        }
        return { requestStatus: { result: true } };
    };
    const { createObsConfigurationTransaction } = await obsWebSocketModule;
    const transaction = createObsConfigurationTransaction(sendRequest);

    await transaction.request('SetStreamServiceSettings', {
        streamServiceType: 'whip_custom',
        streamServiceSettings: { server: 'http://new.example/whip' },
    });
    await transaction.request('SetVideoSettings', { outputWidth: 1280, outputHeight: 720 });
    await transaction.request('StopStream');
    assert.deepEqual(await transaction.rollback(), []);

    assert.deepEqual(calls.slice(-3), [
        { requestType: 'StartStream', requestData: undefined },
        {
            requestType: 'SetVideoSettings',
            requestData: { outputWidth: 1920, outputHeight: 1080 },
        },
        {
            requestType: 'SetStreamServiceSettings',
            requestData: {
                streamServiceType: 'rtmp_custom',
                streamServiceSettings: { server: 'rtmp://previous.example/live' },
            },
        },
    ]);
});

test('OBS rollback reports a rejected restore and continues remaining steps', async () => {
    const restored = [];
    let mutationCount = 0;
    const sendRequest = async (requestType, requestData) => {
        if (requestType === 'GetProfileParameter') {
            return {
                requestStatus: { result: true },
                responseData: { parameterValue: `old-${requestData.parameterName}` },
            };
        }
        if (requestType === 'SetProfileParameter') {
            mutationCount += 1;
            if (mutationCount > 2) restored.push(requestData.parameterName);
            if (mutationCount === 3) {
                return { requestStatus: { result: false, comment: 'restore denied' } };
            }
        }
        return { requestStatus: { result: true } };
    };
    const { createObsConfigurationTransaction } = await obsWebSocketModule;
    const transaction = createObsConfigurationTransaction(sendRequest);

    await transaction.request('SetProfileParameter', {
        parameterCategory: 'Output', parameterName: 'Mode', parameterValue: 'Advanced',
    });
    await transaction.request('SetProfileParameter', {
        parameterCategory: 'AdvOut', parameterName: 'Encoder', parameterValue: 'obs_x264',
    });
    const failures = await transaction.rollback();

    assert.deepEqual(restored, ['Encoder', 'Mode']);
    assert.deepEqual(failures, ['SetProfileParameter: restore denied']);
});

test('configureObsStream restores the previous service after a later validation failure', async () => {
    const serviceWrites = [];
    const WebSocketImpl = fakeObsWebSocket(withStream((ws, request) => {
        if (request.requestType === 'GetStreamServiceSettings') {
            queueMicrotask(() => ws.respond(request, {
                streamServiceType: 'rtmp_custom',
                streamServiceSettings: {
                    server: 'rtmp://previous.example/live',
                    key: 'previous-key',
                },
            }));
            return;
        }
        if (request.requestType === 'SetStreamServiceSettings') {
            serviceWrites.push(request.requestData);
        }
        queueMicrotask(() => ws.respond(request));
    }));
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = WebSocketImpl;
    const { configureObsStream } = await obsWebSocketModule;

    try {
        const result = await configureObsStream({
            whipUrl: 'http://127.0.0.1:8889/whip/room',
            bearerToken: 'new-token',
            encoderSettings: { videoCodec: 'av1', obsEncoderIds: [] },
        });

        assert.equal(result.success, false);
        assert.match(result.message, /No AV1 OBS encoders/);
        assert.match(result.message, /settings were restored.*use H\.264/i);
        assert.deepEqual(serviceWrites, [
            {
                streamServiceType: 'whip_custom',
                streamServiceSettings: {
                    server: 'http://127.0.0.1:8889/whip/room',
                    bearer_token: 'new-token',
                },
            },
            {
                streamServiceType: 'rtmp_custom',
                streamServiceSettings: {
                    server: 'rtmp://previous.example/live',
                    key: 'previous-key',
                },
            },
        ]);
    } finally {
        globalThis.WebSocket = previousWebSocket;
    }
});

test('configureObsStream accepts the first AV1 encoder OBS can set and verify', async () => {
    const profile = new Map([
        ['Output/Mode', 'Simple'],
        ['AdvOut/Encoder', 'obs_x264'],
    ]);
    const encoderWrites = [];
    const WebSocketImpl = fakeObsWebSocket(withStream((ws, request) => {
        const { requestType, requestData = {} } = request;
        const key = `${requestData.parameterCategory}/${requestData.parameterName}`;
        if (requestType === 'GetStreamServiceSettings') {
            queueMicrotask(() => ws.respond(request, {
                streamServiceType: 'rtmp_custom',
                streamServiceSettings: { server: 'rtmp://previous.example/live' },
            }));
            return;
        }
        if (requestType === 'GetProfileParameter') {
            queueMicrotask(() => ws.respond(request, { parameterValue: profile.get(key) || '' }));
            return;
        }
        if (requestType === 'SetProfileParameter') {
            if (key === 'AdvOut/Encoder') encoderWrites.push(requestData.parameterValue);
            // Simulate a missing NVENC plugin: OBS accepts the write request but
            // read-back keeps the previous value. The AMF candidate verifies.
            if (requestData.parameterValue !== 'obs_nvenc_av1_tex') {
                profile.set(key, requestData.parameterValue);
            }
            queueMicrotask(() => ws.respond(request));
            return;
        }
        if (requestType === 'GetOutputList') {
            queueMicrotask(() => ws.respond(request, { outputs: [] }));
            return;
        }
        if (requestType === 'GetOutputSettings') {
            queueMicrotask(() => ws.respond(request, {}, { result: false, comment: 'not found' }));
            return;
        }
        queueMicrotask(() => ws.respond(request));
    }));
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = WebSocketImpl;
    const { configureObsStream } = await obsWebSocketModule;

    try {
        const result = await configureObsStream({
            whipUrl: 'http://127.0.0.1:8889/whip/room',
            bearerToken: 'new-token',
            encoderSettings: {
                videoCodec: 'av1',
                obsEncoderIds: ['obs_nvenc_av1_tex', 'av1_texture_amf'],
                bitrateKbps: 12_000,
            },
        });

        assert.equal(result.success, true);
        assert.match(result.message, /AV1 AMF/);
        assert.deepEqual(encoderWrites, ['obs_nvenc_av1_tex', 'av1_texture_amf']);
        assert.equal(profile.get('AdvOut/Encoder'), 'av1_texture_amf');
    } finally {
        globalThis.WebSocket = previousWebSocket;
    }
});

test('rejected AV1 encoder candidates roll back to the prior H.264 route', async () => {
    let streamService = {
        streamServiceType: 'rtmp_custom',
        streamServiceSettings: { server: 'rtmp://previous.example/live' },
    };
    const profile = new Map([
        ['Output/Mode', 'Simple'],
        ['AdvOut/Encoder', 'obs_x264'],
    ]);
    const WebSocketImpl = fakeObsWebSocket(withStream((ws, request) => {
        const { requestType, requestData = {} } = request;
        const key = `${requestData.parameterCategory}/${requestData.parameterName}`;
        if (requestType === 'GetStreamServiceSettings') {
            queueMicrotask(() => ws.respond(request, streamService));
            return;
        }
        if (requestType === 'SetStreamServiceSettings') {
            streamService = requestData;
            queueMicrotask(() => ws.respond(request));
            return;
        }
        if (requestType === 'GetProfileParameter') {
            queueMicrotask(() => ws.respond(request, { parameterValue: profile.get(key) || '' }));
            return;
        }
        if (requestType === 'SetProfileParameter') {
            if (key === 'AdvOut/Encoder' && requestData.parameterValue !== 'obs_x264') {
                queueMicrotask(() => ws.respond(request, {}, { result: false, comment: 'encoder plugin unavailable' }));
                return;
            }
            profile.set(key, requestData.parameterValue);
            queueMicrotask(() => ws.respond(request));
            return;
        }
        queueMicrotask(() => ws.respond(request));
    }));
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = WebSocketImpl;
    const { configureObsStream } = await obsWebSocketModule;

    try {
        const result = await configureObsStream({
            whipUrl: 'http://127.0.0.1:8889/whip/room',
            bearerToken: 'new-token',
            encoderSettings: {
                videoCodec: 'av1',
                obsEncoderIds: ['obs_nvenc_av1_tex', 'av1_texture_amf'],
            },
        });

        assert.equal(result.success, false);
        assert.match(result.message, /Tried: AV1 NVENC, AV1 AMF/);
        assert.match(result.message, /settings were restored.*use H\.264/i);
        assert.deepEqual(streamService, {
            streamServiceType: 'rtmp_custom',
            streamServiceSettings: { server: 'rtmp://previous.example/live' },
        });
        assert.equal(profile.get('Output/Mode'), 'Simple');
        assert.equal(profile.get('AdvOut/Encoder'), 'obs_x264');
    } finally {
        globalThis.WebSocket = previousWebSocket;
    }
});

// A scripted OBS for whole-setup tests: a profile store, a stream that can be
// active or stuck reconnecting, and a log of the requests that change something.
function scriptedObs({ profile = new Map(), status = { outputActive: false, outputReconnecting: false }, profileName = 'Streaming', onStart = null } = {}) {
    const order = [];
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
        const { requestType, requestData = {} } = request;
        const key = `${requestData.parameterCategory}/${requestData.parameterName}`;
        const reply = (data, requestStatus) => queueMicrotask(() => ws.respond(request, data, requestStatus));
        switch (requestType) {
        case 'GetStreamStatus':
            return reply({ ...status });
        case 'StartStream':
            order.push('StartStream');
            status.outputActive = true;
            status.outputReconnecting = false;
            onStart?.(status);
            return reply();
        case 'StopStream':
            order.push('StopStream');
            status.outputActive = false;
            status.outputReconnecting = false;
            return reply();
        case 'GetStreamServiceSettings':
            return reply({ streamServiceType: 'whip_custom', streamServiceSettings: { server: 'http://old.example/whip' } });
        case 'GetVideoSettings':
            return reply({ outputWidth: 2560, outputHeight: 1440 });
        case 'GetProfileParameter':
            return reply({ parameterValue: profile.get(key) ?? '' });
        case 'SetProfileParameter':
            profile.set(key, requestData.parameterValue);
            return reply();
        case 'GetProfileList':
            return reply({ currentProfileName: profileName, profiles: [profileName] });
        case 'GetOutputList':
            return reply({ outputs: [] });
        case 'GetOutputSettings':
            return reply({}, { result: false, comment: 'not found' });
        default:
            if (requestType === 'SetStreamServiceSettings' || requestType === 'SetVideoSettings') order.push(requestType);
            return reply();
        }
    });
    return { WebSocketImpl, order, profile, status };
}

async function configureWith(obs, options) {
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = obs.WebSocketImpl;
    const { configureObsStream } = await obsWebSocketModule;
    try {
        return await configureObsStream({
            whipUrl: 'http://127.0.0.1:3001/whip/broadcast/ABC123',
            bearerToken: 'token',
            ...options,
        });
    } finally {
        globalThis.WebSocket = previousWebSocket;
    }
}

const nvencEncoderSettings = {
    videoCodec: 'h264',
    obsEncoderIds: ['obs_nvenc_h264_tex', 'obs_x264'],
    bitrateKbps: 18_000,
    keyframeIntervalSec: 1,
    nvencPreset: 'p5',
    nvencMultipass: 'fullres',
};

test('the encoder settings OBS actually reads are handed over for the current profile', async () => {
    const obs = scriptedObs({ profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_nvenc_h264_tex']]) });
    const written = [];

    const result = await configureWith(obs, {
        encoderSettings: nvencEncoderSettings,
        writeEncoderSettings: async (payload) => {
            written.push(payload);
            return { applied: true };
        },
    });

    assert.equal(result.success, true);
    assert.deepEqual(written, [{
        profileName: 'Streaming',
        settings: {
            rate_control: 'CBR',
            bitrate: 18_000,
            keyint_sec: 1,
            bf: 0,
            repeat_headers: true,
            max_bitrate: 18_000,
            preset: 'p5',
            preset2: 'p5',
            tune: 'll',
            multipass: 'fullres',
            lookahead: false,
            disable_scenecut: true,
            profile: 'high',
        },
    }]);
    // The WHIP service in OBS only turns B-frames off when it may apply its settings.
    assert.equal(obs.profile.get('AdvOut/ApplyServiceSettings'), 'true');
    assert.match(result.message, /18000 kbps/);
    assert.match(result.message, /keyframe: 1s/);
    assert.doesNotMatch(result.message, /Warnings/);
    // Nothing is written under a profile section named after the encoder: OBS
    // never reads settings from there.
    assert.equal([...obs.profile.keys()].some((key) => key.startsWith('obs_nvenc_h264_tex/')), false);
});

test('a setup that could not store the encoder settings says what to set by hand', async () => {
    const obs = scriptedObs({ profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_nvenc_h264_tex']]) });

    const remote = await configureWith(obs, {
        encoderSettings: nvencEncoderSettings,
        writeEncoderSettings: async () => ({ applied: false, reason: 'not-local' }),
    });
    assert.equal(remote.success, true);
    assert.match(remote.message, /could not set the encoder's own settings/);
    assert.match(remote.message, /bitrate 18000 kbps, keyframe interval 1 s/);
    assert.doesNotMatch(remote.message, /low-latency tuning/);

    const failing = await configureWith(obs, {
        encoderSettings: nvencEncoderSettings,
        writeEncoderSettings: async () => { throw new Error('socket timeout'); },
    });
    assert.match(failing.message, /could not set the encoder's own settings/);

    const without = await configureWith(obs, { encoderSettings: nvencEncoderSettings });
    assert.match(without.message, /could not set the encoder's own settings/);
});

test('an encoder OBS kept from a stream that never connected is released before settings change', async () => {
    // OBS is retrying a room that no longer exists.
    const obs = scriptedObs({
        profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_nvenc_h264_tex']]),
        status: { outputActive: true, outputReconnecting: true },
    });

    const result = await configureWith(obs, {
        videoSettings: { outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 },
        encoderSettings: nvencEncoderSettings,
        writeEncoderSettings: async () => ({ applied: true }),
    });

    assert.equal(result.success, true);
    // Stop the retry, point OBS at the new room, run a stream there just long
    // enough for OBS to release the old encoder, and only then change the video.
    assert.deepEqual(obs.order, ['StopStream', 'SetStreamServiceSettings', 'StartStream', 'StopStream', 'SetVideoSettings']);
    assert.match(result.message, /encoder reset/);
    assert.doesNotMatch(result.message, /Warnings/);
});

test('an idle OBS is assumed to hold an old encoder, because OBS does not say', async () => {
    // What a room that ended while OBS was still streaming leaves behind: OBS
    // retried, set its encoder up again, and was then stopped.
    const obs = scriptedObs({ profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_nvenc_h264_tex']]) });

    const result = await configureWith(obs, {
        videoSettings: { outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 },
        encoderSettings: nvencEncoderSettings,
        writeEncoderSettings: async () => ({ applied: true }),
    });

    assert.equal(result.success, true);
    assert.deepEqual(obs.order, ['SetStreamServiceSettings', 'StartStream', 'StopStream', 'SetVideoSettings']);
    assert.match(result.message, /encoder reset/);
    assert.equal(obs.status.outputActive, false);
});

test('a test stream the room refuses is stopped and reported, not waited on', async () => {
    const obs = scriptedObs({
        profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_nvenc_h264_tex']]),
        // The stream never connects: OBS goes straight to retrying.
        onStart: (status) => { status.outputReconnecting = true; },
    });

    const startedAt = Date.now();
    const result = await configureWith(obs, {
        encoderSettings: nvencEncoderSettings,
        writeEncoderSettings: async () => ({ applied: true }),
    });

    assert.equal(result.success, true);
    // Tried twice, since a test stream that fails leaves an encoder behind too.
    assert.deepEqual(obs.order, ['SetStreamServiceSettings', 'StartStream', 'StopStream', 'StartStream', 'StopStream']);
    assert.match(result.message, /could not run the short test stream/);
    assert.equal(obs.status.outputActive, false);
    assert.ok(Date.now() - startedAt < 3000, 'gave up on the first sign of a retry');
});

test('a stream that was simply live is stopped once, with no extra start', async () => {
    const obs = scriptedObs({
        profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_nvenc_h264_tex']]),
        status: { outputActive: true, outputReconnecting: false },
    });
    await configureWith(obs, { encoderSettings: nvencEncoderSettings, writeEncoderSettings: async () => ({ applied: true }) });
    assert.deepEqual(obs.order, ['StopStream', 'SetStreamServiceSettings']);
});

test('a changed encoder or output mode is reported as needing an OBS restart', async () => {
    const simple = scriptedObs({ profile: new Map([['Output/Mode', 'Simple'], ['AdvOut/Encoder', 'obs_nvenc_h264_tex']]) });
    const fromSimple = await configureWith(simple, { encoderSettings: nvencEncoderSettings, writeEncoderSettings: async () => ({ applied: true }) });
    assert.match(fromSimple.message, /only after it restarts/);

    const x264 = scriptedObs({ profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_x264']]) });
    const fromX264 = await configureWith(x264, { encoderSettings: nvencEncoderSettings, writeEncoderSettings: async () => ({ applied: true }) });
    assert.match(fromX264.message, /H\.264 NVENC in Advanced output mode only after it restarts/);
    assert.equal(x264.profile.get('AdvOut/Encoder'), 'obs_nvenc_h264_tex');
});

test('the encoder is chosen from the ones OBS has, not from the page\'s guess at the GPU', async () => {
    // The page could not see the GPU and asked for x264; OBS has NVENC.
    const obs = scriptedObs({ profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_nvenc_h264_tex']]) });
    const written = [];

    const result = await configureWith(obs, {
        encoderSettings: { ...nvencEncoderSettings, obsEncoderIds: ['obs_x264'] },
        listEncoders: async () => ['ffmpeg_svt_av1', 'obs_nvenc_h264_tex', 'obs_nvenc_av1_tex', 'obs_x264'],
        writeEncoderSettings: async (payload) => {
            written.push(payload);
            return { applied: true };
        },
    });

    assert.equal(result.success, true);
    assert.equal(obs.profile.get('AdvOut/Encoder'), 'obs_nvenc_h264_tex');
    assert.equal(written[0].settings.tune, 'll');
    assert.match(result.message, /H\.264 NVENC/);
    assert.doesNotMatch(result.message, /Warnings/);
});

test('an encoder list that cannot be fetched leaves the page\'s own choice', async () => {
    const obs = scriptedObs({ profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_x264']]) });

    const result = await configureWith(obs, {
        encoderSettings: { ...nvencEncoderSettings, obsEncoderIds: ['obs_x264'] },
        listEncoders: async () => { throw new Error('socket timeout'); },
        writeEncoderSettings: async () => ({ applied: true }),
    });

    assert.equal(result.success, true);
    assert.equal(obs.profile.get('AdvOut/Encoder'), 'obs_x264');
    assert.match(result.message, /x264 preset/);
});

test('AV1 is refused, and OBS left as it was, when OBS has no AV1 encoder', async () => {
    const obs = scriptedObs({ profile: new Map([['Output/Mode', 'Advanced'], ['AdvOut/Encoder', 'obs_nvenc_h264_tex']]) });

    const result = await configureWith(obs, {
        encoderSettings: { ...nvencEncoderSettings, videoCodec: 'av1', obsEncoderIds: ['obs_nvenc_av1_tex', 'av1_texture_amf'] },
        listEncoders: async () => ['obs_nvenc_h264_tex', 'obs_x264'],
        writeEncoderSettings: async () => ({ applied: true }),
    });

    assert.equal(result.success, false);
    assert.match(result.message, /OBS has no AV1 encoder on this machine/);
    assert.equal(obs.profile.get('AdvOut/Encoder'), 'obs_nvenc_h264_tex');
});
