import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import { runMigrations } from "../../kernel/migrations.js";
import type { CommandContext } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import type { IntakeOwner } from "../intake/intake.types.js";
import type {
  CreateImageQualityInput,
  ImageQualityDelivery,
  ImageQualityOutputRecord,
  ImageQualityRepository,
  ImageQualityRequestRecord,
} from "./image-quality.types.js";

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function record(row: QueryResultRow): ImageQualityRequestRecord {
  const succeeded = row["state"] === "succeeded";
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    image_quality_request_id: String(row["image_quality_request_id"]),
    owner_kind: String(row["owner_kind"]) as ImageQualityRequestRecord["owner_kind"],
    workspace_id: row["workspace_id"] ? String(row["workspace_id"]) : null,
    guest_session_id: row["guest_session_id"] ? String(row["guest_session_id"]) : null,
    upload_session_id: String(row["upload_session_id"]),
    source_version_id: String(row["source_version_id"]),
    source_sha256: String(row["source_sha256"]),
    source_media_type: String(row["source_media_type"]) as ImageQualityRequestRecord["source_media_type"],
    source_byte_size: Number(row["source_byte_size"]),
    source_width: Number(row["source_width"]),
    source_height: Number(row["source_height"]),
    source_frame_count: Number(row["source_frame_count"]),
    source_bit_depth: Number(row["source_bit_depth"]),
    source_colour_primaries: row["source_colour_primaries"] as ImageQualityRequestRecord["source_colour_primaries"],
    source_dynamic_range: row["source_dynamic_range"] as ImageQualityRequestRecord["source_dynamic_range"],
    content_class: String(row["content_class"]) as ImageQualityRequestRecord["content_class"],
    strength: Number(row["strength"]),
    job_id: String(row["job_id"]),
    state: String(row["state"]) as ImageQualityRequestRecord["state"],
    progress_percent: Number(row["progress_percent"]),
    output: succeeded ? {
      media_type: "image/png",
      byte_size: Number(row["output_byte_size"]),
      width: Number(row["output_width"]),
      height: Number(row["output_height"]),
      frame_count: Number(row["output_frame_count"]),
      bit_depth: Number(row["output_bit_depth"]),
      has_icc_profile: Boolean(row["output_has_icc_profile"]),
      colour_policy: String(row["output_colour_policy"]),
      colour_primaries: row["output_colour_primaries"] as ImageQualityOutputRecord["colour_primaries"],
      dynamic_range: row["output_dynamic_range"] as ImageQualityOutputRecord["dynamic_range"],
      sha256: String(row["output_sha256"]),
      model: {
        id: String(row["model_id"]),
        version: String(row["model_version"]),
        sha256: String(row["model_sha256"]),
        usage: String(row["model_usage"]) as ImageQualityOutputRecord["model"]["usage"],
        deterministic: Boolean(row["deterministic"]),
      },
      processor: {
        name: String(row["processor_name"]),
        version: String(row["processor_version"]),
      },
      fidelity: row["output_fidelity"] as ImageQualityOutputRecord["fidelity"],
    } : null,
    failure: row["failure"] as ImageQualityRequestRecord["failure"],
    expires_at: instant(row["expires_at"] as Date | string),
    created_at: instant(row["created_at"] as Date | string),
    updated_at: instant(row["updated_at"] as Date | string),
  };
}

export class PostgresImageQualityRepository implements ImageQualityRepository {
  constructor(private readonly pool: Pool, private readonly runtime: RuntimeValues) {}

  static async connect(
    connectionString: string,
    runtime: RuntimeValues,
    migrate = false,
  ): Promise<PostgresImageQualityRepository> {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresImageQualityRepository(pool, runtime);
  }

