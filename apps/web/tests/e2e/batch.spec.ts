import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

async function openWorkspace(page: Page, suffix: string) {
  const actorId = `actor-batch-${suffix}-${randomUUID()}`;
  const bootstrapKey = `batch-bootstrap-${suffix}-${randomUUID().slice(0, 8)}`;
  await page.addInitScript(({ id, key }) => {
    localStorage.setItem("ipw-theme", "light");
    sessionStorage.setItem("ipw-bootstrap-key", key);
  }, { id: actorId, key: bootstrapKey });
  const response = await page.request.post("/v1/auth/developer-session", {
    data: { actor_id: actorId, display_name: "Batch Producer" },
  });
  expect(response.ok()).toBe(true);
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  return new URL(page.url()).pathname.split("/")[2]!;
}

async function createDocument(page: Page, workspaceId: string, name: string, index: number) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name.endsWith("ipw-csrf"));
  expect(csrf, "authenticated browser CSRF cookie").toBeDefined();
  const response = await page.request.post(`/v1/workspaces/${workspaceId}/documents`, {
    headers: { "idempotency-key": `batch-document-${index}`, "x-csrf-token": csrf!.value },
    data: { name, width: 640, height: 360, intended_use: "digital" },
  });
  if (!response.ok()) throw new Error(`Document creation failed (${response.status()}): ${await response.text()}`);
}

async function routeSuccessfulPreviews(page: Page, workspaceId: string) {
  let sequence = 0;
  await page.route(`**/v1/workspaces/${workspaceId}/documents/*/enhancement-previews`, async (route) => {
    sequence += 1;
    const documentId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const body = route.request().postDataJSON() as { recipe_id: string; recipe_version: number; artboard_id: string; mode: "current" };
    await route.fulfill({ json: {
      schema_version: PRODUCT_SCHEMA_VERSION,
      preview: {
        schema_version: PRODUCT_SCHEMA_VERSION,
        preview_id: `batch-preview-${sequence}`,
        document_id: documentId,
        document_version_id: `batch-version-${sequence}`,
        recipe_id: body.recipe_id,
        recipe_version: body.recipe_version,
        mode: body.mode,
        state: "succeeded",
        export_request_id: `batch-preview-export-${sequence}`,
        output_id: `batch-preview-output-${sequence}`,
        artboard_id: body.artboard_id,
        proxy: false,
        authoritative: true,
        quality_label: "Authoritative representative preview",
        width: 1200,
        height: 900,
        histogram: null,
        object_reference_id: `batch-preview-object-${sequence}`,
        sha256: "a".repeat(64),
        byte_size: 68,
        media_type: "image/png",
        failure_code: null,
        failure_message: null,
        created_at: "2026-09-12T08:00:00.000Z",
      },
      replayed: false,
    } });
  });
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.route(`**/v1/workspaces/${workspaceId}/export-outputs/batch-preview-output-*/download`, (route) => route.fulfill({
    contentType: "image/png",
    body: pixel,
  }));
}

async function reachReview(page: Page, suffix: string) {
  const workspaceId = await openWorkspace(page, suffix);
  await createDocument(page, workspaceId, "Campaign hero", 1);
  await createDocument(page, workspaceId, "Campaign detail", 2);
  await routeSuccessfulPreviews(page, workspaceId);
  await page.goto(`/w/${workspaceId}/files`);
  await page.getByRole("button", { name: "Batch process" }).click();
  await expect(page.getByRole("heading", { name: "Batch processing" })).toBeVisible();
  for (const name of ["Campaign hero", "Campaign detail"]) {
    await page.locator(".batch-document-list label").filter({ hasText: name }).getByRole("checkbox").check();
  }
  await page.getByRole("button", { name: "Create review plan" }).click();
  await expect(page.getByRole("heading", { name: "Review compatible groups" })).toBeVisible();
  await expect(page.getByText("Authoritative representative preview", { exact: false })).toHaveCount(0);
  await page.getByLabel("I reviewed this representative preview").check();
  return workspaceId;
}

test("batch UI reviews representative evidence, survives navigation, cancels pending work and exports a report", async ({ page }) => {
  const workspaceId = await reachReview(page, "journey");
  await expect(page.getByRole("button", { name: "Start 2-file batch" })).toBeEnabled();
  await page.getByRole("button", { name: "Start 2-file batch" }).click();
  await expect(page.getByRole("heading", { name: "Image batch" })).toBeVisible();
  await expect(page.getByText("2 files", { exact: false }).last()).toBeVisible();

  await page.goto(`/w/${workspaceId}/files`);
  await page.getByRole("button", { name: "Batch process" }).click();
  await page.locator(".batch-history button").filter({ hasText: "Image batch" }).first().click();
  await expect(page.getByText("Durable progress continues", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Cancel pending" }).click();
  await expect(page.locator(".batch-state").filter({ hasText: "cancelled" }).first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report" }).click();
  expect((await download).suggestedFilename()).toBe("Image batch-report.json");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("@visual batch review is responsive and visually stable", async ({ page }) => {
  await reachReview(page, "visual");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator(".batch-group-card")).toHaveScreenshot("batch-compatible-group-1280x720-light.png", {
    animations: "disabled",
    caret: "hide",
    scale: "css",
    maxDiffPixelRatio: 0,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await expect(page).toHaveScreenshot("batch-review-phone-390x844-light.png", {
    animations: "disabled",
    caret: "hide",
    scale: "css",
    maxDiffPixelRatio: 0,
  });
});
