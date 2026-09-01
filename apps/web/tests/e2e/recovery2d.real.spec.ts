import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const python = resolve(repoRoot, ".venv/Scripts/python.exe");
const storageRoot = process.env["IPW_RECOVERY_2D_STORAGE_ROOT"]!;
const databaseUrl = process.env["IPW_TEST_DATABASE_URL"]!;

async function identify(page: Page, actorId: string, displayName: string) {
  await page.addInitScript((id) => {
    localStorage.setItem("ipw-theme", "light");
    sessionStorage.setItem("ipw-bootstrap-key", `bootstrap-${id}`);
  }, actorId);
  const response = await page.request.post("/v1/auth/developer-session", {
    data: { actor_id: actorId, display_name: displayName },
  });
  expect(response.ok()).toBe(true);
}

async function openWorkspace(page: Page, actorId: string, displayName: string) {
  await identify(page, actorId, displayName);
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  return new URL(page.url()).pathname.split("/")[2]!;
}

function runPython(script: string, args: string[] = []) {
  return execFileSync(python, [resolve(repoRoot, script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      IPW_TEST_DATABASE_URL: databaseUrl,
      IPW_LOCAL_STORAGE_ROOT: storageRoot,
    },
  }).trim();
}

function runWorker(jobId: string) {
  return JSON.parse(runPython("tools/run_local_processing_job.py", [jobId])) as {
    job_id: string;
    outbox_id: string;
    kind: string;
    state: string;
  };
}

function grantMember(workspaceId: string, actorId: string, role = "member") {
  return JSON.parse(runPython("tools/recovery_2d_acceptance_probe.py", [
    "grant-member", workspaceId, actorId, "--role", role,
  ]));
}

function evidence(workspaceId: string, documentId: string) {
  return JSON.parse(runPython("tools/recovery_2d_acceptance_probe.py", [
    "evidence", workspaceId, documentId,
  ])) as Record<string, any>;
}

async function uploadAndProcess(page: Page, file: string) {
  await page.getByRole("button", { name: "Upload" }).first().click();
  await page.locator('input[type="file"]').setInputFiles(file);
  const finalisedResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && /\/v1\/upload-sessions\/[^/]+\/finalise$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: /Upload 1 file/ }).click();
  const finalised = await (await finalisedResponse).json() as Record<string, any>;
  const dispatch = runWorker(finalised.job.job_id);
  expect(dispatch).toMatchObject({ job_id: finalised.job.job_id, kind: "file_intake_inspection", state: "succeeded" });
  await expect(page.getByText("File ready")).toBeVisible({ timeout: 30_000 });
  await page.locator(".upload-actions").getByRole("button", { name: "Close", exact: true }).click();
  return { ...finalised, dispatch };
}

