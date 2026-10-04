const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { startFallbackRelay, recordFallbackAck, setRelayCapacityKbps } = require('../lib/socket');

// The relay in 100 ms fragments, a keyframe every second: 175 kB each at 14 Mbps.
const FRAGMENT_BYTES = 175_000;
const FRAGMENT_KBPS = 14_000;
const FRAGMENTS_PER_SECOND = 10;

class FakeRelay extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        this.reconfigured = [];
        // Each restart: the bitrate it re-encodes at, or 'pass-through'.
        this.modes = [];
        this.videoCopy = false;
    }

    async start() {}

    stop() {}

    async reconfigure(kbps, { copy = false } = {}) {
        this.reconfigured.push(kbps);
        this.videoCopy = copy;
        this.modes.push(copy ? 'pass-through' : kbps);
    }

    get restartCount() { return 0; }
}

function createRouter() {
    return {
        rtpCapabilities: {},
        async createDirectTransport() {
            return {
                close() {},
                async consume() {
                    const consumer = new EventEmitter();
                    consumer.close = () => {};
                    consumer.requestKeyFrame = async () => {};
                    consumer.pause = async () => {};
                    consumer.resume = async () => {};
                    return consumer;
                },
            };
        },
    };
}

// A cut to 70% of the 6.4 Mbps a link carries, give or take what measuring that
// from the outside allows.
function assertCutToMeasuredRate(kbps) {
    assert.ok(Math.abs(kbps - 4480) <= 110, `cut to ${kbps} kbps`);
}

// Each test runs on its own stretch of the clock, hours apart, so the bitrate
// one test's relay settles on is not remembered as a hint by the next.
let nextClockStart = 0;

// Viewers whose connections drain `bytesPerSecond` each; whatever the server
// hands them queues up until the link has carried it, and the player then
// acknowledges it. `hiddenBufferBytes` of that queue sit where the server cannot
// see them (the operating system, a tunnel); `silent` viewers do not acknowledge.
async function startRelayRoom(drainBytesPerSecond, { hiddenBufferBytes = 0, silent = [] } = {}) {
    nextClockStart += 100_000_000;
    const clock = { now: nextClockStart };
    const backlog = new Map();
    const received = new Map();
    const filler = new Map();
    const sockets = new Map();
    // Per viewer: bytes handed to the link, bytes it has carried, and the
    // fragments on their way.
    const links = new Map();
    const addViewer = (id) => {
        backlog.set(id, 0);
        received.set(id, []);
        filler.set(id, 0);
        links.set(id, { handed: 0, carried: 0, onTheWay: [] });
        sockets.set(id, {
            id,
            emit(event, payload) {
                const link = links.get(id);
                // Filler travels the same link as the media it follows.
                if (event === 'relay-filler') {
                    filler.set(id, filler.get(id) + payload.length);
                    backlog.set(id, backlog.get(id) + payload.length);
                    link.handed += payload.length;
                }
                if (event !== 'media-chunk') return;
                received.get(id).push(payload);
                backlog.set(id, backlog.get(id) + payload.chunk.length);
                link.handed += payload.chunk.length;
                link.onTheWay.push({ generation: payload.generation, sequence: payload.sequence, end: link.handed });
            },
        });
    };
    for (const id of Object.keys(drainBytesPerSecond)) addViewer(id);
    const io = { sockets: { sockets }, to: () => ({ emit() {} }) };
    const room = {
        code: 'ABC123',
        fallbackStarting: false,
        fallbackWorker: null,
        fallbackAvailable: false,
        fallbackGeneration: 0,
        fallbackViewers: new Set(sockets.keys()),
        frameRate: 30,
        relayVideoKbps: 14000,
        obsVideoCodec: 'h264',
        whipProducer: { id: 'video-producer' },
        whipAudioProducer: null,
    };
    const relayRuntime = {
        now: () => clock.now,
        measureBacklogBytes: (socket) => Math.max(0, (backlog.get(socket.id) || 0) - hiddenBufferBytes),
    };

    await startFallbackRelay(room, createRouter(), io, { FFmpegRelay: FakeRelay, relayRuntime });
    const relay = room.fallbackWorker;
    assert.ok(relay, 'relay should be running');
    relay.emit('init', { initSegment: Buffer.from('ftypmoovavc1payload') });

    let sequence = 0;
    const tick = () => {
        clock.now += 1000 / FRAGMENTS_PER_SECOND;
        for (const [id, queued] of backlog) {
            const carried = Math.min(queued, (drainBytesPerSecond[id] || 0) / FRAGMENTS_PER_SECOND);
            backlog.set(id, queued - carried);
            const link = links.get(id);
            link.carried += carried;
            while (link.onTheWay.length > 0 && link.onTheWay[0].end <= link.carried) {
                const arrived = link.onTheWay.shift();
                if (!silent.includes(id)) recordFallbackAck(room, id, arrived, clock.now);
            }
        }
        sequence += 1;
        relay.emit('fragment', {
            sequence,
            hasVideo: true,
            keyframeStart: sequence % FRAGMENTS_PER_SECOND === 1,
            // The encoder produces what it is currently set to.
            data: Buffer.alloc(Math.round(FRAGMENT_BYTES * room.fallbackBitrate.currentKbps / FRAGMENT_KBPS), 1),
        });
    };
    return {
        room,
        relay,
        received,
        filler,
        clock,
        tick,
        addViewer(id, bytesPerSecond) {
            drainBytesPerSecond[id] = bytesPerSecond;
            addViewer(id);
            room.fallbackViewers.add(id);
        },
        // Whole seconds of stream.
        run(seconds, until = () => false) {
            for (let i = 0; i < seconds * FRAGMENTS_PER_SECOND && !until(); i++) tick();
        },
        close() {
            room._mediaPipeline.close();
        },
    };
}

