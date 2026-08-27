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
  /** A job chosen on the landing page, honoured once a file is open. */
  pendingJob: null,
  /** Extra images queued to follow this one into a PDF. */
  extraImages: [],
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
  if (!on) stopClock();
}

/* A running clock for work that takes long enough to look broken.
 *
 * Measured on this machine: a 4x upscale of a small image is 68 seconds and a
 * JPEG repair is over two minutes, both on CPU. A static "takes a moment" is
 * worse than nothing at that length - the one thing a person needs to know is
 * that something is still happening, and a number that keeps moving says it
 * where a spinner does not.
 */
let clockTimer = null;

function startClock(label) {
  stopClock();
  const started = Date.now();
  const tick = () => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const shown = seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    $("busy-text").textContent = `${label} — ${shown}`;
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

function stopClock() {
  if (clockTimer !== null) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

const bytes = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
  : n >= 1024 ? `${Math.round(n / 1024)} KB`
  : `${n} B`;

/* -------------------------------------------------------------------- load */

/** Put a file where the server can reach it, without sending it to the server.
 *
 * The API signs a URL, the browser PUTs to it, and only the object name comes
 * back here. A hundred-megabyte design sheet never enters the API process, and
 * the request that later processes it is a couple of hundred bytes whatever the
 * file weighs.
 *
 * If anything about that fails - no bucket, no network to storage, a signature
 * the browser cannot use - the caller falls back to sending the file inline.
 * A slower path that works beats a faster one that sometimes does not.
 */
async function uploadDirect(file, onProgress) {
  const signed = await api("/api/uploads/sign", {
    filename: file.name,
    content_type: file.type || "application/octet-stream",
  });

  await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(signed.method, signed.url, true);
    for (const [name, value] of Object.entries(signed.headers || {})) {
      request.setRequestHeader(name, value);
    }
    // fetch() cannot report upload progress; XMLHttpRequest can. For a file
    // large enough to need this path, a progress bar is the difference between
    // waiting and wondering whether it has hung.
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve(null)
        : reject(new Error(`upload failed (${request.status})`));
    request.onerror = () => reject(new Error("the upload could not reach storage"));
    request.send(file);
  });

  return signed.object;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsDataURL(file);
  });
}

/** How to tell the API which image to work on.
 *
 * Prefers the object name, so nothing large is re-encoded on every edit. Falls
 * back to the data URL when there is no object - a direct upload that failed,
 * or a result that came back inline.
 */
