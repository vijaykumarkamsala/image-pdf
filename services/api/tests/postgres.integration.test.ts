import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import { Pool } from "pg";

import { DomainError } from "../src/kernel/errors.js";
import { PostgresIntakeRepository } from "../src/domains/intake/postgres-intake.repository.js";
import { PostgresGuestHandoffRepository } from "../src/domains/intake/guest-handoff.repository.js";
import { PostgresDurableJobRepository } from "../src/domains/jobs/postgres-durable-job.repository.js";
import { PostgresExperienceRepository } from "../src/domains/experience/postgres-experience.repository.js";
import { PostgresDocumentRepository } from "../src/domains/documents/postgres-document.repository.js";
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
  "PostgreSQL 17 runs all Product V2 migrations and the Recovery 2C repository journey",
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
      const customerUsage = await repository.customerUsageSummary("actor-pg", first.workspace.workspace_id);
      assert.ok(customerUsage.files >= 1);
      assert.ok(customerUsage.storage_bytes >= 4096);
      assert.doesNotMatch(JSON.stringify(customerUsage), /customer_amount|credit_debit|currency/i);

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
        { schema_version: PRODUCT_SCHEMA_VERSION, guest_session_id: "guest-pg", expires_at: "2026-08-31T00:00:00.000Z" },
        "c".repeat(64),
        "2026-08-30T00:00:00.000Z",
      );
      assert.equal(
        (await intake.findGuest("c".repeat(64), "2026-08-30T00:00:00.000Z"))?.guest_session_id,
        "guest-pg",
      );
      const uploadRecord = {
        schema_version: PRODUCT_SCHEMA_VERSION,
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
          schema_version: PRODUCT_SCHEMA_VERSION,
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
        transferProvider: "local_api" as const,
        protectedProviderSession: null,
        providerMetadata: null,
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

      const cleanupUploadId = `upload-cleanup-pg-${randomUUID()}`;
      const cleanupUpload = {
        ...storedUpload,
        record: {
          ...uploadRecord,
          upload_session_id: cleanupUploadId,
          display_name: "cleanup.png",
        },
        quarantineRef: {
          ...storedUpload.quarantineRef,
          objectKey: `quarantine/${first.workspace.workspace_id}/${cleanupUploadId}`,
        },
      };
      await intake.createUpload(
        cleanupUpload,
        { ...command, idempotencyKey: cleanupUploadId, requestHash: "9".repeat(64) },
        uploadRecord.created_at,
      );
      await intake.cancelUpload(
        cleanupUploadId,
        {
          ownerKind: "actor",
          ownerScope: first.workspace.workspace_id,
          workspaceId: first.workspace.workspace_id,
          actorId: "actor-pg",
        },
        "2026-08-30T00:06:00.000Z",
      );
      const claimedCleanup = await intake.claimCleanup(
        "cleanup-pg-a",
        "2026-08-30T00:07:00.000Z",
        "2026-08-30T00:08:00.000Z",
        100,
      );
      assert.ok(claimedCleanup.some((candidate) => candidate.uploadSessionId === cleanupUploadId));
      for (const candidate of claimedCleanup) {
        if (candidate.uploadSessionId !== cleanupUploadId) {
          await intake.releaseCleanup(candidate.uploadSessionId, "cleanup-pg-a");
        }
      }
      const concurrentCleanup = await intake.claimCleanup(
        "cleanup-pg-b",
        "2026-08-30T00:07:00.000Z",
        "2026-08-30T00:08:00.000Z",
        100,
      );
      assert.ok(concurrentCleanup.every((candidate) => candidate.uploadSessionId !== cleanupUploadId));
      for (const candidate of concurrentCleanup) {
        await intake.releaseCleanup(candidate.uploadSessionId, "cleanup-pg-b");
      }
      await intake.completeCleanup(cleanupUploadId, "cleanup-pg-a", "2026-08-30T00:07:10.000Z");
      const completedCleanup = await intake.claimCleanup(
        "cleanup-pg-c",
        "2026-08-30T00:09:00.000Z",
        "2026-08-30T00:10:00.000Z",
        100,
      );
      assert.ok(completedCleanup.every((candidate) => candidate.uploadSessionId !== cleanupUploadId));
      for (const candidate of completedCleanup) {
        await intake.releaseCleanup(candidate.uploadSessionId, "cleanup-pg-c");
      }

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
        schema_version: PRODUCT_SCHEMA_VERSION,
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
      assert.equal((await durableJobs.claimOutbox(
        "relay-pg",
        "2026-08-30T00:06:00.000Z",
        "2026-08-30T00:07:00.000Z",
        10,
      )).length, 1);
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
        { schema_version: PRODUCT_SCHEMA_VERSION, code: "scanner-unavailable", message: "Scanner unavailable", retryable: true },
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
      const repeatedCancel = await durableJobs.requestCancel(
        "job-pg", jobOwner, "2026-08-30T00:10:11.000Z", "trace-postgres-job"
      );
      assert.equal(repeatedCancel.state, "cancel_requested");
      const cancellationWon = await durableJobs.fail(
        "job-pg",
        "4".repeat(64),
        { schema_version: PRODUCT_SCHEMA_VERSION, code: "late-worker-error", message: "late", retryable: true },
        "2026-08-30T00:10:12.000Z",
        "2026-08-30T00:11:00.000Z",
        "trace-postgres-job",
      );
      assert.equal(cancellationWon.state, "cancelled");
      const jobEvents = await durableJobs.listEvents("job-pg", jobOwner, 0, 20);
      assert.deepEqual(
        jobEvents.map((event) => event.event_kind),
        [
          "job.queued",
          "job.leased",
          "job.started",
          "job.retry-scheduled",
          "job.leased",
          "job.cancel-requested",
          "job.cancelled",
        ],
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
        schema_version: PRODUCT_SCHEMA_VERSION,
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
      const intakeClassification = {
        schema_version: PRODUCT_SCHEMA_VERSION,
        upload_session_id: "upload-accepted-pg",
        inferred_category: "graphic" as const,
        evidence_label: "likely" as const,
        confidence_percent: null,
        evidence: ["The verified image includes an alpha channel."],
        customer_category: "document" as const,
        updated_at: "2026-08-30T00:11:45.000Z",
      };
      const classificationCommand = {
        ownerScope: first.workspace.workspace_id,
        idempotencyKey: "classification-pg",
        commandName: "intake.classification.correct",
        requestHash: "a".repeat(64),
      };
      const savedClassification = await intake.saveClassification(
        intakeClassification,
        jobOwner,
        classificationCommand,
        intakeClassification.updated_at,
      );
      const replayedClassification = await intake.saveClassification(
        intakeClassification,
        jobOwner,
        classificationCommand,
        intakeClassification.updated_at,
      );
      assert.equal(savedClassification.replayed, false);
      assert.equal(replayedClassification.replayed, true);
      assert.equal(savedClassification.classification.evidence_label, "likely");
      assert.equal(savedClassification.classification.confidence_percent, null);
      await assert.rejects(
        pool.query("UPDATE intake_classifications SET confidence_percent=42 WHERE upload_session_id=$1", ["upload-accepted-pg"]),
        /intake_numeric_confidence_unavailable/,
      );
      assert.equal(
        (await intake.findClassification("upload-accepted-pg", jobOwner))?.customer_category,
        "document",
      );
      const experience = new PostgresExperienceRepository(pool);
      const experienceHome = await experience.home(
        "actor-pg",
        first.workspace.workspace_id,
        "2026-08-30T00:12:00.000Z",
      );
      assert.ok(experienceHome.recentWork.some((item) => item.resource_id === "file-accepted-pg"));
      assert.ok(experienceHome.recentJobs.some((item) => item.job_id === "job-accepted-pg"));
      const experienceSearch = await experience.search(
        "actor-pg",
        first.workspace.workspace_id,
        "accepted",
        [],
        { projects: true, files: true, jobs: true, documents: true },
        undefined,
        10,
      );
      assert.ok(experienceSearch.results.some((item) => item.resource_id === "file-accepted-pg"));
      const projectedBeforeRead = await pool.query(
        "SELECT kind,source_key,resource_id FROM notifications WHERE workspace_id=$1 ORDER BY kind DESC",
        [first.workspace.workspace_id],
      );
      assert.deepEqual(
        projectedBeforeRead.rows
          .filter((row) => ["upload-accepted-pg", "job-accepted-pg"].includes(row.resource_id))
          .map((row) => row.kind),
        ["upload_accepted", "job_completed"],
      );
      assert.equal(
        new Set(projectedBeforeRead.rows.map((row) => row.source_key)).size,
        projectedBeforeRead.rows.length,
      );
      const experienceNotifications = await experience.notifications(
        "actor-pg",
        first.workspace.workspace_id,
        undefined,
        1,
      );
      assert.equal(experienceNotifications.notifications.length, 1);
      assert.ok(experienceNotifications.nextCursor);
      const notificationCommand = {
        name: "notification.read",
        idempotencyKey: "notification-pg-read",
        requestHash: "b".repeat(64),
      };
      assert.equal(await experience.markNotificationRead(
        "actor-pg",
        first.workspace.workspace_id,
        experienceNotifications.notifications[0].notification_id,
        "2026-08-30T00:12:10.000Z",
        notificationCommand,
      ), false);
      assert.equal(await experience.markNotificationRead(
        "actor-pg",
        first.workspace.workspace_id,
        experienceNotifications.notifications[0].notification_id,
        "2026-08-30T00:12:10.000Z",
        notificationCommand,
      ), true);
      const acceptedFiles = await repository.listFiles("actor-pg", first.workspace.workspace_id);
      assert.ok(acceptedFiles.some((file) => file.file_id === "file-accepted-pg"));
      const intakeUsage = await repository.listUsageEvents("actor-pg", first.workspace.workspace_id);
      assert.ok(intakeUsage.some((event) => event.event_kind === "file.intake-ready"));
      assert.ok(intakeUsage.every((event) => event.customer_amount === "0.00" && event.credit_debit === 0));

      const failedUpload = {
        ...acceptedUpload,
        record: {
          ...acceptedUpload.record,
          upload_session_id: "upload-manual-retry-pg",
          display_name: "manual-retry.png",
        },
        quarantineRef: {
          ...acceptedUpload.quarantineRef,
          objectKey: `quarantine/${first.workspace.workspace_id}/upload-manual-retry-pg`,
        },
        uploadTokenHash: "6".repeat(64),
      };
      await intake.createUpload(
        failedUpload,
        { ...jobCommand, idempotencyKey: "upload-manual-retry-pg", requestHash: "c".repeat(64) },
        failedUpload.record.created_at,
      );
      await intake.recordUploadedBytes(
        "upload-manual-retry-pg",
        "6".repeat(64),
        4,
        "2026-08-30T00:13:00.000Z",
      );
      const failedJob = {
        ...jobRecord,
        job_id: "job-manual-retry-pg",
        upload_session_id: "upload-manual-retry-pg",
        max_attempts: 1,
        created_at: "2026-08-30T00:13:10.000Z",
        updated_at: "2026-08-30T00:13:10.000Z",
      };
      await durableJobs.createForUpload(
        "upload-manual-retry-pg",
        jobOwner,
        failedJob,
        { ...jobCommand, idempotencyKey: "finalise-manual-retry-pg", requestHash: "d".repeat(64) },
        "trace-manual-retry-pg",
      );
      await durableJobs.claim(
        "worker-manual-retry-pg",
        "lease-manual-retry-pg",
        "7".repeat(64),
        "2026-08-30T00:13:20.000Z",
        "2026-08-30T00:14:20.000Z",
        "trace-manual-retry-pg",
      );
      await durableJobs.start(
        "job-manual-retry-pg",
        "7".repeat(64),
        "2026-08-30T00:13:30.000Z",
        "trace-manual-retry-pg",
      );
      const terminalFailure = await durableJobs.fail(
        "job-manual-retry-pg",
        "7".repeat(64),
        { schema_version: PRODUCT_SCHEMA_VERSION, code: "scanner-unavailable", message: "Scanner unavailable", retryable: true },
        "2026-08-30T00:13:40.000Z",
        "2026-08-30T00:14:00.000Z",
        "trace-manual-retry-pg",
      );
      assert.equal(terminalFailure.state, "failed");
      await assert.rejects(
        pool.query(
          `UPDATE upload_sessions SET state='finalising',failure=NULL,bytes_received=3,updated_at=$1
           WHERE upload_session_id='upload-manual-retry-pg'`,
          ["2026-08-30T00:13:45.000Z"],
        ),
        /invalid upload session transition: rejected -> finalising/,
      );
      const manualRetryCommand = {
        ownerScope: first.workspace.workspace_id,
        idempotencyKey: "manual-retry-pg",
        commandName: "job.retry",
        requestHash: "e".repeat(64),
      };
      const manualRetry = await durableJobs.retry(
        "job-manual-retry-pg",
        jobOwner,
        manualRetryCommand,
        "2026-08-30T00:13:50.000Z",
        "trace-manual-retry-pg",
      );
      const manualRetryReplay = await durableJobs.retry(
        "job-manual-retry-pg",
        jobOwner,
        manualRetryCommand,
        "2026-08-30T00:13:50.000Z",
        "trace-manual-retry-pg",
      );
      assert.equal(manualRetry.job.state, "queued");
      assert.equal(manualRetry.job.max_attempts, 2);
      assert.equal(manualRetryReplay.replayed, true);
      assert.equal((await intake.findUpload("upload-manual-retry-pg", jobOwner))?.record.state, "finalising");

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
      const handoffAudit = await repository.listAuditEvents("actor-pg", first.workspace.workspace_id);
      assert.ok(handoffAudit.some((event) => event.action === "guest-source.handed-off"
        && event.resource_id === handedOff.fileId));
      const handoffNotifications = await pool.query(
        "SELECT kind,resource_id FROM notifications WHERE workspace_id=$1 AND kind='guest_handoff_completed'",
        [first.workspace.workspace_id],
      );
      assert.deepEqual(handoffNotifications.rows, [{ kind: "guest_handoff_completed", resource_id: handedOff.fileId }]);
    } finally {
      await repository.close();
    }
  },
);

