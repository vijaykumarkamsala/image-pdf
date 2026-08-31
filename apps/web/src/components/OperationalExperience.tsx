import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Bell,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  FileStack,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Upload,
  XCircle,
} from "lucide-react";
import type {
  FeatureStateRecord,
  JobEventRecord,
  NotificationRecord,
  ProcessingJobRecord,
  WorkspaceHome,
  WorkspaceSearchResult,
} from "ipw-contracts-ts/product";

import { api, createTraceId } from "../boundaries/apiClient.ts";
import {
  Badge,
  Button,
  Dialog,
  IconButton,
  InlineNotice,
  Popover,
  StatePanel,
  Tabs,
  TextInput,
} from "../design-system";
import { workspacePath } from "../routes.ts";
import { OutcomeGrid } from "./OutcomeGrid.tsx";

function stateLabel(state: ProcessingJobRecord["state"]): string {
  return state.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function stateTone(state: ProcessingJobRecord["state"]): "neutral" | "success" | "warning" | "error" | "info" {
  if (state === "succeeded") return "success";
  if (state === "failed") return "error";
  if (state === "cancelled" || state === "cancel_requested") return "warning";
  if (state === "running" || state === "leased") return "info";
  return "neutral";
}

function SearchCommand({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      setCursor(null);
      setError(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      api.search(workspaceId, query.trim()).then(
        (response) => {
          if (!active) return;
          setResults(response.results);
          setCursor(response.next_cursor ?? null);
          setLoading(false);
        },
        () => {
          if (!active) return;
          setError("Search is unavailable. Try again.");
          setLoading(false);
        },
      );
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, query, workspaceId]);

  async function more() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const response = await api.search(workspaceId, query.trim(), cursor);
      setResults((current) => [...current, ...response.results]);
      setCursor(response.next_cursor ?? null);
    } catch {
      setError("More results could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  function openResult(result: WorkspaceSearchResult) {
    setOpen(false);
    navigate(result.path);
  }

  return <>
    <IconButton label="Search workspace" onClick={() => setOpen(true)}><Search aria-hidden="true" /></IconButton>
    <Dialog open={open} title="Search workspace" onClose={() => setOpen(false)}>
      <div className="search-dialog">
        <TextInput autoFocus label="Search projects, files and jobs" value={query} onChange={(event) => setQuery(event.target.value)} />
        {error && <InlineNotice tone="error" title="Search unavailable">{error}</InlineNotice>}
        {query.trim().length < 2 ? <StatePanel kind="empty" title="Find current work" message="Enter at least two characters." />
          : loading && results.length === 0 ? <StatePanel kind="loading" title="Searching" message="Checking work you can access." />
            : results.length === 0 ? <StatePanel kind="empty" title="No matching work" message="Try a project name, filename or job reference." />
              : <div className="search-results" role="list" aria-label="Search results">{results.map((result) => <div role="listitem" key={`${result.kind}-${result.resource_id}`}><button type="button" onClick={() => openResult(result)}><span className="search-result-icon">{result.kind === "project" ? <BriefcaseBusiness aria-hidden="true" /> : result.kind === "file" ? <FileStack aria-hidden="true" /> : <History aria-hidden="true" />}</span><span><strong>{result.title}</strong><small>{result.description}</small></span><Badge>{result.kind}</Badge></button></div>)}</div>}
        {cursor && <Button disabled={loading} onClick={() => void more()}>{loading ? "Loading" : "Load more"}</Button>}
      </div>
    </Dialog>
  </>;
}

function NotificationCenter({ workspaceId, refresh }: { workspaceId: string; refresh: number }) {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    api.notifications(workspaceId, undefined, 12).then((response) => {
      setNotifications(response.notifications);
      setUnread(response.unread_count);
      setError(false);
    }, () => setError(true));
  }, [workspaceId]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load, refresh]);

  async function markRead(item: NotificationRecord) {
    try {
      if (!item.read_at) {
        await api.markNotificationRead(workspaceId, item.notification_id);
        setNotifications((current) => current.map((candidate) => candidate.notification_id === item.notification_id ? { ...candidate, read_at: new Date().toISOString() } : candidate));
        setUnread((current) => Math.max(0, current - 1));
      }
      navigate(item.resource_kind === "processing_job" ? `${workspacePath(workspaceId, "jobs")}?job=${item.resource_id}` : workspacePath(workspaceId, "files"));
    } catch {
      setError(true);
    }
  }

  async function markAll() {
    try {
      await api.markAllNotificationsRead(workspaceId);
      const readAt = new Date().toISOString();
      setNotifications((current) => current.map((item) => ({ ...item, read_at: item.read_at ?? readAt })));
      setUnread(0);
    } catch {
      setError(true);
    }
  }

  return <div className="notification-center"><Popover label={unread ? `${unread} unread notifications` : "Notifications"} trigger={<span className="notification-trigger"><Bell aria-hidden="true" />{unread > 0 && <span>{unread > 99 ? "99+" : unread}</span>}</span>}>
    <div className="notification-popover"><header><div><strong>Notifications</strong><span>{unread ? `${unread} unread` : "You're up to date"}</span></div>{unread > 0 && <Button tone="quiet" onClick={() => void markAll()}>Mark all read</Button>}</header>
      {error ? <InlineNotice tone="error" title="Notifications unavailable">Refresh and try again.</InlineNotice>
        : notifications.length === 0 ? <StatePanel kind="empty" title="No notifications" message="File and job updates will appear here." />
          : <div className="notification-list">{notifications.map((item) => <button type="button" className={item.read_at ? "is-read" : "is-unread"} key={item.notification_id} onClick={() => void markRead(item)}><span className="notification-dot" /><span><strong>{item.title}</strong><small>{item.message}</small></span></button>)}</div>}
    </div>
  </Popover></div>;
}

