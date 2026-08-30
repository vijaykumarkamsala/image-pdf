import { type FormEvent, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  FileStack,
  FolderKanban,
  History,
  Home,
  Menu as MenuIcon,
  Plus,
  ShieldCheck,
  Upload,
} from "lucide-react";
import type { ProjectRecord, WorkspaceFile } from "ipw-contracts-ts/product";

import { ApiError, api, type WorkspaceContextResponse } from "./boundaries/apiClient";
import { loadGuestSession, storeGuestSession, type StoredGuestSession } from "./boundaries/session";
import { type ThemePreference, useThemePreference } from "./boundaries/theme";
import { Brand } from "./components/Brand";
import { HeaderOperations, JobsPage, SignedWorkspaceHome } from "./components/OperationalExperience";
import { OutcomeGrid } from "./components/OutcomeGrid";
import { UploadDialog } from "./components/UploadDialog";
import { Button, Dialog, IconButton, Menu, Popover, StatePanel, TextInput } from "./design-system";
import { workspacePath, workspaceRoutes } from "./routes";

function AppLoading() {
  return <main className="app-center"><StatePanel kind="loading" title="Opening your workspace" message="Resolving your membership and recent work." /></main>;
}

function AppError({ error, retry }: { error: Error; retry: () => void }) {
  const denied = error instanceof ApiError && error.status === 403;
  return <main className="app-center"><StatePanel kind="error" title={denied ? "Workspace access denied" : "Workspace unavailable"} message={error.message} action={{ label: "Try again", onClick: retry }} /></main>;
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

const navIcons = [Home, FolderKanban, FileStack, History];

function ThemeMenu({ preference, setPreference }: { preference: ThemePreference; setPreference: (value: ThemePreference) => void }) {
  return <Menu
    label="Theme"
    items={(["system", "light", "dark"] as const).map((value) => ({ id: value, label: value[0].toUpperCase() + value.slice(1), selected: value === preference }))}
    onSelect={(value) => setPreference(value as ThemePreference)}
  />;
}

function WorkspaceNavigation({ workspaceId, close }: { workspaceId: string; close?: () => void }) {
  return <nav className="primary-nav" aria-label="Workspace navigation">{workspaceRoutes.map((route, index) => {
    const Icon = navIcons[index];
    return <NavLink aria-label={route.label} key={route.segment} end={!route.segment} to={workspacePath(workspaceId, route.segment)} onClick={close}>
      <Icon aria-hidden="true" /><span>{route.label}</span>
    </NavLink>;
  })}</nav>;
}

function WorkspaceShell({ context, preference, setPreference }: {
  context: WorkspaceContextResponse;
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [fileRefresh, setFileRefresh] = useState(0);
  const [fileCount, setFileCount] = useState(0);
  const [jobCount, setJobCount] = useState(0);
  const id = context.workspace.workspace_id;
  useEffect(() => {
    let active = true;
    Promise.all([api.files(id), api.home(id)]).then(([fileResult, homeResult]) => {
      if (!active) return;
      setFileCount(fileResult.files.length);
      setJobCount(new Set([...homeResult.home.active_jobs, ...homeResult.home.recent_jobs].map((job) => job.job_id)).size);
    }, () => undefined);
    return () => { active = false; };
  }, [id, fileRefresh]);
  return <div className="app-shell">
    <aside className="desktop-sidebar">
      <Brand />
      <Popover label="Choose workspace" align="start" trigger={<span className="workspace-switcher-content"><span className="workspace-avatar">{context.workspace.name.slice(0, 1).toUpperCase()}</span><span><strong>{context.workspace.name}</strong><small>Personal workspace</small></span><ChevronDown aria-hidden="true" /></span>}>
        <div className="workspace-popover"><strong>{context.workspace.name}</strong><span>Your current workspace</span></div>
      </Popover>
      <WorkspaceNavigation workspaceId={id} />
      <div className="testing-status"><CheckCircle2 aria-hidden="true" /><div><strong>Free during testing</strong><span>{fileCount} {fileCount === 1 ? "file" : "files"} &middot; {jobCount} {jobCount === 1 ? "job" : "jobs"}</span></div></div>
    </aside>

    <div className="app-main">
      <header className="app-header">
        <IconButton className="phone-menu" label="Open navigation" onClick={() => setMobileOpen(true)}><MenuIcon aria-hidden="true" /></IconButton>
        <span className="phone-brand"><Brand compact /></span>
        <div className="header-workspace"><strong>{context.workspace.name}</strong><span>Workspace</span></div>
        <div className="header-actions">
          <HeaderOperations workspaceId={id} refresh={fileRefresh} />
          <ThemeMenu preference={preference} setPreference={setPreference} />
          <button className="account-button" aria-label={`Signed in as ${context.actor.display_name}`}><span>{context.actor.display_name.slice(0, 1).toUpperCase()}</span><span className="account-copy"><strong>{context.actor.display_name}</strong><small>{context.membership.role}</small></span></button>
        </div>
      </header>

      <Routes>
        <Route path=":workspaceId" element={<SignedWorkspaceHome workspaceId={id} actorName={context.actor.display_name} onUpload={() => setUploadOpen(true)} refresh={fileRefresh} />} />
        <Route path=":workspaceId/projects" element={<ProjectsPage />} />
        <Route path=":workspaceId/files" element={<FilesPage defaultFilesName={context.default_files.name ?? "Default Files"} refresh={fileRefresh} onUpload={() => setUploadOpen(true)} />} />
        <Route path=":workspaceId/jobs" element={<JobsPage />} />
        <Route path="*" element={<Navigate replace to={workspacePath(id)} />} />
      </Routes>
    </div>

    <div className="phone-bottom-nav"><WorkspaceNavigation workspaceId={id} /></div>
    <Dialog open={mobileOpen} title="Navigation" onClose={() => setMobileOpen(false)}>
      <div className="mobile-sheet-body"><WorkspaceNavigation workspaceId={id} close={() => setMobileOpen(false)} /><div className="testing-status mobile-testing"><CheckCircle2 aria-hidden="true" /><div><strong>Free during testing</strong><span>{fileCount} {fileCount === 1 ? "file" : "files"} &middot; {jobCount} {jobCount === 1 ? "job" : "jobs"}</span></div></div></div>
    </Dialog>
    <UploadDialog open={uploadOpen} workspaceId={id} onOpenChange={setUploadOpen} onReady={() => setFileRefresh((value) => value + 1)} />
  </div>;
}

function ProjectsPage() {
  const { workspaceId = "" } = useParams();
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    setError(null);
    api.projects(workspaceId).then((result) => setProjects(result.projects), (reason: unknown) => setError(reason instanceof Error ? reason : new Error("Projects unavailable")));
  }, [workspaceId]);
  useEffect(load, [load]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const created = await api.createProject(workspaceId, name.trim());
      setProjects((current) => [...(current ?? []), created]);
      setName("");
      setCreating(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("Project could not be created"));
    } finally { setSaving(false); }
  }
  return <main className="page" data-testid="projects-page">
    <section className="page-heading"><div><p className="eyebrow">Workspace</p><h1>Projects</h1><p>Organize files around each piece of work.</p></div><Button tone="primary" onClick={() => setCreating(true)}><Plus aria-hidden="true" />New project</Button></section>
    {error && <div className="inline-error" role="alert"><span>{error.message}</span><Button tone="quiet" onClick={load}>Retry</Button></div>}
    {projects === null ? <StatePanel kind="loading" title="Loading projects" message="Retrieving work you can access." /> : projects.length === 0 ? <StatePanel kind="empty" title="No projects yet" message="Create a project when you want files grouped around one piece of work." action={{ label: "New project", onClick: () => setCreating(true) }} /> : <div className="project-grid">{projects.map((project) => <article className="project-card" key={project.project_id}><span className="project-icon"><BriefcaseBusiness aria-hidden="true" /></span><div><h2>{project.name}</h2><p>{project.parent_project_id ? "Subproject" : "Project"}</p></div><span className="status-dot">Active</span></article>)}</div>}
    <Dialog open={creating} title="New project" onClose={() => setCreating(false)}><form className="modal-form" onSubmit={submit}><TextInput autoFocus label="Project name" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /><div className="dialog-actions"><Button type="button" onClick={() => setCreating(false)}>Cancel</Button><Button tone="primary" disabled={saving || !name.trim()}>{saving ? "Creating..." : "Create project"}</Button></div></form></Dialog>
  </main>;
}

