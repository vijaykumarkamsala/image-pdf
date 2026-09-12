import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DocumentReadModel, ImageExportRequestRecord, ProcessingRecipeRecord } from "ipw-contracts-ts/product";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const python = resolve(repoRoot, ".venv/Scripts/python.exe");
const storageRoot = process.env["IPW_RECOVERY_2E_STORAGE_ROOT"]!;
const databaseUrl = process.env["IPW_TEST_DATABASE_URL"]!;

type Format = "jpeg" | "png" | "webp" | "tiff";

interface UploadEvidence {
  fileId: string;
  uploadSessionId: string;
  sourceVersionId: string;
  facts: {
    detected_media_type: string;
    width: number;
    height: number;
    orientation?: number | null;
    has_alpha?: boolean;
    has_icc_profile?: boolean;
    colour_model?: string | null;
    sensitive_metadata: string[];
    sha256: string;
  };
}

interface ExportResponse {
  export_request: ImageExportRequestRecord;
}

interface OutputProbe {
  output_id: string;
  filename: string;
  state: string;
  format: string;
  mode: string;
  width: number;
  height: number;
  sha256: string;
  byte_size: number;
  storage_generation: string;
  generation_verified: boolean;
  has_non_uniform_pixels: boolean;
  has_icc_profile: boolean;
  sensitive_metadata: string[];
  metadata_verified: boolean;
  provenance_metadata_verified: boolean;
  metadata_evidence_matches_provenance: boolean;
  zero_charge: boolean;
}

interface FixtureCase {
  name: string;
  mediaType: string;
  expectedRawSize: [number, number];
  expectedOutputSize: [number, number];
  outputFormat: Format;
  outputProfile?: "srgb" | "preserve";
  expectedOrientation?: number;
  expectedColourModel?: string;
  expectedSensitive?: string[];
  highResolution?: boolean;
}

