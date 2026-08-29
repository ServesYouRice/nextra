// lib/https.js - Auto-generate and cache a self-signed TLS certificate
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { X509Certificate } = require('crypto');
const config = require('../config');

// Regenerate slightly before expiry so a long-running process never serves a
// certificate that lapses while it is up.
const CERT_RENEWAL_MARGIN_MS = 24 * 60 * 60 * 1000;
// selfsigned ignores its `days` option, so the lifetime is set explicitly via
// notAfterDate instead of relying on the library default.
const CERT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

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

function shouldRegenerateExistingCert(certPem, keyPem) {
    let cert;
    try {
        cert = new X509Certificate(certPem);
        tls.createSecureContext({ cert: certPem, key: keyPem });
    } catch {
        return true;
    }

    const validFrom = Date.parse(cert.validFrom);
    const validTo = Date.parse(cert.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
        return true;
    }
    const now = Date.now();
    if (now < validFrom || now >= validTo - CERT_RENEWAL_MARGIN_MS) {
        return true;
    }

    if (cert.checkHost('localhost', { subject: 'never' }) !== 'localhost') {
        return true;
    }
    if (cert.checkIP('127.0.0.1') !== '127.0.0.1') {
        return true;
    }

    const subjectAltName = cert.subjectAltName || '';
    const ipMatches = [...subjectAltName.matchAll(/IP Address:([0-9.]+)/g)]
        .map((match) => match[1]);

    if (config.HTTPS_INCLUDE_LAN_IP_IN_CERT) {
        if (!config.LAN_IP || config.LAN_IP === '127.0.0.1') return false;
        return cert.checkIP(config.LAN_IP) !== config.LAN_IP;
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
        if (!shouldRegenerateExistingCert(cert, key)) {
            console.log('Loading existing TLS certificate from', certDir);
            return { cert, key };
        }

        console.warn('Existing TLS certificate is expired or no longer matches security settings. Regenerating...');
    }

    console.log('Generating self-signed TLS certificate...');
    const selfsigned = require('selfsigned');
    const attrs = [{ name: 'commonName', value: 'Nextra' }];

    const notBefore = new Date();
    const pems = await selfsigned.generate(attrs, {
        keySize: 2048,
        notBeforeDate: notBefore,
        notAfterDate: new Date(notBefore.getTime() + CERT_LIFETIME_MS),
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
