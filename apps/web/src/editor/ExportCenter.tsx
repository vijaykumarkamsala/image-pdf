import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  CheckCircle2,
  Download,
  FileArchive,
  FileImage,
  Globe2,
  Mail,
  MonitorPlay,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import type {
  DocumentReadModel,
  ExportOutputProfile,
  ExportOutputRecord,
  ExportPurpose,
  ExportZipBundle,
  ImageExportFormat,
  ImageExportRequestRecord,
  ProcessingRecipeRecord,
} from "ipw-contracts-ts/product";

import { api } from "../boundaries/apiClient";
import { Button, Dialog, InlineNotice, Progress } from "../design-system";

interface OutputPreset {
  id: string;
  label: string;
  detail: string;
  icon: typeof Globe2;
  profile: Omit<ExportOutputProfile, "profile_id">;
}

const METADATA_DEFAULT = {
  preserve_copyright: true,
  preserve_description: false,
  preserve_capture_time: false,
  preserve_camera: false,
  preserve_location: false as const,
  remove_embedded_thumbnails: true as const,
};

const OUTPUT_PRESETS: OutputPreset[] = [
  preset("web", "Web", "WebP, 1600 px wide", Globe2, "web", "webp", { width: 1600, quality: 82 }),
  preset("email", "Email", "JPEG, 1200 px wide", Mail, "email", "jpeg", { width: 1200, quality: 78, alpha_behavior: "flatten", background: "#FFFFFF", chroma_subsampling: "4:2:0" }),
  preset("social", "Social", "PNG, 1080 x 1080", FileImage, "social", "png", { width: 1080, height: 1080, fit: "cover" }),
  preset("presentation", "Presentation", "PNG, 1920 x 1080", MonitorPlay, "presentation", "png", { width: 1920, height: 1080, fit: "contain" }),
  preset("archival", "Archival derivative", "TIFF, original dimensions", Archive, "archival_derivative", "tiff", { lossless: true }),
  preset("high-resolution", "High-resolution digital", "PNG, original dimensions", FileImage, "high_resolution_digital", "png", { lossless: true }),
];

