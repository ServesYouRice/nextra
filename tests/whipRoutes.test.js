const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { createWhipRouter } = require('../lib/whipRoutes');

function listen(app) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

test('WHIP CORS reflects only trusted browser origins', async () => {
    const app = express();
    app.use('/whip', createWhipRouter({}, {
        isAllowedOrigin: (origin) => origin === 'https://allowed.example',
    }));

    const { server, baseUrl } = await listen(app);
    try {
        const allowed = await fetch(`${baseUrl}/whip/broadcast/ABC123`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://allowed.example' },
        });
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');
        assert.equal(allowed.headers.get('vary'), 'Origin');

        const denied = await fetch(`${baseUrl}/whip/broadcast/ABC123`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://evil.example' },
        });
        assert.equal(denied.status, 204);
        assert.equal(denied.headers.get('access-control-allow-origin'), null);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