export function HeaderOperations({ workspaceId, refresh }: { workspaceId: string; refresh: number }) {
  return <><SearchCommand workspaceId={workspaceId} /><NotificationCenter workspaceId={workspaceId} refresh={refresh} /></>;
}

export function SignedWorkspaceHome({ workspaceId, actorName, onUpload, refresh }: {
  workspaceId: string;
  actorName: string;
  onUpload: () => void;
  refresh: number;
}) {
  const navigate = useNavigate();
  const [home, setHome] = useState<WorkspaceHome | null>(null);
  const [features, setFeatures] = useState<FeatureStateRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.home(workspaceId), api.features(workspaceId)]).then(([homeResponse, featureResponse]) => {
      setHome(homeResponse.home);
      setFeatures(featureResponse.features);
    }, () => setError("Your current work could not be loaded."));
  }, [workspaceId]);
  useEffect(load, [load, refresh]);

  if (error) return <main className="page"><StatePanel kind="error" title="Home unavailable" message={error} action={{ label: "Try again", onClick: load }} /></main>;
  if (!home) return <main className="page"><StatePanel kind="loading" title="Loading Home" message="Retrieving recent work and current jobs." /></main>;

  const visibleJobs = [...home.active_jobs, ...home.recent_jobs].slice(0, 4);
  return <main className="page home-page" data-testid="workspace-home">
    <section className="page-heading home-heading"><div><p className="eyebrow">Good to see you, {actorName.split(" ")[0]}</p><h1>Continue your work</h1><p>Open something recent or begin with a file.</p></div><div className="heading-actions"><Button onClick={onUpload}><Upload aria-hidden="true" />Upload</Button><Button tone="primary" onClick={() => navigate(workspacePath(workspaceId, "projects"))}><Plus aria-hidden="true" />New project</Button></div></section>

    <section className="home-section" aria-labelledby="recent-heading"><div className="section-heading"><div><h2 id="recent-heading">Recent work</h2><p>Projects and accepted files from this workspace.</p></div></div>
      {home.recent_work.length === 0 ? <div className="compact-empty"><FileStack aria-hidden="true" /><div><strong>Start with your first file</strong><span>Your accepted source will stay connected to its history.</span></div><Button tone="primary" onClick={onUpload}><Upload aria-hidden="true" />Upload</Button></div> : <div className="recent-grid">{home.recent_work.slice(0, 4).map((item) => <button className="recent-card" key={item.resource_id} onClick={() => navigate(item.path)}><span className="recent-icon">{item.kind === "file" ? <FileStack aria-hidden="true" /> : <BriefcaseBusiness aria-hidden="true" />}</span><span><strong>{item.title}</strong><small>{item.description}</small></span></button>)}</div>}
    </section>

    <section className="home-section" aria-labelledby="outcomes-heading"><div className="section-heading"><div><h2 id="outcomes-heading">Choose an outcome</h2><p>Every path starts by protecting and understanding the source.</p></div></div><OutcomeGrid features={features} /></section>

    <section className="home-section operational-section" aria-labelledby="attention-heading"><div className="section-heading"><div><h2 id="attention-heading">Needs attention</h2><p>Only work with a current recovery action appears here.</p></div></div>{home.attention.length === 0 ? <div className="quiet-state"><CheckCircle2 aria-hidden="true" /><span>Nothing needs your attention.</span></div> : <div className="attention-list">{home.attention.map((item) => <button type="button" key={`${item.kind}-${item.resource_id}`} onClick={() => navigate(item.path)}><AlertTriangle aria-hidden="true" /><span><strong>{item.title}</strong><small>{item.message}</small></span></button>)}</div>}</section>

    <section className="home-section operational-section" aria-labelledby="jobs-heading"><div className="section-heading"><div><h2 id="jobs-heading">Jobs</h2><p>Current and recently finished file checks.</p></div><Button tone="quiet" onClick={() => navigate(workspacePath(workspaceId, "jobs"))}>View Jobs</Button></div>{visibleJobs.length === 0 ? <div className="quiet-state"><Clock3 aria-hidden="true" /><span>No jobs yet.</span></div> : <div className="home-job-list">{visibleJobs.map((item) => <button type="button" key={item.job_id} onClick={() => navigate(`${workspacePath(workspaceId, "jobs")}?job=${item.job_id}`)}><History aria-hidden="true" /><span><strong>File intake check</strong><small>{stateLabel(item.state)}</small></span><Badge tone={stateTone(item.state)}>{stateLabel(item.state)}</Badge></button>)}</div>}</section>

    {home.notifications.length > 0 && <section className="home-section operational-section" aria-labelledby="updates-heading"><div className="section-heading"><div><h2 id="updates-heading">Recent updates</h2><p>Durable file and job events from this workspace.</p></div></div><div className="home-update-list">{home.notifications.slice(0, 4).map((item) => <article key={item.notification_id}><span className={item.read_at ? "notification-dot is-read" : "notification-dot"} /><div><strong>{item.title}</strong><p>{item.message}</p></div></article>)}</div></section>}
  </main>;
}

