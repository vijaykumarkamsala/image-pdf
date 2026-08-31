import { useEffect, useState } from "react";
import {
  CheckCircle2,
  FileImage,
  FileText,
  Fingerprint,
  Info,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type {
  IntelligentIntakePresentation,
  IntakeSourceCategory,
  UploadSessionRecord,
} from "ipw-contracts-ts/product";

import { api } from "../boundaries/apiClient.ts";
import { Badge, InlineNotice, SelectField, Skeleton } from "../design-system";

const CATEGORY_LABELS: Record<IntakeSourceCategory, string> = {
  photograph: "Photograph",
  graphic: "Graphic or illustration",
  document: "Document",
  scan: "Scanned page",
  animation: "Animation",
  other: "Something else",
  unsure: "Not sure",
};

const OUTCOME_LABELS = {
  "image-graphic-studio": "Image & Graphic Studio",
  "create-pdf": "Create PDF",
  "edit-manage-pdf": "Edit & Manage PDF",
  "print-production": "Print & Production",
} as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function verifiedType(mediaType: string): string {
  const labels: Record<string, string> = {
    "application/pdf": "PDF document",
    "image/png": "PNG image",
    "image/jpeg": "JPEG image",
    "image/gif": "GIF image",
    "image/webp": "WebP image",
    "image/tiff": "TIFF image",
    "image/bmp": "BMP image",
    "image/heif": "HEIF image",
    "image/heic": "HEIC image",
  };
  return labels[mediaType] ?? mediaType;
}

export function IntakeFacts({
  upload,
  traceId,
}: {
  upload: UploadSessionRecord;
  traceId: string;
}) {
  const [presentation, setPresentation] = useState<IntelligentIntakePresentation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.intakePresentation(upload.upload_session_id, traceId).then(
      (response) => { if (active) setPresentation(response.presentation); },
      () => { if (active) setError("Verified facts could not be displayed. The accepted source remains unchanged."); },
    );
    return () => { active = false; };
  }, [traceId, upload.upload_session_id]);

  async function correct(category: IntakeSourceCategory) {
    setSaving(true);
    setError(null);
    try {
      const response = await api.correctIntakeClassification(upload.upload_session_id, category, traceId);
      setPresentation(response.presentation);
    } catch {
      setError("The source category could not be saved. No file content was changed.");
    } finally {
      setSaving(false);
    }
  }

  if (error && !presentation) return <InlineNotice tone="error" title="Facts unavailable">{error}</InlineNotice>;
  if (!presentation) return <div className="intake-facts-loading" aria-label="Loading verified source facts"><Skeleton height={18} /><Skeleton height={96} /></div>;

  const facts = presentation.source_facts;
  const classification = presentation.classification;
  const evidence = classification.evidence ?? [];
  const effectiveCategory = classification.customer_category ?? classification.inferred_category ?? "";
  const isPdf = facts.detected_media_type === "application/pdf";
  const technicalFacts = [
    facts.width && facts.height ? ["Dimensions", `${facts.width} x ${facts.height} px`] : null,
    facts.megapixels_milli !== null && facts.megapixels_milli !== undefined
      ? ["Megapixels", `${(facts.megapixels_milli / 1000).toFixed(2)} MP`] : null,
    facts.page_count ? ["Pages", String(facts.page_count)] : null,
    facts.frame_count ? ["Frames", String(facts.frame_count)] : null,
    facts.orientation ? ["Orientation", `EXIF ${facts.orientation}`] : null,
    facts.bit_depth ? ["Bit depth", `${facts.bit_depth}-bit`] : null,
    facts.has_alpha !== null && facts.has_alpha !== undefined ? ["Alpha", facts.has_alpha ? "Present" : "Not present"] : null,
    facts.has_icc_profile !== null && facts.has_icc_profile !== undefined
      ? ["Colour profile", facts.has_icc_profile ? "Embedded ICC profile" : "No embedded ICC profile"] : null,
  ].filter((fact): fact is string[] => fact !== null);

  return <section className="intake-facts" aria-label={`Verified facts for ${presentation.filename}`}>
    <div className="intake-facts-title">
      <span className="intake-file-representation">{isPdf ? <FileText aria-hidden="true" /> : <FileImage aria-hidden="true" />}</span>
      <div><span>Verified source</span><h3>{presentation.filename}</h3><Badge tone="success"><CheckCircle2 aria-hidden="true" />Accepted safely</Badge></div>
    </div>

    <div className="intake-fact-groups">
      <section><h4>Identity</h4><dl className="fact-list">
        <div><dt>Verified type</dt><dd>{verifiedType(facts.detected_media_type)}</dd></div>
        <div><dt>File size</dt><dd>{formatBytes(facts.byte_size)}</dd></div>
        <div className="fact-identity"><dt><Fingerprint aria-hidden="true" />SHA-256</dt><dd><code>{facts.sha256}</code></dd></div>
      </dl></section>
      <section><h4>Technical facts</h4>{technicalFacts.length ? <dl className="fact-list">{technicalFacts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p className="muted-copy">No additional technical dimensions are available from the approved parser.</p>}</section>
    </div>

    <section className="intake-dimensions"><div className="intake-section-heading"><h4>Safety and risk dimensions</h4><span>No combined quality score</span></div><div className="risk-grid">{presentation.risk_dimensions.map((risk) => <article className={`risk-item risk-${risk.state}`} key={risk.dimension}>{risk.state === "clear" ? <ShieldCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}<div><strong>{risk.dimension}</strong><p>{risk.summary}</p></div></article>)}</div></section>

    <section className="classification-panel">
      <div><h4>Likely source category</h4>{classification.inferred_category ? <p><strong>{CATEGORY_LABELS[classification.inferred_category]}</strong>{classification.confidence_percent !== null && classification.confidence_percent !== undefined ? ` · ${classification.confidence_percent}% confidence` : ""}</p> : <p>No evidence-based category was inferred from file structure alone.</p>}{evidence.length > 0 && <p className="classification-evidence"><Info aria-hidden="true" />{evidence.join(" ")}</p>}</div>
      <SelectField label="Correct source category" value={effectiveCategory} disabled={saving} onChange={(event) => void correct(event.target.value as IntakeSourceCategory)}>
        <option value="" disabled>Choose a category</option>
        {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </SelectField>
    </section>

    {error && <InlineNotice tone="error" title="Category not saved">{error}</InlineNotice>}
    <InlineNotice tone="success" title="Source is suitable">{presentation.suitable_explanation}</InlineNotice>
    <section className="intake-recommendation"><span>Recommended next outcome</span><strong>{OUTCOME_LABELS[presentation.recommended_outcome]}</strong><p>{presentation.recommendation_rationale}</p><small>This recommendation does not alter or process your source.</small></section>
  </section>;
}
