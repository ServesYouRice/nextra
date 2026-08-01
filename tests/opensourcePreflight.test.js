'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { findDependencyLicenseViolations } = require('../scripts/opensource-preflight');

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
