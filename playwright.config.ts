import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const chromeExecutable =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    launchOptions: chromeExecutable ? { executablePath: chromeExecutable } : undefined,
    viewport: { width: 1280, height: 720 },
    trace: "retain-on-failure",
  },
});
