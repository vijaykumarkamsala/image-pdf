/**
 * Lab UI glue.
 *
 * Holds no logic worth testing - capability detection, routing and result
 * assembly all live in tested modules. This file's only job is to move data
 * between the DOM and a Worker, and to keep the main thread free while it happens.
 *
 * The responsiveness claim in POC-005's acceptance criteria is not asserted here;
 * it is *demonstrated*. A counter ticks on a `requestAnimationFrame` loop
 * throughout the measurement, and the number of frames it managed is reported. If
 * the main thread were blocked, the count would stall visibly and the number
 * would say so.
 */

import { SCHEMA_VERSION, runIdOf } from "ipw-contracts-ts";

import { describeCapabilities, detectCapabilities, missingEssentials } from "./capability.ts";
import { decideRoute, type RoutingInput } from "./routing.ts";
import { BROWSER_LIMITATIONS, browserProcessorIdentity, buildAssetResult } from "./result.ts";
import type { WorkerRequest, WorkerResponse } from "./worker.ts";

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element: ${id}`);
  return found as T;
};

const capabilities = detectCapabilities();
let latestResultJson: string | null = null;

// ------------------------------------------------------------- capability --

function renderCapabilities(): void {
  const rows: Array<[string, string, boolean | null]> = [
    ["Web Worker", capabilities.webWorker ? "yes" : "no", capabilities.webWorker],
    ["OffscreenCanvas", capabilities.offscreenCanvas ? "yes" : "no", capabilities.offscreenCanvas],
    ["createImageBitmap", capabilities.createImageBitmap ? "yes" : "no", capabilities.createImageBitmap],
    ["Web Crypto", capabilities.subtleCrypto ? "yes" : "no", capabilities.subtleCrypto],
    ["Secure context", capabilities.secureContext ? "yes" : "no", capabilities.secureContext],
    ["WebAssembly", capabilities.webAssembly ? "yes" : "no", capabilities.webAssembly],
    ["Logical cores", String(capabilities.hardwareConcurrency ?? "not reported"), null],
    ["Device memory", capabilities.deviceMemoryGiB ? `~${capabilities.deviceMemoryGiB} GiB` : "not reported (Chromium only)", null],
    ["Touch capable", capabilities.touchCapable ? "yes" : "no", null],
    ["User agent", capabilities.userAgent, null],
  ];

  element("capabilities").querySelector("tbody")!.innerHTML = rows
    .map(([label, value, good]) => {
      const cls = good === null ? "" : good ? "ok" : "bad";
      return `<tr><th>${label}</th><td class="${cls}">${escapeHtml(value)}</td></tr>`;
    })
    .join("");

  const missing = missingEssentials(capabilities);
  const essentials = element("essentials");
  if (missing.length === 0) {
    essentials.innerHTML = `<span class="pill ok">Local processing supported</span> ${escapeHtml(describeCapabilities(capabilities))}`;
    element<HTMLButtonElement>("run").disabled = false;
  } else {
    essentials.innerHTML =
      `<span class="pill bad">Local processing unavailable — use the cloud route</span><ul>` +
      missing.map((m) => `<li><code>${escapeHtml(m.capability)}</code> — ${escapeHtml(m.why)}</li>`).join("") +
      `</ul>`;
  }
}

function renderLimitations(): void {
  element("limitations").innerHTML = BROWSER_LIMITATIONS.map(
    (line) => `<li>${escapeHtml(line)}</li>`,
  ).join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

// -------------------------------------------------------------- the run ----

/**
 * Count animation frames while a promise runs.
 *
 * The evidence for "the UI remained responsive". A blocked main thread cannot
 * paint, so the frame count collapses toward zero and the report says so rather
 * than claiming responsiveness it did not verify.
 */
async function withFrameCounter<T>(work: () => Promise<T>): Promise<{ value: T; frames: number; elapsedMs: number }> {
  let frames = 0;
  let running = true;
  const started = performance.now();

  const tick = (): void => {
    if (!running) return;
    frames += 1;
    element("busy").textContent = `working… ${frames} frames painted (a responsive UI keeps painting)`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  try {
    const value = await work();
    return { value, frames, elapsedMs: performance.now() - started };
  } finally {
    running = false;
  }
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function runInWorker(request: WorkerRequest): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      worker.terminate();
      resolve(event.data);
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message || "worker failed"));
    });
    worker.postMessage(request);
  });
}

async function measure(file: File): Promise<void> {
  const status = element("status");
  status.textContent = `Measuring ${file.name}…`;
  element<HTMLButtonElement>("run").disabled = true;

  try {
    const bytes = await file.arrayBuffer();
    const inputSha256 = await sha256Hex(bytes);

    // Routed before any work: an unsuitable device must never be handed the job
    // just to discover it cannot cope.
    const routingInput: RoutingInput = {
      capabilities,
      family: "standard",
      // Pixel count is unknown until decode. The routing rules take a
      // conservative estimate from file size; POC-003's header inspection does
      // this properly server-side, and doing it here would duplicate that logic
      // in a second language for no benchmark benefit.
      pixels: Math.round(file.size / 3),
      bytes: file.size,
      batchSize: 1,
      needsDurableResult: false,
      needsAuthoritativeOutput: false,
    };
    const route = decideRoute(routingInput);
    renderRoute(route);

    if (route.route !== "browser_local") {
      status.innerHTML = `<span class="warn">Routed to the cloud — no local measurement taken.</span> ${escapeHtml(route.customerMessage)}`;
      return;
    }

    const startedAt = new Date().toISOString();
    const request: WorkerRequest = {
      id: "measurement-1",
      blob: file,
      operation: { kind: "resize", width: 512, height: 512 },
      outputType: "image/png",
      quality: 95,
    };

    const { value: response, frames, elapsedMs } = await withFrameCounter(() => runInWorker(request));
    const finishedAt = new Date().toISOString();

    const identity = browserProcessorIdentity(capabilities);
    const runId = await runIdOf({
      processor: identity.name,
      version: identity.version,
      operation: "resize",
      device: capabilities.userAgent,
    });

    const result = await buildAssetResult({
      runId,
      assetId: "browser-measurement",
      inputSha256,
      inputBytes: file.size,
      operationKind: "resize",
      settings: { algorithm: "canvas-high", target_width: 512, target_height: 512 },
      response,
      route,
      startedAt,
      finishedAt,
    });

    const document_ = {
      schema_version: SCHEMA_VERSION,
      processor: identity,
      capabilities,
      route,
      results: [result],
      responsiveness: {
        frames_painted: frames,
        wall_clock_ms: Math.round(elapsedMs),
        // The claim and the evidence, together.
        ui_remained_responsive: frames > 2,
      },
      limitations: BROWSER_LIMITATIONS,
    };

    latestResultJson = JSON.stringify(document_, null, 2);
    element("result").textContent = latestResultJson;
    element<HTMLButtonElement>("download").disabled = false;

    const verdict = frames > 2 ? `<span class="ok">UI stayed responsive</span>` : `<span class="bad">UI stalled</span>`;
    status.innerHTML = response.ok
      ? `Done in ${Math.round(elapsedMs)} ms. ${verdict} — ${frames} frames painted while working.`
      : `<span class="bad">Failed:</span> ${escapeHtml(response.message)}`;
  } catch (error) {
    status.innerHTML = `<span class="bad">Error:</span> ${escapeHtml(String(error))}`;
  } finally {
    element("busy").textContent = "";
    element<HTMLButtonElement>("run").disabled = false;
  }
}

function renderRoute(route: ReturnType<typeof decideRoute>): void {
  const badge = route.route === "browser_local" ? "ok" : "warn";
  element("route-summary").innerHTML =
    `<span class="pill ${badge}">${escapeHtml(route.customerMessage)}</span> ` +
    `<code>${escapeHtml(route.route)}</code> · ` +
    `final-eligible: <strong>${route.eligibleAsFinal ? "yes" : "no (preview)"}</strong> · ` +
    `override: <strong>${route.overrideAllowed ? "allowed" : "not allowed"}</strong>`;
  element("route-reasons").innerHTML = route.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
}

// ---------------------------------------------------------------- wiring ---

renderCapabilities();
renderLimitations();

element("run").addEventListener("click", () => {
  const file = element<HTMLInputElement>("file").files?.[0];
  if (!file) {
    element("status").textContent = "Choose a PNG or JPEG first.";
    return;
  }
  void measure(file);
});

element("download").addEventListener("click", () => {
  if (!latestResultJson) return;
  const blob = new Blob([latestResultJson], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = "browser-lab-result.json";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});