function FilesPage({ defaultFilesName, refresh, onUpload }: { defaultFilesName: string; refresh: number; onUpload: () => void }) {
  const { workspaceId = "" } = useParams();
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    setError(null);
    api.files(workspaceId).then((result) => setFiles(result.files), (reason: unknown) => setError(reason instanceof Error ? reason : new Error("Files unavailable")));
  }, [workspaceId, refresh]);
  return <main className="page" data-testid="files-page">
    <section className="page-heading"><div><p className="eyebrow">Workspace</p><h1>{defaultFilesName}</h1><p>Files you have not placed in a project.</p></div><Button tone="primary" onClick={onUpload}><Upload aria-hidden="true" />Upload</Button></section>
    {error && <div className="inline-error" role="alert">{error.message}</div>}
    {files === null ? <StatePanel kind="loading" title="Loading files" message="Retrieving accepted workspace sources." /> : files.length === 0 ? <StatePanel kind="empty" title="No files yet" message="Files you upload, create or save without a project will appear here." action={{ label: "Upload a file", onClick: onUpload }} /> : <div className="file-list" role="list" aria-label="Workspace files">{files.map((file) => <article className="file-card" role="listitem" key={file.file_id}><span className="file-type-icon"><FileStack aria-hidden="true" /></span><div><strong>{file.display_name}</strong><span>{file.canonical_location.kind === "default_files" ? defaultFilesName : "Project"}</span></div><small title={file.current_source_version_id}>Source preserved</small></article>)}</div>}
  </main>;
}