interface JsonResponse {
  ok(): boolean;
  url(): string;
  status(): number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

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
      IPW_RECOVERY_2E_FAULT_INJECTION: "1",
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

function runExportWorker(exportRequestId: string) {
  return JSON.parse(runPython("tools/run_local_processing_job.py", [
    "--export-request-id",
    exportRequestId,
  ])) as { job_id: string; kind: string; state: string };
}

function faultOutput(outputId: string, format: "avif" | "png") {
  return JSON.parse(runPython("tools/recovery_2e_fault_injection.py", [outputId, format])) as {
    output_id: string;
    format: string;
  };
}

async function responseJson<T>(response: JsonResponse): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${response.url()} returned ${response.status()}: ${await response.text()}`);
  }
  return await response.json() as T;
}

async function commandHeaders(page: Page, key: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name.endsWith("ipw-csrf"));
  expect(csrf, "authenticated browser CSRF cookie").toBeDefined();
  return {
    "idempotency-key": key,
    "x-trace-id": `trace-${key}`,
    "x-csrf-token": csrf!.value,
  };
}

async function uploadFixtureViaApi(
  page: Page,
  workspaceId: string,
  fixture: FixtureCase,
  suffix: string,
): Promise<UploadEvidence> {
  const bytes = readFileSync(resolve(repoRoot, `data/fixtures/images/recovery2e/${fixture.name}`));
  const created = await responseJson<{
    upload_session: { upload_session_id: string };
    authorization: { upload_url: string };
  }>(await page.request.post(`/v1/workspaces/${workspaceId}/upload-sessions`, {
    headers: await commandHeaders(page, `matrix-upload-${suffix}`),
    data: { display_name: fixture.name, media_type: fixture.mediaType, byte_size: bytes.byteLength },
  }));
  const uploadUrl = new URL(created.authorization.upload_url, page.url());
  const transfer = await page.request.put(uploadUrl.toString(), {
    headers: {
      ...await commandHeaders(page, `matrix-transfer-${suffix}`),
      "content-type": "application/octet-stream",
      "upload-offset": "0",
    },
    data: bytes,
  });
  expect(transfer.ok()).toBe(true);
  const finalised = await responseJson<{ job: { job_id: string } }>(await page.request.post(
    `/v1/upload-sessions/${created.upload_session.upload_session_id}/finalise`,
    { headers: await commandHeaders(page, `matrix-finalise-${suffix}`) },
  ));
  expect(runWorker(finalised.job.job_id)).toMatchObject({
    job_id: finalised.job.job_id,
    kind: "file_intake_inspection",
    state: "succeeded",
  });
  const status = await responseJson<{ upload_session: {
    state: string;
    file_id: string;
    source_version_id: string;
    source_facts: UploadEvidence["facts"];
  } }>(await page.request.get(`/v1/upload-sessions/${created.upload_session.upload_session_id}`));
  expect(status.upload_session.state).toBe("ready");
  expect(status.upload_session.source_facts.detected_media_type).toBe(fixture.mediaType);
  expect([status.upload_session.source_facts.width, status.upload_session.source_facts.height]).toEqual(fixture.expectedRawSize);
  expect(status.upload_session.source_facts.orientation ?? undefined).toBe(fixture.expectedOrientation);
  if (fixture.expectedColourModel) expect(status.upload_session.source_facts.colour_model).toBe(fixture.expectedColourModel);
  if (fixture.expectedSensitive) {
    expect(new Set(status.upload_session.source_facts.sensitive_metadata)).toEqual(new Set(fixture.expectedSensitive));
  }
  return {
    fileId: status.upload_session.file_id,
    uploadSessionId: created.upload_session.upload_session_id,
    sourceVersionId: status.upload_session.source_version_id,
    facts: status.upload_session.source_facts,
  };
}

async function uploadTransparentThroughReact(page: Page) {
  await page.getByRole("button", { name: "Upload" }).first().click();
  await page.locator('input[type="file"]').setInputFiles(
    resolve(repoRoot, "data/fixtures/images/recovery2e/transparent-256x192.png"),
  );
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

async function createDocumentThroughReact(page: Page, workspaceId: string) {
  await page.getByRole("link", { name: "Files", exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/files$`));
  const source = page.locator(".file-card").filter({ hasText: "transparent-256x192.png" });
  await expect(source).toBeVisible();
  await source.getByRole("button", { name: "Create in Studio" }).click();
  await page.getByLabel("Graphic name").fill("Real enhancement export");
  const createdResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/v1/workspaces/${workspaceId}/documents`);
  await page.getByRole("button", { name: "Create graphic" }).click();
  const created = await (await createdResponse).json() as { editor: DocumentReadModel };
  await expect(page.getByTestId("image-graphic-studio")).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  return created.editor;
}

async function createDocumentViaApi(
  page: Page,
  workspaceId: string,
  upload: UploadEvidence,
  suffix: string,
): Promise<DocumentReadModel> {
  let created = await responseJson<{ editor: DocumentReadModel }>(await page.request.post(
    `/v1/workspaces/${workspaceId}/documents`,
    {
      headers: await commandHeaders(page, `matrix-document-${suffix}`),
      data: { name: `Matrix ${suffix}`, source_file_id: upload.fileId, intended_use: "digital" },
    },
  ));
  const previewJobId = created.editor.document.preview_job_id;
  if (previewJobId) {
    expect(runWorker(previewJobId)).toMatchObject({
      job_id: previewJobId,
      kind: "preview_generation",
      state: "succeeded",
    });
    created = await responseJson<{ editor: DocumentReadModel }>(await page.request.get(
      `/v1/workspaces/${workspaceId}/documents/${created.editor.document.document_id}`,
    ));
    expect(created.editor.document.preview_state).toBe("ready");
  }
  return created.editor;
}

async function makeArtboardTransparent(page: Page, workspaceId: string, editor: DocumentReadModel, suffix: string) {
  const documentId = editor.document.document_id;
  const acquired = await responseJson<{ grant: { lease_token: string } }>(await page.request.post(
    `/v1/workspaces/${workspaceId}/documents/${documentId}/lease`,
    { headers: await commandHeaders(page, `matrix-lease-${suffix}`) },
  ));
  const artboard = editor.snapshot.artboards[0]!;
  await responseJson(await page.request.patch(`/v1/workspaces/${workspaceId}/documents/${documentId}`, {
    headers: {
      ...await commandHeaders(page, `matrix-transparent-${suffix}`),
      "x-editor-lease": acquired.grant.lease_token,
    },
    data: {
      base_revision: editor.document.current_revision,
      mutation: {
        kind: "artboard.update",
        target_id: artboard.artboard_id,
        artboard: { ...artboard, background: { kind: "transparent", color: null } },
        properties: {},
      },
    },
  }));
  await responseJson(await page.request.post(
    `/v1/workspaces/${workspaceId}/documents/${documentId}/versions`,
    {
      headers: await commandHeaders(page, `matrix-transparent-version-${suffix}`),
      data: { name: `Transparent ${suffix}` },
    },
  ));
  return responseJson<{ editor: DocumentReadModel }>(await page.request.get(
    `/v1/workspaces/${workspaceId}/documents/${documentId}`,
  )).then((value) => value.editor);
}

async function createRecipe(
  page: Page,
  workspaceId: string,
  documentId: string,
  suffix: string,
): Promise<ProcessingRecipeRecord> {
  return responseJson<{ recipe: ProcessingRecipeRecord }>(await page.request.post(
    `/v1/workspaces/${workspaceId}/documents/${documentId}/recipes`,
    { headers: await commandHeaders(page, `matrix-recipe-${suffix}`), data: { name: `Recipe ${suffix}`, operations: [] } },
  )).then((value) => value.recipe);
}

function outputProfile(
  suffix: string,
  format: Format,
  width: number,
  height: number,
  colourProfile: "srgb" | "preserve" = "srgb",
) {
  return {
    profile_id: `profile-${suffix}`,
    name: `${format.toUpperCase()} ${suffix}`,
    purpose: "custom",
    format,
    width,
    height,
    percentage: null,
    physical_width: null,
    physical_height: null,
    physical_unit: null,
    ppi: null,
    fit: "contain",
    quality: format === "jpeg" || format === "webp" ? 88 : null,
    lossless: format === "png" || format === "tiff",
    resampling_algorithm: "lanczos",
    colour_profile: colourProfile,
    bit_depth: 8,
    alpha_behavior: format === "jpeg" ? "flatten" : "preserve",
    background: format === "jpeg" ? "#FFFFFF" : null,
    metadata_policy: {
      preserve_copyright: false,
      preserve_description: false,
      preserve_capture_time: false,
      preserve_camera: false,
      preserve_location: false,
      remove_embedded_thumbnails: true,
    },
    chroma_subsampling: null,
    filename_template: `{document}-${suffix}`,
    collision_behavior: "fail",
  };
}

async function submitExport(
  page: Page,
  workspaceId: string,
  editor: DocumentReadModel,
  recipe: ProcessingRecipeRecord,
  outputs: Array<{ artboard_id: string; filename: string; profile: ReturnType<typeof outputProfile> }>,
  suffix: string,
) {
  return responseJson<ExportResponse>(await page.request.post(
    `/v1/workspaces/${workspaceId}/documents/${editor.document.document_id}/exports`,
    {
      headers: await commandHeaders(page, `matrix-export-${suffix}`),
      data: {
        document_version_id: editor.document.current_version_id,
        recipe_id: recipe.recipe_id,
        recipe_version: recipe.version,
        outputs,
      },
    },
  )).then((value) => value.export_request);
}

test("Recovery 2E real React, processing matrix, isolation and verified delivery journey", async ({ page }) => {
  test.setTimeout(600_000);
  await identify(page);
  await page.goto("/app");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  const workspaceId = new URL(page.url()).pathname.split("/")[2]!;

  await uploadTransparentThroughReact(page);
  const initialEditor = await createDocumentThroughReact(page, workspaceId);
  const documentId = initialEditor.document.document_id;

  await page.getByRole("tab", { name: "Enhance" }).click();
  await expect(page.getByText("Keep transparency where the format supports it")).toBeVisible();
  await page.getByLabel("Correction to add").selectOption("contrast");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".operation-card").filter({ hasText: "Contrast" }).locator('input[type="range"]').fill("12");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(page.getByText("Corrections saved", { exact: true })).toBeVisible();

  const previewIds: string[] = [];
  let previewSerial = Promise.resolve();
  await page.route(`**/v1/workspaces/${workspaceId}/documents/${documentId}/enhancement-previews`, async (route) => {
    const upstream = await route.fetch();
    const payload = await upstream.json() as { preview: { preview_id: string; export_request_id: string } };
    if (upstream.ok()) {
      previewIds.push(payload.preview.preview_id);
      previewSerial = previewSerial.then(() => {
        expect(runExportWorker(payload.preview.export_request_id)).toMatchObject({
          kind: "image_export",
          state: "succeeded",
        });
      });
      await previewSerial;
    }
    await route.fulfill({ response: upstream, json: payload });
  });
  await page.getByRole("button", { name: "Split view" }).click();
  await expect(page.getByTestId("comparison-workspace")).toHaveAttribute("data-mode", "split");
  expect(previewIds).toHaveLength(2);
  const previews = await Promise.all(previewIds.map(async (previewId) => responseJson<{
    preview: { mode: string; state: string; sha256: string; width: number; height: number; authoritative: boolean };
  }>(await page.request.get(`/v1/workspaces/${workspaceId}/enhancement-previews/${previewId}`))));
  expect(previews.map((value) => value.preview.state)).toEqual(["succeeded", "succeeded"]);
  expect(new Set(previews.map((value) => value.preview.sha256)).size).toBe(2);
  expect(previews.every((value) => value.preview.authoritative && value.preview.width === 1200 && value.preview.height === 900)).toBe(true);
  await page.getByRole("button", { name: "Close comparison" }).click();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByTestId("export-center")).toBeVisible();
  await page.getByLabel("Width px").fill("128");
  await page.getByLabel("Height px").fill("96");
  const submittedResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/v1/workspaces/${workspaceId}/documents/${documentId}/exports`);
  await page.getByRole("button", { name: "Export 1 output" }).click();
  const submitted = await (await submittedResponse).json() as ExportResponse;
  await expect(page.locator(".export-monitor")).toHaveAttribute("data-export-state", "queued");
  expect(runWorker(submitted.export_request.job_id)).toMatchObject({
    job_id: submitted.export_request.job_id,
    kind: "image_export",
    state: "succeeded",
  });
  await expect(page.locator(".export-monitor")).toHaveAttribute("data-export-state", "completed");
  await expect(page.getByRole("link", { name: "Download" })).toBeVisible();

  const status = await responseJson<ExportResponse>(await page.request.get(
    `/v1/workspaces/${workspaceId}/exports/${submitted.export_request.export_request_id}`,
  ));
  expect(status.export_request.state).toBe("completed");
  expect(status.export_request.outputs[0]).toMatchObject({ width: 128, height: 96, metadata_verified: true });
  const primaryOutput = status.export_request.outputs[0]!;
  const downloadUrl = `/v1/workspaces/${workspaceId}/export-outputs/${primaryOutput.output_id}/download`;
  const download = await page.request.get(downloadUrl);
  if (!download.ok()) {
    throw new Error(`output download failed (${download.status()}): ${await download.text()}`);
  }
  expect(download.headers()["cache-control"]).toBe("private, no-store, max-age=0");
  expect(download.headers()["x-content-type-options"]).toBe("nosniff");
  expect(download.headers()["accept-ranges"]).toBe("bytes");
  expect(download.headers()["content-disposition"]).toContain("filename*=UTF-8''");
  const outputBytes = await download.body();
  expect(createHash("sha256").update(outputBytes).digest("hex")).toBe(primaryOutput.sha256);
  const partialDownload = await page.request.get(downloadUrl, { headers: { range: "bytes=0-15" } });
  expect(partialDownload.status()).toBe(206);
  expect(partialDownload.headers()["content-range"]).toBe(`bytes 0-15/${outputBytes.byteLength}`);
  expect(await partialDownload.body()).toEqual(outputBytes.subarray(0, 16));
  expect((await page.request.get(downloadUrl, { headers: { range: "bytes=999999999-" } })).status()).toBe(416);

  const outsiderContext = await page.context().browser()!.newContext();
  const outsider = await outsiderContext.newPage();
  await outsider.request.post("/v1/auth/developer-session", {
    data: { actor_id: "actor-recovery-2e-outsider", display_name: "Outside user" },
  });
  expect((await outsider.request.get(downloadUrl)).status()).toBe(404);
  await outsiderContext.close();

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
  const zipUrl = `/v1/workspaces/${workspaceId}/export-bundles/${bundle.bundle.bundle_id}/download`;
  const zip = await page.request.get(zipUrl);
  expect(zip.ok()).toBe(true);
  expect(zip.headers()["cache-control"]).toBe("private, no-store, max-age=0");
  expect(zip.headers()["x-content-type-options"]).toBe("nosniff");
  expect(zip.headers()["content-disposition"]).toContain("filename*=UTF-8''");
  const zipBytes = await zip.body();
  expect(zipBytes.subarray(0, 2).toString("ascii")).toBe("PK");
  const zipRange = await page.request.get(zipUrl, { headers: { range: "bytes=-12" } });
  expect(zipRange.status()).toBe(206);
  expect(await zipRange.body()).toEqual(zipBytes.subarray(-12));

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Artboard", exact: true }).click();
  await expect.poll(async () => responseJson<{ editor: DocumentReadModel }>(await page.request.get(
    `/v1/workspaces/${workspaceId}/documents/${documentId}`,
  )).then((value) => value.editor.snapshot.artboards.length)).toBe(2);
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  await expect.poll(async () => responseJson<{ editor: DocumentReadModel }>(await page.request.get(
    `/v1/workspaces/${workspaceId}/documents/${documentId}`,
  )).then((value) => (value.editor.snapshot.layers ?? []).length)).toBe(2);

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "New export" }).click();
  await expect(page.getByRole("button", { name: "1 Configure" })).toHaveAttribute("aria-current", "step");
  await expect(page.getByLabel("Artboard 2")).toBeVisible();
  await page.getByLabel("Artboard 2").check();
  await page.getByRole("button", { name: /^Social/ }).click();
  const multiSubmittedResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/v1/workspaces/${workspaceId}/documents/${documentId}/exports`);
  await page.getByRole("button", { name: "Export 4 outputs" }).click();
  const multiRequest = (await responseJson<ExportResponse>(await multiSubmittedResponse)).export_request;
  expect(multiRequest.outputs).toHaveLength(4);
  const multiEditor = await responseJson<{ editor: DocumentReadModel }>(await page.request.get(
    `/v1/workspaces/${workspaceId}/documents/${documentId}`,
  )).then((value) => value.editor);
  expect(multiEditor.snapshot.artboards).toHaveLength(2);
  const exportVersion = multiEditor.versions.find(
    (version) => version.document_version_id === multiRequest.document_version_id,
  );
  expect(exportVersion).toMatchObject({ name: "Export checkpoint", revision: multiEditor.snapshot.revision });
  const recipes = await responseJson<{ recipes: ProcessingRecipeRecord[] }>(await page.request.get(
    `/v1/workspaces/${workspaceId}/documents/${documentId}/recipes`,
  ));
  const currentRecipe = recipes.recipes.at(-1)!;
  const faultedOutput = multiRequest.outputs.find((output) => output.profile.format === "png")!;
  expect(faultedOutput.profile.format).toBe("png");
  expect(faultOutput(faultedOutput.output_id, "avif")).toMatchObject({
    output_id: faultedOutput.output_id,
    format: "avif",
  });
  expect(runWorker(multiRequest.job_id)).toMatchObject({ kind: "image_export", state: "succeeded" });
  const partial = await responseJson<ExportResponse>(await page.request.get(
    `/v1/workspaces/${workspaceId}/exports/${multiRequest.export_request_id}`,
  ));
  expect(partial.export_request.state).toBe("partially_completed");
  expect(partial.export_request.outputs.map((output) => output.state).sort()).toEqual([
    "failed",
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
  const successfulBeforeRetry = partial.export_request.outputs.find((output) => output.state === "succeeded")!;
  const failedBeforeRetry = partial.export_request.outputs.find((output) => output.state === "failed")!;
  expect(successfulBeforeRetry.sha256).toMatch(/^[a-f0-9]{64}$/);
  const retried = await responseJson<ExportResponse>(await page.request.post(
    `/v1/workspaces/${workspaceId}/exports/${multiRequest.export_request_id}/retry`,
    { headers: await commandHeaders(page, "matrix-retry-failed-only") },
  ));
  expect(retried.export_request.outputs.find((output) => output.output_id === successfulBeforeRetry.output_id)).toMatchObject({
    state: "succeeded",
    sha256: successfulBeforeRetry.sha256,
    object_reference_id: successfulBeforeRetry.object_reference_id,
  });
  expect(retried.export_request.outputs.find((output) => output.output_id === failedBeforeRetry.output_id)?.state).toBe("queued");
  expect(faultOutput(failedBeforeRetry.output_id, "png")).toMatchObject({ format: "png" });
  expect(runWorker(retried.export_request.job_id)).toMatchObject({ kind: "image_export", state: "succeeded" });
  const recovered = await responseJson<ExportResponse>(await page.request.get(
    `/v1/workspaces/${workspaceId}/exports/${multiRequest.export_request_id}`,
  ));
  expect(recovered.export_request.state).toBe("completed");
  expect(recovered.export_request.outputs.find((output) => output.output_id === successfulBeforeRetry.output_id)).toMatchObject({
    sha256: successfulBeforeRetry.sha256,
    object_reference_id: successfulBeforeRetry.object_reference_id,
  });

  const cancellation = await submitExport(page, workspaceId, multiEditor, currentRecipe, [{
    artboard_id: multiEditor.snapshot.artboards[1]!.artboard_id,
    filename: "cancelled-before-work.png",
    profile: outputProfile("cancelled", "png", 200, 140),
  }], "cancel-before-work");
  const cancelled = await responseJson<ExportResponse>(await page.request.post(
    `/v1/workspaces/${workspaceId}/exports/${cancellation.export_request_id}/cancel`,
    { headers: await commandHeaders(page, "matrix-cancel-before-work") },
  ));
  expect(cancelled.export_request.state).toBe("cancelled");
  expect(cancelled.export_request.outputs[0]?.state).toBe("cancelled");
  expect(runWorker(cancellation.job_id).state).toBe("already_terminal");

  const matrix: FixtureCase[] = [
    { name: "photographic-640x400.jpg", mediaType: "image/jpeg", expectedRawSize: [640, 400], expectedOutputSize: [320, 200], outputFormat: "jpeg", expectedColourModel: "rgb" },
    { name: "source-320x200.webp", mediaType: "image/webp", expectedRawSize: [320, 200], expectedOutputSize: [320, 200], outputFormat: "webp", expectedColourModel: "rgb" },
    { name: "source-240x180.tiff", mediaType: "image/tiff", expectedRawSize: [240, 180], expectedOutputSize: [240, 180], outputFormat: "tiff", expectedColourModel: "rgb" },
    { name: "orientation6-160x96.jpg", mediaType: "image/jpeg", expectedRawSize: [160, 96], expectedOutputSize: [96, 160], outputFormat: "png", expectedOrientation: 6, expectedColourModel: "rgb" },
    {
      name: "private-metadata-320x200.jpg", mediaType: "image/jpeg", expectedRawSize: [320, 200], expectedOutputSize: [200, 320], outputFormat: "jpeg", expectedOrientation: 6, expectedColourModel: "rgb",
      expectedSensitive: ["comments", "description", "embedded_thumbnails", "exif", "gps", "iptc", "maker_notes", "software_device", "xmp"],
    },
    { name: "tagged-rgb-320x200.png", mediaType: "image/png", expectedRawSize: [320, 200], expectedOutputSize: [320, 200], outputFormat: "png", outputProfile: "preserve", expectedColourModel: "rgb" },
    { name: "cmyk-360x240.jpg", mediaType: "image/jpeg", expectedRawSize: [360, 240], expectedOutputSize: [360, 240], outputFormat: "jpeg", expectedColourModel: "cmyk" },
    { name: "bounded-high-resolution-3200x2600.png", mediaType: "image/png", expectedRawSize: [3200, 2600], expectedOutputSize: [800, 650], outputFormat: "png", expectedColourModel: "rgb", highResolution: true },
  ];
  const matrixOutputs: Array<{ outputId: string; fixture: FixtureCase }> = [];
  let metadataDocument: DocumentReadModel | null = null;
  for (const [index, fixture] of matrix.entries()) {
    const suffix = `fixture-${index}`;
    const upload = await uploadFixtureViaApi(page, workspaceId, fixture, suffix);
    let editor = await createDocumentViaApi(page, workspaceId, upload, suffix);
    if (fixture.highResolution) {
      expect(editor.document.preview_state).toBe("ready");
      const sourceDelivery = await page.request.get(
        `/v1/workspaces/${workspaceId}/documents/${editor.document.document_id}/source`,
      );
      expect(sourceDelivery.ok()).toBe(true);
      expect(sourceDelivery.headers()["content-type"]).toContain("image/png");
      expect((await sourceDelivery.body()).byteLength).toBeLessThan(16 * 1024 * 1024);
    }
    if (fixture.outputProfile === "preserve") {
      editor = await makeArtboardTransparent(page, workspaceId, editor, suffix);
    }
    if (fixture.name === "private-metadata-320x200.jpg") metadataDocument = editor;
    const recipe = await createRecipe(page, workspaceId, editor.document.document_id, suffix);
    const request = await submitExport(page, workspaceId, editor, recipe, [{
      artboard_id: editor.snapshot.artboards[0]!.artboard_id,
      filename: `${suffix}.${fixture.outputFormat === "jpeg" ? "jpg" : fixture.outputFormat === "tiff" ? "tif" : fixture.outputFormat}`,
      profile: outputProfile(
        suffix,
        fixture.outputFormat,
        fixture.expectedOutputSize[0],
        fixture.expectedOutputSize[1],
        fixture.outputProfile ?? "srgb",
      ),
    }], suffix);
    expect(runWorker(request.job_id)).toMatchObject({ kind: "image_export", state: "succeeded" });
    const completed = await responseJson<ExportResponse>(await page.request.get(
      `/v1/workspaces/${workspaceId}/exports/${request.export_request_id}`,
    ));
    expect(completed.export_request.state).toBe("completed");
    expect(completed.export_request.outputs[0]).toMatchObject({
      state: "succeeded",
      width: fixture.expectedOutputSize[0],
      height: fixture.expectedOutputSize[1],
      metadata_verified: true,
    });
    matrixOutputs.push({ outputId: completed.export_request.outputs[0]!.output_id, fixture });
  }

  expect(metadataDocument).not.toBeNull();
  const recommendationInput = {
    document_version_id: metadataDocument!.document.current_version_id,
    intended_outcome: "digital",
  };
  const recommendationOne = await responseJson<{ recommendation_set: {
    recommendation_set_id: string;
    recommendations: Array<{ recommendation_id: string; target_kind: string; state: string }>;
  } }>(await page.request.post(
    `/v1/workspaces/${workspaceId}/documents/${metadataDocument!.document.document_id}/recommendations`,
    { headers: await commandHeaders(page, "matrix-metadata-recommendation-one"), data: recommendationInput },
  ));
  const recommendationTwo = await responseJson<typeof recommendationOne>(await page.request.post(
    `/v1/workspaces/${workspaceId}/documents/${metadataDocument!.document.document_id}/recommendations`,
    { headers: await commandHeaders(page, "matrix-metadata-recommendation-two"), data: recommendationInput },
  ));
  expect(recommendationTwo.recommendation_set.recommendation_set_id).toBe(recommendationOne.recommendation_set.recommendation_set_id);
  const metadataRecommendation = recommendationOne.recommendation_set.recommendations.find(
    (item) => item.target_kind === "metadata_policy",
  )!;
  await responseJson(await page.request.patch(
    `/v1/workspaces/${workspaceId}/recommendation-sets/${recommendationOne.recommendation_set.recommendation_set_id}/decisions`,
    {
      headers: await commandHeaders(page, "matrix-metadata-recommendation-accept"),
      data: { decisions: [{ recommendation_id: metadataRecommendation.recommendation_id, state: "accepted" }] },
    },
  ));
  const refreshedRecommendation = await responseJson<typeof recommendationOne>(await page.request.post(
    `/v1/workspaces/${workspaceId}/documents/${metadataDocument!.document.document_id}/recommendations`,
    { headers: await commandHeaders(page, "matrix-metadata-recommendation-refresh"), data: recommendationInput },
  ));
  expect(refreshedRecommendation.recommendation_set.recommendations.find(
    (item) => item.recommendation_id === metadataRecommendation.recommendation_id,
  )?.state).toBe("accepted");

  const probeTargets = [
    primaryOutput.output_id,
    ...recovered.export_request.outputs.map((output) => output.output_id),
    ...matrixOutputs.map((item) => item.outputId),
  ];
  const outputEvidence = JSON.parse(runPython("tools/recovery_2e_output_probe.py", [
    workspaceId,
    ...probeTargets,
  ])) as OutputProbe[];
  expect(outputEvidence).toHaveLength(probeTargets.length);
  for (const output of outputEvidence) {
    expect(output).toMatchObject({
      state: "succeeded",
      zero_charge: true,
      generation_verified: true,
      has_non_uniform_pixels: true,
      metadata_verified: true,
      provenance_metadata_verified: true,
      metadata_evidence_matches_provenance: true,
    });
    expect(output.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.storage_generation).toBeTruthy();
    expect(output.sensitive_metadata).toEqual([]);
  }
  for (const { outputId, fixture } of matrixOutputs) {
    const output = outputEvidence.find((value) => value.output_id === outputId)!;
    expect([output.width, output.height]).toEqual(fixture.expectedOutputSize);
    expect(output.format).toBe({ jpeg: "JPEG", png: "PNG", webp: "WEBP", tiff: "TIFF" }[fixture.outputFormat]);
    expect(output.has_icc_profile).toBe(true);
    if (fixture.expectedColourModel === "cmyk") expect(output.mode).toBe("RGB");
  }

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
