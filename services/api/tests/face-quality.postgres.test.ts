import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { FaceQualityCompositionIntent, NativeFaceRelease, StoredNativeFaceCandidate } from "ipw-contracts-ts/product";
import { Pool } from "pg";
import { DomainError } from "../src/kernel/errors.js";
import { runMigrations } from "../src/kernel/migrations.js";
import { requestDigest, SystemRuntimeValues } from "../src/kernel/runtime.js";
import { PostgresFaceQualityRepository, requireFaceRelease } from "../src/domains/image-quality/face-quality.repository.js";
import { parseFaceQualityCompositionIntent } from "../src/domains/image-quality/face-quality.contract.js";
import { PostgresImageQualityRepository } from "../src/domains/image-quality/postgres-image-quality.repository.js";
import { PostgresDurableJobRepository } from "../src/domains/jobs/postgres-durable-job.repository.js";

const database = process.env["IPW_TEST_FACE_DATABASE_URL"];
function pool() {
  assert.ok(database, "IPW_TEST_FACE_DATABASE_URL is required; this focused test must not silently skip");
  const address = new URL(database);
  assert.ok(["127.0.0.1", "localhost"].includes(address.hostname) && address.pathname === "/ipw_face_test", "Use the isolated local face-test database only");
  return new Pool({ connectionString: database });
}
const release: NativeFaceRelease = { model_id: "owned-synthetic-not-production", model_version: "1",
  model_sha256: "a".repeat(64), dependency_lock_sha256: "c".repeat(64), commercial_rights: "approved",
  rights_evidence_id: "test-only-not-commercial-clearance", quality_review: "approved", quality_evidence_id: "test-only-not-face-quality" };
const command = (key: string, payload: unknown) => ({ principal: { actorId: "test-synthetic", displayName: "Synthetic test" },
  traceId: "trace-face-test", idempotencyKey: key, requestHash: requestDigest(payload) });
const down = () => readFile(new URL("../../migrations/rollback/0025_image_face_jobs.sql", import.meta.url), "utf8");

async function fixture(connection: Pool) {
  const suffix = randomUUID().slice(0, 8); const guest = `guest-face-${suffix}`; const upload = `upload-face-${suffix}`;
  const scope = { ownerKind: "guest" as const, ownerScope: guest, guestSessionId: guest };
  const sha = "1".repeat(64);
  await connection.query("INSERT INTO guest_sessions(guest_session_id,token_hash,expires_at,created_at) VALUES($1,$2,now()+interval '1 day',now())",
    [guest, createHash("sha256").update(guest).digest("hex")]);
  await connection.query(`INSERT INTO upload_sessions(upload_session_id,owner_kind,guest_session_id,display_name,
    expected_media_type,expected_byte_size,bytes_received,state,constraints,upload_token_hash,upload_token_expires_at,
    quarantine_object_key,immutable_object_key,immutable_provider_generation,source_version_id,source_facts,created_at,expires_at,updated_at,transfer_provider)
    VALUES($1,'guest',$2,'owned-synthetic.png','image/png',100,100,'ready','{}',$3,now()+interval '1 hour',$4,$5,$8,$6,$7,now(),now()+interval '1 day',now(),'local_api')`,
  [upload, guest, sha, `quarantine/${guest}/${upload}`, `immutable/${guest}/${sha}`, `source-${suffix}`, { sha256: sha }, sha]);
  const ordinary = new PostgresImageQualityRepository(connection, new SystemRuntimeValues());
  const base = (await ordinary.create(command(`base-${suffix}`, {}), { owner: scope, uploadSessionId: upload,
    sourceVersionId: `source-${suffix}`, sourceObjectKey: `immutable/${guest}/${sha}`, sourceStorageGeneration: sha,
    sourceSha256: sha, sourceMediaType: "image/png", sourceByteSize: 100, sourceWidth: 8, sourceHeight: 6, sourceFrameCount: 1,
    sourceBitDepth: 8, sourceHasIccProfile: false, sourceColourPrimaries: "srgb", sourceDynamicRange: "sdr",
    contentClass: "photo", strength: 80, expiresAt: new Date(Date.now()+86400000).toISOString() })).value;
  await connection.query(`UPDATE image_quality_requests SET state='succeeded',output_object_key=$1,
    output_storage_generation=$4,output_sha256=$2,output_media_type='image/png',output_byte_size=120,
    output_width=8,output_height=6,output_frame_count=1,output_bit_depth=8,output_has_icc_profile=false,
    output_colour_policy='synthetic-only',model_id='owned-synthetic',model_version='1',model_sha256=$2,
    model_usage='deterministic',deterministic=true,processor_name='synthetic-test',processor_version='1',output_fidelity='{}'
    WHERE image_quality_request_id=$3`, [`derivative/${guest}/synthetic/base.png`, "b".repeat(64), base.image_quality_request_id, "b".repeat(64)]);
  await connection.query("UPDATE processing_jobs SET state='succeeded' WHERE job_id=$1", [base.job_id]);
  const intent = { contract_version: "image-quality-face-v1" as const, base_image_quality_request_id: base.image_quality_request_id,
    source_sha256: sha, base_output_sha256: "b".repeat(64), allow_reconstructed_face_detail: true as const,
    fidelity_permyriad: 8000, candidate_count: 2 as const };
  return { scope, upload, base, intent };
}
function identity(candidate: StoredNativeFaceCandidate["candidate"]) {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])) : value;
  return createHash("sha256").update(JSON.stringify(["ipw-native-face-candidate-v1", canonical(candidate)])).digest("hex");
}

