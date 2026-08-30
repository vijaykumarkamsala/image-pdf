import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { DomainError } from "../src/kernel/errors.js";
import { PostgresIntakeRepository } from "../src/domains/intake/postgres-intake.repository.js";
import { PostgresGuestHandoffRepository } from "../src/domains/intake/guest-handoff.repository.js";
import { PostgresDurableJobRepository } from "../src/domains/jobs/postgres-durable-job.repository.js";
import { runMigrations } from "../src/kernel/migrations.js";
import { PostgresProductKernelRepository } from "../src/kernel/postgres.repository.js";
import type { CommandContext } from "../src/kernel/product.types.js";
import { DeterministicRuntimeValues, requestDigest } from "../src/kernel/runtime.js";

const connectionString = process.env["IPW_TEST_DATABASE_URL"];

function context(actorId: string, key: string, command: string, payload: unknown): CommandContext {
  return {
    principal: { actorId, displayName: actorId === "actor-pg" ? "Postgres actor" : "Other actor" },
    idempotencyKey: key,
    traceId: "trace-postgres",
    requestHash: requestDigest({ command, payload }),
  };
}

test(
  "PostgreSQL 17 runs all Product V2 migrations and the Recovery 2B repository journey",
  { skip: !connectionString },
  async () => {
    assert.ok(connectionString);
    const pool = new Pool({ connectionString });
    const repository = new PostgresProductKernelRepository(pool, new DeterministicRuntimeValues());
    try {
      await runMigrations(pool);
      await runMigrations(pool);
      const version = await pool.query<{ server_version_num: string }>("SHOW server_version_num");
      assert.equal(Math.floor(Number(version.rows[0].server_version_num) / 10000), 17);

      const bootstrapPayload = {};
      const first = await repository.bootstrap(context("actor-pg", "bootstrap-pg", "session.bootstrap", bootstrapPayload));
      const replay = await repository.bootstrap(context("actor-pg", "bootstrap-pg", "session.bootstrap", bootstrapPayload));
      assert.equal(replay.replayed, true);
      assert.equal(replay.workspace.workspace_id, first.workspace.workspace_id);
      assert.equal(replay.defaultFiles.default_files_id, first.defaultFiles.default_files_id);

      const projectInput = { name: "PostgreSQL proof" };
      const project = await repository.createProject(
        context("actor-pg", "project-pg", "project.create", {
          workspaceId: first.workspace.workspace_id,
          ...projectInput,
        }),
        first.workspace.workspace_id,
        projectInput,
      );
      const fileInput = {
        displayName: "proof.png",
        objectKey: "postgres/proof.png",
        sha256: "a".repeat(64),
        mediaType: "image/png",
        byteSize: 4096,
      };
      const registered = await repository.registerFile(
        context("actor-pg", "file-pg", "file.register", {
          workspaceId: first.workspace.workspace_id,
          ...fileInput,
        }),
        first.workspace.workspace_id,
        fileInput,
      );
      const referenceInput = { ownerKind: "project" as const, ownerId: project.value.project_id, purpose: "cover" };
      await repository.addFileReference(
        context("actor-pg", "reference-pg", "file.reference.add", {
          workspaceId: first.workspace.workspace_id,
          fileId: registered.file.file_id,
          ...referenceInput,
        }),
        first.workspace.workspace_id,
        registered.file.file_id,
        referenceInput,
      );
      const moveInput = { kind: "project" as const, projectId: project.value.project_id };
      const moved = await repository.moveFile(
        context("actor-pg", "move-pg", "file.move", {
          workspaceId: first.workspace.workspace_id,
          fileId: registered.file.file_id,
          ...moveInput,
        }),
        first.workspace.workspace_id,
        registered.file.file_id,
        moveInput,
      );
      assert.equal(moved.value.asset_original_id, registered.original.asset_original_id);
      assert.equal(moved.value.current_source_version_id, registered.sourceVersion.source_version_id);

      const sourceInput = {
        objectKey: "postgres/proof-v2.png",
        sha256: "b".repeat(64),
        mediaType: "image/png",
        byteSize: 4200,
      };
      const source = await repository.registerSourceVersion(
        context("actor-pg", "source-pg", "file.source.register", {
          workspaceId: first.workspace.workspace_id,
          fileId: registered.file.file_id,
          ...sourceInput,
        }),
        first.workspace.workspace_id,
        registered.file.file_id,
        sourceInput,
      );
      assert.equal(source.file.asset_original_id, registered.original.asset_original_id);
      assert.equal(source.sourceVersion.previous_source_version_id, registered.sourceVersion.source_version_id);

      const references = await repository.listFileReferences(
        "actor-pg",
        first.workspace.workspace_id,
        registered.file.file_id,
      );
      assert.equal(references.length, 1);
      assert.equal(references[0].owner_id, project.value.project_id);

      const other = await repository.bootstrap(
        context("actor-other", "bootstrap-other", "session.bootstrap", bootstrapPayload),
      );
      assert.notEqual(other.workspace.workspace_id, first.workspace.workspace_id);
      await assert.rejects(
        repository.listFiles("actor-other", first.workspace.workspace_id),
        (error: unknown) => error instanceof DomainError && error.code === "access-denied",
      );

      const usage = await repository.listUsageEvents("actor-pg", first.workspace.workspace_id);
      assert.ok(usage.length >= 5);
      assert.ok(usage.every((event) => event.customer_amount === "0.00" && event.credit_debit === 0));
      const dimensions = await pool.query("SELECT dimensions FROM usage_admin_dimensions");
      assert.ok(dimensions.rowCount && dimensions.rowCount >= usage.length);

      await assert.rejects(
        pool.query("UPDATE asset_originals SET original_filename = 'mutated' WHERE asset_original_id = $1", [
          registered.original.asset_original_id,
        ]),
        /immutable/,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO usage_events(usage_event_id, workspace_id, actor_id, event_kind,
           customer_amount, credit_debit, currency, occurred_at) VALUES ('usage-invalid', $1, $2, 'invalid', 1, 0, 'USD', now())`,
          [first.workspace.workspace_id, "actor-pg"],
        ),
        /check constraint/,
      );

      const intake = new PostgresIntakeRepository(pool);
      await intake.createGuest(
        { schema_version: "1.8.0", guest_session_id: "guest-pg", expires_at: "2026-08-31T00:00:00.000Z" },
        "c".repeat(64),
        "2026-08-30T00:00:00.000Z",
      );
      assert.equal(
        (await intake.findGuest("c".repeat(64), "2026-08-30T00:00:00.000Z"))?.guest_session_id,
        "guest-pg",
      );
      const uploadRecord = {
        schema_version: "1.8.0" as const,
        upload_session_id: "upload-pg",
        owner_kind: "actor" as const,
        workspace_id: first.workspace.workspace_id,
        actor_id: "actor-pg",
        guest_session_id: null,
        display_name: "postgres.png",
        expected_media_type: "image/png",
        expected_byte_size: 4,
        bytes_received: 0,
        state: "initiated" as const,
        constraints: {
          schema_version: "1.8.0" as const,
          allowed_media_types: ["image/png"],
          max_bytes: 4,
          max_pixels: 100,
          max_pages: 1,
        },
        job_id: null,
        asset_original_id: null,
        source_version_id: null,
        file_id: null,
        source_facts: null,
        failure: null,
        created_at: "2026-08-30T00:00:00.000Z",
        expires_at: "2026-08-31T00:00:00.000Z",
        updated_at: "2026-08-30T00:00:00.000Z",
      };
      const storedUpload = {
        record: uploadRecord,
        quarantineRef: {
          ownerScope: first.workspace.workspace_id,
          objectKey: `quarantine/${first.workspace.workspace_id}/upload-pg`,
          zone: "quarantine" as const,
        },
        uploadTokenHash: "d".repeat(64),
        uploadTokenExpiresAt: "2026-08-30T01:00:00.000Z",
      };
      const command = {
        ownerScope: first.workspace.workspace_id,
        idempotencyKey: "upload-pg-key",
        commandName: "upload.create",
        requestHash: "e".repeat(64),
      };
      const createdUpload = await intake.createUpload(storedUpload, command, uploadRecord.created_at);
      const replayedUpload = await intake.createUpload(storedUpload, command, uploadRecord.created_at);
      assert.equal(createdUpload.replayed, false);
      assert.equal(replayedUpload.replayed, true);
      assert.equal(
        await intake.findUpload("upload-pg", {
          ownerKind: "actor",
          ownerScope: other.workspace.workspace_id,
          workspaceId: other.workspace.workspace_id,
          actorId: "actor-other",
        }),
        null,
      );
      const uploaded = await intake.recordUploadedBytes(
        "upload-pg",
        "d".repeat(64),
        4,
        "2026-08-30T00:05:00.000Z",
      );
      assert.equal(uploaded.record.bytes_received, 4);
      await intake.cancelUpload(
        "upload-pg",
        {
          ownerKind: "actor",
          ownerScope: first.workspace.workspace_id,
          workspaceId: first.workspace.workspace_id,
          actorId: "actor-pg",
        },
        "2026-08-30T00:06:00.000Z",
      );
      await assert.rejects(
        pool.query("UPDATE upload_sessions SET bytes_received=3 WHERE upload_session_id='upload-pg'"),
        /terminal upload sessions are immutable/,
      );

      const jobUpload = {
        ...storedUpload,
        record: {
          ...uploadRecord,
          upload_session_id: "upload-job-pg",
          display_name: "job.png",
        },
        quarantineRef: {
          ...storedUpload.quarantineRef,
          objectKey: `quarantine/${first.workspace.workspace_id}/upload-job-pg`,
        },
        uploadTokenHash: "f".repeat(64),
      };
      await intake.createUpload(
        jobUpload,
        { ...command, idempotencyKey: "upload-job-pg-key", requestHash: "1".repeat(64) },
        uploadRecord.created_at,
      );
      await intake.recordUploadedBytes(
        "upload-job-pg",
        "f".repeat(64),
        4,
        "2026-08-30T00:05:00.000Z",
      );
      const durableJobs = new PostgresDurableJobRepository(pool);
      const jobRecord = {
        schema_version: "1.8.0" as const,
        job_id: "job-pg",
        kind: "file_intake_inspection" as const,
        owner_kind: "actor" as const,
        workspace_id: first.workspace.workspace_id,
        actor_id: "actor-pg",
        guest_session_id: null,
        upload_session_id: "upload-job-pg",
        state: "queued" as const,
        attempt: 0,
        max_attempts: 3,
        progress_percent: 0,
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        next_attempt_at: null,
        failure: null,
        created_at: "2026-08-30T00:06:00.000Z",
        updated_at: "2026-08-30T00:06:00.000Z",
      };
      const jobOwner = {
        ownerKind: "actor" as const,
        ownerScope: first.workspace.workspace_id,
        workspaceId: first.workspace.workspace_id,
        actorId: "actor-pg",
      };
      const jobCommand = {
        ownerScope: first.workspace.workspace_id,
        idempotencyKey: "finalise-job-pg",
        commandName: "upload.finalise",
        requestHash: "2".repeat(64),
      };
      const durable = await durableJobs.createForUpload(
        "upload-job-pg",
        jobOwner,
        jobRecord,
        jobCommand,
        "trace-postgres-job",
      );
      assert.equal(durable.upload.state, "finalising");
      assert.equal(durable.job.state, "queued");
      assert.equal((await durableJobs.createForUpload(
        "upload-job-pg", jobOwner, jobRecord, jobCommand, "trace-postgres-job"
      )).replayed, true);
      assert.equal((await durableJobs.pendingOutbox("2026-08-30T00:06:00.000Z", 10)).length, 1);
      const claim = await durableJobs.claim(
        "worker-pg",
        "lease-token-pg",
        "3".repeat(64),
        "2026-08-30T00:07:00.000Z",
        "2026-08-30T00:08:00.000Z",
        "trace-postgres-job",
      );
      assert.equal(claim?.job.attempt, 1);
      const running = await durableJobs.start(
        "job-pg", "3".repeat(64), "2026-08-30T00:07:10.000Z", "trace-postgres-job"
      );
      assert.equal(running.state, "running");
      await durableJobs.heartbeat(
        "job-pg", "3".repeat(64), "2026-08-30T00:07:20.000Z", "2026-08-30T00:09:00.000Z"
      );
      await durableJobs.checkpoint(
        "job-pg", "3".repeat(64), "header", { media_type: "image/png" }, "2026-08-30T00:07:30.000Z"
      );
      const retry = await durableJobs.fail(
        "job-pg",
        "3".repeat(64),
        { schema_version: "1.8.0", code: "scanner-unavailable", message: "Scanner unavailable", retryable: true },
        "2026-08-30T00:07:40.000Z",
        "2026-08-30T00:10:00.000Z",
        "trace-postgres-job",
      );
      assert.equal(retry.state, "retry_wait");
      const secondClaim = await durableJobs.claim(
        "worker-pg",
        "lease-token-pg-2",
        "4".repeat(64),
        "2026-08-30T00:10:00.000Z",
        "2026-08-30T00:11:00.000Z",
        "trace-postgres-job",
      );
      assert.equal(secondClaim?.job.attempt, 2);
      const cancelRequested = await durableJobs.requestCancel(
        "job-pg", jobOwner, "2026-08-30T00:10:10.000Z", "trace-postgres-job"
      );
      assert.equal(cancelRequested.state, "cancel_requested");
      const jobEvents = await durableJobs.listEvents("job-pg", jobOwner, 0, 20);
      assert.deepEqual(
        jobEvents.map((event) => event.event_kind),
        ["job.queued", "job.leased", "job.started", "job.retry-scheduled", "job.leased", "job.cancel-requested"],
      );

      const acceptedUpload = {
        ...jobUpload,
        record: { ...jobUpload.record, upload_session_id: "upload-accepted-pg", display_name: "accepted.png" },
        quarantineRef: {
          ...jobUpload.quarantineRef,
          objectKey: `quarantine/${first.workspace.workspace_id}/upload-accepted-pg`,
        },
        uploadTokenHash: "5".repeat(64),
      };
      await intake.createUpload(
        acceptedUpload,
        { ...command, idempotencyKey: "upload-accepted-pg-key", requestHash: "6".repeat(64) },
        uploadRecord.created_at,
      );
      await intake.recordUploadedBytes(
        "upload-accepted-pg",
        "5".repeat(64),
        4,
        "2026-08-30T00:11:00.000Z",
      );
      const acceptedJob = {
        ...jobRecord,
        job_id: "job-accepted-pg",
        upload_session_id: "upload-accepted-pg",
        created_at: "2026-08-30T00:11:10.000Z",
        updated_at: "2026-08-30T00:11:10.000Z",
      };
      await durableJobs.createForUpload(
        "upload-accepted-pg",
        jobOwner,
        acceptedJob,
        { ...jobCommand, idempotencyKey: "finalise-accepted-pg", requestHash: "7".repeat(64) },
        "trace-postgres-accepted",
      );
      const acceptedClaim = await durableJobs.claim(
        "worker-pg",
        "lease-token-accepted",
        "8".repeat(64),
        "2026-08-30T00:11:20.000Z",
        "2026-08-30T00:12:20.000Z",
        "trace-postgres-accepted",
      );
      assert.equal(acceptedClaim?.job.job_id, "job-accepted-pg");
      await durableJobs.start(
        "job-accepted-pg",
        "8".repeat(64),
        "2026-08-30T00:11:30.000Z",
        "trace-postgres-accepted",
      );
      const sourceFacts = {
        schema_version: "1.8.0" as const,
        sha256: "9".repeat(64),
        detected_media_type: "image/png",
        byte_size: 4,
        width: 1,
        height: 1,
        megapixels_milli: 0,
        orientation: null,
        frame_count: 1,
        page_count: null,
        has_alpha: true,
        bit_depth: 8,
        has_icc_profile: false,
        sensitive_metadata: [],
        malware_scan_state: "clean" as const,
      };
      const acceptedCompletion = await durableJobs.completeAccepted(
        "job-accepted-pg",
        "8".repeat(64),
        {
          objectReferenceId: "object-accepted-pg",
          assetOriginalId: "asset-accepted-pg",
          sourceVersionId: "source-accepted-pg",
          fileId: "file-accepted-pg",
          immutableObjectKey: `immutable/${first.workspace.workspace_id}/${sourceFacts.sha256}`,
          facts: sourceFacts,
        },
        "2026-08-30T00:11:40.000Z",
        "trace-postgres-accepted",
      );
      assert.equal(acceptedCompletion.upload.state, "ready");
      assert.equal(acceptedCompletion.job.state, "succeeded");
      assert.equal(acceptedCompletion.upload.asset_original_id, "asset-accepted-pg");
      const acceptedFiles = await repository.listFiles("actor-pg", first.workspace.workspace_id);
      assert.ok(acceptedFiles.some((file) => file.file_id === "file-accepted-pg"));
      const intakeUsage = await repository.listUsageEvents("actor-pg", first.workspace.workspace_id);
      assert.ok(intakeUsage.some((event) => event.event_kind === "file.intake-ready"));
      assert.ok(intakeUsage.every((event) => event.customer_amount === "0.00" && event.credit_debit === 0));

      const guestReadyUpload = {
        ...acceptedUpload,
        record: {
          ...acceptedUpload.record,
          upload_session_id: "upload-guest-ready-pg",
          owner_kind: "guest" as const,
          workspace_id: null,
          actor_id: null,
          guest_session_id: "guest-pg",
          display_name: "guest-ready.png",
        },
        quarantineRef: {
          ownerScope: "guest-pg",
          objectKey: "quarantine/guest-pg/upload-guest-ready-pg",
          zone: "quarantine" as const,
        },
        uploadTokenHash: "a".repeat(64),
      };
      await intake.createUpload(
        guestReadyUpload,
        { ownerScope: "guest-pg", idempotencyKey: "upload-guest-ready", commandName: "upload.create", requestHash: "b".repeat(64) },
        uploadRecord.created_at,
      );
      await intake.recordUploadedBytes(
        "upload-guest-ready-pg",
        "a".repeat(64),
        4,
        "2026-08-30T00:12:00.000Z",
      );
      const guestJob = {
        ...jobRecord,
        job_id: "job-guest-ready-pg",
        owner_kind: "guest" as const,
        workspace_id: null,
        actor_id: null,
        guest_session_id: "guest-pg",
        upload_session_id: "upload-guest-ready-pg",
        created_at: "2026-08-30T00:12:10.000Z",
        updated_at: "2026-08-30T00:12:10.000Z",
      };
      const guestOwner = { ownerKind: "guest" as const, ownerScope: "guest-pg", guestSessionId: "guest-pg" };
      await durableJobs.createForUpload(
        "upload-guest-ready-pg",
        guestOwner,
        guestJob,
        { ownerScope: "guest-pg", idempotencyKey: "finalise-guest-ready", commandName: "upload.finalise", requestHash: "c".repeat(64) },
        "trace-postgres-guest",
      );
      const guestClaim = await durableJobs.claim(
        "worker-pg",
        "lease-token-guest",
        "d".repeat(64),
        "2026-08-30T00:12:20.000Z",
        "2026-08-30T00:13:20.000Z",
        "trace-postgres-guest",
      );
      assert.equal(guestClaim?.job.job_id, "job-guest-ready-pg");
      await durableJobs.start(
        "job-guest-ready-pg",
        "d".repeat(64),
        "2026-08-30T00:12:30.000Z",
        "trace-postgres-guest",
      );
      const guestCompletion = await durableJobs.completeAccepted(
        "job-guest-ready-pg",
        "d".repeat(64),
        {
          objectReferenceId: "object-guest-unused",
          assetOriginalId: "asset-guest-preserved",
          sourceVersionId: "source-guest-preserved",
          fileId: null,
          immutableObjectKey: `immutable/guest-pg/${sourceFacts.sha256}`,
          facts: sourceFacts,
        },
        "2026-08-30T00:12:40.000Z",
        "trace-postgres-guest",
      );
      assert.equal(guestCompletion.upload.file_id, null);
      const handoffs = new PostgresGuestHandoffRepository(pool);
      const handedOff = await handoffs.handoff({
        uploadSessionId: "upload-guest-ready-pg",
        guestSessionId: "guest-pg",
        workspaceId: first.workspace.workspace_id,
        actorId: "actor-pg",
        objectReferenceId: "object-guest-handoff",
        assetOriginalId: "asset-guest-preserved",
        sourceVersionId: "source-guest-preserved",
        fileId: "file-guest-handoff",
        displayName: "guest-ready.png",
        immutableObjectKey: `immutable/${first.workspace.workspace_id}/${sourceFacts.sha256}`,
        sha256: sourceFacts.sha256,
        mediaType: sourceFacts.detected_media_type,
        byteSize: sourceFacts.byte_size,
        command: context("actor-pg", "handoff-guest-pg", "guest-source.handoff", {
          uploadSessionId: "upload-guest-ready-pg",
          workspaceId: first.workspace.workspace_id,
        }),
        now: "2026-08-30T00:12:50.000Z",
      });
      assert.equal(handedOff.fileId, "file-guest-handoff");
      const guestFile = (await repository.listFiles("actor-pg", first.workspace.workspace_id))
        .find((file) => file.file_id === handedOff.fileId);
      assert.equal(guestFile?.asset_original_id, "asset-guest-preserved");
      assert.equal(guestFile?.current_source_version_id, "source-guest-preserved");
    } finally {
      await repository.close();
    }
  },
);
