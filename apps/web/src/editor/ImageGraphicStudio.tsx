import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  BoxSelect,
  ChevronDown,
  ChevronUp,
  CopyPlus,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  Focus,
  Image as ImageIcon,
  Layers3,
  Lock,
  Blend,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  Redo2,
  RotateCw,
  Save,
  Shapes,
  Type,
  Undo2,
  Unlock,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  DocumentReadModel,
  CropRegion,
  EditorDocumentSnapshot,
  EditorMutation,
  ImportCompatibilityReport,
  LayerRecord,
  LayerTransform,
  ProjectRecord,
  StudioSourceCandidate,
  VisualAdjustments,
  WorkspaceFile,
} from "ipw-contracts-ts/product";

import { api, createTraceId } from "../boundaries/apiClient";
import { Button, Dialog, IconButton, InlineNotice, StatePanel, Tabs, TextInput, Tooltip } from "../design-system";
import { PanelFramework } from "../panels/PanelFramework";
import { workspacePath } from "../routes";
import { FabricEditorRenderer } from "./renderer/FabricEditorRenderer";
import type { EditorRenderer, RendererViewport } from "./renderer/EditorRenderer";
import { useDurableEditorSession, type SaveState } from "./useDurableEditorSession";

const PRESETS = [
  { id: "social", label: "Social post", detail: "1080 x 1080 px", width: 1080, height: 1080 },
  { id: "presentation", label: "Presentation", detail: "1920 x 1080 px", width: 1920, height: 1080 },
  { id: "print", label: "A4 print", detail: "2480 x 3508 px", width: 2480, height: 3508 },
] as const;

