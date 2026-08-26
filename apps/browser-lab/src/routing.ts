/**
 * Local-versus-cloud routing, as a pure decision.
 *
 * Implements the policy table in benchmark plan §14 and decisions D-015 to D-019.
 * Deliberately pure and host-free so it can be tested exhaustively in Node: a
 * routing rule that can only be exercised by opening a browser is a routing rule
 * nobody exercises.
 *
 * Two product rules shape this more than anything technical:
 *
 * - **Browser output is a preview unless explicitly eligible as final**
 *   (AGENTS.md product invariants). The default is `preview`, and eligibility is
 *   something a route has to earn.
 * - **The customer never sees infrastructure words.** Every decision carries a
 *   `customerMessage` phrased as "Processing on your device" / "Processing
 *   securely in the cloud", per blueprint §11 and D-016.
 *
 * The thresholds here are *provisional*. Open decision O-003 says the real ones
 * come from measurement, which is what this lab exists to collect. They are
 * gathered in one exported object rather than scattered, so replacing them with
 * measured values is a single edit.
 */

import type { Capabilities } from "./capability.ts";
import { missingEssentials } from "./capability.ts";

export type Route = "browser_local" | "cloud_cpu" | "cloud_gpu";

export type OperationFamily = "standard" | "ai" | "inspection";

/** Why a route was chosen, in terms a person can check. */
export interface RouteDecision {
  route: Route;
  /** True only when the local result may be downloaded as a final file. */
  eligibleAsFinal: boolean;
  /** Whether the customer may override this choice (D-017). */
  overrideAllowed: boolean;
  /** Machine-readable reasons, most decisive first. */
  reasons: string[];
  /** What the customer is told. No infrastructure vocabulary. */
  customerMessage: string;
}

export interface RoutingInput {
  capabilities: Capabilities;
  family: OperationFamily;
  /** Decoded pixel count. Compressed bytes alone are not a safe proxy. */
  pixels: number;
  /** Compressed size on disk. */
  bytes: number;
  /** Number of images in this request. */
  batchSize: number;
  /** True when the result must be stored, audited, or survive the tab closing. */
  needsDurableResult: boolean;
  /** True when the customer asked for the authoritative full-quality output. */
  needsAuthoritativeOutput: boolean;
}

/**
 * Provisional local-eligibility thresholds.
 *
 * NOT measured yet - open decision O-003. These are conservative starting points
 * chosen so the lab has something to compare against; the whole purpose of
 * POC-005 is to replace them with figures from real devices.
 */
export const PROVISIONAL_LIMITS = {
  /** Above this many decoded pixels, a phone browser starts to struggle. */
  maxLocalPixels: 12_000_000,
  /** Above this compressed size, decode time alone becomes user-visible. */
  maxLocalBytes: 8 * 1024 * 1024,
  /** More than this many images and the cumulative cost outweighs the round trip. */
  maxLocalBatch: 5,
  /** Below this, the device is too constrained for comfortable local work. */
  minCores: 4,
  /** Chromium-only hint; absent on other browsers, so never required. */
  minMemoryGiB: 4,
} as const;

const CLOUD_MESSAGE = "Processing securely in the cloud";
const LOCAL_MESSAGE = "Processing on your device";

/**
 * Choose a route.
 *
 * Order matters: hard blocks first, then product rules, then size heuristics. The
 * first matching rule wins, and every rule that fired is recorded so a report can
 * explain the decision rather than assert it.
 */
