import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function identify(page: Page, suffix: string, theme: "light" | "dark" = "light") {
  await page.addInitScript(({ id, selectedTheme }) => {
    localStorage.setItem("ipw-actor-id", id);
    localStorage.setItem("ipw-actor-name", "Alex Morgan");
    localStorage.setItem("ipw-theme", selectedTheme);
    sessionStorage.setItem("ipw-bootstrap-key", `bootstrap-${id}`);
  }, { id: `actor-${suffix}`, selectedTheme: theme });
}

async function openWorkspace(page: Page, suffix: string, theme: "light" | "dark" = "light") {
  await identify(page, suffix, theme);
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
}

test("real API onboarding, project creation, and Default Files journey", async ({ page }) => {
  await openWorkspace(page, "journey");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Retail launch");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Retail launch" })).toBeVisible();
  await page.getByRole("link", { name: "Files" }).first().click();
  await expect(page.getByRole("heading", { name: "Default Files" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No files yet" })).toBeVisible();
});

test("loading, access-denied, and API error states are customer-safe", async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route("**/v1/session/bootstrap", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "access-denied", message: "You do not have access to this workspace" } }),
    });
  });
  await identify(page, "denied");
  await page.goto("/");
  await expect(page.getByText("Opening your workspace...")).toBeVisible();
  release?.();
  await expect(page.getByRole("heading", { name: "Workspace access denied" })).toBeVisible();
  await expect(page.getByText("You do not have access to this workspace")).toBeVisible();
});

for (const route of ["home", "projects", "files"] as const) {
  test(`${route} journey has no detectable accessibility violations`, async ({ page }) => {
    await openWorkspace(page, `axe-${route}`);
    if (route !== "home") await page.getByRole("link", { name: route === "projects" ? "Projects" : "Files" }).first().click();
    await expect(page.locator("main")).not.toHaveAttribute("aria-busy", "true");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}

test("phone navigation remains operable without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, "phone-nav");
  await page.getByTitle("Open navigation").click();
  await expect(page.locator(".sidebar.open")).toBeVisible();
  await page.getByRole("link", { name: "Projects" }).last().click();
  await expect(page.getByTestId("projects-page")).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
});

const visualCases = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone", width: 390, height: 844 },
] as const;

for (const viewport of visualCases) {
  for (const theme of ["light", "dark"] as const) {
    test(`@visual ${viewport.name} ${theme} workspace home`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openWorkspace(page, `visual-${viewport.name}-${theme}`, theme);
      await expect(page).toHaveScreenshot(`workspace-home-${viewport.width}x${viewport.height}-${theme}.png`, {
        animations: "disabled",
        caret: "hide",
        scale: "css",
        maxDiffPixelRatio: 0,
      });
    });
  }
}
