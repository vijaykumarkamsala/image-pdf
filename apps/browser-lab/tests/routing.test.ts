/**
 * Capability detection and routing decisions.
 *
 * Both are pure functions taking a host object, so the whole policy table from
 * benchmark plan §14 can be exercised in Node without opening a browser. A
 * routing rule that can only be tested by hand on a phone is a routing rule that
 * silently rots.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type Capabilities,
  describeCapabilities,
  detectCapabilities,
  missingEssentials,
} from "../src/capability.ts";
import {
  PROVISIONAL_LIMITS,
  type RoutingInput,
  decideRoute,
  isWithinLocalLimits,
} from "../src/routing.ts";

/** A host with everything a modern desktop browser provides. */
function capableHost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Worker: class {},
    OffscreenCanvas: class {},
    createImageBitmap: () => undefined,
    WebAssembly: {},
    isSecureContext: true,
    crypto: { subtle: {} },
    performance: { now: () => 0 },
    navigator: {
      hardwareConcurrency: 8,
      deviceMemory: 8,
      userAgent: "TestBrowser/1.0",
      maxTouchPoints: 0,
    },
    ...overrides,
  };
}

const capable = (): Capabilities => detectCapabilities(capableHost() as never);

function request(overrides: Partial<RoutingInput> = {}): RoutingInput {
  return {
    capabilities: capable(),
    family: "standard",
    pixels: 2_000_000,
    bytes: 1_500_000,
    batchSize: 1,
    needsDurableResult: false,
    needsAuthoritativeOutput: false,
    ...overrides,
  };
}

// ----------------------------------------------------------- capabilities --

test("a fully capable host reports everything present", () => {
  const capabilities = capable();
  assert.equal(capabilities.webWorker, true);
  assert.equal(capabilities.offscreenCanvas, true);
  assert.equal(capabilities.createImageBitmap, true);
  assert.equal(capabilities.subtleCrypto, true);
  assert.equal(capabilities.secureContext, true);
  assert.equal(capabilities.hardwareConcurrency, 8);
  assert.equal(missingEssentials(capabilities).length, 0);
});

test("a bare host reports nothing present rather than throwing", () => {
  const capabilities = detectCapabilities({} as never);
  assert.equal(capabilities.webWorker, false);
  assert.equal(capabilities.hardwareConcurrency, null);
  assert.equal(capabilities.userAgent, "unknown");
  assert.ok(missingEssentials(capabilities).length >= 3);
});

test("detection never consults the user agent for a decision", () => {
  // Benchmark plan §9: feature detection, not user-agent assumptions.
  const lying = detectCapabilities(
    capableHost({ navigator: { userAgent: "Mozilla/5.0 (ancient device)", hardwareConcurrency: 8 } }) as never,
  );
  assert.equal(missingEssentials(lying).length, 0, "a claimed-old user agent must not block a capable host");
});

test("an insecure context is an essential failure", () => {
  const insecure = detectCapabilities(capableHost({ isSecureContext: false }) as never);
  const missing = missingEssentials(insecure).map((m) => m.capability);
  assert.ok(missing.includes("secureContext"));
});

test("each missing essential explains itself", () => {
  for (const item of missingEssentials(detectCapabilities({} as never))) {
    assert.ok(item.why.length > 20, `${item.capability} has no useful explanation`);
  }
});

test("the description is human-readable", () => {
  assert.match(describeCapabilities(capable()), /OffscreenCanvas.*8 cores/);
});

// ---------------------------------------------------------------- routing --

test("a small standard operation on a capable device runs locally", () => {
  const decision = decideRoute(request());
  assert.equal(decision.route, "browser_local");
  assert.equal(decision.customerMessage, "Processing on your device");
});

test("local output is a preview by default", () => {
  // AGENTS.md product invariant: browser output is a preview unless explicitly
  // eligible as a final result.
  assert.equal(decideRoute(request()).eligibleAsFinal, false);
});

test("AI never runs locally", () => {
  const decision = decideRoute(request({ family: "ai" }));
  assert.equal(decision.route, "cloud_gpu");
  assert.equal(decision.overrideAllowed, false, "D-019: no local override for AI initially");
});

test("a durable result is routed to the cloud", () => {
  const decision = decideRoute(request({ needsDurableResult: true }));
  assert.equal(decision.route, "cloud_cpu");
  assert.match(decision.reasons.join(" "), /survive the browser closing/);
});

test("authoritative output is rendered server-side", () => {
  const decision = decideRoute(request({ needsAuthoritativeOutput: true }));
  assert.equal(decision.route, "cloud_cpu");
  assert.equal(decision.eligibleAsFinal, true);
});

