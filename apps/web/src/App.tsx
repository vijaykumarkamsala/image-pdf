import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  FileStack,
  FolderKanban,
  History,
  Home,
  LogOut,
  Menu as MenuIcon,
  Plus,
  ShieldCheck,
  Upload,
} from "lucide-react";
import type { ProjectRecord, WorkspaceFile } from "ipw-contracts-ts/product";

import { ApiError, api, createTraceId, type WorkspaceContextResponse } from "./boundaries/apiClient";
import { browserCoordinator } from "./boundaries/crossTab";
import { clearGuestBrowserState, clearPrivateBrowserState, storeGuestSession, type StoredGuestSession } from "./boundaries/session";
import { type ThemePreference, useThemePreference } from "./boundaries/theme";
import { Brand } from "./components/Brand";
import { HeaderOperations, JobsPage, SignedWorkspaceHome } from "./components/OperationalExperience";
import { OutcomeGrid } from "./components/OutcomeGrid";
import { UploadDialog } from "./components/UploadDialog";
import { Button, Dialog, IconButton, Menu, Popover, StatePanel, TextInput } from "./design-system";
import { InternalPanelHarness } from "./panels/PanelFramework";
import { OfflineStatus } from "./pwa/OfflineStatus";
import { clearPrivateCachesOnLogout } from "./pwa/serviceWorker";
import { workspacePath, workspaceRoutes } from "./routes";

const developmentBuild = (import.meta as ImportMeta & { readonly env?: { readonly DEV?: boolean } }).env?.DEV ?? false;

function AppLoading() {
  return <main className="app-center"><StatePanel kind="loading" title="Opening your workspace" message="Resolving your membership and recent work." /></main>;
}

function AppError({ error, retry }: { error: Error; retry: () => void }) {
  const denied = error instanceof ApiError && error.status === 403;
  return <main className="app-center"><StatePanel kind="error" title={denied ? "Workspace access denied" : "Workspace unavailable"} message={error.message} action={{ label: "Try again", onClick: retry }} /></main>;
}

function useWorkspace(canonicalWorkspaceId: string | null) {
  const [context, setContext] = useState<WorkspaceContextResponse | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceContextResponse["workspace"][]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    setContext(null);
    const contextRequest = canonicalWorkspaceId ? api.context(canonicalWorkspaceId) : api.bootstrap();
    Promise.all([contextRequest, api.workspaces()]).then(
      ([value, listing]) => {
        if (!active) return;
        setContext(value);
        setWorkspaces(listing.workspaces);
      },
      (reason: unknown) => active && setError(reason instanceof Error ? reason : new Error("Workspace unavailable")),
    );
    return () => { active = false; };
  }, [attempt, canonicalWorkspaceId]);
  return { context, workspaces, error, retry: () => setAttempt((value) => value + 1) };
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

