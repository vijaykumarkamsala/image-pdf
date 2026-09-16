import { useState } from "react";

import { Button } from "../design-system";
import { FACE_DETAIL_RELEASE, faceModelBlockers } from "./faceDetailRestoration";

/** Availability/consent only. No model is approved, so no generation action is exposed. */
export function FaceDetailPanel({ disabled }: { disabled: boolean }) {
  const [consent, setConsent] = useState(false);
  const blockers = faceModelBlockers(FACE_DETAIL_RELEASE);

  return <details className="quality-face-detail" onToggle={(event) => {
    if (!event.currentTarget.open) setConsent(false);
  }}>
    <summary>Restore face detail <span>Not yet available</span></summary>
    <div className="quality-face-detail-content">
      <p>This separate mode would reconstruct plausible facial detail, not recover guaranteed original detail.
        It may change identity, eyes or expression. Ordinary Enhance quality does not enable it.</p>
      <label className="quality-face-consent">
        <input
          type="checkbox"
          checked={consent}
          disabled={disabled}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <span>I allow reconstructed face-detail candidates for this image. I will compare them with the original before approving one.</span>
      </label>
      {consent && <p>Permission recorded for this image only. No face model has run and no pixels have changed.</p>}
      <p>Unavailable: no face model currently passes all release gates.</p>
      <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
      <Button size="compact" disabled>Generate face candidates (unavailable)</Button>
      <p>Your original and current enhanced result remain available. This is unfinished face-restoration work, not an enhancement result.</p>
    </div>
  </details>;
}