const JOB_TABS = [
  ["active", "Active"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
  ["retryable", "Retryable"],
] as const;

export function JobsPage() {
  const [params, setParams] = useSearchParams();
  const { workspaceId = "" } = useParams();
  const requestedView = params.get("view");
  const initialView = JOB_TABS.some(([id]) => id === requestedView) ? requestedView as (typeof JOB_TABS)[number][0] : "active";
  const [view, setView] = useState<(typeof JOB_TABS)[number][0]>(initialView);
  const [jobs, setJobs] = useState<ProcessingJobRecord[] | null>(null);
  const [directJob, setDirectJob] = useState<ProcessingJobRecord | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, JobEventRecord[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [deepLinkLoading, setDeepLinkLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  const selectedJob = params.get("job");

  useEffect(() => {
    const next = JOB_TABS.some(([id]) => id === requestedView) ? requestedView as typeof view : "active";
    if (next !== view) {
      setView(next);
      setJobs(null);
    }
  }, [requestedView, view]);

  const load = useCallback(() => {
    setError(null);
    api.jobs(workspaceId, view).then((response) => {
      setJobs(response.jobs);
      setCursor(response.next_cursor ?? null);
    }, () => setError("Jobs could not be loaded."));
  }, [view, workspaceId]);

  useEffect(load, [load, generation]);
  useEffect(() => {
    if (!selectedJob) {
      setDirectJob(null);
      setDeepLinkError(null);
      setDeepLinkLoading(false);
      return;
    }
    let active = true;
    setDeepLinkLoading(true);
    setDeepLinkError(null);
    Promise.all([
      api.jobStatus(selectedJob, createTraceId()),
      api.jobEvents(selectedJob, 0, createTraceId()),
    ]).then(([jobResponse, eventResponse]) => {
      if (!active) return;
      if (jobResponse.job.workspace_id !== workspaceId) {
        setDirectJob(null);
        setDeepLinkError("This job is not available in this workspace.");
        return;
      }
      setDirectJob(jobResponse.job);
      setEvents((current) => ({ ...current, [selectedJob]: eventResponse.events }));
    }, () => {
      if (active) {
        setDirectJob(null);
        setDeepLinkError("This job is missing or you no longer have access to it.");
      }
    }).finally(() => { if (active) setDeepLinkLoading(false); });
    return () => { active = false; };
  }, [selectedJob, workspaceId]);
  useEffect(() => {
    if (!jobs?.some((item) => ["queued", "leased", "running", "retry_wait", "cancel_requested"].includes(item.state))) return;
    const timer = window.setInterval(() => setGeneration((current) => current + 1), 3000);
    return () => window.clearInterval(timer);
  }, [jobs]);

  async function timeline(jobId: string) {
    try {
      const response = await api.jobEvents(jobId, 0, createTraceId());
      setEvents((current) => ({ ...current, [jobId]: response.events }));
      const next = new URLSearchParams(params);
      next.set("view", view);
      next.set("job", jobId);
      setParams(next);
    } catch {
      setError("The job timeline could not be loaded.");
    }
  }

  async function cancel(item: ProcessingJobRecord) {
    try {
      await api.cancelJob(item.job_id, createTraceId());
      setGeneration((current) => current + 1);
    } catch {
      setError("The job could not be cancelled.");
    }
  }

  async function retry(item: ProcessingJobRecord) {
    try {
      await api.retryJob(item.job_id, createTraceId());
      setView("active");
      setGeneration((current) => current + 1);
    } catch {
      setError("This job can no longer be retried. Refresh to see its current state.");
    }
  }

  async function more() {
    if (!cursor) return;
    const response = await api.jobs(workspaceId, view, cursor);
    setJobs((current) => [...(current ?? []), ...response.jobs]);
    setCursor(response.next_cursor ?? null);
  }

  const panel = (() => {
    if (error) return <InlineNotice tone="error" title="Jobs unavailable">{error}</InlineNotice>;
    if (jobs === null) return <StatePanel kind="loading" title="Loading Jobs" message="Reconnecting to durable job state." />;
    const visibleJobs = directJob && !jobs.some((item) => item.job_id === directJob.job_id) ? [directJob, ...jobs] : jobs;
    if (visibleJobs.length === 0 && !deepLinkLoading && !deepLinkError) return <StatePanel kind="empty" title={`No ${view} jobs`} message="File checks will appear here when they enter this state." />;
    return <div className="job-list">{deepLinkLoading && <StatePanel kind="loading" title="Opening job timeline" message="Retrieving the permitted job and its ordered events." />}{deepLinkError && <InlineNotice tone="error" title="Job unavailable">{deepLinkError}</InlineNotice>}{visibleJobs.map((item) => {
      const itemEvents = events[item.job_id];
      const active = ["queued", "leased", "running", "retry_wait", "cancel_requested"].includes(item.state);
      return <article className="job-card" key={item.job_id} data-job-id={item.job_id}><header><span className={`job-state-icon state-${item.state}`}>{active ? <LoaderCircle aria-hidden="true" /> : item.state === "succeeded" ? <CheckCircle2 aria-hidden="true" /> : item.state === "cancelled" ? <XCircle aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}</span><div><h2>File intake check</h2><p>1 file, {item.progress_percent}% complete</p></div><Badge tone={stateTone(item.state)}>{stateLabel(item.state)}</Badge></header>{item.failure && <InlineNotice tone={item.failure.retryable ? "warning" : "error"} title={item.failure.retryable ? "Recovery available" : "Job did not finish"}>{item.failure.message}</InlineNotice>}<div className="job-actions"><Button tone="quiet" onClick={() => void timeline(item.job_id)}><History aria-hidden="true" />Timeline</Button>{active && item.state !== "cancel_requested" && <Button tone="danger" onClick={() => void cancel(item)}>Cancel</Button>}{item.state === "failed" && item.failure?.retryable && <Button onClick={() => void retry(item)}><RotateCcw aria-hidden="true" />Retry</Button>}</div>{selectedJob === item.job_id && <section className="job-timeline" aria-label="Ordered job timeline">{itemEvents ? itemEvents.map((event) => <div key={event.job_event_id}><span /><div><strong>{event.event_kind.replaceAll(".", " ")}</strong><small>{stateLabel(event.state)}, {event.progress_percent}%</small></div></div>) : <StatePanel kind="loading" title="Loading timeline" message="Retrieving ordered job events." />}<details><summary>Advanced reference details</summary><dl><div><dt>Job</dt><dd>{item.job_id}</dd></div><div><dt>Upload</dt><dd>{item.upload_session_id}</dd></div>{itemEvents?.at(-1) && <div><dt>Trace</dt><dd>{itemEvents.at(-1)!.trace_id}</dd></div>}</dl></details></section>}</article>;
    })}{cursor && <Button onClick={() => void more()}>Load more</Button>}</div>;
  })();

  return <main className="page jobs-page" data-testid="jobs-page"><section className="page-heading"><div><p className="eyebrow">Workspace</p><h1>Jobs</h1><p>Follow file checks, recovery and completion without keeping this page open.</p></div><IconButton label="Refresh Jobs" onClick={() => setGeneration((current) => current + 1)}><RefreshCw aria-hidden="true" /></IconButton></section><Tabs label="Job views" selected={view} onSelect={(id) => {
    const nextView = id as typeof view;
    setView(nextView);
    setJobs(null);
    setDirectJob(null);
    setParams({ view: nextView });
  }} items={JOB_TABS.map(([id, label]) => ({ id, label, panel }))} /></main>;
}