function SignedInApplication() {
  const { context, error, retry } = useWorkspace();
  const { preference, setPreference } = useThemePreference();
  const location = useLocation();
  if (error) return <AppError error={error} retry={retry} />;
  if (!context) return <AppLoading />;
  if (location.pathname.startsWith("/app")) return <Navigate replace to={workspacePath(context.workspace.workspace_id)} />;
  return <WorkspaceShell context={context} preference={preference} setPreference={setPreference} />;
}

function GuestHome() {
  const navigate = useNavigate();
  const { preference, setPreference } = useThemePreference();
  const [guest, setGuest] = useState<StoredGuestSession | null>(() => loadGuestSession());
  const [error, setError] = useState<Error | null>(null);
  const [savedWorkspace, setSavedWorkspace] = useState<string | null>(null);
  useEffect(() => {
    if (guest) return;
    let active = true;
    api.createGuestSession().then((created) => {
      if (!active) return;
      const session = { token: created.token, guestSessionId: created.guest_session.guest_session_id, expiresAt: created.guest_session.expires_at };
      storeGuestSession(session);
      setGuest(session);
    }, (reason: unknown) => { if (active) setError(reason instanceof Error ? reason : new Error("Guest intake is unavailable")); });
    return () => { active = false; };
  }, [guest]);
  if (error) return <AppError error={error} retry={() => { setError(null); setGuest(null); }} />;
  return <div className="public-shell">
    <header className="public-header"><Brand /><div className="public-header-actions"><span className="free-testing"><CheckCircle2 aria-hidden="true" />Free during testing</span><ThemeMenu preference={preference} setPreference={setPreference} /></div></header>
    <main className="public-main" data-testid="guest-home">
      <section className="guest-intro"><p className="eyebrow">Images and PDFs, understood first</p><h1>Bring a source. See what is trustworthy.</h1><p>Upload an image or PDF for private safety checks and verified facts. Your original stays untouched.</p></section>
      <section className="guest-intake" aria-labelledby="guest-intake-heading"><div className="guest-intake-heading"><div><h2 id="guest-intake-heading">Start with a file</h2><p>Choose one or several supported images or PDFs.</p></div><ShieldCheck aria-hidden="true" /></div>{guest ? <UploadDialog open embedded guestSession={guest} onOpenChange={() => undefined} onReady={() => undefined} onGuestSaved={setSavedWorkspace} /> : <StatePanel kind="loading" title="Preparing private intake" message="Creating a temporary session for your files." />}</section>
      {savedWorkspace && <div className="guest-saved" role="status"><CheckCircle2 aria-hidden="true" /><span>Your original source was saved without changing its identity.</span><Button tone="primary" onClick={() => navigate(workspacePath(savedWorkspace, "files"))}>Open Default Files</Button></div>}
      <section className="public-outcomes" aria-labelledby="public-outcomes-heading"><div className="section-heading"><div><h2 id="public-outcomes-heading">Four ways forward</h2><p>Upload first and the workspace will recommend only what the verified source supports.</p></div></div><OutcomeGrid publicView /></section>
      <section className="trust-row" aria-label="Source safeguards"><span><ShieldCheck aria-hidden="true" />Original preserved</span><span><FileStack aria-hidden="true" />Verified facts before recommendations</span><span><CheckCircle2 aria-hidden="true" />No silent changes or AI</span></section>
    </main>
  </div>;
}

export default function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<GuestHome />} />
    <Route path="/guest/upload" element={<GuestHome />} />
    <Route path="/app/*" element={<SignedInApplication />} />
    <Route path="/w/*" element={<SignedInApplication />} />
    <Route path="*" element={<Navigate replace to="/" />} />
  </Routes></BrowserRouter>;
}
