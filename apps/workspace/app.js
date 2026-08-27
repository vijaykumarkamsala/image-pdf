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
    renderCanvasTools();
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
  const result = $("img-result");

  // Fit once the new pixels have arrived, not before: naturalWidth is 0 until
  // the image decodes, and fitting against 0 puts the picture in a corner at a
  // scale of one - which reads as "the zoom is broken" rather than "the image
  // has not loaded yet".
  const keepPlace = !view.fitted && result.src === c.dataUrl;
  result.onload = () => {
    $("zoombar").hidden = false;
    if (keepPlace) applyView();
    else zoomToFit();
  };

  result.src = c.dataUrl;
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
      // Compare stacks two images and slides a divider across them; a scale and
      // pan on top of that would fight its layout, so zooming stands down here.
      $("zoombar").hidden = view === "split";
      $("viewport").hidden = view === "split";
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
  wireZoom();
  wireCrop();
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

/* --------------------------------------------------------------- cropping */

/* A box dragged on the picture, not four numbers typed into a form.
 *
 * The selection is kept in *image* coordinates and drawn through the same
 * transform as the image, so it survives zooming and panning. That combination
 * is the part a phone cannot do: placing a crop edge on one thread of a garment
 * means being able to see that thread, which means being zoomed in while
 * dragging.
 *
 * The numeric fields stay bound to it in both directions. Dragging is how a
 * crop is found; typing is how it is repeated on the next forty files, and a
 * tool for production work has to support both.
 */
const crop = { on: false, box: null, drag: null };

function stageToImage(clientX, clientY) {
  const rect = $("stage").getBoundingClientRect();
  return {
    x: (clientX - rect.left - view.x) / view.scale,
    y: (clientY - rect.top - view.y) / view.scale,
  };
}

function clampToImage(box) {
  const image = $("img-result");
  const width = image.naturalWidth || 0;
  const height = image.naturalHeight || 0;
  const x = Math.max(0, Math.min(box.x, width));
  const y = Math.max(0, Math.min(box.y, height));
  return {
    x,
    y,
    width: Math.max(1, Math.min(box.width, width - x)),
    height: Math.max(1, Math.min(box.height, height - y)),
  };
}

function drawCrop() {
  const layer = $("crop-layer");
  const element = $("crop-box");
  if (!crop.on || !crop.box) {
    layer.hidden = true;
    return;
  }
  layer.hidden = false;
  const box = crop.box;
  element.style.left = `${view.x + box.x * view.scale}px`;
  element.style.top = `${view.y + box.y * view.scale}px`;
  element.style.width = `${box.width * view.scale}px`;
  element.style.height = `${box.height * view.scale}px`;
  $("crop-size").textContent =
    `${Math.round(box.width)} × ${Math.round(box.height)} px`;

  // Keep the typed fields honest while the box moves.
  const fields = { "crop-x": box.x, "crop-y": box.y,
                   "crop-w": box.width, "crop-h": box.height };
  for (const [id, value] of Object.entries(fields)) {
    const field = document.getElementById(id);
    if (field) field.value = String(Math.round(value));
  }
}

function startCropping() {
  const image = $("img-result");
  crop.on = true;
  // Open on the middle half, which is a visible starting box rather than an
  // invisible zero-sized one somebody has to discover by dragging.
  crop.box = clampToImage({
    x: image.naturalWidth * 0.25,
    y: image.naturalHeight * 0.25,
    width: image.naturalWidth * 0.5,
    height: image.naturalHeight * 0.5,
  });
  drawCrop();
}

function stopCropping() {
  crop.on = false;
  crop.box = null;
  crop.drag = null;
  $("crop-layer").hidden = true;
}

/* Typing moves the box, as well as the box filling in the typing.
 *
 * Dragging is how a crop is found. Typing is how the same crop is applied to
 * the next forty files, which is the difference between a photo app and
 * something used for production - so both directions have to work.
 */
