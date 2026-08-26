/* Image & PDF Workspace - the interface.
 *
 * Plain ES modules, no build step. The browser lab (POC-005) is TypeScript
 * because it computes content-addressed identifiers that must agree with the
 * Python side byte for byte, and a type error there is a wrong measurement. This
 * app computes nothing: it renders what the API says and sends back what the
 * customer asked for. A build step would buy type-checking over `fetch` results
 * that are already validated server-side, and cost every future change a
 * compile.
 *
 * Two rules it follows without exception:
 *
 *   It never states a fact it was not given. Dimensions, timings, warnings and
 *   availability all come from the API. When something is unknown the interface
 *   says so rather than guessing, because a confident wrong number is worse than
 *   an honest gap - especially for someone about to commit a design to fabric.
 *
 *   It never applies an AI operation the customer did not choose. The AI group is
 *   collapsed by default, visually distinct, and every operation that can invent
 *   detail says so on its own control.
 */

import * as batchView from "./batch-view.js";
import * as pdfView from "./pdf-view.js";

const $ = (id) => document.getElementById(id);

const state = {
  /** The untouched upload. Every edit chain starts here. */
  original: null,     // { dataUrl, bytes, name, type }
  /** What the customer is looking at now. Edits compose on this. */
  current: null,      // { dataUrl, width, height, bytes, mediaType }
  /** Undo stack of previous `current` values. */
  past: [],
  applied: [],
  catalogue: null,
  facts: null,
  busy: false,
};

/* ------------------------------------------------------------------ helpers */

async function api(route, payload) {
  const response = await fetch(route, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const document_ = await response.json().catch(() => ({
    ok: false,
    error: `the server returned ${response.status} and no JSON`,
  }));
  if (!response.ok && document_.error) throw new Error(document_.error);
  return document_;
}

function toast(message, bad = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("is-bad", bad);
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, bad ? 6500 : 3200);
}

function busy(on, text = "Working…") {
  state.busy = on;
  $("busy").hidden = !on;
  $("busy-text").textContent = text;
  document.querySelectorAll(".apply").forEach((b) => { b.disabled = on; });
}

const bytes = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
  : n >= 1024 ? `${Math.round(n / 1024)} KB`
  : `${n} B`;

/* -------------------------------------------------------------------- load */

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsDataURL(file);
  });
}

