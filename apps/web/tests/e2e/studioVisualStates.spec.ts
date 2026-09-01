import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_SCHEMA_VERSION, type ProcessingJobRecord } from "ipw-contracts-ts/product";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const screenshotOptions = { animations: "disabled", caret: "hide", scale: "css", maxDiffPixelRatio: 0 } as const;

async function identify(page: Page, suffix: string, theme: "light" | "dark") {
  const actorId = `actor-studio-state-${suffix}`;
  await page.addInitScript(({ id, selectedTheme }) => {
    localStorage.setItem("ipw-theme", selectedTheme);
    sessionStorage.setItem("ipw-bootstrap-key", `bootstrap-${id}`);
  }, { id: actorId, selectedTheme: theme });
  const response = await page.request.post("/v1/auth/developer-session", {
    data: { actor_id: actorId, display_name: "Alex Morgan" },
  });
  expect(response.ok()).toBe(true);
}

async function openWorkspace(page: Page, suffix: string, theme: "light" | "dark") {
  await identify(page, suffix, theme);
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  return new URL(page.url()).pathname.split("/")[2]!;
}

async function createBlank(page: Page, workspaceId: string, name: string) {
  await page.goto(`/w/${workspaceId}/studio/new`);
  await page.getByLabel("Graphic name").fill(name);
  await page.getByRole("button", { name: "Create graphic" }).click();
  await expect(page.getByTestId("image-graphic-studio")).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/")[4]!;
}

async function assertCanvasPainted(page: Page) {
  const canvas = page.locator(".lower-canvas");
  await expect(canvas).toBeVisible();
  const stats = await canvas.evaluate((element: HTMLCanvasElement) => {
    const data = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    let painted = 0;
    const colours = new Set<string>();
    for (let index = 0; index < data.length; index += 64) {
      if (data[index + 3]) painted += 1;
      colours.add(`${data[index]}:${data[index + 1]}:${data[index + 2]}:${data[index + 3]}`);
    }
    return { painted, colours: colours.size };
  });
  expect(stats.painted).toBeGreaterThan(100);
  expect(stats.colours).toBeGreaterThan(1);
}

async function shot(page: Page, name: string, canvas = true) {
  await expect(page.locator("body")).not.toContainText(/recovery/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (canvas) await assertCanvasPainted(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page).toHaveScreenshot(name, screenshotOptions);
}

async function uploadFixture(page: Page) {
  await page.getByRole("button", { name: "Upload" }).first().click();
  await page.locator('input[type="file"]').setInputFiles(resolve(repoRoot, "data/fixtures/images/synthetic-alpha-32.png"));
  await page.getByRole("button", { name: /Upload 1 file/ }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 20_000 });
  await page.locator(".upload-actions").getByRole("button", { name: "Close", exact: true }).click();
}