function bindCropFields() {
  for (const id of ["crop-x", "crop-y", "crop-w", "crop-h"]) {
    const field = document.getElementById(id);
    if (!field) continue;
    field.addEventListener("input", () => {
      if (!crop.on) return;
      const read = (name, fallback) => {
        const value = Number(document.getElementById(name)?.value);
        return Number.isFinite(value) ? value : fallback;
      };
      crop.box = clampToImage({
        x: read("crop-x", crop.box.x),
        y: read("crop-y", crop.box.y),
        width: read("crop-w", crop.box.width),
        height: read("crop-h", crop.box.height),
      });
      // Redraw without writing the fields back, or the caret jumps mid-typing.
      const element = $("crop-box");
      element.style.left = `${view.x + crop.box.x * view.scale}px`;
      element.style.top = `${view.y + crop.box.y * view.scale}px`;
      element.style.width = `${crop.box.width * view.scale}px`;
      element.style.height = `${crop.box.height * view.scale}px`;
      $("crop-size").textContent =
        `${Math.round(crop.box.width)} × ${Math.round(crop.box.height)} px`;
      $("crop-layer").hidden = false;
    });
  }
}

function wireCrop() {
  const layer = $("crop-layer");
  if (!layer) return;

  layer.addEventListener("pointerdown", (event) => {
    const grip = event.target.closest(".crop-handle");
    const inside = event.target.closest(".crop-box");
    const at = stageToImage(event.clientX, event.clientY);

    if (grip) {
      crop.drag = { mode: "resize", grip: grip.dataset.grip, from: { ...crop.box } };
    } else if (inside) {
      crop.drag = { mode: "move", at, from: { ...crop.box } };
    } else {
      // A drag on bare canvas starts a fresh selection from that corner.
      crop.drag = { mode: "new", at };
      crop.box = { x: at.x, y: at.y, width: 1, height: 1 };
    }
    layer.setPointerCapture(event.pointerId);
    event.stopPropagation();
  });

  layer.addEventListener("pointermove", (event) => {
    if (!crop.drag) return;
    const at = stageToImage(event.clientX, event.clientY);
    const from = crop.drag.from;

    if (crop.drag.mode === "new") {
      const start = crop.drag.at;
      crop.box = clampToImage({
        x: Math.min(start.x, at.x),
        y: Math.min(start.y, at.y),
        width: Math.abs(at.x - start.x),
        height: Math.abs(at.y - start.y),
      });
    } else if (crop.drag.mode === "move") {
      crop.box = clampToImage({
        x: from.x + (at.x - crop.drag.at.x),
        y: from.y + (at.y - crop.drag.at.y),
        width: from.width,
        height: from.height,
      });
    } else {
      const right = from.x + from.width;
      const bottom = from.y + from.height;
      const grip = crop.drag.grip;
      const x = grip.includes("w") ? Math.min(at.x, right - 1) : from.x;
      const y = grip.includes("n") ? Math.min(at.y, bottom - 1) : from.y;
      crop.box = clampToImage({
        x,
        y,
        width: (grip.includes("e") ? Math.max(at.x, from.x + 1) : right) - x,
        height: (grip.includes("s") ? Math.max(at.y, from.y + 1) : bottom) - y,
      });
    }
    drawCrop();
  });

  for (const type of ["pointerup", "pointercancel"]) {
    layer.addEventListener(type, () => { crop.drag = null; });
  }
}

/* ---------------------------------------------------------------- zooming */

/* The inspection canvas.
 *
 * "I can edit faster on my phone" is true for cropping and brightness, and it
 * stops being true the moment somebody has to judge whether detail survives at
 * print size. A phone cannot show a 6000-pixel textile print at actual pixels
 * and let you walk around it; this can, and that is the reason to open it.
 *
 * The zoom is anchored at the pointer rather than the centre, because looking
 * closely at something means putting the cursor on it and scrolling - anchoring
 * at the centre makes the thing you were looking at run away from you.
 */
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 32;      // 3200%: past the point where a printer's dot matters
const ZOOM_STEP = 1.25;