test("authoritative output still permits an override when local is safe", () => {
  // D-017: the customer may choose local when both routes are safe.
  const decision = decideRoute(request({ needsAuthoritativeOutput: true }));
  assert.equal(decision.overrideAllowed, true);
});

test("authoritative output forbids an override when local is unsafe", () => {
  const decision = decideRoute(
    request({ needsAuthoritativeOutput: true, pixels: PROVISIONAL_LIMITS.maxLocalPixels + 1 }),
  );
  assert.equal(decision.overrideAllowed, false);
});

test("an incapable device is sent to the cloud and cannot override", () => {
  // POC-005 acceptance: unsupported devices receive a cloud-route recommendation.
  const decision = decideRoute(request({ capabilities: detectCapabilities({} as never) }));
  assert.equal(decision.route, "cloud_cpu");
  assert.equal(decision.overrideAllowed, false);
  assert.equal(decision.eligibleAsFinal, false);
  assert.ok(decision.reasons.some((r) => r.startsWith("missing capability")));
});

test("every decision carries a customer message free of infrastructure words", () => {
  const inputs = [
    request(),
    request({ family: "ai" }),
    request({ needsDurableResult: true }),
    request({ capabilities: detectCapabilities({} as never) }),
    request({ pixels: 99_000_000 }),
  ];
  for (const input of inputs) {
    const message = decideRoute(input).customerMessage;
    assert.ok(
      message === "Processing on your device" || message === "Processing securely in the cloud",
      `unexpected customer wording: ${message}`,
    );
    for (const word of ["CPU", "GPU", "cloud_cpu", "worker", "canvas"]) {
      assert.ok(!message.includes(word), `customer message leaks infrastructure term: ${word}`);
    }
  }
});

test("every decision records at least one reason", () => {
  for (const family of ["standard", "ai", "inspection"] as const) {
    assert.ok(decideRoute(request({ family })).reasons.length > 0);
  }
});

// ----------------------------------------------------------------- limits --

test("each provisional limit pushes work to the cloud on its own", () => {
  const cases: Array<[string, Partial<RoutingInput>]> = [
    ["pixels", { pixels: PROVISIONAL_LIMITS.maxLocalPixels + 1 }],
    ["bytes", { bytes: PROVISIONAL_LIMITS.maxLocalBytes + 1 }],
    ["batch", { batchSize: PROVISIONAL_LIMITS.maxLocalBatch + 1 }],
  ];
  for (const [label, overrides] of cases) {
    const decision = decideRoute(request(overrides));
    assert.equal(decision.route, "cloud_cpu", `${label} should force the cloud route`);
  }
});

test("a low core count forces the cloud route", () => {
  const weak = detectCapabilities(
    capableHost({ navigator: { hardwareConcurrency: 2, deviceMemory: 8, userAgent: "x", maxTouchPoints: 0 } }) as never,
  );
  assert.equal(decideRoute(request({ capabilities: weak })).route, "cloud_cpu");
});

test("unreported device memory never counts against a device", () => {
  // deviceMemory is Chromium-only. Treating absence as unsuitable would push
  // every Firefox and Safari user to the cloud for no reason.
  const noMemoryHint = detectCapabilities(
    capableHost({ navigator: { hardwareConcurrency: 8, userAgent: "Firefox", maxTouchPoints: 0 } }) as never,
  );
  assert.equal(noMemoryHint.deviceMemoryGiB, null);
  assert.equal(isWithinLocalLimits(request({ capabilities: noMemoryHint })).length, 0);
  assert.equal(decideRoute(request({ capabilities: noMemoryHint })).route, "browser_local");
});

test("a request at exactly the limit is still local", () => {
  const atLimit = request({
    pixels: PROVISIONAL_LIMITS.maxLocalPixels,
    bytes: PROVISIONAL_LIMITS.maxLocalBytes,
    batchSize: PROVISIONAL_LIMITS.maxLocalBatch,
  });
  assert.equal(isWithinLocalLimits(atLimit).length, 0);
  assert.equal(decideRoute(atLimit).route, "browser_local");
});

test("exceeded limits are reported individually", () => {
  const exceeded = isWithinLocalLimits(request({ pixels: 99_000_000, bytes: 99_000_000, batchSize: 50 }));
  assert.equal(exceeded.length, 3, "each exceeded limit should be reported separately");
});

test("the provisional limits are flagged as unmeasured", () => {
  // O-003: the real thresholds come from measurement. Until then, every local
  // decision has to say so, or a reader will mistake a guess for a finding.
  assert.ok(decideRoute(request()).reasons.some((r) => r.includes("provisional")));
});
