/* Many files at once - PRODUCT_REQUIREMENTS section 13.
 *
 * Nobody edits one photograph. A shop has a folder of product shots, a designer
 * a set of colourways, a firm a bundle of scans. Every operation the single-file
 * workspace offers is worth more when it can run over fifty of them, and until
 * it can, the tool is a demonstration rather than something anyone works in.
 *
 * **The loop lives here, not on the server, and that is deliberate.** One
 * request per image means the progress bar is real rather than a guess, a
 * failure is attached to the file that caused it, and retrying the three that
 * failed does not re-run the forty-seven that did not. A single request for the
 * whole batch would be simpler to write and would give the customer a spinner
 * and no information for four minutes.
 *
 * The server still exposes `/api/batch` and `/api/batch/pdf` for scripts and for
 * a future queue; this view uses the per-item routes because it is a person
 * watching.
 *
 * **One screen for images and documents.** The grid, the progress, the retry and
 * the archive are identical work; only the list of operations and what a card
 * can show differ. Two screens would drift apart, and the second one would be
 * the one that stopped getting the fixes.
 */

const $ = (id) => document.getElementById(id);

const MAX_ITEMS = 50;

const state = {
  /** { name, dataUrl, status, width, height, result, error } */
  items: [],
  kind: "image",      // "image" or "pdf" - decided by what was dropped
  operation: null,
  settings: {},
  running: false,
  cancelled: false,
  nextNumber: 1,   // the running Bates count, carried across documents
};

/* What can be done to a folder of documents.
 *
 * Deliberately not the whole PDF menu. Splitting at page four means something
 * different in every document, and merging is one output rather than fifty, so
 * neither belongs on a screen whose promise is "the same thing to all of them".
 * What is here is what a folder of documents actually needs doing to it. */
