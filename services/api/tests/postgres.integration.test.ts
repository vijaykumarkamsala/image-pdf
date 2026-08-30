import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { DomainError } from "../src/kernel/errors.js";
import { PostgresIntakeRepository } from "../src/domains/intake/postgres-intake.repository.js";
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
  "PostgreSQL 17 runs migrations and the Recovery 2A repository journey",
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
    } finally {
      await repository.close();
    }
  },
);
