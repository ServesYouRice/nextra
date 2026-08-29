const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { X509Certificate } = require('crypto');
const selfsigned = require('selfsigned');
const config = require('../config');
const { getOrCreateCert } = require('../lib/https');

async function generateCertFixture(altNames, validity = {}) {
    const attrs = [{ name: 'commonName', value: 'Nextra' }];
    const pems = await selfsigned.generate(attrs, {
        keySize: 2048,
        algorithm: 'sha256',
        ...validity,
        extensions: [
            {
                name: 'subjectAltName',
                altNames,
            },
        ],
    });
    return { cert: pems.cert, key: pems.private };
}

test('regression: certificate with prefix SANs (localhost.example.com, 127.0.0.10) is replaced rather than reused', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = true;
        config.LAN_IP = '127.0.0.10';

        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost.example.com' },
            { type: 7, ip: '127.0.0.10' },
        ]);
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.cert, fixture.cert, 'Expected cert with prefix SANs to be replaced rather than reused');
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('regression: valid certificate paired with mismatched private key is replaced and accepted by tls.createSecureContext', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const fixture1 = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ]);
        const fixture2 = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ]);

        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture1.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture2.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.key, fixture2.key, 'Expected mismatched key to cause regeneration');
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('empty directory generates both files and exact localhost/loopback SANs', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        assert.equal(fs.existsSync(certPath), false);
        assert.equal(fs.existsSync(keyPath), false);

        const result = await getOrCreateCert();
        assert.equal(fs.existsSync(certPath), true);
        assert.equal(fs.existsSync(keyPath), true);
        assert.equal(fs.readFileSync(certPath, 'utf-8'), result.cert);
        assert.equal(fs.readFileSync(keyPath, 'utf-8'), result.key);

        const cert = new X509Certificate(result.cert);
        assert.equal(cert.checkHost('localhost', { subject: 'never' }), 'localhost');
        assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('unparseable certificate PEM regenerates', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ]);
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, 'NOT A VALID CERTIFICATE PEM', 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.cert, 'NOT A VALID CERTIFICATE PEM');
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('unparseable private-key PEM regenerates', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ]);
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, 'NOT A VALID PRIVATE KEY PEM', 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.key, 'NOT A VALID PRIVATE KEY PEM');
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('missing exact DNS:localhost regenerates', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const fixture = await generateCertFixture([
            { type: 7, ip: '127.0.0.1' },
        ]);
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.cert, fixture.cert);
        const cert = new X509Certificate(result.cert);
        assert.equal(cert.checkHost('localhost', { subject: 'never' }), 'localhost');
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('missing exact IP Address:127.0.0.1 regenerates', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
        ]);
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.cert, fixture.cert);
        const cert = new X509Certificate(result.cert);
        assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('LAN inclusion with non-loopback IP regenerates when missing and reuses byte-identically when present', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = true;
        config.LAN_IP = '192.168.1.75';

        // Missing LAN IP -> regenerates
        const missingLanFixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ]);
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, missingLanFixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, missingLanFixture.key, 'utf-8');

        const regenerated = await getOrCreateCert();
        assert.notEqual(regenerated.cert, missingLanFixture.cert);
        const regenCert = new X509Certificate(regenerated.cert);
        assert.equal(regenCert.checkIP('192.168.1.75'), '192.168.1.75');

        // Present LAN IP -> reuses byte-identically
        const matchingFixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '192.168.1.75' },
        ]);
        fs.writeFileSync(certPath, matchingFixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, matchingFixture.key, 'utf-8');

        const reused = await getOrCreateCert();
        assert.equal(reused.cert, matchingFixture.cert);
        assert.equal(reused.key, matchingFixture.key);
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: reused.cert, key: reused.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('LAN inclusion with LAN_IP=127.0.0.1 reuses an exact-valid pair', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = true;
        config.LAN_IP = '127.0.0.1';

        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ]);
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.equal(result.cert, fixture.cert);
        assert.equal(result.key, fixture.key);
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('LAN inclusion disabled regenerates a certificate carrying another IPv4 SAN', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '192.168.1.50' },
        ]);
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.cert, fixture.cert);
        const cert = new X509Certificate(result.cert);
        assert.equal(cert.checkIP('192.168.1.50'), undefined);
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('an exact-valid certificate/key pair is reused byte-identically', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ]);
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.equal(result.cert, fixture.cert);
        assert.equal(result.key, fixture.key);
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('expired certificate regenerates', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const now = Date.now();
        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ], {
            notBeforeDate: new Date(now - 400 * 24 * 60 * 60 * 1000),
            notAfterDate: new Date(now - 24 * 60 * 60 * 1000),
        });
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.cert, fixture.cert, 'Expected expired cert to be replaced rather than reused');
        const cert = new X509Certificate(result.cert);
        assert.equal(Date.parse(cert.validTo) > Date.now(), true);
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('certificate expiring inside the renewal margin regenerates', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const now = Date.now();
        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ], {
            notBeforeDate: new Date(now - 364 * 24 * 60 * 60 * 1000),
            notAfterDate: new Date(now + 60 * 60 * 1000),
        });
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.cert, fixture.cert, 'Expected cert inside the renewal margin to be replaced');
        assert.doesNotThrow(() => {
            tls.createSecureContext({ cert: result.cert, key: result.key });
        });
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('not-yet-valid certificate regenerates', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const now = Date.now();
        const fixture = await generateCertFixture([
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
        ], {
            notBeforeDate: new Date(now + 24 * 60 * 60 * 1000),
            notAfterDate: new Date(now + 400 * 24 * 60 * 60 * 1000),
        });
        const certPath = path.join(tempDir, 'server.crt');
        const keyPath = path.join(tempDir, 'server.key');
        fs.writeFileSync(certPath, fixture.cert, 'utf-8');
        fs.writeFileSync(keyPath, fixture.key, 'utf-8');

        const result = await getOrCreateCert();
        assert.notEqual(result.cert, fixture.cert, 'Expected not-yet-valid cert to be replaced');
        const cert = new X509Certificate(result.cert);
        assert.equal(Date.parse(cert.validFrom) <= Date.now(), true);
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('generated certificate carries an explicit 365-day validity window', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextra-https-test-'));
    const prevCertDir = config.HTTPS_CERT_DIR;
    const prevIncludeLan = config.HTTPS_INCLUDE_LAN_IP_IN_CERT;
    const prevLanIp = config.LAN_IP;

    try {
        config.HTTPS_CERT_DIR = tempDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = false;
        config.LAN_IP = '192.168.1.50';

        const result = await getOrCreateCert();
        const cert = new X509Certificate(result.cert);
        const lifetimeDays = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / (24 * 60 * 60 * 1000);
        assert.equal(Math.round(lifetimeDays), 365);
    } finally {
        config.HTTPS_CERT_DIR = prevCertDir;
        config.HTTPS_INCLUDE_LAN_IP_IN_CERT = prevIncludeLan;
        config.LAN_IP = prevLanIp;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
