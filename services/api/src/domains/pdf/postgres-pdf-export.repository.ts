import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { PdfExportRequestRecord, PdfExportResult } from "ipw-contracts-ts/product";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { runMigrations } from "../../kernel/migrations.js";
import type { CommandContext } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import type {
  CreatePdfExportInput,
  PdfExportDelivery,
  PdfExportReadModel,
  PdfExportRepository,
} from "./pdf.types.js";

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function request(row: QueryResultRow): PdfExportRequestRecord {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    pdf_export_request_id: String(row["pdf_export_request_id"]),
    workspace_id: String(row["workspace_id"]),
    document_id: String(row["document_id"]),
    document_version_id: String(row["document_version_id"]),
    snapshot_sha256: String(row["snapshot_sha256"]),
    profile: row["profile"] as PdfExportRequestRecord["profile"],
    preflight: row["preflight"] as PdfExportRequestRecord["preflight"],
    state: String(row["state"]) as PdfExportRequestRecord["state"],
    job_id: String(row["job_id"]),
    created_by_actor_id: String(row["actor_id"]),
    created_at: instant(row["created_at"] as Date | string),
    updated_at: instant(row["updated_at"] as Date | string),
    failure_code: row["failure_code"] ? String(row["failure_code"]) : null,
    failure_message: row["failure_message"] ? String(row["failure_message"]) : null,
  };
}

function result(row: QueryResultRow): PdfExportResult {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    pdf_export_result_id: String(row["pdf_export_result_id"]),
    pdf_export_request_id: String(row["pdf_export_request_id"]),
    workspace_id: String(row["workspace_id"]),
    document_id: String(row["document_id"]),
    document_version_id: String(row["document_version_id"]),
    filename: String(row["filename"]),
    media_type: "application/pdf",
    byte_size: Number(row["byte_size"]),
    sha256: String(row["sha256"]),
    page_count: Number(row["page_count"]),
    renderer: row["renderer"] as PdfExportResult["renderer"],
    object_reference_id: String(row["object_reference_id"]),
    created_at: instant(row["created_at"] as Date | string),
  };
}

export class PostgresPdfExportRepository implements PdfExportRepository {
  readonly recordsMutationsAtomically = true;

  constructor(private readonly pool: Pool, private readonly runtime: RuntimeValues) {}

  static async connect(
    connectionString: string,
    runtime: RuntimeValues,
    migrate = false,
  ): Promise<PostgresPdfExportRepository> {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresPdfExportRepository(pool, runtime);
  }

  async create(context: CommandContext, input: CreatePdfExportInput) {
    return this.transaction(async (client) => {
      const replay = await this.replay(client, context, input.workspaceId, "pdf-export.create");
      if (replay) return { value: replay, replayed: true };
      if (input.preflight.state !== "ready") {
        throw new DomainError(409, "pdf-preflight-blocked", "Resolve blocking PDF preflight issues before export");
      }
      const documentResult = await client.query(
        `SELECT document.kind,document.current_version_id,version.snapshot_sha256
         FROM editor_documents document
         JOIN memberships membership
           ON membership.workspace_id=document.workspace_id AND membership.actor_id=$1
         JOIN document_versions version
           ON version.document_id=document.document_id AND version.document_version_id=document.current_version_id
         WHERE document.workspace_id=$2 AND document.document_id=$3`,
        [context.principal.actorId, input.workspaceId, input.preflight.document_id],
      );
      const document = documentResult.rows[0];
      if (!document || document["kind"] !== "pdf") {
        throw new DomainError(404, "pdf-document-not-found", "Native PDF document was not found");
      }
      if (String(document["current_version_id"]) !== input.preflight.document_version_id
        || String(document["snapshot_sha256"]) !== input.preflight.snapshot_sha256) {
        throw new DomainError(409, "document-version-changed", "Review the current PDF version before exporting");
      }
      const requestId = this.runtime.id("pdf-export");
      const jobId = this.runtime.id("job");
      const now = this.runtime.now();
      await client.query(
        `INSERT INTO pdf_export_requests(pdf_export_request_id,workspace_id,actor_id,document_id,
         document_version_id,snapshot_sha256,profile,preflight,job_id,state,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$10)`,
        [requestId, input.workspaceId, context.principal.actorId, input.preflight.document_id,
          input.preflight.document_version_id, input.preflight.snapshot_sha256,
          JSON.stringify(input.preflight.profile), JSON.stringify(input.preflight), jobId, now],
      );
      await client.query(
        `WITH inserted AS (
           INSERT INTO processing_jobs(job_id,kind,owner_kind,workspace_id,actor_id,guest_session_id,
           upload_session_id,document_id,export_request_id,pdf_export_request_id,bundle_id,batch_id,
           batch_item_id,state,attempt,max_attempts,progress_percent,created_at,updated_at)
           VALUES ($1,'pdf_export','actor',$2,$3,NULL,NULL,$4,NULL,$5,NULL,NULL,NULL,'queued',0,3,0,$6,$6)
         )
         INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,available_at,created_at)
         VALUES ($7,$1,'process_job',$8,$9,$6,$6)`,
        [jobId, input.workspaceId, context.principal.actorId, input.preflight.document_id,
          requestId, now, this.runtime.id("outbox"), { job_id: jobId }, context.traceId],
      );
      await this.evidence(client, context, input.workspaceId, "pdf.export-submitted", requestId);
      const value = await this.read(client, input.workspaceId, requestId);
      await this.remember(client, context, input.workspaceId, "pdf-export.create", requestId, value);
      return { value, replayed: false };
    });
  }

