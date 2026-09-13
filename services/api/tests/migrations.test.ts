import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MIGRATION_VERSIONS } from "../src/kernel/migrations.js";

test("the ordered migration registry exactly covers every production migration", () => {
  const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
  const migrationVersions = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => name.slice(0, -4));

  assert.deepEqual([...MIGRATION_VERSIONS], migrationVersions);
  assert.equal(new Set(MIGRATION_VERSIONS).size, MIGRATION_VERSIONS.length);
});
