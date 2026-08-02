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
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
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
    });
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
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
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
    });
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
    const WebSocketImpl = fakeObsWebSocket((ws, request) => {
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
    });
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
