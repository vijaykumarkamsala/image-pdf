import assert from "node:assert/strict";
import test from "node:test";

import { attachment, parseRange } from "../src/domains/exports/exports.controller.js";

test("download content disposition has safe ASCII and RFC 5987 names", () => {
  assert.equal(
    attachment("campaign cafe.png"),
    "attachment; filename=\"campaign cafe.png\"; filename*=UTF-8''campaign%20cafe.png",
  );
  assert.equal(
    attachment("campaign-caf\u00e9.png"),
    "attachment; filename=\"campaign-caf_.png\"; filename*=UTF-8''campaign-caf%C3%A9.png",
  );
  const hostile = attachment("report\r\nX-Injected: yes.png");
  assert.doesNotMatch(hostile, /[\r\n]/);
  assert.doesNotMatch(hostile, /X-Injected:/);
});

test("single byte ranges support bounded, open and suffix forms", () => {
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=10-500", 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
});

test("malformed, multiple and unsatisfiable byte ranges fail closed", () => {
  for (const value of [
    "items=0-1",
    "bytes=",
    "bytes=0-1,4-5",
    "bytes=100-101",
    "bytes=20-10",
    "bytes=-0",
    "bytes=Infinity-",
  ]) {
    assert.equal(parseRange(value, 100), null, value);
  }
  assert.equal(parseRange("bytes=0-0", 0), null);
});
