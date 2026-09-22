import type { FaceQualityCandidateRequest, FaceQualityCompositionIntent, FaceQualityJobView, NativeFaceOutput, NativeFaceRelease, StoredNativeFaceCandidate } from "ipw-contracts-ts/product";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { DomainError } from "../../kernel/errors.js";
import type { CommandContext } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import type { IntakeOwner } from "../intake/intake.types.js";

export const FACE_QUALITY_REPOSITORY = Symbol("FACE_QUALITY_REPOSITORY");
export const FACE_QUALITY_RELEASES = Symbol("FACE_QUALITY_RELEASES");
export interface NativeFaceReleases { current(): NativeFaceRelease | null; }

/** Empty until exact commercial artefacts and real-photo acceptance are registered. */
export class UnregisteredNativeFaceReleases implements NativeFaceReleases {
  current(): null { return null; }
}
export function requireFaceRelease(release: NativeFaceRelease | null): NativeFaceRelease {
  if (!release || release.commercial_rights !== "approved" || release.quality_review !== "approved"
    || !release.rights_evidence_id?.trim() || !release.quality_evidence_id?.trim()
    || !release.model_id.trim() || !release.model_version.trim()
    || !/^[0-9a-f]{64}$/.test(release.model_sha256) || !/^[0-9a-f]{64}$/.test(release.dependency_lock_sha256)) {
    throw new DomainError(503, "face-quality-unavailable", "Face model rights and real-photo quality acceptance are not registered");
  }
  return release;
}

export class PostgresFaceQualityRepository {
  constructor(private readonly pool: Pool, private readonly runtime: RuntimeValues) {}

  async createCandidates(context: CommandContext, owner: IntakeOwner, uploadId: string,
    intent: FaceQualityCandidateRequest, release: NativeFaceRelease) {
    requireFaceRelease(release);
    return this.create(context, owner, uploadId, "candidates", intent, release);
  }
  async createComposition(context: CommandContext, owner: IntakeOwner, uploadId: string,
    intent: FaceQualityCompositionIntent, release: NativeFaceRelease) {
    requireFaceRelease(release);
    return this.create(context, owner, uploadId, "compose", intent, release);
  }

