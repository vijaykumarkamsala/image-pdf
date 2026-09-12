import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Download, Eye, FileStack, Layers3, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import type {
  BatchCreateRequest,
  BatchPlan,
  BatchPlanGroup,
  BatchPlanRequest,
  BatchRunRecord,
  BatchSubmissionItem,
  DocumentReadModel,
  EditorDocumentRecord,
  EnhancementPreview,
  ExportOutputProfile,
  ImageExportFormat,
  ProcessingRecipeRecord,
} from "ipw-contracts-ts/product";

import { api } from "../boundaries/apiClient";
import { Button, InlineNotice, Progress, StatePanel } from "../design-system";
import { workspacePath } from "../routes";

type Step = "select" | "review" | "monitor";
type Busy = "load" | "plan" | "preview" | "submit" | "cancel" | "retry" | "report" | null;

interface PreparedItem {
  editor: DocumentReadModel;
  recipe: ProcessingRecipeRecord;
  request: BatchSubmissionItem;
}

export function BatchWorkspace({ canCreate }: { canCreate: boolean }) {
  const { workspaceId = "" } = useParams();
  const [documents, setDocuments] = useState<EditorDocumentRecord[] | null>(null);
  const [history, setHistory] = useState<BatchRunRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [name, setName] = useState("Image batch");
  const [format, setFormat] = useState<ImageExportFormat>("png");
  const [width, setWidth] = useState(1600);
  const [step, setStep] = useState<Step>("select");
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [plannedRequest, setPlannedRequest] = useState<BatchPlanRequest | null>(null);
  const [submitIdempotencyKey, setSubmitIdempotencyKey] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Map<string, PreparedItem>>(new Map());
  const [previews, setPreviews] = useState<Map<string, EnhancementPreview>>(new Map());
  const [approvedGroups, setApprovedGroups] = useState<Set<string>>(new Set());
  const [confirmedItems, setConfirmedItems] = useState<Set<string>>(new Set());
  const [activeBatch, setActiveBatch] = useState<BatchRunRecord | null>(null);
  const [busy, setBusy] = useState<Busy>("load");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setBusy("load");
    void Promise.all([api.documents(workspaceId), api.imageBatches(workspaceId)]).then(
      ([documentResult, batchResult]) => {
        if (!active) return;
        setDocuments(documentResult.documents);
        setHistory(batchResult.batches);
      },
      (reason: unknown) => active && setError(message(reason, "Batch workspace could not be loaded")),
    ).finally(() => active && setBusy(null));
    return () => { active = false; };
  }, [workspaceId]);

  useEffect(() => {
    if (!activeBatch || terminal(activeBatch.state)) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await api.imageBatch(workspaceId, activeBatch.batch_id);
        if (!active) return;
        setActiveBatch(response.batch);
        setHistory((current) => [response.batch, ...current.filter((item) => item.batch_id !== response.batch.batch_id)]);
      } catch {
        // Durable state remains visible and is retried after a transient disconnect.
      }
    };
    const timer = window.setInterval(() => void refresh(), 1500);
    void refresh();
    return () => { active = false; window.clearInterval(timer); };
  }, [activeBatch?.batch_id, activeBatch?.state, workspaceId]);

  useEffect(() => {
    const pending = [...previews.entries()].filter(([, preview]) => ["queued", "running"].includes(preview.state));
    if (!pending.length) return;
    let active = true;
    const refresh = async () => {
      const results = await Promise.allSettled(pending.map(async ([groupId, preview]) => ({
        groupId,
        preview: (await api.enhancementPreview(workspaceId, preview.preview_id)).preview,
      })));
      if (!active) return;
      setPreviews((current) => {
        const next = new Map(current);
        for (const result of results) if (result.status === "fulfilled") next.set(result.value.groupId, result.value.preview);
        return next;
      });
    };
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [previews, workspaceId]);

  const selectedDocuments = useMemo(
    () => (documents ?? []).filter((document) => selected.has(document.document_id)),
    [documents, selected],
  );
  const includedCount = selectedDocuments.filter((document) => !excluded.has(document.document_id)).length;
  const requiredRiskIds = plan?.items.filter((item) => item.requires_individual_confirmation)
    .map((item) => item.client_item_id) ?? [];
  const reviewReady = Boolean(plan)
    && plan!.groups.every((group) => approvedGroups.has(group.group_id)
      && previews.get(group.group_id)?.state === "succeeded")
    && requiredRiskIds.every((id) => confirmedItems.has(id));

  function toggleDocument(documentId: string) {
    setError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(documentId)) {
        next.delete(documentId);
        setExcluded((values) => {
          const copy = new Set(values);
          copy.delete(documentId);
          return copy;
        });
      } else if (next.size < 50) {
        next.add(documentId);
      } else {
        setError("A batch can contain at most 50 files.");
      }
      return next;
    });
  }

  function returnToSelection() {
    setStep("select");
    setPlan(null);
    setPlannedRequest(null);
    setSubmitIdempotencyKey(null);
    setPrepared(new Map());
    setPreviews(new Map());
    setApprovedGroups(new Set());
    setConfirmedItems(new Set());
  }

  function toggleExcluded(documentId: string) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId); else next.add(documentId);
      return next;
    });
  }

  async function buildPlan() {
    if (!selectedDocuments.length || includedCount < 1) return;
    setBusy("plan");
    setError(null);
    try {
      const values = await mapWithConcurrency(selectedDocuments, 5, async (document): Promise<PreparedItem> => {
        const [documentResponse, recipesResponse] = await Promise.all([
          api.document(workspaceId, document.document_id),
          api.processingRecipes(workspaceId, document.document_id),
        ]);
        const recipe = [...recipesResponse.recipes]
          .sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.version - right.version)
          .at(-1)
          ?? (await api.createProcessingRecipe(workspaceId, document.document_id, "Export without corrections", [])).recipe;
        const editor = documentResponse.editor;
        const artboard = editor.snapshot.artboards[0];
        if (!artboard) throw new Error(`${document.name} has no exportable artboard.`);
        const isIncluded = !excluded.has(document.document_id);
        return {
          editor,
          recipe,
          request: {
            client_item_id: document.document_id,
            display_name: document.name,
            document_id: document.document_id,
            document_version_id: editor.document.current_version_id,
            recipe_id: recipe.recipe_id,
            recipe_version: recipe.version,
            outputs: [{
              artboard_id: artboard.artboard_id,
              filename: `${safeName(document.name)}.${extension(format)}`,
              profile: outputProfile(format, width),
            }],
            included: isIncluded,
            exclusion_reason: isIncluded ? null : "Excluded during batch review",
          },
        };
      });
      const request: BatchPlanRequest = { name: name.trim(), items: values.map((item) => item.request) };
      const response = await api.planImageBatch(workspaceId, request);
      const byId = new Map(values.map((item) => [item.request.client_item_id, item]));
      setPrepared(byId);
      setPlannedRequest(request);
      setSubmitIdempotencyKey(`batch-submit-${crypto.randomUUID()}`);
      setPlan(response.plan);
      setApprovedGroups(new Set());
      setConfirmedItems(new Set());
      setPreviews(new Map());
      setStep("review");
      await requestPreviews(response.plan.groups, byId);
    } catch (reason) {
      setError(message(reason, "The batch plan could not be prepared"));
    } finally {
      setBusy(null);
    }
  }

  async function requestPreviews(groups: BatchPlanGroup[], values = prepared) {
    setBusy("preview");
    const results = await mapWithConcurrency(groups, 5, async (group) => {
      try {
        const item = values.get(group.representative_client_item_id);
        if (!item) throw new Error("The representative item is no longer available.");
        const artboard = item.editor.snapshot.artboards[0];
        if (!artboard) throw new Error(`${item.editor.document.name} has no exportable artboard.`);
        return {
          status: "fulfilled" as const,
          value: {
            groupId: group.group_id,
            preview: (await api.requestEnhancementPreview(
              workspaceId,
              item.editor.document.document_id,
              item.recipe.recipe_id,
              item.recipe.version,
              "current",
              artboard.artboard_id,
            )).preview,
          },
        };
      } catch (reason) {
        return { status: "rejected" as const, reason };
      }
    });
    setPreviews((current) => {
      const next = new Map(current);
      for (const result of results) if (result.status === "fulfilled") next.set(result.value.groupId, result.value.preview);
      return next;
    });
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") setError(message(rejected.reason, "A representative preview could not be requested"));
    setBusy(null);
  }

  async function submitBatch() {
    if (!plan || !plannedRequest || !submitIdempotencyKey || !reviewReady) return;
    setBusy("submit");
    setError(null);
    try {
      const input: BatchCreateRequest = {
        ...plannedRequest,
        plan_sha256: plan.plan_sha256,
        group_approvals: plan.groups.map((group) => ({
          group_id: group.group_id,
          representative_client_item_id: group.representative_client_item_id,
          representative_preview_id: previews.get(group.group_id)!.preview_id,
          confirmation_state: "confirmed",
        })),
        confirmed_client_item_ids: requiredRiskIds,
      };
      const response = await api.submitImageBatch(workspaceId, input, submitIdempotencyKey);
      setActiveBatch(response.batch);
      setHistory((current) => [response.batch, ...current.filter((item) => item.batch_id !== response.batch.batch_id)]);
      setStep("monitor");
    } catch (reason) {
      setError(message(reason, "The reviewed batch could not be submitted"));
    } finally {
      setBusy(null);
    }
  }

  async function cancelBatch() {
    if (!activeBatch) return;
    setBusy("cancel");
    setError(null);
    try {
      const response = await api.cancelImageBatch(workspaceId, activeBatch.batch_id);
      setActiveBatch(response.batch);
      setHistory((current) => [response.batch, ...current.filter((item) => item.batch_id !== response.batch.batch_id)]);
    } catch (reason) {
      setError(message(reason, "Pending batch work could not be cancelled"));
    } finally {
      setBusy(null);
    }
  }

  async function retryBatch() {
    if (!activeBatch) return;
    setBusy("retry");
    setError(null);
    try {
      const response = await api.retryImageBatch(workspaceId, activeBatch.batch_id);
      setActiveBatch(response.batch);
      setHistory((current) => [response.batch, ...current.filter((item) => item.batch_id !== response.batch.batch_id)]);
    } catch (reason) {
      setError(message(reason, "Failed batch items could not be retried"));
    } finally {
      setBusy(null);
    }
  }

  async function downloadReport() {
    if (!activeBatch) return;
    setBusy("report");
    setError(null);
    try {
      const response = await api.imageBatchReport(workspaceId, activeBatch.batch_id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(response.report, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${safeName(activeBatch.name)}-report.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) {
      setError(message(reason, "The batch report could not be generated"));
    } finally {
      setBusy(null);
    }
  }

  function startAnother() {
    returnToSelection();
    setActiveBatch(null);
    setError(null);
  }

  if (busy === "load" && documents === null) {
    return <main className="batch-page"><StatePanel kind="loading" title="Loading batch workspace" message="Retrieving native documents and durable batch history." /></main>;
  }

  return <main className="batch-page" data-testid="batch-workspace">
    <header className="batch-hero">
      <div>
        <Link className="batch-back" to={workspacePath(workspaceId, "files")}><ArrowLeft aria-hidden="true" />Files</Link>
        <span className="batch-kicker"><Layers3 aria-hidden="true" />Image Studio</span>
        <h1>Batch processing</h1>
        <p>Apply reviewed image recipes across independent files. Every output keeps its own job, provenance, retry path and failure boundary.</p>
      </div>
      <div className="batch-trust"><ShieldCheck aria-hidden="true" /><span><strong>Originals remain immutable</strong><small>Private derivatives · zero charge during testing</small></span></div>
    </header>

    {canCreate && <nav className="batch-steps" aria-label="Batch processing steps">
      {(["select", "review", "monitor"] as Step[]).map((value, index) => <button
        type="button"
        key={value}
        aria-current={step === value ? "step" : undefined}
        disabled={(value === "review" && !plan) || (value === "monitor" && !activeBatch)}
        onClick={() => value === "select" ? returnToSelection() : setStep(value)}
      ><span>{index + 1}</span>{value === "select" ? "Select and configure" : value === "review" ? "Review groups" : "Monitor and report"}</button>)}
    </nav>}

    {error && <InlineNotice tone="error" title="Batch needs attention">{error}</InlineNotice>}

    {step === "select" && !canCreate && <section className="batch-panel"><StatePanel kind="empty" title="Batch history access" message="You can review durable batch runs in this workspace. Creating or changing a batch requires edit access." /></section>}

    {step === "select" && canCreate && <div className="batch-select-layout">
      <section className="batch-panel" aria-labelledby="batch-files-heading">
        <div className="batch-panel-heading"><div><h2 id="batch-files-heading">Choose native documents</h2><p>Select up to 50. Files are validated independently before the review plan is created.</p></div><strong>{selected.size}/50 selected</strong></div>
        {!documents?.length ? <StatePanel kind="empty" title="No native documents" message="Create an image document in Studio before starting a batch." /> : <div className="batch-document-list" role="list">
          {documents.map((document) => <label key={document.document_id} className={selected.has(document.document_id) ? "selected" : ""}>
            <input type="checkbox" checked={selected.has(document.document_id)} onChange={() => toggleDocument(document.document_id)} />
            <span className="batch-file-icon"><FileStack aria-hidden="true" /></span>
            <span><strong>{document.name}</strong><small>Native image document · immutable version selected at review</small></span>
            <em>{document.preview_state === "ready" ? "Ready" : (document.preview_state ?? "ready").replaceAll("_", " ")}</em>
          </label>)}
        </div>}
      </section>

      <aside className="batch-panel batch-config" aria-labelledby="batch-settings-heading">
        <div className="batch-panel-heading"><div><h2 id="batch-settings-heading">Run settings</h2><p>The latest saved recipe is used for each file.</p></div></div>
        <label>Batch name<input maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="batch-field-row"><label>Format<select value={format} onChange={(event) => setFormat(event.target.value as ImageExportFormat)}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option><option value="tiff">TIFF</option></select></label><label>Maximum width<input type="number" min={1} max={12000} value={width} onChange={(event) => setWidth(Math.max(1, Math.min(12000, Number(event.target.value) || 1)))} /></label></div>
        <small className="batch-field-help">Standard resampling only. This workflow does not reconstruct or invent detail.</small>
        <div className="batch-inclusion-list">
          <strong>Included in this run</strong>
          {selectedDocuments.length ? selectedDocuments.map((document) => <label key={document.document_id}>
            <input type="checkbox" checked={!excluded.has(document.document_id)} onChange={() => toggleExcluded(document.document_id)} />
            <span>{document.name}</span><small>{excluded.has(document.document_id) ? "Excluded with a recorded reason" : "Process"}</small>
          </label>) : <p>Select documents to configure inclusion.</p>}
        </div>
        <div className="batch-summary-line"><span>{includedCount} processing</span><span>{selected.size - includedCount} excluded</span></div>
        <Button tone="primary" disabled={busy !== null || !name.trim() || !selected.size || includedCount < 1} onClick={() => void buildPlan()}>{busy === "plan" ? "Analysing files..." : "Create review plan"}</Button>
      </aside>
    </div>}

    {step === "review" && plan && <section className="batch-review" aria-labelledby="batch-review-heading">
      <div className="batch-panel-heading"><div><h2 id="batch-review-heading">Review compatible groups</h2><p>{plan.included_count} files form {plan.groups.length} compatible {plan.groups.length === 1 ? "group" : "groups"}. Only surfaced exceptions need per-file confirmation.</p></div><Button onClick={returnToSelection}>Change selection</Button></div>
      <div className="batch-plan-metrics"><Metric value={plan.included_count} label="Included" /><Metric value={plan.excluded_count} label="Excluded" /><Metric value={plan.groups.length} label="Recipe groups" /><Metric value={requiredRiskIds.length} label="Exceptions" /></div>
      <div className="batch-group-list">{plan.groups.map((group) => {
        const preview = previews.get(group.group_id);
        const representative = prepared.get(group.representative_client_item_id);
        const succeeded = preview?.state === "succeeded";
        return <article className="batch-group-card" key={group.group_id}>
          <div className="batch-group-copy"><span className="batch-group-icon"><Layers3 aria-hidden="true" /></span><div><h3>{group.label}</h3><p>{group.client_item_ids.length} {group.client_item_ids.length === 1 ? "file" : "files"} · representative: {representative?.editor.document.name}</p><code>{group.compatibility_sha256.slice(0, 16)}</code></div></div>
          <div className={`batch-preview state-${preview?.state ?? "loading"}`}>
            {succeeded ? <img src={api.exportOutputDownloadUrl(workspaceId, preview.output_id)} alt={`Representative preview for ${representative?.editor.document.name ?? "batch group"}`} /> : <span>{preview?.state === "failed" ? <XCircle aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}<strong>{preview?.state === "failed" ? "Preview failed" : "Preparing preview"}</strong><small>{preview?.failure_message ?? "Rendered by the authoritative image worker"}</small></span>}
          </div>
          {preview?.state === "failed" && <Button size="compact" disabled={busy !== null} onClick={() => void requestPreviews([group])}><RefreshCw aria-hidden="true" />Retry preview</Button>}
          <label className="batch-approval"><input type="checkbox" disabled={!succeeded} checked={approvedGroups.has(group.group_id)} onChange={() => setApprovedGroups((current) => toggle(current, group.group_id))} /><span><strong>I reviewed this representative preview</strong><small>Approval applies only to files with the same measured processing compatibility.</small></span></label>
        </article>;
      })}</div>
      {requiredRiskIds.length > 0 && <section className="batch-risk-review"><h3>File-specific exceptions</h3><p>These files differ in ways that need explicit confirmation.</p>{plan.items.filter((item) => item.requires_individual_confirmation).map((item) => <label key={item.client_item_id}><input type="checkbox" checked={confirmedItems.has(item.client_item_id)} onChange={() => setConfirmedItems((current) => toggle(current, item.client_item_id))} /><span><strong>{prepared.get(item.client_item_id)?.editor.document.name}</strong><small>{item.exception_codes.map(exceptionLabel).join(" · ")}</small></span></label>)}</section>}
      <footer className="batch-review-actions"><span><strong>{approvedGroups.size}/{plan.groups.length} groups reviewed</strong><small>{confirmedItems.size}/{requiredRiskIds.length} exceptions confirmed</small></span><Button tone="primary" disabled={busy !== null || !reviewReady} onClick={() => void submitBatch()}>{busy === "submit" ? "Starting batch..." : `Start ${plan.included_count}-file batch`}</Button></footer>
    </section>}

    {step === "monitor" && <section className="batch-monitor" aria-labelledby="batch-monitor-heading">
      {!activeBatch ? <StatePanel kind="empty" title="No batch selected" message="Open a prior run or create a new reviewed batch." /> : <>
        <div className="batch-panel-heading"><div><h2 id="batch-monitor-heading">{activeBatch.name}</h2><p>Durable progress continues if this page is closed. Completed files are retained when another file fails.</p></div><span className={`batch-state state-${activeBatch.state}`}>{activeBatch.state.replaceAll("_", " ")}</span></div>
        <div className="batch-plan-metrics"><Metric value={activeBatch.succeeded_count} label="Succeeded" /><Metric value={activeBatch.running_count + activeBatch.queued_count} label="Remaining" /><Metric value={activeBatch.failed_count} label="Failed" /><Metric value={activeBatch.cancelled_count} label="Cancelled" /></div>
        <Progress value={overallProgress(activeBatch)} label="Overall batch progress" />
        <div className="batch-item-table" role="table" aria-label="Batch item status">
          <div role="row" className="batch-item-header"><span role="columnheader">File</span><span role="columnheader">Status</span><span role="columnheader">Progress</span><span role="columnheader">Evidence</span></div>
          {activeBatch.items.map((item) => <div role="row" className="batch-item-row" key={item.batch_item_id} data-state={item.state}><span role="cell"><strong>{item.display_name}</strong><small>{item.output_count} {item.output_count === 1 ? "output" : "outputs"}</small></span><span role="cell"><StateIcon state={item.state} />{item.state.replaceAll("_", " ")}</span><span role="cell"><Progress value={item.progress_percent} label={`${item.display_name} progress`} /></span><span role="cell">{item.last_checkpoint_key ? <small>Checkpoint: {item.last_checkpoint_key}</small> : item.failure_message ? <small className="batch-failure">{item.failure_message}</small> : <small>{item.succeeded_output_count} verified</small>}</span></div>)}
        </div>
        <footer className="batch-monitor-actions"><Button onClick={startAnother}>New batch</Button>{!terminal(activeBatch.state) && <Button disabled={busy !== null} onClick={() => void cancelBatch()}>Cancel pending</Button>}{activeBatch.failed_count > 0 && <Button tone="primary" disabled={busy !== null} onClick={() => void retryBatch()}><RefreshCw aria-hidden="true" />Retry failed only</Button>}<Button disabled={busy !== null} onClick={() => void downloadReport()}><Download aria-hidden="true" />Download report</Button></footer>
      </>}
    </section>}

    {history.length > 0 && <section className="batch-history" aria-labelledby="batch-history-heading"><div className="batch-panel-heading"><div><h2 id="batch-history-heading">Recent batches</h2><p>Reopen durable runs without recreating their settings.</p></div></div><div>{history.map((batch) => <button type="button" key={batch.batch_id} onClick={() => { setActiveBatch(batch); setStep("monitor"); }}><span><strong>{batch.name}</strong><small>{batch.item_count} files · {new Date(batch.created_at).toLocaleString()}</small></span><span className={`batch-state state-${batch.state}`}>{batch.state.replaceAll("_", " ")}</span></button>)}</div></section>}
  </main>;
}

function Metric({ value, label }: { value: number; label: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function StateIcon({ state }: { state: BatchRunRecord["items"][number]["state"] }) {
  if (state === "succeeded") return <CheckCircle2 aria-hidden="true" />;
  if (state === "failed" || state === "cancelled") return <XCircle aria-hidden="true" />;
  if (state === "excluded") return <Eye aria-hidden="true" />;
  return <RefreshCw aria-hidden="true" />;
}

function outputProfile(format: ImageExportFormat, width: number): ExportOutputProfile {
  const lossy = format === "jpeg" || format === "webp";
  return {
    profile_id: `batch-${format}-${width}`,
    name: `${format.toUpperCase()} ${width}px`,
    purpose: "web",
    format,
    width,
    height: null,
    percentage: null,
    physical_width: null,
    physical_height: null,
    physical_unit: null,
    ppi: null,
    fit: "contain",
    quality: lossy ? 82 : null,
    lossless: !lossy,
    resampling_algorithm: "lanczos",
    colour_profile: "srgb",
    bit_depth: 8,
    alpha_behavior: format === "jpeg" ? "flatten" : "preserve",
    background: format === "jpeg" ? "#FFFFFF" : null,
    metadata_policy: {
      preserve_copyright: true,
      preserve_description: false,
      preserve_capture_time: false,
      preserve_camera: false,
      preserve_location: false,
      remove_embedded_thumbnails: true,
    },
    chroma_subsampling: format === "jpeg" ? "4:2:0" : null,
    filename_template: "{document}",
    collision_behavior: "suffix",
  };
}

function extension(format: ImageExportFormat) { return format === "jpeg" ? "jpg" : format === "tiff" ? "tif" : format; }
function safeName(value: string) { return value.replace(/[\\/\0-\x1f\x7f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 180) || "output"; }
function terminal(state: BatchRunRecord["state"]) { return ["completed", "partially_completed", "failed", "cancelled"].includes(state); }
function message(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback; }
function toggle(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}
function overallProgress(batch: BatchRunRecord): number {
  const included = batch.items.filter((item) => item.included);
  return included.length ? Math.floor(included.reduce((sum, item) => sum + item.progress_percent, 0) / included.length) : 100;
}
function exceptionLabel(code: string): string {
  if (code === "sensitive-metadata") return "Sensitive metadata will follow the reviewed export policy";
  if (code === "transparency-flattened") return "Transparency will be flattened on the selected background";
  if (code === "colour-conversion") return "Source colour will be converted through its validated ICC profile";
  return code.replaceAll("-", " ");
}
async function mapWithConcurrency<T, U>(values: T[], limit: number, work: (value: T) => Promise<U>): Promise<U[]> {
  const result: U[] = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await work(values[index]!);
    }
  }));
  return result;
}