const view = { scale: 1, x: 0, y: 0, fitted: true };

function applyView() {
  const viewport = $("viewport");
  if (!viewport) return;
  viewport.style.transform =
    `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;

  const stage = $("stage");
  stage.classList.toggle("is-zoomed", view.scale > 1.05);

  const label = $("zoom-level");
  if (label) label.textContent = view.fitted ? "Fit" : `${Math.round(view.scale * 100)}%`;

  renderZoomNote();
  drawCrop();
}

/* Fit the whole image in the stage, which is where every load starts. */
function zoomToFit() {
  const stage = $("stage");
  const image = $("img-result");
  if (!stage || !image || !image.naturalWidth) return;

  const pad = 40;
  const available = {
    width: Math.max(80, stage.clientWidth - pad),
    height: Math.max(80, stage.clientHeight - pad),
  };
  const scale = Math.min(
    available.width / image.naturalWidth,
    available.height / image.naturalHeight,
    1,
  );

  view.scale = scale;
  view.fitted = true;
  centre();
}

/* Actual pixels: one image pixel to one screen pixel, which is the only honest
 * view for judging sharpness. */
function zoomToActual() {
  view.scale = 1;
  view.fitted = false;
  centre();
}

function centre() {
  const stage = $("stage");
  const image = $("img-result");
  if (!stage || !image || !image.naturalWidth) return;
  view.x = (stage.clientWidth - image.naturalWidth * view.scale) / 2;
  view.y = (stage.clientHeight - image.naturalHeight * view.scale) / 2;
  applyView();
}

function zoomAt(factor, clientX, clientY) {
  const stage = $("stage");
  const rect = stage.getBoundingClientRect();
  const pointer = { x: clientX - rect.left, y: clientY - rect.top };

  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.scale * factor));
  if (next === view.scale) return;

  // Keep whatever is under the pointer under the pointer.
  view.x = pointer.x - (pointer.x - view.x) * (next / view.scale);
  view.y = pointer.y - (pointer.y - view.y) * (next / view.scale);
  view.scale = next;
  view.fitted = false;
  applyView();
}

/* What the zoom means in the real world.
 *
 * A print shop does not think in percentages; it thinks in inches at a DPI. At
 * actual pixels this says how big the image would print, which turns an
 * abstract number into the decision somebody is actually making.
 */
function renderZoomNote() {
  let note = document.getElementById("zoom-note");
  const image = $("img-result");
  if (!image || !image.naturalWidth || !state.current) {
    if (note) note.remove();
    return;
  }
  if (!note) {
    note = document.createElement("div");
    note.id = "zoom-note";
    note.className = "zoom-note";
    $("stage").append(note);
  }

  const dpi = Number($("print-dpi")?.value) || 300;
  const inches = image.naturalWidth / dpi;
  note.textContent =
    `${image.naturalWidth} × ${image.naturalHeight} px · ` +
    `${inches.toFixed(1)}in wide at ${dpi} DPI · ` +
    (view.scale >= 1
      ? `showing ${Math.round(view.scale * 100)}% of actual pixels`
      : `showing ${Math.round(view.scale * 100)}% — zoom in to judge sharpness`);
}

function wireZoom() {
  const stage = $("stage");
  if (!stage) return;

  stage.addEventListener("wheel", (event) => {
    if ($("split").hidden === false) return;   // the compare view has its own layout
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, event.clientX, event.clientY);
  }, { passive: false });

  let dragging = null;
  stage.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".canvas-tools, .tool-popover, .zoombar, .busy")) return;
    dragging = { x: event.clientX - view.x, y: event.clientY - view.y };
    stage.classList.add("is-panning");
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    view.x = event.clientX - dragging.x;
    view.y = event.clientY - dragging.y;
    applyView();
  });
  for (const type of ["pointerup", "pointercancel"]) {
    stage.addEventListener(type, () => {
      dragging = null;
      stage.classList.remove("is-panning");
    });
  }

  $("zoom-in").addEventListener("click", () =>
    zoomAt(ZOOM_STEP, stage.getBoundingClientRect().left + stage.clientWidth / 2,
           stage.getBoundingClientRect().top + stage.clientHeight / 2));
  $("zoom-out").addEventListener("click", () =>
    zoomAt(1 / ZOOM_STEP, stage.getBoundingClientRect().left + stage.clientWidth / 2,
           stage.getBoundingClientRect().top + stage.clientHeight / 2));
  $("zoom-fit").addEventListener("click", zoomToFit);
  $("zoom-100").addEventListener("click", zoomToActual);
  $("zoom-level").addEventListener("click", () =>
    (view.fitted ? zoomToActual() : zoomToFit()));

  // The shortcuts every image tool has, so the muscle memory transfers.
  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, select, textarea")) return;
    if ($("workspace").hidden) return;
    if (event.key === "0") { zoomToFit(); }
    else if (event.key === "1") { zoomToActual(); }
    else if (event.key === "+" || event.key === "=") {
      zoomAt(ZOOM_STEP, innerWidth / 2, innerHeight / 2);
    } else if (event.key === "-") {
      zoomAt(1 / ZOOM_STEP, innerWidth / 2, innerHeight / 2);
    } else { return; }
    event.preventDefault();
  });

  addEventListener("resize", () => { if (view.fitted) zoomToFit(); });
}

/* ------------------------------------------------------ tools on the canvas */

/* Line icons, drawn here rather than pulled from a font or a sprite sheet.
 *
 * Four hundred bytes of paths against a web font that would be another request,
 * another licence-register entry and a flash of missing glyphs on a slow
 * connection. They inherit `currentColor`, so the active and disabled states
 * cost nothing extra.
 */
const TOOL_ICONS = {
  resize:  '<path d="M3 9V3h6M21 15v6h-6"/><path d="M3 3l7 7M21 21l-7-7"/>',
  crop:    '<path d="M6 2v16h16"/><path d="M2 6h16v16"/>',
  rotate:  '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  flip:    '<path d="M12 3v18"/><path d="M8 7 3 12l5 5V7Z"/><path d="M16 7l5 5-5 5V7Z"/>',
  adjust:  '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none"/>',
  sharpen: '<path d="M12 3 4 21h16L12 3Z"/><path d="M12 9v8"/>',
  denoise: '<path d="M4 18c3-6 5 4 8-2s5 2 8-4"/><circle cx="7" cy="7" r="1"/><circle cx="17" cy="16" r="1"/>',
  straighten_page:
    '<path d="M3 7l7-3 11 4-7 3Z"/><path d="M4 12h16v8H4Z"/>',
  document_clean:
    '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h4"/>',
  convert: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  enlarge:
    '<path d="M4 4h7v7H4Z"/><path d="M11 11h9v9h-9Z"/><path d="M14 8h6v6"/>',
  super_resolution:
    '<path d="M4 4h6v6H4Z"/><path d="M14 4h6v6h-6Z"/><path d="M4 14h6v6H4Z"/><path d="M14 14h6v6h-6Z"/>',
  ai_denoise: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="4"/>',
  jpeg_artifact_repair:
    '<path d="M4 4h16v16H4Z"/><path d="M4 10h16M10 4v16"/>',
  // Not reachable while their weights are absent - the strip filters those out -
  // but drawn now so installing a model does not produce a row of blank circles.
  face_restore:
    '<circle cx="12" cy="9" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  damage_repair:
    '<path d="M4 4h16v16H4Z"/><path d="m9 4 3 8-3 3 4 6"/>',
  colourise:
    '<path d="M12 3a9 9 0 1 0 0 18c1.7 0 2-1.3 1.2-2.2-.8-.9-.5-2.3.8-2.3H17a4 4 0 0 0 4-4A9 9 0 0 0 12 3Z"/>'
    + '<circle cx="7.5" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/>',
  background_remove:
    '<path d="M4 4h7v7H4Z"/><path d="M13 13h7v7h-7Z"/><path d="M13 4h7v7h-7Z" stroke-dasharray="2 2"/>'
    + '<path d="M4 13h7v7H4Z" stroke-dasharray="2 2"/>',
  background_replace:
    '<path d="M3 17l5-5 4 4 3-3 6 6"/><path d="M3 5h18v14H3Z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
};

const FALLBACK_ICON = '<circle cx="12" cy="12" r="8"/>';

/* Build the strip from the catalogue, so a tool added on the server appears
 * here without this file being touched. Order follows the catalogue's own
 * grouping, with a rule between groups. */
function renderCanvasTools() {
  const strip = $("canvas-tools");
  if (!strip || !state.catalogue) return;

  strip.innerHTML = "";
  let first = true;

  for (const group of state.catalogue.groups) {
    const usable = group.operations.filter(
      (operation) => !(operation.needs_model && operation.available === false));
    if (!usable.length) continue;

    if (!first) {
      const rule = document.createElement("div");
      rule.className = "sep";
      strip.append(rule);
    }
    first = false;

    for (const operation of usable) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tool-btn${group.is_ai ? " is-ai" : ""}`;
      button.dataset.kind = operation.kind;
      button.dataset.label = operation.label + (group.is_ai ? " · AI" : "");
      button.setAttribute("aria-label", operation.label);
      button.innerHTML =
        `<svg viewBox="0 0 24 24" aria-hidden="true">` +
        `${TOOL_ICONS[operation.kind] || FALLBACK_ICON}</svg>`;
      button.addEventListener("click", () => openTool(operation, button));
      strip.append(button);
    }
  }
}

