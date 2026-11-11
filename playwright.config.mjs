import { defineConfig, devices } from '@playwright/test';

// The server under test listens on one HTTPS port and one RTC port range. The
// defaults are what a lone run uses. Worktrees that run the browser tests at the
// same time each set their own with NEXTRA_E2E_PORT, NEXTRA_E2E_RTC_MIN_PORT
// and NEXTRA_E2E_RTC_MAX_PORT; the specs read the port back from the baseURL
// below, so nothing else names it.
function portFromEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error(`${name} must be a port number from 1 to 65535, got "${raw}".`);
    }
    return value;
}

const port = portFromEnv('NEXTRA_E2E_PORT', 3210);
const rtcMinPort = portFromEnv('NEXTRA_E2E_RTC_MIN_PORT', 42100);
const rtcMaxPort = portFromEnv('NEXTRA_E2E_RTC_MAX_PORT', 42199);
if (rtcMinPort > rtcMaxPort) {
    throw new Error(`NEXTRA_E2E_RTC_MIN_PORT (${rtcMinPort}) is above NEXTRA_E2E_RTC_MAX_PORT (${rtcMaxPort}).`);
}

export default defineConfig({
    testDir: './tests/browser',
    timeout: 60_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: `https://127.0.0.1:${port}`,
        ignoreHTTPSErrors: true,
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {
                    args: [
                        '--autoplay-policy=no-user-gesture-required',
                        '--host-resolver-rules=MAP nextra.cloudflare.test 127.0.0.1',
                    ],
                },
            },
        },
        {
            // Backs the mobile Chrome viewer row of the README support table.
            // Media flows stay on the desktop project, which joins from an
            // emulated mobile context for the decoded-frame evidence.
            name: 'mobile-chrome',
            testMatch: /ui-semantics\.spec\.mjs/,
            use: {
                ...devices['Pixel 5'],
                launchOptions: {
                    args: [
                        '--autoplay-policy=no-user-gesture-required',
                        '--host-resolver-rules=MAP nextra.cloudflare.test 127.0.0.1',
                    ],
                },
            },
        },
    ],
    webServer: {
        command: 'npm run build && node server.js',
        url: `https://127.0.0.1:${port}/readyz`,
        ignoreHTTPSErrors: true,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            BIND_HOST: '127.0.0.1',
            LOCAL_HTTPS: 'true',
            OPEN_BROWSER: 'false',
            AUTO_PUBLIC_TUNNEL: 'false',
            SHARE_BASE_URL: `https://nextra.cloudflare.test:${port}`,
            WHIP_ENABLED: 'false',
            WHEP_ENABLED: 'false',
            RTC_LISTEN_IP: '127.0.0.1',
            RTC_MIN_PORT: String(rtcMinPort),
            RTC_MAX_PORT: String(rtcMaxPort),
        },
    },
});
