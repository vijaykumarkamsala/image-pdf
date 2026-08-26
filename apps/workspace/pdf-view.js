/* The PDF workspace - page-level work on a document the customer already has.
 *
 * This is the half of the product that has nothing to do with AI. Someone with a
 * sixty-page report who needs four pages of it, a designer whose print run is in
 * the wrong order, a lecturer merging three handouts: none of that needs a model,
 * and all of it is what people actually open a PDF tool to do.
 *
 * **There are no page previews, and that is deliberate.** Rendering a PDF page
 * means implementing a content-stream interpreter, a font rasteriser and a
 * colour pipeline - and getting any of it slightly wrong produces a picture that
 * is confidently different from what will print. The grid therefore shows each
 * page's true measured size and orientation rather than a guess at its
 * appearance. Where a page turns out to hold one large image that fills it - a
 * scan, typically - that image is shown, labelled as what it is.
 *
 * Everything here works by page number, because that is the unit the customer
 * already has in their head when they say "drop page four".
 */

const $ = (id) => document.getElementById(id);

const state = {
  /** Base64 payloads, in merge order. The first is the document being edited. */
  documents: [],      // { dataUrl, name, bytes }
  report: null,       // /api/pdf/inspect for documents[0]
  selection: new Set(),   // one-based page numbers
  order: null,        // one-based, when the customer has dragged pages about
  thumbs: new Map(),  // page number -> data URL, only where honestly available
  thumbNote: "",      // why some pages have a picture and others do not
  keepPrivate: false,
  history: [],        // previous { documents, report } for undo
};

let deps = null;

export function init(dependencies) {
  deps = dependencies;   // { api, toast, busy, bytes }
}

export function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** How to name the document in a request.
 *
 * The object where there is one, so a two-hundred-page bundle is not re-encoded
 * and re-sent for every operation applied to it. A data URL otherwise - a
 * document produced by an earlier edit, or an upload that could not reach
 * storage.
 *
 * Spread into a request rather than returning the whole body, so each caller
 * keeps its own arguments visible where it makes them.
 */
function documentRef() {
  const document_ = state.documents[0];
  return document_.object
    ? { object: document_.object, filename: document_.name }
    : { pdf: document_.dataUrl, filename: document_.name };
}

/* --------------------------------------------------------------- opening -- */

