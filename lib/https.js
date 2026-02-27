// lib/https.js - Auto-generate and cache a self-signed TLS certificate
const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const config = require('../config');

function getDesiredAltNames() {
    const altNames = [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
    ];

    if (config.HTTPS_INCLUDE_LAN_IP_IN_CERT && config.LAN_IP && config.LAN_IP !== '127.0.0.1') {
        altNames.push({ type: 7, ip: config.LAN_IP });
    }

    return altNames;
}

function shouldRegenerateExistingCert(certPem) {
    let subjectAltName = '';
    try {
        const cert = new X509Certificate(certPem);
        subjectAltName = cert.subjectAltName || '';
    } catch {
        return true;
    }

    if (!subjectAltName.includes('DNS:localhost')) return true;
    if (!subjectAltName.includes('IP Address:127.0.0.1')) return true;

    const ipMatches = [...subjectAltName.matchAll(/IP Address:([0-9.]+)/g)]
        .map((match) => match[1]);

    if (config.HTTPS_INCLUDE_LAN_IP_IN_CERT) {
        if (!config.LAN_IP || config.LAN_IP === '127.0.0.1') return false;
        return !ipMatches.includes(config.LAN_IP);
    }

    return ipMatches.some((ip) => ip !== '127.0.0.1');
}

/**
 * Returns { cert, key } by loading from disk if present, otherwise
 * generating a self-signed certificate and persisting it.
 */
async function getOrCreateCert() {
    const certDir = config.HTTPS_CERT_DIR;
    const certPath = path.join(certDir, 'server.crt');
    const keyPath = path.join(certDir, 'server.key');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        const cert = fs.readFileSync(certPath, 'utf-8');
        const key = fs.readFileSync(keyPath, 'utf-8');
        if (!shouldRegenerateExistingCert(cert)) {
            console.log('Loading existing TLS certificate from', certDir);
            return { cert, key };
        }

        console.warn('Existing TLS certificate SAN no longer matches security settings. Regenerating...');
    }

    console.log('Generating self-signed TLS certificate...');
    const selfsigned = require('selfsigned');
    const attrs = [{ name: 'commonName', value: 'Nextra' }];

    const pems = await selfsigned.generate(attrs, {
        keySize: 2048,
        days: 365,
        algorithm: 'sha256',
        extensions: [
            {
                name: 'subjectAltName',
                altNames: getDesiredAltNames(),
            },
        ],
    });

    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(certPath, pems.cert, { encoding: 'utf-8', mode: 0o644 });
    fs.writeFileSync(keyPath, pems.private, { encoding: 'utf-8', mode: 0o600 });
    console.log('TLS certificate saved to', certDir);

    return { cert: pems.cert, key: pems.private };
}

module.exports = { getOrCreateCert };
