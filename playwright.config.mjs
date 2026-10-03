import { defineConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const uiPort = 5174;
const apiPort = 4319;
const baseURL = `http://127.0.0.1:${uiPort}`;
const serverLogDirectory = path.join(os.tmpdir(), "repolens-e2e-server-logs");
mkdirSync(serverLogDirectory, { recursive: true });
const serverLogPath = path.join(serverLogDirectory, `${process.pid}-${Date.now()}.log`);
process.env.REPOLENS_E2E_SERVER_LOG = serverLogPath;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["./e2e/startup-evidence-reporter.mjs"]],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node scripts/with-local-service.mjs scripts/run-framework.mjs dev --port ${uiPort}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      REPOLENS_PORT: String(apiPort),
      REPOLENS_UI_PORT: String(uiPort),
      VINEXT_NO_DEV_LOCK: "1",
      NEXT_PUBLIC_REPOLENS_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      REPOLENS_SERVER_LOG: serverLogPath,
    },
  },
});
