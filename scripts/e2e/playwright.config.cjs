// The end-to-end cases (#545): `pnpm e2e` runs them all, `pnpm e2e -g "slideshow"` the ones
// whose names match. Build first: `pnpm build && cargo build -p mrs-cli`.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.cjs',
  outputDir: '../../e2e-results',
  // The dev surface draws the wind, the traffic and the lights in software here, so a case is given time.
  timeout: 240_000,
  expect: { timeout: 30_000 },
  // Every case has its own host and table, so cases run side by side; each one in a file runs in order.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 2,
  fullyParallel: true,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    browserName: 'chromium',
    // A step that waits names what it was waiting for, rather than running out the case's time.
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
});