function WorkspaceSwitcher({ current, workspaces }: {
  current: WorkspaceContextResponse["workspace"];
  workspaces: WorkspaceContextResponse["workspace"][];
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const identity = <span className="workspace-switcher-content"><span className="workspace-avatar">{current.name.slice(0, 1).toUpperCase()}</span><span><strong>{current.name}</strong><small>Workspace</small></span>{workspaces.length > 1 && <ChevronDown aria-hidden="true" />}</span>;
  if (workspaces.length <= 1) return <div className="workspace-switcher-static">{identity}</div>;
  const suffix = location.pathname.replace(/^\/w\/[^/]+/, "") || "";
  return <Popover label="Choose workspace" align="start" trigger={identity}>
    <div className="workspace-popover" role="group" aria-label="Available workspaces">{workspaces.map((workspace) => <Button
      key={workspace.workspace_id}
      tone={workspace.workspace_id === current.workspace_id ? "quiet" : "secondary"}
      onClick={() => navigate(`/w/${encodeURIComponent(workspace.workspace_id)}${suffix}${location.search}`)}
    ><span className="workspace-avatar">{workspace.name.slice(0, 1).toUpperCase()}</span><span>{workspace.name}</span></Button>)}</div>
  </Popover>;
}

function WorkspaceShell({ context, workspaces, preference, setPreference }: {
  context: WorkspaceContextResponse;
  workspaces: WorkspaceContextResponse["workspace"][];
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [fileRefresh, setFileRefresh] = useState(0);
  const [fileCount, setFileCount] = useState(0);
  const [jobCount, setJobCount] = useState(0);
  const [sessionState, setSessionState] = useState<"checking" | "active" | "unavailable">("checking");
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
  useEffect(() => {
    let active = true;
    api.authSession().then(
      (session) => { if (active) setSessionState(session.authenticated ? "active" : "unavailable"); },
      () => { if (active) setSessionState("unavailable"); },
    );
    return () => { active = false; };
  }, [id]);
  async function logout() {
    await api.logout();
    clearPrivateBrowserState();
    await clearPrivateCachesOnLogout();
    browserCoordinator?.publish({ type: "session.logout" });
    window.location.replace("/");
  }
  return <div className="app-shell">
    <aside className="desktop-sidebar">
      <Brand />
      <WorkspaceSwitcher current={context.workspace} workspaces={workspaces} />
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
          <Popover label={`Account for ${context.actor.display_name}`} trigger={<span className="account-button"><span>{context.actor.display_name.slice(0, 1).toUpperCase()}</span><span className="account-copy"><strong>{context.actor.display_name}</strong><small>{context.membership.role}</small></span></span>}>
            <div className="account-popover"><div><strong>{context.actor.display_name}</strong><span>{context.membership.role} in {context.workspace.name}</span><small>{sessionState === "checking" ? "Checking session" : sessionState === "active" ? "Session active" : "Session unavailable"}</small></div><Button tone="quiet" onClick={() => void logout()}><LogOut aria-hidden="true" />Sign out</Button></div>
          </Popover>
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
  const location = useLocation();
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(location.pathname);
  let canonicalWorkspaceId: string | null = null;
  try { canonicalWorkspaceId = match ? decodeURIComponent(match[1]) : null; } catch { canonicalWorkspaceId = null; }
  const { context, workspaces, error, retry } = useWorkspace(canonicalWorkspaceId);
  const { preference, setPreference } = useThemePreference();
  if (error) return <AppError error={error} retry={retry} />;
  if (!context) return <AppLoading />;
  if (location.pathname.startsWith("/app")) return <Navigate replace to={workspacePath(context.workspace.workspace_id)} />;
  if (!canonicalWorkspaceId) return <Navigate replace to="/app" />;
  return <WorkspaceShell context={context} workspaces={workspaces} preference={preference} setPreference={setPreference} />;
}

function GuestHome() {
  const { preference, setPreference } = useThemePreference();
  const [guest, setGuest] = useState<StoredGuestSession | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const preparation = useRef<ReturnType<typeof api.createGuestSession> | null>(null);
  useEffect(() => {
    let active = true;
    preparation.current ??= api.createGuestSession();
    void preparation.current.then((created) => {
      if (!active) return;
      const session = { guestSessionId: created.guest_session.guest_session_id, expiresAt: created.guest_session.expires_at };
      storeGuestSession(session);
      setGuest(session);
    }, (reason: unknown) => { if (active) setError(reason instanceof Error ? reason : new Error("Guest intake is unavailable")); });
    return () => { active = false; };
  }, []);
  if (error) return <AppError error={error} retry={() => window.location.reload()} />;
  return <div className="public-shell">
    <header className="public-header"><Brand /><div className="public-header-actions"><span className="free-testing"><CheckCircle2 aria-hidden="true" />Free during testing</span><ThemeMenu preference={preference} setPreference={setPreference} /></div></header>
    <main className="public-main" data-testid="guest-home">
      <section className="guest-intro"><p className="eyebrow">Images and PDFs, understood first</p><h1>Bring a source. See what is trustworthy.</h1><p>Upload an image or PDF for private safety checks and verified facts. Your original stays untouched.</p></section>
      <section className="guest-intake" aria-labelledby="guest-intake-heading"><div className="guest-intake-heading"><div><h2 id="guest-intake-heading">Start with a file</h2><p>Choose one or several supported images or PDFs.</p></div><ShieldCheck aria-hidden="true" /></div>{guest ? <UploadDialog open embedded guestSession={guest} onOpenChange={() => undefined} onReady={() => undefined} /> : <StatePanel kind="loading" title="Preparing private intake" message="Creating a temporary session for your files." />}</section>
      <section className="public-outcomes" aria-labelledby="public-outcomes-heading"><div className="section-heading"><div><h2 id="public-outcomes-heading">Four ways forward</h2><p>Upload first and the workspace will recommend only what the verified source supports.</p></div></div><OutcomeGrid publicView /></section>
      <section className="trust-row" aria-label="Source safeguards"><span><ShieldCheck aria-hidden="true" />Original preserved</span><span><FileStack aria-hidden="true" />Verified facts before recommendations</span><span><CheckCircle2 aria-hidden="true" />No silent changes or AI</span></section>
    </main>
  </div>;
}

function AuthComplete() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const completion = useRef<Promise<string> | null>(null);
  useEffect(() => {
    let active = true;
    const uploadSessionId = params.get("handoff");
    if (!uploadSessionId) {
      navigate("/app", { replace: true });
      return;
    }
    const keyName = `ipw-handoff-key-${uploadSessionId}`;
    const idempotencyKey = sessionStorage.getItem(keyName) ?? `guest-handoff-${crypto.randomUUID()}`;
    sessionStorage.setItem(keyName, idempotencyKey);
    completion.current ??= (async () => {
      const authenticated = await api.authSession();
      if (!authenticated.authenticated) throw new Error("Your sign-in session was not established.");
      const context = await api.bootstrap();
      await api.handoffGuest(uploadSessionId, context.workspace.workspace_id, createTraceId(), idempotencyKey);
      clearGuestBrowserState();
      browserCoordinator?.publish({ type: "guest.handoff", workspaceId: context.workspace.workspace_id, uploadSessionId });
      return workspacePath(context.workspace.workspace_id, "files");
    })();
    void completion.current.then(
      (path) => { if (active) navigate(path, { replace: true }); },
      (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Temporary work could not be saved.");
      },
    );
    return () => { active = false; };
  }, [navigate, params]);
  if (error) return <main className="app-center"><StatePanel kind="error" title="Your file was not saved yet" message={error} action={{ label: "Return to temporary work", onClick: () => navigate("/guest/upload", { replace: true }) }} /></main>;
  return <main className="app-center"><StatePanel kind="loading" title="Saving your original source" message="Verifying your session and preserving the accepted source." /></main>;
}

function CrossTabSessionBoundary() {
  useEffect(() => browserCoordinator?.subscribe((event) => {
    if (event.type === "session.logout") {
      clearPrivateBrowserState();
      void clearPrivateCachesOnLogout().finally(() => window.location.replace("/"));
    }
    if (event.type === "guest.handoff" && event.workspaceId) {
      clearGuestBrowserState();
      window.location.replace(workspacePath(event.workspaceId, "files"));
    }
  }), []);
  return null;
}

export default function App() {
  return <><OfflineStatus /><CrossTabSessionBoundary /><BrowserRouter><Routes>
    <Route path="/" element={<GuestHome />} />
    <Route path="/guest/upload" element={<GuestHome />} />
    <Route path="/auth/complete" element={<AuthComplete />} />
    <Route path="/app/*" element={<SignedInApplication />} />
    <Route path="/w/*" element={<SignedInApplication />} />
    <Route path="/internal/panels" element={developmentBuild ? <InternalPanelHarness /> : <Navigate replace to="/" />} />
    <Route path="*" element={<Navigate replace to="/" />} />
  </Routes></BrowserRouter></>;
}