  async list(actorId: string, workspaceId: string, documentId?: string): Promise<PdfExportReadModel[]> {
    const rows = await this.pool.query(
      `SELECT request.pdf_export_request_id FROM pdf_export_requests request
       JOIN memberships membership ON membership.workspace_id=request.workspace_id AND membership.actor_id=$1
       WHERE request.workspace_id=$2 AND ($3::text IS NULL OR request.document_id=$3)
       ORDER BY request.updated_at DESC,request.pdf_export_request_id DESC`,
      [actorId, workspaceId, documentId ?? null],
    );
    return Promise.all(rows.rows.map((row) => this.read(this.pool, workspaceId, String(row["pdf_export_request_id"]))));
  }

  async get(actorId: string, workspaceId: string, requestId: string): Promise<PdfExportReadModel | null> {
    const allowed = await this.pool.query(
      `SELECT 1 FROM pdf_export_requests request
       JOIN memberships membership ON membership.workspace_id=request.workspace_id AND membership.actor_id=$1
       WHERE request.workspace_id=$2 AND request.pdf_export_request_id=$3`,
      [actorId, workspaceId, requestId],
    );
    return allowed.rowCount ? this.read(this.pool, workspaceId, requestId) : null;
  }

  async cancel(context: CommandContext, workspaceId: string, requestId: string) {
    return this.transaction(async (client) => {
      const replay = await this.replay(client, context, workspaceId, "pdf-export.cancel");
      if (replay) return { value: replay, replayed: true };
      const current = await client.query(
        `SELECT request.state,request.job_id,job.state AS job_state FROM pdf_export_requests request
         JOIN processing_jobs job ON job.job_id=request.job_id
         WHERE request.workspace_id=$1 AND request.pdf_export_request_id=$2 FOR UPDATE OF request,job`,
        [workspaceId, requestId],
      );
      const row = current.rows[0];
      if (!row) throw new DomainError(404, "pdf-export-not-found", "PDF export was not found");
      if (!["succeeded", "failed", "cancelled"].includes(String(row["state"]))) {
        const immediate = ["queued", "retry_wait"].includes(String(row["job_state"]));
        await client.query("UPDATE processing_jobs SET state=$1,updated_at=$2 WHERE job_id=$3", [immediate ? "cancelled" : "cancel_requested", this.runtime.now(), row["job_id"]]);
        await client.query("UPDATE pdf_export_requests SET state=$1,updated_at=$2 WHERE pdf_export_request_id=$3", [immediate ? "cancelled" : "cancellation_requested", this.runtime.now(), requestId]);
        await this.evidence(client, context, workspaceId, "pdf.export-cancellation-requested", requestId);
      }
      const value = await this.read(client, workspaceId, requestId);
      await this.remember(client, context, workspaceId, "pdf-export.cancel", requestId, value);
      return { value, replayed: false };
    });
  }

  async retry(context: CommandContext, workspaceId: string, requestId: string) {
    return this.transaction(async (client) => {
      const replay = await this.replay(client, context, workspaceId, "pdf-export.retry");
      if (replay) return { value: replay, replayed: true };
      const current = await client.query(
        "SELECT * FROM pdf_export_requests WHERE workspace_id=$1 AND pdf_export_request_id=$2 FOR UPDATE",
        [workspaceId, requestId],
      );
      const row = current.rows[0];
      if (!row) throw new DomainError(404, "pdf-export-not-found", "PDF export was not found");
      if (!["failed", "cancelled"].includes(String(row["state"]))) {
        throw new DomainError(409, "pdf-export-not-retryable", "Only failed or cancelled PDF exports can be retried");
      }
      const jobId = this.runtime.id("job");
      const now = this.runtime.now();
      await client.query(
        `UPDATE pdf_export_requests SET job_id=$1,state='queued',failure_code=NULL,failure_message=NULL,
         updated_at=$2 WHERE workspace_id=$3 AND pdf_export_request_id=$4`,
        [jobId, now, workspaceId, requestId],
      );
      await client.query(
        `WITH inserted AS (
           INSERT INTO processing_jobs(job_id,kind,owner_kind,workspace_id,actor_id,document_id,
           pdf_export_request_id,state,attempt,max_attempts,progress_percent,created_at,updated_at)
           VALUES ($1,'pdf_export','actor',$2,$3,$4,$5,'queued',0,3,0,$6,$6)
         )
         INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,available_at,created_at)
         VALUES ($7,$1,'process_job',$8,$9,$6,$6)`,
        [jobId, workspaceId, context.principal.actorId, String(row["document_id"]), requestId,
          now, this.runtime.id("outbox"), { job_id: jobId }, context.traceId],
      );
      await this.evidence(client, context, workspaceId, "pdf.export-retry-requested", requestId);
      const value = await this.read(client, workspaceId, requestId);
      await this.remember(client, context, workspaceId, "pdf-export.retry", requestId, value);
      return { value, replayed: false };
    });
  }

