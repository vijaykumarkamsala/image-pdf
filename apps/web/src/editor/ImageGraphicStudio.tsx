import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  VisualAdjustments,
  WorkspaceFile,
} from "ipw-contracts-ts/product";

import { ApiError, api } from "../boundaries/apiClient";
import { Button, Dialog, IconButton, InlineNotice, StatePanel, Tabs, TextInput, Tooltip } from "../design-system";
import { PanelFramework } from "../panels/PanelFramework";
import { workspacePath } from "../routes";
import { FabricEditorRenderer } from "./renderer/FabricEditorRenderer";
import type { EditorRenderer, RendererViewport } from "./renderer/EditorRenderer";

type SaveState = "saved" | "saving" | "offline" | "conflict" | "failed" | "read-only";

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
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [sourceId, setSourceId] = useState(params.get("source") ?? "");
  const [projectId, setProjectId] = useState(params.get("project") ?? "");
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>(PRESETS[0]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.files(workspaceId), api.projects(workspaceId)]).then(
      ([fileResult, projectResult]) => { setFiles(fileResult.files); setProjects(projectResult.projects); },
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
        {files.length === 0 ? <div className="studio-source-empty"><ImageIcon aria-hidden="true" /><span>Accepted images from Default Files will appear here.</span></div> : <div className="studio-source-list" role="radiogroup" aria-label="Source file">{files.map((file) => <button
          type="button" role="radio" aria-checked={sourceId === file.file_id} key={file.file_id} onClick={() => { setSourceId(file.file_id); setName(`${file.display_name} design`); }}
        ><ImageIcon aria-hidden="true" /><span><strong>{file.display_name}</strong><small>Source preserved</small></span></button>)}</div>}
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<EditorRenderer | null>(null);
  const editorRef = useRef<DocumentReadModel | null>(null);
  const selectedRef = useRef<string | null>(null);
  const leaseRef = useRef("");
  const saveChain = useRef(Promise.resolve());
  const [editor, setEditor] = useState<DocumentReadModel | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saving");
  const [message, setMessage] = useState<string | null>(null);
  const [viewport, setViewport] = useState<RendererViewport>({ zoom: 1, panX: 0, panY: 0 });
  const [leftTab, setLeftTab] = useState("layers");
  const [rightTab, setRightTab] = useState("properties");
  const [activeArtboardId, setActiveArtboardId] = useState("");
  const [versionName, setVersionName] = useState("");
  const [compatibility, setCompatibility] = useState<ImportCompatibilityReport[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [saveAsProjectId, setSaveAsProjectId] = useState("");
  const [savingCopy, setSavingCopy] = useState(false);
  const editorReady = editor !== null;

  const updateEditor = useCallback((next: DocumentReadModel) => {
    editorRef.current = next;
    setEditor(next);
    sessionStorage.setItem(`ipw-editor-recovery:${next.document.document_id}`, JSON.stringify({ revision: next.snapshot.revision, updatedAt: next.document.updated_at }));
  }, []);

  useEffect(() => {
    let active = true;
    setMessage(null);
    Promise.all([api.document(workspaceId, documentId), api.acquireDocumentLease(workspaceId, documentId), api.documentCompatibility(workspaceId, documentId)]).then(
      ([documentResponse, leaseResponse, compatibilityResponse]) => {
        if (!active) return;
        leaseRef.current = leaseResponse.grant.lease_token;
        updateEditor(documentResponse.editor);
        setActiveArtboardId(documentResponse.editor.snapshot.artboards[0]?.artboard_id ?? "");
        setCompatibility(compatibilityResponse.reports);
        setSaveState("saved");
      },
      async (reason: unknown) => {
        if (!active) return;
        if (reason instanceof ApiError && reason.code === "document-lease-held") {
          try {
            const documentResponse = await api.document(workspaceId, documentId);
            if (!active) return;
            updateEditor(documentResponse.editor);
            setSaveState("read-only");
            setMessage(reason.message);
          } catch { setMessage("The document could not be opened"); }
        } else setMessage(reason instanceof Error ? reason.message : "The document could not be opened");
      },
    );
    return () => {
      active = false;
      const token = leaseRef.current;
      leaseRef.current = "";
      if (token) void api.releaseDocumentLease(workspaceId, documentId, token).catch(() => undefined);
    };
  }, [documentId, updateEditor, workspaceId]);

  useEffect(() => {
    let active = true;
    void api.projects(workspaceId).then((result) => {
      if (active) setProjects(result.projects);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [workspaceId]);

  useEffect(() => {
    if (!leaseRef.current) return;
    const timer = window.setInterval(() => {
      if (!navigator.onLine) { setSaveState("offline"); return; }
      void api.heartbeatDocumentLease(workspaceId, documentId, leaseRef.current).then(
        () => setSaveState((current) => current === "offline" ? "saved" : current),
        () => setSaveState("read-only"),
      );
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [documentId, editor, workspaceId]);

  const commit = useCallback((mutation: EditorMutation) => {
    if (!leaseRef.current) return;
    setSaveState(navigator.onLine ? "saving" : "offline");
    saveChain.current = saveChain.current.then(async () => {
      if (!navigator.onLine) throw new ApiError(503, "offline", "New uploads and online processing require a connection.");
      const current = editorRef.current;
      if (!current) return;
      const response = await api.mutateDocument(workspaceId, documentId, leaseRef.current, current.snapshot.revision, mutation);
      const next = { ...current, document: response.mutation.document, snapshot: response.mutation.snapshot };
      if (response.mutation.checkpoint) next.versions = [response.mutation.checkpoint, ...current.versions];
      updateEditor(next);
      setSaveState("saved");
      setMessage(null);
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.code === "document-revision-conflict") setSaveState("conflict");
      else if (reason instanceof ApiError && reason.code === "offline") setSaveState("offline");
      else setSaveState("failed");
      setMessage(reason instanceof Error ? reason.message : "Changes could not be saved");
    });
  }, [documentId, updateEditor, workspaceId]);

  useEffect(() => {
    const element = canvasRef.current;
    const surface = surfaceRef.current;
    if (!element || !surface || rendererRef.current) return;
    const renderer = new FabricEditorRenderer();
    renderer.mount(element, {
      onSelection: (id) => { selectedRef.current = id; setSelectedId(id); },
      onTransform: (layerId, transform) => commit({ kind: "layer.update", target_id: layerId, transform, properties: {} }),
      onViewport: setViewport,
    });
    rendererRef.current = renderer;
    const observer = new ResizeObserver(([entry]) => renderer.resize(entry.contentRect.width, entry.contentRect.height));
    observer.observe(surface);
    renderer.resize(surface.clientWidth, surface.clientHeight);
    return () => { observer.disconnect(); renderer.dispose(); rendererRef.current = null; };
  }, [commit, editorReady]);

  useEffect(() => {
    if (!editor || !rendererRef.current) return;
    const selectedBeforeRender = selectedRef.current;
    void rendererRef.current.render(
      editor.snapshot,
      editor.document.source_file_id ? api.documentSourceUrl(workspaceId, documentId) : undefined,
    ).then(() => rendererRef.current?.select(selectedBeforeRender))
      .catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : "Preview could not be rendered"));
  }, [documentId, editor, workspaceId]);

  const selected = useMemo(() => (editor?.snapshot.layers ?? []).find((item) => item.layer_id === selectedId) ?? null, [editor, selectedId]);

  async function history(direction: "undo" | "redo") {
    if (!leaseRef.current) return;
    setSaveState("saving");
    try {
      const response = await api.documentHistory(workspaceId, documentId, leaseRef.current, direction);
      const current = editorRef.current!;
      updateEditor({ ...current, document: response.history.document, snapshot: response.history.snapshot });
      setSaveState("saved");
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : `${direction} failed`); setSaveState("failed"); }
  }

  function addShape() {
    const current = editorRef.current;
    if (!current) return;
    const artboard = current.snapshot.artboards[0];
    const id = `layer-${crypto.randomUUID()}`;
    const layer: LayerRecord = {
      layer_id: id, artboard_id: artboard.artboard_id, parent_layer_id: null, layer_type: "shape", name: "Rectangle",
      order: current.snapshot.layers?.length ?? 0, visible: true, locked: false, opacity: 1, blend_mode: "normal",
      transform: baseTransform(artboard.width * 0.2, artboard.height * 0.36, Math.min(320, artboard.width * 0.35), Math.min(220, artboard.height * 0.3)),
      shared_style_ids: [], raster: null, vector: null, rich_text: null,
      shape: { shape: "rectangle", fill: "#3559e0", stroke: null, stroke_width: 0, corner_radius: 12 },
      group: null, extension_payload: {},
    };
    selectedRef.current = id;
    setSelectedId(id);
    commit({ kind: "layer.add", target_id: id, layer, properties: {} });
  }

  function addText() {
    const current = editorRef.current;
    if (!current) return;
    const artboard = current.snapshot.artboards[0];
    const id = `layer-${crypto.randomUUID()}`;
    const layer: LayerRecord = {
      layer_id: id, artboard_id: artboard.artboard_id, parent_layer_id: null, layer_type: "rich_text", name: "Heading",
      order: current.snapshot.layers?.length ?? 0, visible: true, locked: false, opacity: 1, blend_mode: "normal",
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
    const first = current.snapshot.artboards[0];
    const order = current.snapshot.artboards.length;
    commit({
      kind: "artboard.add",
      artboard: {
        artboard_id: `artboard-${crypto.randomUUID()}`, name: `Artboard ${order + 1}`, order,
        width: first.width, height: first.height, unit: first.unit, orientation: first.orientation,
        background: structuredClone(first.background), intended_use: structuredClone(first.intended_use),
      },
      properties: {},
    });
  }

  function groupSelected() {
    const current = editorRef.current;
    const selectedLayer = (current?.snapshot.layers ?? []).find((item) => item.layer_id === selectedId);
    if (!current || !selectedLayer) return;
    const id = `layer-${crypto.randomUUID()}`;
    commit({
      kind: "layer.add",
      target_id: id,
      layer: {
        layer_id: id, artboard_id: selectedLayer.artboard_id, parent_layer_id: null, layer_type: "group",
        name: "Group", order: selectedLayer.order, visible: true, locked: false, opacity: 1, blend_mode: "normal",
        transform: baseTransform(0, 0, 1, 1), shared_style_ids: [], raster: null, vector: null, rich_text: null,
        shape: null, group: { collapsed: false }, extension_payload: {},
      },
      properties: {},
    });
    commit({ kind: "layer.reorder", target_id: selectedLayer.layer_id, properties: { parent_layer_id: id } });
  }

  function updateLayer(properties: EditorMutation["properties"], transform?: LayerTransform, adjustments?: VisualAdjustments) {
    if (!selected) return;
    commit({ kind: "layer.update", target_id: selected.layer_id, transform, adjustments, properties: properties ?? {} });
  }

  async function nameVersion() {
    if (!versionName.trim()) return;
    try {
      const response = await api.createDocumentVersion(workspaceId, documentId, versionName.trim());
      const current = editorRef.current!;
      updateEditor({ ...current, document: { ...current.document, current_version_id: response.version.document_version_id }, versions: [response.version, ...current.versions] });
      setVersionName("");
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Version could not be saved"); }
  }

  async function restore(versionId: string) {
    if (!leaseRef.current) return;
    try {
      setSaveState("saving");
      const response = await api.restoreDocumentVersion(workspaceId, documentId, versionId, leaseRef.current);
      updateEditor(response.editor);
      setSaveState("saved");
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Version could not be restored"); setSaveState("failed"); }
  }

  async function requestTakeover() {
    try {
      const response = await api.takeoverDocumentLease(workspaceId, documentId);
      if (response.takeover.status === "acquired" && response.takeover.grant) {
        leaseRef.current = response.takeover.grant.lease_token;
        setSaveState("saved");
        setMessage(null);
      } else {
        setMessage("Editing access was requested from the current editor.");
      }
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "Editing access could not be requested"); }
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
      const response = await api.saveAsDocument(workspaceId, documentId, saveAsName.trim(), saveAsProjectId || undefined);
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
        commit({ kind: "layer.remove", target_id: selectedId, properties: {} });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commit, selectedId]);

  if (!editor) return <main className="studio-loading">{message ? <StatePanel kind="error" title="Studio unavailable" message={message} action={{ label: "Back to Home", onClick: () => navigate(workspacePath(workspaceId)) }} /> : <StatePanel kind="loading" title="Opening Studio" message="Loading the native document and editor lease." />}</main>;

  const leftPanel = <Tabs label="Document panels" selected={leftTab} onSelect={setLeftTab} items={[
    { id: "artboards", label: "Artboards", panel: <ArtboardsPanel snapshot={editor.snapshot} activeId={activeArtboardId} select={(id) => { setActiveArtboardId(id); rendererRef.current?.fitArtboard(id); }} add={addArtboard} /> },
    { id: "layers", label: "Layers", panel: <LayersPanel snapshot={editor.snapshot} selectedId={selectedId} select={(id) => { selectedRef.current = id; setSelectedId(id); rendererRef.current?.select(id); }} mutate={commit} /> },
    { id: "assets", label: "Assets", panel: <AssetsPanel editor={editor} compatibility={compatibility} /> },
    { id: "history", label: "History", panel: <HistoryPanel editor={editor} versionName={versionName} setVersionName={setVersionName} save={() => void nameVersion()} restore={(id) => void restore(id)} /> },
  ]} />;
  const rightPanel = <Tabs label="Tool panels" selected={rightTab} onSelect={setRightTab} items={[
    { id: "properties", label: "Properties", panel: <PropertiesPanel layer={selected} update={updateLayer} mutate={commit} /> },
    { id: "all-tools", label: "All Tools", panel: <AllTools addShape={addShape} addText={addText} addArtboard={addArtboard} groupSelected={groupSelected} saveAs={openSaveAs} fit={() => rendererRef.current?.fit()} focusCanvas={() => surfaceRef.current?.querySelector<HTMLElement>(".upper-canvas")?.focus()} selected={selected} update={updateLayer} /> },
  ]} />;

  return <main className="studio" data-testid="image-graphic-studio">
    <div className="studio-command-bar" role="toolbar" aria-label="Editor commands">
      <Tooltip label="Back to Home"><IconButton label="Back to Home" onClick={() => navigate(workspacePath(workspaceId))}><ArrowLeft aria-hidden="true" /></IconButton></Tooltip>
      <div className="studio-document-title"><h1 title={editor.document.name}>{editor.document.name}</h1><span>{editor.snapshot.artboards.length} {editor.snapshot.artboards.length === 1 ? "artboard" : "artboards"}</span></div>
      <div className={`studio-save-state state-${saveState}`} role="status"><Save aria-hidden="true" /><span>{saveLabel(saveState)}</span></div>
      <div className="studio-command-group" role="group" aria-label="History"><IconButton label="Undo" disabled={saveState === "read-only"} onClick={() => void history("undo")}><Undo2 aria-hidden="true" /></IconButton><IconButton label="Redo" disabled={saveState === "read-only"} onClick={() => void history("redo")}><Redo2 aria-hidden="true" /></IconButton><IconButton label="Save as" disabled={saveState === "saving" || saveState === "offline" || saveState === "conflict" || saveState === "failed"} onClick={openSaveAs}><CopyPlus aria-hidden="true" /></IconButton></div>
      <div className="studio-command-group add-tools" role="group" aria-label="Add"><Button size="compact" onClick={addText}><Type aria-hidden="true" />Text</Button><Button size="compact" onClick={addShape}><Shapes aria-hidden="true" />Shape</Button><Button size="compact" onClick={addArtboard}><Plus aria-hidden="true" />Artboard</Button></div>
      <div className="studio-command-group" role="group" aria-label="Zoom"><IconButton label="Zoom out" onClick={() => rendererRef.current?.zoomBy(0.8)}><ZoomOut aria-hidden="true" /></IconButton><span className="zoom-value">{Math.round(viewport.zoom * 100)}%</span><IconButton label="Zoom in" onClick={() => rendererRef.current?.zoomBy(1.25)}><ZoomIn aria-hidden="true" /></IconButton><IconButton label="Fit artboards" onClick={() => rendererRef.current?.fit()}><Maximize2 aria-hidden="true" /></IconButton></div>
    </div>
    {message && <div className="studio-message" role="alert"><span>{message}</span>{saveState === "conflict" && <Button size="compact" onClick={() => window.location.reload()}>Reload</Button>}{saveState === "read-only" && <Button size="compact" onClick={() => void requestTakeover()}>Request access</Button>}</div>}
    <PanelFramework mode="editor" panels={[
      { id: "inspector", title: "Document", slot: "tool", children: leftPanel, canClose: false },
      { id: "conversation", title: "Tools", slot: "conversation", children: rightPanel, canClose: false },
    ]} center={<CanvasSurface canvasRef={canvasRef} surfaceRef={surfaceRef} editor={editor} />} />
    <Dialog open={saveAsOpen} title="Save a copy" onClose={() => setSaveAsOpen(false)}>
      <form className="modal-form" onSubmit={(event) => void saveAs(event)}>
        <TextInput autoFocus label="Graphic name" maxLength={200} value={saveAsName} onChange={(event) => setSaveAsName(event.target.value)} />
        <label className="studio-select-label">Location<select className="ds-select" value={saveAsProjectId} onChange={(event) => setSaveAsProjectId(event.target.value)}><option value="">Default Files</option>{projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}</select></label>
        <div className="dialog-actions"><Button type="button" onClick={() => setSaveAsOpen(false)}>Cancel</Button><Button tone="primary" disabled={savingCopy || !saveAsName.trim()}>{savingCopy ? "Saving..." : "Save copy"}</Button></div>
      </form>
    </Dialog>
  </main>;
}

function CanvasSurface({ canvasRef, surfaceRef, editor }: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  editor: DocumentReadModel;
}) {
  return <div className="studio-canvas-shell" ref={surfaceRef}>
    <div className="canvas-corner" aria-hidden="true" />
    <div className="canvas-ruler canvas-ruler-x" aria-hidden="true" />
    <div className="canvas-ruler canvas-ruler-y" aria-hidden="true" />
    <canvas ref={canvasRef} aria-label={`${editor.document.name} editable artboards`} />
    <span className="preview-evidence">Browser preview | Native document remains authoritative</span>
  </div>;
}

function ArtboardsPanel({ snapshot, activeId, select, add }: {
  snapshot: EditorDocumentSnapshot;
  activeId: string;
  select: (id: string) => void;
  add: () => void;
}) {
  const artboards = [...snapshot.artboards].sort((left, right) => left.order - right.order);
  return <div className="studio-panel-body"><div className="artboard-list" role="list" aria-label="Artboards">{artboards.map((artboard) => <div role="listitem" key={artboard.artboard_id}><button type="button" aria-pressed={activeId === artboard.artboard_id} onClick={() => select(artboard.artboard_id)}><span className="artboard-thumbnail" style={{ aspectRatio: `${artboard.width} / ${artboard.height}` }} /><span><strong>{artboard.name}</strong><small>{formatDimension(artboard.width)} x {formatDimension(artboard.height)} {artboard.unit} | {artboard.intended_use.label}</small></span></button></div>)}</div><Button size="compact" onClick={add}><Plus aria-hidden="true" />Add artboard</Button></div>;
}

function LayersPanel({ snapshot, selectedId, select, mutate }: {
  snapshot: EditorDocumentSnapshot;
  selectedId: string | null;
  select: (id: string) => void;
  mutate: (mutation: EditorMutation) => void;
}) {
  const layers = [...(snapshot.layers ?? [])].sort((left, right) => right.order - left.order);
  return <div className="studio-panel-body">{layers.length === 0 ? <div className="studio-panel-empty"><Layers3 aria-hidden="true" /><strong>No layers yet</strong><span>Add text or a shape to begin.</span></div> : <div className="layer-list" role="list" aria-label="Layers">{layers.map((layer, index) => <div className={selectedId === layer.layer_id ? "layer-row is-selected" : "layer-row"} role="listitem" key={layer.layer_id}>
    <button type="button" aria-pressed={selectedId === layer.layer_id} onClick={() => select(layer.layer_id)}><span className="layer-kind"><LayerIcon layer={layer} /></span><span><strong>{layer.name}</strong><small>{layerTypeLabel(layer)}</small></span></button>
    <IconButton label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`} onClick={() => mutate({ kind: "layer.update", target_id: layer.layer_id, properties: { visible: !layer.visible } })}>{layer.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}</IconButton>
    <IconButton label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`} onClick={() => mutate({ kind: "layer.update", target_id: layer.layer_id, properties: { locked: !layer.locked } })}>{layer.locked ? <Lock aria-hidden="true" /> : <Unlock aria-hidden="true" />}</IconButton>
    <div className="layer-order"><IconButton label="Move layer up" disabled={index === 0} onClick={() => mutate({ kind: "layer.reorder", target_id: layer.layer_id, properties: { order: layer.order + 1 } })}><ChevronUp aria-hidden="true" /></IconButton><IconButton label="Move layer down" disabled={index === layers.length - 1} onClick={() => mutate({ kind: "layer.reorder", target_id: layer.layer_id, properties: { order: Math.max(0, layer.order - 1) } })}><ChevronDown aria-hidden="true" /></IconButton></div>
  </div>)}</div>}</div>;
}

function AssetsPanel({ editor, compatibility }: { editor: DocumentReadModel; compatibility: ImportCompatibilityReport[] }) {
  const assets = editor.snapshot.shared_assets ?? [];
  return <div className="studio-panel-body"><h3>Linked assets</h3>{assets.length === 0 ? <div className="studio-panel-empty"><ImageIcon aria-hidden="true" /><strong>No linked source</strong><span>This graphic began with a blank artboard.</span></div> : assets.map((asset) => <article className="asset-row" key={asset.shared_asset_id}><ImageIcon aria-hidden="true" /><span><strong>{asset.name}</strong><small>Linked immutable source</small></span></article>)}{compatibility.map((report) => <InlineNotice key={report.compatibility_report_id} tone={report.state === "compatible" ? "success" : "warning"} title={report.state === "compatible" ? "Raster compatible" : "Compatibility limits"}>{report.source_preserved ? "Original source preserved." : ""}</InlineNotice>)}</div>;
}

function HistoryPanel({ editor, versionName, setVersionName, save, restore }: {
  editor: DocumentReadModel;
  versionName: string;
  setVersionName: (value: string) => void;
  save: () => void;
  restore: (id: string) => void;
}) {
  return <div className="studio-panel-body history-panel"><div className="version-create"><TextInput label="Version name" maxLength={100} value={versionName} onChange={(event) => setVersionName(event.target.value)} /><Button size="compact" disabled={!versionName.trim()} onClick={save}>Save version</Button></div><div className="version-list">{editor.versions.map((version) => <article key={version.document_version_id}><span><strong>{version.name || version.kind.replaceAll("_", " ")}</strong><small>Revision {version.revision} | {version.kind.replaceAll("_", " ")}</small></span>{version.document_version_id !== editor.document.current_version_id && <Button tone="quiet" size="compact" onClick={() => restore(version.document_version_id)}>Restore</Button>}</article>)}</div></div>;
}

function PropertiesPanel({ layer, update, mutate }: {
  layer: LayerRecord | null;
  update: (properties: EditorMutation["properties"], transform?: LayerTransform, adjustments?: VisualAdjustments) => void;
  mutate: (mutation: EditorMutation) => void;
}) {
  if (!layer) return <div className="studio-panel-empty"><MousePointer2 aria-hidden="true" /><strong>Select a layer</strong><span>Its transform and appearance controls will appear here.</span></div>;
  const transform = layer.transform;
  const rotation = transform.rotation_degrees ?? 0;
  const opacity = layer.opacity ?? 1;
  const crop = layer.raster ? normalizedCrop(layer.raster.crop) : null;
  return <div className="studio-panel-body properties-panel"><div className="property-heading"><LayerIcon layer={layer} /><span><strong>{layer.name}</strong><small>{layerTypeLabel(layer)}</small></span></div>
    <fieldset><legend>Transform</legend><div className="property-grid">{(["x", "y", "width", "height", "rotation_degrees"] as const).map((key) => <NumberProperty key={key} label={key === "rotation_degrees" ? "Rotate" : key.toUpperCase()} value={key === "rotation_degrees" ? rotation : transform[key]} onCommit={(value) => update({}, { ...transform, [key]: key === "width" || key === "height" ? Math.max(1, value) : value })} />)}</div><div className="property-actions"><IconButton label="Flip horizontally" onClick={() => update({}, { ...transform, flip_x: !(transform.flip_x ?? false) })}><FlipHorizontal2 aria-hidden="true" /></IconButton><IconButton label="Flip vertically" onClick={() => update({}, { ...transform, flip_y: !(transform.flip_y ?? false) })}><FlipVertical2 aria-hidden="true" /></IconButton><IconButton label="Rotate 90 degrees" onClick={() => update({}, { ...transform, rotation_degrees: rotation + 90 > 360 ? rotation - 270 : rotation + 90 })}><RotateCw aria-hidden="true" /></IconButton></div></fieldset>
    <fieldset><legend>Layer</legend><label>Opacity <span>{Math.round(opacity * 100)}%</span><input type="range" min="0" max="100" value={Math.round(opacity * 100)} onChange={(event) => update({ opacity: Number(event.target.value) / 100 })} /></label><label>Blend mode<select value={layer.blend_mode ?? "normal"} onChange={(event) => update({ blend_mode: event.target.value })}><option value="normal">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="overlay">Overlay</option></select></label></fieldset>
    {layer.raster && crop && <><fieldset><legend>Crop</legend><div className="property-grid">{(["left", "top", "right", "bottom"] as const).map((key) => <NumberProperty key={key} label={key} step={0.01} value={crop[key]} onCommit={(value) => mutate({ kind: "layer.update", target_id: layer.layer_id, crop: { ...crop, [key]: Math.min(1, Math.max(0, value)) }, properties: {} })} />)}</div></fieldset><fieldset><legend>Quick correction</legend><label>Light <span>{layer.raster.adjustments?.brightness ?? 0}</span><input type="range" min="-100" max="100" value={layer.raster.adjustments?.brightness ?? 0} onChange={(event) => update({}, undefined, { ...normalizedAdjustments(layer.raster!.adjustments), brightness: Number(event.target.value) })} /></label></fieldset><details className="advanced-controls"><summary>Advanced adjustments</summary><AdjustmentControls value={normalizedAdjustments(layer.raster.adjustments)} update={(adjustments) => update({}, undefined, adjustments)} /></details></>}
    {layer.rich_text && <fieldset><legend>Text</legend><label className="property-textarea">Content<textarea defaultValue={layer.rich_text.text} onBlur={(event) => mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, rich_text: { ...layer.rich_text!, text: event.target.value } }, properties: {} })} /></label></fieldset>}
    {layer.shape && <fieldset><legend>Shape</legend><label>Fill<input type="color" value={layer.shape.fill ?? "#3559e0"} onChange={(event) => mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, shape: { ...layer.shape!, fill: event.target.value } }, properties: {} })} /></label></fieldset>}
    {layer.raster && <fieldset><legend>Asset instance</legend><label>Mode<select aria-label="Asset instance mode" value={layer.raster.instance_mode ?? "linked"} onChange={(event) => mutate({ kind: "layer.update", target_id: layer.layer_id, layer: { ...layer, raster: { ...layer.raster!, instance_mode: event.target.value as "linked" | "independent" } }, properties: {} })}><option value="linked">Linked</option><option value="independent">Independent</option></select></label></fieldset>}
    {(layer.raster || layer.vector) && <Button onClick={() => {
      const maskId = `mask-${crypto.randomUUID()}`;
      mutate({ kind: "mask.update", target_id: layer.layer_id, mask: { mask_id: maskId, artboard_id: layer.artboard_id, name: `Mask for ${layer.name}`, kind: "shape", enabled: true, inverted: false, feather: 0, path_data: "rect(0,0,1,1)", object_reference_id: null }, properties: {} });
    }}><Blend aria-hidden="true" />Add editable mask</Button>}
  </div>;
}