test(
  "PostgreSQL 17 persists native documents, optimistic revisions, leases and forward-only restore",
  { skip: !connectionString },
  async () => {
    assert.ok(connectionString);
    const pool = new Pool({ connectionString });
    const runtime = new DeterministicRuntimeValues("2026-08-31T08:00:00.000Z");
    for (let index = 0; index < 1000; index += 1) runtime.id("test-seed");
    const product = new PostgresProductKernelRepository(pool, runtime);
    const documents = new PostgresDocumentRepository(pool, runtime);
    try {
      await runMigrations(pool);
      const bootstrap = await product.bootstrap(context("actor-editor-pg", "editor-bootstrap-pg", "session.bootstrap", {}));
      const workspaceId = bootstrap.workspace.workspace_id;
      const createContext = context("actor-editor-pg", "editor-create-pg", "document.create", { name: "PostgreSQL canvas" });
      const created = await documents.create(createContext, {
        workspaceId,
        defaultFilesId: bootstrap.defaultFiles.default_files_id,
        name: "PostgreSQL canvas",
        intendedUse: "digital",
        intendedUseLabel: "Digital design",
        width: 800,
        height: 600,
      });
      const replay = await documents.create(createContext, {
        workspaceId,
        defaultFilesId: bootstrap.defaultFiles.default_files_id,
        name: "PostgreSQL canvas",
        intendedUse: "digital",
        intendedUseLabel: "Digital design",
        width: 800,
        height: 600,
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.value.document.document_id, created.value.document.document_id);

      const documentId = created.value.document.document_id;
      const leaseContext = context("actor-editor-pg", "editor-lease-pg", "document.lease.acquire", { documentId });
      const lease = await documents.acquireLease(leaseContext, workspaceId, documentId);
      const tokenHash = (await import("../src/domains/documents/document-model.js")).sha256(lease.lease_token);
      const mutation = {
        kind: "layer.add" as const,
        layer: {
          layer_id: "layer-pg-shape", artboard_id: created.value.snapshot.artboards[0].artboard_id,
          parent_layer_id: null, layer_type: "shape" as const, name: "PostgreSQL rectangle", order: 0,
          visible: true, locked: false, opacity: 1, blend_mode: "normal",
          transform: { x: 10, y: 20, width: 100, height: 80, rotation_degrees: 0, scale_x: 1, scale_y: 1, skew_x_degrees: 0, skew_y_degrees: 0, flip_x: false, flip_y: false },
          shared_style_ids: [], raster: null, vector: null, rich_text: null,
          shape: { shape: "rectangle" as const, fill: "#3559e0", stroke: null, stroke_width: 0, corner_radius: 4 },
          group: null, extension_payload: {},
        },
        properties: {},
      };
      const mutationContext = context("actor-editor-pg", "editor-mutate-pg", "document.mutate", { documentId, mutation });
      const changed = await documents.mutate(mutationContext, { workspaceId, documentId, baseRevision: 0, mutation, leaseTokenHash: tokenHash });
      assert.equal(changed.snapshot.revision, 1);

      let revision = changed.snapshot.revision;
      for (let index = 2; index <= 101; index += 1) {
        const command = context("actor-editor-pg", `editor-mutate-pg-${index}`, "document.mutate", { documentId, index });
        const next = await documents.mutate(command, {
          workspaceId,
          documentId,
          baseRevision: revision,
          mutation: { kind: "document.rename", properties: {} },
          leaseTokenHash: tokenHash,
        });
        revision = next.snapshot.revision;
        assert.equal(Boolean(next.checkpoint), index % 10 === 0);
      }
      const history = await pool.query(
        "SELECT MIN(history_position)::int AS minimum,MAX(history_position)::int AS maximum,COUNT(*)::int AS count FROM document_history_entries WHERE document_id=$1",
        [documentId],
      );
      assert.deepEqual(history.rows, [{ minimum: 1, maximum: 100, count: 100 }]);
      assert.equal(Number((await pool.query("SELECT history_cursor FROM editor_documents WHERE document_id=$1", [documentId])).rows[0]!["history_cursor"]), 100);

      const named = await documents.createVersion(
        context("actor-editor-pg", "editor-version-pg", "document.version", { documentId }),
        workspaceId, documentId, "PostgreSQL checkpoint",
      );
      const restored = await documents.restoreVersion(
        context("actor-editor-pg", "editor-restore-pg", "document.restore", { documentId }),
        workspaceId, documentId, created.value.document.current_version_id, tokenHash,
      );
      assert.equal(restored.value.snapshot.layers?.length, 0);
      assert.ok(restored.value.snapshot.revision > changed.snapshot.revision);
      const boundedAfterRestore = await pool.query(
        "SELECT MIN(history_position)::int AS minimum,MAX(history_position)::int AS maximum,COUNT(*)::int AS count FROM document_history_entries WHERE document_id=$1",
        [documentId],
      );
      assert.deepEqual(boundedAfterRestore.rows, [{ minimum: 1, maximum: 100, count: 100 }]);
      const versions = (await documents.get("actor-editor-pg", workspaceId, documentId))!.versions;
      assert.ok(versions.some((item) => item.document_version_id === named.value.document_version_id));
      assert.ok(versions.some((item) => item.kind === "restore"));

      const project = await product.createProject(
        context("actor-editor-pg", "editor-project-pg", "project.create", { workspaceId, name: "Design work" }),
        workspaceId,
        { name: "Design work" },
      );
      const sourceIdentity = {
        file: created.value.document.source_file_id,
        original: created.value.document.source_asset_original_id,
        version: created.value.document.source_version_id,
      };
      const moved = await documents.move(
        context("actor-editor-pg", "editor-move-pg", "document.move", { documentId, projectId: project.value.project_id }),
        workspaceId,
        documentId,
        project.value.project_id,
        bootstrap.defaultFiles.default_files_id,
      );
      assert.equal(moved.value.location.kind, "project");
      assert.deepEqual({
        file: moved.value.source_file_id,
        original: moved.value.source_asset_original_id,
        version: moved.value.source_version_id,
      }, sourceIdentity);
      const experience = new PostgresExperienceRepository(pool);
      assert.ok((await experience.home("actor-editor-pg", workspaceId, runtime.now())).recentWork
        .some((item) => item.kind === "native_document" && item.resource_id === documentId));
      assert.ok((await experience.search(
        "actor-editor-pg", workspaceId, "postgresql", [],
        { projects: true, files: true, jobs: true, documents: true }, undefined, 20,
      )).results.some((item) => item.kind === "native_document" && item.path.endsWith(`/studio/${documentId}`)));

      const persisted = new PostgresDocumentRepository(pool, runtime);
      assert.equal((await persisted.get("actor-editor-pg", workspaceId, documentId))!.snapshot.revision, restored.value.snapshot.revision);
      const applied = await pool.query("SELECT version FROM schema_migrations WHERE version='0014_recovery_2d_native_documents'");
      assert.equal(applied.rowCount, 1);
    } finally {
      await pool.end();
    }
  },
);

test(
  "PostgreSQL 17 scopes lease transitions to tenants and serialises takeover retries",
  { skip: !connectionString },
  async () => {
    assert.ok(connectionString);
    const pool = new Pool({ connectionString, max: 8 });
    const runtime = new DeterministicRuntimeValues("2026-09-01T08:00:00.000Z");
    for (let index = 0; index < 2000; index += 1) runtime.id("test-seed");
    const product = new PostgresProductKernelRepository(pool, runtime);
    const documents = new PostgresDocumentRepository(pool, runtime);
    try {
      await Promise.all([runMigrations(pool), runMigrations(pool)]);
      const owner = await product.bootstrap(context("actor-lease-owner-pg", "lease-owner-bootstrap", "session.bootstrap", {}));
      const outsider = await product.bootstrap(context("actor-lease-outsider-pg", "lease-outsider-bootstrap", "session.bootstrap", {}));
      await pool.query(
        `INSERT INTO actors(actor_id,display_name,created_at) VALUES
         ('actor-lease-peer-a','Lease peer A',now()),('actor-lease-peer-b','Lease peer B',now())
         ON CONFLICT(actor_id) DO NOTHING`,
      );
      const created = await documents.create(
        context("actor-lease-owner-pg", "lease-document-create", "document.create", { name: "Tenant lease proof" }),
        {
          workspaceId: owner.workspace.workspace_id,
          defaultFilesId: owner.defaultFiles.default_files_id,
          name: "Tenant lease proof",
          intendedUse: "digital",
          intendedUseLabel: "Digital design",
          width: 640,
          height: 480,
        },
      );
      const documentId = created.value.document.document_id;
      const held = await documents.acquireLease(
        context("actor-lease-owner-pg", "lease-document-acquire", "document.lease.acquire", { documentId }),
        owner.workspace.workspace_id,
        documentId,
      );
      const acquireReplay = await documents.acquireLease(
        context("actor-lease-owner-pg", "lease-document-acquire", "document.lease.acquire", { documentId }),
        owner.workspace.workspace_id,
        documentId,
      );
      assert.equal(acquireReplay.lease_token, held.lease_token);

      await assert.rejects(
        documents.requestTakeover(
          context("actor-lease-outsider-pg", "lease-guessed-id", "document.lease.takeover.request", { documentId }),
          outsider.workspace.workspace_id,
          documentId,
          "Guessed identifier",
        ),
        (error: unknown) => error instanceof DomainError && error.code === "document-not-found",
      );

      const requestAContext = context("actor-lease-peer-a", "lease-request-a", "document.lease.takeover.request", { documentId, reason: "A" });
      const requestBContext = context("actor-lease-peer-b", "lease-request-b", "document.lease.takeover.request", { documentId, reason: "B" });
      const [requestA, requestB] = await Promise.all([
        documents.requestTakeover(requestAContext, owner.workspace.workspace_id, documentId, "A"),
        documents.requestTakeover(requestBContext, owner.workspace.workspace_id, documentId, "B"),
      ]);
      assert.equal(requestA.status, "requested");
      assert.equal(requestB.status, "requested");
      assert.equal(
        (await documents.requestTakeover(requestAContext, owner.workspace.workspace_id, documentId, "A")).status,
        "requested",
      );

      const leaseEvents = await pool.query(
        `SELECT event_kind,actor_id FROM document_lease_events
         WHERE workspace_id=$1 AND document_id=$2 ORDER BY occurred_at,event_kind,actor_id`,
        [owner.workspace.workspace_id, documentId],
      );
      assert.equal(leaseEvents.rows.filter((row) => row.event_kind === "takeover_requested").length, 2);
      const notifications = await pool.query(
        "SELECT recipient_actor_id FROM notifications WHERE workspace_id=$1 AND resource_id=$2 AND kind='lease_takeover_requested'",
        [owner.workspace.workspace_id, documentId],
      );
      assert.ok(notifications.rows.every((row) => row.recipient_actor_id === "actor-lease-owner-pg"));

      const forced = await documents.forceTakeover(
        context("actor-lease-peer-a", "lease-force-a", "document.lease.takeover.force", { documentId, reason: "Owner-approved recovery" }),
        owner.workspace.workspace_id,
        documentId,
        "Owner-approved recovery",
      );
      assert.equal(forced.status, "acquired");
      assert.equal(forced.grant?.lease.actor_id, "actor-lease-peer-a");

      await pool.query(
        `CREATE OR REPLACE FUNCTION reject_editor_atomic_audit() RETURNS trigger AS $$
         BEGIN
           IF NEW.action='layer.add' AND NEW.resource_id='${documentId}' THEN
             RAISE EXCEPTION 'atomic audit proof';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql;
         CREATE TRIGGER reject_editor_atomic_audit_trigger BEFORE INSERT ON audit_events
         FOR EACH ROW EXECUTE FUNCTION reject_editor_atomic_audit();`,
      );
      try {
        const artboardId = created.value.snapshot.artboards[0].artboard_id;
        const mutation = {
          kind: "layer.add" as const,
          layer: {
            schema_version: PRODUCT_SCHEMA_VERSION,
            layer_id: "layer-atomic-proof",
            artboard_id: artboardId,
            parent_layer_id: null,
            layer_type: "shape" as const,
            name: "Atomic proof",
            order: 0,
            visible: true,
            locked: false,
            opacity: 1,
            blend_mode: "normal",
            transform: {
              schema_version: PRODUCT_SCHEMA_VERSION,
              x: 0, y: 0, width: 100, height: 100, rotation_degrees: 0,
              scale_x: 1, scale_y: 1, skew_x_degrees: 0, skew_y_degrees: 0,
              flip_x: false, flip_y: false,
            },
            shared_style_ids: [],
            raster: null,
            vector: null,
            rich_text: null,
            shape: {
              schema_version: PRODUCT_SCHEMA_VERSION,
              shape: "rectangle" as const,
              fill: "#3559e0",
              stroke: null,
              stroke_width: 0,
              corner_radius: 0,
            },
            group: null,
            extension_payload: {},
          },
          properties: {},
        };
        await assert.rejects(
          documents.mutate(
            context("actor-lease-peer-a", "lease-atomic-mutation", "document.mutate", { documentId, mutation }),
            {
              workspaceId: owner.workspace.workspace_id,
              documentId,
              baseRevision: 0,
              mutation,
              leaseTokenHash: (await import("../src/domains/documents/document-model.js")).sha256(forced.grant!.lease_token),
            },
          ),
          /atomic audit proof/,
        );
      } finally {
        await pool.query("DROP TRIGGER IF EXISTS reject_editor_atomic_audit_trigger ON audit_events");
        await pool.query("DROP FUNCTION IF EXISTS reject_editor_atomic_audit() ");
      }
      assert.equal((await documents.get("actor-lease-peer-a", owner.workspace.workspace_id, documentId))!.snapshot.revision, 0);
      assert.equal(
        Number((await pool.query("SELECT count(*)::int AS count FROM document_operations WHERE document_id=$1", [documentId])).rows[0].count),
        0,
      );

      const audit = await pool.query(
        "SELECT action FROM audit_events WHERE workspace_id=$1 AND resource_id=$2 ORDER BY occurred_at",
        [owner.workspace.workspace_id, documentId],
      );
      assert.ok(audit.rows.some((row) => row.action === "document.lease.takeover-requested"));
      assert.ok(audit.rows.some((row) => row.action === "document.lease.force-takeover"));
      const usage = await pool.query(
        "SELECT customer_amount,credit_debit FROM usage_events WHERE workspace_id=$1",
        [owner.workspace.workspace_id],
      );
      assert.ok(usage.rows.every((row) => Number(row.customer_amount) === 0 && row.credit_debit === 0));
    } finally {
      await pool.end();
    }
  },
);
