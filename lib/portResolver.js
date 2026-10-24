'use strict';

const net = require('net');

const MAX_PORT = 65535;

function isPortUnavailableError(err) {
    return err?.code === 'EADDRINUSE' || err?.code === 'EACCES';
}

function canListenOnPort({ port, host }) {
    return new Promise((resolve, reject) => {
        const tester = net.createServer();

        const cleanup = () => {
            tester.removeAllListeners('error');
            tester.removeAllListeners('listening');
        };

        tester.unref();
        tester.once('error', (err) => {
            cleanup();
            if (isPortUnavailableError(err)) {
                resolve(false);
                return;
            }
            reject(err);
        });

        tester.once('listening', () => {
            tester.close((err) => {
                cleanup();
                if (err) {
                    reject(err);
                    return;
                }
                resolve(true);
            });
        });

        tester.listen(port, host);
    });
}

async function findAvailablePort({ preferredPort, host, reservedPorts = [], maxAttempts = 25 }) {
    const reserved = new Set(
        Array.from(reservedPorts, (port) => Number.parseInt(port, 10))
            .filter((port) => Number.isFinite(port) && port > 0)
    );

    let candidate = Number.parseInt(preferredPort, 10);
    if (!Number.isFinite(candidate) || candidate <= 0 || candidate > MAX_PORT) {
        throw new Error(`Invalid preferred port: ${preferredPort}`);
    }

    // Candidates stop at the top of the port range: net refuses 65536 with
    // ERR_SOCKET_BAD_PORT, so running out ends with the error below instead.
    for (let attempt = 0; attempt < maxAttempts && candidate <= MAX_PORT; attempt += 1, candidate += 1) {
        if (reserved.has(candidate)) continue;
        if (await canListenOnPort({ port: candidate, host })) {
            return candidate;
        }
    }

    throw new Error(`Could not find an available port starting at ${preferredPort} on ${host}.`);
}

module.exports = {
    canListenOnPort,
    findAvailablePort,
};
