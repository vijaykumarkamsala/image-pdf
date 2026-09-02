import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const screenshotOptions = { animations: "disabled", caret: "hide", scale: "css", maxDiffPixelRatio: 0 } as const;

async function identify(page: Page, suffix: string, theme: "light" | "dark") {
  const actorId = `actor-enhancement-${suffix}`;
  await page.addInitScript(({ id, selectedTheme }) => {
    localStorage.setItem("ipw-theme", selectedTheme);
    sessionStorage.setItem("ipw-bootstrap-key", `bootstrap-${id}`);
  }, { id: actorId, selectedTheme: theme });
  const response = await page.request.post("/v1/auth/developer-session", { data: { actor_id: actorId, display_name: "Alex Morgan" } });
  expect(response.ok()).toBe(true);
}

async function openWorkspace(page: Page, suffix: string, theme: "light" | "dark") {
  await identify(page, suffix, theme);
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  return new URL(page.url()).pathname.split("/")[2]!;
}

async function createImportedImage(page: Page, workspaceId: string, name: string) {
  await page.getByRole("button", { name: "Upload" }).first().click();
  await page.locator('input[type="file"]').setInputFiles(resolve(repoRoot, "data/fixtures/images/synthetic-alpha-32.png"));
  await page.getByRole("button", { name: /Upload 1 file/ }).click();
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 20_000 });
  await page.locator(".upload-actions").getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(`/w/${workspaceId}/files`);
  await page.locator(".file-card").filter({ hasText: "synthetic-alpha-32.png" }).getByRole("button", { name: "Create in Studio" }).click();
  await page.getByLabel("Graphic name").fill(name);
  await page.getByRole("button", { name: "Create graphic" }).click();
  await expect(page.getByTestId("image-graphic-studio")).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/")[4]!;
}

async function mockRecommendations(page: Page, workspaceId: string, documentId: string) {
  await page.route(`**/v1/workspaces/${workspaceId}/documents/${documentId}/recommendations`, async (route) => {
    const body = route.request().postDataJSON() as { document_version_id: string; intended_outcome?: string | null };
    await route.fulfill({ json: {
      schema_version: PRODUCT_SCHEMA_VERSION,
      replayed: false,
      recommendation_set: {
        schema_version: PRODUCT_SCHEMA_VERSION,
        recommendation_set_id: "recommendations-visual-2e",
        workspace_id: workspaceId,
        document_id: documentId,
        document_version_id: body.document_version_id,
        intended_outcome: body.intended_outcome ?? null,
        intended_outcome_required: true,
        source_facts_summary: ["Verified source: 32 x 32 px, PNG with transparency.", "Private metadata categories were detected during safe intake."],
        recommendations: [
          {
            recommendation_id: "recommendation-contrast",
            title: "Gently improve contrast",
            explanation: "A conservative contrast adjustment can improve separation without inventing detail.",
            evidence: [{ kind: "heuristic", explanation: "The decoded preview has a narrow middle-tone range." }],
            target_kind: "processing_operation",
            operation: { operation_id: "recommended-contrast", kind: "contrast", order: 0, enabled: true, parameters: { amount: 12 } },
            metadata_policy: null,
            state: "proposed",
          },
          {
            recommendation_id: "recommendation-metadata",
            title: "Remove private metadata on export",
            explanation: "The original remains untouched while derivatives omit location and embedded thumbnails.",
            evidence: [{ kind: "measured", explanation: "Intake detected metadata that is not required for the image pixels." }],
            target_kind: "metadata_policy",
            operation: null,
            metadata_policy: { preserve_copyright: true, preserve_description: false, preserve_capture_time: false, preserve_camera: false, preserve_location: false, remove_embedded_thumbnails: true },
            state: "proposed",
          },
          {
            recommendation_id: "recommendation-size",
            title: "Review the output size",
            explanation: "Larger output uses standard resampling and does not recreate detail.",
            evidence: [{ kind: "measured", explanation: "The verified source contains 1,024 pixels." }],
            target_kind: "output_warning",
            operation: null,
            metadata_policy: null,
            state: "proposed",
          },
        ],
        no_correction_needed: false,
        created_at: "2026-09-02T09:00:00.000Z",
      },
    } });
  });
}