test('when every viewer is behind, the relay restarts at the rate their connections carried', async () => {
    // 800 kB/s is 6.4 Mbps against a 14 Mbps stream.
    const relayRoom = await startRelayRoom({ a: 800_000, b: 800_000 });
    try {
        const startedAt = relayRoom.clock.now;
        relayRoom.run(30, () => relayRoom.relay.reconfigured.length > 0);

        // 70% of the 6.4 Mbps their connections were measured to carry.
        assert.equal(relayRoom.relay.reconfigured.length, 1);
        const [cut] = relayRoom.relay.reconfigured;
        assertCutToMeasuredRate(cut);
        assert.equal(relayRoom.room.fallbackBitrate.currentKbps, cut);
        assert.equal(relayRoom.room.fallbackBitrate.targetKbps, 14000);
        // It did not take five seconds of skipping to find out: the viewers were
        // a second behind, and what they received showed why.
        assert.ok(relayRoom.clock.now - startedAt < 5000, `cut after ${relayRoom.clock.now - startedAt} ms`);

        // The new rate needs time to show before another cut.
        relayRoom.run(15);
        assert.deepEqual(relayRoom.relay.reconfigured, [cut]);
    } finally {
        relayRoom.close();
    }
});

test('one slow viewer skips ahead without lowering the relay for the others', async () => {
    const relayRoom = await startRelayRoom({ slow: 800_000, fast: 20_000_000 });
    try {
        relayRoom.run(40);

        assert.deepEqual(relayRoom.relay.reconfigured, []);
        assert.equal(relayRoom.received.get('fast').length, 40 * FRAGMENTS_PER_SECOND);
        assert.ok(relayRoom.received.get('slow').length < 30 * FRAGMENTS_PER_SECOND);
        assert.equal(relayRoom.room.fallbackBitrate.currentKbps, 14000);
    } finally {
        relayRoom.close();
    }
});

test('a viewer begins on a keyframe and resumes on one after skipping', async () => {
    const relayRoom = await startRelayRoom({ steady: 20_000_000 });
    try {
        // Three fragments into a GOP, a second viewer joins.
        relayRoom.run(0.3);
        relayRoom.addViewer('late', 800_000);
        relayRoom.run(20);

        const late = relayRoom.received.get('late');
        assert.equal(late[0].keyframeStart, true, 'the first fragment a viewer gets must start on a keyframe');
        assert.equal(late[0].sequence, 11);
        // Wherever fragments were skipped, delivery picked up again on a keyframe.
        let resumptions = 0;
        for (let i = 1; i < late.length; i++) {
            if (late[i].sequence === late[i - 1].sequence + 1) continue;
            resumptions += 1;
            assert.equal(late[i].keyframeStart, true, `resumed on fragment ${late[i].sequence}`);
        }
        assert.ok(resumptions > 0, 'a viewer at 6.4 Mbps cannot take every fragment of a 14 Mbps relay');
    } finally {
        relayRoom.close();
    }
});