function sourceRef(extra = {}) {
  const current = state.current;
  return current.object
    ? { object: current.object, ...extra }
    : { image: current.dataUrl, ...extra };
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
    // The data URL is for the screen only. What the API is told about is the
    // object, so the file itself never travels through it.
    const dataUrl = await readFile(file);

    let object = null;
    try {
      busy(true, "Uploading…");
      object = await uploadDirect(file, (percent) => busy(true, `Uploading… ${percent}%`));
    } catch (error) {
      // Falling back rather than failing: a workspace that cannot reach storage
      // should still edit a photograph, just with the old size ceiling.
      console.warn("direct upload unavailable, sending inline:", error.message);
      object = null;
    }

    state.original = { dataUrl, object, bytes: file.size, name: file.name, type: file.type };
    state.current = { dataUrl, object, bytes: file.size, mediaType: file.type };
    state.past = [];
    state.applied = [];

    busy(true, "Reading…");
    // Inspection happens before anything else, exactly as the pipeline does it:
    // headers only, no pixels decoded, so a hostile file is refused cheaply.
    const facts = await api("/api/inspect", sourceRef({ filename: file.name }));
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
    // The tools are built here, not at boot: their controls are seeded from the
    // image's own width and height. Building them with nothing loaded threw,
    // and because that throw happened during start-up the whole tool panel
    // stayed empty for the entire session - which looked like an interface
    // missing its features rather than a crash.
    renderTools();
    await refreshPrintPlan();
    toast(`${file.name} loaded`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy(false);
  }

  applyPendingJob();
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

  if (op.speed === "slow") {
    // Honest about the length. "A moment" for something that runs over a
    // minute on CPU is how a working operation gets reported as a hang.
    busy(true, `${op.label}…`);
    startClock(`${op.label} — running a model, this can take a minute or two`);
  } else {
    busy(true, `${op.label}…`);
  }

  try {
    const result = await api("/api/process", sourceRef({
      operation: kind,
      settings: settingsFor(op),
      filename: state.original.name,
    }));

    if (!result.ok) {
      const f = result.failure || {};
      toast(f.remediation ? `${f.message} — ${f.remediation}` : (f.message || "That did not work"), true);
      return;
    }

    state.past.push({ ...state.current });
    // A result arrives one of two ways. Small ones come back inline; large ones
    // are written to storage and come back as a link, so the response carries no
    // image data at all. Both have to be displayable, and both have to be usable
    // as the input to the next edit - which is why the object name is kept:
    // chaining five edits should not re-upload the file five times.
    state.current = {
      dataUrl: result.image || result.download_url,
      object: result.object || null,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      mediaType: result.media_type,
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
      images: [
        state.current.object
          ? { object: state.current.object, filename: state.original.name }
          : { image: state.current.dataUrl, filename: state.original.name },
      ],
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
    const result = await api("/api/vectorise", sourceRef({
      filename: state.original.name,
      mode: $("vec-mode").value,
      colours: Number($("vec-colours").value) || 6,
      detail: Number($("vec-detail").value) || 1,
      smoothness: Number($("vec-smoothness").value),
      clean: Number($("vec-clean").value) || 0,
      also_pdf: true,
      page_size: $("pdf-size").value || null,
    }));

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
  $("btn-reset").addEventListener("click", reset);
  $("print-inches").addEventListener("change", refreshPrintPlan);
  $("print-dpi").addEventListener("change", refreshPrintPlan);

  wireTasks();
  wireExport();
  wirePalette();
  wireJobs();
}

/* Jobs, not tools.
 *
 * Somebody arriving with "this PDF is too big for the portal" should not have
 * to work out that the answer lives under Size. Each of these picks the file
 * and lands on the task, so the first click is about their problem rather than
 * about our menu.
 */
function wireJobs() {
  for (const button of document.querySelectorAll(".job")) {
    button.addEventListener("click", () => {
      state.pendingJob = button.dataset.job;
      $("file").click();
    });
  }
}

/* Called once a file is open, to honour whatever job was chosen on the way in. */
function applyPendingJob() {
  const job = state.pendingJob;
  state.pendingJob = null;
  if (!job) return;

  const imagePanel = document.querySelector(".panel:not(.pdf-panel)");
  const pdfPanel = document.querySelector(".pdf-panel");
  const isPdf = !$("pdfspace").hidden;

  if (job === "smaller") {
    if (isPdf) showTask(pdfPanel, "size");
    else showTask(imagePanel, "export");
  } else if (job === "redact") {
    if (isPdf) showTask(pdfPanel, "protect");
    else toast("Removing text needs a PDF. This is an image.", true);
  } else if (job === "searchable") {
    if (isPdf) showTask(pdfPanel, "content");
    else toast("Making a scan searchable needs a PDF. This is an image.", true);
  } else if (job === "vector") {
    if (isPdf) {
      toast("Turning artwork into a cut file needs an image, not a PDF.", true);
    } else {
      showTask(imagePanel, "export");
      $("export-format").value = "image/svg+xml";
      $("export-format").dispatchEvent(new Event("change"));
    }
  }
}

/* --------------------------------------------------------- command palette */

/* Search, rather than another row of buttons.
 *
 * The brief is that features keep being added. Every arrangement of visible
 * controls degrades as that happens - a longer panel, a deeper menu, a second
 * toolbar. A search box does not: the fiftieth action is found by the same
 * three keystrokes as the first, and it costs no screen space at all.
 *
 * It also answers a question no menu can. Somebody thinking "I need to get a
 * name out of this" does not know whether that lives under Content, Protect or
 * Pages, and typing "name" finds it without them having to learn the map.
 */
function wirePalette() {
  const box = $("cmdk");
  const input = $("cmdk-input");
  const list = $("cmdk-list");
  const empty = $("cmdk-empty");
  let commands = [];
  let cursor = 0;

  const open = () => {
    commands = collectCommands();
    box.hidden = false;
    input.value = "";
    render("");
    input.focus();
  };

  const close = () => {
    box.hidden = true;
  };

  function render(query) {
    const needle = query.trim().toLowerCase();
    const shown = needle
      ? commands.filter((command) =>
          `${command.label} ${command.where} ${command.keywords || ""}`
            .toLowerCase()
            .includes(needle))
      : commands;

    cursor = 0;
    list.innerHTML = shown
      .map((command, index) =>
        `<li data-index="${index}" class="${index === 0 ? "is-on" : ""}">` +
        `<span>${command.label}</span><span class="where">${command.where}</span></li>`)
      .join("");
    empty.hidden = shown.length > 0;
    list.dataset.shown = JSON.stringify(shown.map((c) => c.id));
  }

  function runAt(index) {
    const ids = JSON.parse(list.dataset.shown || "[]");
    const chosen = commands.find((command) => command.id === ids[index]);
    if (!chosen) return;
    close();
    chosen.run();
  }

  $("cmd-trigger").addEventListener("click", open);
  input.addEventListener("input", () => render(input.value));

  box.addEventListener("click", (event) => {
    if (event.target === box) close();
    const row = event.target.closest("li[data-index]");
    if (row) runAt(Number(row.dataset.index));
  });

  input.addEventListener("keydown", (event) => {
    const rows = list.querySelectorAll("li");
    if (event.key === "Escape") { close(); return; }
    if (event.key === "Enter") { event.preventDefault(); runAt(cursor); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    event.preventDefault();
    if (!rows.length) return;
    cursor = event.key === "ArrowDown"
      ? Math.min(cursor + 1, rows.length - 1)
      : Math.max(cursor - 1, 0);
    rows.forEach((row, index) => row.classList.toggle("is-on", index === cursor));
    rows[cursor].scrollIntoView({ block: "nearest" });
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      box.hidden ? open() : close();
    }
  });
}

/* What the palette can reach right now.
 *
 * Rebuilt each time it opens rather than cached, because what is possible
 * depends on what is loaded: a PDF has no resize, an image has no page order,
 * and offering either would be a menu that lies.
 */
function collectCommands() {
  const found = [];
  const visible = (id) => {
    const element = document.getElementById(id);
    return element && !element.hidden;
  };

  if (visible("workspace") && state.catalogue) {
    for (const group of state.catalogue.groups) {
      for (const operation of group.operations) {
        if (operation.needs_model && operation.available === false) continue;
        found.push({
          id: `op:${operation.kind}`,
          label: operation.label,
          where: group.label,
          keywords: operation.summary,
          run: () => {
            showTask(document.querySelector(".panel"), "edit");
            const card = document.querySelector(`[data-kind="${operation.kind}"]`);
            card?.closest(".tool-group")?.classList.add("is-open");
            card?.scrollIntoView({ block: "center", behavior: "smooth" });
            card?.focus?.();
          },
        });
      }
    }

    const panel = document.querySelector(".panel");
    found.push(
      { id: "task:print", label: "Print size", where: "Prepare",
        keywords: "dpi inches banner fabric engraving",
        run: () => showTask(panel, "print") },
      { id: "task:export", label: "Export", where: "Finish",
        keywords: "download save jpeg png pdf svg vector cut file",
        run: () => showTask(panel, "export") },
    );
  }

  if (visible("pdfspace")) {
    const panel = document.querySelector(".pdf-panel");
    found.push(
      { id: "pdf:pages", label: "Combine or reorder pages", where: "Pages",
        keywords: "merge join split delete rotate order",
        run: () => showTask(panel, "pages") },
      { id: "pdf:searchable", label: "Make a scan searchable", where: "Content",
        keywords: "ocr recognise read words text layer",
        run: () => showTask(panel, "content") },
      { id: "pdf:stamp", label: "Stamp text over the pages", where: "Content",
        keywords: "draft sample confidential watermark",
        run: () => showTask(panel, "content") },
      { id: "pdf:redact", label: "Remove a name or number", where: "Protect",
        keywords: "redact delete sensitive personal gdpr disclosure",
        run: () => showTask(panel, "protect") },
      { id: "pdf:compress", label: "Make the file smaller", where: "Size",
        keywords: "compress shrink megabytes portal email limit",
        run: () => showTask(panel, "size") },
    );
  }

  found.push({
    id: "app:reset", label: "Start over with another file", where: "Workspace",
    keywords: "clear reset new upload",
    run: () => reset(),
  });

  return found;
}

/* ------------------------------------------------------------------ tasks */

/* One pane at a time.
 *
 * The panel used to stack print settings, PDF export, vector conversion and
 * every tool group in one column, all open. That is unreadable at today's
 * feature count and gets worse with each one added, so a task is chosen and
 * only its controls are shown. Adding the fiftieth feature adds an entry to a
 * list; it does not add another screen's worth of scrolling.
 */
function wireTasks() {
  for (const nav of document.querySelectorAll(".tasknav")) {
    const scope = nav.parentElement;
    nav.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-task]");
      if (!button) return;
      showTask(scope, button.dataset.task);
    });
  }
}