async function createFromFile(page: Page, workspaceId: string, displayName: string) {
  await page.goto(`/w/${workspaceId}/files`);
  const card = page.locator(".file-card").filter({ hasText: displayName });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Create in Studio" }).click();
  await expect(page.getByRole("radio", { name: new RegExp(displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })).toHaveAttribute("aria-checked", "true");
  const created = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/v1/workspaces/${workspaceId}/documents`);
  await page.getByRole("button", { name: "Create graphic" }).click();
  return (await created).json() as Promise<Record<string, any>>;
}

async function newPeerPage(browser: Browser) {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:4175",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "Asia/Kolkata",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await identify(page, "actor-recovery-2d-peer", "Jordan Lee");
  return { context, page };
}

test("Recovery 2D real React to PostgreSQL journey", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const workspaceId = await openWorkspace(page, "actor-recovery-2d-owner", "Alex Morgan");

  await page.getByRole("link", { name: "Projects" }).first().click();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Real PostgreSQL campaign");
  await page.getByRole("button", { name: "Create project" }).click();

  await page.goto(`/w/${workspaceId}/studio/new`);
  await page.getByLabel("Graphic name").fill("Durable campaign graphic");
  await page.getByLabel("Location").selectOption({ label: "Real PostgreSQL campaign" });
  await page.getByRole("button", { name: "Create graphic" }).click();
  await expect(page.getByTestId("image-graphic-studio")).toBeVisible();
  const originalDocumentId = new URL(page.url()).pathname.split("/")[4]!;

  await page.route(`**/v1/workspaces/${workspaceId}/documents/${originalDocumentId}`, async (route) => {
    if (route.request().method() === "PATCH") await route.abort("failed");
    else await route.continue();
  });
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  await expect(page.getByText("Save failed", { exact: true })).toBeVisible();
  await expect(page.getByText("1 pending edit", { exact: true })).toBeVisible();
  await page.unroute(`**/v1/workspaces/${workspaceId}/documents/${originalDocumentId}`);
  await page.reload();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".layer-row").filter({ hasText: "Rectangle" })).toBeVisible();

  await page.getByRole("tab", { name: "History" }).click();
  await page.getByLabel("Version name").fill("Approved shape checkpoint");
  await page.getByRole("button", { name: "Save version" }).click();
  await expect(page.locator(".version-list").getByText("Approved shape checkpoint")).toBeVisible();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Layers" }).click();
  await expect(page.locator(".layer-row").filter({ hasText: "Heading" })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".layer-row").filter({ hasText: "Heading" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.locator(".layer-row").filter({ hasText: "Heading" })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const beforeRestore = await page.request.get(`/v1/workspaces/${workspaceId}/documents/${originalDocumentId}`).then((response) => response.json()) as Record<string, any>;
  await page.getByRole("tab", { name: "History" }).click();
  await page.locator(".version-list article").filter({ hasText: "Initial" }).getByRole("button", { name: "Restore" }).click();
  await page.getByRole("tab", { name: "Layers" }).click();
  await expect(page.locator(".layer-row").filter({ hasText: "Heading" })).toHaveCount(0);
  await expect(page.locator(".layer-row").filter({ hasText: "Rectangle" })).toHaveCount(0);
  const afterRestore = await page.request.get(`/v1/workspaces/${workspaceId}/documents/${originalDocumentId}`).then((response) => response.json()) as Record<string, any>;
  expect(afterRestore.editor.document.current_revision).toBeGreaterThan(beforeRestore.editor.document.current_revision);
  expect(afterRestore.editor.versions[0].kind).toBe("restore");
  expect(afterRestore.editor.versions[0].restored_from_version_id).toBeTruthy();

  await page.getByRole("button", { name: "Save as", exact: true }).click();
  const saveAs = page.getByRole("dialog", { name: "Save a copy" });
  await saveAs.getByLabel("Graphic name").fill("Recovered campaign copy");
  await saveAs.getByLabel("Location").selectOption("");
  await saveAs.getByRole("button", { name: "Save copy" }).click();
  await expect(page.getByRole("heading", { name: "Recovered campaign copy" })).toBeVisible();
  const copiedDocumentId = new URL(page.url()).pathname.split("/")[4]!;

  await page.getByRole("button", { name: "Back to Home" }).click();
  await expect(page.locator(".recent-card").filter({ hasText: "Recovered campaign copy" })).toContainText("Native document");
  await page.getByRole("link", { name: "Projects" }).first().click();
  await expect(page.locator(".project-card").filter({ hasText: "Real PostgreSQL campaign" })).toContainText("Durable campaign graphic");
  await page.getByRole("link", { name: "Files" }).first().click();
  await expect(page.locator(".native-document-card").filter({ hasText: "Recovered campaign copy" })).toBeVisible();
  await page.getByRole("button", { name: "Search workspace" }).click();
  await page.getByLabel("Search projects, files, native documents and jobs").fill("Recovered campaign");
  await expect(page.getByRole("listitem").filter({ hasText: "Recovered campaign copy" })).toContainText("Native document");
  await page.keyboard.press("Escape");
  await page.goto(`/w/${workspaceId}/studio/${copiedDocumentId}`);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  const peer = await newPeerPage(browser);
  const denied = await peer.page.request.get(`/v1/workspaces/${workspaceId}/documents/${copiedDocumentId}`);
  expect(denied.status()).toBe(404);
  grantMember(workspaceId, "actor-recovery-2d-peer");
  await peer.page.goto(page.url());
  await expect(peer.page.getByText("View only", { exact: true })).toBeVisible();
  await expect(peer.page.getByRole("button", { name: "Shape", exact: true })).toBeDisabled();
  await peer.page.getByRole("button", { name: "Request takeover" }).click();
  await expect(peer.page.getByText("Editing access was requested from the current editor.")).toBeVisible();
  await expect(page.getByText("Jordan Lee requested editing access")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Save and release" }).click();
  await expect(peer.page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(peer.page.getByRole("button", { name: "Shape", exact: true })).toBeEnabled();
  await peer.context.close();

  await page.goto(`/w/${workspaceId}`);
  const smallFixture = resolve(repoRoot, "data/fixtures/images/synthetic-alpha-32.png");
  await uploadAndProcess(page, smallFixture);
  const smallDocument = await createFromFile(page, workspaceId, "synthetic-alpha-32.png");
  await expect(page.getByTestId("image-graphic-studio")).toBeVisible();
  expect(smallDocument.editor.document.source_file_id).toBeTruthy();
  const rasterPixels = await page.locator(".lower-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 0; index < pixels.length; index += 16) if (pixels[index + 3]) painted += 1;
    return painted;
  });
  expect(rasterPixels).toBeGreaterThan(100);

  await page.getByRole("button", { name: "Back to Home" }).click();
  const generated = resolve(repoRoot, "apps/web/test-results/recovery-2d-large-source.png");
  mkdirSync(resolve(repoRoot, "apps/web/test-results"), { recursive: true });
  execFileSync(python, ["-c", "from PIL import Image; import sys; Image.new('RGB',(9000,4),(30,130,220)).save(sys.argv[1],format='PNG')", generated]);
  await uploadAndProcess(page, generated);
  const fullSourceRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/documents\/[^/]+\/source$/.test(new URL(request.url()).pathname)) fullSourceRequests.push(request.url());
  });
  const largeDocument = await createFromFile(page, workspaceId, "recovery-2d-large-source.png");
  const largeDocumentId = largeDocument.editor.document.document_id as string;
  const previewJobId = largeDocument.editor.document.preview_job_id as string;
  await expect(page.getByTestId("preview-preparing")).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(fullSourceRequests).toEqual([]);
  const previewDispatch = runWorker(previewJobId);
  expect(previewDispatch).toMatchObject({ job_id: previewJobId, kind: "preview_generation", state: "succeeded" });
  await expect(page.getByTestId("image-graphic-studio")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".lower-canvas")).toBeVisible();
  const readyLarge = await page.request.get(`/v1/workspaces/${workspaceId}/documents/${largeDocumentId}`).then((response) => response.json()) as Record<string, any>;
  expect(readyLarge.editor.document.preview_state).toBe("ready");
  expect(readyLarge.editor.document.source_version_id).toBe(largeDocument.editor.document.source_version_id);

  const databaseEvidence = evidence(workspaceId, largeDocumentId);
  expect(databaseEvidence.audit_count).toBeGreaterThan(0);
  expect(databaseEvidence.usage_count).toBeGreaterThan(0);
  expect(databaseEvidence.customer_amount).toBe(0);
  expect(databaseEvidence.credit_debit).toBe(0);
  expect(databaseEvidence.preview_count).toBe(2);
  expect(databaseEvidence.preview_max_width).toBeLessThanOrEqual(2048);
  expect(databaseEvidence.preview_max_height).toBeLessThanOrEqual(2048);
  expect(databaseEvidence.previews_non_authoritative).toBe(true);
  expect(databaseEvidence.preview_source_hashes_match).toBe(true);
  expect(databaseEvidence.outbox_count).toBe(1);
  expect(databaseEvidence.outbox_dispatched).toBe(true);
  expect(databaseEvidence.outbox_delivery_attempts).toBe(1);
  expect(databaseEvidence.jobs).toEqual([expect.objectContaining({ kind: "preview_generation", state: "succeeded", progress: 100 })]);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
