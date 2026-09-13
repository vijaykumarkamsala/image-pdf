import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("native PDF creation, page editing, truthful preflight and durable export", async ({ page }) => {
  const actorId = "actor-native-pdf-e2e";
  await page.addInitScript((id) => {
    sessionStorage.setItem("ipw-bootstrap-key", `bootstrap-${id}`);
  }, actorId);
  const identity = await page.request.post("/v1/auth/developer-session", {
    data: { actor_id: actorId, display_name: "PDF creator" },
  });
  expect(identity.ok()).toBe(true);

  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByRole("link", { name: /Create PDF/ }).click();
  await expect(page.getByTestId("pdf-start")).toBeVisible();
  await page.getByLabel("Letter").check();
  await page.getByLabel("Landscape").check();
  await page.getByLabel("PDF name").fill("Customer brief");
  await page.getByRole("button", { name: "Create PDF", exact: true }).click();

  await expect(page.getByTestId("pdf-studio")).toBeVisible();
  await expect(page.getByText("1 page", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Page", exact: true }).click();
  await expect(page.getByText("2 pages", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Pages" }).click();
  await page.getByRole("button", { name: "Move Page 2 up" }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Preflight and export PDF" }).click();
  const exportCenter = page.getByTestId("pdf-export-center");
  await expect(exportCenter).toBeVisible();
  await expect(exportCenter.getByText("Ready", { exact: true })).toBeVisible();
  await expect(exportCenter.getByText(/untagged and is not PDF\/A/)).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include("[data-testid=pdf-export-center]").analyze();
  expect(accessibility.violations).toEqual([]);

  await exportCenter.getByRole("button", { name: "Export Screen PDF" }).click();
  await expect(exportCenter.getByText("queued", { exact: true })).toBeVisible();
  await exportCenter.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(exportCenter.getByText("cancelled", { exact: true })).toBeVisible();
});
