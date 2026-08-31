import { CircleDashed, FilePlus2, Files, Image, Printer } from "lucide-react";
import type { FeatureStateRecord } from "ipw-contracts-ts/product";
import { Link } from "react-router-dom";
import { productFeatureState } from "../boundaries/featureFlags";
import { futureOutcomes } from "../routes";

const icons = [Image, FilePlus2, Files, Printer];

export function OutcomeGrid({ publicView = false, features, workspaceId }: { publicView?: boolean; features?: FeatureStateRecord[]; workspaceId?: string }) {
  return <div className="outcome-grid">{futureOutcomes.map((outcome, index) => {
    const Icon = icons[index];
    const serverState = features?.find((feature) => feature.feature === outcome.feature);
    const active = serverState?.active ?? productFeatureState.enabled(outcome.feature);
    const content = <>
      <span className="outcome-icon"><Icon aria-hidden="true" /></span>
      <div><h3>{outcome.label}</h3><p>{publicView ? outcome.publicDescription : outcome.description}</p></div>
      {!active && productFeatureState.showInactiveBuildIndicator && <span className="build-indicator"><CircleDashed aria-hidden="true" />Not active in this build</span>}
    </>;
    const className = `outcome-card outcome-card-${index + 1}`;
    return active && workspaceId && outcome.feature === "image-graphic-studio"
      ? <Link className={className} data-feature-state="active" key={outcome.feature} to={`/w/${encodeURIComponent(workspaceId)}/studio/new`}>{content}</Link>
      : <article className={className} data-feature-state={active ? "active" : "inactive"} aria-disabled={active ? undefined : true} key={outcome.feature}>{content}</article>;
  })}</div>;
}