export async function open(file) {
  deps.busy(true, "Reading the document…");
  try {
    const dataUrl = await readAsDataUrl(file);

    // Straight to storage, so a large bundle never travels through the API.
    let object = null;
    try {
      object = await deps.uploadDirect(file, (percent) =>
        deps.busy(true, `Uploading… ${percent}%`)
      );
    } catch (error) {
      console.warn("direct upload unavailable, sending inline:", error.message);
    }

    deps.busy(true, "Reading the document…");
    const report = await deps.api(
      "/api/pdf/inspect",
      object ? { object, filename: file.name } : { pdf: dataUrl, filename: file.name }
    );
    if (!report.ok) {
      deps.toast(report.error, true);
      return false;
    }

    state.documents = [{ dataUrl, object, name: file.name, bytes: file.size }];
    state.report = report;
    state.selection = new Set();
    state.order = null;
    state.thumbs = new Map();
    state.thumbNote = "";
    state.history = [];

    show();
    render();
    deps.toast(`${file.name}: ${report.summary}`);
    // Thumbnails are a bonus, never a blocker, so they load after the grid.
    void loadThumbnails();
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
  $("pdfspace").hidden = false;
  $("btn-reset").hidden = false;
  $("btn-download").hidden = false;
}

/* ------------------------------------------------------------ thumbnails -- */

async function loadThumbnails() {
  // Downsized server-side. Asking for the images at their original resolution
  // works beautifully on a two-page document and sends several hundred
  // megabytes for a hundred-page scan - and whether an image *is* the page is
  // judged there too, where the page dimensions are known.
  try {
    const result = await deps.api("/api/pdf/thumbnails", {
      ...documentRef(),
      edge: 240,
    });
    state.thumbs = new Map(
      Object.entries(result.thumbnails || {}).map(([page, image]) => [Number(page), image])
    );
    state.thumbNote = result.note || "";
    render();
  } catch {
    /* A missing preview costs nothing; the grid is complete without it. */
  }
}

/* ------------------------------------------------------------- rendering -- */

function pageNumbers() {
  const total = state.report.document.page_count;
  return state.order ?? Array.from({ length: total }, (_, i) => i + 1);
}

function render() {
  renderSummary();
  renderGrid();
  renderActions();
}

function renderSummary() {
  const { document: doc, capabilities: caps, filename, bytes } = state.report;
  const extra = state.documents.length > 1
    ? `<p class="meta">+ ${state.documents.length - 1} more queued for merging: ${
        state.documents.slice(1).map((d) => escapeHtml(d.name)).join(", ")}</p>`
    : "";

  $("pdf-summary").innerHTML = `
    <h2>${escapeHtml(filename)}</h2>
    <p class="meta">${escapeHtml(state.report.summary)} &middot; ${deps.bytes(bytes)}</p>
    ${extra}
    <div class="caps">
      <div class="caps-yes">
        <strong>You can</strong>
        <ul>${Object.entries(caps.supported).filter(([, v]) => v)
          .map(([k]) => `<li>${escapeHtml(label(k))}</li>`).join("")}</ul>
      </div>
      <div class="caps-no">
        <strong>Not possible with this file</strong>
        <ul>${caps.not_supported.map((k) => `<li>${escapeHtml(label(k))}</li>`).join("")}</ul>
      </div>
    </div>
    <p class="meta subtle">${doc.uniform_size
      ? "Every page is the same size."
      : "Pages are not all the same size - check before printing."}</p>
    ${extrasNote()}
    ${state.thumbNote ? `<p class="meta subtle">${escapeHtml(state.thumbNote)}</p>` : ""}`;
}

/** What this document carries besides pages, and what removing pages costs.
 *
 * Bookmarks and form fields point at particular pages, so a split cannot keep
 * them without leaving dead links and fields that cannot be filled in. That is
 * worth knowing before clicking rather than after.
 */
function extrasNote() {
  const extras = state.report.extras || [];
  if (!extras.length) return "";

  const pageBound = extras.filter((item) =>
    ["bookmarks", "fill-in form fields", "named destinations", "custom page numbering"]
      .includes(item)
  );
  const list = extras.map(escapeHtml).join(", ");

  if (!pageBound.length) {
    return `<p class="meta subtle">This document also carries ${list}, which every
            operation here keeps.</p>`;
  }
  return `<p class="warn-note">This document carries ${list}. Reordering, turning and
          stamping keep all of it. Removing pages cannot: ${pageBound.map(escapeHtml).join(" and ")}
          point at particular pages, so they are dropped rather than left pointing at pages
          that are no longer there.</p>`;
}

function label(key) {
  return {
    merge: "Combine with other PDFs",
    split: "Pull pages out into a new file",
    reorder: "Move pages around",
    rotate: "Turn pages the right way up",
    delete_pages: "Remove pages",
    add_content_over_pages: "Stamp text over pages",
    extract_images: "Save the images inside at full quality",
    edit_existing_text: "Retype the text that is already on the page",
    edit_existing_vector_artwork: "Redraw the artwork that is already on the page",
    render_page_preview: "Show a picture of each page",
  }[key] ?? key.replace(/_/g, " ");
}

function renderGrid() {
  const pages = state.report.document.pages;
  const grid = $("pdf-grid");
  grid.innerHTML = pageNumbers().map((number, position) => {
    const page = pages[number - 1];
    const chosen = state.selection.has(number);
    const thumb = state.thumbs.get(number);
    const moved = state.order && number !== position + 1;
    return `
      <div class="page-card${chosen ? " is-chosen" : ""}${moved ? " is-moved" : ""}"
           draggable="true" data-page="${number}" data-position="${position}"
           role="checkbox" aria-checked="${chosen}" tabindex="0"
           aria-label="Page ${number}, ${page.label}">
        <div class="page-face" style="aspect-ratio:${page.width_inches}/${page.height_inches}">
          ${thumb
            ? `<img src="${thumb}" alt="" /><span class="page-badge">scan</span>`
            : `<span class="page-blank">${number}</span>`}
        </div>
        <div class="page-info">
          <strong>${moved ? `${position + 1} &larr; was ${number}` : number}</strong>
          <span>${page.label}</span>
          ${page.rotation ? `<span class="rot">turned ${page.rotation}&deg;</span>` : ""}
        </div>
      </div>`;
  }).join("");

  for (const card of grid.querySelectorAll(".page-card")) {
    card.addEventListener("click", (event) => choose(Number(card.dataset.page), event));
    card.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        choose(Number(card.dataset.page), event);
      }
    });
    card.addEventListener("dragstart", onDragStart);
    card.addEventListener("dragover", onDragOver);
    card.addEventListener("drop", onDrop);
    card.addEventListener("dragend", () => grid.classList.remove("is-dragging"));
  }
}

