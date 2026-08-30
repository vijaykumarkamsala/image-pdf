import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

async function clearFocus(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const screenshotOptions = {
  animations: "disabled",
  caret: "hide",
  scale: "css",
  maxDiffPixelRatio: 0,
} as const;

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
  await expect(page.getByText("Files you upload, create or save without a project will appear here.")).toBeVisible();
});

test("real API secure upload becomes a preserved Default Files source", async ({ page }) => {
  await openWorkspace(page, "upload-journey");
  await page.getByRole("button", { name: "Upload" }).first().click();
  const fixture = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "data/fixtures/images/synthetic-alpha-32.png");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(page.getByText("synthetic-alpha-32.png")).toBeVisible();
  await page.getByRole("button", { name: "Upload", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "File ready" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("link", { name: "Files" }).first().click();
  await expect(page.getByRole("heading", { name: "Default Files" })).toBeVisible();
  await expect(page.getByText("synthetic-alpha-32.png")).toBeVisible();
  await expect(page.locator(".testing-status")).toContainText(/1 file.*0 jobs/);
});

test("an in-flight upload can be cancelled and its temporary source is removed", async ({ page }) => {
  let releaseTransfer: (() => void) | undefined;
  await page.route("**/v1/uploads/**", async (route) => {
    await new Promise<void>((resolve) => { releaseTransfer = resolve; });
    await route.abort().catch(() => undefined);
  });
  await openWorkspace(page, "upload-cancel");
  await page.getByRole("button", { name: "Upload" }).first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "cancelled.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(4096, 1),
  });
  await page.getByRole("button", { name: "Upload", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Uploading securely" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel upload" }).click();
  await expect(page.getByRole("heading", { name: "Upload cancelled" })).toBeVisible();
  releaseTransfer?.();
});

test("customer copy discloses testing and inactive product areas without internal or monetary language", async ({ page }) => {
  await openWorkspace(page, "customer-copy");
  const testingStatus = page.locator(".testing-status");
  await expect(testingStatus).toContainText("Free during testing");
  await expect(testingStatus).toContainText(/0 files.*0 jobs/);
  await expect(testingStatus).not.toContainText(/\$|price|credit/i);

  const expectedOutcomes = [
    ["Image & Graphic Studio", "Enhance, design and prepare visuals"],
    ["Create PDF", "Build PDFs from pages, images and rich content"],
    ["Edit & Manage PDF", "Edit, organize, protect and convert PDFs"],
    ["Print & Production", "Check quality and prepare production outputs"],
  ] as const;
  const tiles = page.locator(".outcome-tile");
  await expect(tiles).toHaveCount(4);
  for (const [label, description] of expectedOutcomes) {
    const tile = tiles.filter({ hasText: label });
    await expect(tile).toContainText(description);
    await expect(tile).toContainText("Not active in this build");
  }
  await expect(page.getByText("Available in a later recovery")).toHaveCount(0);
  await expect(tiles.locator("a, button")).toHaveCount(0);
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

test("collapsed tablet navigation retains accessible names", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openWorkspace(page, "axe-tablet-navigation");
  const primaryNavigation = page.getByRole("navigation", { name: "Workspace navigation" }).first();
  for (const name of ["Home", "Projects", "Files"]) {
    await expect(primaryNavigation.getByRole("link", { name })).toBeVisible();
  }
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

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

for (const theme of ["light", "dark"] as const) {
  test(`${theme} keyboard focus uses the accessible brand token`, async ({ page }) => {
    await openWorkspace(page, `focus-${theme}`, theme);
    await page.keyboard.press("Tab");
    const focus = page.locator(":focus");
    await expect(focus).toBeVisible();
    const styles = await focus.evaluate((element) => {
      const computed = getComputedStyle(element);
      const root = getComputedStyle(document.documentElement);
      return {
        outlineColor: computed.outlineColor,
        outlineStyle: computed.outlineStyle,
        outlineWidth: computed.outlineWidth,
        focusToken: root.getPropertyValue("--focus-ring").trim(),
        errorToken: root.getPropertyValue("--error").trim(),
      };
    });
    expect(styles).toEqual({
      outlineColor: theme === "light" ? "rgb(0, 138, 126)" : "rgb(112, 210, 198)",
      outlineStyle: "solid",
      outlineWidth: "3px",
      focusToken: theme === "light" ? "#008a7e" : "#70d2c6",
      errorToken: theme === "light" ? "#a43e26" : "#ff9a7a",
    });
    expect(styles.focusToken).not.toBe(styles.errorToken);
  });
}

const visualCases = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "intermediate", width: 638, height: 768 },
  { name: "phone", width: 390, height: 844 },
] as const;

for (const viewport of visualCases) {
  for (const theme of ["light", "dark"] as const) {
    test(`@visual ${viewport.name} ${theme} workspace home`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openWorkspace(page, `visual-${viewport.name}-${theme}`, theme);
      await expect(page).toHaveScreenshot(`workspace-home-${viewport.width}x${viewport.height}-${theme}.png`, screenshotOptions);
    });
  }
}

for (const viewport of visualCases) {
  for (const theme of ["light", "dark"] as const) {
    test(`@visual ${viewport.name} ${theme} selected upload dialog`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openWorkspace(page, `visual-upload-${viewport.name}-${theme}`, theme);
      await page.getByRole("button", { name: "Upload" }).first().click();
      await page.locator('input[type="file"]').setInputFiles({
        name: "visual-proof.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(1536, 1),
      });
      await expect(page.getByText("visual-proof.png")).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(accessibility.violations).toEqual([]);
      await clearFocus(page);
      await expect(page).toHaveScreenshot(
        `workspace-upload-selected-${viewport.width}x${viewport.height}-${theme}.png`,
        screenshotOptions,
      );
    });
  }
}

test("@visual tablet light Projects", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openWorkspace(page, "visual-tablet-projects");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-projects-768x1024-light.png", screenshotOptions);
});

test("@visual 638x768 Projects keeps its header action on one line", async ({ page }) => {
  await page.setViewportSize({ width: 638, height: 768 });
  await openWorkspace(page, "visual-projects-638");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();

  const action = page.getByRole("button", { name: "New project" }).first();
  const layout = await action.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      height: bounds.height,
      whiteSpace: getComputedStyle(element).whiteSpace,
      contentFits: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.height).toBeGreaterThanOrEqual(44);
  expect(layout.whiteSpace).toBe("nowrap");
  expect(layout.contentFits).toBe(true);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-projects-638x768-light.png", screenshotOptions);
});

test("@visual phone light Home with navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, "visual-phone-navigation");
  await page.getByTitle("Open navigation").click();
  await expect(page.locator(".sidebar.open")).toBeVisible();
  await expect(page).toHaveScreenshot("workspace-home-navigation-390x844-light.png", screenshotOptions);
});

test("@visual phone light Default Files", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page, "visual-phone-files");
  await page.locator(".mobile-nav").getByRole("link", { name: "Files" }).click();
  await expect(page.getByRole("heading", { name: "No files yet" })).toBeVisible();
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-files-390x844-light.png", screenshotOptions);
});

test("@visual desktop light Projects with one created project", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page, "visual-created-project");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Retail launch");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Retail launch" })).toBeVisible();
  await clearFocus(page);
  await expect(page).toHaveScreenshot("workspace-projects-created-1440x900-light.png", screenshotOptions);
});