export function StudioStartPage() {
  const { workspaceId = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [sources, setSources] = useState<StudioSourceCandidate[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [sourceId, setSourceId] = useState(params.get("source") ?? "");
  const [projectId, setProjectId] = useState(params.get("project") ?? "");
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>(PRESETS[0]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.files(workspaceId), api.projects(workspaceId), api.studioSources(workspaceId)]).then(
      ([fileResult, projectResult, sourceResult]) => { setFiles(fileResult.files); setProjects(projectResult.projects); setSources(sourceResult.sources); },
      (reason: unknown) => setError(reason instanceof Error ? reason.message : "Studio sources could not be loaded"),
    );
  }, [workspaceId]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const source = files.find((item) => item.file_id === sourceId);
      const result = await api.createDocument(workspaceId, {
        name: name.trim() || (source ? `${source.display_name} design` : `Untitled ${preset.label}`),
        source_file_id: sourceId || undefined,
        project_id: projectId || undefined,
        intended_use: sourceId ? "source" : preset.id === "print" ? "print" : "digital",
        intended_use_label: sourceId ? "Source size" : preset.label,
        width: sourceId ? undefined : preset.width,
        height: sourceId ? undefined : preset.height,
      });
      navigate(workspacePath(workspaceId, `studio/${result.editor.document.document_id}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The graphic could not be created");
    } finally {
      setCreating(false);
    }
  }

  return <main className="page studio-start" data-testid="studio-start">
    <section className="page-heading"><div><p className="eyebrow">Image &amp; Graphic Studio</p><h1>Start a graphic</h1><p>Begin at a useful size or preserve an accepted image as the linked source.</p></div></section>
    {error && <InlineNotice tone="error" title="Studio could not start">{error}</InlineNotice>}
    <form onSubmit={create} className="studio-start-form">
      <section aria-labelledby="studio-size-heading"><div className="section-heading"><div><h2 id="studio-size-heading">Canvas</h2><p>Choose a starting point. Artboards remain editable.</p></div></div>
        <div className="preset-grid" role="radiogroup" aria-label="Canvas preset">{PRESETS.map((item) => <button
          type="button" role="radio" aria-checked={!sourceId && preset.id === item.id} className="preset-option" key={item.id}
          onClick={() => { setPreset(item); setSourceId(""); }}
        ><span className={`preset-shape preset-${item.id}`} /><strong>{item.label}</strong><small>{item.detail}</small></button>)}</div>
      </section>
      <section aria-labelledby="studio-source-heading"><div className="section-heading"><div><h2 id="studio-source-heading">Accepted source</h2><p>Optional. The immutable original stays unchanged.</p></div></div>
        {sources.length === 0 ? <div className="studio-source-empty"><ImageIcon aria-hidden="true" /><span>Accepted images from Default Files will appear here.</span></div> : <div className="studio-source-list" role="radiogroup" aria-label="Source file">{sources.map((source) => <button
          type="button" role="radio" aria-checked={sourceId === source.file_id} aria-disabled={!source.editable} disabled={!source.editable} key={source.file_id} onClick={() => { setSourceId(source.file_id); setName(`${source.display_name} design`); }}
        ><ImageIcon aria-hidden="true" /><span><strong>{source.display_name}</strong><small>{source.editable ? (source.requires_generated_preview ? "Safe preview prepared after creation" : "Source preserved") : source.compatibility_message}</small></span></button>)}</div>}
      </section>
      <div className="studio-start-fields">
        <TextInput label="Graphic name" maxLength={200} value={name} placeholder="Untitled graphic" onChange={(event) => setName(event.target.value)} />
        <label className="studio-select-label">Location<select className="ds-select" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Default Files</option>{projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}</select></label>
      </div>
      <div className="studio-start-actions"><Button type="button" onClick={() => navigate(workspacePath(workspaceId))}>Cancel</Button><Button tone="primary" disabled={creating}>{creating ? "Creating..." : "Create graphic"}</Button></div>
    </form>
  </main>;
}

export function ImageGraphicStudio() {
  const { workspaceId = "", documentId = "" } = useParams();
  const navigate = useNavigate();
  const {
    editor,
    editorRef,
    leaseRef,
    saveState,
    message,
    setMessage,
    pendingCount,
    getPendingCount,
    readOnly,
    commit,
    replaceServer,
    adoptLease,
    flushPending,
    retryPending,
    reloadCurrent,
    reapplyPending,
    recoveredSnapshot,
    takeoverRequest,
    denyTakeover,
    releaseForTakeover,
    retryAcquire,
  } = useDurableEditorSession(workspaceId, documentId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<EditorRenderer | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<RendererViewport>({ zoom: 1, panX: 0, panY: 0 });
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null } | null>(null);
  const [leftTab, setLeftTab] = useState("layers");
  const [rightTab, setRightTab] = useState("properties");
  const [activeArtboardId, setActiveArtboardId] = useState("");
  const [groupSelection, setGroupSelection] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<StudioSourceCandidate[]>([]);
  const [addingAssetId, setAddingAssetId] = useState<string | null>(null);
  const [versionName, setVersionName] = useState("");
  const [compatibility, setCompatibility] = useState<ImportCompatibilityReport[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [saveAsProjectId, setSaveAsProjectId] = useState("");
  const [savingCopy, setSavingCopy] = useState(false);
  const [canForceTakeover, setCanForceTakeover] = useState(false);
  const [layoutActorId, setLayoutActorId] = useState<string | null>(null);
  const [forceOpen, setForceOpen] = useState(false);
  const [forceReason, setForceReason] = useState("");
  const [takeoverPending, setTakeoverPending] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewActionBusy, setPreviewActionBusy] = useState(false);
  const [previewRetryable, setPreviewRetryable] = useState(false);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const previewState = editor?.document.preview_state ?? "not_required";
  const editorReady = editor !== null && (previewState === "not_required" || previewState === "ready");

  useEffect(() => {
    let active = true;
    void Promise.all([api.projects(workspaceId), api.context(workspaceId), api.studioSources(workspaceId)]).then(([result, context, sourceResult]) => {
      if (active) {
        setProjects(result.projects);
        setSources(sourceResult.sources);
        setLayoutActorId(context.actor.actor_id);
        setCanForceTakeover(context.effective_permissions.some((permission) => permission.permission === "document.lease.takeover" && permission.allowed));
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [workspaceId]);

  useEffect(() => {
    const jobId = editor?.document.preview_job_id;
    if (!jobId || (previewState !== "preparing" && previewState !== "failed")) return;
    let active = true;
    const refresh = async () => {
      try {
        const [status, document] = await Promise.all([
          api.jobStatus(jobId, createTraceId()),
          api.document(workspaceId, documentId),
        ]);
        if (!active) return;
        setPreviewProgress(status.job.progress_percent);
        setPreviewRetryable(Boolean(status.job.failure?.retryable));
        setPreviewFailure(status.job.failure?.message ?? null);
        replaceServer(document.editor);
      } catch (reason) {
        if (active) setMessage(reason instanceof Error ? reason.message : "Preview status could not be refreshed");
      }
    };
    void refresh();
    const timer = previewState === "preparing" ? window.setInterval(() => void refresh(), 1_500) : null;
    return () => { active = false; if (timer !== null) window.clearInterval(timer); };
  }, [documentId, editor?.document.preview_job_id, previewState, replaceServer, setMessage, workspaceId]);

  useEffect(() => {
    if (!takeoverPending || !readOnly || leaseRef.current) return;
    const timer = window.setInterval(() => void retryAcquire(), 3_000);
    return () => window.clearInterval(timer);
  }, [leaseRef, readOnly, retryAcquire, takeoverPending]);

  useEffect(() => {
    if (!editor) return;
    setActiveArtboardId((current) => editor.snapshot.artboards.some((item) => item.artboard_id === current)
      ? current
      : editor.snapshot.artboards[0]?.artboard_id ?? "");
    if (selectedRef.current && !(editor.snapshot.layers ?? []).some((item) => item.layer_id === selectedRef.current)) {
      selectedRef.current = null;
      setSelectedId(null);
    }
    setGroupSelection((current) => new Set([...current].filter((id) => (editor.snapshot.layers ?? []).some((item) => item.layer_id === id))));
  }, [editor]);

  useEffect(() => {
    let active = true;
    void api.documentCompatibility(workspaceId, documentId).then((response) => {
      if (active) setCompatibility(response.reports);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [documentId, workspaceId]);

  useEffect(() => {
    const element = canvasRef.current;
    const surface = surfaceRef.current;
    if (!element || !surface || rendererRef.current) return;
    const renderer = new FabricEditorRenderer();
    renderer.mount(element, {
      onSelection: (id) => {
        selectedRef.current = id;
        setSelectedId(id);
        const artboardId = editorRef.current?.snapshot.layers?.find((item) => item.layer_id === id)?.artboard_id;
        if (artboardId) setActiveArtboardId(artboardId);
      },
      onTransform: (layerId, transform) => commit({ kind: "layer.update", target_id: layerId, transform, properties: {} }),
      onViewport: setViewport,
      onSnap: setSnapGuides,
    });
    renderer.setReadOnly(readOnly);
    rendererRef.current = renderer;
    const observer = new ResizeObserver(([entry]) => renderer.resize(entry.contentRect.width, entry.contentRect.height));
    observer.observe(surface);
    renderer.resize(surface.clientWidth, surface.clientHeight);
    return () => { observer.disconnect(); renderer.dispose(); rendererRef.current = null; };
  }, [commit, editorReady]);

  useEffect(() => rendererRef.current?.setReadOnly(readOnly), [readOnly]);

  useEffect(() => {
    if (!editor || !rendererRef.current) return;
    const selectedBeforeRender = selectedRef.current;
    void rendererRef.current.render(
      editor.snapshot,
      (sharedAssetId) => api.documentAssetSourceUrl(workspaceId, documentId, sharedAssetId),
    ).then(() => {
      rendererRef.current?.setReadOnly(readOnly);
      rendererRef.current?.select(selectedBeforeRender);
    })
      .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : "Preview could not be rendered"));
  }, [documentId, editor, readOnly, workspaceId]);

  const selected = useMemo(() => (editor?.snapshot.layers ?? []).find((item) => item.layer_id === selectedId) ?? null, [editor, selectedId]);

  async function history(direction: "undo" | "redo") {
    if (!leaseRef.current || readOnly) return;
    await flushPending();
    if (getPendingCount()) {
      setMessage("Save pending edits before changing history.");
      return;
    }
    try {
      const response = await api.documentHistory(workspaceId, documentId, leaseRef.current, direction);
      const current = editorRef.current!;
      replaceServer({ ...current, document: response.history.document, snapshot: response.history.snapshot });
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : `${direction} failed`); }
  }

  function activeArtboard() {
    const current = editorRef.current;
    return current?.snapshot.artboards.find((item) => item.artboard_id === activeArtboardId)
      ?? current?.snapshot.artboards[0];
  }

  function nextRootOrder(artboardId: string) {
    return (editorRef.current?.snapshot.layers ?? []).filter((item) => item.artboard_id === artboardId && !item.parent_layer_id).length;
  }

  function addShape(shape: "rectangle" | "ellipse" | "line" | "polygon" = "rectangle") {
    const current = editorRef.current;
    const artboard = activeArtboard();
    if (!current || !artboard) return;
    const id = `layer-${crypto.randomUUID()}`;
    const label = { rectangle: "Rectangle", ellipse: "Ellipse", line: "Line", polygon: "Polygon" }[shape];
    const points = shape === "line"
      ? [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]
      : shape === "polygon"
        ? [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
        : [];
    const layer: LayerRecord = {
      layer_id: id, artboard_id: artboard.artboard_id, parent_layer_id: null, layer_type: "shape", name: label,
      order: nextRootOrder(artboard.artboard_id), visible: true, locked: false, opacity: 1, blend_mode: "normal",
      transform: baseTransform(artboard.width * 0.2, artboard.height * 0.36, Math.min(320, artboard.width * 0.35), Math.min(220, artboard.height * 0.3)),
      shared_style_ids: [], raster: null, vector: null, rich_text: null,
      shape: { shape, fill: shape === "line" ? null : "#3559e0", stroke: shape === "line" ? "#3559e0" : null, stroke_width: shape === "line" ? 4 : 0, corner_radius: shape === "rectangle" ? 12 : 0, points },
      group: null, extension_payload: {},
    };
    selectedRef.current = id;
    setSelectedId(id);
    commit({ kind: "layer.add", target_id: id, layer, properties: {} });
  }

  function addVectorPath() {
    const artboard = activeArtboard();
    if (!artboard) return;
    const id = `layer-${crypto.randomUUID()}`;
    const layer: LayerRecord = {
      layer_id: id, artboard_id: artboard.artboard_id, parent_layer_id: null, layer_type: "vector_svg", name: "Vector path",
      order: nextRootOrder(artboard.artboard_id), visible: true, locked: false, opacity: 1, blend_mode: "normal",
      transform: baseTransform(artboard.width * 0.25, artboard.height * 0.25, Math.min(260, artboard.width * 0.35), Math.min(260, artboard.height * 0.35)),
      shared_style_ids: [], raster: null,
      vector: { shared_asset_id: null, sanitised_svg_object_reference_id: null, compatibility_report_id: null, path_data: "M 50 0 L 100 38 L 81 100 L 19 100 L 0 38 Z", fill: "#16a085", stroke: "#0f6f5f", stroke_width: 2, mask_ids: [] },
      rich_text: null, shape: null, group: null, extension_payload: {},
    };
    selectedRef.current = id;
    setSelectedId(id);
    commit({ kind: "layer.add", target_id: id, layer, properties: {} });
  }

  function addText() {
    const current = editorRef.current;
    if (!current) return;
    const artboard = activeArtboard();
    if (!artboard) return;
    const id = `layer-${crypto.randomUUID()}`;
    const layer: LayerRecord = {
      layer_id: id, artboard_id: artboard.artboard_id, parent_layer_id: null, layer_type: "rich_text", name: "Heading",
      order: nextRootOrder(artboard.artboard_id), visible: true, locked: false, opacity: 1, blend_mode: "normal",
      transform: baseTransform(artboard.width * 0.2, artboard.height * 0.16, Math.min(520, artboard.width * 0.6), 100),
      shared_style_ids: [], raster: null, vector: null,
      rich_text: { text: "Your heading", runs: [], font_family: "system-ui", font_size: 52, color: "#162033", text_align: "left" },
      shape: null, group: null, extension_payload: {},
    };
    selectedRef.current = id;
    setSelectedId(id);
    commit({ kind: "layer.add", target_id: id, layer, properties: {} });
  }

  function addArtboard() {
    const current = editorRef.current;
    if (!current) return;
    const first = activeArtboard() ?? current.snapshot.artboards[0];
    const order = current.snapshot.artboards.length;
    const id = `artboard-${crypto.randomUUID()}`;
    commit({
      kind: "artboard.add",
      artboard: {
        artboard_id: id, name: `Artboard ${order + 1}`, order,
        width: first.width, height: first.height, unit: first.unit, orientation: first.orientation,
        background: structuredClone(first.background), intended_use: structuredClone(first.intended_use),
      },
      properties: {},
    });
    setActiveArtboardId(id);
  }

  function groupSelected() {
    const current = editorRef.current;
    const selectedLayers = (current?.snapshot.layers ?? []).filter((item) => groupSelection.has(item.layer_id));
    if (!current || selectedLayers.length < 2) return;
    const first = selectedLayers[0]!;
    const id = `layer-${crypto.randomUUID()}`;
    commit({
      kind: "layer.group",
      target_id: id,
      target_ids: selectedLayers.map((item) => item.layer_id),
      layer: {
        layer_id: id, artboard_id: first.artboard_id, parent_layer_id: first.parent_layer_id ?? null, layer_type: "group",
        name: "Group", order: first.order, visible: true, locked: false, opacity: 1, blend_mode: "normal",
        transform: baseTransform(0, 0, 1, 1), shared_style_ids: [], raster: null, vector: null, rich_text: null,
        shape: null, group: { collapsed: false }, extension_payload: {},
      },
      properties: {},
    });
    setGroupSelection(new Set());
    selectedRef.current = id;
    setSelectedId(id);
  }

  function ungroupSelected() {
    if (!selected?.group) return;
    commit({ kind: "layer.ungroup", target_id: selected.layer_id, properties: {} });
    selectedRef.current = null;
    setSelectedId(null);
  }

  async function addAsset(fileId: string) {
    const lease = leaseRef.current;
    const current = editorRef.current;
    const artboard = activeArtboard();
    if (!lease || !current || !artboard || readOnly) return;
    setAddingAssetId(fileId);
    try {
      await flushPending();
      if (getPendingCount()) throw new Error("Save pending edits before adding another asset.");
      const response = await api.addDocumentAsset(workspaceId, documentId, lease, current.document.current_revision, fileId, artboard.artboard_id);
      replaceServer({ ...current, document: response.mutation.document, snapshot: response.mutation.snapshot });
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "The asset could not be added");
    } finally {
      setAddingAssetId(null);
    }
  }

  function updateLayer(properties: EditorMutation["properties"], transform?: LayerTransform, adjustments?: VisualAdjustments) {
    if (!selected) return;
    commit({ kind: "layer.update", target_id: selected.layer_id, transform, adjustments, properties: properties ?? {} });
  }

  async function nameVersion() {
    if (!versionName.trim() || readOnly) return;
    await flushPending();
    if (getPendingCount()) { setMessage("Save pending edits before creating a version."); return; }
    try {
      const response = await api.createDocumentVersion(workspaceId, documentId, versionName.trim());
      const current = editorRef.current!;
      replaceServer({ ...current, document: { ...current.document, current_version_id: response.version.document_version_id }, versions: [response.version, ...current.versions] });
      setVersionName("");
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Version could not be saved"); }
  }

  async function restore(versionId: string) {
    if (!leaseRef.current || readOnly) return;
    await flushPending();
    if (getPendingCount()) { setMessage("Save pending edits before restoring a version."); return; }
    try {
      const response = await api.restoreDocumentVersion(workspaceId, documentId, versionId, leaseRef.current);
      replaceServer(response.editor);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Version could not be restored"); }
  }

  async function requestTakeover() {
    try {
      const response = await api.takeoverDocumentLease(workspaceId, documentId);
      if (response.takeover.status === "acquired" && response.takeover.grant) {
        adoptLease(response.takeover.grant.lease_token);
        setTakeoverPending(false);
      } else {
        setTakeoverPending(true);
        setMessage("Editing access was requested from the current editor.");
      }
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Editing access could not be requested"); }
  }

  async function forceTakeover(event: FormEvent) {
    event.preventDefault();
    if (!forceReason.trim()) return;
    try {
      const response = await api.forceTakeoverDocumentLease(workspaceId, documentId, forceReason.trim());
      adoptLease(response.takeover.grant.lease_token);
      setTakeoverPending(false);
      setForceOpen(false);
      setForceReason("");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Editing access could not be taken over");
    }
  }

  function openSaveAs() {
    setSaveAsName(`${editorRef.current?.document.name ?? "Untitled graphic"} copy`);
    setSaveAsProjectId(editorRef.current?.document.project_id ?? "");
    setSaveAsOpen(true);
  }

  async function saveAs(event: FormEvent) {
    event.preventDefault();
    if (!saveAsName.trim()) return;
    setSavingCopy(true);
    try {
      const response = await api.saveAsDocument(
        workspaceId,
        documentId,
        saveAsName.trim(),
        saveAsProjectId || undefined,
        pendingCount ? recoveredSnapshot ?? undefined : undefined,
      );
      setSaveAsOpen(false);
      navigate(workspacePath(workspaceId, `studio/${response.editor.document.document_id}`));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "The copy could not be created");
    } finally {
      setSavingCopy(false);
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editingText = target?.matches("input, textarea, select, [contenteditable='true']") ?? false;
      if (editingText && event.key !== "Escape") return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void history(event.shiftKey ? "redo" : "undo");
      } else if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        void history("redo");
      } else if (command && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        openSaveAs();
      } else if (event.key === "0") {
        event.preventDefault();
        rendererRef.current?.fit();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        rendererRef.current?.zoomBy(1.25);
      } else if (event.key === "-") {
        event.preventDefault();
        rendererRef.current?.zoomBy(0.8);
      } else if (event.key === "Escape") {
        selectedRef.current = null;
        setSelectedId(null);
        rendererRef.current?.select(null);
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        if (!readOnly) commit({ kind: "layer.remove", target_id: selectedId, properties: {} });
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && selected && !readOnly) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        updateLayer({}, { ...selected.transform, x: selected.transform.x + dx, y: selected.transform.y + dy });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commit, readOnly, selected, selectedId]);

  if (!editor) return <main className="studio-loading">{message ? <StatePanel kind="error" title="Studio unavailable" message={message} action={{ label: "Back to Home", onClick: () => navigate(workspacePath(workspaceId)) }} /> : <StatePanel kind="loading" title="Opening Studio" message="Loading the native document and editor lease." />}</main>;

  if (previewState === "preparing") return <main className="studio-loading preview-preparation" data-testid="preview-preparing">
    <h1 className="sr-only">Preparing a safe editing preview</h1>
    <StatePanel kind="loading" title="Preparing a safe editing preview" message={`You can leave while the durable preview job continues. ${previewProgress}% complete.`} />
    <div className="studio-loading-actions"><Button onClick={() => navigate(workspacePath(workspaceId))}>Close and return later</Button><Button tone="danger" disabled={previewActionBusy} onClick={() => {
      if (!editor.document.preview_job_id) return;
      setPreviewActionBusy(true);
      void api.cancelJob(editor.document.preview_job_id, createTraceId()).finally(() => setPreviewActionBusy(false));
    }}>{previewActionBusy ? "Cancelling..." : "Cancel preparation"}</Button></div>
  </main>;

  if (previewState === "failed" || previewState === "cancelled") return <main className="studio-loading preview-preparation" data-testid={`preview-${previewState}`}>
    <h1 className="sr-only">{previewState === "failed" ? "Preview could not be prepared" : "Preview preparation was cancelled"}</h1>
    <StatePanel kind="error" title={previewState === "failed" ? "Preview could not be prepared" : "Preview preparation was cancelled"} message={`${previewFailure ? `${previewFailure} ` : ""}The full-resolution source is unchanged and remains safely stored.`} />
    <div className="studio-loading-actions"><Button onClick={() => navigate(workspacePath(workspaceId))}>Back to workspace</Button>{previewState === "failed" && previewRetryable && <Button tone="primary" disabled={previewActionBusy} onClick={() => {
      if (!editor.document.preview_job_id) return;
      setPreviewActionBusy(true);
      void api.retryJob(editor.document.preview_job_id, createTraceId())
        .then(() => api.document(workspaceId, documentId))
        .then((result) => replaceServer(result.editor))
        .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : "Preview retry could not start"))
        .finally(() => setPreviewActionBusy(false));
    }}>{previewActionBusy ? "Retrying..." : "Retry preparation"}</Button>}</div>
  </main>;

  const leftPanel = <Tabs label="Document panels" selected={leftTab} onSelect={setLeftTab} items={[
    { id: "artboards", label: "Artboards", panel: <ArtboardsPanel snapshot={editor.snapshot} activeId={activeArtboardId} select={(id) => { setActiveArtboardId(id); rendererRef.current?.fitArtboard(id); }} add={addArtboard} mutate={commit} readOnly={readOnly} /> },
    { id: "layers", label: "Layers", panel: <LayersPanel snapshot={editor.snapshot} selectedId={selectedId} groupSelection={groupSelection} toggleGroup={(id) => setGroupSelection((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} select={(id) => { selectedRef.current = id; setSelectedId(id); const artboardId = editor.snapshot.layers?.find((item) => item.layer_id === id)?.artboard_id; if (artboardId) setActiveArtboardId(artboardId); rendererRef.current?.select(id); }} mutate={commit} readOnly={readOnly} /> },
    { id: "assets", label: "Assets", panel: <AssetsPanel editor={editor} sources={sources} addingAssetId={addingAssetId} add={addAsset} compatibility={compatibility} readOnly={readOnly} /> },
    { id: "history", label: "History", panel: <HistoryPanel editor={editor} versionName={versionName} setVersionName={setVersionName} save={() => void nameVersion()} restore={(id) => void restore(id)} readOnly={readOnly} /> },
  ]} />;
  const rightPanel = <Tabs label="Tool panels" selected={rightTab} onSelect={setRightTab} items={[
    { id: "properties", label: "Properties", panel: <PropertiesPanel snapshot={editor.snapshot} layer={selected} update={updateLayer} mutate={commit} readOnly={readOnly} /> },
    { id: "all-tools", label: "All Tools", panel: <AllTools addShape={addShape} addVectorPath={addVectorPath} addText={addText} addArtboard={addArtboard} groupSelected={groupSelected} ungroupSelected={ungroupSelected} groupCount={groupSelection.size} saveAs={openSaveAs} fit={() => rendererRef.current?.fit()} focusCanvas={() => surfaceRef.current?.querySelector<HTMLElement>(".upper-canvas")?.focus()} selected={selected} update={updateLayer} readOnly={readOnly} /> },
  ]} />;

  return <main className="studio" data-testid="image-graphic-studio">
    <div className="studio-command-bar" role="toolbar" aria-label="Editor commands">
      <Tooltip label="Back to Home"><IconButton label="Back to Home" onClick={() => navigate(workspacePath(workspaceId))}><ArrowLeft aria-hidden="true" /></IconButton></Tooltip>
      <div className="studio-document-title"><h1 title={editor.document.name}>{editor.document.name}</h1><span>{editor.snapshot.artboards.length} {editor.snapshot.artboards.length === 1 ? "artboard" : "artboards"}</span></div>
      <div className={`studio-save-state state-${saveState}`} role="status"><Save aria-hidden="true" /><span>{saveLabel(saveState)}</span></div>
      <div className="studio-command-group" role="group" aria-label="History"><IconButton label="Undo" disabled={readOnly || pendingCount > 0} onClick={() => void history("undo")}><Undo2 aria-hidden="true" /></IconButton><IconButton label="Redo" disabled={readOnly || pendingCount > 0} onClick={() => void history("redo")}><Redo2 aria-hidden="true" /></IconButton><IconButton label={readOnly ? "Save independent copy" : "Save as"} disabled={!editor} onClick={openSaveAs}><CopyPlus aria-hidden="true" /></IconButton></div>
      <div className="studio-command-group add-tools" role="group" aria-label="Add"><Button size="compact" disabled={readOnly} onClick={addText}><Type aria-hidden="true" />Text</Button><Button size="compact" disabled={readOnly} onClick={() => addShape()}><Shapes aria-hidden="true" />Shape</Button><Button size="compact" disabled={readOnly} onClick={addArtboard}><Plus aria-hidden="true" />Artboard</Button></div>
      <div className="studio-command-group" role="group" aria-label="Zoom"><IconButton label="Zoom out" onClick={() => rendererRef.current?.zoomBy(0.8)}><ZoomOut aria-hidden="true" /></IconButton><span className="zoom-value">{Math.round(viewport.zoom * 100)}%</span><IconButton label="Zoom in" onClick={() => rendererRef.current?.zoomBy(1.25)}><ZoomIn aria-hidden="true" /></IconButton><IconButton label="Fit artboards" onClick={() => rendererRef.current?.fit()}><Maximize2 aria-hidden="true" /></IconButton></div>
    </div>
    {message && <div className="studio-message" role="alert"><span>{message}</span><div className="studio-message-actions">
      {(saveState === "failed" || saveState === "offline") && pendingCount > 0 && <Button size="compact" onClick={retryPending}>Retry now</Button>}
      {saveState === "conflict" && <><Button size="compact" onClick={() => void reloadCurrent()}>Reload current</Button><Button size="compact" onClick={openSaveAs}>Save recovered copy</Button><Button size="compact" tone="primary" onClick={() => void reapplyPending()}>Review and reapply</Button></>}
      {saveState === "read-only" && <><Button size="compact" onClick={() => void requestTakeover()}>Request takeover</Button>{canForceTakeover && <Button size="compact" tone="danger" onClick={() => setForceOpen(true)}>Force takeover</Button>}</>}
    </div>{pendingCount > 0 && <details><summary>{pendingCount} pending {pendingCount === 1 ? "edit" : "edits"}</summary><p>Pending edits stay on this device for this signed-in account. Closing a browser tab can prevent a final lease release, but acknowledged server work is never removed.</p></details>}</div>}
    {takeoverRequest && <div className="studio-takeover-request" role="alert"><div><strong>{takeoverRequest.actorDisplayName} requested editing access</strong><span>{takeoverRequest.reason}</span></div><div><Button size="compact" onClick={() => void releaseForTakeover()}>Save and release</Button><Button size="compact" onClick={() => void denyTakeover("Current editor is continuing this session")}>Deny</Button></div></div>}
    <PanelFramework mode="editor" profileKey={layoutActorId ? `${layoutActorId}:${workspaceId}:image-graphic-studio` : undefined} panels={[
      { id: "inspector", title: "Document", slot: "tool", children: leftPanel },
      { id: "conversation", title: "Tools", slot: "conversation", children: rightPanel },
    ]} center={<CanvasSurface canvasRef={canvasRef} surfaceRef={surfaceRef} editor={editor} viewport={viewport} snapGuides={snapGuides} />} />
    <Dialog open={saveAsOpen} title="Save a copy" onClose={() => setSaveAsOpen(false)}>
      <form className="modal-form" onSubmit={(event) => void saveAs(event)}>
        <TextInput autoFocus label="Graphic name" maxLength={200} value={saveAsName} onChange={(event) => setSaveAsName(event.target.value)} />
        <label className="studio-select-label">Location<select className="ds-select" value={saveAsProjectId} onChange={(event) => setSaveAsProjectId(event.target.value)}><option value="">Default Files</option>{projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}</select></label>
        <div className="dialog-actions"><Button type="button" onClick={() => setSaveAsOpen(false)}>Cancel</Button><Button tone="primary" disabled={savingCopy || !saveAsName.trim()}>{savingCopy ? "Saving..." : "Save copy"}</Button></div>
      </form>
    </Dialog>
    <Dialog open={forceOpen} title="Force editing takeover" onClose={() => setForceOpen(false)}>
      <form className="modal-form" onSubmit={(event) => void forceTakeover(event)}>
        <InlineNotice tone="warning" title="The current editor will lose editing access">Only continue when their work has been coordinated. This action is audited.</InlineNotice>
        <TextInput autoFocus label="Reason" maxLength={500} value={forceReason} onChange={(event) => setForceReason(event.target.value)} />
        <div className="dialog-actions"><Button type="button" onClick={() => setForceOpen(false)}>Cancel</Button><Button tone="danger" disabled={!forceReason.trim()}>Force takeover</Button></div>
      </form>
    </Dialog>
  </main>;
}

function CanvasSurface({ canvasRef, surfaceRef, editor, viewport, snapGuides }: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  editor: DocumentReadModel;
  viewport: RendererViewport;
  snapGuides: { x: number | null; y: number | null } | null;
}) {
  return <div className="studio-canvas-shell" ref={surfaceRef}>
    <div className="canvas-corner" aria-hidden="true" />
    <div className="canvas-ruler canvas-ruler-x" aria-hidden="true" />
    <div className="canvas-ruler canvas-ruler-y" aria-hidden="true" />
    <canvas ref={canvasRef} aria-label={`${editor.document.name} editable artboards`} />
    {snapGuides?.x !== null && snapGuides?.x !== undefined && <span className="canvas-snap-guide guide-x" style={{ left: snapGuides.x * viewport.zoom + viewport.panX }} aria-hidden="true" />}
    {snapGuides?.y !== null && snapGuides?.y !== undefined && <span className="canvas-snap-guide guide-y" style={{ top: snapGuides.y * viewport.zoom + viewport.panY }} aria-hidden="true" />}
    <span className="preview-evidence">Browser preview | Native document remains authoritative</span>
  </div>;
}

function ArtboardsPanel({ snapshot, activeId, select, add, mutate, readOnly }: {
  snapshot: EditorDocumentSnapshot;
  activeId: string;
  select: (id: string) => void;
  add: () => void;
  mutate: (mutation: EditorMutation) => void;
  readOnly: boolean;
}) {
  const artboards = [...snapshot.artboards].sort((left, right) => left.order - right.order);
  const active = artboards.find((item) => item.artboard_id === activeId) ?? artboards[0];
  const update = (next: typeof active) => next && mutate({ kind: "artboard.update", target_id: next.artboard_id, artboard: next, properties: {} });
  return <div className="studio-panel-body"><div className="artboard-list" role="list" aria-label="Artboards">{artboards.map((artboard) => <div role="listitem" key={artboard.artboard_id}><button type="button" aria-pressed={activeId === artboard.artboard_id} onClick={() => select(artboard.artboard_id)}><span className="artboard-thumbnail" style={{ aspectRatio: `${artboard.width} / ${artboard.height}`, background: artboard.background.kind === "transparent" ? "repeating-conic-gradient(#d8dde7 0 25%, #fff 0 50%) 50% / 8px 8px" : artboard.background.color ?? "#fff" }} /><span><strong>{artboard.name}</strong><small>{formatDimension(artboard.width)} x {formatDimension(artboard.height)} {artboard.unit} | {artboard.orientation}</small></span></button></div>)}</div>
    <Button size="compact" disabled={readOnly} onClick={add}><Plus aria-hidden="true" />Add artboard</Button>
    {active && <fieldset disabled={readOnly} className="artboard-properties"><legend>Active artboard</legend>
      <label>Name<input value={active.name} onChange={(event) => update({ ...active, name: event.target.value || active.name })} /></label>
      <div className="property-grid"><NumberProperty label="Width" value={active.width} step={0.01} onCommit={(width) => update({ ...active, width: Math.max(0.01, width), orientation: artboardOrientation(Math.max(0.01, width), active.height) })} /><NumberProperty label="Height" value={active.height} step={0.01} onCommit={(height) => update({ ...active, height: Math.max(0.01, height), orientation: artboardOrientation(active.width, Math.max(0.01, height)) })} /></div>
      <label>Unit<select value={active.unit ?? "px"} onChange={(event) => update(convertArtboardUnit(active, event.target.value as "px" | "mm" | "in" | "pt"))}><option value="px">Pixels</option><option value="in">Inches</option><option value="mm">Millimetres</option><option value="pt">Points</option></select></label>
      <label>Orientation<select value={active.orientation} onChange={(event) => { const value = event.target.value; if (value === "square") update({ ...active, height: active.width, orientation: "square" }); else if ((value === "landscape") !== (active.width > active.height)) update({ ...active, width: active.height, height: active.width, orientation: value as "portrait" | "landscape" }); }}><option value="portrait">Portrait</option><option value="landscape">Landscape</option><option value="square">Square</option></select></label>
      <label><input type="checkbox" checked={active.background.kind === "transparent"} onChange={(event) => update({ ...active, background: event.target.checked ? { kind: "transparent", color: null } : { kind: "solid", color: "#ffffff" } })} />Transparent background</label>
      {active.background.kind === "solid" && <label>Background<input type="color" value={active.background.color ?? "#ffffff"} onChange={(event) => update({ ...active, background: { kind: "solid", color: event.target.value } })} /></label>}
      <Button tone="danger" size="compact" disabled={snapshot.artboards.length === 1} onClick={() => mutate({ kind: "artboard.remove", target_id: active.artboard_id, properties: {} })}>Remove artboard</Button>
    </fieldset>}
  </div>;
}

function LayersPanel({ snapshot, selectedId, groupSelection, toggleGroup, select, mutate, readOnly }: {
  snapshot: EditorDocumentSnapshot;
  selectedId: string | null;
  groupSelection: Set<string>;
  toggleGroup: (id: string) => void;
  select: (id: string) => void;
  mutate: (mutation: EditorMutation) => void;
  readOnly: boolean;
}) {
  const layers = [...(snapshot.layers ?? [])].sort((left, right) => left.artboard_id.localeCompare(right.artboard_id) || (left.parent_layer_id ?? "").localeCompare(right.parent_layer_id ?? "") || right.order - left.order);
  return <div className="studio-panel-body">{layers.length === 0 ? <div className="studio-panel-empty"><Layers3 aria-hidden="true" /><strong>No layers yet</strong><span>Add text or a shape to begin.</span></div> : <div className="layer-list" role="list" aria-label="Layers">{layers.map((layer) => <div className={selectedId === layer.layer_id ? "layer-row is-selected" : "layer-row"} role="listitem" key={layer.layer_id}>
    <input className="layer-group-check" type="checkbox" aria-label={`Include ${layer.name} in group`} checked={groupSelection.has(layer.layer_id)} disabled={readOnly || layer.layer_type === "group"} onChange={() => toggleGroup(layer.layer_id)} />
    <button type="button" aria-pressed={selectedId === layer.layer_id} onClick={() => select(layer.layer_id)}><span className="layer-kind"><LayerIcon layer={layer} /></span><span><strong>{layer.name}</strong><small>{layerTypeLabel(layer)}</small></span></button>
    <IconButton label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`} disabled={readOnly} onClick={() => mutate({ kind: "layer.update", target_id: layer.layer_id, properties: { visible: !layer.visible } })}>{layer.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}</IconButton>
    <IconButton label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`} disabled={readOnly} onClick={() => mutate({ kind: "layer.update", target_id: layer.layer_id, properties: { locked: !layer.locked } })}>{layer.locked ? <Lock aria-hidden="true" /> : <Unlock aria-hidden="true" />}</IconButton>
    <div className="layer-order"><IconButton label="Move layer up" disabled={readOnly || layer.order >= siblingCount(snapshot, layer) - 1} onClick={() => mutate({ kind: "layer.reorder", target_id: layer.layer_id, properties: { order: layer.order + 1 } })}><ChevronUp aria-hidden="true" /></IconButton><IconButton label="Move layer down" disabled={readOnly || layer.order === 0} onClick={() => mutate({ kind: "layer.reorder", target_id: layer.layer_id, properties: { order: Math.max(0, layer.order - 1) } })}><ChevronDown aria-hidden="true" /></IconButton></div>
  </div>)}</div>}</div>;
}

function AssetsPanel({ editor, sources, addingAssetId, add, compatibility, readOnly }: { editor: DocumentReadModel; sources: StudioSourceCandidate[]; addingAssetId: string | null; add: (fileId: string) => Promise<void>; compatibility: ImportCompatibilityReport[]; readOnly: boolean }) {
  const assets = editor.snapshot.shared_assets ?? [];
  return <div className="studio-panel-body"><h3>Document assets</h3>{assets.length === 0 ? <div className="studio-panel-empty"><ImageIcon aria-hidden="true" /><strong>No linked source</strong><span>This graphic began with a blank artboard.</span></div> : assets.map((asset) => <article className="asset-row" key={asset.shared_asset_id}><ImageIcon aria-hidden="true" /><span><strong>{asset.name}</strong><small>{asset.linked_by_default ? "Linked immutable source" : "Independent asset reference"}</small></span></article>)}
    <h3>Add accepted image</h3><div className="asset-source-list">{sources.map((source) => <article className="asset-row" key={source.file_id}><ImageIcon aria-hidden="true" /><span><strong>{source.display_name}</strong><small>{source.editable ? source.requires_generated_preview ? "Open as its own graphic to prepare a preview" : "Ready to add" : source.compatibility_message}</small></span>{source.editable && !source.requires_generated_preview && <Button size="compact" disabled={readOnly || addingAssetId !== null} onClick={() => void add(source.file_id)}>{addingAssetId === source.file_id ? "Adding..." : "Add"}</Button>}</article>)}</div>
    {compatibility.map((report) => <InlineNotice key={report.compatibility_report_id} tone={report.state === "compatible" ? "success" : "warning"} title={report.state === "compatible" ? "Raster compatible" : "Compatibility limits"}>{report.source_preserved ? "Original source preserved." : ""}</InlineNotice>)}</div>;
}

function HistoryPanel({ editor, versionName, setVersionName, save, restore, readOnly }: {
  editor: DocumentReadModel;
  versionName: string;
  setVersionName: (value: string) => void;
  save: () => void;
  restore: (id: string) => void;
  readOnly: boolean;
}) {
  return <div className="studio-panel-body history-panel"><div className="version-create"><TextInput label="Version name" maxLength={100} disabled={readOnly} value={versionName} onChange={(event) => setVersionName(event.target.value)} /><Button size="compact" disabled={readOnly || !versionName.trim()} onClick={save}>Save version</Button></div><div className="version-list">{editor.versions.map((version) => <article key={version.document_version_id}><span><strong>{version.name || version.kind.replaceAll("_", " ")}</strong><small>Revision {version.revision} | {version.kind.replaceAll("_", " ")}</small></span>{version.document_version_id !== editor.document.current_version_id && <Button tone="quiet" size="compact" disabled={readOnly} onClick={() => restore(version.document_version_id)}>Restore</Button>}</article>)}</div></div>;
}

function PropertiesPanel({ snapshot, layer, update, mutate, readOnly }: {
  snapshot: EditorDocumentSnapshot;
  layer: LayerRecord | null;
  update: (properties: EditorMutation["properties"], transform?: LayerTransform, adjustments?: VisualAdjustments) => void;
  mutate: (mutation: EditorMutation) => void;
  readOnly: boolean;
}) {
  const [runStart, setRunStart] = useState(0);
  const [runEnd, setRunEnd] = useState(0);
  useEffect(() => { setRunStart(0); setRunEnd(layer?.rich_text?.text.length ?? 0); }, [layer?.layer_id, layer?.rich_text?.text.length]);
  if (!layer) return <div className="studio-panel-empty"><MousePointer2 aria-hidden="true" /><strong>Select a layer</strong><span>Its transform and appearance controls will appear here.</span></div>;
  const transform = layer.transform;
  const rotation = transform.rotation_degrees ?? 0;
  const opacity = layer.opacity ?? 1;
  const crop = layer.raster ? normalizedCrop(layer.raster.crop) : null;
  const linkedStyle = snapshot.shared_styles?.find((style) => layer.shared_style_ids?.includes(style.shared_style_id));
  const maskIds = layer.raster?.mask_ids ?? layer.vector?.mask_ids ?? [];
  const masks = (snapshot.masks ?? []).filter((mask) => maskIds.includes(mask.mask_id));
  const fontCompatible = !layer.rich_text || APPROVED_FONTS.some((font) => font.value.toLowerCase() === (layer.rich_text?.font_family ?? "system-ui").toLowerCase());
  const paintLayer = (fill: string) => {
    if (linkedStyle) mutate({ kind: "style.upsert", shared_style: { ...linkedStyle, properties: { ...linkedStyle.properties, fill } }, target_ids: [layer.layer_id], properties: {} });
    else if (layer.shape) mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, shape: { ...layer.shape, fill } }, properties: {} });
    else if (layer.vector) mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, vector: { ...layer.vector, fill } }, properties: {} });
  };
  return <div className="studio-panel-body properties-panel"><div className="property-heading"><LayerIcon layer={layer} /><span><strong>{layer.name}</strong><small>{layerTypeLabel(layer)}</small></span></div>
    <fieldset disabled={readOnly}><legend>Transform</legend><div className="property-grid">{(["x", "y", "width", "height", "rotation_degrees"] as const).map((key) => <NumberProperty key={key} label={key === "rotation_degrees" ? "Rotate" : key.toUpperCase()} value={key === "rotation_degrees" ? rotation : transform[key]} onCommit={(value) => update({}, { ...transform, [key]: key === "width" || key === "height" ? Math.max(1, value) : value })} />)}</div><div className="property-actions"><IconButton label="Flip horizontally" onClick={() => update({}, { ...transform, flip_x: !(transform.flip_x ?? false) })}><FlipHorizontal2 aria-hidden="true" /></IconButton><IconButton label="Flip vertically" onClick={() => update({}, { ...transform, flip_y: !(transform.flip_y ?? false) })}><FlipVertical2 aria-hidden="true" /></IconButton><IconButton label="Rotate 90 degrees" onClick={() => update({}, { ...transform, rotation_degrees: rotation + 90 > 360 ? rotation - 270 : rotation + 90 })}><RotateCw aria-hidden="true" /></IconButton></div></fieldset>
    <fieldset disabled={readOnly}><legend>Layer</legend><label>Opacity <span>{Math.round(opacity * 100)}%</span><input type="range" min="0" max="100" value={Math.round(opacity * 100)} onChange={(event) => update({ opacity: Number(event.target.value) / 100 })} /></label><label>Blend mode<select value={layer.blend_mode ?? "normal"} onChange={(event) => update({ blend_mode: event.target.value })}><option value="normal">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="overlay">Overlay</option><option value="darken">Darken</option><option value="lighten">Lighten</option></select></label></fieldset>
    {layer.raster && crop && <><fieldset disabled={readOnly}><legend>Crop</legend><div className="property-grid">{(["left", "top", "right", "bottom"] as const).map((key) => <NumberProperty key={key} label={key} step={0.01} value={crop[key]} onCommit={(value) => mutate({ kind: "layer.update", target_id: layer.layer_id, crop: { ...crop, [key]: Math.min(1, Math.max(0, value)) }, properties: {} })} />)}</div></fieldset><fieldset disabled={readOnly}><legend>Quick correction</legend><label>Light <span>{layer.raster.adjustments?.brightness ?? 0}</span><input type="range" min="-100" max="100" value={layer.raster.adjustments?.brightness ?? 0} onChange={(event) => update({}, undefined, { ...normalizedAdjustments(layer.raster!.adjustments), brightness: Number(event.target.value) })} /></label></fieldset><details className="advanced-controls"><summary>Advanced adjustments</summary><AdjustmentControls value={normalizedAdjustments(layer.raster.adjustments)} update={(adjustments) => update({}, undefined, adjustments)} readOnly={readOnly} /></details></>}
    {layer.rich_text && <fieldset disabled={readOnly}><legend>Text</legend><label className="property-textarea">Content<textarea value={layer.rich_text.text} onChange={(event) => { const text = event.target.value; mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, rich_text: { ...layer.rich_text!, text, runs: (layer.rich_text!.runs ?? []).filter((run) => run.end <= text.length) } }, properties: {} }); }} /></label><label>Font<select value={fontCompatible ? layer.rich_text.font_family ?? "system-ui" : "__unsupported"} onChange={(event) => event.target.value !== "__unsupported" && mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, rich_text: { ...layer.rich_text!, font_family: event.target.value } }, properties: {} })}>{!fontCompatible && <option value="__unsupported">Unsupported: {layer.rich_text.font_family}</option>}{APPROVED_FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label>{!fontCompatible && <InlineNotice tone="warning" title="Font not available">Preview uses Arial as an honest fallback. Choose an approved font to make rendering deterministic.</InlineNotice>}<NumberProperty label="Text size" value={layer.rich_text.font_size ?? 32} onCommit={(fontSize) => mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, rich_text: { ...layer.rich_text!, font_size: Math.max(1, fontSize) } }, properties: {} })} /><div className="rich-run-controls"><strong>Formatting range</strong><div className="property-grid"><NumberProperty label="Start" value={runStart} onCommit={(value) => setRunStart(Math.max(0, Math.min(layer.rich_text!.text.length, Math.floor(value))))} /><NumberProperty label="End" value={runEnd} onCommit={(value) => setRunEnd(Math.max(runStart, Math.min(layer.rich_text!.text.length, Math.floor(value))))} /></div><Button size="compact" disabled={runEnd <= runStart} onClick={() => mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, rich_text: { ...layer.rich_text!, runs: replaceRichTextRun(layer.rich_text!.runs ?? [], { start: runStart, end: runEnd, style: { font_weight: "bold" } }) } }, properties: {} })}>Bold range</Button></div></fieldset>}
    {layer.shape && <fieldset disabled={readOnly}><legend>Shape</legend><label>Kind<select value={layer.shape.shape} onChange={(event) => { const shape = event.target.value as "rectangle" | "ellipse" | "line" | "polygon"; mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, name: shape[0]!.toUpperCase() + shape.slice(1), shape: { ...layer.shape!, shape, fill: shape === "line" ? null : layer.shape!.fill ?? "#3559e0", stroke: shape === "line" ? layer.shape!.stroke ?? "#3559e0" : layer.shape!.stroke, stroke_width: shape === "line" ? Math.max(1, layer.shape!.stroke_width ?? 0) : layer.shape!.stroke_width, points: shapePoints(shape) } }, properties: {} }); }}><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="line">Line</option><option value="polygon">Polygon</option></select></label><label>{layer.shape.shape === "line" ? "Stroke" : "Fill"}<input type="color" value={(layer.shape.shape === "line" ? layer.shape.stroke : layer.shape.fill) ?? "#3559e0"} onChange={(event) => layer.shape!.shape === "line" ? mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, shape: { ...layer.shape!, stroke: event.target.value } }, properties: {} }) : paintLayer(event.target.value)} /></label></fieldset>}
    {layer.vector?.path_data && <fieldset disabled={readOnly}><legend>Internal vector path</legend><label className="property-textarea">Path commands<textarea value={layer.vector.path_data} onChange={(event) => mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, vector: { ...layer.vector!, path_data: event.target.value } }, properties: {} })} /></label><InlineNotice tone="info" title="Internal paths only">External SVG stays unavailable until an approved sanitisation pipeline is executable.</InlineNotice><label>Fill<input type="color" value={layer.vector.fill ?? "#16a085"} onChange={(event) => paintLayer(event.target.value)} /></label></fieldset>}
    {layer.raster && <fieldset disabled={readOnly}><legend>Asset instance</legend><label>Mode<select aria-label="Asset instance mode" value={layer.raster.instance_mode ?? "linked"} onChange={(event) => mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, raster: { ...layer.raster!, instance_mode: event.target.value as "linked" | "independent" } }, properties: {} })}><option value="linked">Linked</option><option value="independent">Independent</option></select></label></fieldset>}
    {(layer.shape || layer.vector) && <fieldset disabled={readOnly}><legend>Shared style</legend>{linkedStyle ? <><span>Linked to {linkedStyle.name}. Changes update every linked object.</span><Button size="compact" onClick={() => mutate({ kind: "style.detach", target_id: linkedStyle.shared_style_id, target_ids: [layer.layer_id], properties: {} })}>Detach appearance</Button></> : <Button size="compact" onClick={() => mutate({ kind: "style.upsert", target_ids: [layer.layer_id], shared_style: { shared_style_id: `style-${crypto.randomUUID()}`, name: `${layer.name} style`, kind: "fill", properties: { fill: layer.shape?.fill ?? layer.vector?.fill ?? "#3559e0", stroke: layer.shape?.stroke ?? layer.vector?.stroke ?? null, stroke_width: layer.shape?.stroke_width ?? layer.vector?.stroke_width ?? 0 } }, properties: {} })}>Create linked style</Button>}</fieldset>}
    {(layer.raster || layer.vector) && <><Button disabled={readOnly} onClick={() => {
      const maskId = `mask-${crypto.randomUUID()}`;
      mutate({ kind: "mask.update", target_id: layer.layer_id, mask: { mask_id: maskId, artboard_id: layer.artboard_id, name: `Mask for ${layer.name}`, kind: "shape", enabled: true, inverted: false, feather: 0, path_data: "rect(0.1,0.1,0.8,0.8)", object_reference_id: null }, properties: {} });
    }}><Blend aria-hidden="true" />Add editable mask</Button>{masks.map((mask) => <fieldset disabled={readOnly} key={mask.mask_id}><legend>{mask.name}</legend><label><input type="checkbox" checked={mask.enabled ?? true} onChange={(event) => mutate({ kind: "mask.update", target_id: layer.layer_id, mask: { ...mask, enabled: event.target.checked }, properties: {} })} />Enabled</label><label><input type="checkbox" checked={mask.inverted ?? false} onChange={(event) => mutate({ kind: "mask.update", target_id: layer.layer_id, mask: { ...mask, inverted: event.target.checked }, properties: {} })} />Invert mask</label><label>Shape<select value={mask.path_data?.startsWith("ellipse") ? "ellipse" : "rect"} onChange={(event) => mutate({ kind: "mask.update", target_id: layer.layer_id, mask: { ...mask, path_data: `${event.target.value}(0.1,0.1,0.8,0.8)` }, properties: {} })}><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option></select></label></fieldset>)}</>}
  </div>;
}

function AdjustmentControls({ value, update, readOnly }: { value: VisualAdjustments; update: (value: VisualAdjustments) => void; readOnly: boolean }) {
  const controls: Array<[keyof VisualAdjustments, string, number, number]> = [
    ["exposure", "Exposure", -100, 100], ["brightness", "Brightness", -100, 100], ["contrast", "Contrast", -100, 100],
    ["saturation", "Saturation", -100, 100], ["temperature", "Temperature", -100, 100], ["tint", "Tint", -100, 100], ["sharpness", "Sharpness", 0, 100],
  ];
  return <fieldset disabled={readOnly}><legend>Adjustments</legend>{controls.map(([key, label, min, max]) => <label key={key}>{label}<span>{value[key] ?? 0}</span><input type="range" min={min} max={max} value={(value[key] as number | undefined) ?? 0} onChange={(event) => update({ ...value, [key]: Number(event.target.value) })} /></label>)}</fieldset>;
}

function AllTools({ addShape, addVectorPath, addText, addArtboard, groupSelected, ungroupSelected, groupCount, saveAs, fit, focusCanvas, selected, update, readOnly }: {
  addShape: (shape?: "rectangle" | "ellipse" | "line" | "polygon") => void; addVectorPath: () => void; addText: () => void; addArtboard: () => void; groupSelected: () => void; ungroupSelected: () => void; groupCount: number; saveAs: () => void; fit: () => void; focusCanvas: () => void; selected: LayerRecord | null;
  update: (properties: EditorMutation["properties"], transform?: LayerTransform, adjustments?: VisualAdjustments) => void;
  readOnly: boolean;
}) {
  const [query, setQuery] = useState("");
  const tools = [
    { label: "Select & move", description: "Position, resize and rotate layers", icon: MousePointer2, action: focusCanvas, mutating: false },
    { label: "Rich text", description: "Add editable type", icon: Type, action: addText, mutating: true },
    { label: "Rectangle", description: "Add a rectangle", icon: Shapes, action: () => addShape("rectangle"), mutating: true },
    { label: "Ellipse", description: "Add an ellipse", icon: Shapes, action: () => addShape("ellipse"), mutating: true },
    { label: "Line", description: "Add a line", icon: Minus, action: () => addShape("line"), mutating: true },
    { label: "Polygon", description: "Add a polygon", icon: Shapes, action: () => addShape("polygon"), mutating: true },
    { label: "Vector path", description: "Add an editable internal path", icon: Shapes, action: addVectorPath, mutating: true },
    { label: "Artboard", description: "Add another canvas", icon: BoxSelect, action: addArtboard, mutating: true },
    { label: "Save a copy", description: "Create an independent graphic", icon: CopyPlus, action: saveAs, mutating: false },
    { label: "Group", description: `Group ${groupCount} marked layers`, icon: Layers3, action: groupSelected, mutating: true },
    { label: "Ungroup", description: "Release a group without moving its children", icon: Layers3, action: ungroupSelected, mutating: true },
    { label: "Rotate", description: "Rotate selected layer 90 degrees", icon: RotateCw, action: () => selected && update({}, { ...selected.transform, rotation_degrees: (selected.transform.rotation_degrees ?? 0) + 90 }), mutating: true },
    { label: "Flip horizontal", description: "Mirror selected layer", icon: FlipHorizontal2, action: () => selected && update({}, { ...selected.transform, flip_x: !selected.transform.flip_x }), mutating: true },
    { label: "Fit view", description: "Frame every artboard", icon: Focus, action: fit, mutating: false },
  ];
  const visible = tools.filter((tool) => `${tool.label} ${tool.description}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="studio-panel-body all-tools"><label className="tool-search"><span className="sr-only">Search tools</span><input type="search" placeholder="Search tools" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div>{visible.map(({ label, description, icon: Icon, action, mutating }) => <button type="button" key={label} onClick={action} disabled={(mutating && readOnly) || ((label === "Rotate" || label === "Flip horizontal") && !selected) || (label === "Group" && groupCount < 2) || (label === "Ungroup" && !selected?.group)}><Icon aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span></button>)}</div></div>;
}

function NumberProperty({ label, value, onCommit, step = 1 }: { label: string; value: number; onCommit: (value: number) => void; step?: number }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Math.round(value * 1000) / 1000)), [value]);
  return <label>{label}<input type="number" step={step} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { const next = Number(draft); if (Number.isFinite(next)) onCommit(next); }} /></label>;
}

