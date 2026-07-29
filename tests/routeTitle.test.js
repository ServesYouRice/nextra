const test = require('node:test');
const assert = require('node:assert/strict');

const routeTitleModule = import('../src/lib/routeTitle.mjs');

test('each hash route gets its own document title', async () => {
    const { routeTitle } = await routeTitleModule;

    assert.equal(routeTitle(''), 'Nextra — Self-hosted screen sharing');
    assert.equal(routeTitle('#'), 'Nextra — Self-hosted screen sharing');
    assert.equal(routeTitle('#host'), 'Host · Nextra');
    assert.equal(routeTitle('#how-to'), 'How to Use · Nextra');
    assert.equal(routeTitle('#status'), 'Server Status · Nextra');
    assert.equal(routeTitle('#privacy'), 'Privacy · Nextra');
    assert.equal(routeTitle('#copyright'), 'Copyright / Contact · Nextra');
});

test('watch links keep one title and never expose the room code', async () => {
    const { routeTitle, routeName } = await routeTitleModule;

    assert.equal(routeTitle('#watch'), 'Watch · Nextra');
    assert.equal(routeTitle('#watch/ABC123'), 'Watch · Nextra');
    assert.equal(routeName('#watch/ABC123'), 'Watch');
});

test('an unknown route is titled as not found', async () => {
    const { routeTitle } = await routeTitleModule;

    assert.equal(routeTitle('#nope'), 'Page not found · Nextra');
});
