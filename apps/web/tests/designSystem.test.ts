import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../src/design-system");
const tokens = readFileSync(resolve(root, "tokens.css"), "utf8");
const styles = readFileSync(resolve(root, "design-system.css"), "utf8");
const components = readFileSync(resolve(root, "components.tsx"), "utf8");
const overlays = readFileSync(resolve(root, "overlays.tsx"), "utf8");
const upload = readFileSync(resolve(root, "../components/UploadDialog.tsx"), "utf8");
const featureStyles = readFileSync(resolve(root, "../styles.css"), "utf8");

test("semantic tokens define independent brand, focus, and status colours in both themes", () => {
  for (const token of [
    "--color-brand:",
    "--color-focus:",
    "--color-success:",
    "--color-warning:",
    "--color-error:",
    "--color-info:",
  ]) assert.match(tokens, new RegExp(token));
  assert.match(tokens, /:root\[data-theme="dark"\]/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});

test("the production component catalogue exposes the approved control families", () => {
  for (const component of [
    "Button", "IconButton", "TextInput", "SelectField", "SearchCombobox",
    "Card", "Badge", "Progress", "Tabs", "InlineNotice", "Skeleton",
    "Dropzone", "StatusItem",
  ]) assert.match(components, new RegExp(`export (?:interface |function )${component}`));
  for (const component of ["Dialog", "Drawer", "Popover", "Menu", "ToastViewport"])
    assert.match(overlays, new RegExp(`export (?:interface |function )${component}`));
});

test("modal foundation includes escape, focus trapping, and focus restoration", () => {
  assert.match(overlays, /event\.key === "Escape"/);
  assert.match(overlays, /event\.key !== "Tab"/);
  assert.match(overlays, /returnFocus\.current\?\.focus\(\)/);
});

test("upload actions use the shared button and dropzone system without legacy variants", () => {
  assert.match(upload, /<Dropzone/);
  assert.doesNotMatch(upload, /className="(?:button|icon-button)/);
  assert.doesNotMatch(featureStyles, /^\.(?:button|icon-button)(?:[\s.{:#])/m);
});