export function decideRoute(input: RoutingInput): RouteDecision {
  const { capabilities, family, pixels, bytes, batchSize } = input;
  const reasons: string[] = [];

  // -- hard blocks -------------------------------------------------------
  const missing = missingEssentials(capabilities);
  if (missing.length > 0) {
    reasons.push(...missing.map((m) => `missing capability: ${m.capability} (${m.why})`));
    return {
      route: "cloud_cpu",
      eligibleAsFinal: false,
      overrideAllowed: false,
      reasons,
      customerMessage: CLOUD_MESSAGE,
    };
  }

  // -- AI is never local, initially (benchmark plan §14, D-019) ----------
  if (family === "ai") {
    reasons.push("AI operations run on cloud GPU; no local override until a benchmark proves it safe");
    return {
      route: "cloud_gpu",
      eligibleAsFinal: true,
      overrideAllowed: false,
      reasons,
      customerMessage: CLOUD_MESSAGE,
    };
  }

  // -- durability and authority (D-019) ----------------------------------
  if (input.needsDurableResult) {
    reasons.push("the result must survive the browser closing, which local work cannot promise");
    return {
      route: "cloud_cpu",
      eligibleAsFinal: true,
      overrideAllowed: false,
      reasons,
      customerMessage: CLOUD_MESSAGE,
    };
  }

  if (input.needsAuthoritativeOutput) {
    reasons.push("authoritative full-quality output is rendered server-side so it is identical on every device");
    return {
      route: "cloud_cpu",
      eligibleAsFinal: true,
      // D-017: the customer may still choose local when both routes are safe.
      overrideAllowed: isWithinLocalLimits(input).length === 0,
      reasons,
      customerMessage: CLOUD_MESSAGE,
    };
  }

  // -- size and batch heuristics -----------------------------------------
  const exceeded = isWithinLocalLimits(input);
  if (exceeded.length > 0) {
    reasons.push(...exceeded);
    return {
      route: "cloud_cpu",
      eligibleAsFinal: true,
      overrideAllowed: false,
      reasons,
      customerMessage: CLOUD_MESSAGE,
    };
  }

  reasons.push(
    `within provisional local limits (${pixels} px, ${bytes} bytes, batch of ${batchSize})`,
    "thresholds are provisional until measured on real devices (O-003)",
  );
  return {
    route: "browser_local",
    // The default. Local output is a preview until a specific operation is
    // benchmarked and explicitly declared eligible as a final download.
    eligibleAsFinal: false,
    overrideAllowed: true,
    reasons,
    customerMessage: LOCAL_MESSAGE,
  };
}

/** Reasons this request exceeds provisional local limits. Empty means it fits. */
export function isWithinLocalLimits(input: RoutingInput): string[] {
  const exceeded: string[] = [];
  const { capabilities, pixels, bytes, batchSize } = input;

  if (pixels > PROVISIONAL_LIMITS.maxLocalPixels) {
    exceeded.push(`${pixels} decoded pixels exceeds the provisional local limit of ${PROVISIONAL_LIMITS.maxLocalPixels}`);
  }
  if (bytes > PROVISIONAL_LIMITS.maxLocalBytes) {
    exceeded.push(`${bytes} bytes exceeds the provisional local limit of ${PROVISIONAL_LIMITS.maxLocalBytes}`);
  }
  if (batchSize > PROVISIONAL_LIMITS.maxLocalBatch) {
    exceeded.push(`a batch of ${batchSize} exceeds the provisional local limit of ${PROVISIONAL_LIMITS.maxLocalBatch}`);
  }
  if (capabilities.hardwareConcurrency !== null && capabilities.hardwareConcurrency < PROVISIONAL_LIMITS.minCores) {
    exceeded.push(`${capabilities.hardwareConcurrency} cores is below the provisional minimum of ${PROVISIONAL_LIMITS.minCores}`);
  }
  // deviceMemory is Chromium-only. Absent must never mean "unsuitable", or every
  // Firefox and Safari user would be pushed to the cloud for no reason.
  if (capabilities.deviceMemoryGiB !== null && capabilities.deviceMemoryGiB < PROVISIONAL_LIMITS.minMemoryGiB) {
    exceeded.push(`~${capabilities.deviceMemoryGiB} GiB reported is below the provisional minimum of ${PROVISIONAL_LIMITS.minMemoryGiB} GiB`);
  }
  return exceeded;
}