function showTask(scope, task) {
  if (!scope) return;
  for (const button of scope.querySelectorAll(".tasknav button")) {
    button.classList.toggle("is-active", button.dataset.task === task);
  }
  for (const pane of scope.querySelectorAll(".taskpane")) {
    pane.hidden = pane.dataset.pane !== task;
  }
}

/* ----------------------------------------------------------------- export */

/* Format is the customer's choice, not a conversion the tool decides on.
 *
 * There used to be a "Make a PDF" block and a separate "Convert to vector"
 * block, which implied those were the destinations. They are two of four, and
 * a JPEG staying a JPEG is the commonest answer of all.
 */
function wireExport() {
  const format = $("export-format");
  const update = () => {
    const value = format.value;
    $("export-pdf-options").hidden = value !== "application/pdf";
    $("export-svg-options").hidden = value !== "image/svg+xml";
    $("export-quality-wrap").hidden = value !== "image/jpeg";
  };
  format.addEventListener("change", update);
  update();

  $("btn-export").addEventListener("click", () => {
    const value = format.value;
    if (value === "application/pdf") return exportPdf();
    if (value === "image/svg+xml") return convertToVector();
    return exportImage(value);
  });

  $("btn-add-image").addEventListener("click", () => $("more-images").click());
  $("more-images").addEventListener("change", (event) => {
    const chosen = Array.from(event.target.files || []);
    if (!chosen.length) return;
    state.extraImages = chosen;
    const box = $("extra-images");
    box.hidden = false;
    box.textContent =
      `${chosen.length} more image${chosen.length === 1 ? "" : "s"} will follow this one ` +
      `in the document.`;
  });
}