async function load(file, all = null) {
  if (!file) return;

  // Several files at once is a batch, of images or of documents. Silently
  // taking the first one and ignoring the rest is the kind of thing that loses
  // somebody an afternoon.
  if (all && batchView.batchKindOf(all)) {
    await batchView.open(all);
    return;
  }

  // A PDF is not a failed image; it is the other half of the product.
  if (pdfView.isPdf(file)) {
    await pdfView.open(file);
    return;
  }

  if (!/^image\/(jpeg|png)$/.test(file.type)) {
    toast("That format is not supported yet. Please use a JPEG, PNG or PDF.", true);
    return;
  }

  busy(true, "Reading…");
  try {
    const dataUrl = await readFile(file);
    state.original = { dataUrl, bytes: file.size, name: file.name, type: file.type };
    state.current = { dataUrl, bytes: file.size, mediaType: file.type };
    state.past = [];
    state.applied = [];

    // Inspection happens before anything else, exactly as the pipeline does it:
    // headers only, no pixels decoded, so a hostile file is refused cheaply.
    const facts = await api("/api/inspect", { image: dataUrl, filename: file.name });
    state.facts = facts;

    if (!facts.accepted) {
      const why = facts.failure ? facts.failure.message : "this file cannot be processed";
      toast(`${why}${facts.failure?.remediation ? " " + facts.failure.remediation : ""}`, true);
      state.original = null;
      return;
    }

    state.current.width = facts.width;
    state.current.height = facts.height;

    $("intake").hidden = true;
    $("workspace").hidden = false;
    $("btn-download").hidden = false;
    $("btn-reset").hidden = false;

    renderFacts();
    renderImages();
    await refreshPrintPlan();
    toast(`${file.name} loaded`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy(false);
  }
}

/* ------------------------------------------------------------------ render */

function renderFacts() {
  const f = state.facts;
  const c = state.current;
  const rows = [
    ["Size", `${c.width} × ${c.height}`],
    ["Megapixels", f.megapixels],
    ["Format", (c.mediaType || "").replace("image/", "").toUpperCase()],
    ["File", bytes(c.bytes)],
    ["Handling", f.decision],
  ];

  let html = rows
    .map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");

  // Risk flags are shown, not hidden. A colour profile we do not manage is
  // exactly the kind of thing that surprises someone at the printer.
  if (f.risk_flags?.length) {
    html += `<div class="flagset">${f.risk_flags
      .map((flag) => `<span class="flag">${flag.replace(/_/g, " ")}</span>`)
      .join("")}</div>`;
  }
  $("facts").innerHTML = `<dl style="margin:0;display:grid;gap:7px">${html}</dl>`;
}

function renderImages() {
  const c = state.current, o = state.original;
  $("img-result").src = c.dataUrl;
  $("img-original").src = o.dataUrl;
  $("split-a").src = o.dataUrl;
  $("split-b").src = c.dataUrl;
  $("canvas-meta").textContent =
    `${c.width} × ${c.height} · ${bytes(c.bytes)}` +
    (state.applied.length ? ` · ${state.applied.length} edit${state.applied.length > 1 ? "s" : ""}` : "");

  $("history").hidden = state.applied.length === 0;
  $("history-list").innerHTML = state.applied
    .map((a) => `<li class="${a.usedModel ? "is-ai" : ""}">${a.label}</li>`)
    .join("");
  $("btn-undo").disabled = state.past.length === 0;
}

/* -------------------------------------------------------------- print plan */

async function refreshPrintPlan() {
  if (!state.current) return;
  const plan = await api("/api/print-plan", {
    width: state.current.width,
    height: state.current.height,
    target_inches: Number($("print-inches").value) || 0,
    dpi: Number($("print-dpi").value),
  });

  const headline = {
    ready: "Ready to print",
    ok: "Good to print",
    needs_upscale: "Needs upscaling",
    too_small: "Too small for this size",
  }[plan.verdict] || plan.verdict;

  $("print-verdict").className = `verdict is-${plan.verdict}`;
  $("print-verdict").innerHTML =
    `<strong>${headline}</strong>${plan.advice}` +
    `<div style="margin-top:6px;opacity:.85">Needs ${plan.required_pixels_on_longest_edge}px ` +
    `on the long edge — that is ${plan.required_scale}× this image.</div>`;
}

/* ------------------------------------------------------------------- tools */

function control(op, key, spec, prefix = "") {
  // The prefix keeps two views' controls apart. Without it the batch screen
  // and the single-image screen both emit an element called `adjust-contrast_percent`,
  // and whichever was rendered first silently answers for both.
  const id = `${prefix}${op.kind}-${key}`;
  const nice = key.replace(/_/g, " ").replace(/percent/, "");

  if (Array.isArray(spec) && spec.length === 2 && typeof spec[0] === "number"
      && (spec[0] < 0 || key.endsWith("percent") || key === "quality")) {
    const mid = key === "quality" ? 90 : 0;
    return `<div class="control">
      <label for="${id}">${nice}</label><output id="${id}-out">${mid}</output>
      <input id="${id}" type="range" min="${spec[0]}" max="${spec[1]}" value="${mid}"
             oninput="document.getElementById('${id}-out').textContent=this.value">
    </div>`;
  }
  if (Array.isArray(spec)) {
    return `<div class="control">
      <label for="${id}">${nice}</label>
      <select id="${id}">${spec.map((v) => `<option value="${v}">${v}</option>`).join("")}</select>
    </div>`;
  }
  return "";
}

function toolControls(op) {
  const hint = op.settings_hint || {};
  switch (op.kind) {
    case "resize":
      return `<div class="row">
          <div class="control"><label for="resize-w">width</label>
            <input id="resize-w" type="number" min="1" value="${state.current.width}"></div>
          <div class="control"><label for="resize-h">height</label>
            <input id="resize-h" type="number" min="1" value="${state.current.height}"></div>
        </div>${control(op, "algorithm", hint.algorithm)}`;
    case "crop":
      return `<div class="row">
          <div class="control"><label for="crop-x">left</label>
            <input id="crop-x" type="number" min="0" value="0"></div>
          <div class="control"><label for="crop-y">top</label>
            <input id="crop-y" type="number" min="0" value="0"></div>
          <div class="control"><label for="crop-w">width</label>
            <input id="crop-w" type="number" min="1" value="${Math.round(state.current.width / 2)}"></div>
          <div class="control"><label for="crop-h">height</label>
            <input id="crop-h" type="number" min="1" value="${Math.round(state.current.height / 2)}"></div>
        </div>`;
    case "rotate":
      return `<div class="control"><label for="rotate-deg">turn</label>
        <select id="rotate-deg">
          <option value="90">90° right</option><option value="180">180°</option>
          <option value="270">90° left</option></select></div>`;
    case "flip":
      return `<div class="control"><label for="flip-axis">direction</label>
        <select id="flip-axis">
          <option value="horizontal">horizontal</option>
          <option value="vertical">vertical</option></select></div>`;
    default:
      return Object.entries(hint).map(([k, v]) => control(op, k, v)).join("");
  }
}

function settingsFor(op, prefix = "") {
  const num = (id, fallback = 0) => Number($(`${prefix}${id}`)?.value ?? fallback);
  const val = (id) => $(`${prefix}${id}`)?.value;

  switch (op.kind) {
    case "resize":
      return { algorithm: val(`${op.kind}-algorithm`) || "lanczos",
               target_width: num("resize-w"), target_height: num("resize-h"),
               preserve_aspect_ratio: false };
    case "crop":
      return { x: num("crop-x"), y: num("crop-y"),
               width: num("crop-w"), height: num("crop-h") };
    case "rotate":
      return { degrees: num("rotate-deg", 90) };
    case "flip":
      return { axis: val("flip-axis") || "horizontal" };
    case "sharpen":
      return { amount_percent: 60 };
    case "denoise":
      return { strength_percent: 30 };
    case "adjust": {
      const s = {};
      for (const key of ["brightness_percent", "contrast_percent",
                         "exposure_percent", "saturation_percent"]) {
        const v = num(`adjust-${key}`, 0);
        if (v) s[key] = v;
      }
      const wb = val("adjust-white_balance");
      if (wb && wb !== "none") s.white_balance = wb;
      return s;
    }
    case "convert":
      return { target_media_type: val("convert-target_media_type") || "image/png",
               quality: num("convert-quality", 90) || 90 };
    case "super_resolution":
      return { scale: num(`${op.kind}-scale`, 4) || 4,
               mode: val(`${op.kind}-mode`) || "natural" };
    case "ai_denoise":
      return { noise_sigma: num(`${op.kind}-noise_sigma`, 15) || 15 };
    case "jpeg_artifact_repair":
      return { quality_target: num(`${op.kind}-quality_target`, 10) || 10 };
    default:
      return {};
  }
}

function renderTools() {
  const host = $("tools");
  host.innerHTML = "";

  for (const group of state.catalogue.groups) {
    const open = !group.is_ai;                 // AI is closed until asked for.
    const el = document.createElement("section");
    el.className = `tool-group ${group.is_ai ? "is-ai" : ""} ${open ? "is-open" : ""}`;

    el.innerHTML = `
      <button class="group-head" aria-expanded="${open}">
        <h2>${group.label} ${group.is_ai ? '<span class="ai-badge">AI</span>' : ""}</h2>
        <span class="chev">▸</span>
      </button>
      <div class="group-wrap" ${open ? "" : "hidden"}>
        <p class="group-note">${group.note}</p>
        <div class="group-body"></div>
      </div>`;

    const body = el.querySelector(".group-body");
    for (const op of group.operations) {
      const unavailable = op.needs_model && op.available === false;
      const tool = document.createElement("div");
      tool.className = `tool ${group.is_ai ? "is-ai" : ""}`;
      tool.innerHTML = `
        <div class="tool-top">
          <span class="tool-name">${op.label}</span>
          <span class="speed ${op.speed === "slow" ? "is-slow" : ""}">${
            op.speed === "slow" ? "takes a moment" : ""}</span>
        </div>
        <p class="tool-summary">${op.summary}</p>
        ${op.invents_detail
          ? '<p class="invents">May reconstruct detail that was not in your original.</p>' : ""}
        ${unavailable
          ? `<p class="unavailable">Not available here — ${op.reason || "not installed"}.</p>` : ""}
        ${op.licence && !op.licence.eligible_for_commercial_use && !unavailable
          ? '<p class="licence-note">Research use only — this model is not cleared for commercial output.</p>' : ""}
        <div class="controls">${unavailable ? "" : toolControls(op)}</div>
        ${unavailable ? "" : `<button class="apply" data-kind="${op.kind}">Apply ${op.label}</button>`}`;
      body.appendChild(tool);
    }

    el.querySelector(".group-head").addEventListener("click", () => {
      const wrap = el.querySelector(".group-wrap");
      const nowOpen = wrap.hidden;
      wrap.hidden = !nowOpen;
      el.classList.toggle("is-open", nowOpen);
      el.querySelector(".group-head").setAttribute("aria-expanded", String(nowOpen));
    });

    host.appendChild(el);
  }

  host.querySelectorAll(".apply").forEach((button) => {
    button.addEventListener("click", () => apply(button.dataset.kind));
  });
}

/* ------------------------------------------------------------------- apply */

function findOperation(kind) {
  for (const group of state.catalogue.groups) {
    const found = group.operations.find((o) => o.kind === kind);
    if (found) return found;
  }
  return null;
}

async function apply(kind) {
  if (state.busy) return;
  const op = findOperation(kind);
  if (!op) return;

  busy(true, op.speed === "slow"
    ? `${op.label}… this uses a model and takes a moment`
    : `${op.label}…`);

  try {
    const result = await api("/api/process", {
      operation: kind,
      settings: settingsFor(op),
      image: state.current.dataUrl,
      filename: state.original.name,
    });

    if (!result.ok) {
      const f = result.failure || {};
      toast(f.remediation ? `${f.message} — ${f.remediation}` : (f.message || "That did not work"), true);
      return;
    }

    state.past.push({ ...state.current });
    state.current = {
      dataUrl: result.image, width: result.width, height: result.height,
      bytes: result.bytes, mediaType: result.media_type,
    };
    state.applied.push({ label: op.label, usedModel: result.processor.used_a_model });

    renderImages();
    renderFacts();
    await refreshPrintPlan();
    toast(`${op.label} applied in ${result.took_ms} ms`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy(false);
  }
}

function undo() {
  const previous = state.past.pop();
  if (!previous) return;
  state.current = previous;
  state.applied.pop();
  renderImages();
  renderFacts();
  refreshPrintPlan();
  toast("Undone");
}

async function exportPdf() {
  if (state.busy || !state.current) return;
  busy(true, "Building the PDF…");
  try {
    const result = await api("/api/pdf", {
      images: [{ image: state.current.dataUrl, filename: state.original.name }],
      page_size: $("pdf-size").value || null,
      margin_mm: Number($("pdf-margin").value) || 0,
      title: (state.original.name || "").replace(/\.[^.]+$/, ""),
    });

    const page = result.pages[0];
    const box = $("pdf-result");
    // The class comes from the measured DPI, so the colour cannot disagree with
    // the number printed beside it.
    box.className = `pdf-result is-${page.print_quality === "soft" ? "soft" : "fine"}`;
    box.hidden = false;
    box.innerHTML =
      `<strong>${page.effective_dpi} DPI on ${page.page_label}</strong>${result.advice}` +
      `<span class="quality-note">${result.quality_note}</span>`;

    const a = document.createElement("a");
    a.href = result.pdf;
    a.download = `${(state.original.name || "document").replace(/\.[^.]+$/, "")}.pdf`;
    a.click();
    toast(`PDF ready — ${bytes(result.bytes)}`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy(false);
  }
}

/* --------------------------------------------------------------- vectorise */

async function convertToVector() {
  if (state.busy || !state.current) return;
  busy(true, "Tracing the shapes…");
  try {
    const result = await api("/api/vectorise", {
      image: state.current.dataUrl,
      filename: state.original.name,
      mode: $("vec-mode").value,
      colours: Number($("vec-colours").value) || 6,
      detail: Number($("vec-detail").value) || 1,
      smoothness: Number($("vec-smoothness").value),
      clean: Number($("vec-clean").value) || 0,
      also_pdf: true,
      page_size: $("pdf-size").value || null,
    });

    const report = result.report;
    const stem = (state.original.name || "artwork").replace(/\.[^.]+$/, "");
    const box = $("vec-result");

    // The SVG is shown inline rather than as a rendered image. The browser has a
    // correct SVG renderer; shipping a half-correct one here would produce a
    // preview that disagrees with the file the customer downloads.
    box.innerHTML = `
      <div class="vec-preview">${result.svg_text}</div>
      <p class="vec-advice">${escapeHtml(result.advice)}</p>
      <dl class="vec-stats">
        <div><dt>Colours</dt><dd>${report.colours}</dd></div>
        <div><dt>Shapes</dt><dd>${report.paths}</dd></div>
        <div><dt>Curves and lines</dt><dd>${report.segments}</dd></div>
        <div><dt>Traced in</dt><dd>${report.seconds}s</dd></div>
      </dl>
      ${report.palette.length ? `<div class="vec-swatches">${report.palette
        .map((c) => `<span class="swatch" style="background:${c.hex}" title="${c.hex} - ${c.paths} shape(s)"></span>`)
        .join("")}</div>` : ""}
      ${report.specks_dropped ? `<p class="meta">${report.specks_dropped} speck(s) of
        grain were ignored rather than traced as real shapes.</p>` : ""}
      <div class="vec-downloads">
        <a class="ghost small" download="${escapeHtml(stem)}.svg" href="${result.svg}">Download SVG</a>
        <a class="ghost small" download="${escapeHtml(stem)}-vector.pdf" href="${result.pdf}">Download PDF</a>
      </div>
      <p class="meta subtle">SVG opens in Illustrator, Inkscape, CorelDRAW, Cricut and
        every cutter and laser. The PDF carries the same paths for a print shop.</p>`;
    box.hidden = false;
    toast(`Traced into ${report.paths} shape(s) across ${report.colours} colour(s)`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy(false);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function download() {
  if (batchView.active()) { batchView.download(); return; }
  if (pdfView.active()) { pdfView.download(); return; }
  const a = document.createElement("a");
  const ext = (state.current.mediaType || "image/png").split("/")[1];
  const stem = (state.original.name || "image").replace(/\.[^.]+$/, "");
  a.href = state.current.dataUrl;
  a.download = `${stem}-edited.${ext}`;
  a.click();
}

function reset() {
  pdfView.reset();
  batchView.reset();
  state.original = null; state.current = null; state.past = []; state.applied = [];
  $("workspace").hidden = true;
  $("intake").hidden = false;
  $("btn-download").hidden = true;
  $("btn-reset").hidden = true;
  $("file").value = "";
}

/* ------------------------------------------------------------------- wire */

function wire() {
  const drop = $("drop"), file = $("file");
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); }
  });
  file.addEventListener("change", () => load(file.files[0], file.files));

  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("is-over"); });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove("is-over"); });
  }
  drop.addEventListener("drop", (e) =>
    load(e.dataTransfer?.files?.[0], e.dataTransfer?.files));

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      const view = tab.dataset.view;
      $("img-result").hidden = view !== "result";
      $("img-original").hidden = view !== "original";
      $("split").hidden = view !== "split";
    });
  });

  $("split-range").addEventListener("input", (e) => {
    $("split-b-wrap").style.width = `${e.target.value}%`;
  });

  $("btn-undo").addEventListener("click", undo);
  $("btn-download").addEventListener("click", download);
  $("btn-pdf").addEventListener("click", exportPdf);
  $("btn-vectorise").addEventListener("click", convertToVector);
  $("btn-reset").addEventListener("click", reset);
  $("print-inches").addEventListener("change", refreshPrintPlan);
  $("print-dpi").addEventListener("change", refreshPrintPlan);
}

async function start() {
  pdfView.init({ api, toast, busy, bytes });
  batchView.init({
    api,
    toast,
    busy,
    bytes,
    catalogue: () => state.catalogue,
    findOperation,
    control,
    settingsFor,
  });
  wire();
  pdfView.wire();
  batchView.wire();
  try {
    state.catalogue = await api("/api/catalogue");
    renderTools();
  } catch (error) {
    toast(`Could not reach the workspace service: ${error.message}`, true);
  }
}

start();
