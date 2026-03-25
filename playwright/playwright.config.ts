import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ["blob", { outputDir: "blob-report" }],
    ["html", { open: "never" }],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? "https://www.evite.com",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
