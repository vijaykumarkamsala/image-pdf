/**
 * Device and browser capability detection.
 *
 * Benchmark plan §9: *"Automatic routing uses feature detection and measured
 * limits, not user-agent assumptions alone."* So nothing here parses a user-agent
 * string to decide what a device can do. Every capability is either probed
 * directly or measured.
 *
 * The user-agent *is* recorded, because a benchmark result has to say which
 * device produced it - but it is evidence for a human reading the report, never
 * an input to a routing decision.
 */

/** What the host actually supports, as probed rather than assumed. */
export interface Capabilities {
  /** Off-main-thread execution. Without it, any real work blocks the UI. */
  webWorker: boolean;
  /** Canvas work inside a worker. The difference between responsive and frozen. */
  offscreenCanvas: boolean;
  /** Efficient decode without a DOM element. */
  createImageBitmap: boolean;
  /** Needed to compute a content-addressed identifier in the browser. */
  subtleCrypto: boolean;
  /** Required if a future local operation ships as WASM. */
  webAssembly: boolean;
  /** High-resolution timing. */
  performanceNow: boolean;
  /** Only present in a secure context; crypto.subtle depends on it. */
  secureContext: boolean;

  /** Logical cores, when the host reports them. */
  hardwareConcurrency: number | null;
  /**
   * Approximate RAM in GiB, when reported. Chromium-only, and deliberately
   * coarse for fingerprinting reasons - treat as a hint, never a limit.
   */
  deviceMemoryGiB: number | null;
  /** Recorded for the report. Never used to decide a route. */
  userAgent: string;
  /** Touch-first devices get different defaults, per blueprint §23. */
  touchCapable: boolean;
}

interface CapabilityHost {
  Worker?: unknown;
  OffscreenCanvas?: unknown;
  createImageBitmap?: unknown;
  WebAssembly?: unknown;
  isSecureContext?: boolean;
  crypto?: { subtle?: unknown };
  performance?: { now?: unknown };
  navigator?: {
    hardwareConcurrency?: number;
    deviceMemory?: number;
    userAgent?: string;
    maxTouchPoints?: number;
  };
}

/**
 * Probe the current host.
 *
 * Takes the host object as a parameter so the same function can be exercised in
 * Node against synthetic hosts. A capability detector that can only run in the
 * environment it detects is a capability detector nobody tests.
 */
export function detectCapabilities(host: CapabilityHost = globalThis as CapabilityHost): Capabilities {
  const navigator = host.navigator;
  return {
    webWorker: typeof host.Worker !== "undefined",
    offscreenCanvas: typeof host.OffscreenCanvas !== "undefined",
    createImageBitmap: typeof host.createImageBitmap === "function",
    subtleCrypto: typeof host.crypto?.subtle !== "undefined",
    webAssembly: typeof host.WebAssembly !== "undefined",
    performanceNow: typeof host.performance?.now === "function",
    secureContext: host.isSecureContext === true,
    hardwareConcurrency: navigator?.hardwareConcurrency ?? null,
    deviceMemoryGiB: navigator?.deviceMemory ?? null,
    userAgent: navigator?.userAgent ?? "unknown",
    touchCapable: (navigator?.maxTouchPoints ?? 0) > 0,
  };
}

/** A capability that must be present for local processing to be attempted at all. */
export interface MissingCapability {
  capability: string;
  why: string;
}

/**
 * Capabilities without which local processing is not merely slow but unsafe or
 * impossible.
 *
 * Deliberately short. Every entry has to justify blocking a device, and "it would
 * be a bit slower" does not qualify - that is the routing decision's job, not
 * this one's.
 */
export function missingEssentials(capabilities: Capabilities): MissingCapability[] {
  const missing: MissingCapability[] = [];

  if (!capabilities.createImageBitmap) {
    missing.push({
      capability: "createImageBitmap",
      why: "the image cannot be decoded without holding it on the main thread, which would freeze the UI",
    });
  }
  if (!capabilities.webWorker) {
    missing.push({
      capability: "Worker",
      why: "all work would run on the main thread, so the interface would stop responding",
    });
  }
  if (!capabilities.subtleCrypto) {
    missing.push({
      capability: "crypto.subtle",
      why: "a result could not be given a content-addressed identifier, so it could not be compared with a server result",
    });
  }
  if (!capabilities.secureContext) {
    missing.push({
      capability: "secureContext",
      why: "Web Crypto is unavailable outside a secure context; serve over http://localhost or https, not file://",
    });
  }
  return missing;
}

/** Human-readable one-liner for the lab UI and the report. */
export function describeCapabilities(capabilities: Capabilities): string {
  const parts = [
    capabilities.offscreenCanvas ? "OffscreenCanvas" : "no OffscreenCanvas",
    capabilities.createImageBitmap ? "createImageBitmap" : "no createImageBitmap",
    `${capabilities.hardwareConcurrency ?? "?"} cores`,
    capabilities.deviceMemoryGiB ? `~${capabilities.deviceMemoryGiB} GiB` : "memory unreported",
  ];
  return parts.join(" · ");
}
