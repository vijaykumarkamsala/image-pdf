import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { Pool } from "pg";

export const POSTGRESQL_MAJOR = 17;
export const MIGRATION_VERSIONS = [
  "0001_recovery_2a_product_kernel",
  "0002_recovery_2b_upload_sessions",
  "0003_recovery_2b_durable_jobs",
  "0004_recovery_2b_guest_handoffs",
  "0005_recovery_2b_gcs_integrity",
  "0006_recovery_2b_durable_dispatch",
  "0007_recovery_2b_durable_cleanup",
  "0008_recovery_2c_intake_classification",
  "0009_recovery_2c_experience",
  "0010_recovery_2c_manual_retry",
  "0011_recovery_2c_auth_sessions",
  "0012_recovery_2c_transactional_notifications",
  "0013_recovery_2c_truthful_intake",
] as const;

export async function runMigrations(pool: Pool): Promise<void> {
  const version = await pool.query<{ server_version_num: string }>("SHOW server_version_num");
  const major = Math.floor(Number(version.rows[0]?.server_version_num ?? 0) / 10000);
  if (major !== POSTGRESQL_MAJOR) {
    throw new Error(`PostgreSQL ${POSTGRESQL_MAJOR} is required; connected to major ${major || "unknown"}`);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  for (const versionName of MIGRATION_VERSIONS) {
    const existing = await pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    if (existing.rows[0]?.present) {
      const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [versionName]);
      if (applied.rowCount) continue;
    }
    const migration = resolve(here, "..", "..", "..", "migrations", `${versionName}.sql`);
    await pool.query(await readFile(migration, "utf8"));
  }
}
