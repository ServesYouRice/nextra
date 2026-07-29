import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.NEXTRA_PACKAGED_BASE_URL;
if (!baseURL) throw new Error('NEXTRA_PACKAGED_BASE_URL is required.');

export default defineConfig({
    testDir: './tests/browser',
    testMatch: 'packaged-media.packaged.mjs',
    timeout: 60_000,
    expect: { timeout: 15_000 },
    reporter: 'list',
    use: {
        baseURL,
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
    },
    projects: [{
        name: 'chromium',
        use: {
            ...devices['Desktop Chrome'],
            launchOptions: {
                args: ['--autoplay-policy=no-user-gesture-required'],
            },
        },
    }],
});
