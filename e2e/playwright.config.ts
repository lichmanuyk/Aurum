import { defineConfig } from "@playwright/test";

// Points at the throwaway stack run.sh brings up (see README) — never the
// user's real self-hosted instance, so tests can freely create/delete data.
const baseURL = process.env.AURUM_E2E_BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // tests share one backend/DB and assert on exact totals — no isolation between them
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: "aurum:noAuthAcknowledged", value: "1" }] }] },
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