test('a relay just over what the link carries is eased down before the viewer has to skip', async () => {
    // 1.72 MB/s against 1.75 MB/s of relay: never far behind, never catching up.
    const relayRoom = await startRelayRoom({ a: 1_720_000 });
    try {
        relayRoom.run(120);
        assert.equal(relayRoom.relay.reconfigured[0], 12600);
        const got = relayRoom.received.get('a');
        assert.equal(got.length, got.at(-1).sequence, 'no fragment should have been skipped');
    } finally {
        relayRoom.close();
    }
});

test('a viewer who stays a little behind while another keeps up is skipped to live', async () => {
    // The link they share has room, so the bitrate stays; the slow one must not
    // trail further and further behind.
    const relayRoom = await startRelayRoom({ slow: 1_720_000, fast: 20_000_000 });
    try {
        relayRoom.run(120);
        assert.deepEqual(relayRoom.relay.reconfigured, []);
        const got = relayRoom.received.get('slow');
        const skipped = got.at(-1).sequence - got[0].sequence + 1 - got.length;
        assert.ok(skipped > 0, 'the slow viewer should have been skipped ahead at least once');
        assert.equal(relayRoom.received.get('fast').length, 120 * FRAGMENTS_PER_SECOND);
    } finally {
        relayRoom.close();
    }
});

test('a relay starts at what the public link was measured to carry', async () => {
    setRelayCapacityKbps(10_000);
    try {
        const relayRoom = await startRelayRoom({ a: 1_250_000 });
        try {
            assert.equal(relayRoom.relay.opts.videoBitrateKbps, 7000);
            assert.equal(relayRoom.room.fallbackBitrate.currentKbps, 7000);
            assert.equal(relayRoom.room.fallbackBitrate.targetKbps, 14000);
        } finally {
            relayRoom.close();
        }
    } finally {
        setRelayCapacityKbps(null);
    }
});

test('a relay that was cut goes back up once nobody is watching and the cut is old', async () => {
    const relayRoom = await startRelayRoom({ a: 800_000 });
    try {
        relayRoom.run(30, () => relayRoom.relay.reconfigured.length > 0);
        const [cut] = relayRoom.relay.reconfigured;
        assertCutToMeasuredRate(cut);

        // The viewer leaves. The cut is recent, so it stands for the next viewer.
        relayRoom.room.fallbackViewers.clear();
        relayRoom.run(60);
        assert.deepEqual(relayRoom.relay.reconfigured, [cut]);

        // Half an hour on, with still nobody watching, the restart is free.
        relayRoom.clock.now += 31 * 60_000;
        relayRoom.run(15);
        assert.deepEqual(relayRoom.relay.reconfigured, [cut, 14000]);
    } finally {
        relayRoom.close();
    }
});

test('a relay that started low climbs back to full quality while its viewers keep up', async () => {
    setRelayCapacityKbps(10_000);
    try {
        // The link was measured at a bad moment; it actually carries far more.
        const relayRoom = await startRelayRoom({ a: 20_000_000 });
        try {
            assert.equal(relayRoom.room.fallbackBitrate.currentKbps, 7000);
            // Half a minute of keeping up, then four seconds of filler.
            relayRoom.run(29);
            assert.equal(relayRoom.filler.get('a'), 0);
            relayRoom.run(4);
            assert.ok(relayRoom.filler.get('a') > 0, 'the link is tested before the step');
            assert.deepEqual(relayRoom.relay.reconfigured, []);

            relayRoom.run(107);
            assert.deepEqual(relayRoom.relay.reconfigured, [8400, 10080, 12096, 14000]);
            const fillerOnTheWayUp = relayRoom.filler.get('a');
            relayRoom.run(120);
            assert.deepEqual(relayRoom.relay.reconfigured, [8400, 10080, 12096, 14000]);
            // At full quality there is nothing left to test for.
            assert.equal(relayRoom.filler.get('a'), fillerOnTheWayUp);
            // Nothing was skipped on the way up.
            assert.equal(relayRoom.received.get('a').length, relayRoom.received.get('a').at(-1).sequence);
        } finally {
            relayRoom.close();
        }
    } finally {
        setRelayCapacityKbps(null);
    }
});

