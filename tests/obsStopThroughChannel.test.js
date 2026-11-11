const test = require('node:test');
const assert = require('node:assert/strict');

const obsWebSocketModule = import('../src/lib/obsWebSocket.js');

test('a stop the control channel delivered is not sent again on a fresh connection', async () => {
    const { stopObsThroughChannel } = await obsWebSocketModule;
    let fresh = 0;
    const result = await stopObsThroughChannel({ stopStream: async () => true }, async () => { fresh += 1; });
    assert.equal(result, true);
    assert.equal(fresh, 0);
});

test('a control channel that lost OBS hands the stop to a fresh connection', async () => {
    const { stopObsThroughChannel } = await obsWebSocketModule;
    for (const channel of [
        { stopStream: async () => false },
        { stopStream: async () => { throw new Error('socket closed'); } },
        null,
    ]) {
        let fresh = 0;
        const result = await stopObsThroughChannel(channel, async () => { fresh += 1; return { success: true }; });
        assert.deepEqual(result, { success: true });
        assert.equal(fresh, 1, 'the stop was lost with the dead channel');
    }
});

test('a channel whose connection dropped after it opened answers false, so the fallback runs', async () => {
    const { openObsControlChannel, stopObsThroughChannel } = await obsWebSocketModule;
    let socket = null;
    class DroppingObsWebSocket {
        constructor() {
            socket = this;
            queueMicrotask(() => {
                this.onopen?.();
                this.onmessage?.({ data: JSON.stringify({ op: 0, d: { rpcVersion: 1 } }) });
            });
        }

        send(payload) {
            const message = JSON.parse(payload);
            if (message.op === 1) {
                queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }) }));
            }
        }

        close() {
            this.onclose?.({ code: 1006 });
        }
    }
    const channel = openObsControlChannel({ WebSocketImpl: DroppingObsWebSocket });
    assert.equal((await channel.ready).success, true);
    // OBS restarts: the open connection ends underneath the page.
    socket.onclose?.({ code: 1006 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    let fresh = 0;
    await stopObsThroughChannel(channel, async () => { fresh += 1; });
    assert.equal(fresh, 1);
    channel.close();
});