  async create(context: CommandContext, input: CreateImageQualityInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query(
        `SELECT request_hash,image_quality_request_id FROM image_quality_idempotency
         WHERE owner_scope=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.owner.ownerScope, context.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0]["request_hash"] !== context.requestHash) {
          throw new DomainError(
            409,
            "idempotency-conflict",
            "This idempotency key was already used for different enhancement work",
          );
        }
        const value = await this.read(
          client,
          input.owner,
          String(prior.rows[0]["image_quality_request_id"]),
        );
        await client.query("COMMIT");
        return { value, replayed: true };
      }
      const upload = await client.query(
        `SELECT state,owner_kind,workspace_id,actor_id,guest_session_id,source_version_id,
                immutable_object_key,immutable_provider_generation,source_facts
         FROM upload_sessions WHERE upload_session_id=$1 FOR SHARE`,
        [input.uploadSessionId],
      );
      const row = upload.rows[0];
      if (!row || row["state"] !== "ready" || String(row["owner_kind"]) !== input.owner.ownerKind
        || (input.owner.ownerKind === "actor" && row["workspace_id"] !== input.owner.workspaceId)
        || (input.owner.ownerKind === "guest" && row["guest_session_id"] !== input.owner.guestSessionId)) {
        throw new DomainError(409, "source-not-ready", "The verified source is not ready for enhancement");
      }
      const requestId = this.runtime.id("quality");
      const jobId = this.runtime.id("job");
      const now = this.runtime.now();
      await client.query(
        `INSERT INTO image_quality_requests(
           image_quality_request_id,owner_kind,owner_scope,workspace_id,actor_id,
           guest_session_id,upload_session_id,source_version_id,source_object_key,
           source_storage_generation,source_sha256,source_media_type,source_byte_size,
           source_width,source_height,source_frame_count,source_bit_depth,source_has_icc_profile,
           source_colour_primaries,source_dynamic_range,content_class,strength,job_id,state,
           progress_percent,expires_at,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                $21,$22,$23,'queued',0,$24,$25,$25)`,
        [requestId, input.owner.ownerKind, input.owner.ownerScope,
          input.owner.workspaceId ?? null, input.owner.actorId ?? null,
          input.owner.guestSessionId ?? null, input.uploadSessionId, input.sourceVersionId,
          input.sourceObjectKey, input.sourceStorageGeneration, input.sourceSha256,
          input.sourceMediaType, input.sourceByteSize, input.sourceWidth, input.sourceHeight,
          input.sourceFrameCount, input.sourceBitDepth, input.sourceHasIccProfile,
          input.sourceColourPrimaries, input.sourceDynamicRange, input.contentClass,
          input.strength, jobId, input.expiresAt, now],
      );
      await client.query(
        `INSERT INTO processing_jobs(
           job_id,kind,owner_kind,workspace_id,actor_id,guest_session_id,upload_session_id,
           document_id,export_request_id,pdf_export_request_id,bundle_id,image_quality_request_id,
           state,attempt,max_attempts,progress_percent,created_at,updated_at)
         VALUES($1,'image_quality_restore',$2,$3,$4,$5,$6,NULL,NULL,NULL,NULL,$7,
                'queued',0,3,0,$8,$8)`,
        [jobId, input.owner.ownerKind, input.owner.workspaceId ?? null,
          input.owner.actorId ?? null, input.owner.guestSessionId ?? null,
          input.uploadSessionId, requestId, now],
      );
      await client.query(
        `INSERT INTO job_events(job_event_id,job_id,event_kind,state,progress_percent,occurred_at,trace_id)
         VALUES($1,$2,'job.queued','queued',0,$3,$4)`,
        [this.runtime.id("job-event"), jobId, now, context.traceId],
      );
      await client.query(
        `INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,available_at,created_at)
         VALUES($1,$2,'process_job',$3,$4,$5,$5)`,
        [this.runtime.id("outbox"), jobId, { job_id: jobId }, context.traceId, now],
      );
      await client.query(
        `INSERT INTO image_quality_idempotency(owner_scope,idempotency_key,command_name,
          request_hash,image_quality_request_id,created_at)
         VALUES($1,$2,'image-quality.create',$3,$4,$5)`,
        [input.owner.ownerScope, context.idempotencyKey, context.requestHash, requestId, now],
      );
      const value = await this.read(client, input.owner, requestId);
      await client.query("COMMIT");
      return { value, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(owner: IntakeOwner, requestId: string): Promise<ImageQualityRequestRecord | null> {
    const value = await this.pool.query(
      `SELECT * FROM image_quality_requests
       WHERE image_quality_request_id=$1 AND owner_scope=$2 AND owner_kind=$3`,
      [requestId, owner.ownerScope, owner.ownerKind],
    );
    return value.rows[0] ? record(value.rows[0]) : null;
  }

  async delivery(owner: IntakeOwner, requestId: string): Promise<ImageQualityDelivery | null> {
    const value = await this.pool.query(
      `SELECT * FROM image_quality_requests
       WHERE image_quality_request_id=$1 AND owner_scope=$2 AND owner_kind=$3
         AND state='succeeded'`,
      [requestId, owner.ownerScope, owner.ownerKind],
    );
    const row = value.rows[0];
    return row ? {
      ownerScope: owner.ownerScope,
      objectKey: String(row["output_object_key"]),
      storageGeneration: String(row["output_storage_generation"]),
      byteSize: Number(row["output_byte_size"]),
      mediaType: "image/png",
      filename: `enhanced-${String(row["image_quality_request_id"])}.png`,
      sha256: String(row["output_sha256"]),
      frameCount: Number(row["output_frame_count"]),
    } : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async read(
    client: PoolClient,
    owner: IntakeOwner,
    requestId: string,
  ): Promise<ImageQualityRequestRecord> {
    const value = await client.query(
      `SELECT * FROM image_quality_requests
       WHERE image_quality_request_id=$1 AND owner_scope=$2 AND owner_kind=$3`,
      [requestId, owner.ownerScope, owner.ownerKind],
    );
    if (!value.rows[0]) {
      throw new DomainError(404, "image-quality-not-found", "Enhancement request was not found");
    }
    return record(value.rows[0]);
  }
}