test('a link without room for a step is found out by the filler, not by the viewer', async () => {
    setRelayCapacityKbps(10_000);
    try {
        // 1.2 MB/s is 9.6 Mbps: room for 8.4 Mbps, not for 35% on top of that.
        const relayRoom = await startRelayRoom({ a: 1_200_000 });
        try {
            relayRoom.run(75);
            assert.deepEqual(relayRoom.relay.reconfigured, [8400]);

            // The tests that follow fail, further and further apart, and none of
            // them restarts the encoder or costs the viewer a fragment.
            relayRoom.run(400);
            assert.deepEqual(relayRoom.relay.reconfigured, [8400]);
            assert.equal(relayRoom.room.fallbackBitrate.currentKbps, 8400);
            assert.equal(relayRoom.received.get('a').length, relayRoom.received.get('a').at(-1).sequence);
        } finally {
            relayRoom.close();
        }
    } finally {
        setRelayCapacityKbps(null);
    }
});

test('a step up that the link stops carrying is taken back', async () => {
    setRelayCapacityKbps(10_000);
    try {
        const link = { a: 20_000_000 };
        const relayRoom = await startRelayRoom(link);
        try {
            relayRoom.run(40, () => relayRoom.relay.reconfigured.length > 0);
            assert.deepEqual(relayRoom.relay.reconfigured, [8400]);

            // The line gets worse right after the step: 0.95 MB/s carries the
            // 7 Mbps the relay had, not the 8.4 it has now.
            link.a = 950_000;
            relayRoom.run(15);
            assert.deepEqual(relayRoom.relay.reconfigured, [8400, 7000]);
            assert.equal(relayRoom.room.fallbackBitrate.currentKbps, 7000);
        } finally {
            relayRoom.close();
        }
    } finally {
        setRelayCapacityKbps(null);
    }
});

test('one viewer who cannot keep up holds the bitrate where it is for everyone', async () => {
    setRelayCapacityKbps(10_000);
    try {
        // 0.85 MB/s is 6.8 Mbps against a 7 Mbps relay: always a little behind.
        const relayRoom = await startRelayRoom({ steady: 20_000_000, behind: 850_000 });
        try {
            relayRoom.run(180);
            assert.deepEqual(relayRoom.relay.reconfigured, []);
            assert.equal(relayRoom.room.fallbackBitrate.currentKbps, 7000);
            assert.equal(relayRoom.filler.get('steady'), 0);
        } finally {
            relayRoom.close();
        }
    } finally {
        setRelayCapacityKbps(null);
    }
});

test('a backlog that sits where the server cannot see it still stops a step up', async () => {
    setRelayCapacityKbps(10_000);
    try {
        // The same 9.6 Mbps link, behind 1.5 MB of buffers the server knows
        // nothing about: its own send queue stays empty the whole time.
        const relayRoom = await startRelayRoom({ a: 1_200_000 }, { hiddenBufferBytes: 1_500_000 });
        try {
            relayRoom.run(75);
            assert.deepEqual(relayRoom.relay.reconfigured, [8400]);
            relayRoom.run(400);
            assert.deepEqual(relayRoom.relay.reconfigured, [8400]);
            assert.equal(relayRoom.received.get('a').length, relayRoom.received.get('a').at(-1).sequence);
        } finally {
            relayRoom.close();
        }
    } finally {
        setRelayCapacityKbps(null);
    }
});

