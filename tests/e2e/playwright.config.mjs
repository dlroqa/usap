// Playwright config: tests run against the REAL production build (app/dist)
// served by the REAL scripts/server/serve.cjs. API responses are fixtures
// (support/test.mjs) except in specs/live-backend.spec.mjs.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 14720);
const CI = !!process.env.CI;
// Screenshot baselines are stored per render target (font rasterisation differs by
// OS/CPU): linux-x64 (Playwright container), macos-arm64, macos-x86_64. Local runs use
// "local", which is git-ignored.
const RENDER_TARGET = process.env.RENDER_TARGET || "local";

export default defineConfig({
  testDir: "specs",
  outputDir: "test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  // Never create or rewrite baselines implicitly in CI. Baselines change only via the
  // guarded update mode in render-e2e.yml (see docs/ci/RENDER_TESTS.md).
  updateSnapshots: CI ? "none" : "missing",
  reporter: CI
    ? [["list"], ["junit", { outputFile: "test-results/junit.xml" }], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css", maxDiffPixels: 0, threshold: 0.2 },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: RENDER_TARGET, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } }],
  webServer: {
    command: "node ../../scripts/server/serve.cjs",
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
