import assert from "node:assert/strict";
import test from "node:test";

import { majorOutcomes, routeFor } from "../src/routes.ts";

test("home exposes the four V2 parent outcomes equally", () => {
  assert.deepEqual(
    majorOutcomes.map((route) => route.label),
    ["Image & Graphic Studio", "Create PDF", "Edit & Manage PDF", "Print & Production"],
  );
});

test("unknown routes fall back to home", () => {
  assert.equal(routeFor("/unknown").path, "/");
});