test('a relay too fast for a link is found out through buffers the server cannot see', async () => {
    // 6.4 Mbps of link for a 14 Mbps relay, with 1.5 MB of hidden buffers: the
    // server's own send queue stays empty for the first two seconds.
    const relayRoom = await startRelayRoom({ a: 800_000 }, { hiddenBufferBytes: 1_500_000 });
    try {
        const startedAt = relayRoom.clock.now;
        relayRoom.run(40, () => relayRoom.relay.reconfigured.length > 0);
        assert.equal(relayRoom.relay.reconfigured.length, 1);
        assertCutToMeasuredRate(relayRoom.relay.reconfigured[0]);
        assert.ok(relayRoom.clock.now - startedAt < 5000, `cut after ${relayRoom.clock.now - startedAt} ms`);
    } finally {
        relayRoom.close();
    }
});

test('a player that does not acknowledge is still covered by what the send queue shows', async () => {
    const relayRoom = await startRelayRoom({ a: 800_000 }, { silent: ['a'] });
    try {
        relayRoom.run(40, () => relayRoom.relay.reconfigured.length > 0);
        assert.equal(relayRoom.relay.reconfigured.length, 1);
        assertCutToMeasuredRate(relayRoom.relay.reconfigured[0]);
    } finally {
        relayRoom.close();
    }
});

test('a viewer whose player does not acknowledge never gets a step up', async () => {
    setRelayCapacityKbps(10_000);
    try {
        const relayRoom = await startRelayRoom({ a: 20_000_000 }, { silent: ['a'] });
        try {
            relayRoom.run(180);
            assert.deepEqual(relayRoom.relay.reconfigured, []);
            assert.equal(relayRoom.filler.get('a'), 0);
            assert.equal(relayRoom.received.get('a').length, 180 * FRAGMENTS_PER_SECOND);
        } finally {
            relayRoom.close();
        }
    } finally {
        setRelayCapacityKbps(null);
    }
});

test('a link that suddenly carries much less is answered with one cut to what it carries', async () => {
    const link = { a: 20_000_000 };
    const relayRoom = await startRelayRoom(link, { hiddenBufferBytes: 1_500_000 });
    try {
        relayRoom.run(20);
        assert.deepEqual(relayRoom.relay.reconfigured, []);

        // 1 MB/s is 8 Mbps under a 14 Mbps relay, and none of the backlog shows
        // in the server's own send queue.
        link.a = 1_000_000;
        relayRoom.run(20, () => relayRoom.relay.reconfigured.length > 0);
        assert.equal(relayRoom.relay.reconfigured.length, 1);
        const [cut] = relayRoom.relay.reconfigured;
        // 70% of the 8 Mbps the viewer was receiving, not a blind step that is
        // still more than the link carries.
        assert.ok(Math.abs(cut - 5600) <= 60, `cut to ${cut} kbps`);
    } finally {
        relayRoom.close();
    }
});

test('at full bitrate the relay passes the OBS stream through, and re-encodes only while the link cannot carry it', async () => {
    const link = { a: 20_000_000 };
    const relayRoom = await startRelayRoom(link);
    try {
        // OBS runs on Nextra's settings and its stream shows it.
        relayRoom.room.obsEncoderSettingsApplied = true;
        relayRoom.room.fallbackSource.keyframeIntervalMs = 1000;
        relayRoom.run(5);
        assert.deepEqual(relayRoom.relay.modes, ['pass-through']);

        // The link drops to 8 Mbps: the stream has to shrink, so it is encoded.
        link.a = 1_000_000;
        relayRoom.run(20, () => relayRoom.relay.modes.length > 1);
        assert.equal(relayRoom.relay.modes.length, 2);
        assert.ok(Math.abs(relayRoom.relay.modes[1] - 5600) <= 80, `cut to ${relayRoom.relay.modes[1]}`);

        // The link recovers; the relay climbs back and, at the top, goes back to
        // passing the stream through.
        link.a = 20_000_000;
        relayRoom.run(600, () => relayRoom.relay.modes.at(-1) === 'pass-through');
        assert.equal(relayRoom.relay.modes.at(-1), 'pass-through');
        assert.equal(relayRoom.room.fallbackBitrate.currentKbps, 14000);
        const climb = relayRoom.relay.modes.slice(2, -1);
        assert.ok(climb.length >= 3 && climb.every((kbps, index) => index === 0 || kbps > climb[index - 1]), `climb ${climb}`);
    } finally {
        relayRoom.close();
    }
});
