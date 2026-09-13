import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  FileCheck2,
  FileStack,
  LockKeyhole,
  ShieldAlert,
} from "lucide-react";
import type {
  PdfCapabilityReport,
  PdfFeature,
  PdfOperation,
  WorkspaceFile,
} from "ipw-contracts-ts/product";
import { useNavigate, useParams } from "react-router-dom";

import { api } from "../boundaries/apiClient";
import { Button, InlineNotice, StatePanel } from "../design-system";
import { workspacePath } from "../routes";

const classificationLabels = {
  fully_editable: "Fully editable",
  limited: "Limited editing",
  page_management_only: "Page management only",
  reconstructable_copy: "Reconstructable copy",
  view_only: "View only",
} as const;

const featureLabels: Record<PdfFeature, string> = {
  encryption: "Encryption",
  document_permissions: "Permissions",
  digital_signatures: "Digital signatures",
  fonts: "Fonts",
  text: "Text",
  images: "Images",
  vector_content: "Vector content",
  forms: "Forms",
  annotations: "Annotations",
  optional_content_layers: "Optional-content layers",
  tags: "Accessibility tags",
  attachments: "Attachments",
  active_content: "Active content",
  mixed_page_sizes: "Mixed page sizes",
};

const operationLabels: Record<PdfOperation, string> = {
  view_capability_report: "View capability report",
  download_original: "Download original",
  manage_pages: "Manage pages",
  edit_content: "Edit page content",
  unlock_with_password: "Unlock with password",
  sanitize_copy: "Create sanitized copy",
  reconstruct_copy: "Create reconstructed copy",
};

function modeNotice(report: PdfCapabilityReport) {
  if (report.analysis.opening_mode === "credential_required") {
    return {
      tone: "warning" as const,
      title: "Password required",
      message: "The encrypted original is preserved. No password was requested or tested during intake.",
      Icon: LockKeyhole,
    };
  }
  if (report.analysis.opening_mode === "restricted_safe_view") {
    return {
      tone: "warning" as const,
      title: "Restricted safe view",
      message: "Active, embedded, signed or unsupported structures remain disabled. Nothing from this PDF is executed.",
      Icon: ShieldAlert,
    };
  }
  return {
    tone: "info" as const,
    title: "Safe view",
    message: "The strict structural inspection found no active-content reason to restrict this document further.",
    Icon: FileCheck2,
  };
}

export function ImportedPdfStartPage() {
  const { workspaceId = "" } = useParams();
  const navigate = useNavigate();
  const [reports, setReports] = useState<PdfCapabilityReport[] | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.pdfCapabilityReports(workspaceId), api.files(workspaceId)]).then(
      ([reportResult, fileResult]) => {
        if (!active) return;
        setReports(reportResult.capability_reports);
        setFiles(fileResult.files);
      },
      (reason: unknown) => active && setError(reason instanceof Error ? reason.message : "PDF files could not be loaded"),
    );
    return () => { active = false; };
  }, [workspaceId]);

  const names = useMemo(() => new Map(files.map((file) => [file.file_id, file.display_name])), [files]);
  return <main className="page imported-pdf-start" data-testid="pdf-management-start">
    <section className="page-heading"><div><p className="eyebrow">Edit &amp; Manage PDF</p><h1>Open an imported PDF safely</h1><p>Review verified structure and restrictions before any page or content operation.</p></div></section>
    {error && <InlineNotice tone="error" title="PDF workspace unavailable">{error}</InlineNotice>}
    {reports === null && !error
      ? <StatePanel kind="loading" title="Loading imported PDFs" message="Retrieving immutable-source capability reports." />
      : reports?.length === 0
        ? <StatePanel kind="empty" title="No inspected PDFs yet" message="Upload a PDF first. It will stay private while its structure and restrictions are checked." action={{ label: "Go to Files", onClick: () => navigate(workspacePath(workspaceId, "files")) }} />
        : <div className="imported-pdf-list" role="list" aria-label="Inspected PDF files">{reports?.map((report) => <article key={report.file_id} role="listitem" className="imported-pdf-card"><FileStack aria-hidden="true" /><div><h2>{names.get(report.file_id) ?? "Imported PDF"}</h2><p>{report.analysis.page_count ? `${report.analysis.page_count} ${report.analysis.page_count === 1 ? "page" : "pages"}` : "Page count restricted"}</p><span className={`pdf-classification pdf-classification-${report.analysis.classification}`}>{classificationLabels[report.analysis.classification]}</span></div><Button size="compact" onClick={() => navigate(workspacePath(workspaceId, `pdf-files/${report.file_id}`))}>Open safely</Button></article>)}</div>}
  </main>;
}

