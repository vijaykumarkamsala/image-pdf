import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalFilesystemPrivateObjectStore,
  MemoryPrivateObjectStore,
  UploadLimitExceeded,
  UploadOffsetConflict,
} from "../src/domains/intake/private-object-store.js";

for (const [name, factory] of [
  ["memory", async () => ({ store: new MemoryPrivateObjectStore(), close: async () => {} })],
  ["local filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipw-private-"));
    return { store: new LocalFilesystemPrivateObjectStore(root), close: () => rm(root, { recursive: true, force: true }) };
  }],
] as const) {
  test(`${name} storage is private, resumable and immutable`, async () => {
    const { store, close } = await factory();
    try {
      const quarantine = await store.createQuarantine("workspace-001", "upload-001");
      assert.equal(await store.append(quarantine, new Uint8Array([1, 2]), 0, 4), 2);
      await assert.rejects(store.append(quarantine, new Uint8Array([3]), 0, 4), UploadOffsetConflict);
      assert.equal(await store.append(quarantine, new Uint8Array([3, 4]), 2, 4), 4);
      await assert.rejects(store.append(quarantine, new Uint8Array([5]), 4, 4), UploadLimitExceeded);
      const digest = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
      const immutable = await store.promote(quarantine, digest);
      assert.equal(immutable.zone, "immutable");
      assert.match(immutable.objectKey, /^immutable\/workspace-001\/[a-f0-9]{64}$/);
      await assert.rejects(store.append(immutable, new Uint8Array([9]), 4, 10));
      assert.deepEqual(Uint8Array.from(await store.read(immutable, 4)), new Uint8Array([1, 2, 3, 4]));
      const rehomed = await store.rehome(immutable, "workspace-002", digest);
      assert.match(rehomed.objectKey, /^immutable\/workspace-002\/[a-f0-9]{64}$/);
      assert.deepEqual(Uint8Array.from(await store.read(rehomed, 4)), new Uint8Array([1, 2, 3, 4]));
    } finally {
      await close();
    }
  });
}

test("filesystem storage contains bytes only below its private root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ipw-private-"));
  const store = new LocalFilesystemPrivateObjectStore(root);
  try {
    const ref = await store.createQuarantine("workspace-001", "upload-002");
    await store.append(ref, new Uint8Array([7]), 0, 1);
    assert.deepEqual(await readFile(join(root, ...ref.objectKey.split("/"))), Buffer.from([7]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