let lastChosen = null;

function choose(number, event) {
  if (event.shiftKey && lastChosen !== null) {
    // Range selection follows what is on screen, not the original numbering,
    // so shift-clicking after a reorder selects what the customer can see.
    const view = pageNumbers();
    const from = view.indexOf(lastChosen);
    const to = view.indexOf(number);
    for (const n of view.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      state.selection.add(n);
    }
  } else if (state.selection.has(number)) {
    state.selection.delete(number);
  } else {
    state.selection.add(number);
  }
  lastChosen = number;
  render();
}

/* -------------------------------------------------------------- dragging -- */

let dragging = null;

function onDragStart(event) {
  dragging = Number(event.currentTarget.dataset.position);
  event.dataTransfer.effectAllowed = "move";
  // Firefox will not start a drag without payload, even one nobody reads.
  event.dataTransfer.setData("text/plain", String(dragging));
  $("pdf-grid").classList.add("is-dragging");
}

function onDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

function onDrop(event) {
  event.preventDefault();
  const target = Number(event.currentTarget.dataset.position);
  if (dragging === null || dragging === target) return;
  const view = pageNumbers();
  const [moved] = view.splice(dragging, 1);
  view.splice(target, 0, moved);
  state.order = view;
  dragging = null;
  render();
}

/* --------------------------------------------------------------- actions -- */

function renderActions() {
  const chosen = [...state.selection].sort((a, b) => a - b);
  const total = state.report.document.page_count;
  const some = chosen.length > 0;
  const reordered = Boolean(state.order) &&
    state.order.some((n, i) => n !== i + 1);

  $("pdf-selection").textContent = some
    ? `${chosen.length} of ${total} page(s) selected: ${summarise(chosen)}`
    : `No pages selected - actions below apply to all ${total}.`;

  $("pdf-apply-order").hidden = !reordered;
  $("pdf-clear").hidden = !some && !reordered;

  for (const [id, enabled] of [
    ["pdf-split", some],
    ["pdf-delete", some && chosen.length < total],
    ["pdf-rotate-left", true],
    ["pdf-rotate-right", true],
    ["pdf-stamp", true],
    ["pdf-extract", state.report.capabilities.extractable_images > 0],
  ]) {
    $(id).disabled = !enabled;
  }
  $("pdf-extract").title = state.report.capabilities.extractable_images
    ? `${state.report.capabilities.extractable_images} image(s) inside`
    : "This document's artwork is vector - there are no images to pull out.";
}

