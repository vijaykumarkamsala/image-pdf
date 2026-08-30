import assert from "node:assert/strict";
import test from "node:test";

import { futureOutcomes, workspacePath, workspaceRoutes } from "../src/routes.ts";

test("workspace navigation is outcome-oriented and mobile-safe", () => {
  assert.deepEqual(workspaceRoutes.map((route) => route.label), ["Home", "Projects", "Files"]);
  assert.equal(workspacePath("workspace-001", "projects"), "/w/workspace-001/projects");
});

test("the four approved parent outcomes remain equally represented", () => {
  assert.deepEqual(futureOutcomes, [
    "Image & Graphic Studio",
    "Create PDF",
    "Edit & Manage PDF",
    "Print & Production",
  ]);
});