  private async create(context: CommandContext, owner: IntakeOwner, uploadId: string,
    operation: "candidates" | "compose", intent: FaceQualityCandidateRequest | FaceQualityCompositionIntent,
    release: NativeFaceRelease) {
    const client = await this.pool.connect();
    const command = `face-quality.${operation}`;
    try {
      await client.query("BEGIN");
      // Serialise absent-row idempotency too: SELECT FOR UPDATE alone cannot do it.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify([owner.ownerScope, command, context.idempotencyKey])]);
      const prior = await client.query(`SELECT * FROM face_quality_idempotency
        WHERE owner_scope=$1 AND command_name=$2 AND idempotency_key=$3`,
      [owner.ownerScope, command, context.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0]["request_hash"] !== context.requestHash) {
          throw new DomainError(409, "idempotency-conflict", "This key already identifies different face work");
        }
        const value = await this.view(client, owner, uploadId, String(prior.rows[0]["face_quality_job_id"]));
        if (!value) throw new DomainError(404, "face-quality-not-found", "Face work was not found for this image");
        await client.query("COMMIT");
        return { value, replayed: true };
      }
      let baseId: string;
      let parentId: string | null = null;
      let candidateSha: string | null = null;
      if (operation === "compose") {
        const review = intent as FaceQualityCompositionIntent;
        const parent = await client.query(`SELECT f.*,j.state FROM face_quality_jobs f
          JOIN processing_jobs j USING(job_id) WHERE f.face_quality_job_id=$1 AND f.owner_scope=$2
          AND f.upload_session_id=$3 AND f.operation='candidates' AND f.expires_at>$4 FOR SHARE OF f,j`,
        [review.candidate_request_id, owner.ownerScope, uploadId, this.runtime.now()]);
        const row = parent.rows[0];
        if (!row) throw new DomainError(404, "face-quality-not-found", "Candidate work was not found for this image");
        if (row["state"] !== "succeeded" || row["source_sha256"] !== review.source_sha256
          || row["base_output_sha256"] !== review.base_output_sha256) {
          throw new DomainError(409, "face-quality-review-stale", "Review the exact completed face candidates");
        }
        const old = row["release"] as NativeFaceRelease;
        if (old.model_sha256 !== release.model_sha256 || old.dependency_lock_sha256 !== release.dependency_lock_sha256) {
          throw new DomainError(409, "face-quality-release-changed", "Generate candidates with the current approved model");
        }
        const selected = await client.query(`SELECT candidate_sha256 FROM face_quality_candidates
          WHERE face_quality_job_id=$1 AND candidate_sha256=$2`, [review.candidate_request_id, review.candidate_sha256]);
        if (!selected.rowCount) throw new DomainError(409, "face-quality-review-stale", "The reviewed candidate was not found");
        baseId = String(row["base_image_quality_request_id"]);
        parentId = review.candidate_request_id;
        candidateSha = review.candidate_sha256;
      } else baseId = (intent as FaceQualityCandidateRequest).base_image_quality_request_id;
      const base = await client.query(`SELECT i.*,u.state AS upload_state,u.source_facts,
        u.expires_at AS upload_expires_at FROM image_quality_requests i JOIN upload_sessions u USING(upload_session_id)
        WHERE i.image_quality_request_id=$1 AND i.owner_scope=$2 AND i.owner_kind=$3
        AND i.upload_session_id=$4 FOR SHARE OF i,u`, [baseId, owner.ownerScope, owner.ownerKind, uploadId]);
      const row = base.rows[0];
      if (!row) throw new DomainError(404, "face-quality-base-not-found", "The enhanced image was not found");
      const facts = row["source_facts"] as { sha256?: string } | null;
      const now = this.runtime.now();
      if (row["state"] !== "succeeded" || row["upload_state"] !== "ready"
        || facts?.sha256 !== intent.source_sha256 || row["source_sha256"] !== intent.source_sha256
        || row["output_sha256"] !== intent.base_output_sha256
        || new Date(row["expires_at"] as string).getTime() <= new Date(now).getTime()
        || new Date(row["upload_expires_at"] as string).getTime() <= new Date(now).getTime()) {
        throw new DomainError(409, "face-quality-source-changed", "The immutable source or completed base is stale");
      }
      if (Number(row["source_frame_count"]) !== 1 || Number(row["output_frame_count"]) !== 1
        || ![8, 16].includes(Number(row["output_bit_depth"]))) {
        throw new DomainError(415, "face-quality-native-layout-unsupported", "Native face processing currently requires an 8/16-bit still base");
      }
      const id = this.runtime.id("face"); const jobId = this.runtime.id("job");
      await client.query(`INSERT INTO face_quality_jobs(face_quality_job_id,job_id,operation,
        owner_kind,owner_scope,workspace_id,actor_id,guest_session_id,upload_session_id,
        base_image_quality_request_id,source_sha256,base_output_sha256,candidate_request_id,
        candidate_sha256,intent,release,expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, jobId, operation, owner.ownerKind, owner.ownerScope, owner.workspaceId ?? null,
        owner.actorId ?? null, owner.guestSessionId ?? null, uploadId, baseId, intent.source_sha256,
        intent.base_output_sha256, parentId, candidateSha, intent, release,
        new Date(Math.min(new Date(row["expires_at"] as string).getTime(), new Date(row["upload_expires_at"] as string).getTime())).toISOString(), now]);
      await client.query(`INSERT INTO processing_jobs(job_id,kind,owner_kind,workspace_id,actor_id,
        guest_session_id,upload_session_id,face_quality_job_id,state,attempt,max_attempts,progress_percent,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',0,3,0,$9,$9)`,
      [jobId, operation === "candidates" ? "image_face_candidates" : "image_face_compose", owner.ownerKind,
        owner.workspaceId ?? null, owner.actorId ?? null, owner.guestSessionId ?? null, uploadId, id, now]);
      await this.dispatch(client, jobId, context.traceId, now);
      await client.query(`INSERT INTO face_quality_idempotency VALUES($1,$2,$3,$4,$5)`,
        [owner.ownerScope, command, context.idempotencyKey, context.requestHash, id]);
      const value = (await this.view(client, owner, uploadId, id))!;
      await client.query("COMMIT");
      return { value, replayed: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async dispatch(client: PoolClient, jobId: string, traceId: string, now: string) {
    await client.query(`INSERT INTO job_events(job_event_id,job_id,event_kind,state,progress_percent,occurred_at,trace_id)
      SELECT $1,job_id,'job.queued','queued',progress_percent,$3,$4 FROM processing_jobs WHERE job_id=$2`,
    [this.runtime.id("job-event"), jobId, now, traceId]);
    await client.query(`INSERT INTO job_outbox(outbox_id,job_id,dispatch_kind,payload,trace_id,available_at,created_at)
      VALUES($1,$2,'process_job',$3,$4,$5,$5)`, [this.runtime.id("outbox"), jobId, { job_id: jobId }, traceId, now]);
  }

  private async view(client: Pick<Pool, "query"> | PoolClient, owner: IntakeOwner, uploadId: string, id: string): Promise<FaceQualityJobView | null> {
    const result = await client.query(`SELECT f.*,j.state,j.progress_percent,j.failure FROM face_quality_jobs f
      JOIN processing_jobs j USING(job_id) WHERE f.face_quality_job_id=$1 AND f.owner_scope=$2
      AND f.owner_kind=$3 AND f.upload_session_id=$4 AND f.expires_at>$5`,
    [id, owner.ownerScope, owner.ownerKind, uploadId, this.runtime.now()]);
    const row = result.rows[0]; if (!row) return null;
    const candidates = row["operation"] === "candidates" && row["state"] === "succeeded"
      ? await client.query(`SELECT stored_candidate FROM face_quality_candidates WHERE face_quality_job_id=$1 ORDER BY ordinal`, [id]) : null;
    return { contract_version: "image-quality-face-v1", face_quality_job_id: id, job_id: String(row["job_id"]),
      operation: row["operation"] as FaceQualityJobView["operation"], state: row["state"] as FaceQualityJobView["state"],
      progress_percent: Number(row["progress_percent"]), source_sha256: String(row["source_sha256"]),
      base_output_sha256: String(row["base_output_sha256"]),
      candidates: candidates?.rows.map((item: QueryResultRow) => (item["stored_candidate"] as StoredNativeFaceCandidate).candidate) ?? [],
      output_sha256: (row["output"] as NativeFaceOutput | null)?.object.sha256 ?? null,
      failure: (row["failure"] as Record<string, unknown> | null) ?? null,
      expires_at: new Date(row["expires_at"] as string).toISOString() };
  }
  get(owner: IntakeOwner, uploadId: string, id: string) { return this.view(this.pool, owner, uploadId, id); }

  async retry(context: CommandContext, owner: IntakeOwner, uploadId: string, id: string, release: NativeFaceRelease) {
    requireFaceRelease(release);
    const client = await this.pool.connect();
    const command = "face-quality.retry";
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify([owner.ownerScope, command, context.idempotencyKey])]);
      const prior = await client.query(`SELECT request_hash,face_quality_job_id FROM face_quality_idempotency
        WHERE owner_scope=$1 AND command_name=$2 AND idempotency_key=$3`, [owner.ownerScope, command, context.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0]["request_hash"] !== context.requestHash || prior.rows[0]["face_quality_job_id"] !== id) {
          throw new DomainError(409, "idempotency-conflict", "This retry key already identifies other face work");
        }
        const value = await this.view(client, owner, uploadId, id);
        if (!value) throw new DomainError(404, "face-quality-not-found", "Face work was not found");
        await client.query("COMMIT"); return { value, replayed: true };
      }
      const found = await client.query(`SELECT f.*,j.state,j.failure,j.max_attempts,u.state AS upload_state,
        u.source_facts,i.state AS base_state,i.output_sha256 FROM face_quality_jobs f
        JOIN processing_jobs j USING(job_id) JOIN upload_sessions u ON u.upload_session_id=f.upload_session_id
        JOIN image_quality_requests i ON i.image_quality_request_id=f.base_image_quality_request_id
        WHERE f.face_quality_job_id=$1 AND f.owner_scope=$2 AND f.owner_kind=$3 AND f.upload_session_id=$4
        AND f.expires_at>$5 AND i.expires_at>$5 AND u.expires_at>$5 FOR UPDATE OF j`,
      [id, owner.ownerScope, owner.ownerKind, uploadId, this.runtime.now()]);
      const row = found.rows[0];
      if (!row) throw new DomainError(404, "face-quality-not-found", "Face work was not found");
      const old = row["release"] as NativeFaceRelease;
      if (old.model_sha256 !== release.model_sha256 || old.dependency_lock_sha256 !== release.dependency_lock_sha256
        || row["upload_state"] !== "ready" || row["base_state"] !== "succeeded"
        || (row["source_facts"] as { sha256?: string } | null)?.sha256 !== row["source_sha256"]
        || row["output_sha256"] !== row["base_output_sha256"] || row["state"] !== "failed"
        || !(row["failure"] as { retryable?: boolean } | null)?.retryable || Number(row["max_attempts"]) >= 20) {
        throw new DomainError(409, "face-quality-not-retryable", "Only retryable face work on the unchanged source/base/model can be reopened");
      }
      const now = this.runtime.now();
      await client.query(`UPDATE processing_jobs SET state='queued',max_attempts=max_attempts+1,
        failure=NULL,next_attempt_at=NULL,lease_owner=NULL,lease_token_hash=NULL,lease_expires_at=NULL,
        heartbeat_at=NULL,updated_at=$1 WHERE job_id=$2`, [now, row["job_id"]]);
      await this.dispatch(client, String(row["job_id"]), context.traceId, now);
      await client.query("INSERT INTO face_quality_idempotency VALUES($1,$2,$3,$4,$5)",
        [owner.ownerScope, command, context.idempotencyKey, context.requestHash, id]);
      const value = (await this.view(client, owner, uploadId, id))!;
      await client.query("COMMIT"); return { value, replayed: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async cancel(owner: IntakeOwner, uploadId: string, id: string, traceId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(`SELECT j.job_id,j.state,j.progress_percent FROM face_quality_jobs f JOIN processing_jobs j USING(job_id)
        WHERE f.face_quality_job_id=$1 AND f.owner_scope=$2 AND f.owner_kind=$3 AND f.upload_session_id=$4 FOR UPDATE OF j`,
      [id, owner.ownerScope, owner.ownerKind, uploadId]);
      const row = found.rows[0]; if (!row) throw new DomainError(404, "face-quality-not-found", "Face work was not found");
      if (["queued", "retry_wait", "leased", "running"].includes(String(row["state"]))) {
        const state = ["queued", "retry_wait"].includes(String(row["state"])) ? "cancelled" : "cancel_requested";
        const now = this.runtime.now();
        await client.query("UPDATE processing_jobs SET state=$1,updated_at=$2 WHERE job_id=$3", [state, now, row["job_id"]]);
        await client.query(`INSERT INTO job_events(job_event_id,job_id,event_kind,state,progress_percent,occurred_at,trace_id)
          VALUES($1,$2,$3,$4,$7,$5,$6)`, [this.runtime.id("job-event"), row["job_id"], `job.${state}`, state, now, traceId,row["progress_percent"]]);
      }
      const value = await this.view(client, owner, uploadId, id);
      await client.query("COMMIT"); return value;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async delivery(owner: IntakeOwner, uploadId: string, id: string): Promise<NativeFaceOutput | null> {
    const result = await this.pool.query(`SELECT f.output FROM face_quality_jobs f JOIN processing_jobs j USING(job_id)
      WHERE f.face_quality_job_id=$1 AND f.owner_scope=$2 AND f.owner_kind=$3 AND f.upload_session_id=$4
      AND f.operation='compose' AND j.state='succeeded' AND f.expires_at>$5`,
    [id, owner.ownerScope, owner.ownerKind, uploadId, this.runtime.now()]);
    return (result.rows[0]?.["output"] as NativeFaceOutput | null) ?? null;
  }

  async candidateArtifact(
    owner: IntakeOwner,
    uploadId: string,
    id: string,
    candidateId: string,
  ): Promise<{ stored: StoredNativeFaceCandidate; candidateSha256: string; release: NativeFaceRelease } | null> {
    const result = await this.pool.query(`SELECT c.stored_candidate,c.candidate_sha256,f.release
      FROM face_quality_candidates c JOIN face_quality_jobs f USING(face_quality_job_id)
      JOIN processing_jobs j USING(job_id)
      WHERE f.face_quality_job_id=$1 AND f.owner_scope=$2 AND f.owner_kind=$3
      AND f.upload_session_id=$4 AND f.operation='candidates' AND j.state='succeeded'
      AND f.expires_at>$5 AND c.stored_candidate->'candidate'->>'candidate_id'=$6`,
    [id, owner.ownerScope, owner.ownerKind, uploadId, this.runtime.now(), candidateId]);
    const row = result.rows[0];
    return row ? {
      stored: row["stored_candidate"] as StoredNativeFaceCandidate,
      candidateSha256: String(row["candidate_sha256"]),
      release: row["release"] as NativeFaceRelease,
    } : null;
  }
  close() { return this.pool.end(); }
}
