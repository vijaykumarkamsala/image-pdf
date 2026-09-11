import { Pool } from "pg";

import { runMigrations } from "../services/api/dist/src/kernel/migrations.js";

const connectionString = process.env.IPW_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("IPW_TEST_DATABASE_URL is required for canonical Linux evidence");
}

const pool = new Pool({ connectionString });
try {
  await runMigrations(pool);
} finally {
  await pool.end();
}