export function ExportCenter({
  open,
  onClose,
  workspaceId,
  editor,
  prepareDocument,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  editor: DocumentReadModel;
  prepareDocument: () => Promise<DocumentReadModel>;
}) {
  const [selectedArtboards, setSelectedArtboards] = useState<Set<string>>(new Set());
  const [profiles, setProfiles] = useState<ExportOutputProfile[]>([]);
  const [recipe, setRecipe] = useState<ProcessingRecipeRecord | null>(null);
  const [exports, setExports] = useState<ImageExportRequestRecord[]>([]);
  const [activeExport, setActiveExport] = useState<ImageExportRequestRecord | null>(null);
  const [bundle, setBundle] = useState<ExportZipBundle | null>(null);
  const [busy, setBusy] = useState<"load" | "submit" | "cancel" | "retry" | "bundle" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"configure" | "monitor">("configure");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSelectedArtboards((current) => current.size ? current : new Set(editor.snapshot.artboards.map((item) => item.artboard_id)));
    setProfiles((current) => current.length ? current : [profileFromPreset(OUTPUT_PRESETS[0]!) ]);
    setBusy("load");
    setError(null);
    void Promise.all([
      api.processingRecipes(workspaceId, editor.document.document_id),
      api.imageExports(workspaceId, editor.document.document_id),
    ]).then(([recipeResult, exportResult]) => {
      if (!active) return;
      setRecipe(recipeResult.recipes.at(-1) ?? null);
      setExports(exportResult.exports);
      const current = exportResult.exports.find((item) => ["queued", "running", "partially_completed"].includes(item.state)) ?? exportResult.exports[0] ?? null;
      setActiveExport(current);
      if (current) setStep("monitor");
    }).catch((reason: unknown) => active && setError(message(reason, "Export details could not be loaded"))).finally(() => active && setBusy(null));
    return () => { active = false; };
  }, [editor.document.document_id, open, workspaceId]);

  useEffect(() => {
    if (!open || !activeExport || !["queued", "running", "partially_completed"].includes(activeExport.state)) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await api.imageExport(workspaceId, activeExport.export_request_id);
        if (active) setActiveExport(response.export_request);
      } catch { /* Preserve the last known durable status during a transient reconnect. */ }
    };
    const timer = window.setInterval(() => void refresh(), 1500);
    void refresh();
    return () => { active = false; window.clearInterval(timer); };
  }, [activeExport?.export_request_id, activeExport?.state, open, workspaceId]);

  useEffect(() => {
    if (!open || !bundle || ["succeeded", "failed", "cancelled"].includes(bundle.state)) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await api.exportBundle(workspaceId, bundle.bundle_id);
        if (active) setBundle(response.bundle);
      } catch { /* Keep the durable bundle status and retry on the next poll. */ }
    };
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [bundle?.bundle_id, bundle?.state, open, workspaceId]);

  const outputCount = selectedArtboards.size * profiles.length;
  const estimate = useMemo(() => estimateRange(editor, selectedArtboards, profiles), [editor, profiles, selectedArtboards]);
  const successful = activeExport?.outputs.filter((item) => item.state === "succeeded") ?? [];
  const failed = activeExport?.outputs.filter((item) => item.state === "failed") ?? [];

  async function ensureRecipe(current: DocumentReadModel) {
    if (recipe) return recipe;
    const response = await api.createProcessingRecipe(workspaceId, current.document.document_id, "Export without corrections", []);
    setRecipe(response.recipe);
    return response.recipe;
  }

  async function submit() {
    if (!selectedArtboards.size || !profiles.length) return;
    setBusy("submit");
    setError(null);
    try {
      const current = await prepareDocument();
      const selectedRecipe = await ensureRecipe(current);
      const artboards = current.snapshot.artboards.filter((item) => selectedArtboards.has(item.artboard_id));
      const outputs = artboards.flatMap((artboard) => profiles.map((profile, profileIndex) => ({
        artboard_id: artboard.artboard_id,
        profile,
        filename: renderFilename(profile.filename_template ?? "{document}-{artboard}-{profile}", current.document.name, artboard.name, profile.name, profile.format, profileIndex),
      })));
      const response = await api.submitImageExport(workspaceId, current.document.document_id, {
        document_version_id: current.document.current_version_id,
        recipe_id: selectedRecipe.recipe_id,
        recipe_version: selectedRecipe.version,
        outputs,
      });
      setActiveExport(response.export_request);
      setExports((values) => [response.export_request, ...values.filter((item) => item.export_request_id !== response.export_request.export_request_id)]);
      setStep("monitor");
    } catch (reason) {
      setError(message(reason, "The export could not be submitted"));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!activeExport) return;
    setBusy("cancel");
    try {
      const response = await api.cancelImageExport(workspaceId, activeExport.export_request_id);
      setActiveExport(response.export_request);
    } catch (reason) { setError(message(reason, "Cancellation could not be requested")); }
    finally { setBusy(null); }
  }

  async function retry() {
    if (!activeExport) return;
    setBusy("retry");
    try {
      const response = await api.retryImageExport(workspaceId, activeExport.export_request_id);
      setActiveExport(response.export_request);
    } catch (reason) { setError(message(reason, "Failed outputs could not be retried")); }
    finally { setBusy(null); }
  }

  async function createBundle() {
    if (!activeExport || !successful.length) return;
    setBusy("bundle");
    try {
      const response = await api.createExportBundle(workspaceId, activeExport.export_request_id);
      setBundle(response.bundle);
    } catch (reason) { setError(message(reason, "The ZIP bundle could not be created")); }
    finally { setBusy(null); }
  }

  function repeatLast() {
    const last = exports.find((item) => item.state === "completed" || item.state === "partially_completed");
    if (!last) return;
    const uniqueProfiles = new Map(last.outputs.map((item) => [item.profile.profile_id, { ...item.profile, profile_id: `profile-${crypto.randomUUID()}` }]));
    setProfiles([...uniqueProfiles.values()]);
    setSelectedArtboards(new Set(last.outputs.map((item) => item.artboard_id)));
    setStep("configure");
  }

  return <Dialog open={open} title="Export Center" onClose={onClose}>
    <div className="export-center" data-testid="export-center">
      <nav className="export-steps" aria-label="Export steps">
        <button type="button" aria-current={step === "configure" ? "step" : undefined} onClick={() => setStep("configure")}><span>1</span>Configure</button>
        <button type="button" aria-current={step === "monitor" ? "step" : undefined} disabled={!activeExport} onClick={() => setStep("monitor")}><span>2</span>Monitor and download</button>
      </nav>
      {error && <InlineNotice tone="error" title="Export needs attention">{error}</InlineNotice>}
      {step === "configure" ? <div className="export-configure">
        <section className="export-main" aria-labelledby="export-output-heading">
          <div className="export-section-heading"><span><strong id="export-output-heading">Output presets</strong><small>Add one or several independent outputs.</small></span>{exports.some((item) => item.state === "completed") && <Button type="button" size="compact" onClick={repeatLast}><RotateCcw aria-hidden="true" />Repeat last successful</Button>}</div>
          <div className="export-preset-grid">{OUTPUT_PRESETS.map((item) => {
            const Icon = item.icon;
            return <button type="button" key={item.id} onClick={() => setProfiles((current) => [...current, profileFromPreset(item)])}><Icon aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.detail}</small></span><Plus aria-hidden="true" /></button>;
          })}</div>
          <button className="export-preset-disabled" type="button" disabled title="AVIF requires executable capability and licence validation"><FileImage aria-hidden="true" /><span><strong>AVIF</strong><small>Not available in this build</small></span></button>

          <div className="export-profile-list">{profiles.map((profile, index) => <ProfileEditor key={profile.profile_id} profile={profile} index={index} update={(next) => setProfiles((current) => current.map((item) => item.profile_id === profile.profile_id ? next : item))} remove={() => setProfiles((current) => current.filter((item) => item.profile_id !== profile.profile_id))} />)}</div>
        </section>
        <aside className="export-summary" aria-label="Export summary">
          <section><strong>Artboards</strong>{editor.snapshot.artboards.map((artboard) => <label key={artboard.artboard_id}><input type="checkbox" checked={selectedArtboards.has(artboard.artboard_id)} onChange={() => setSelectedArtboards((current) => toggleSet(current, artboard.artboard_id))} />{artboard.name}<small>{Math.round(artboard.width)} x {Math.round(artboard.height)} px</small></label>)}</section>
          <section><strong>Destination</strong><label className="export-select-label">Save to<select><option>Workspace downloads</option></select></label><small>Completed derivatives remain private. Downloads are authorised and retention-controlled.</small></section>
          <section className="privacy-summary"><strong><ShieldCheck aria-hidden="true" />Privacy by default</strong><span>GPS, private metadata and embedded thumbnails are removed. Each completed file is inspected to verify the decision.</span></section>
          <section className="size-estimate"><strong>Estimated total</strong><span>{formatBytes(estimate.minimum)} to {formatBytes(estimate.maximum)}</span><small>Range based on dimensions and format. Content complexity changes the final size.</small></section>
          <div className="export-total"><span>{outputCount} {outputCount === 1 ? "output" : "outputs"}</span><span>{selectedArtboards.size} artboards x {profiles.length} profiles</span></div>
          <Button type="button" tone="primary" disabled={busy !== null || outputCount < 1} onClick={() => void submit()}>{busy === "submit" ? "Submitting export..." : `Export ${outputCount || ""} ${outputCount === 1 ? "output" : "outputs"}`}</Button>
          <small className="zero-charge">Free during testing. This action records zero charge.</small>
        </aside>
      </div> : <ExportMonitor workspaceId={workspaceId} request={activeExport} bundle={bundle} busy={busy} successful={successful} failed={failed} cancel={cancel} retry={retry} createBundle={createBundle} configure={() => setStep("configure")} />}
    </div>
  </Dialog>;
}