async function shot(page: Page, name: string) {
  await expect(page.locator("body")).not.toContainText(/recovery/i);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page).toHaveScreenshot(name, screenshotOptions);
}

async function assertNewTargets(page: Page, selector: string) {
  const undersized = await page.locator(selector).evaluateAll((elements) => elements.filter((element) => {
    const node = element as HTMLElement;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
  }).map((element) => ({ label: element.getAttribute("aria-label") || element.textContent?.trim(), rect: (element as HTMLElement).getBoundingClientRect().toJSON() })));
  expect(undersized).toEqual([]);
}

test("@visual Recovery 2E enhancement, comparison, export and recovery states", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspaceId = await openWorkspace(page, "desktop-light", "light");
  const documentId = await createImportedImage(page, workspaceId, "Campaign image enhancement");
  await mockRecommendations(page, workspaceId, documentId);

  await page.getByRole("tab", { name: "Enhance" }).click();
  await expect(page.getByText("Gently improve contrast")).toBeVisible();
  await shot(page, "enhancement-recommendations-1440x900-light.png");
  await assertNewTargets(page, ".enhancement-workspace button, .enhancement-workspace select, .enhancement-workspace input[type=range]");

  await page.getByRole("button", { name: "Apply selected for review" }).click();
  await expect(page.getByText("Recommended corrections added for review")).toBeVisible();
  await page.getByLabel("Correction to add").selectOption("curves");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".operation-card").filter({ hasText: "Curves" }).locator("summary").click();
  await shot(page, "enhancement-advanced-controls-1440x900-light.png");

  await page.getByRole("button", { name: "Split view" }).click();
  await expect(page.getByTestId("comparison-workspace")).toHaveAttribute("data-mode", "split");
  await shot(page, "enhancement-comparison-split-1440x900-light.png");
  await page.getByTestId("comparison-workspace").getByRole("button", { name: "Side by side" }).click();
  await expect(page.getByTestId("comparison-workspace")).toHaveAttribute("data-mode", "side_by_side");
  await expect(page.getByRole("img", { name: "RGB histogram for the interactive preview" })).toBeVisible();
  await shot(page, "enhancement-comparison-side-by-side-1440x900-light.png");
  await page.getByRole("button", { name: "Close comparison" }).click();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByTestId("export-center")).toBeVisible();
  await page.locator(".export-preset-grid").getByRole("button", { name: /Email/ }).click();
  await page.locator(".export-profile").first().getByText("Colour, metadata and naming").click();
  await shot(page, "export-center-multi-output-metadata-1440x900-light.png");
  await assertNewTargets(page, ".export-center button:not([disabled]), .export-center select, .export-center input[type=range], .export-center a");

  await page.getByRole("button", { name: "Export 2 outputs" }).click();
  await expect(page.locator(".export-monitor")).toHaveAttribute("data-export-state", "queued");
  await shot(page, "export-active-1440x900-light.png");

  const list = await page.request.get(`/v1/workspaces/${workspaceId}/exports?document_id=${documentId}`).then((response) => response.json()) as { exports: any[] };
  const submitted = list.exports[0]!;
  const partial = {
    ...submitted,
    state: "partially_completed",
    outputs: submitted.outputs.map((output: any, index: number) => index === 0 ? {
      ...output, state: "succeeded", progress_percent: 100, object_reference_id: "object-output-web", sha256: "a".repeat(64), byte_size: 18420, width: 1600, height: 1600, media_type: "image/webp", completed_at: "2026-09-02T09:05:00.000Z",
    } : {
      ...output, state: "failed", progress_percent: 64, failure_code: "encoder-resource-limit", failure_message: "This output exceeded its bounded encoder memory limit.",
    }),
  };
  let statusFixture = partial;
  await page.route(`**/v1/workspaces/${workspaceId}/exports/${submitted.export_request_id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { schema_version: PRODUCT_SCHEMA_VERSION, export_request: statusFixture } });
  });
  await expect(page.locator(".export-monitor")).toHaveAttribute("data-export-state", "partially_completed", { timeout: 8_000 });
  await shot(page, "export-partial-failure-retry-1440x900-light.png");

  await page.route(`**/v1/workspaces/${workspaceId}/exports/${submitted.export_request_id}/retry`, async (route) => {
    await route.fulfill({ json: { schema_version: PRODUCT_SCHEMA_VERSION, replayed: false, export_request: { ...partial, state: "running", outputs: partial.outputs.map((output: any) => output.state === "failed" ? { ...output, state: "queued", progress_percent: 0, failure_code: null, failure_message: null } : output) } } });
  });
  await page.getByRole("button", { name: "Retry failed only" }).click();
  statusFixture = {
    ...partial,
    state: "completed",
    outputs: partial.outputs.map((output: any, index: number) => ({ ...output, state: "succeeded", progress_percent: 100, failure_code: null, failure_message: null, object_reference_id: `object-output-${index}`, sha256: `${index + 1}`.repeat(64), byte_size: 18420 + index * 2300, width: index ? 1200 : 1600, height: index ? 1200 : 1600, media_type: index ? "image/jpeg" : "image/webp", completed_at: "2026-09-02T09:06:00.000Z" })),
  };
  await expect(page.locator(".export-monitor")).toHaveAttribute("data-export-state", "completed", { timeout: 8_000 });
  await page.route(`**/v1/workspaces/${workspaceId}/exports/${submitted.export_request_id}/bundles`, async (route) => route.fulfill({ json: { schema_version: PRODUCT_SCHEMA_VERSION, replayed: false, bundle: bundleFixture(workspaceId, submitted.export_request_id, "queued") } }));
  await page.route(`**/v1/workspaces/${workspaceId}/export-bundles/bundle-visual-2e`, async (route) => route.fulfill({ json: { schema_version: PRODUCT_SCHEMA_VERSION, bundle: bundleFixture(workspaceId, submitted.export_request_id, "succeeded") } }));
  await page.getByRole("button", { name: "Create ZIP of completed" }).click();
  await expect(page.getByRole("link", { name: "Download ZIP" })).toBeVisible({ timeout: 8_000 });
  await shot(page, "export-completed-results-1440x900-light.png");

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("@visual Recovery 2E dark and responsive review/export states", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspaceId = await openWorkspace(page, "responsive-dark", "dark");
  const documentId = await createImportedImage(page, workspaceId, "Responsive image review");
  await mockRecommendations(page, workspaceId, documentId);
  await page.getByRole("tab", { name: "Enhance" }).click();
  await expect(page.getByText("Gently improve contrast")).toBeVisible();
  await shot(page, "enhancement-recommendations-1440x900-dark.png");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await shot(page, "export-center-1440x900-dark.png");
  await page.getByRole("button", { name: "Close", exact: true }).click();

  for (const viewport of [
    { width: 768, height: 1024, label: "tablet" },
    { width: 638, height: 768, label: "intermediate" },
    { width: 390, height: 844, label: "phone" },
  ]) {
    await page.setViewportSize(viewport);
    const tools = page.getByRole("button", { name: "Tools", exact: true });
    if (await tools.isVisible()) await tools.click();
    await page.getByRole("tab", { name: "Enhance" }).click();
    await expect(page.getByTestId("enhancement-workspace")).toBeVisible();
    await shot(page, `enhancement-review-${viewport.label}-${viewport.width}x${viewport.height}-dark.png`);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByTestId("export-center")).toBeVisible();
    await shot(page, `export-center-${viewport.label}-${viewport.width}x${viewport.height}-dark.png`);
    await page.getByRole("button", { name: "Close", exact: true }).click();
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

function bundleFixture(workspaceId: string, exportRequestId: string, state: "queued" | "succeeded") {
  return {
    bundle_id: "bundle-visual-2e", workspace_id: workspaceId, export_request_id: exportRequestId,
    job_id: "job-bundle-visual-2e", state,
    items: [{ output_id: "output-one", filename: "campaign-web.webp", sha256: "a".repeat(64), byte_size: 18420, media_type: "image/webp" }, { output_id: "output-two", filename: "campaign-email.jpg", sha256: "b".repeat(64), byte_size: 20720, media_type: "image/jpeg" }],
    object_reference_id: state === "succeeded" ? "object-bundle-visual-2e" : null,
    sha256: state === "succeeded" ? "c".repeat(64) : null,
    byte_size: state === "succeeded" ? 40120 : null,
    expires_at: "2026-09-09T09:00:00.000Z", created_at: "2026-09-02T09:07:00.000Z",
  };
}
