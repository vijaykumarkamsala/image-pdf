import { CircleDashed, FilePlus2, Files, Image, Printer } from "lucide-react";
import { productFeatureState } from "../boundaries/featureFlags";
import { futureOutcomes } from "../routes";

const icons = [Image, FilePlus2, Files, Printer];

export function OutcomeGrid({ publicView = false }: { publicView?: boolean }) {
  return <div className="outcome-grid">{futureOutcomes.map((outcome, index) => {
    const Icon = icons[index];
    const active = productFeatureState.enabled(outcome.feature);
    return <article className={`outcome-card outcome-card-${index + 1}`} data-feature-state={active ? "active" : "inactive"} key={outcome.feature}>
      <span className="outcome-icon"><Icon aria-hidden="true" /></span>
      <div><h3>{outcome.label}</h3><p>{publicView ? outcome.publicDescription : outcome.description}</p></div>
      {!active && productFeatureState.showInactiveBuildIndicator && <span className="build-indicator"><CircleDashed aria-hidden="true" />Not active in this build</span>}
    </article>;
  })}</div>;
}
