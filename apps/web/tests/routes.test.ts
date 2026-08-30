import assert from "node:assert/strict";
import test from "node:test";

import { createProductFeatureState } from "../src/boundaries/featureFlags.ts";
import { resolveTheme } from "../src/boundaries/theme.ts";
import { futureOutcomes, workspacePath, workspaceRoutes } from "../src/routes.ts";

test("workspace navigation is outcome-oriented and mobile-safe", () => {
  assert.deepEqual(workspaceRoutes.map((route) => route.label), ["Home", "Projects", "Files"]);
  assert.equal(workspacePath("workspace-001", "projects"), "/w/workspace-001/projects");
});

test("the four approved parent outcomes remain equally represented", () => {
  assert.deepEqual(futureOutcomes.map(({ label, description, feature }) => ({ label, description, feature })), [
    { label: "Image & Graphic Studio", description: "Enhance, design and prepare visuals", feature: "image-graphic-studio" },
    { label: "Create PDF", description: "Build PDFs from pages, images and rich content", feature: "create-pdf" },
    { label: "Edit & Manage PDF", description: "Edit, organize, protect and convert PDFs", feature: "edit-manage-pdf" },
    { label: "Print & Production", description: "Check quality and prepare production outputs", feature: "print-production" },
  ]);
});

test("inactive product areas disclose build status only outside production", () => {
  const development = createProductFeatureState("development");
  const production = createProductFeatureState("production");
  for (const outcome of futureOutcomes) {
    assert.equal(development.enabled(outcome.feature), false);
    assert.equal(production.enabled(outcome.feature), false);
  }
  assert.equal(development.showInactiveBuildIndicator, true);
  assert.equal(production.showInactiveBuildIndicator, false);
});

test("system theme follows the browser while explicit preferences remain stable", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});