export function ImportedPdfWorkspace() {
  const { workspaceId = "", fileId = "" } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState<PdfCapabilityReport | null>(null);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.pdfCapabilityReport(workspaceId, fileId), api.files(workspaceId)]).then(
      ([reportResult, fileResult]) => {
        if (!active) return;
        setReport(reportResult.capability_report);
        setFile(fileResult.files.find((candidate) => candidate.file_id === fileId) ?? null);
      },
      (reason: unknown) => active && setError(reason instanceof Error ? reason.message : "Capability report could not be loaded"),
    );
    return () => { active = false; };
  }, [fileId, workspaceId]);

  if (error) return <main className="page"><StatePanel kind="error" title="PDF could not open safely" message={error} action={{ label: "Back to PDF files", onClick: () => navigate(workspacePath(workspaceId, "pdf/manage")) }} /></main>;
  if (!report) return <main className="page"><StatePanel kind="loading" title="Opening safe PDF evidence" message="Loading the immutable-source capability report." /></main>;
  const notice = modeNotice(report);
  const NoticeIcon = notice.Icon;
  const pages = Math.min(report.analysis.page_count ?? 0, 24);

  return <main className="page imported-pdf-workspace" data-testid="pdf-capability-workspace">
    <div className="pdf-workspace-toolbar"><Button size="compact" onClick={() => navigate(workspacePath(workspaceId, "pdf/manage"))}><ChevronLeft aria-hidden="true" />PDF files</Button><span>Original preserved</span></div>
    <section className="pdf-capability-heading"><div><p className="eyebrow">Imported PDF</p><h1>{file?.display_name ?? "Imported PDF"}</h1><p>{classificationLabels[report.analysis.classification]} &middot; {report.analysis.page_count ? `${report.analysis.page_count} ${report.analysis.page_count === 1 ? "page" : "pages"}` : "page count unavailable"} &middot; PDF {report.analysis.pdf_version ?? "version unknown"}</p></div><span className="pdf-original-badge"><FileCheck2 aria-hidden="true" />Immutable original</span></section>
    <InlineNotice tone={notice.tone} title={notice.title}><span className="pdf-notice-content"><NoticeIcon aria-hidden="true" />{notice.message}</span></InlineNotice>

    <div className="pdf-capability-layout">
      <section className="pdf-page-map" aria-labelledby="pdf-page-map-heading"><div className="section-heading"><div><h2 id="pdf-page-map-heading">Document map</h2><p>No page content is rendered in this inspection-only release.</p></div></div>{pages > 0 ? <ol>{Array.from({ length: pages }, (_, index) => <li key={index}><span>{index + 1}</span><FileStack aria-hidden="true" /></li>)}</ol> : <div className="pdf-page-map-empty"><AlertTriangle aria-hidden="true" /><span>Page structure is unavailable until the restriction is resolved through an approved workflow.</span></div>}{(report.analysis.page_count ?? 0) > pages && <p className="pdf-page-map-more">Showing the first {pages} of {report.analysis.page_count} pages.</p>}</section>

      <section className="pdf-capability-panel" aria-labelledby="pdf-capability-heading"><div className="section-heading"><div><h2 id="pdf-capability-heading">Capability report</h2><p>What the bounded inspector could establish without executing or rendering the PDF.</p></div></div><div className="pdf-finding-grid">{report.analysis.findings.map((finding) => <article key={finding.feature} className={`pdf-finding pdf-finding-${finding.state}`}><span>{finding.state === "absent" ? <CheckCircle2 aria-hidden="true" /> : finding.state === "present" ? <FileCheck2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}{featureLabels[finding.feature]}</span><strong>{finding.state}</strong><p>{finding.summary}</p></article>)}</div></section>
    </div>

    <section className="pdf-operation-boundary" aria-labelledby="pdf-operation-heading"><div className="section-heading"><div><h2 id="pdf-operation-heading">Operation boundary</h2><p>Only actions backed by released production behavior are marked available.</p></div></div><div className="pdf-operation-list">{report.analysis.operations.map((operation) => <article key={operation.operation} className={`pdf-operation-${operation.state}`}><span>{operation.state === "available" ? <CheckCircle2 aria-hidden="true" /> : operation.state === "blocked" ? <LockKeyhole aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}</span><div><strong>{operationLabels[operation.operation]}</strong><p>{operation.reason}</p></div><small>{operation.state.replace("_", " ")}</small></article>)}</div></section>

    <section className="pdf-compatibility-notes" aria-labelledby="pdf-notes-heading"><h2 id="pdf-notes-heading">Compatibility notes</h2><ul>{report.analysis.compatibility_notes.map((note) => <li key={note}>{note}</li>)}</ul><details><summary>Advanced evidence</summary><dl><div><dt>Source version</dt><dd>{report.source_version_id}</dd></div><div><dt>Source SHA-256</dt><dd>{report.analysis.source_sha256}</dd></div><div><dt>Storage generation</dt><dd>{report.storage_generation}</dd></div><div><dt>Inspector</dt><dd>{report.analysis.inspector.name} {report.analysis.inspector.version} &middot; {report.analysis.inspector.library_name} {report.analysis.inspector.library_version}</dd></div></dl></details></section>
  </main>;
}