const PDF_OPERATIONS = [
  {
    id: "compress",
    label: "Make them smaller",
    route: "/api/pdf/compress",
    controls: () => `<div class="control">
        <label for="b-target">must be under (MB)</label>
        <input id="b-target" type="number" min="0.1" max="500" step="0.5" value="10">
      </div>`,
    settings: () => ({ target_mb: Number($("b-target")?.value) || 10 }),
    summary: (r) => `${deps.bytes(r.bytes)}${r.reached_target ? "" : " - over the limit"}`,
    ok: (r) => r.reached_target !== false,
  },
  {
    id: "redact",
    label: "Remove sensitive words",
    route: "/api/pdf/redact",
    danger: true,
    controls: () => `<div class="control">
        <label for="b-phrases">words to remove (one per line)</label>
        <textarea id="b-phrases" rows="2" placeholder="Jane Doe&#10;ACC-4929-8812"></textarea>
      </div>`,
    settings: () => ({
      phrases: ($("b-phrases")?.value || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    }),
    summary: (r) =>
      r.areas_redacted
        ? `${r.areas_redacted} removed${r.verified ? ", verified" : " - NOT VERIFIED"}`
        : "nothing matched",
    // A document where the words were not found is not a failure, but it is the
    // single most important thing to surface: assuming a name was removed
    // because nothing complained is how documents get released with it still in.
    ok: (r) => r.verified !== false,
  },
  {
    id: "ocr",
    label: "Make the scans searchable",
    route: "/api/pdf/ocr",
    controls: () => "",
    settings: () => ({}),
    summary: (r) => (r.changed ? `${r.words} words read` : "nothing to read"),
    ok: (r) => r.available !== false,
  },
  {
    id: "number",
    label: "Number the pages across the bundle",
    route: "/api/pdf/number",
    controls: () => `<div class="control">
        <label for="b-prefix">prefix</label>
        <input id="b-prefix" type="text" maxlength="16" value="ABC-" placeholder="ABC-">
      </div>
      <div class="control">
        <label for="b-start">start at</label>
        <input id="b-start" type="number" min="0" max="999999" value="1">
      </div>
      <div class="control"><label for="b-position">corner</label>
        <select id="b-position">
          <option value="bottom-right">bottom right</option>
          <option value="bottom-left">bottom left</option>
          <option value="bottom-centre">bottom centre</option>
          <option value="top-right">top right</option>
        </select></div>`,
    settings: () => ({
      prefix: $("b-prefix")?.value ?? "",
      start: Number($("b-start")?.value) || 1,
      position: $("b-position")?.value || "bottom-right",
    }),
    summary: (r) => `${r.first} .. ${r.last}`,
  },
  {
    id: "stamp",
    label: "Stamp text over every page",
    route: "/api/pdf/edit",
    controls: () => `<div class="control">
        <label for="b-stamp">words</label>
        <input id="b-stamp" type="text" maxlength="40" value="DRAFT">
      </div>`,
    settings: () => ({ operation: "stamp", text: $("b-stamp")?.value || "DRAFT" }),
    summary: (r) => `${r.page_count} page(s) stamped`,
  },
  {
    id: "rotate",
    label: "Turn every page",
    route: "/api/pdf/edit",
    controls: () => `<div class="control"><label for="b-degrees">turn</label>
      <select id="b-degrees">
        <option value="90">90&deg; right</option><option value="180">180&deg;</option>
        <option value="270">90&deg; left</option></select></div>`,
    settings: () => ({ operation: "rotate", degrees: Number($("b-degrees")?.value) || 90 }),
    summary: (r) => `${r.page_count} page(s) turned`,
  },
];

let deps = null;

export function init(dependencies) {
  deps = dependencies;   // { api, toast, busy, bytes, catalogue, controlsFor, settingsFor }
}

export function isImage(file) {
  return /^image\/(jpeg|png)$/.test(file.type);
}

export function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** Whether this drop is a batch at all, and of what.
 *
 * A mixed drop is refused rather than guessed at. Silently taking the six images
 * and ignoring the four PDFs would be the same failure as taking the first file
 * and ignoring the rest, just harder to notice.
 */
export function batchKindOf(files) {
  const list = [...files];
  const images = list.filter(isImage).length;
  const pdfs = list.filter(isPdf).length;
  if (images > 1 && pdfs === 0) return "image";
  if (pdfs > 1 && images === 0) return "pdf";
  if (images && pdfs) return "mixed";
  return null;
}

/* --------------------------------------------------------------- opening -- */

export async function open(files) {
  const kind = batchKindOf(files);
  if (kind === "mixed") {
    deps.toast(
      "Drop images or PDFs, not both at once - one batch does one kind of thing.",
      true
    );
    return false;
  }
  if (!kind) return false;

  const chosen = [...files].filter(kind === "pdf" ? isPdf : isImage);
  const noun = kind === "pdf" ? "documents" : "images";
  if (chosen.length > MAX_ITEMS) {
    deps.toast(
      `A batch takes up to ${MAX_ITEMS} ${noun} at a time; ${chosen.length} were dropped. ` +
      `The first ${MAX_ITEMS} were taken.`,
      true
    );
  }

  deps.busy(true, `Reading ${Math.min(chosen.length, MAX_ITEMS)} files…`);
  try {
    state.kind = kind;
    state.items = [];
    for (const file of chosen.slice(0, MAX_ITEMS)) {
      state.items.push({
        name: file.name,
        dataUrl: await readAsDataUrl(file),
        bytes: file.size,
        status: "queued",
      });
    }
    state.cancelled = false;
    state.operation = null;
    show();
    renderTools();
    render();
    return true;
  } catch (error) {
    deps.toast(error.message, true);
    return false;
  } finally {
    deps.busy(false);
  }
}

function show() {
  $("intake").hidden = true;
  $("workspace").hidden = true;
  $("pdfspace").hidden = true;
  $("batchspace").hidden = false;
  $("btn-reset").hidden = false;
  $("btn-download").hidden = false;
}

/* --------------------------------------------------------------- running -- */

async function run(only = null) {
  if (state.running) return;
  if (!state.operation) {
    deps.toast("Choose what to do to them first.", true);
    return;
  }

  const targets = only ?? state.items.map((_, index) => index);
  if (!targets.length) return;

  state.running = true;
  state.cancelled = false;
  for (const index of targets) {
    state.items[index].status = "queued";
    state.items[index].error = null;
  }
  render();

  // Read once for the whole run, so every file in a batch gets the same
  // configuration even if someone nudges a slider while it is going.
  const settings = readBatchSettings();
  // Reset the running count at the start of a run, so re-running a bundle
  // numbers it the same way rather than continuing from last time.
  state.nextNumber = Number(settings.start) || 1;

  let done = 0;
  for (const index of targets) {
    if (state.cancelled) {
      state.items[index].status = "queued";
      continue;
    }

    const item = state.items[index];
    item.status = "processing";
    render();

    try {
      const result = await callFor(item, settings);

      // Every one of these routes refuses a file by *returning* a failure rather
      // than failing the request. Treating a 200 as success marked a corrupt
      // upload as finished and put it in the download - silent, and worse than
      // the failure it hid.
      const trouble = troubleWith(result);
      if (trouble) {
        item.status = "failed";
        item.error = trouble;
      } else {
        item.status = "completed";
        item.result = result;
      }
    } catch (error) {
      item.status = "failed";
      item.error = error.message;
    }

    done += 1;
    render(done, targets.length);
  }

  state.running = false;
  render();

  const failed = state.items.filter((item) => item.status === "failed").length;
  const completed = state.items.filter((item) => item.status === "completed").length;
  const noun = state.kind === "pdf" ? "document" : "image";
  deps.toast(
    failed
      ? `${completed} done, ${failed} failed — the failures can be retried on their own.`
      : `All ${completed} ${noun}(s) done.`,
    Boolean(failed)
  );
}

/** One request for one file, whichever kind of batch this is. */
function callFor(item, settings) {
  if (state.kind !== "pdf") {
    return deps.api("/api/process", {
      operation: state.operation,
      settings,
      image: item.dataUrl,
      filename: item.name,
    });
  }

  const entry = pdfOperation();
  if (entry.id === "number") {
    // Numbering is the one operation that carries state between documents: the
    // count continues, or a bundle ends up with fifty page ones.
    return deps
      .api(entry.route, { pdf: item.dataUrl, filename: item.name, ...settings, start: state.nextNumber })
      .then((result) => {
        if (result?.next_number) state.nextNumber = result.next_number;
        return result;
      });
  }
  if (entry.route === "/api/pdf/edit") {
    // The page-editing route takes a list of documents and its own operation
    // name, so the settings carry it rather than the outer selection.
    const { operation, ...rest } = settings;
    return deps.api(entry.route, {
      documents: [{ pdf: item.dataUrl, filename: item.name }],
      operation,
      ...rest,
    });
  }
  return deps.api(entry.route, { pdf: item.dataUrl, filename: item.name, ...settings });
}

/** Why this result should count as a failure, or null if it should not. */
function troubleWith(result) {
  if (result.ok === false) {
    return result.error || result.failure?.message || "this file could not be processed";
  }
  if (state.kind === "pdf") {
    const entry = pdfOperation();
    if (entry?.ok && !entry.ok(result)) {
      // Not an error from the server - a result the customer must not mistake
      // for success. A redaction that found nothing, or a file still over the
      // limit, has to be visible on its own card.
      return entry.summary ? entry.summary(result) : "did not meet what was asked";
    }
  }
  return null;
}

function pdfOperation() {
  return PDF_OPERATIONS.find((entry) => entry.id === state.operation);
}

function cancel() {
  if (!state.running) return;
  state.cancelled = true;
  deps.toast("Stopping after the current image. Everything finished is kept.");
}

async function downloadAll() {
  const finished = state.items
    .filter((item) => item.status === "completed")
    .map((item) =>
      state.kind === "pdf"
        ? { filename: renamedPdf(item.name), pdf: item.result.pdf }
        : { filename: renamed(item.name, item.result), image: item.result.image }
    );

  if (!finished.length) {
    deps.toast("Nothing has finished yet.", true);
    return;
  }

  deps.busy(true, "Building the archive…");
  try {
    const bundle = await deps.api("/api/batch/zip", { files: finished });
    const link = document.createElement("a");
    link.href = bundle.zip;
    link.download = state.kind === "pdf" ? "edited-documents.zip" : "edited-images.zip";
    link.click();
    deps.toast(`${bundle.files} file(s), ${deps.bytes(bundle.bytes)}`);
  } catch (error) {
    deps.toast(error.message, true);
  } finally {
    deps.busy(false);
  }
}

function renamed(name, result) {
  const stem = name.replace(/\.[^.]+$/, "");
  const extension = (result?.media_type || "image/png").split("/")[1];
  return `${stem}-edited.${extension}`;
}

function renamedPdf(name) {
  const stem = name.replace(/\.pdf$/i, "");
  const suffix = {
    compress: "smaller",
    number: "numbered",
    redact: "redacted",
    ocr: "searchable",
    stamp: "stamped",
    rotate: "turned",
  }[state.operation] ?? "edited";
  return `${stem}-${suffix}.pdf`;
}

/* ------------------------------------------------------------- rendering -- */

function render(done = 0, total = 0) {
  const counts = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };
  for (const item of state.items) counts[item.status] += 1;

  $("batch-summary").innerHTML = `
    <h2>${state.items.length} ${state.kind === "pdf" ? "document" : "image"}(s)</h2>
    <p class="meta">
      ${counts.completed} done &middot; ${counts.failed} failed &middot;
      ${counts.queued + counts.processing} waiting
      ${state.running && total ? ` &middot; ${done} of ${total} this run` : ""}
    </p>
    ${state.running
      ? `<div class="batch-bar"><span style="width:${total ? (done / total) * 100 : 0}%"></span></div>`
      : ""}`;

  $("batch-run").disabled = state.running;
  $("batch-retry").hidden = state.running || !counts.failed;
  $("batch-cancel").hidden = !state.running;
  $("batch-download").hidden = !counts.completed;

  $("batch-grid").innerHTML = state.items
    .map((item, index) => {
      const size = describe(item);
      // A document has no picture to show without a renderer, and inventing one
      // would be worse than the honest placeholder - see pdf-view.js.
      const face =
        state.kind === "pdf"
          ? `<div class="batch-thumb batch-doc"><span>PDF</span></div>`
          : `<div class="batch-thumb"><img src="${
              item.status === "completed" ? item.result.image : item.dataUrl
            }" alt="" loading="lazy" /></div>`;
      return `
        <figure class="batch-card is-${item.status}" data-index="${index}">
          ${face}
          <figcaption>
            <span class="batch-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <span class="batch-state">${label(item.status)}</span>
            <span class="batch-size">${size}</span>
            ${item.error ? `<span class="batch-error">${escapeHtml(item.error)}</span>` : ""}
          </figcaption>
        </figure>`;
    })
    .join("");
}