function ProfileEditor({ profile, index, update, remove }: { profile: ExportOutputProfile; index: number; update: (profile: ExportOutputProfile) => void; remove: () => void }) {
  const sizing = profile.percentage ? "percentage" : profile.physical_width || profile.physical_height ? "physical" : profile.width || profile.height ? "pixels" : "original";
  const setFormat = (format: ImageExportFormat) => update({
    ...profile,
    format,
    alpha_behavior: format === "jpeg" ? "flatten" : profile.alpha_behavior === "flatten" ? "flatten" : "preserve",
    background: format === "jpeg" ? (profile.background ?? "#FFFFFF") : profile.alpha_behavior === "flatten" ? profile.background : null,
    lossless: ["png", "tiff"].includes(format) ? profile.lossless : false,
    chroma_subsampling: format === "jpeg" ? (profile.chroma_subsampling ?? "4:2:0") : null,
  });
  const setSizing = (value: string) => update({ ...profile,
    width: value === "pixels" ? 1600 : null, height: null,
    percentage: value === "percentage" ? 100 : null,
    physical_width: value === "physical" ? 8 : null, physical_height: null,
    physical_unit: value === "physical" ? "in" : null, ppi: value === "physical" ? 300 : null,
  });
  return <details className="export-profile" open={index === 0}>
    <summary><FileImage aria-hidden="true" /><span><strong>{profile.name}</strong><small>{profile.format.toUpperCase()} | {sizeSummary(profile)}</small></span><button type="button" aria-label={`Remove ${profile.name}`} onClick={(event) => { event.preventDefault(); remove(); }}><Trash2 aria-hidden="true" /></button></summary>
    <div className="profile-fields">
      <label>Profile name<input value={profile.name} maxLength={100} onChange={(event) => update({ ...profile, name: event.target.value })} /></label>
      <div className="format-segments" role="group" aria-label={`Format for ${profile.name}`}>{(["jpeg", "png", "webp", "tiff"] as ImageExportFormat[]).map((format) => <button key={format} type="button" aria-pressed={profile.format === format} onClick={() => setFormat(format)}>{format.toUpperCase()}</button>)}</div>
      <div className="two-field-grid"><label>Purpose<select value={profile.purpose} onChange={(event) => update({ ...profile, purpose: event.target.value as ExportPurpose })}><option value="archival_derivative">Archival derivative</option><option value="web">Web</option><option value="email">Email</option><option value="social">Social</option><option value="presentation">Presentation</option><option value="high_resolution_digital">High-resolution digital</option><option value="custom">Custom</option></select></label><label>Size<select value={sizing} onChange={(event) => setSizing(event.target.value)}><option value="original">Original dimensions</option><option value="pixels">Pixels</option><option value="percentage">Percentage</option><option value="physical">Physical size</option></select></label></div>
      {sizing === "pixels" && <div className="two-field-grid"><label>Width px<input type="number" min={1} max={100000} value={profile.width ?? ""} onChange={(event) => update({ ...profile, width: event.target.value ? Number(event.target.value) : null })} /></label><label>Height px<input type="number" min={1} max={100000} value={profile.height ?? ""} onChange={(event) => update({ ...profile, height: event.target.value ? Number(event.target.value) : null })} /></label></div>}
      {sizing === "percentage" && <label>Scale %<input type="number" min={0.01} max={1000} step={0.01} value={profile.percentage ?? 100} onChange={(event) => update({ ...profile, percentage: Number(event.target.value) })} /></label>}
      {sizing === "physical" && <div className="physical-grid"><label>Width<input type="number" min={0.001} step={0.01} value={profile.physical_width ?? ""} onChange={(event) => update({ ...profile, physical_width: event.target.value ? Number(event.target.value) : null })} /></label><label>Height<input type="number" min={0.001} step={0.01} value={profile.physical_height ?? ""} onChange={(event) => update({ ...profile, physical_height: event.target.value ? Number(event.target.value) : null })} /></label><label>Unit<select value={profile.physical_unit ?? "in"} onChange={(event) => update({ ...profile, physical_unit: event.target.value as "in" | "mm" | "cm" })}><option value="in">in</option><option value="mm">mm</option><option value="cm">cm</option></select></label><label>PPI<input type="number" min={1} max={9600} value={profile.ppi ?? 300} onChange={(event) => update({ ...profile, ppi: Number(event.target.value) })} /></label></div>}
      <div className="two-field-grid"><label>Fit<select value={profile.fit ?? "contain"} onChange={(event) => update({ ...profile, fit: event.target.value as "contain" | "cover" | "stretch" })}><option value="contain">Contain</option><option value="cover">Cover</option><option value="stretch">Stretch</option></select></label><label>Resampling<select value={profile.resampling_algorithm ?? "lanczos"} onChange={(event) => update({ ...profile, resampling_algorithm: event.target.value as ExportOutputProfile["resampling_algorithm"] })}><option value="nearest">Nearest</option><option value="bilinear">Bilinear</option><option value="bicubic">Bicubic</option><option value="lanczos">Lanczos</option></select></label></div>
      {!["png", "tiff"].includes(profile.format) && <label className="profile-range">Quality <output>{profile.quality ?? 82}</output><input type="range" min={1} max={100} value={profile.quality ?? 82} onChange={(event) => update({ ...profile, quality: Number(event.target.value) })} /></label>}
      {["png", "webp", "tiff"].includes(profile.format) && <label className="checkbox-control"><input type="checkbox" checked={profile.lossless ?? false} onChange={(event) => update({ ...profile, lossless: event.target.checked })} />Lossless encoding</label>}
      <details className="profile-advanced"><summary>Colour, metadata and naming</summary>
        <div className="two-field-grid"><label>Colour profile<select value={profile.colour_profile ?? "srgb"} onChange={(event) => update({ ...profile, colour_profile: event.target.value as "preserve" | "srgb" })}><option value="srgb">sRGB</option><option value="preserve">Preserve source profile</option><option disabled value="display-p3">Display P3 - processor required</option></select></label><label>Bit depth<select value={profile.bit_depth ?? 8} onChange={() => undefined}><option value="8">8-bit</option><option disabled value="16">16-bit - processor required</option></select></label></div>
        <div className="two-field-grid"><label>Transparency<select value={profile.alpha_behavior ?? "preserve"} onChange={(event) => update({ ...profile, alpha_behavior: event.target.value as "preserve" | "flatten", background: event.target.value === "flatten" ? (profile.background ?? "#FFFFFF") : null })}><option disabled={profile.format === "jpeg"} value="preserve">Preserve alpha</option><option value="flatten">Flatten on background</option></select></label>{profile.alpha_behavior === "flatten" && <label>Background<input type="color" value={profile.background ?? "#FFFFFF"} onChange={(event) => update({ ...profile, background: event.target.value.toUpperCase() })} /></label>}</div>
        {profile.format === "jpeg" && <label>Chroma subsampling<select value={profile.chroma_subsampling ?? "4:2:0"} onChange={(event) => update({ ...profile, chroma_subsampling: event.target.value as "4:4:4" | "4:2:2" | "4:2:0" })}><option value="4:4:4">4:4:4</option><option value="4:2:2">4:2:2</option><option value="4:2:0">4:2:0</option></select></label>}
        <fieldset className="metadata-policy"><legend>Metadata to retain</legend><p>GPS and embedded thumbnails are always removed.</p><label><input type="checkbox" checked={profile.metadata_policy?.preserve_copyright ?? true} onChange={(event) => updateMetadata(profile, update, "preserve_copyright", event.target.checked)} />Copyright</label><label><input type="checkbox" checked={profile.metadata_policy?.preserve_description ?? false} onChange={(event) => updateMetadata(profile, update, "preserve_description", event.target.checked)} />Description</label><label><input type="checkbox" checked={profile.metadata_policy?.preserve_capture_time ?? false} onChange={(event) => updateMetadata(profile, update, "preserve_capture_time", event.target.checked)} />Capture time</label><label><input type="checkbox" checked={profile.metadata_policy?.preserve_camera ?? false} onChange={(event) => updateMetadata(profile, update, "preserve_camera", event.target.checked)} />Camera details</label></fieldset>
        <label>Filename template<input value={profile.filename_template ?? "{document}-{artboard}-{profile}"} onChange={(event) => update({ ...profile, filename_template: event.target.value })} /></label>
        <label>Filename collision<select value={profile.collision_behavior ?? "suffix"} onChange={(event) => update({ ...profile, collision_behavior: event.target.value as "suffix" | "fail" })}><option value="suffix">Add a numeric suffix</option><option value="fail">Stop the colliding output</option></select></label>
      </details>
    </div>
  </details>;
}