/** "1-4, 9, 12-14" rather than a list of twenty numbers. */
function summarise(numbers) {
  const runs = [];
  for (const n of numbers) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

async function run(operation, extra = {}) {
  const chosen = [...state.selection].sort((a, b) => a - b);
  deps.busy(true, "Working on the document…");
  try {
    const result = await deps.api("/api/pdf/edit", {
      operation,
      documents: state.documents.map((d) => ({ pdf: d.dataUrl, filename: d.name })),
      pages: chosen.length ? chosen : undefined,
      keep_private_data: state.keepPrivate,
      ...extra,
    });

    if (operation === "extract_images") {
      showExtracted(result);
      return;
    }

    state.history.push({
      documents: state.documents,
      report: state.report,
      order: state.order,
    });

    // Any documents queued for merging apply to a merge and nothing else. A
    // split that quietly discarded them would leave someone waiting for a
    // combine that already stopped being possible, so it is said out loud.
    const dropped = operation === "merge" ? 0 : state.documents.length - 1;

    const name = renamed(state.documents[0].name, operation);
    state.documents = [{ dataUrl: result.pdf, object: null, name, bytes: result.bytes }];
    state.report = await deps.api("/api/pdf/inspect", { pdf: result.pdf, filename: name });
    state.selection = new Set();
    state.order = null;
    state.thumbs = new Map();

    render();
    $("pdf-note").textContent = result.note;
    $("pdf-note").hidden = false;
    $("pdf-undo").hidden = false;
    deps.toast(
      `${label2(operation)} - ${result.page_count} page(s), ${deps.bytes(result.bytes)}` +
      (dropped > 0 ? `. ${dropped} queued document(s) were set aside; add them again to combine.` : "")
    );
    void loadThumbnails();
  } catch (error) {
    deps.toast(error.message, true);
  } finally {
    deps.busy(false);
  }
}

function label2(operation) {
  return {
    split: "Pages pulled out", delete_pages: "Pages removed", reorder: "Pages moved",
    rotate: "Pages turned", stamp: "Stamp added", merge: "Documents combined",
  }[operation] ?? "Done";
}

function renamed(name, operation) {
  const stem = name.replace(/\.pdf$/i, "");
  const suffix = {
    split: "pages", delete_pages: "trimmed", reorder: "reordered",
    rotate: "turned", stamp: "stamped", merge: "combined",
    redact: "redacted", smaller: "smaller", searchable: "searchable",
  }[operation] ?? "edited";
  return `${stem}-${suffix}.pdf`;
}

function showExtracted(result) {
  const box = $("pdf-extracted");
  if (!result.count) {
    box.innerHTML = `<p class="meta">${escapeHtml(result.note)}</p>`;
    box.hidden = false;
    return;
  }
  box.innerHTML = `<p class="meta">${escapeHtml(result.note)}</p><div class="shots">` +
    result.images.map((image) => `
      <figure>
        <img src="${image.image}" alt="Image from page ${image.page_number}" />
        <figcaption>
          page ${image.page_number} &middot; ${image.width}&times;${image.height}
          &middot; ${deps.bytes(image.bytes)}
          <br><span class="${image.original_quality ? "good" : "subtle"}">${
            image.original_quality
              ? "original file, untouched"
              : "repacked losslessly - no pixels lost"}</span>
          <br><a download="page-${image.page_number}.png" href="${image.image}">Save</a>
        </figcaption>
      </figure>`).join("") + "</div>";
  box.hidden = false;
}

function undo() {
  const previous = state.history.pop();
  if (!previous) return;
  state.documents = previous.documents;
  state.report = previous.report;
  state.order = previous.order;
  state.selection = new Set();
  state.thumbs = new Map();
  $("pdf-undo").hidden = state.history.length === 0;
  $("pdf-note").hidden = true;
  render();
  void loadThumbnails();
  deps.toast("Reverted");
}

/* ------------------------------------------------------------------- ocr -- */

/** Say up front whether recognition can run, rather than failing on the click. */
async function refreshOcrStatus() {
  const box = $("pdf-ocr-status");
  try {
    const status = await deps.api("/api/ocr-availability");
    if (status.available) {
      box.textContent = `Ready — ${status.version}.`;
      $("pdf-ocr").disabled = false;
    } else {
      box.textContent = status.reason;
      $("pdf-ocr").disabled = true;
    }
  } catch {
    box.textContent = "Could not check whether recognition is available.";
    $("pdf-ocr").disabled = true;
  }
}

async function readTheWords() {
  deps.busy(true, "Reading the words on the scan…");
  try {
    const result = await deps.api("/api/pdf/ocr", documentRef());
    const box = $("pdf-ocr-result");

    if (!result.available) {
      box.innerHTML = `<div class="redact-warn">${escapeHtml(result.error)}</div>`;
      box.hidden = false;
      return;
    }
    if (!result.changed) {
      box.innerHTML = `<div class="redact-warn">${escapeHtml(result.note)}</div>`;
      box.hidden = false;
      deps.toast("Nothing was recognised - the document is unchanged.", true);
      return;
    }

    state.history.push({
      documents: state.documents,
      report: state.report,
      order: state.order,
    });

    const name = renamed(state.documents[0].name, "searchable");
    state.documents = [{ dataUrl: result.pdf, object: null, name, bytes: result.bytes }];
    state.report = await deps.api("/api/pdf/inspect", { pdf: result.pdf, filename: name });
    state.selection = new Set();
    state.order = null;
    state.thumbs = new Map();
    render();

    // Low-confidence words lead when there are any: a wrong word in a
    // searchable layer is worse than a gap, because a search for it lands on a
    // page that does not contain it.
    const shaky = result.low_confidence_words;
    box.innerHTML = `<div class="${shaky ? "redact-warn" : "redact-ok"}">
      <strong>${result.words} word(s)</strong> read from
      ${result.pages_read.length} page(s). You can now search, select and copy from this
      document, and redact a name by typing it.
      ${shaky ? `<br><strong>${shaky} word(s) came back uncertain.</strong> Recognition is a
        guess on poor scans — check those before relying on a search.` : ""}
      ${result.licence_note ? `<br><span class="meta">${escapeHtml(result.licence_note)}</span>` : ""}
    </div>`;
    box.hidden = false;
    $("pdf-undo").hidden = false;
    deps.toast(`${result.words} word(s) recognised — the scan is searchable now`);
    void loadThumbnails();
  } catch (error) {
    deps.toast(error.message, true);
  } finally {
    deps.busy(false);
  }
}

/* -------------------------------------------------------------- compress -- */

async function compressToFit() {
  const target = Number($("pdf-target").value);
  if (!target || target <= 0) {
    deps.toast("Give the size limit in megabytes first.", true);
    return;
  }
  deps.busy(true, "Reducing the file…");
  try {
    const result = await deps.api("/api/pdf/compress", {
      ...documentRef(),
      target_mb: target,
      keep_private_data: state.keepPrivate,
    });

    state.history.push({
      documents: state.documents,
      report: state.report,
      order: state.order,
    });

    const name = renamed(state.documents[0].name, "smaller");
    state.documents = [{ dataUrl: result.pdf, object: null, name, bytes: result.bytes }];
    state.report = await deps.api("/api/pdf/inspect", { pdf: result.pdf, filename: name });
    state.selection = new Set();
    state.order = null;
    state.thumbs = new Map();
    render();

    // Whether the limit was met leads, because that is the question that was
    // asked. Everything else is detail behind it.
    const box = $("pdf-compress-result");
    box.innerHTML = `<div class="${result.reached_target ? "redact-ok" : "redact-warn"}">
      ${result.reached_target
        ? `<strong>${deps.bytes(result.bytes)}</strong> - under your ${target} MB limit.`
        : `<strong>Could not reach ${target} MB.</strong> The smallest honest result is
           ${deps.bytes(result.bytes)}.`}
      <br>${escapeHtml(result.note)}</div>`;
    box.hidden = false;
    $("pdf-undo").hidden = false;
    deps.toast(
      result.reached_target
        ? `${result.percent_smaller}% smaller - ${deps.bytes(result.bytes)}`
        : `Could not reach ${target} MB; smallest is ${deps.bytes(result.bytes)}`,
      !result.reached_target
    );
    void loadThumbnails();
  } catch (error) {
    deps.toast(error.message, true);
  } finally {
    deps.busy(false);
  }
}

/* ---------------------------------------------------------------- redact -- */

/** Find a phrase without changing anything.
 *
 * Redaction is irreversible by design - the words are deleted, not hidden - so
 * a customer should be able to see how many times a phrase appears, and where,
 * before committing to removing it.
 */
async function findText() {
  const phrase = $("pdf-redact-text").value.trim();
  if (!phrase) {
    deps.toast("Type the words you want to find first.", true);
    $("pdf-redact-text").focus();
    return;
  }
  deps.busy(true, "Searching the document…");
  try {
    const result = await deps.api("/api/pdf/search", {
      ...documentRef(),
      phrase,
      ignore_case: !$("pdf-redact-case").checked,
    });
    const box = $("pdf-redact-result");
    box.className = "redact-result";
    box.innerHTML = `<div class="${result.count ? "redact-ok" : "redact-warn"}">
      <span class="redact-count">${result.count}</span> occurrence(s).
      ${escapeHtml(result.note)}</div>`;
    box.hidden = false;
  } catch (error) {
    deps.toast(error.message, true);
  } finally {
    deps.busy(false);
  }
}

async function removeText() {
  const phrase = $("pdf-redact-text").value.trim();
  if (!phrase) {
    deps.toast("Type the words you want removed first.", true);
    $("pdf-redact-text").focus();
    return;
  }

  deps.busy(true, "Removing the text…");
  try {
    const result = await deps.api("/api/pdf/redact", {
      ...documentRef(),
      phrases: [phrase],
      ignore_case: !$("pdf-redact-case").checked,
    });

    if (!result.areas_redacted) {
      const box = $("pdf-redact-result");
      box.innerHTML = `<div class="redact-warn">${escapeHtml(result.note)}</div>`;
      box.hidden = false;
      deps.toast("Nothing matched - the document is unchanged.", true);
      return;
    }

    state.history.push({
      documents: state.documents,
      report: state.report,
      order: state.order,
    });

    const name = renamed(state.documents[0].name, "redact");
    state.documents = [{ dataUrl: result.pdf, object: null, name, bytes: result.bytes }];
    state.report = await deps.api("/api/pdf/inspect", { pdf: result.pdf, filename: name });
    state.selection = new Set();
    state.order = null;
    state.thumbs = new Map();
    render();

    // The verification result leads, because it is the only part of this that
    // is a fact about the file rather than a description of an intention.
    const box = $("pdf-redact-result");
    box.innerHTML = `<div class="${result.verified ? "redact-ok" : "redact-warn"}">
      ${result.verified
        ? "<strong>Verified removed.</strong> The finished file was read back and the words are not in it."
        : `<strong>NOT fully removed.</strong> Still found: ${
            result.still_present.map(escapeHtml).join(", ")}. Do not treat this file as redacted.`}
      <br>${escapeHtml(result.note)}</div>`;
    box.hidden = false;
    $("pdf-undo").hidden = false;
    deps.toast(`${result.areas_redacted} occurrence(s) removed from ${result.page_count} page(s)`);
    void loadThumbnails();
  } catch (error) {
    deps.toast(error.message, true);
  } finally {
    deps.busy(false);
  }
}

/* ----------------------------------------------------------------- wiring -- */

export function wire() {
  $("pdf-split").addEventListener("click", () => run("split"));
  $("pdf-delete").addEventListener("click", () => run("delete_pages"));
  $("pdf-rotate-left").addEventListener("click", () => run("rotate", { degrees: 270 }));
  $("pdf-rotate-right").addEventListener("click", () => run("rotate", { degrees: 90 }));
  $("pdf-extract").addEventListener("click", () => run("extract_images"));
  $("pdf-undo").addEventListener("click", undo);
  $("pdf-ocr").addEventListener("click", readTheWords);
  void refreshOcrStatus();
  $("pdf-compress").addEventListener("click", compressToFit);
  $("pdf-find").addEventListener("click", findText);
  $("pdf-redact").addEventListener("click", removeText);

  $("pdf-stamp").addEventListener("click", () => {
    const text = $("pdf-stamp-text").value.trim();
    if (!text) {
      deps.toast("Type the words you want stamped first.", true);
      $("pdf-stamp-text").focus();
      return;
    }
    void run("stamp", { text });
  });

  $("pdf-apply-order").addEventListener("click", () => {
    if (!state.order) return;
    void run("reorder", { order: state.order, pages: undefined });
  });

  $("pdf-clear").addEventListener("click", () => {
    state.selection = new Set();
    state.order = null;
    render();
  });

  $("pdf-keep-private").addEventListener("change", (event) => {
    state.keepPrivate = event.target.checked;
  });

  $("pdf-add").addEventListener("click", () => $("pdf-file").click());
  $("pdf-file").addEventListener("change", async (event) => {
    const files = [...event.target.files].filter(isPdf);
    event.target.value = "";
    if (!files.length) return;
    for (const file of files) {
      state.documents.push({
        dataUrl: await readAsDataUrl(file),
        name: file.name,
        bytes: file.size,
      });
    }
    render();
    deps.toast(`${files.length} document(s) queued - press Combine to merge them.`);
  });

  $("pdf-merge").addEventListener("click", () => {
    if (state.documents.length < 2) {
      deps.toast("Add at least one more PDF before combining.", true);
      return;
    }
    void run("merge", { pages: undefined });
  });
}

export function download() {
  const document_ = state.documents[0];
  if (!document_) return false;
  const link = window.document.createElement("a");
  link.href = document_.dataUrl;
  link.download = document_.name;
  link.click();
  return true;
}

export function active() {
  return state.documents.length > 0;
}

export function reset() {
  state.documents = [];
  state.report = null;
  state.selection = new Set();
  state.order = null;
  state.thumbs = new Map();
  state.history = [];
  $("pdfspace").hidden = true;
  $("pdf-note").hidden = true;
  $("pdf-redact-result").hidden = true;
  $("pdf-compress-result").hidden = true;
  $("pdf-ocr-result").hidden = true;
  $("pdf-undo").hidden = true;
  $("pdf-extracted").hidden = true;
}

/* ----------------------------------------------------------------- utility -- */

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