/** What to show under a card's name: the result if there is one, else the size. */
function describe(item) {
  if (item.status !== "completed") return deps.bytes(item.bytes);
  if (state.kind === "pdf") {
    const entry = pdfOperation();
    return entry?.summary ? escapeHtml(entry.summary(item.result)) : deps.bytes(item.result.bytes);
  }
  return `${item.result.width}&times;${item.result.height}`;
}

function label(status) {
  return {
    queued: "waiting",
    processing: "working…",
    completed: "done",
    failed: "failed",
  }[status];
}

/** What can be done, for whichever kind of batch this is.
 *
 * Images reuse the catalogue, so a batch offers exactly what a single image
 * offers and cannot drift from it. Documents use their own short list, because
 * most page operations mean something different in every file.
 */
function renderTools() {
  if (state.kind === "pdf") {
    $("batch-operation").innerHTML =
      `<option value="">Choose what to do…</option>` +
      PDF_OPERATIONS.map(
        (entry) => `<option value="${entry.id}">${escapeHtml(entry.label)}</option>`
      ).join("");
    return;
  }

  const catalogue = deps.catalogue();
  if (!catalogue) return;

  const groups = catalogue.groups
    .map((group) => {
      const options = group.operations
        .filter((entry) => !entry.needs_model || entry.available)
        .map((entry) => `<option value="${entry.kind}">${escapeHtml(entry.label)}</option>`)
        .join("");
      return options ? `<optgroup label="${escapeHtml(group.label)}">${options}</optgroup>` : "";
    })
    .join("");

  $("batch-operation").innerHTML =
    `<option value="">Choose what to do…</option>${groups}`;
}

