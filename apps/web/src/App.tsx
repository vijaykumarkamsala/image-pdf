import { type FormEvent, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  BriefcaseBusiness, CheckCircle2, ChevronDown, CircleDashed, FileStack, FolderKanban, Home,
  Image, Layers3, Menu, Moon, Plus, Printer, Sun, Upload, X,
} from "lucide-react";
import type { ProjectRecord, WorkspaceFile } from "ipw-contracts-ts/product";

import { ApiError, api, type WorkspaceContextResponse } from "./boundaries/apiClient.ts";
import { productFeatureState } from "./boundaries/featureFlags.ts";
import { loadGuestSession, storeGuestSession, type StoredGuestSession } from "./boundaries/session.ts";
import { UploadDialog } from "./components/UploadDialog.tsx";
import { futureOutcomes, workspacePath, workspaceRoutes } from "./routes.ts";

type Theme = "light" | "dark";

function AppLoading() {
  return <main className="center-state" aria-busy="true"><span className="loading-mark" aria-hidden="true" /><p>Opening your workspace...</p></main>;
}

function AppError({ error, retry }: { error: Error; retry: () => void }) {
  const denied = error instanceof ApiError && error.status === 403;
  return (
    <main className="center-state" role="alert">
      <div className="state-icon"><X aria-hidden="true" /></div>
      <h1>{denied ? "Workspace access denied" : "Workspace unavailable"}</h1>
      <p>{error.message}</p>
      <button className="button primary" onClick={retry}>Try again</button>
    </main>
  );
}

function useWorkspace() {
  const [context, setContext] = useState<WorkspaceContextResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    api.bootstrap().then(
      (value) => active && setContext(value),
      (reason: unknown) => active && setError(reason instanceof Error ? reason : new Error("Workspace unavailable")),
    );
    return () => { active = false; };
  }, [attempt]);
  return { context, error, retry: () => setAttempt((value) => value + 1) };
}

function ThemeButton({ theme, toggle }: { theme: Theme; toggle: () => void }) {
  const Icon = theme === "light" ? Moon : Sun;
  return (
    <button className="icon-button" onClick={toggle} title={`Use ${theme === "light" ? "dark" : "light"} theme`}>
      <Icon aria-hidden="true" /><span className="sr-only">Use {theme === "light" ? "dark" : "light"} theme</span>
    </button>
  );
}