function LayerIcon({ layer }: { layer: LayerRecord }) {
  if (layer.layer_type === "rich_text") return <Type aria-hidden="true" />;
  if (layer.layer_type === "shape") return <Shapes aria-hidden="true" />;
  if (layer.layer_type === "raster_image") return <ImageIcon aria-hidden="true" />;
  return <Layers3 aria-hidden="true" />;
}

function layerTypeLabel(layer: LayerRecord) { return layer.layer_type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatDimension(value: number) { return Math.round(value * 100) / 100; }
function saveLabel(state: SaveState) { return { saved: "Saved", saving: "Saving...", offline: "Offline - changes not saved", conflict: "Save conflict", failed: "Save failed", "read-only": "View only" }[state]; }
function baseTransform(x: number, y: number, width: number, height: number): LayerTransform { return { x, y, width, height, rotation_degrees: 0, scale_x: 1, scale_y: 1, skew_x_degrees: 0, skew_y_degrees: 0, flip_x: false, flip_y: false }; }
function normalizedAdjustments(value: VisualAdjustments | undefined): VisualAdjustments { return { exposure: value?.exposure ?? 0, brightness: value?.brightness ?? 0, contrast: value?.contrast ?? 0, saturation: value?.saturation ?? 0, temperature: value?.temperature ?? 0, tint: value?.tint ?? 0, sharpness: value?.sharpness ?? 0 }; }
function normalizedCrop(value: CropRegion | undefined) { return { left: value?.left ?? 0, top: value?.top ?? 0, right: value?.right ?? 1, bottom: value?.bottom ?? 1 }; }

const APPROVED_FONTS = [
  { value: "system-ui", label: "System UI" },
  { value: "Arial", label: "Arial" },
  { value: "Times New Roman", label: "Times New Roman" },
  { value: "Courier New", label: "Courier New" },
] as const;

function artboardOrientation(width: number, height: number): "portrait" | "landscape" | "square" {
  return width === height ? "square" : width > height ? "landscape" : "portrait";
}

function artboardUnitScale(unit: string | undefined) { return { px: 1, in: 96, mm: 96 / 25.4, pt: 96 / 72 }[unit ?? "px"] ?? 1; }

function convertArtboardUnit<T extends { width: number; height: number; unit?: "px" | "mm" | "in" | "pt"; orientation: "portrait" | "landscape" | "square" }>(artboard: T, unit: "px" | "mm" | "in" | "pt"): T {
  const ratio = artboardUnitScale(artboard.unit) / artboardUnitScale(unit);
  const width = Math.round(artboard.width * ratio * 1000) / 1000;
  const height = Math.round(artboard.height * ratio * 1000) / 1000;
  return { ...artboard, unit, width, height, orientation: artboardOrientation(width, height) };
}

function siblingCount(snapshot: EditorDocumentSnapshot, layer: LayerRecord) {
  return (snapshot.layers ?? []).filter((item) => item.artboard_id === layer.artboard_id && (item.parent_layer_id ?? null) === (layer.parent_layer_id ?? null)).length;
}

function shapePoints(shape: "rectangle" | "ellipse" | "line" | "polygon") {
  if (shape === "line") return [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
  if (shape === "polygon") return [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  return [];
}

function replaceRichTextRun(runs: NonNullable<NonNullable<LayerRecord["rich_text"]>["runs"]>, replacement: NonNullable<NonNullable<LayerRecord["rich_text"]>["runs"]>[number]) {
  return [...runs.filter((run) => run.end <= replacement.start || run.start >= replacement.end), replacement]
    .sort((left, right) => left.start - right.start || left.end - right.end);
}
