// @ts-check

const APP_NAME = 'Nextra';

const ROUTE_TITLES = {
    '': 'Self-hosted screen sharing',
    '#how-to': 'How to Use',
    '#host': 'Host',
    '#watch': 'Watch',
    '#status': 'Server Status',
    '#privacy': 'Privacy',
    '#copyright': 'Copyright / Contact',
};

/**
 * Name of the page a hash route renders. Watch keeps one name across
 * `#watch` and `#watch/CODE` so a room code never leaks into the tab title.
 * @param {string} route
 * @returns {string}
 */
export function routeName(route) {
    const hash = String(route || '');
    if (hash === '' || hash === '#') return ROUTE_TITLES[''];
    if (hash.startsWith('#watch')) return ROUTE_TITLES['#watch'];
    return ROUTE_TITLES[hash] || 'Page not found';
}

/**
 * Document title for a hash route.
 * @param {string} route
 * @returns {string}
 */
export function routeTitle(route) {
    const name = routeName(route);
    return name === ROUTE_TITLES[''] ? `${APP_NAME} — ${name}` : `${name} · ${APP_NAME}`;
}
