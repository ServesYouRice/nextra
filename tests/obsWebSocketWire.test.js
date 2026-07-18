const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');

const obsModule = import('../src/lib/obsWebSocket.js');

async function startObsServer(onRequest) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    server.on('connection', (socket) => {
        socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '30.2.0', rpcVersion: 1 } }));
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.op === 1) {
                socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
            } else if (message.op === 6) {
                onRequest(socket, message.d);
            }
        });
    });
    const address = server.address();
    return {
        url: `ws://127.0.0.1:${address.port}`,
        close: async () => {
            for (const client of server.clients) client.terminate();
            server.close();
            await once(server, 'close');
        },
    };
}

function respond(socket, request, { result = true, comment, responseData } = {}) {
    socket.send(JSON.stringify({
        op: 7,
        d: {
            requestType: request.requestType,
            requestId: request.requestId,
            requestStatus: { result, code: result ? 100 : 500, ...(comment ? { comment } : {}) },
            ...(responseData ? { responseData } : {}),
        },
    }));
}

test('wire-level OBS transport matches reordered responses and protocol rejection', async (t) => {
    const pending = [];
    const fake = await startObsServer((socket, request) => {
        pending.push({ socket, request });
        if (pending.length !== 2) return;
        respond(pending[1].socket, pending[1].request, {
            result: false,
            comment: 'wire rejection',
        });
        respond(pending[0].socket, pending[0].request, {
            responseData: { outputActive: false },
        });
    });
    t.after(() => fake.close());
    const { withObsConnection } = await obsModule;

    const result = await withObsConnection('', async (sendRequest, done) => {
        const first = sendRequest('GetStreamStatus');
        const second = sendRequest('SetStreamServiceSettings', { streamServiceType: 'whip_custom' });
        const [status, rejected] = await Promise.all([first, second]);
        done({
            success: status.responseData.outputActive === false && rejected.requestStatus.result === false,
            message: rejected.requestStatus.comment,
        });
    }, { WebSocketImpl: WebSocket, url: fake.url });

    assert.deepEqual(result, { success: true, message: 'wire rejection' });
});

test('wire-level disconnect during rollback reports the interrupted restore', async (t) => {
    let serviceWrites = 0;
    const fake = await startObsServer((socket, request) => {
        if (request.requestType === 'GetStreamServiceSettings') {
            respond(socket, request, {
                responseData: {
                    streamServiceType: 'rtmp_custom',
                    streamServiceSettings: { server: 'rtmp://previous/live' },
                },
            });
            return;
        }
        if (request.requestType === 'SetStreamServiceSettings') {
            serviceWrites += 1;
            if (serviceWrites === 1) respond(socket, request);
            else socket.close(4000, 'disconnect during rollback');
        }
    });
    t.after(() => fake.close());
    const { withObsConnection, createObsConfigurationTransaction } = await obsModule;

    const result = await withObsConnection('', async (sendRequest, done) => {
        const transaction = createObsConfigurationTransaction(sendRequest);
        await transaction.request('SetStreamServiceSettings', {
            streamServiceType: 'whip_custom',
            streamServiceSettings: { server: 'http://new/whip' },
        });
        const failures = await transaction.rollback();
        done({ success: false, message: failures.join('; ') });
    }, { WebSocketImpl: WebSocket, url: fake.url, requestTimeoutMs: 500 });

    assert.equal(result.success, false);
    assert.match(result.message, /disconnected before setup completed|SetStreamServiceSettings/);
    assert.equal(serviceWrites, 2);
});