  async delivery(actorId: string, workspaceId: string, requestId: string): Promise<PdfExportDelivery | null> {
    const value = await this.pool.query(
      `SELECT object.object_key,object.storage_generation,result.byte_size,result.filename,result.sha256
       FROM pdf_export_results result
       JOIN pdf_export_requests request USING(pdf_export_request_id)
       JOIN memberships membership ON membership.workspace_id=request.workspace_id AND membership.actor_id=$1
       JOIN object_references object
         ON object.workspace_id=result.workspace_id AND object.object_reference_id=result.object_reference_id
       WHERE request.workspace_id=$2 AND request.pdf_export_request_id=$3 AND request.state='succeeded'`,
      [actorId, workspaceId, requestId],
    );
    const row = value.rows[0];
    return row ? {
      objectKey: String(row["object_key"]),
      storageGeneration: String(row["storage_generation"]),
      byteSize: Number(row["byte_size"]),
      mediaType: "application/pdf",
      filename: String(row["filename"]),
      sha256: String(row["sha256"]),
    } : null;
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async read(client: Pool | PoolClient, workspaceId: string, requestId: string): Promise<PdfExportReadModel> {
    const value = await client.query(
      `SELECT request.*,result.pdf_export_result_id,result.filename,result.media_type,result.byte_size,
              result.sha256 AS result_sha256,result.page_count,result.renderer,result.object_reference_id,
              result.created_at AS result_created_at
       FROM pdf_export_requests request
       LEFT JOIN pdf_export_results result USING(pdf_export_request_id)
       WHERE request.workspace_id=$1 AND request.pdf_export_request_id=$2`,
      [workspaceId, requestId],
    );
    const row = value.rows[0];
    if (!row) throw new DomainError(404, "pdf-export-not-found", "PDF export was not found");
    const exported = row["pdf_export_result_id"] ? result({
      ...row,
      sha256: row["result_sha256"],
      created_at: row["result_created_at"],
    }) : null;
    return { request: request(row), result: exported };
  }

  private async replay(client: PoolClient, context: CommandContext, workspaceId: string, command: string): Promise<PdfExportReadModel | null> {
    const value = await client.query(
      `SELECT command_name,request_hash,response_body FROM pdf_export_idempotency_records
       WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [workspaceId, context.idempotencyKey],
    );
    const row = value.rows[0];
    if (!row) return null;
    if (row["command_name"] !== command || row["request_hash"] !== context.requestHash) {
      throw new DomainError(409, "idempotency-conflict", "Idempotency key was already used for another PDF request");
    }
    return row["response_body"] as PdfExportReadModel;
  }

  private remember(client: PoolClient, context: CommandContext, workspaceId: string, command: string, resourceId: string, value: PdfExportReadModel) {
    return client.query(
      `INSERT INTO pdf_export_idempotency_records(workspace_id,idempotency_key,command_name,request_hash,
       resource_id,response_body,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [workspaceId, context.idempotencyKey, command, context.requestHash, resourceId, JSON.stringify(value), this.runtime.now()],
    );
  }

  private async evidence(client: PoolClient, context: CommandContext, workspaceId: string, action: string, requestId: string) {
    await client.query(
      `INSERT INTO audit_events(audit_event_id,workspace_id,actor_id,action,resource_kind,resource_id,occurred_at,trace_id)
       VALUES ($1,$2,$3,$4,'pdf_export',$5,$6,$7)`,
      [this.runtime.id("audit"), workspaceId, context.principal.actorId, action, requestId, this.runtime.now(), context.traceId],
    );
    const usageId = this.runtime.id("usage");
    await client.query(
      `INSERT INTO usage_events(usage_event_id,workspace_id,actor_id,event_kind,customer_amount,credit_debit,currency,occurred_at)
       VALUES ($1,$2,$3,$4,0,0,'USD',$5)`,
      [usageId, workspaceId, context.principal.actorId, action, this.runtime.now()],
    );
    await client.query(
      "INSERT INTO usage_admin_dimensions(usage_event_id,dimensions) VALUES ($1,$2)",
      [usageId, { capability: "native_pdf_creation", action, zero_charge: true }],
    );
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
