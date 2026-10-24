'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    classifyTrackedFile,
    classifyTrackedPath,
    findDependencyLicenseViolations,
    parseTrackedFileList,
    scanTrackedFiles,
} = require('../scripts/opensource-preflight');

function lockfileWith(packages) {
    return {
        lockfileVersion: 3,
        packages: {
            '': { name: 'fixture', license: 'GPL-3.0-only' },
            ...packages,
        },
    };
}

test('production dependency licenses must be present and reviewed', () => {
    const violations = findDependencyLicenseViolations(lockfileWith({
        'node_modules/allowed': { license: 'MIT' },
        'node_modules/missing': {},
        'node_modules/unreviewed': { license: 'GPL-2.0-only' },
        'node_modules/dev-only': { dev: true },
    }), 'fixture-lock.json');

    assert.deepEqual(violations, [
        'Missing production dependency license in fixture-lock.json: missing',
        'Unreviewed production dependency license in fixture-lock.json: unreviewed (GPL-2.0-only)',
    ]);
});

test('nested production packages retain their scoped name in failures', () => {
    const violations = findDependencyLicenseViolations(lockfileWith({
        'node_modules/parent/node_modules/@scope/child': { license: 'UNKNOWN' },
    }), 'nested-lock.json');

    assert.deepEqual(violations, [
        'Unreviewed production dependency license in nested-lock.json: @scope/child (UNKNOWN)',
    ]);
});

test('invalid lockfile structure fails closed', () => {
    assert.deepEqual(findDependencyLicenseViolations({}, 'broken-lock.json'), [
        'Invalid package lock structure: broken-lock.json',
    ]);
});

// Built at run time so this file does not itself look like a hardcoded key to the scan.
const FAKE_AWS_KEY = `AKIA${'ABCDEFGH'}${'IJKLMNOP'}`;

function withTempDir(prefix, callback) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    try {
        return callback(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function writeTree(root, files) {
    for (const [relPath, content] of Object.entries(files)) {
        const absPath = path.join(root, ...relPath.split('/'));
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content);
    }
}

test('the env rule matches .env files at any depth and exempts .env.example by basename', () => {
    for (const forbidden of [
        '.env',
        '.env.local',
        'poc-mediasoup/.env',
        'server/.env.production',
        'config/.env.local',
        'a/b/c/.env.staging',
        'config\\.env.local',
        'sub/.ENV',
    ]) {
        assert.notEqual(classifyTrackedPath(forbidden), 'allowed', `${forbidden} should be forbidden`);
    }

    for (const allowed of [
        '.env.example',
        'poc-mediasoup/.env.example',
        'docs/guides/.env.example',
        'config\\.env.example',
        'docs/env.md',
        'src/.environment.js',
        'tools/.envrc',
        'src/dotenv/index.js',
    ]) {
        assert.equal(classifyTrackedPath(allowed), 'allowed', `${allowed} should be allowed`);
    }
});

test('the path rules that existed before still match what they matched', () => {
    assert.equal(classifyTrackedPath('certs/server.key'), 'forbidden-file');
    assert.equal(classifyTrackedPath('Nextra.exe'), 'forbidden-file');
    assert.equal(classifyTrackedPath('.env.production'), 'forbidden-file');
    assert.equal(classifyTrackedPath('tools/certs/dev.pem'), 'forbidden-pattern');
    assert.equal(classifyTrackedPath('dist/Nextra-macos-arm64'), 'forbidden-pattern');
    assert.equal(classifyTrackedPath('bin/ffmpeg.exe'), 'forbidden-pattern');
    assert.equal(classifyTrackedPath('bin/cloudflared'), 'forbidden-pattern');
    assert.equal(classifyTrackedPath('certs/README.md'), 'allowed');
    assert.equal(classifyTrackedPath('src/App.jsx'), 'allowed');
});

test('the git ls-files -z parser splits on NUL, drops empty entries and keeps names exact', () => {
    const names = ['src/a.js', 'café/crème.txt', ' leading.txt', 'trailing.txt ', 'new\nline.txt', 'two  spaces.txt'];
    const output = `${names.join('\0')}\0`;

    assert.deepEqual(parseTrackedFileList(output), names);
    assert.deepEqual(parseTrackedFileList(Buffer.from(output, 'utf8')), names);
    assert.deepEqual(parseTrackedFileList(`${names[0]}\0\0${names[1]}\0`), [names[0], names[1]]);
    assert.deepEqual(parseTrackedFileList(''), []);
});

test('classifyTrackedFile tells text, binary, directory and unreadable apart', () => {
    withTempDir('nextra-oss-classify-', (dir) => {
        writeTree(dir, {
            'plain.txt': 'hello\n',
            'with-nul.bin': Buffer.concat([Buffer.from('head'), Buffer.from([0]), Buffer.from(FAKE_AWS_KEY)]),
            'folder/inner.txt': 'x',
            'file-in-the-way': 'x',
        });

        const text = classifyTrackedFile(path.join(dir, 'plain.txt'));
        assert.equal(text.kind, 'text');
        assert.equal(text.text, 'hello\n');

        assert.equal(classifyTrackedFile(path.join(dir, 'with-nul.bin')).kind, 'binary');
        assert.equal(classifyTrackedFile(path.join(dir, 'folder')).kind, 'directory');

        const missing = classifyTrackedFile(path.join(dir, 'missing.txt'));
        assert.equal(missing.kind, 'unreadable');
        assert.equal(missing.code, 'ENOENT');

        const underFile = classifyTrackedFile(path.join(dir, 'file-in-the-way', 'child.txt'));
        assert.equal(underFile.kind, 'unreadable');
        assert.match(underFile.code, /^E[A-Z]+$/);
    });
});

test('scanTrackedFiles reports nested .env files and skips only the .env.example templates', () => {
    withTempDir('nextra-oss-env-', (dir) => {
        const files = {
            '.env.example': 'PORT=3000\n',
            'poc-mediasoup/.env': 'TOKEN=abc\n',
            'poc-mediasoup/.env.example': 'TOKEN=\n',
            'server/.env.production': 'TOKEN=abc\n',
            'config/.env.local': 'TOKEN=abc\n',
            'src/app.js': 'module.exports = 1;\n',
        };
        writeTree(dir, files);

        assert.deepEqual(scanTrackedFiles(Object.keys(files), dir), [
            'Forbidden tracked path pattern: poc-mediasoup/.env',
            'Forbidden tracked path pattern: server/.env.production',
            'Forbidden tracked path pattern: config/.env.local',
        ]);
    });
});

test('scanTrackedFiles scans a non-ASCII filename read back from a NUL-separated listing', () => {
    withTempDir('nextra-oss-unicode-', (dir) => {
        const secretName = 'café/clés été.txt';
        writeTree(dir, {
            [secretName]: `key = ${FAKE_AWS_KEY}\n`,
            'ok.txt': 'nothing here\n',
        });

        const listing = `${secretName}\0ok.txt\0`;
        assert.deepEqual(scanTrackedFiles(parseTrackedFileList(listing), dir), [
            `Hardcoded AWS key pattern found in tracked file: ${secretName}`,
        ]);
    });
});

test('scanTrackedFiles fails closed on a tracked path it cannot read', () => {
    withTempDir('nextra-oss-unreadable-', (dir) => {
        writeTree(dir, { 'present.txt': 'fine\n', 'file-in-the-way': 'x' });

        const violations = scanTrackedFiles(['present.txt', 'gone.txt', 'file-in-the-way/child.txt'], dir);

        assert.equal(violations.length, 2);
        assert.equal(violations[0], 'Cannot read tracked file: gone.txt (ENOENT)');
        assert.match(violations[1], /^Cannot read tracked file: file-in-the-way\/child\.txt \(E[A-Z]+\)$/);
    });
});

test('scanTrackedFiles skips binary files and directories without a violation', () => {
    withTempDir('nextra-oss-skip-', (dir) => {
        writeTree(dir, {
            'asset.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(FAKE_AWS_KEY)]),
            'vendor/submodule/readme.txt': 'a gitlink checks out as a directory\n',
        });

        assert.deepEqual(scanTrackedFiles(['asset.bin', 'vendor/submodule'], dir), []);
    });
});

test('scanTrackedFiles keeps reporting tracked content that matches a sensitive pattern', () => {
    withTempDir('nextra-oss-content-', (dir) => {
        writeTree(dir, { 'notes.txt': `aws ${FAKE_AWS_KEY}\n` });

        assert.deepEqual(scanTrackedFiles(['notes.txt'], dir), [
            'Hardcoded AWS key pattern found in tracked file: notes.txt',
        ]);
    });
});

// The tests below run a copy of the script against a throwaway git repository, so they
// exercise main(), the real `git ls-files` call and Git's own quoting of unusual names.
const scriptSource = path.join(__dirname, '..', 'scripts', 'opensource-preflight.js');
const emptyLockfile = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'fixture' } } });

function cleanGitEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    for (const name of Object.keys(env)) {
        if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX)$/.test(name)) delete env[name];
    }
    return env;
}

function runPreflightInTempRepo(files, { initGit = true } = {}) {
    return withTempDir('nextra-oss-repo-', (dir) => {
        writeTree(dir, {
            'package-lock.json': emptyLockfile,
            'poc-mediasoup/package-lock.json': emptyLockfile,
            ...files,
        });
        fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
        fs.copyFileSync(scriptSource, path.join(dir, 'scripts', 'opensource-preflight.js'));

        const env = cleanGitEnv({ GIT_CEILING_DIRECTORIES: path.dirname(dir) });
        if (initGit) {
            const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
            git('init', '-q');
            git('add', '-A');
        }

        const result = spawnSync(process.execPath, ['scripts/opensource-preflight.js'], {
            cwd: dir,
            env,
            encoding: 'utf8',
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    });
}

test('the script fails on a tracked nested .env file and passes on a nested .env.example', () => {
    const blocked = runPreflightInTempRepo({
        'poc-mediasoup/.env': 'METRICS_TOKEN=do-not-publish\n',
        'poc-mediasoup/.env.example': 'METRICS_TOKEN=\n',
    });

    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stderr, /\[oss:check\] FAILED/);
    assert.match(blocked.stderr, /Forbidden tracked path pattern: poc-mediasoup\/\.env\r?\n/);
    assert.doesNotMatch(blocked.stderr, /\.env\.example/);

    const allowed = runPreflightInTempRepo({ 'poc-mediasoup/.env.example': 'METRICS_TOKEN=\n' });
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.match(allowed.stdout, /\[oss:check\] OK/);
});

test('the script scans a tracked file whose name Git would quote', () => {
    const result = runPreflightInTempRepo({
        'café/clé.txt': `key = ${FAKE_AWS_KEY}\n`,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(
        result.stderr.includes('Hardcoded AWS key pattern found in tracked file: café/clé.txt'),
        result.stderr,
    );
    assert.doesNotMatch(result.stderr, /Cannot read tracked file/);
});

test('the script still fails with the same message outside a git repository', () => {
    const result = runPreflightInTempRepo({}, { initGit: false });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\[oss:check\] FAILED\. This command must be run from a git repository root\./);
});