const PREFIX = "b-";

/** Controls for a batch, which cannot depend on any one image's dimensions.
 *
 * The single-image screen offers a crop in pixels and a resize prefilled with
 * that image's width. Neither means anything across fifty images of different
 * sizes, so this offers the batch-shaped version instead: one longest edge with
 * the aspect ratio kept. Crop is deliberately absent - a fixed rectangle applied
 * to a set of differently-sized photographs cuts each of them somewhere else.
 */
function batchControls(entry) {
  const hint = entry.settings_hint || {};

  if (entry.kind === "resize") {
    return `<div class="control">
        <label for="${PREFIX}resize-edge">longest edge (px)</label>
        <input id="${PREFIX}resize-edge" type="number" min="1" max="20000" value="2000">
      </div>${deps.control(entry, "algorithm", hint.algorithm, PREFIX)}`;
  }
  if (entry.kind === "rotate") {
    return `<div class="control"><label for="${PREFIX}rotate-deg">turn</label>
      <select id="${PREFIX}rotate-deg">
        <option value="90">90&deg; right</option><option value="180">180&deg;</option>
        <option value="270">90&deg; left</option></select></div>`;
  }
  if (entry.kind === "flip") {
    return `<div class="control"><label for="${PREFIX}flip-axis">direction</label>
      <select id="${PREFIX}flip-axis">
        <option value="horizontal">horizontal</option>
        <option value="vertical">vertical</option></select></div>`;
  }
  return Object.entries(hint)
    .map(([key, spec]) => deps.control(entry, key, spec, PREFIX))
    .join("");
}