function AdjustmentControls({ value, update }: { value: VisualAdjustments; update: (value: VisualAdjustments) => void }) {
  const controls: Array<[keyof VisualAdjustments, string, number, number]> = [
    ["exposure", "Exposure", -100, 100], ["brightness", "Brightness", -100, 100], ["contrast", "Contrast", -100, 100],
    ["saturation", "Saturation", -100, 100], ["temperature", "Temperature", -100, 100], ["tint", "Tint", -100, 100], ["sharpness", "Sharpness", 0, 100],
  ];
  return <fieldset><legend>Adjustments</legend>{controls.map(([key, label, min, max]) => <label key={key}>{label}<span>{value[key] ?? 0}</span><input type="range" min={min} max={max} value={(value[key] as number | undefined) ?? 0} onChange={(event) => update({ ...value, [key]: Number(event.target.value) })} /></label>)}</fieldset>;
}

function AllTools({ addShape, addText, addArtboard, groupSelected, saveAs, fit, focusCanvas, selected, update }: {
  addShape: () => void; addText: () => void; addArtboard: () => void; groupSelected: () => void; saveAs: () => void; fit: () => void; focusCanvas: () => void; selected: LayerRecord | null;
  update: (properties: EditorMutation["properties"], transform?: LayerTransform, adjustments?: VisualAdjustments) => void;
}) {
  const [query, setQuery] = useState("");
  const tools = [
    { label: "Select & move", description: "Position, resize and rotate layers", icon: MousePointer2, action: focusCanvas },
    { label: "Rich text", description: "Add editable type", icon: Type, action: addText },
    { label: "Shape", description: "Add a vector shape", icon: Shapes, action: addShape },
    { label: "Artboard", description: "Add another canvas", icon: BoxSelect, action: addArtboard },
    { label: "Save a copy", description: "Create a new graphic in Files or a project", icon: CopyPlus, action: saveAs },
    { label: "Group", description: "Nest the selected layer in a group", icon: Layers3, action: groupSelected },
    { label: "Rotate", description: "Rotate selected layer 90 degrees", icon: RotateCw, action: () => selected && update({}, { ...selected.transform, rotation_degrees: (selected.transform.rotation_degrees ?? 0) + 90 }) },
    { label: "Flip horizontal", description: "Mirror selected layer", icon: FlipHorizontal2, action: () => selected && update({}, { ...selected.transform, flip_x: !selected.transform.flip_x }) },
    { label: "Fit view", description: "Frame every artboard", icon: Focus, action: fit },
  ];
  const visible = tools.filter((tool) => `${tool.label} ${tool.description}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="studio-panel-body all-tools"><label className="tool-search"><span className="sr-only">Search tools</span><input type="search" placeholder="Search tools" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div>{visible.map(({ label, description, icon: Icon, action }) => <button type="button" key={label} onClick={action} disabled={(label === "Rotate" || label === "Flip horizontal" || label === "Group") && !selected}><Icon aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span></button>)}</div></div>;
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
