import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileCheck2, RefreshCw, XCircle } from "lucide-react";
import type { DocumentReadModel, PdfPreflightReport } from "ipw-contracts-ts/product";

import { api, type PdfExportReadModel } from "../boundaries/apiClient";
import { Button, Dialog, InlineNotice, StatePanel } from "../design-system";

const ACTIVE_STATES = new Set(["queued", "running", "cancellation_requested"]);

export function PdfExportCenter({ open, onClose, workspaceId, editor, prepareDocument }: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  editor: DocumentReadModel;
  prepareDocument: () => Promise<DocumentReadModel>;
}) {
  const [preflight, setPreflight] = useState<PdfPreflightReport | null>(null);
  const [exports, setExports] = useState<PdfExportReadModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const documentId = editor.document.document_id;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const currentDocumentId = (await prepareDocument()).document.document_id;
      const [preflightResult, exportResult] = await Promise.all([
        api.pdfPreflight(workspaceId, currentDocumentId),
        api.pdfExports(workspaceId, currentDocumentId),
      ]);
      setPreflight(preflightResult.preflight);
      setExports(exportResult.pdf_exports);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PDF preflight could not be completed");
    } finally {
      setLoading(false);
    }
  }, [documentId, prepareDocument, workspaceId]);

  const refreshExports = useCallback(async () => {
    try {
      const result = await api.pdfExports(workspaceId, documentId);
      setExports(result.pdf_exports);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PDF export status could not be refreshed");
    }
  }, [documentId, workspaceId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open || !exports.some((item) => ACTIVE_STATES.has(item.request.state))) return;
    const timer = window.setInterval(() => void refreshExports(), 1_500);
    return () => window.clearInterval(timer);
  }, [exports, open, refreshExports]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const current = await prepareDocument();
      const checked = await api.pdfPreflight(workspaceId, current.document.document_id);
      setPreflight(checked.preflight);
      if (checked.preflight.state !== "ready") return;
      const response = await api.submitPdfExport(workspaceId, current.document.document_id);
      setExports((items) => [response.pdf_export, ...items.filter((item) => item.request.pdf_export_request_id !== response.pdf_export.request.pdf_export_request_id)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PDF export could not be submitted");
    } finally {
      setSubmitting(false);
    }
  }

  async function mutate(item: PdfExportReadModel, action: "cancel" | "retry") {
    setError(null);
    try {
      const response = action === "cancel"
        ? await api.cancelPdfExport(workspaceId, item.request.pdf_export_request_id)
        : await api.retryPdfExport(workspaceId, item.request.pdf_export_request_id);
      setExports((items) => items.map((candidate) => candidate.request.pdf_export_request_id === response.pdf_export.request.pdf_export_request_id ? response.pdf_export : candidate));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `PDF export could not ${action}`);
    }
  }

  return <Dialog open={open} title="Export PDF" onClose={onClose}>
    <div className="pdf-export-center" data-testid="pdf-export-center">
      {error && <InlineNotice tone="error" title="PDF export unavailable">{error}</InlineNotice>}
      {loading && !preflight
        ? <StatePanel kind="loading" title="Checking this PDF" message="Saving the current native version and running output preflight." />
        : preflight && <section className="pdf-preflight" aria-labelledby="pdf-preflight-heading">
          <div className="section-heading"><div><h3 id="pdf-preflight-heading">Screen PDF preflight</h3><p>{preflight.page_count} {preflight.page_count === 1 ? "page" : "pages"} · sRGB · safe metadata</p></div><span className={`pdf-preflight-state state-${preflight.state}`}>{preflight.state === "ready" ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}{preflight.state === "ready" ? "Ready" : "Blocked"}</span></div>
          <InlineNotice tone="info" title="Output disclosure">This profile preserves visible text and images. It is untagged and is not PDF/A.</InlineNotice>
          {(preflight.issues ?? []).length > 0 && <ul className="pdf-preflight-issues">{(preflight.issues ?? []).map((issue, index) => <li className={`severity-${issue.severity}`} key={`${issue.code}-${issue.layer_id ?? issue.page_artboard_id ?? index}`}>{issue.severity === "error" ? <XCircle aria-hidden="true" /> : issue.severity === "warning" ? <AlertTriangle aria-hidden="true" /> : <FileCheck2 aria-hidden="true" />}<span><strong>{issue.message}</strong>{issue.page_artboard_id && <small>Page reference: {issue.page_artboard_id}</small>}</span></li>)}</ul>}
          <div className="pdf-export-actions"><Button onClick={() => void load()} disabled={loading || submitting}><RefreshCw aria-hidden="true" />Run preflight again</Button><Button tone="primary" onClick={() => void submit()} disabled={loading || submitting || preflight.state !== "ready"}><Download aria-hidden="true" />{submitting ? "Submitting..." : "Export Screen PDF"}</Button></div>
        </section>}

      {exports.length > 0 && <section className="pdf-export-history" aria-labelledby="pdf-export-history-heading"><div className="section-heading"><div><h3 id="pdf-export-history-heading">Exports</h3><p>Durable output jobs remain available after this dialog closes.</p></div></div><div role="list">{exports.map((item) => <article role="listitem" key={item.request.pdf_export_request_id}><span className={`pdf-export-status state-${item.request.state}`}>{item.request.state === "succeeded" ? <CheckCircle2 aria-hidden="true" /> : item.request.state === "failed" ? <XCircle aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}</span><span><strong>{item.result?.filename ?? "Screen PDF"}</strong><small>{item.request.state.replaceAll("_", " ")}{item.result ? ` · ${item.result.page_count} pages · ${formatBytes(item.result.byte_size)}` : ""}</small>{item.request.failure_message && <small>{item.request.failure_message}</small>}</span><div>{ACTIVE_STATES.has(item.request.state) && <Button size="compact" tone="danger" onClick={() => void mutate(item, "cancel")}>Cancel</Button>}{["failed", "cancelled"].includes(item.request.state) && <Button size="compact" onClick={() => void mutate(item, "retry")}>Retry</Button>}{item.request.state === "succeeded" && item.result && <a className="ds-button ds-button-primary ds-button-compact" href={api.pdfExportDownloadUrl(workspaceId, item.request.pdf_export_request_id)}><Download aria-hidden="true" />Download</a>}</div></article>)}</div></section>}
      <div className="dialog-actions"><Button onClick={onClose}>Close</Button></div>
    </div>
  </Dialog>;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  return `${Math.round(value / 104_857.6) / 10} MB`;
}