function readBatchSettings() {
  if (state.kind === "pdf") {
    return pdfOperation()?.settings() ?? {};
  }
  const entry = deps.findOperation(state.operation);
  if (!entry) return {};
  if (entry.kind === "resize") {
    const edge = Number($(`${PREFIX}resize-edge`)?.value) || 2000;
    // Aspect ratio kept, because the images are not all the same shape and
    // forcing them to one would distort every portrait in a set of landscapes.
    return {
      algorithm: $(`${PREFIX}resize-algorithm`)?.value || "lanczos",
      target_width: edge,
      preserve_aspect_ratio: true,
    };
  }
  return deps.settingsFor(entry, PREFIX);
}

function chooseOperation(kind) {
  state.operation = kind || null;
  const box = $("batch-settings");

  if (!kind) {
    box.innerHTML = "";
    state.settings = {};
    return;
  }

  if (state.kind === "pdf") {
    const document_entry = pdfOperation();
    box.innerHTML = document_entry ? document_entry.controls() : "";
    if (document_entry?.danger) {
      box.insertAdjacentHTML(
        "afterbegin",
        `<p class="warn-note">This <strong>deletes</strong> the words from every document,
         and overwrites the pixels underneath on scanned pages. Each result is checked by
         reading the finished file back, and any document where the words survived is
         marked failed rather than quietly counted as done.</p>`
      );
    }
    return;
  }

  const entry = deps.findOperation(kind);
  if (!entry) {
    box.innerHTML = "";
    state.settings = {};
    return;
  }

  box.innerHTML = batchControls(entry);

  // A generative operation over fifty images is fifty chances to invent detail
  // nobody asked for, so the warning is repeated here rather than assumed to
  // have been read on the single-image screen.
  if (entry.invents_detail) {
    box.insertAdjacentHTML(
      "afterbegin",
      `<p class="warn-note">This can invent detail that was not in the originals.
       Over a whole batch that is ${state.items.length} chances to change something
       you did not intend &mdash; try one image first.</p>`
    );
  }
  if (entry.speed === "slow") {
    box.insertAdjacentHTML(
      "beforeend",
      `<p class="meta subtle">This one uses a model and takes a moment per image;
       ${state.items.length} of them will not be quick.</p>`
    );
  }
}

/* ---------------------------------------------------------------- wiring -- */

export function wire() {
  $("batch-run").addEventListener("click", () => run());
  $("batch-cancel").addEventListener("click", cancel);
  $("batch-download").addEventListener("click", downloadAll);
  $("batch-retry").addEventListener("click", () => {
    const failed = state.items
      .map((item, index) => (item.status === "failed" ? index : -1))
      .filter((index) => index >= 0);
    void run(failed);
  });
  $("batch-operation").addEventListener("change", (event) =>
    chooseOperation(event.target.value)
  );
}

export function active() {
  return state.items.length > 0;
}

export function download() {
  void downloadAll();
  return true;
}

export function reset() {
  state.items = [];
  state.operation = null;
  state.settings = {};
  state.running = false;
  $("batchspace").hidden = true;
}

/* --------------------------------------------------------------- utility -- */

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
