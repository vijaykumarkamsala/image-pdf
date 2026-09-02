import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const python = resolve(repoRoot, ".venv/Scripts/python.exe");
const storageRoot = process.env["IPW_RECOVERY_2E_STORAGE_ROOT"]!;
const databaseUrl = process.env["IPW_TEST_DATABASE_URL"]!;

async function identify(page: Page) {
  const actorId = "actor-recovery-2e-owner";
  await page.addInitScript((id) => {
    localStorage.setItem("ipw-theme", "light");
    sessionStorage.setItem("ipw-bootstrap-key", `bootstrap-${id}`);
  }, actorId);
  const response = await page.request.post("/v1/auth/developer-session", {
    data: { actor_id: actorId, display_name: "Alex Morgan" },
  });
  expect(response.ok()).toBe(true);
}

function runPython(script: string, args: string[]) {
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
    kind: string;
    state: string;
  };
}

async function uploadAndProcess(page: Page) {
  await page.getByRole("button", { name: "Upload" }).first().click();
  await page.locator('input[type="file"]').setInputFiles(resolve(repoRoot, "data/fixtures/images/synthetic-alpha-32.png"));
  const finalisedResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && /\/v1\/upload-sessions\/[^/]+\/finalise$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "Upload 1 file" }).click();
  const finalised = await (await finalisedResponse).json() as { job: { job_id: string } };
  expect(runWorker(finalised.job.job_id)).toMatchObject({
    job_id: finalised.job.job_id,
    kind: "file_intake_inspection",
    state: "succeeded",
  });
  await expect(page.getByText("File ready")).toBeVisible();
  await page.locator(".upload-actions").getByRole("button", { name: "Close", exact: true }).click();
}

async function createDocument(page: Page, workspaceId: string) {
  await page.goto(`/w/${workspaceId}/files`);
  await page.locator(".file-card").filter({ hasText: "synthetic-alpha-32.png" })
    .getByRole("button", { name: "Create in Studio" }).click();
  await page.getByLabel("Graphic name").fill("Real enhancement export");
  const createdResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/v1/workspaces/${workspaceId}/documents`);
  await page.getByRole("button", { name: "Create graphic" }).click();
  const created = await (await createdResponse).json() as { editor: { document: { document_id: string } } };
  await expect(page.getByTestId("image-graphic-studio")).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  return created.editor.document.document_id;
}

test("Recovery 2E real React to durable derivative journey", async ({ page }) => {
  test.setTimeout(360_000);
  await identify(page);
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  const workspaceId = new URL(page.url()).pathname.split("/")[2]!;

  await uploadAndProcess(page);
  const documentId = await createDocument(page, workspaceId);

  await page.getByRole("tab", { name: "Enhance" }).click();
  await expect(page.getByText("Keep transparency where the format supports it")).toBeVisible();
  await page.getByLabel("Correction to add").selectOption("contrast");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".operation-card").filter({ hasText: "Contrast" }).locator('input[type="range"]').fill("12");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(page.getByText("Corrections saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByTestId("export-center")).toBeVisible();
  await page.getByLabel("Width px").fill("128");
  const submittedResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/v1/workspaces/${workspaceId}/documents/${documentId}/exports`);
  await page.getByRole("button", { name: "Export 1 output" }).click();
  const submitted = await (await submittedResponse).json() as {
    export_request: { export_request_id: string; job_id: string; outputs: Array<{ output_id: string }> };
  };
  await expect(page.locator(".export-monitor")).toHaveAttribute("data-export-state", "queued");

  expect(runWorker(submitted.export_request.job_id)).toMatchObject({
    job_id: submitted.export_request.job_id,
    kind: "image_export",
    state: "succeeded",
  });
  await expect(page.locator(".export-monitor")).toHaveAttribute("data-export-state", "completed");
  await expect(page.getByRole("link", { name: "Download" })).toBeVisible();

  const statusResponse = await page.request.get(
    `/v1/workspaces/${workspaceId}/exports/${submitted.export_request.export_request_id}`,
  );
  expect(statusResponse.ok()).toBe(true);
  const status = await statusResponse.json() as {
    export_request: { state: string; outputs: Array<{ output_id: string; sha256: string; width: number; height: number }> };
  };
  expect(status.export_request.state).toBe("completed");
  expect(status.export_request.outputs[0]).toMatchObject({ width: 128, height: 128 });
  const output = status.export_request.outputs[0]!;
  const download = await page.request.get(`/v1/workspaces/${workspaceId}/export-outputs/${output.output_id}/download`);
  expect(download.ok()).toBe(true);
  const outputBytes = await download.body();
  expect(createHash("sha256").update(outputBytes).digest("hex")).toBe(output.sha256);

  await page.reload();
  await expect(page.getByTestId("image-graphic-studio")).toBeVisible();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator(".export-monitor")).toHaveAttribute("data-export-state", "completed");

  const bundleResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/v1/workspaces/${workspaceId}/exports/${submitted.export_request.export_request_id}/bundles`);
  await page.getByRole("button", { name: "Create ZIP of completed" }).click();
  const bundle = await (await bundleResponse).json() as { bundle: { bundle_id: string; job_id: string } };
  expect(runWorker(bundle.bundle.job_id)).toMatchObject({
    job_id: bundle.bundle.job_id,
    kind: "export_bundle",
    state: "succeeded",
  });
  await expect(page.getByRole("link", { name: "Download ZIP" })).toBeVisible();
  const zip = await page.request.get(`/v1/workspaces/${workspaceId}/export-bundles/${bundle.bundle.bundle_id}/download`);
  expect(zip.ok()).toBe(true);
  expect((await zip.body()).subarray(0, 2).toString("ascii")).toBe("PK");

  const evidence = JSON.parse(runPython("tools/recovery_2e_acceptance_probe.py", [
    workspaceId,
    submitted.export_request.export_request_id,
  ])) as Record<string, unknown>;
  expect(evidence).toMatchObject({
    request_state: "completed",
    job_state: "succeeded",
    outbox_state: "dispatched",
    output_state: "succeeded",
    metadata_verified: true,
    deterministic: true,
    source_identity_matches: true,
    audit_count: 2,
    customer_amount: 0,
    credit_debit: 0,
    bundle_state: "succeeded",
  });
});
