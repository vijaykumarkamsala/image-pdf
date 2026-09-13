import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  DocumentReadModel,
  LayerRecord,
  PdfOutputProfile,
  PdfPreflightIssue,
  PdfPreflightReport,
} from "ipw-contracts-ts/product";

import { snapshotDigest } from "../documents/document-model.js";

const MAX_INITIAL_PAGES = 50;
const MAX_PDF_PAGE_POINTS = 14_400;
const SCREEN_PROFILE: PdfOutputProfile = {
  schema_version: PRODUCT_SCHEMA_VERSION,
  profile_id: "screen",
  profile_version: "1.0.0",
  label: "Screen PDF",
  tagged_pdf: false,
  archival_conformance: null,
  colour_space: "srgb",
  image_quality: 90,
  metadata_policy: "safe",
};

export function screenPdfProfile(): PdfOutputProfile {
  return structuredClone(SCREEN_PROFILE);
}

export function preflightScreenPdf(editor: DocumentReadModel, generatedAt: string): PdfPreflightReport {
  const issues: PdfPreflightIssue[] = [];
  const { document, snapshot } = editor;
  const block = (code: string, message: string, layer?: LayerRecord) => issues.push(issue(code, message, "error", true, layer));
  const digest = snapshotDigest(snapshot);
  if (document.kind !== "pdf" || !snapshot.pdf_settings) {
    block("native-pdf-required", "Screen PDF export requires a native PDF document.");
  }
  const currentVersion = editor.versions.find((version) => version.document_version_id === document.current_version_id);
  if (!currentVersion || currentVersion.revision !== snapshot.revision || currentVersion.snapshot_sha256 !== digest) {
    block("pdf-version-checkpoint-required", "Save an immutable checkpoint of the current PDF before export.");
  }
  if (snapshot.artboards.length > MAX_INITIAL_PAGES) {
    block("page-limit-exceeded", `This release exports at most ${MAX_INITIAL_PAGES} pages in one PDF.`);
  }
  for (const page of snapshot.artboards) {
    if (page.unit !== "pt") {
      issues.push(issue("page-unit-invalid", "PDF pages must use point dimensions.", "error", true, undefined, page.artboard_id));
    }
    if (page.width > MAX_PDF_PAGE_POINTS || page.height > MAX_PDF_PAGE_POINTS) {
      issues.push(issue("page-size-unsupported", "A PDF page cannot exceed 200 inches on either side.", "error", true, undefined, page.artboard_id));
    }
  }
  const assets = new Map((snapshot.shared_assets ?? []).map((asset) => [asset.shared_asset_id, asset]));
  for (const layer of snapshot.layers ?? []) {
    if (!effectivelyVisible(layer, snapshot.layers ?? [])) continue;
    if (layer.layer_type === "group") {
      block("group-layer-unsupported", "Ungroup layers before exporting this PDF.", layer);
      continue;
    }
    if ((layer.blend_mode ?? "normal") !== "normal" || (layer.opacity ?? 1) !== 1) {
      block("appearance-unsupported", "Screen PDF export does not yet support layer opacity or blend modes.", layer);
    }
    if ((layer.transform.skew_x_degrees ?? 0) !== 0 || (layer.transform.skew_y_degrees ?? 0) !== 0) {
      block("skew-unsupported", "Screen PDF export does not yet support skewed layers.", layer);
    }
    if ((layer.shared_style_ids ?? []).length > 0) {
      block("linked-style-unsupported", "Detach shared styles before Screen PDF export.", layer);
    }
    if (layer.raster) {
      const asset = assets.get(layer.raster.shared_asset_id);
      const crop = layer.raster.crop;
      if (!asset?.source_width_px || !asset.source_height_px || !asset.source_media_type
        || !asset.source_byte_size || !asset.source_bit_depth || !asset.source_frame_count
        || asset.source_colour_model === null || asset.source_colour_model === undefined) {
        block("source-facts-missing", "The image source is missing facts required for safe PDF rendering.", layer);
      } else if (!crop) {
        block("image-crop-missing", "The image placement is missing its source crop.", layer);
      } else {
        if (!["image/jpeg", "image/png", "image/webp", "image/tiff"].includes(asset.source_media_type)
          || asset.source_bit_depth > 8 || asset.source_frame_count !== 1
          || !["grayscale", "rgb", "indexed"].includes(asset.source_colour_model)) {
          block("source-profile-unsupported", "Screen PDF currently accepts verified single-frame 8-bit RGB, grayscale or indexed images.", layer);
        }
        const cropWidth = (crop.right ?? 1) - (crop.left ?? 0);
        const cropHeight = (crop.bottom ?? 1) - (crop.top ?? 0);
        const effectiveDpi = Math.min(
          (asset.source_width_px * cropWidth) / ((layer.transform.width * (layer.transform.scale_x ?? 1)) / 72),
          (asset.source_height_px * cropHeight) / ((layer.transform.height * (layer.transform.scale_y ?? 1)) / 72),
        );
        if (effectiveDpi < 150) {
          issues.push(issue(
            "image-resolution-low",
            `This image will render at about ${Math.max(1, Math.round(effectiveDpi))} DPI.`,
            "warning",
            false,
            layer,
          ));
        }
      }
      if (Object.entries(layer.raster.adjustments ?? {}).some(([name, value]) => name !== "schema_version" && value !== 0)) {
        block("image-adjustments-unsupported", "Apply image adjustments to a reviewed derivative before PDF export.", layer);
      }
      if ((layer.raster.mask_ids ?? []).length > 0) {
        block("image-mask-unsupported", "Raster masks are not enabled in the Screen PDF renderer yet.", layer);
      }
      if (!layer.accessibility) {
        issues.push(issue(
          "image-description-missing",
          "Add an image description or mark this image decorative before an accessible profile can be enabled.",
          "warning",
          false,
          layer,
        ));
      }
      continue;
    }
    if (layer.rich_text) {
      if (layer.rich_text.font_family !== "IPW Standard" || (layer.rich_text.runs ?? []).length > 0) {
        block("typography-unsupported", "This release exports plain IPW Standard text only.", layer);
      }
      if (!/^[\x09\x0A\x0D\x20-\x7E]*$/.test(layer.rich_text.text)) {
        block("text-glyph-unsupported", "This text contains glyphs outside the approved embedded font subset.", layer);
      }
      if (layer.rich_text.text_align === "justify") {
        block("text-alignment-unsupported", "Screen PDF supports left, centre and right aligned plain text.", layer);
      }
      if (!validColour(layer.rich_text.color ?? "#000000")) block("text-colour-invalid", "Text colour must be a six-digit hexadecimal colour.", layer);
      continue;
    }
    if (layer.shape) {
      if (layer.shape.shape !== "rectangle") {
        block("shape-type-unsupported", "Screen PDF currently exports rectangle shapes only.", layer);
      }
      if ((layer.shape.corner_radius ?? 0) !== 0) {
        block("rounded-shape-unsupported", "Use square corners for Screen PDF rectangle shapes.", layer);
      }
      if ((layer.shape.fill && !validColour(layer.shape.fill)) || (layer.shape.stroke && !validColour(layer.shape.stroke))) {
        block("shape-colour-invalid", "Shape colours must use six-digit hexadecimal values.", layer);
      }
      continue;
    }
    block("layer-type-unsupported", `The ${layer.layer_type} layer type is not enabled in the Screen PDF renderer.`, layer);
  }
  issues.push(issue(
    "screen-profile-untagged",
    "Screen PDF preserves visible text and images but is not yet a tagged accessible PDF or PDF/A output.",
    "info",
    false,
  ));
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    document_id: document.document_id,
    document_version_id: document.current_version_id,
    snapshot_sha256: digest,
    profile: screenPdfProfile(),
    state: issues.some((item) => item.blocks_export) ? "blocked" : "ready",
    page_count: snapshot.artboards.length,
    issues,
    generated_at: generatedAt,
  };
}

function issue(
  code: string,
  message: string,
  severity: "info" | "warning" | "error",
  blocksExport: boolean,
  layer?: LayerRecord,
  pageArtboardId?: string,
): PdfPreflightIssue {
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    code,
    severity,
    message,
    page_artboard_id: pageArtboardId ?? layer?.artboard_id ?? null,
    layer_id: layer?.layer_id ?? null,
    blocks_export: blocksExport,
  };
}

function validColour(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function effectivelyVisible(layer: LayerRecord, layers: LayerRecord[]): boolean {
  if (layer.visible === false) return false;
  const byId = new Map(layers.map((item) => [item.layer_id, item]));
  const visited = new Set<string>();
  let parentId = layer.parent_layer_id;
  while (parentId) {
    if (visited.has(parentId)) return false;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.visible === false) return false;
    parentId = parent.parent_layer_id;
  }
  return true;
}