/* Export the picture as itself, in the format asked for. */
async function exportImage(mediaType) {
  if (state.busy || !state.current) return;
  const label = mediaType === "image/png" ? "PNG" : "JPEG";
  busy(true, `Preparing the ${label}…`);
  try {
    const result = await api("/api/process", sourceRef({
      operation: "convert",
      settings: {
        target_media_type: mediaType,
        quality: Number($("export-quality").value) || 88,
      },
      filename: state.original.name,
    }));

    if (!result.ok) {
      const failure = result.failure || {};
      toast(failure.message || "That did not work", true);
      return;
    }

    const stem = (state.original.name || "image").replace(/\.[^.]+$/, "");
    const link = document.createElement("a");
    link.href = result.image || result.download_url;
    link.download = `${stem}.${mediaType === "image/png" ? "png" : "jpg"}`;
    link.click();
    toast(`${label} ready — ${bytes(result.bytes)}`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy(false);
  }
}

async function start() {
  pdfView.init({ api, toast, busy, bytes, uploadDirect });
  batchView.init({
    api,
    toast,
    busy,
    bytes,
    uploadDirect,
    catalogue: () => state.catalogue,
    findOperation,
    control,
    settingsFor,
  });
  wire();
  pdfView.wire();
  batchView.wire();
  // The catalogue is fetched at boot; the tool controls are not built until
  // there is a file to build them for. `toolControls` reads the current image's
  // width to seed the resize and crop fields, so rendering with nothing loaded
  // threw "Cannot read properties of null" - which the catch below then
  // reported as the service being unreachable, sending anyone who saw it to
  // check a server that was answering perfectly.
  try {
    state.catalogue = await api("/api/catalogue");
  } catch (error) {
    toast(`Could not reach the workspace service: ${error.message}`, true);
    return;
  }

  // Separate catch: a failure to draw the tools is a bug in this file, and
  // saying "could not reach the service" about it wastes the first hour of
  // anybody debugging it.
  try {
    if (state.current) renderTools();
  } catch (error) {
    toast(`The tools could not be drawn: ${error.message}`, true);
  }
}

start();