function ExportMonitor({ workspaceId, request, bundle, busy, successful, failed, cancel, retry, createBundle, configure }: {
  workspaceId: string;
  request: ImageExportRequestRecord | null;
  bundle: ExportZipBundle | null;
  busy: string | null;
  successful: ExportOutputRecord[];
  failed: ExportOutputRecord[];
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
  createBundle: () => Promise<void>;
  configure: () => void;
}) {
  if (!request) return <div className="export-monitor-empty"><FileImage aria-hidden="true" /><strong>No export submitted</strong><Button type="button" onClick={configure}>Configure outputs</Button></div>;
  const terminal = ["completed", "failed", "cancelled"].includes(request.state);
  return <div className="export-monitor" data-export-state={request.state}>
    <div className="export-monitor-heading"><span><strong>{stateLabel(request.state)}</strong><small>Durable job {request.job_id}</small></span><span className={`export-state state-${request.state}`}>{request.state.replaceAll("_", " ")}</span></div>
    <div className="export-integrity-note"><ShieldCheck aria-hidden="true" /><span><strong>Full-resolution worker render</strong><small>The immutable source and confirmed recipe are authoritative. Completed outputs remain available if another output fails.</small></span></div>
    <div className="export-output-list">{request.outputs.map((output) => <article key={output.output_id} data-output-state={output.state}>
      <span className="output-state-icon">{output.state === "succeeded" ? <CheckCircle2 aria-hidden="true" /> : output.state === "failed" ? <XCircle aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}</span>
      <span className="output-copy"><strong>{output.filename}</strong><small>{output.profile.name} | {output.profile.format.toUpperCase()}{output.width && output.height ? ` | ${output.width} x ${output.height} px` : ""}</small>{output.failure_message && <em>{output.failure_message}</em>}{output.sha256 && <details><summary>Verified details</summary><code>SHA-256 {output.sha256}</code><span>{formatBytes(output.byte_size ?? 0)} | integrity verified after metadata removal</span></details>}</span>
      <span className="output-progress">{["queued", "running"].includes(output.state) ? <Progress value={output.progress_percent} label={output.state === "queued" ? "Waiting" : "Rendering"} /> : <span>{output.state}</span>}</span>
      {output.state === "succeeded" && <a className="ds-button ds-button-secondary ds-button-compact" href={api.exportOutputDownloadUrl(workspaceId, output.output_id)}><Download aria-hidden="true" />Download</a>}
    </article>)}</div>
    {request.state === "partially_completed" && <InlineNotice tone="warning" title={`${successful.length} completed, ${failed.length} need attention`}>Completed derivatives are retained. Retry starts only the failed outputs.</InlineNotice>}
    <footer className="export-monitor-actions">
      <Button type="button" onClick={configure}>New export</Button>
      {!terminal && <Button type="button" disabled={busy !== null} onClick={() => void cancel()}>Cancel remaining</Button>}
      {failed.length > 0 && <Button type="button" tone="primary" disabled={busy !== null} onClick={() => void retry()}><RefreshCw aria-hidden="true" />Retry failed only</Button>}
      {successful.length > 0 && <Button type="button" disabled={busy !== null || bundle?.state === "queued" || bundle?.state === "running"} onClick={() => void createBundle()}><FileArchive aria-hidden="true" />Create ZIP of completed</Button>}
      {bundle?.state === "succeeded" && <a className="ds-button ds-button-primary ds-button-normal" href={api.exportBundleDownloadUrl(workspaceId, bundle.bundle_id)}><Download aria-hidden="true" />Download ZIP</a>}
    </footer>
    {bundle && <div className="bundle-status" role="status"><FileArchive aria-hidden="true" /><span><strong>ZIP {bundle.state}</strong><small>{bundle.items.length} verified files | expires {new Date(bundle.expires_at).toLocaleDateString()}</small></span></div>}
    <p className="durable-reconnect">You can close this window. PostgreSQL retains job state and completed output checkpoints for reconnect and queue redelivery.</p>
  </div>;
}

