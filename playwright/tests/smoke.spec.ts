import { test, expect } from "@playwright/test";

test.describe("Homepage", () => {
  test("loads with page title @smoke", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/.+/); // any non-empty title
  });

  test("body element is present @smoke", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("Navigation", () => {
  test("login path returns a page @smoke", async ({ page }) => {
    const response = await page.goto("/login");
    expect(response?.status()).toBeLessThan(500);
  });

  test("signup path returns a page @smoke", async ({ page }) => {
    const response = await page.goto("/signup");
    expect(response?.status()).toBeLessThan(500);
  });
});
