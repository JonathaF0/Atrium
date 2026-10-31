import { test, expect } from "@playwright/test";

test.describe("Portal", () => {
  test("portal home shows the client dashboard", async ({ page }) => {
    await page.goto("/portal");
    await expect(page).toHaveURL(/\/portal$/, { timeout: 10000 });
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible({ timeout: 15000 });
  });

  test("portal projects page has header with navigation", async ({ page }) => {
    await page.goto("/portal/projects");
    await expect(page).toHaveURL(/\/portal\/projects/, { timeout: 10000 });
    await expect(page.locator("header").getByRole("link", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.getByText(/projects/i).first()).toBeVisible();
  });
});
