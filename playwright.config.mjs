import { defineConfig, devices } from '@playwright/test';

const port = 3210;

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
    projects: [{
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
    }],
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
            RTC_MIN_PORT: '42100',
            RTC_MAX_PORT: '42199',
        },
    },
});
