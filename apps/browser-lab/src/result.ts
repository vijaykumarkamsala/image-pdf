/**
 * Build a benchmark result the Python runner can read.
 *
 * POC-005's acceptance criterion is that results "can be compared with the server
 * baseline". That requires more than a similar-looking JSON file: it requires the
 * *same contract*, the *same identifier rules*, and the same honesty about what
 * the result is.
 *
 * Three things this file is careful about:
 *
 * 1. **Identifiers are computed with the shared implementation**, so a browser
 *    result and a server result describing the same work carry the same
 *    `result_id`. That is what makes them comparable rather than merely similar.
 * 2. **Every duration is an integer nanosecond.** `performance.now()` returns
 *    fractional milliseconds; a float would be refused by the canonicaliser, and
 *    rightly so.
 * 3. **Output is labelled a preview.** Canvas offers no choice of resampling
 *    kernel, so browser output will not match the server's. Calling it a final
 *    result would be a false claim (AGENTS.md product invariants).
 */

import type {
  AssetResult,
  Measurement,
  ProcessorIdentity,
  ResultIdentity,
} from "ipw-contracts-ts";
import { SCHEMA_VERSION, resultIdOf } from "ipw-contracts-ts";

import type { Capabilities } from "./capability.ts";
import type { RouteDecision } from "./routing.ts";
import type { WorkerResponse } from "./worker.ts";

export const LAB_VERSION = "0.1.0";

/**
 * Identity of the browser as a processor.
 *
 * `deterministic_output: false` is a measured claim, not caution. Canvas
 * resampling is implementation-defined and varies between browsers and even GPU
 * drivers, so two runs on different devices legitimately differ. Declaring it
 * false means every result carries the nondeterministic label the reproducibility
 * rules require.
 */
export function browserProcessorIdentity(capabilities: Capabilities): ProcessorIdentity {
  return {
    name: "standard-browser-canvas",
    version: LAB_VERSION,
    family: "standard",
    runtime: {
      language: "typescript",
      language_version: LAB_VERSION,
      framework: "canvas-2d",
      framework_version: capabilities.userAgent,
      container_image: null,
      container_digest: null,
      dependency_lock_digest: null,
    },
    weights: null,
    precision: "na",
    tile_size: null,
    tile_overlap: null,
    requires_network: false,
    deterministic_output: false,
    supported_operations: ["resize", "crop", "rotate", "flip"],
    licence_ref: "standard-browser-canvas",
  };
}

export interface BuildResultInput {
  runId: string;
  assetId: string;
  inputSha256: string;
  inputBytes: number;
  operationKind: "resize" | "crop" | "rotate" | "flip";
  settings: Record<string, unknown>;
  response: WorkerResponse;
  route: RouteDecision;
  startedAt: string;
  finishedAt: string;
}

/** Assemble one `AssetResult`, identifier included. */
export async function buildAssetResult(input: BuildResultInput): Promise<AssetResult> {
  const identity: ResultIdentity = {
    schema_version: SCHEMA_VERSION,
    run_id: input.runId,
    asset_id: input.assetId,
    input_sha256: input.inputSha256,
    operation_kind: input.operationKind,
    // Browser output is a preview by default; the variant records that plainly.
    variant: input.route.eligibleAsFinal
      ? "standard_server_authoritative"
      : "standard_browser_preview",
    effective_settings: {
      kind: input.operationKind,
      ...input.settings,
    } as ResultIdentity["effective_settings"],
  };

  const resultId = await resultIdOf(identity as unknown as Record<string, unknown>);
  const response = input.response;

  const measurement: Measurement = {
    timing: {
      queue_wait_ns: 0,
      cold_start_ns: 0,
      preprocess_ns: response.ok ? response.phases.decodeNs : 0,
      inference_ns: response.ok ? response.phases.operationNs : 0,
      postprocess_ns: response.ok ? response.phases.encodeNs : 0,
      total_ns: response.ok ? response.phases.totalNs : 0,
      cold_or_warm: "unknown",
    },
    memory: {
      peak_rss_bytes: 0,
      peak_vram_bytes: null,
      // Stated rather than guessed. No browser API reports per-operation memory:
      // performance.memory is Chromium-only, heap-only, and coarse. Reporting a
      // fabricated figure would be worse than reporting none.
      measurement_method: "not_measured_browser_provides_no_per_operation_api",
    },
    cost: {
      currency: "USD",
      compute: "0",
      model_load_allocation: "0",
      temporary_storage: "0",
      retained_storage_allocation: "0",
      output_bandwidth: "0",
      external_provider_fee: "0",
      payment_overhead_allocation: "0",
      total: "0",
      // Local work consumes the customer's device, not our infrastructure. Zero
      // is the correct direct cost, and that asymmetry is itself a finding for
      // the POC-014 cost model.
      basis: "local_device_no_direct_infrastructure_cost",
    },
    input_bytes: input.inputBytes,
    output_bytes: response.ok ? response.outputBytes : 0,
    input_width: null,
    input_height: null,
    output_width: response.ok ? response.width : null,
    output_height: response.ok ? response.height : null,
    retry_count: 0,
  };

  if (!response.ok) {
    return {
      result_id: resultId,
      identity,
      state: "failed",
      attempt: 1,
      output: null,
      measurement,
      failure: {
        code: response.code as never,
        category: "permanent_processing",
        severity: "error",
        retryable: false,
        next_action: "alternate_route",
        message: response.message,
        pointer: null,
        context: { engine: "canvas-2d" },
        remediation: "Retry in the cloud; the browser route could not complete this operation.",
      },
      nondeterministic: true,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
    };
  }

  return {
    result_id: resultId,
    identity,
    state: "succeeded",
    attempt: 1,
    output: {
      relative_path: `browser-result-${input.assetId}.png`,
      sha256: response.outputSha256,
      bytes_written: response.outputBytes,
      media_type: "image/png",
      width: response.width,
      height: response.height,
      // The whole point: Canvas resampling is implementation-defined, so this is
      // not the authoritative render and must never be presented as one.
      is_preview: !input.route.eligibleAsFinal,
    },
    measurement,
    failure: null,
    nondeterministic: true,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
  };
}

/** Limitations that must travel with every browser run. */
export const BROWSER_LIMITATIONS: readonly string[] = [
  "Work stops when the tab is closed. Local processing cannot promise background continuation, so anything that must survive closure is routed to the cloud (D-019).",
  "A backgrounded tab is throttled by the browser; timings taken while hidden are not comparable and are marked as such.",
  "A refresh discards all in-memory state. The lab holds nothing across reloads by design - persisting customer images in the browser is a privacy decision nobody has taken.",
  "Canvas resampling is implementation-defined and differs between browsers and GPU drivers, so output is not byte-comparable with the server baseline. Compare timings and dimensions, not hashes.",
  "No browser API reports per-operation memory. peak_rss_bytes is recorded as 0 with the method stated, rather than fabricated.",
  "Web Crypto requires a secure context: the lab must be served over http://localhost or https, never opened as a file:// URL.",
] as const;