function preset(id: string, label: string, detail: string, icon: typeof Globe2, purpose: ExportPurpose, format: ImageExportFormat, overrides: Partial<ExportOutputProfile>): OutputPreset {
  return { id, label, detail, icon, profile: {
    name: label,
    purpose,
    format,
    width: null, height: null, percentage: null,
    physical_width: null, physical_height: null, physical_unit: null, ppi: null,
    fit: "contain", quality: 82, lossless: false, resampling_algorithm: "lanczos",
    colour_profile: "srgb", bit_depth: 8, alpha_behavior: "preserve", background: null,
    metadata_policy: METADATA_DEFAULT, chroma_subsampling: null,
    filename_template: "{document}-{artboard}-{profile}", collision_behavior: "suffix",
    ...overrides,
  } };
}

function profileFromPreset(value: OutputPreset): ExportOutputProfile {
  return { ...structuredClone(value.profile), profile_id: `profile-${crypto.randomUUID()}` };
}

function updateMetadata(profile: ExportOutputProfile, update: (profile: ExportOutputProfile) => void, key: "preserve_copyright" | "preserve_description" | "preserve_capture_time" | "preserve_camera", value: boolean) {
  update({ ...profile, metadata_policy: { ...METADATA_DEFAULT, ...profile.metadata_policy, [key]: value } });
}