for (const theme of ["light", "dark"] as const) {
  test(`@visual @studio-state semantic and responsive evidence ${theme}`, async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const workspaceId = await openWorkspace(page, `semantic-${theme}`, theme);
    const documentId = await createBlank(page, workspaceId, `Studio evidence ${theme}`);

    await shot(page, `studio-state-blank-1440x900-${theme}.png`);

    await page.getByRole("button", { name: "Text", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Properties" }).click();
    await shot(page, `studio-state-selected-text-1440x900-${theme}.png`);

    await page.getByRole("tab", { name: "All Tools" }).click();
    await page.getByRole("button", { name: /Vector path Add an editable internal path/ }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Properties" }).click();
    await shot(page, `studio-state-selected-vector-1440x900-${theme}.png`);

    await page.getByRole("button", { name: "Artboard", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Shape", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Artboards" }).click();
    await shot(page, `studio-state-multiple-artboards-1440x900-${theme}.png`);

    await page.getByRole("button", { name: "Shape", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Layers" }).click();
    await shot(page, `studio-state-layers-panel-1440x900-${theme}.png`);
    const shapeRows = page.locator(".layer-row").filter({ hasText: "Rectangle" });
    await expect(shapeRows).toHaveCount(2);
    await shapeRows.nth(0).getByRole("checkbox").check();
    await shapeRows.nth(1).getByRole("checkbox").check();
    await page.getByRole("tab", { name: "All Tools" }).click();
    await page.getByRole("button", { name: /Group 2 marked layers/ }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Layers" }).click();
    await shot(page, `studio-state-group-transform-1440x900-${theme}.png`);

    await page.getByRole("tab", { name: "History" }).click();
    await page.getByLabel("Version name").fill("Reviewed layout");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Reviewed layout")).toBeVisible();
    await shot(page, `studio-state-history-versions-1440x900-${theme}.png`);

    const panel = page.locator('[data-panel-id="conversation"]');
    await panel.getByRole("button", { name: "Panel position" }).click();
    await page.getByRole("menuitem", { name: "Detach panel" }).click();
    const header = panel.locator(".panel-window-header");
    const headerBox = await header.boundingBox();
    await page.mouse.move(headerBox!.x + 36, headerBox!.y + 18);
    await page.mouse.down();
    await page.mouse.move(headerBox!.x + 110, headerBox!.y + 70, { steps: 5 });
    await page.mouse.up();
    const resize = panel.getByRole("button", { name: "Resize panel" });
    const resizeBox = await resize.boundingBox();
    await page.mouse.move(resizeBox!.x + 8, resizeBox!.y + 8);
    await page.mouse.down();
    await page.mouse.move(resizeBox!.x + 60, resizeBox!.y + 45, { steps: 5 });
    await page.mouse.up();
    await shot(page, `studio-state-floating-panel-1440x900-${theme}.png`);

    await page.getByTitle("Reset workspace").click();
    await page.getByRole("button", { name: "Back to Home" }).click();
    await uploadFixture(page);
    await page.goto(`/w/${workspaceId}/files`);
    await page.locator(".file-card").filter({ hasText: "synthetic-alpha-32.png" }).getByRole("button", { name: "Create in Studio" }).click();
    await page.getByLabel("Graphic name").fill(`Imported raster evidence ${theme}`);
    await page.getByRole("button", { name: "Create graphic" }).click();
    await expect(page.getByTestId("image-graphic-studio")).toBeVisible();
    await page.getByRole("tab", { name: "Layers" }).click();
    await page.locator(".layer-row").filter({ hasText: "synthetic-alpha-32.png" }).getByRole("button", { name: "synthetic-alpha-32.png Raster" }).click();
    await page.getByRole("tab", { name: "Properties" }).click();
    await shot(page, `studio-state-imported-raster-1440x900-${theme}.png`);
    const beforeAdjustment = await page.locator(".lower-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    await page.locator("fieldset").filter({ hasText: "Quick correction" }).getByRole("slider").fill("35");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect.poll(() => page.locator(".lower-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(beforeAdjustment);
    await shot(page, `studio-state-raster-adjustments-1440x900-${theme}.png`);
    const beforeMask = await page.locator(".lower-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    await page.getByRole("button", { name: "Add editable mask" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect.poll(() => page.locator(".lower-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(beforeMask);
    await shot(page, `studio-state-rendered-mask-1440x900-${theme}.png`);

    await page.getByTitle("Reset workspace").click();
    for (const viewport of [{ width: 768, height: 1024, label: "tablet" }, { width: 638, height: 768, label: "intermediate" }, { width: 390, height: 844, label: "phone-review" }]) {
      await page.setViewportSize(viewport);
      const canvasButton = page.getByRole("button", { name: "Canvas", exact: true });
      if (await canvasButton.isVisible()) await canvasButton.click();
      await shot(page, `studio-state-${viewport.label}-${viewport.width}x${viewport.height}-${theme}.png`);
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(documentId).toBeTruthy();
  });

  test(`@visual @studio-state lease and save recovery evidence ${theme}`, async ({ page, context }) => {
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const workspaceId = await openWorkspace(page, `lifecycle-${theme}`, theme);
    const documentId = await createBlank(page, workspaceId, `Lifecycle evidence ${theme}`);
    const documentUrl = page.url();

    const viewer = await context.newPage();
    await viewer.setViewportSize({ width: 1440, height: 900 });
    await viewer.goto(documentUrl);
    await expect(viewer.getByText("View only", { exact: true })).toBeVisible();
    await shot(viewer, `studio-state-read-only-lease-1440x900-${theme}.png`);
    await viewer.close();

    const leaseToken = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith("ipw-editor-lease:"))?.[1]);
    const leaseStatus = await page.request.get(`/v1/workspaces/${workspaceId}/documents/${documentId}/lease`, {
      headers: { "x-editor-lease": leaseToken! },
    }).then((response) => response.json()) as Record<string, any>;
    await page.route(`**/v1/workspaces/${workspaceId}/documents/${documentId}/lease`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ json: { ...leaseStatus, status: { ...leaseStatus.status, takeoverRequest: {
        actorId: "actor-visual-requester", actorDisplayName: "Jordan Lee", reason: "Continue the reviewed layout", requestedAt: "2026-09-01T09:30:00.000Z",
      } } } });
    });
    await expect(page.getByText("Jordan Lee requested editing access")).toBeVisible({ timeout: 15_000 });
    await shot(page, `studio-state-takeover-request-1440x900-${theme}.png`);
    await page.unroute(`**/v1/workspaces/${workspaceId}/documents/${documentId}/lease`);
    await page.reload();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(page.getByText("Jordan Lee requested editing access")).toHaveCount(0);

    let releaseSave!: () => void;
    const delayedSave = new Promise<void>((resolveDelay) => { releaseSave = resolveDelay; });
    await page.route(`**/v1/workspaces/${workspaceId}/documents/${documentId}`, async (route) => {
      if (route.request().method() === "PATCH") { await delayedSave; }
      await route.continue();
    });
    await page.getByRole("button", { name: "Shape", exact: true }).click();
    await expect(page.getByText("Saving...", { exact: true })).toBeVisible();
    await shot(page, `studio-state-saving-1440x900-${theme}.png`);
    releaseSave();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.unroute(`**/v1/workspaces/${workspaceId}/documents/${documentId}`);

    await page.route(`**/v1/workspaces/${workspaceId}/documents/${documentId}`, async (route) => {
      if (route.request().method() === "PATCH") await route.abort("failed");
      else await route.continue();
    });
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await expect(page.getByText("Save failed", { exact: true })).toBeVisible();
    await shot(page, `studio-state-failed-save-1440x900-${theme}.png`);
    await page.unroute(`**/v1/workspaces/${workspaceId}/documents/${documentId}`);
    await page.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await context.setOffline(true);
    await page.getByRole("button", { name: "Shape", exact: true }).click();
    await expect(page.getByText("Offline - changes not saved", { exact: true })).toBeVisible();
    await shot(page, `studio-state-offline-pending-1440x900-${theme}.png`);
    await context.setOffline(false);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test(`@visual @studio-state large preview lifecycle evidence ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const workspaceId = await openWorkspace(page, `preview-${theme}`, theme);
    const documentId = await createBlank(page, workspaceId, `Preview evidence ${theme}`);
    const documentUrl = `/v1/workspaces/${workspaceId}/documents/${documentId}`;
    const original = await page.request.get(documentUrl).then((response) => response.json()) as Record<string, any>;
    let state: "preparing" | "failed" = "preparing";
    let progress = 0;
    await page.route(`**${documentUrl}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const body = structuredClone(original);
      body.editor.document.preview_state = state;
      body.editor.document.preview_job_id = "job-visual-preview";
      body.editor.document.current_preview_id = null;
      await route.fulfill({ json: body });
    });
    await page.route("**/v1/jobs/job-visual-preview**", async (route) => {
      const job: ProcessingJobRecord = {
        schema_version: PRODUCT_SCHEMA_VERSION, job_id: "job-visual-preview", kind: "preview_generation",
        owner_kind: "actor", workspace_id: workspaceId, actor_id: `actor-studio-state-preview-${theme}`,
        guest_session_id: null, upload_session_id: null, document_id: documentId,
        state: state === "preparing" ? "running" : "failed", attempt: 1, max_attempts: 3,
        progress_percent: progress, lease_owner: null, lease_expires_at: null, heartbeat_at: null, next_attempt_at: null,
        failure: state === "failed" ? { schema_version: PRODUCT_SCHEMA_VERSION, code: "preview-temporary-failure", message: "Preview renderer was unavailable", retryable: true } : null,
        created_at: "2026-09-01T09:30:00.000Z", updated_at: "2026-09-01T09:30:01.000Z",
      };
      await route.fulfill({ json: { schema_version: PRODUCT_SCHEMA_VERSION, job, command: { replayed: false } } });
    });

    await page.reload();
    await expect(page.getByTestId("preview-preparing")).toBeVisible();
    await shot(page, `studio-state-preview-preparing-1440x900-${theme}.png`, false);
    progress = 70;
    await page.reload();
    await expect(page.getByText("70% complete.")).toBeVisible();
    await shot(page, `studio-state-preview-progress-1440x900-${theme}.png`, false);
    state = "failed";
    await page.reload();
    await expect(page.getByTestId("preview-failed")).toBeVisible();
    await shot(page, `studio-state-preview-failure-1440x900-${theme}.png`, false);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
