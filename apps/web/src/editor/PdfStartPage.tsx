import { type FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, FilePlus2, Image as ImageIcon, Plus, Trash2 } from "lucide-react";
import type { PdfPageOrientation, PdfPagePreset, ProjectRecord, StudioSourceCandidate } from "ipw-contracts-ts/product";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api } from "../boundaries/apiClient";
import { Button, IconButton, InlineNotice, StatePanel, TextInput } from "../design-system";
import { workspacePath } from "../routes";

export function PdfStartPage() {
  const { workspaceId = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [sources, setSources] = useState<StudioSourceCandidate[] | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [preset, setPreset] = useState<PdfPagePreset>("a4");
  const [orientation, setOrientation] = useState<PdfPageOrientation>("portrait");
  const [projectId, setProjectId] = useState(params.get("project") ?? "");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.studioSources(workspaceId), api.projects(workspaceId)]).then(
      ([sourceResult, projectResult]) => {
        if (!active) return;
        setSources(sourceResult.sources);
        setProjects(projectResult.projects);
        const requested = params.get("source");
        if (requested && sourceResult.sources.some((source) => source.file_id === requested && source.editable && !source.requires_generated_preview)) {
          setOrderedIds([requested]);
          const source = sourceResult.sources.find((item) => item.file_id === requested);
          if (source) setName(`${source.display_name} PDF`);
        }
      },
      (reason: unknown) => setError(reason instanceof Error ? reason.message : "PDF sources could not be loaded"),
    );
    return () => { active = false; };
  }, [params, workspaceId]);

  const orderedSources = useMemo(
    () => orderedIds.flatMap((id) => sources?.find((source) => source.file_id === id) ?? []),
    [orderedIds, sources],
  );

  function addSource(id: string) {
    setOrderedIds((current) => current.length >= 50 || current.includes(id) ? current : [...current, id]);
  }

  function move(index: number, direction: -1 | 1) {
    setOrderedIds((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const result = await api.createPdfDocument(workspaceId, {
        name: name.trim() || "Untitled PDF",
        project_id: projectId || null,
        source_file_ids: orderedIds,
        page_preset: preset,
        orientation,
        image_placement: "contain",
        language: "en",
      });
      navigate(workspacePath(workspaceId, `pdf/${result.editor.document.document_id}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The PDF could not be created");
    } finally {
      setCreating(false);
    }
  }

  if (sources === null && !error) {
    return <main className="page studio-start"><StatePanel kind="loading" title="Preparing PDF creation" message="Loading verified image sources and workspace locations." /></main>;
  }

  const available = (sources ?? []).filter((source) => source.editable && !source.requires_generated_preview && !orderedIds.includes(source.file_id));
  const unavailable = (sources ?? []).filter((source) => !source.editable || source.requires_generated_preview);
  return <main className="page studio-start pdf-start" data-testid="pdf-start">
    <section className="page-heading"><div><p className="eyebrow">Create PDF</p><h1>Build a native PDF</h1><p>Start with a blank page or arrange up to 50 verified images. Originals remain unchanged.</p></div></section>
    {error && <InlineNotice tone="error" title="PDF could not start">{error}</InlineNotice>}
    <form onSubmit={(event) => void create(event)} className="studio-start-form">
      <section aria-labelledby="pdf-page-heading"><div className="section-heading"><div><h2 id="pdf-page-heading">Page setup</h2><p>All pages use one production-safe size in this release.</p></div></div>
        <div className="pdf-page-setup">
          <fieldset><legend>Size</legend><label><input type="radio" checked={preset === "a4"} onChange={() => setPreset("a4")} />A4 <small>210 x 297 mm</small></label><label><input type="radio" checked={preset === "letter"} onChange={() => setPreset("letter")} />Letter <small>8.5 x 11 in</small></label></fieldset>
          <fieldset><legend>Orientation</legend><label><input type="radio" checked={orientation === "portrait"} onChange={() => setOrientation("portrait")} />Portrait</label><label><input type="radio" checked={orientation === "landscape"} onChange={() => setOrientation("landscape")} />Landscape</label></fieldset>
        </div>
      </section>

      <section aria-labelledby="pdf-pages-heading"><div className="section-heading"><div><h2 id="pdf-pages-heading">Pages</h2><p>Image order becomes page order. Images are contained within safe margins and never cropped.</p></div><span>{orderedIds.length || 1} {orderedIds.length === 1 ? "page" : "pages"}</span></div>
        {orderedSources.length === 0
          ? <div className="studio-source-empty pdf-blank-page"><FilePlus2 aria-hidden="true" /><span><strong>One blank page</strong><small>Add text and images after creation, or keep this blank starting page.</small></span></div>
          : <ol className="pdf-page-order" aria-label="PDF page order">{orderedSources.map((source, index) => <li key={source.file_id}><span className="pdf-page-number">{index + 1}</span><ImageIcon aria-hidden="true" /><span><strong>{source.display_name}</strong><small>{source.width} x {source.height} px · {source.media_type}</small></span><div><IconButton label={`Move ${source.display_name} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp aria-hidden="true" /></IconButton><IconButton label={`Move ${source.display_name} down`} disabled={index === orderedSources.length - 1} onClick={() => move(index, 1)}><ArrowDown aria-hidden="true" /></IconButton><IconButton label={`Remove ${source.display_name}`} onClick={() => setOrderedIds((current) => current.filter((id) => id !== source.file_id))}><Trash2 aria-hidden="true" /></IconButton></div></li>)}</ol>}
        {available.length > 0 && <div className="asset-source-list pdf-source-list" aria-label="Available verified images">{available.map((source) => <article className="asset-row" key={source.file_id}><ImageIcon aria-hidden="true" /><span><strong>{source.display_name}</strong><small>{source.width} x {source.height} px · verified source</small></span><Button type="button" size="compact" disabled={orderedIds.length >= 50} onClick={() => addSource(source.file_id)}><Plus aria-hidden="true" />Add page</Button></article>)}</div>}
        {unavailable.length > 0 && <details className="pdf-unavailable-sources"><summary>{unavailable.length} source {unavailable.length === 1 ? "is" : "are"} not ready for direct PDF placement</summary><p>Large or unsupported sources must first pass the bounded image preparation flow.</p></details>}
      </section>

      <div className="studio-start-fields">
        <TextInput label="PDF name" maxLength={200} value={name} placeholder="Untitled PDF" onChange={(event) => setName(event.target.value)} />
        <label className="studio-select-label">Location<select className="ds-select" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Default Files</option>{projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}</select></label>
      </div>
      <InlineNotice tone="info" title="Screen PDF output">The first output profile is an sRGB Screen PDF. It is intentionally disclosed as untagged and not PDF/A.</InlineNotice>
      <div className="studio-start-actions"><Button type="button" onClick={() => navigate(workspacePath(workspaceId))}>Cancel</Button><Button tone="primary" disabled={creating}>{creating ? "Creating..." : "Create PDF"}</Button></div>
    </form>
  </main>;
}
