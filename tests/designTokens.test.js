const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8');

function rootBlock() {
    const match = css.match(/:root\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, ':root block exists');
    return match[1];
}

// Returns the declarations of the first rule whose selector list is exactly `selector`.
function ruleBody(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `rule ${selector} exists`);
    return match[1];
}

function tokenValue(name) {
    const matches = [...rootBlock().matchAll(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm'))];
    assert.equal(matches.length, 1, `${name} is declared exactly once in :root`);
    return matches[0][1].replace(/\s+/g, ' ').trim();
}

function luminance(hex) {
    const channels = hex.slice(1).match(/../g).map((part) => {
        const value = parseInt(part, 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('--text-3 is the lighter grey and reads at 4.5:1 on every surface', () => {
    assert.equal(tokenValue('--text-3'), '#9494a8');
    for (const surface of ['--bg-0', '--bg-1', '--bg-2', '--bg-3']) {
        const ratio = contrast(tokenValue('--text-3'), tokenValue(surface));
        assert.ok(ratio >= 4.5, `--text-3 on ${surface} is ${ratio.toFixed(2)}:1`);
    }
});

test('every foundation token is declared once in :root', () => {
    const expected = {
        '--surface-button': null,
        '--surface-button-hover': null,
        '--surface-button-quiet': 'linear-gradient(180deg, rgba(35, 36, 46, 0.98), rgba(24, 24, 31, 0.98))',
        '--surface-button-stop': 'radial-gradient(circle at top right, rgba(255, 150, 150, 0.18), transparent 48%), linear-gradient(135deg, rgba(104, 40, 46, 0.98), rgba(150, 52, 58, 0.98))',
        '--surface-button-stop-hover': 'radial-gradient(circle at top right, rgba(255, 160, 160, 0.22), transparent 52%), linear-gradient(135deg, rgba(116, 44, 51, 0.98), rgba(164, 58, 64, 0.98))',
        '--fs-display': 'clamp(1.75rem, 3vw, 2.75rem)',
        '--fs-title': '1.75rem',
        '--fs-heading': '1.25rem',
        '--fs-body': '1rem',
        '--fs-small': '0.875rem',
        '--fs-label': '0.75rem',
        '--space-1': '0.25rem',
        '--space-2': '0.5rem',
        '--space-3': '0.75rem',
        '--space-4': '1rem',
        '--space-6': '1.5rem',
        '--space-8': '2rem',
        '--space-12': '3rem',
        '--radius-pill': '999px',
        '--tap-min': '2.75rem',
    };
    for (const [name, value] of Object.entries(expected)) {
        const actual = tokenValue(name);
        if (value !== null) assert.equal(actual, value, name);
    }
    assert.equal(tokenValue('--radius'), '8px');
    assert.equal(tokenValue('--radius-lg'), '12px');
    assert.equal(tokenValue('--panel-shell-radius'), '18px');
});

test('the button and card gradients are held in tokens with their original values', () => {
    const button = tokenValue('--surface-button');
    assert.ok(button.includes('rgba(130, 167, 255, 0.2)'));
    assert.ok(button.includes('linear-gradient(135deg, rgba(57, 61, 83, 0.98), rgba(73, 82, 122, 0.98))'));
    const hover = tokenValue('--surface-button-hover');
    assert.ok(hover.includes('radial-gradient(circle at top right, rgba(147, 181, 255, 0.24), transparent 52%)'));
    assert.ok(hover.includes('linear-gradient(135deg, rgba(64, 69, 94, 0.98), rgba(82, 94, 138, 0.98))'));
    assert.equal(
        tokenValue('--surface-glass'),
        'linear-gradient(180deg, rgba(35, 36, 46, 0.98), rgba(24, 24, 31, 0.98))',
    );
    assert.equal(
        tokenValue('--surface-glass-accent'),
        'radial-gradient(circle at top right, rgba(91, 141, 239, 0.12), transparent 38%)',
    );
});

test('shared control rules use the tokens named for them', () => {
    assert.match(ruleBody('.btn-primary'), /background:\s*var\(--surface-button\);/);
    assert.match(ruleBody('.btn-primary:hover:not(:disabled)'), /background:\s*var\(--surface-button-hover\);/);
    assert.match(ruleBody('.mode-toggle button.active'), /background:\s*var\(--surface-button\);/);
    assert.match(ruleBody('.btn-secondary'), /background:\s*var\(--surface-button-quiet\);/);
    assert.match(ruleBody('.btn-danger'), /background:\s*var\(--surface-button-stop\);/);
    assert.match(ruleBody('.btn-danger:hover:not(:disabled)'), /background:\s*var\(--surface-button-stop-hover\);/);
    assert.match(ruleBody('.btn-danger-quiet'), /background:\s*var\(--surface-button-quiet\);/);
    assert.match(ruleBody('.btn-main'), /font-size:\s*var\(--fs-body\);/);
    for (const selector of ['.stat-card', '.article-step']) {
        assert.match(ruleBody(selector), /background:\s*var\(--surface-glass-accent\),\s*var\(--surface-glass\);/, selector);
    }
});

test('the danger button draws its edge with an inset shadow, not a border', () => {
    const body = ruleBody('.btn-danger');
    assert.doesNotMatch(body, /(^|\s)border\s*:/);
    assert.match(body, /inset 0 0 0 1px rgba\(255, 160, 160, 0\.28\)/);
});

test('select and input text is left-aligned', () => {
    assert.doesNotMatch(ruleBody('.select-input'), /center/);
});

test('the focus ring and the reduced-motion rule stay', () => {
    assert.match(ruleBody(':focus-visible'), /outline:\s*2px solid var\(--accent\);/);
    assert.match(ruleBody(':focus-visible'), /outline-offset:\s*2px;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration:\s*0\.01ms !important;/);
});

// Every declaration of `property` in the stylesheet, with the selector it sits in.
function declarations(property) {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = [];
    const stack = [];
    let prelude = '';
    let body = '';
    for (const char of source) {
        if (char === '{') {
            stack.push(prelude.trim());
            prelude = '';
            body = '';
        } else if (char === '}') {
            stack.pop();
            prelude = '';
            body = '';
        } else if (char === ';') {
            const match = body.match(new RegExp(`^\\s*${property}\\s*:\\s*([^]*)$`));
            if (match) found.push({ selector: stack[stack.length - 1], value: match[1].trim() });
            body = '';
        } else {
            prelude += char;
            body += char;
        }
    }
    return found;
}

function describe(offenders) {
    return offenders.map(({ selector, value }) => `${selector} { ${value} }`).join('\n');
}

test('every font-size uses a text token', () => {
    const allowed = /^(var\(--fs-(display|title|heading|body|small|label)\)|inherit|-?[\d.]+em|var\(--brand-mark-height,[^]*\))$/;
    const offenders = declarations('font-size').filter(({ value }) => !allowed.test(value));
    assert.equal(offenders.length, 0, `${offenders.length} font-size values are off the scale:\n${describe(offenders)}`);
});

test('every border-radius uses a corner token', () => {
    const allowed = /^(var\(--radius\)|var\(--radius-lg\)|var\(--panel-shell-radius\)|var\(--radius-pill\)|50%|inherit|0)$/;
    const offenders = declarations('border-radius').filter(({ value }) => !allowed.test(value));
    assert.equal(offenders.length, 0, `${offenders.length} border-radius values are off the scale:\n${describe(offenders)}`);
});

test('--radius-xl is not declared or used', () => {
    assert.ok(!css.includes('--radius-xl'), '--radius-xl still appears in src/index.css');
});
