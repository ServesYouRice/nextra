'use strict';

// Ports for tests that start the real server (server.js) in a child process.
//
// server.js cannot take port 0: config.PORT also builds the allowed origins, and
// the shared mediasoup WebRtcServer binds RTC_MIN_PORT over UDP and TCP. So the
// test chooses both ports and the child binds them a second or two later. Taking
// them from a released port-0 listener was unsafe:
// - port 0 hands out ports from the OS dynamic range, where Windows keeps
//   UDP-only exclusion blocks (Hyper-V, WinNAT): a port free over TCP then fails
//   the WebRtcServer's UDP bind with "permission denied";
// - a released dynamic port can go to any other socket on the machine (another
//   test file, another checkout's suite, any program) before the child binds it.
//
// So each server gets a pair from a range below every OS's dynamic range (Linux's
// starts at 32768, Windows' and macOS's at 49152), which the OS never hands to a
// port-0 bind or an outgoing connection, and the pair is claimed before it is
// checked: this process binds a UDP socket on the HTTP port (the server uses that
// port over TCP only) and keeps it until the process exits. Any other caller, in
// this run or in another checkout's run at the same time, cannot bind the claim
// and tries another pair; the OS drops the claim when this process ends. The RTC
// port is the odd port beside it, so it is never anyone's claim.

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');

const HOST = '127.0.0.1';
const FIRST_PORT = 20000;
const END_PORT = 32000;
const PAIR_COUNT = (END_PORT - FIRST_PORT) / 2;
const MAX_ATTEMPTS = 200;

const heldClaims = [];

function isPortUnavailable(err) {
    return err?.code === 'EADDRINUSE' || err?.code === 'EACCES';
}

function bindUdp(port) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', (err) => {
            try { socket.close(); } catch {}
            if (isPortUnavailable(err)) resolve(null);
            else reject(err);
        });
        socket.bind(port, HOST, () => {
            socket.removeAllListeners('error');
            socket.on('error', () => {});
            resolve(socket);
        });
    });
}

function closeUdp(socket) {
    return new Promise((resolve) => socket.close(() => resolve()));
}

async function isUdpFree(port) {
    const socket = await bindUdp(port);
    if (!socket) return false;
    await closeUdp(socket);
    return true;
}

function isTcpFree(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (isPortUnavailable(err)) resolve(false);
            else reject(err);
        });
        server.listen(port, HOST, () => server.close(() => resolve(true)));
    });
}

/**
 * Claims the ports for one server.js child on 127.0.0.1: `port` for PORT (TCP), and
 * `rtcPort` for both RTC_MIN_PORT and RTC_MAX_PORT (the WebRtcServer, UDP and TCP).
 * The claim lasts until this test file's process exits.
 * @returns {Promise<{ port: number, rtcPort: number }>}
 */
async function claimServerPorts() {
    const firstPair = crypto.randomInt(PAIR_COUNT);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const port = FIRST_PORT + ((firstPair + attempt) % PAIR_COUNT) * 2;
        const rtcPort = port + 1;
        const claim = await bindUdp(port);
        if (!claim) continue;
        if (await isTcpFree(port) && await isTcpFree(rtcPort) && await isUdpFree(rtcPort)) {
            claim.unref();
            heldClaims.push(claim);
            return { port, rtcPort };
        }
        await closeUdp(claim);
    }
    throw new Error(`no free port pair between ${FIRST_PORT} and ${END_PORT} on ${HOST} after ${MAX_ATTEMPTS} tries`);
}

module.exports = { claimServerPorts };
