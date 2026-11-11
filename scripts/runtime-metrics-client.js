'use strict';

const http = require('node:http');
const https = require('node:https');

// Builds a /api/metrics fetcher for the runtime benchmark. Certificate checks
// are controlled per request (rejectUnauthorized), never through the
// process-wide NODE_TLS_REJECT_UNAUTHORIZED setting.
function createMetricsFetcher({ baseUrl, allowInsecureTls = false, token = '' }) {
    const target = new URL('/api/metrics?resetEventLoopDelay=true', baseUrl);
    const transport = target.protocol === 'https:' ? https : http;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const options = target.protocol === 'https:' ? { rejectUnauthorized: !allowInsecureTls } : {};

    return function fetchMetrics() {
        return new Promise((resolve, reject) => {
            const request = transport.request(target, { method: 'GET', headers, ...options }, (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('error', reject);
                response.on('end', () => {
                    const status = response.statusCode;
                    if (status < 200 || status > 299) {
                        reject(new Error(`/api/metrics returned ${status}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (err) {
                        reject(err);
                    }
                });
            });
            request.on('error', reject);
            request.end();
        });
    };
}

module.exports = { createMetricsFetcher };