/* The settings for one tool, next to the icon that opened them. */
function openTool(operation, button) {
  const popover = $("tool-popover");
  const already = popover.dataset.kind === operation.kind && !popover.hidden;
  closeTool();
  if (already) return;

  const licence = operation.licence && !operation.licence.eligible_for_commercial_use
    ? `<span class="licence-note">${operation.licence.note ||
        "This model is not cleared for commercial use."}</span>`
    : "";

  popover.dataset.kind = operation.kind;
  popover.innerHTML =
    `<button class="pop-close" type="button" aria-label="Close">&times;</button>` +
    `<div class="tool-top"><span class="tool-name">${operation.label}</span>` +
    `${operation.speed === "slow" ? '<span class="speed">slow</span>' : ""}` +
    `${operation.invents_detail ? '<span class="invents">invents detail</span>' : ""}</div>` +
    `<p class="tool-summary">${operation.summary}</p>` +
    licence +
    `<div class="controls">${toolControls(operation)}</div>` +
    `<button class="apply" data-kind="${operation.kind}">Apply ${operation.label}</button>`;
  popover.hidden = false;
  button.classList.add("is-on");

  // Crop is the one tool that is used *on* the picture rather than through a
  // form, so opening it puts a box on the image and closing it takes it away.
  if (operation.kind === "crop") {
    startCropping();
    bindCropFields();
  } else {
    stopCropping();
  }

  popover.querySelector(".pop-close").addEventListener("click", closeTool);
  popover.querySelector(".apply").addEventListener("click", async () => {
    await apply(operation.kind);
    closeTool();
  });
}

function closeTool() {
  stopCropping();
  const popover = $("tool-popover");
  popover.hidden = true;
  popover.dataset.kind = "";
  popover.innerHTML = "";
  document.querySelectorAll(".tool-btn.is-on").forEach((b) => b.classList.remove("is-on"));
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
    if (event.key === "Escape" && !$("tool-popover").hidden) {
      closeTool();
      return;
    }
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