function renderFilename(template: string, document: string, artboard: string, profile: string, format: ImageExportFormat, index: number) {
  const values: Record<string, string> = { document, artboard, profile };
  let result = template.replace(/\{(document|artboard|profile)\}/g, (_, key: string) => values[key] ?? "output");
  result = safeName(result || `output-${index + 1}`);
  const extension = format === "jpeg" ? ".jpg" : format === "tiff" ? ".tif" : `.${format}`;
  return result.toLowerCase().endsWith(extension) ? result : `${result}${extension}`;
}

function safeName(value: string) {
  return value.replace(/[\\/\0-\x1f\x7f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 200) || "output";
}

function toggleSet(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

function estimateRange(editor: DocumentReadModel, artboards: Set<string>, profiles: ExportOutputProfile[]) {
  let minimum = 0;
  let maximum = 0;
  for (const artboard of editor.snapshot.artboards.filter((item) => artboards.has(item.artboard_id))) {
    for (const profile of profiles) {
      const dimensions = profileDimensions(artboard.width, artboard.height, profile);
      const pixels = Math.max(1, dimensions.width * dimensions.height);
      const factors = profile.format === "jpeg" ? [0.08, 1.2] : profile.format === "webp" ? [0.05, 1.1] : profile.format === "png" ? [0.1, 4.2] : [0.2, 4.5];
      minimum += Math.max(256, Math.round(pixels * factors[0]));
      maximum += Math.max(1024, Math.round(pixels * factors[1]));
    }
  }
  return { minimum, maximum };
}

function profileDimensions(sourceWidth: number, sourceHeight: number, profile: ExportOutputProfile) {
  if (profile.percentage) return { width: Math.max(1, Math.round(sourceWidth * profile.percentage / 100)), height: Math.max(1, Math.round(sourceHeight * profile.percentage / 100)) };
  if (profile.physical_width || profile.physical_height) {
    const unit = profile.physical_unit ?? "in";
    const convert = (value: number) => unit === "mm" ? value / 25.4 : unit === "cm" ? value / 2.54 : value;
    const ppi = profile.ppi ?? 300;
    return { width: profile.physical_width ? Math.round(convert(profile.physical_width) * ppi) : Math.round(sourceWidth), height: profile.physical_height ? Math.round(convert(profile.physical_height) * ppi) : Math.round(sourceHeight) };
  }
  return { width: profile.width ?? Math.round(sourceWidth), height: profile.height ?? Math.round(sourceHeight) };
}

function sizeSummary(profile: ExportOutputProfile) {
  if (profile.percentage) return `${profile.percentage}%`;
  if (profile.physical_width || profile.physical_height) return `${profile.physical_width ?? "auto"} x ${profile.physical_height ?? "auto"} ${profile.physical_unit ?? "in"} at ${profile.ppi ?? 300} PPI`;
  if (profile.width || profile.height) return `${profile.width ?? "auto"} x ${profile.height ?? "auto"} px`;
  return "Original dimensions";
}

function stateLabel(state: ImageExportRequestRecord["state"]) {
  if (state === "queued") return "Export queued";
  if (state === "running") return "Rendering full-resolution outputs";
  if (state === "partially_completed") return "Some outputs need attention";
  if (state === "completed") return "Export complete";
  if (state === "cancelled") return "Remaining outputs cancelled";
  return "Export failed";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function message(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