test("face migration applies idempotently and rollback restores exact old target constraints", async () => {
  const connection = pool();
  try {
    await runMigrations(connection); await runMigrations(connection);
    const old = (await connection.query("SELECT * FROM image_face_migration_backup")).rows[0];
    await connection.query(await down());
    const restored = await connection.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='processing_jobs'::regclass AND conname IN ('processing_jobs_kind_check','processing_jobs_target_check')");
    for (const row of restored.rows) assert.equal(row.definition, row.conname === "processing_jobs_kind_check" ? old.kind_check : old.target_check);
    assert.equal((await connection.query("SELECT pg_get_indexdef('processing_jobs_upload_session_unique_idx'::regclass) AS definition")).rows[0].definition, old.upload_index);
    await runMigrations(connection); await runMigrations(connection);
    assert.equal((await connection.query("SELECT * FROM schema_migrations WHERE version='0025_image_face_jobs'")).rowCount, 1);
  } finally { await connection.end(); }
});

test("durable face creation, exact review, ownership, retry and cancellation do not mutate ordinary output", async () => {
  const connection = pool(); const runtime = new SystemRuntimeValues();
  const repo = new PostgresFaceQualityRepository(connection, runtime);
  try {
    const sample = await fixture(connection); const other = await fixture(connection);
    const { scope, upload, intent } = sample;
    const key = `face-${randomUUID()}`;
    for (const invalid of [{ ...release, commercial_rights: "pending" as const }, { ...release, quality_evidence_id: null }]) {
      assert.throws(() => requireFaceRelease(invalid), (error: unknown) => error instanceof DomainError && error.status === 503);
    }
    const copies = await Promise.all(Array.from({length:8},()=>repo.createCandidates(command(key,intent),scope,upload,intent,release)));
    const value = copies[0].value; assert.equal(new Set(copies.map(item=>item.value.job_id)).size,1);
    assert.equal(copies.filter(item=>!item.replayed).length,1);
    assert.equal((await connection.query("SELECT * FROM job_outbox WHERE job_id=$1",[value.job_id])).rowCount,1);
    assert.equal(await repo.get(other.scope,upload,value.face_quality_job_id),null);
    await assert.rejects(repo.createCandidates(command(key,{different:true}),scope,upload,intent,release), /different face work/);
    await assert.rejects(repo.createCandidates(command(`foreign-${key}`,intent),other.scope,upload,intent,release), /not found/);
    const view = await repo.get(scope,upload,value.face_quality_job_id);
    assert.ok(view && !JSON.stringify(view).includes("object_key") && !JSON.stringify(view).includes("rights_evidence_id"));
    const review: FaceQualityCompositionIntent = { contract_version:"image-quality-face-v1",candidate_request_id:value.face_quality_job_id,
      candidate_sha256:"f".repeat(64),source_sha256:intent.source_sha256,base_output_sha256:intent.base_output_sha256,
      allow_reconstructed_face_detail:true,acknowledged_possible_identity_change:true };
    await assert.rejects(repo.createComposition(command(`review-${key}`,review),scope,upload,review,release), /completed face candidates/);
    assert.throws(()=>parseFaceQualityCompositionIntent({...review,acknowledged_possible_identity_change:1}));
    assert.throws(()=>parseFaceQualityCompositionIntent({...review,pixels:[1,2,3]}));
    for (let ordinal=0;ordinal<2;ordinal++) {
      const context = {source_sha256:intent.source_sha256,base_output_sha256:intent.base_output_sha256,
        source_width:8,source_height:6,output_width:8,output_height:6,bit_depth:8 as const,colour_authority_sha256:"d".repeat(64)};
      const candidate = {candidate_id:`test-owned-${ordinal}`,context,model_sha256:release.model_sha256,
        dependency_lock_sha256:release.dependency_lock_sha256,fidelity_permyriad:6500+ordinal*1000,
        region:{x:1,y:1,width:2,height:2},pixels_sha256:"e".repeat(64),mask_sha256:"f".repeat(64)};
      const stored: StoredNativeFaceCandidate = {candidate,pixels:{owner_scope:scope.ownerScope,
        object_key:`derivative/${scope.ownerScope}/synthetic/pixels`,generation:"1",sha256:candidate.pixels_sha256,byte_size:16},
        mask:{owner_scope:scope.ownerScope,object_key:`derivative/${scope.ownerScope}/synthetic/mask`,generation:"1",sha256:candidate.mask_sha256,byte_size:4}};
      const digest = identity(candidate);
      await connection.query("INSERT INTO face_quality_candidates VALUES($1,$2,$3,$4,now())",[value.face_quality_job_id,digest,ordinal,stored]);
      if (ordinal===0) review.candidate_sha256=digest;
    }
    await connection.query("UPDATE processing_jobs SET state='succeeded',progress_percent=100 WHERE job_id=$1",[value.job_id]);
    await assert.rejects(connection.query("UPDATE processing_jobs SET kind='image_face_compose' WHERE job_id=$1",[value.job_id]), /operation and target/);
    await assert.rejects(connection.query("UPDATE face_quality_jobs SET intent='{}' WHERE face_quality_job_id=$1",[value.face_quality_job_id]), /immutable/);
    await assert.rejects(repo.createComposition(command(`stale-${key}`,review),scope,upload,{...review,candidate_sha256:"0".repeat(64)},release), /not found/);
    const composed = await repo.createComposition(command(`review-${key}`,review),scope,upload,review,release);
    const common = new PostgresDurableJobRepository(connection);
    await assert.rejects(common.requestCancel(composed.value.job_id,scope,runtime.now(),"trace-face-test"), /source-bound face/);
    await connection.query("UPDATE processing_jobs SET progress_percent=45 WHERE job_id=$1",[composed.value.job_id]);
    const cancelled = (await repo.cancel(scope,upload,composed.value.face_quality_job_id,"trace-face-test"))!;
    assert.equal(cancelled.state,"cancelled"); assert.equal(cancelled.progress_percent,45);
    assert.equal((await connection.query("SELECT progress_percent FROM job_events WHERE job_id=$1 AND state='cancelled'",[composed.value.job_id])).rows[0].progress_percent,45);
    assert.equal(await repo.delivery(other.scope,upload,composed.value.face_quality_job_id),null);
    await connection.query("UPDATE processing_jobs SET state='failed',failure=$2 WHERE job_id=$1",[composed.value.job_id,{retryable:true}]);
    const retryKey = `retry-${key}`;
    const retries = await Promise.all(Array.from({length:4},()=>repo.retry(command(retryKey,{id:composed.value.face_quality_job_id}),scope,upload,composed.value.face_quality_job_id,release)));
    assert.equal(retries.filter(item=>!item.replayed).length,1);
    assert.equal(retries[0].value.progress_percent,45);
    assert.equal((await connection.query("SELECT progress_percent FROM job_events WHERE job_id=$1 AND state='queued' ORDER BY occurred_at DESC LIMIT 1",[composed.value.job_id])).rows[0].progress_percent,45);
    assert.equal((await connection.query("SELECT max_attempts FROM processing_jobs WHERE job_id=$1",[composed.value.job_id])).rows[0].max_attempts,4);
    assert.equal((await connection.query("SELECT output_sha256,state FROM image_quality_requests WHERE image_quality_request_id=$1",[sample.base.image_quality_request_id])).rows[0].output_sha256,intent.base_output_sha256);
    assert.equal((await connection.query("SELECT state FROM upload_sessions WHERE upload_session_id=$1",[upload])).rows[0].state,"ready");
    const client = await connection.connect();
    try { await assert.rejects(client.query(await down()), /refuses to delete customer work/); }
    finally { await client.query("ROLLBACK");client.release(); }
    assert.equal((await repo.get(scope,upload,composed.value.face_quality_job_id))!.state,"queued");
  } finally { await connection.end(); }
});
