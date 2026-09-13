import {
  PRODUCT_SCHEMA_VERSION,
  PdfFeatureValues,
  PdfOperationValues,
  type PdfCapabilityAnalysis,
  type PdfFeature,
  type SourceFacts,
} from "ipw-contracts-ts/product";

const labels: Record<PdfFeature, string> = {
  encryption: "Encryption",
  document_permissions: "Document permissions",
  digital_signatures: "Digital signatures",
  fonts: "Fonts",
  text: "Text",
  images: "Images",
  vector_content: "Vector content",
  forms: "Forms",
  annotations: "Annotations",
  optional_content_layers: "Optional-content layers",
  tags: "Accessibility tags",
  attachments: "Attachments",
  active_content: "Active content",
  mixed_page_sizes: "Mixed page sizes",
};

const activeMarkers = ["/JavaScript", "/JS", "/Launch", "/OpenAction", "/RichMedia"];
const attachmentMarkers = ["/EmbeddedFile", "/EmbeddedFiles", "/Filespec"];

/**
 * Conservative evidence for the deterministic local adapter only.
 * Production capability authority is the pinned Python/pypdf worker.
 */
export function localPdfCapability(bytes: Uint8Array, facts: SourceFacts): PdfCapabilityAnalysis {
  const body = Buffer.from(bytes).toString("latin1");
  const encrypted = body.includes("/Encrypt");
  const active = activeMarkers.some((marker) => body.includes(marker));
  const attachments = attachmentMarkers.some((marker) => body.includes(marker));
  const restricted = encrypted || active || attachments;
  return {
    schema_version: PRODUCT_SCHEMA_VERSION,
    source_sha256: facts.sha256,
    pdf_version: /^%PDF-(1\.[0-9])/.exec(body)?.[1] ?? null,
    page_count: facts.page_count ?? null,
    analysis_state: "restricted",
    classification: "view_only",
    opening_mode: encrypted ? "credential_required" : "restricted_safe_view",
    original_protected: true,
    findings: PdfFeatureValues.map((feature) => {
      const present = feature === "encryption" ? encrypted
        : feature === "active_content" ? active
          : feature === "attachments" ? attachments
            : false;
      return {
        schema_version: PRODUCT_SCHEMA_VERSION,
        feature,
        state: present ? "present" as const : "unknown" as const,
        summary: present
          ? `${labels[feature]} structures were detected and remain disabled.`
          : `${labels[feature]} requires the canonical strict Linux inspector before capability is claimed.`,
      };
    }),
    operations: PdfOperationValues.map((operation) => ({
      schema_version: PRODUCT_SCHEMA_VERSION,
      operation,
      state: operation === "view_capability_report" ? "available" as const : "blocked" as const,
      creates_derivative: !["view_capability_report", "download_original"].includes(operation),
      reason: operation === "view_capability_report"
        ? "The conservative local capability report is available."
        : restricted
          ? "The source requires canonical restricted inspection before this operation can be considered."
          : "This operation is not enabled by the local compatibility adapter.",
    })),
    compatibility_notes: [
      "Local development uses a conservative non-production report and never enables an imported-PDF mutation.",
      "The pinned Linux Python worker produces authoritative capability evidence.",
    ],
    inspector: {
      schema_version: PRODUCT_SCHEMA_VERSION,
      name: "IPW local conservative PDF inspector",
      version: "1.0.0",
      library_name: "bounded-header",
      library_version: "1.0.0",
      max_object_visits: 1,
    },
  };
}
