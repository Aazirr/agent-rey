import { defineConfig, devices } from '@playwright/test';

/**
 * The daemon is started by the test file itself rather than by `webServer` here,
 * because each run needs a fresh state directory and a scratch project root, and
 * the test asserts on the daemon's own behaviour (login throttling, replay) as
 * well as the UI's.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices['Pixel 7'],
    // A phone-shaped viewport is the point; a desktop default would hide exactly
    // the layout problems this UI has to get right.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