function WorkspaceShell({ context, theme, toggleTheme }: {
  context: WorkspaceContextResponse; theme: Theme; toggleTheme: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [fileRefresh, setFileRefresh] = useState(0);
  const [fileCount, setFileCount] = useState(0);
  const id = context.workspace.workspace_id;
  const navIcons = [Home, FolderKanban, FileStack];
  useEffect(() => {
    let active = true;
    api.files(id).then((result) => { if (active) setFileCount(result.files.length); }, () => undefined);
    return () => { active = false; };
  }, [id, fileRefresh]);
  return (
    <div className="workspace-shell">
      <aside className={mobileOpen ? "sidebar open" : "sidebar"}>
        <div className="wordmark">
          <span className="wordmark-symbol">V</span><span>Visual Workspace</span>
          {mobileOpen && <button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} title="Close navigation"><X aria-hidden="true" /></button>}
        </div>
        <nav className="primary-nav" aria-label="Workspace navigation">
          {workspaceRoutes.map((route, index) => {
            const Icon = navIcons[index];
            return (
              <NavLink aria-label={route.label} key={route.segment} end={!route.segment} to={workspacePath(id, route.segment)} onClick={() => setMobileOpen(false)}>
                <Icon aria-hidden="true" /><span>{route.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="testing-status"><CheckCircle2 aria-hidden="true" /><div><strong>Free during testing</strong><span>{fileCount} {fileCount === 1 ? "file" : "files"} &middot; 0 jobs</span></div></div>
      </aside>
      {mobileOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <div className="workspace-main">
        <header className="workspace-header">
          <button className="icon-button menu-button" onClick={() => setMobileOpen(true)} title="Open navigation"><Menu aria-hidden="true" /></button>
          <button className="workspace-switcher"><span>{context.workspace.name}</span><ChevronDown aria-hidden="true" /></button>
          <div className="header-actions">
            <ThemeButton theme={theme} toggle={toggleTheme} />
            <span className="avatar" aria-label={`Signed in as ${context.actor.display_name}`}>{context.actor.display_name.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceHome context={context} onUpload={() => setUploadOpen(true)} />} />
          <Route path="/w/:workspaceId/projects" element={<ProjectsPage />} />
          <Route path="/w/:workspaceId/files" element={<FilesPage defaultFilesName={context.default_files.name ?? "Default Files"} refresh={fileRefresh} onUpload={() => setUploadOpen(true)} />} />
          <Route path="*" element={<Navigate replace to={workspacePath(id)} />} />
        </Routes>
      </div>
      <nav className="mobile-nav" aria-label="Mobile workspace navigation">
        {workspaceRoutes.map((route, index) => {
          const Icon = navIcons[index];
          return <NavLink aria-label={route.label} key={route.segment} end={!route.segment} to={workspacePath(id, route.segment)}><Icon aria-hidden="true" /><span>{route.label}</span></NavLink>;
        })}
      </nav>
      <UploadDialog
        open={uploadOpen}
        workspaceId={id}
        onOpenChange={setUploadOpen}
        onReady={() => setFileRefresh((value) => value + 1)}
      />
    </div>
  );
}

const outcomeIcons = [Image, Layers3, FileStack, Printer];

function WorkspaceHome({ context, onUpload }: { context: WorkspaceContextResponse; onUpload: () => void }) {
  const navigate = useNavigate();
  return (
    <main className="page" data-testid="workspace-home">
      <section className="page-heading home-heading">
        <div><p className="eyebrow">Good afternoon, {context.actor.display_name.split(" ")[0]}</p><h1>What will you make today?</h1></div>
        <div className="heading-actions"><button className="button" onClick={onUpload}><Upload aria-hidden="true" />Upload</button><button className="button primary" onClick={() => navigate(workspacePath(context.workspace.workspace_id, "projects"))}><Plus aria-hidden="true" />New project</button></div>
      </section>
      <section aria-labelledby="create-heading">
        <div className="section-heading"><h2 id="create-heading">Start creating</h2></div>
        <div className="outcome-grid">
          {futureOutcomes.map((outcome, index) => {
            const Icon = outcomeIcons[index];
            const isActive = productFeatureState.enabled(outcome.feature);
            return (
              <div className="outcome-tile" data-feature-state={isActive ? "active" : "inactive"} key={outcome.feature}>
                <span className={`outcome-icon outcome-${index + 1}`}><Icon aria-hidden="true" /></span>
                <div className="outcome-copy">
                  <h3>{outcome.label}</h3>
                  <p>{outcome.description}</p>
                  {!isActive && productFeatureState.showInactiveBuildIndicator && (
                    <span className="build-indicator"><CircleDashed aria-hidden="true" />Not active in this build</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className="activity-band" aria-labelledby="activity-heading">
        <div><p className="eyebrow">Workspace activity</p><h2 id="activity-heading">Your foundation is ready</h2><p>Projects and Default Files are connected to your workspace.</p></div>
        <div className="permission-fact"><span>Access</span><strong>{context.membership.role}</strong><small>{context.effective_permissions.filter((item) => item.allowed).length} effective permissions</small></div>
      </section>
    </main>
  );
}

function ProjectsPage() {
  const { workspaceId = "" } = useParams();
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const load = () => {
    setError(null);
    api.projects(workspaceId).then((result) => setProjects(result.projects), (reason: unknown) => setError(reason instanceof Error ? reason : new Error("Projects unavailable")));
  };
  useEffect(load, [workspaceId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const created = await api.createProject(workspaceId, name.trim());
      setProjects((current) => [...(current ?? []), created]);
      setName(""); setCreating(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("Project could not be created"));
    } finally { setSaving(false); }
  }
  return (
    <main className="page" data-testid="projects-page">
      <section className="page-heading"><div><p className="eyebrow">Workspace</p><h1>Projects</h1><p>Organize files around each piece of work.</p></div><button className="button primary" onClick={() => setCreating(true)}><Plus aria-hidden="true" />New project</button></section>
      {error && <div className="inline-error" role="alert"><span>{error.message}</span><button onClick={load}>Retry</button></div>}
      {projects === null ? <div className="content-loading" aria-busy="true">Loading projects...</div> : projects.length === 0 ? (
        <section className="empty-state"><span className="state-icon"><FolderKanban aria-hidden="true" /></span><h2>No projects yet</h2><p>Your first project will appear here.</p><button className="button primary" onClick={() => setCreating(true)}><Plus aria-hidden="true" />New project</button></section>
      ) : (
        <div className="project-grid">{projects.map((project) => <article className="project-card" key={project.project_id}><span className="project-icon"><BriefcaseBusiness aria-hidden="true" /></span><div><h2>{project.name}</h2><p>{project.parent_project_id ? "Subproject" : "Project"}</p></div><span className="status-dot">Active</span></article>)}</div>
      )}
      {creating && <div className="dialog-layer" role="presentation"><button className="dialog-scrim" aria-label="Close dialog" onClick={() => setCreating(false)} /><form className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title" onSubmit={submit}><div className="dialog-heading"><h2 id="new-project-title">New project</h2><button type="button" className="icon-button" onClick={() => setCreating(false)} title="Close"><X /></button></div><label>Project name<input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label><div className="dialog-actions"><button type="button" className="button" onClick={() => setCreating(false)}>Cancel</button><button className="button primary" disabled={saving || !name.trim()}>{saving ? "Creating..." : "Create project"}</button></div></form></div>}
    </main>
  );
}

function FilesPage({ defaultFilesName, refresh, onUpload }: { defaultFilesName: string; refresh: number; onUpload: () => void }) {
  const { workspaceId = "" } = useParams();
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => { api.files(workspaceId).then((result) => setFiles(result.files), (reason: unknown) => setError(reason instanceof Error ? reason : new Error("Files unavailable"))); }, [workspaceId, refresh]);
  return (
    <main className="page" data-testid="files-page">
      <section className="page-heading"><div><p className="eyebrow">Workspace</p><h1>{defaultFilesName}</h1><p>Files without a project live here.</p></div><button className="button primary" onClick={onUpload}><Upload aria-hidden="true" />Upload</button></section>
      {error && <div className="inline-error" role="alert">{error.message}</div>}
      {files === null ? <div className="content-loading" aria-busy="true">Loading files...</div> : files.length === 0 ? (
        <section className="empty-state"><span className="state-icon"><FileStack aria-hidden="true" /></span><h2>No files yet</h2><p>Files you upload, create or save without a project will appear here.</p><button className="button primary" onClick={onUpload}><Upload aria-hidden="true" />Upload a file</button></section>
      ) : (
        <div className="file-table" role="table" aria-label="Workspace files"><div className="file-row file-header" role="row"><span>Name</span><span>Location</span><span>Source</span></div>{files.map((file) => <div className="file-row" role="row" key={file.file_id}><span className="file-name"><FileStack aria-hidden="true" />{file.display_name}</span><span>{file.canonical_location.kind === "default_files" ? defaultFilesName : "Project"}</span><span>{file.current_source_version_id}</span></div>)}</div>
      )}
    </main>
  );
}

function RoutedApp() {
  const { context, error, retry } = useWorkspace();
  const initialTheme = useMemo<Theme>(() => localStorage.getItem("ipw-theme") === "dark" ? "dark" : "light", []);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => { document.documentElement.dataset["theme"] = theme; }, [theme]);
  if (error) return <AppError error={error} retry={retry} />;
  if (!context) return <AppLoading />;
  return <WorkspaceShell context={context} theme={theme} toggleTheme={() => setTheme((current) => {
    const next = current === "light" ? "dark" : "light"; localStorage.setItem("ipw-theme", next); return next;
  })} />;
}

function GuestUploadPage() {
  const navigate = useNavigate();
  const [guest, setGuest] = useState<StoredGuestSession | null>(() => loadGuestSession());
  const [error, setError] = useState<Error | null>(null);
  const [savedWorkspace, setSavedWorkspace] = useState<string | null>(null);
  useEffect(() => {
    if (guest) return;
    let active = true;
    api.createGuestSession().then((created) => {
      if (!active) return;
      const session = {
        token: created.token,
        guestSessionId: created.guest_session.guest_session_id,
        expiresAt: created.guest_session.expires_at,
      };
      storeGuestSession(session);
      setGuest(session);
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason : new Error("Guest upload is unavailable"));
    });
    return () => { active = false; };
  }, [guest]);

  if (error) return <AppError error={error} retry={() => { setError(null); setGuest(null); }} />;
  if (!guest) return <AppLoading />;
  return (
    <div className="guest-shell">
      <header className="guest-header"><span className="wordmark"><span className="wordmark-symbol">V</span><span>Visual Workspace</span></span></header>
      <main className="guest-page" data-testid="guest-upload-page">
        <section className="guest-heading">
          <p className="eyebrow">Private upload</p>
          <h1>Check files before you sign in</h1>
          <p>Upload images and PDFs now, then sign in only when you are ready to save accepted files.</p>
        </section>
        <UploadDialog
          open
          embedded
          guestSession={guest}
          onOpenChange={() => undefined}
          onReady={() => undefined}
          onGuestSaved={setSavedWorkspace}
        />
        {savedWorkspace && (
          <div className="guest-saved" role="status">
            <CheckCircle2 aria-hidden="true" />
            <span>Your original source was saved without changing its identity.</span>
            <button className="button primary" onClick={() => navigate(workspacePath(savedWorkspace, "files"))}>Open Default Files</button>
          </div>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/guest/upload" element={<GuestUploadPage />} />
        <Route path="*" element={<RoutedApp />} />
      </Routes>
    </BrowserRouter>
  );
}
