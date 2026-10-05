# Image Editor Master Backlog (IE-18)

**Status:** Product-owner-approved capability catalogue; implementation order and
individual feature scope remain subject to explicit approval.
**Recorded:** 28 September 2026
**Implementation authority:** None. This document preserves product discovery and
must not be treated as approval to implement every listed capability.

**Local delivery note:** The product owner subsequently approved incremental
implementation. Only explicitly completed slices below change state; the rest
of the catalogue remains backlog, not a completion claim.

## Purpose and boundaries

This catalogue preserves the candidate capabilities for the isolated Image
Editor. The editor begins with image-quality enhancement and may grow through
small, verified features. Enhancement feedback can arrive at any time and does
not need to block independent image-editing work.

The Image Editor remains distinct from the PDF Editor and the proposed future
Diagram Studio. They may share projects, assets, identity, storage, history and
design tokens, but they must not silently share editing semantics.

Every approved feature must preserve an immutable original, be non-destructive
where practical, disclose generative processing, keep preview and downloaded
bytes consistent, and fail visibly instead of silently reducing quality or
dimensions.

## IE-01 — Editing foundation

- Immutable original; exact reset to original.
- Non-destructive edit stack with per-edit enable, disable and reset.
- Undo, redo, named versions, restore points and Save a copy.
- Save to project and recover interrupted work.
- Same-coordinate Original/Edited side-by-side and comparison-slider views.
- Synchronized pan and zoom; preview must match downloaded bytes.
- Explicit output dimensions, scale, colour space and metadata policy.
- Progress, cancel, retry and understandable resource-limit failures.

## IE-02 — Geometry

**Implemented locally, pending product-owner image testing:** source-coordinate
free crop, Original/1:1/4:5/16:9 ratios, clockwise/counter-clockwise quarter
turns, manual four-corner perspective correction, horizontal/vertical flip,
bounded ±15° straightening and optional exact pixel resize with aspect locking.
Perspective uses bounded projective sampling with alpha-safe bilinear
interpolation and a disclosed browser working-pixel budget. The derivative is
rendered in a worker, retains ordered geometry provenance, verifies its encoded
PNG dimensions and uses the same bytes for preview and download. Oversized
browser requests fail visibly instead of being clamped. Automatic perspective,
lens correction, physical/PPI sizing, fit/fill, canvas and content-aware
operations remain pending.

- Free and fixed-ratio crop, including social, print, marketplace and identity
  photograph presets.
- Rotate, straighten and horizontal/vertical flip.
- Perspective, keystone and lens-distortion correction.
- Image resize and canvas resize as separate operations.
- Pixel, percentage, physical-size and PPI/DPI sizing.
- Fit, fill, contain and cover behavior.
- Content-aware crop suggestions and metadata orientation correction.

## IE-03 — Light and tone

Local implementation status (2026-10-01): the React image editor now provides
deterministic global exposure, brightness, contrast, perceptual gamma,
highlights, shadows, whites and blacks controls. Each apply starts from the
latest verified original, enhancement or geometry derivative rather than a
previous tone result. Processing is worker-isolated and pixel-budgeted,
preserves alpha, retains source/base hashes and clipping statistics in PNG
provenance, verifies exact dimensions, and serves identical bytes to preview
and download. Pending slider changes cannot download a stale derivative.
An analysis-only exact RGB/luminance histogram and factual shadow/highlight
endpoint-occupancy review are also implemented locally. They analyse the exact
current verified preview in a worker, exclude fully transparent pixels, do not
modify derivative/download bytes, and fail visibly rather than silently sample
when browser limits are exceeded. Source-bound input luminance Levels are also
implemented with constrained black/white points and a bounded midtone control;
they execute before the existing tone operations and are recorded in v2 tone
provenance. A five-anchor luminance tone curve is also implemented with smooth
monotone interpolation, non-crossing points, a neutral reset and v3 tone
provenance; it executes after Levels and cannot invert tones. Positive-only
shadow and highlight recovery is implemented as a distinct protected stage in
v4 provenance: exact black/white remain fixed, RGB headroom prevents new
channel clipping, and the UI explains that clipped detail cannot be recreated.
Explainable automatic tonal correction now analyses the exact verified-base
histogram and proposes conservative Levels, midtone and protected-recovery
values. It reports its evidence, returns neutral for an already balanced range,
and requires separate Use suggestion and Apply adjustments actions before any
pixels change. Signed deterministic local contrast is also implemented as a
separate neighbourhood stage before global tone operations. It reads every
worker tile from the immutable verified base with source halos, excludes fully
transparent pixels from its neighbourhood statistics, and uses a noise floor,
bounded detail gain, endpoint protection and RGB-headroom limits to prevent
tile seams, grain amplification and new clipping. Its setting and operation
order are recorded in tone provenance. Signed deterministic clarity is also
implemented as a distinct medium-scale signal within the shared
source-neighbourhood stage. It derives a bounded
difference-of-neighbourhoods signal from the same immutable source tiles,
rather than sharpening individual pixels, and shares the transparency, noise,
endpoint, colour-headroom and seam protections. Local contrast and clarity are
recorded before global tone operations. Signed deterministic Texture is also
implemented inside that shared source-neighbourhood stage. It uses fine-scale
detail plus exact local variance to act on repeated tonal texture, suppresses
low-amplitude isolated variation, and rejects strong outline transitions so it
does not silently become edge sharpening. The three neighbourhood settings are
recorded in tone provenance. Signed deterministic Dehaze is also implemented
inside the source-neighbourhood stage. Positive values conservatively remove a
bounded neutral veil only where an elevated dark floor and low broad-scale
variance are measured; negative values add a bounded veil. Endpoint,
colour-headroom, transparency, structure and seam protections remain active,
and the UI states that obscured detail cannot be recovered. All four
neighbourhood settings are recorded in v8 tone provenance.

- Exposure, brightness, contrast, gamma, highlights, shadows, whites and blacks.
- Levels, tone curve, histogram and clipping warnings.
- Dynamic-range recovery, local contrast, clarity, texture and dehaze.
- Protected shadow lifting and highlight recovery.
- Explainable automatic tonal correction.

## IE-04 — Colour

Local implementation status (2026-10-04): the React image editor now provides
deterministic global temperature, tint, saturation and vibrance controls as a
separate stage after geometry and light/tone. Each apply starts from the latest
verified derivative rather than a previous colour result. Worker processing is
pixel-budgeted, preserves alpha and exact dimensions, records source/base hashes,
the ordered recipe and gamut-clipping statistics in PNG provenance, and exposes
identical bytes to preview and download. Earlier-stage changes invalidate colour
output and pending colour changes cannot download stale bytes. Deterministic
neutral-point white-balance sampling is also implemented against the exact
verified pre-colour derivative. The customer explicitly selects a known-neutral
point in the Result viewer, reviews the measured visible-patch RGB and proposed
Temperature/Tint correction, then separately chooses Use suggestion and Apply
colour. Transparent samples and unusably dark or clipped patches fail visibly;
accepted sample coordinates, measurements and bounded correction are recorded
in v2 colour provenance. Eight-range selective HSL is also implemented for Red,
Orange, Yellow, Green, Aqua, Blue, Purple and Magenta. Each range exposes bounded
Hue, Saturation and Lightness controls with smooth transitions into neighbouring
ranges; neutral colours and transparent pixels remain protected. The ordered
selective recipe is recorded in v3 colour provenance. Deterministic tonal colour
grading is also implemented for Shadows, Midtones and Highlights. Each range
provides Hue, Saturation and Luminance controls through smooth, overlapping
luminance masks; exact black, exact white, transparency and alpha are protected,
and tint strength is bounded to available gamut. The ordered grading recipe is
recorded in v4 colour provenance. An opt-in deterministic black-and-white
channel mixer is also implemented in linear light with bounded Red, Green and
Blue weights. The weights are normalized, an all-zero mix fails visibly, exact
black/white and alpha remain protected, and the ordered mixer recipe is recorded
in v5 colour provenance. Deterministic duotone mapping is also implemented with
separate bounded Shadow and Highlight Hue/Saturation controls plus an adjustable
balance point. It runs after the optional channel mixer, preserves luminance,
exact black/white, transparency and alpha, prevents new gamut clipping, and is
recorded in v6 colour provenance. Source-bound point-colour selection is also
implemented against the exact verified pre-colour derivative. A visible,
chromatic patch supplies one reviewed target hue; bounded tolerance, feather,
hue, saturation and lightness controls affect only that circular hue interval.
Neutral or conflicting patches fail visibly, sampling alone changes no pixels,
and the measured patch plus ordered recipe are recorded in v7 colour provenance.
Reviewed local 3D IRIDAS `.cube` LUTs are also implemented as the final creative
colour transform. The strict UTF-8 parser accepts only complete 3D grids from 2³ through
65³ within a 16 MiB file budget, supports declared input domains and rejects 1D,
shaper, malformed, incomplete and excess data instead of guessing. The customer
reviews the file name, title, grid, domain, interpolation and exact SHA-256 before
applying a bounded intensity. Red-fastest tetrahedral interpolation runs in
display-referred sRGB; dimensions, alpha and fully transparent hidden RGB remain
unchanged, while out-of-range output is clipped and counted. Preview and download
use the same source-bound bytes, and the reviewed LUT identity plus ordered recipe
are recorded in v8 colour provenance. Proposal-first reference-image colour
matching is also implemented for verified single-frame JPEG, PNG and WebP files.
The browser worker hashes the exact reference bytes and analyses bounded Oklab
distribution samples from both the reference and exact verified pre-colour base;
importing alone never changes pixels. The customer explicitly activates the
reviewed proposal, then controls match strength, luminance, colour intensity and
neutral protection. Matching is bounded, preserves exact black/white,
transparency, alpha and dimensions, and runs before the final optional 3D LUT.
The source/base and reference hashes, sampled statistics and deterministic method
are recorded in v9 provenance; raw reference bytes and the local file name are
not exported. Explicit protected brand/product/skin-critical colour anchors are
also implemented against the exact verified pre-colour base. The customer samples
and reviews up to three chromatic patches, assigns a bounded purpose category and
controls hue tolerance, feather and protection strength. Sampling or protection
alone is neutral. When another colour transform is requested, a final bounded
blend-back protects source pixels similar in hue, saturation and lightness; multiple
anchors use a maximum/union mask and cannot exceed 100%. The feature does not infer
people, skin, brands, products or object boundaries. Source coordinates, measured
colour, purpose, controls and exact base hash are recorded in v10 provenance.
Preview-only colour-vision simulation is also implemented for full-severity
protanopia, deuteranopia and tritanopia review using the published
Machado-Oliveira-Fernandes RGB matrices. A dedicated browser worker renders
the exact current Result image at unchanged dimensions and fails visibly when
the local resource budget cannot be met. The simulation never changes an edit
recipe, derivative, provenance or download bytes, and returning to Standard
colour restores the exact verified Result. The UI identifies this as an
approximate display-referred sRGB design aid rather than a diagnosis, contrast
conformance check, device proof or substitute for testing with people.

- White balance, temperature, tint, saturation and vibrance.
- HSL, selective colour, point colour and colour balance.
- Shadow/midtone/highlight grading and LUT support.
- Colour replacement and matching between images.
- Colour-cast removal, black-and-white mixing and duotone.
- Skin-tone, product-colour and brand-colour protection.
- Colour-vision preview.

## IE-05 — Enhancement and restoration

- Same-dimension pixel correction plus explicit, exact 2x and 4x output.
- Luminance/chroma denoise and compression-artifact removal.
- Edge-preserving and noise-aware sharpness.
- Lens-blur, motion-blur and missed-focus correction.
- Local-detail, face-detail, hair, fabric, foliage and fur preservation.
- Text, logo and critical-outline preservation.
- Moire, chromatic-aberration, colour-fringe and banding reduction.
- Dust, scratch, scan, faded-colour and old-photograph restoration.
- Controlled film-grain preservation or removal.
- Content-specific routes for photographs, portraits, illustrations, logos,
  screenshots, documents and product images.
- Honest warnings where source detail cannot be recovered reliably.

## IE-06 — Selections and masks

- Rectangle, ellipse, lasso, polygon, edge-aware and brush selections.
- Select by colour or luminosity.
- Subject, background, sky, object, person, face, hair, skin and clothing masks.
- Add, subtract, intersect, invert, feather, smooth, expand and contract.
- Hair/transparency edge refinement.
- Saved masks plus linear, radial, colour-range and luminance-range masks.
- Local tone, colour, denoise and sharpness adjustments.

## IE-07 — Cleanup and retouching

- Spot healing, clone, patch and blemish removal.
- Dust-spot visualization and red-eye/pet-eye correction.
- Object, wire, pole, background-person, glare and reflection cleanup.
- Natural skin retouching with texture protection.
- Controlled eye, teeth, under-eye and face-light adjustments.
- Dodge, burn and damaged-region repair.
- Retouching on a separate non-destructive layer and restore-region-from-original.

## IE-08 — Background tools

- Automatic removal with manual refinement.
- Transparent, solid-colour, uploaded-image and blurred backgrounds.
- Background-only tone/colour correction and cleanup.
- Hair/fur refinement and edge-colour decontamination.
- Contact shadows, reflections and background extension.
- Standard white/grey product backgrounds.
- Consistent subject position and size across variants.

## IE-09 — Portrait tools

- Natural portrait enhancement with identity and geometry protection.
- Face-aware exposure, sharpness and skin-texture preservation.
- Hair detail, restrained eye clarity and controlled skin smoothing.
- Temporary blemish cleanup, portrait relighting and depth blur.
- Adjustable focus point and professional/identity-photo presets.
- Group portraits and independent controls per detected person.
- Trust warnings when a face is too small for reliable restoration.

## IE-10 — Product and e-commerce

- Product cutout, white background, centring and consistent padding.
- Marketplace dimension and compliance presets.
- Product recolouring, contact shadows and reflections.
- Stand/support/mannequin removal and ghost-mannequin workflow.
- Clothing wrinkle reduction, flat-lay presentation and catalogue framing.
- Brand kits covering colour, logo, framing and export rules.
- Batch SKU processing and multiple channel outputs from one master.

## IE-11 — Layers and composition

- Image, adjustment, text and shape layers.
- Groups, layer masks, clipping masks, opacity and blend modes.
- Lock, hide, duplicate, reorder and non-destructive transform.
- Linked/embedded placed images.
- Alignment, distribution, guides, grids and snapping.
- Logo, watermark, borders, frames, overlays and simple collages.
- Exposure blending and selected-object placement.

These capabilities must not turn the Image Editor into the future Diagram
Studio; structured diagrams and connectors remain a separate experience.

## IE-12 — Creative tools

**Implemented locally, pending product-owner image testing:** a bounded first
preset slice provides four versioned built-in light-and-tone recipes. Selecting
a preset only loads its complete sanitized deterministic settings into the
existing controls; pixels remain unchanged until the customer explicitly
chooses **Apply adjustments**. Exact expanded recipe values continue through the
existing preview/download provenance path, and any manual value change is
identified as custom settings. This slice does not add generative processing or
silently alter the immutable original. Customers can also save, reload, rename,
apply and explicitly delete up to 24 custom tone recipes in the current browser
profile. The local collection uses a strict versioned schema and recipe version,
rejects corrupt, duplicate or out-of-range entries, and clearly discloses that
it is not workspace-synced or shared. Loading a saved recipe still requires a
separate Apply action; exported provenance records expanded settings rather than
the private local preset name.

- Built-in and user-created presets.
- Film looks, controlled grain, vignette, glow and bloom.
- Depth blur, bokeh, selective colour, colour splash and double exposure.
- Tilt-shift, motion effects, posterization, halftone and pixel-art treatments.
- Cartoon/illustration conversion, vintage effects and campaign variants.
- Randomized but repeatable preset variants.

**Still pending:** authenticated workspace-synced/shared presets, server-side
migration and update notices, colour and multi-stage looks,
film/grain/vignette/effect tools, and randomized repeatable variants.

## IE-13 — Multi-image processing

- Panorama, HDR and HDR panorama.
- Focus stacking, exposure blending and deghosting.
- Noise reduction and astrophotography stacking.
- Multi-frame object removal, group-photo face choice and best-frame selection.
- Source alignment with every immutable input retained.

## IE-14 — RAW and professional colour

- Camera RAW development, demosaicing and camera/lens profiles.
- RAW highlight recovery and 16-bit processing.
- ICC preservation and sRGB, Display P3 and Adobe RGB workflows.
- HDR editing/preview and SDR fallback.
- Soft proofing, gamut warnings and rendering intent.
- Rec. 2020 and controlled CMYK conversion for print.
- EXIF/IPTC/copyright inspection and editing.

## IE-15 — Batch and automation

- Copy/paste selected edits and apply recipes to multiple images.
- Batch crop, rotate, resize, convert, enhance, remove background, watermark,
  rename and manage metadata.
- Saved recipes, per-image exceptions and representative previews.
- Pause, resume, cancel and retry; one failure must not fail unrelated items.
- ZIP download, APIs, webhooks and usage reports when cloud work is authorized.

## IE-16 — Export and delivery

**Implemented locally, pending product-owner image testing:** a bounded browser
export baseline prepares PNG, JPEG or WebP from the latest verified local
derivative. PNG retains the exact verified derivative bytes; JPEG and WebP use
an explicit 40–100 quality control and disclose 8-bit sRGB browser encoding.
JPEG rejects transparent pixels unless the customer explicitly selects a white
or black matte, while WebP is withheld if the browser encoder cannot preserve
alpha. The worker and final download boundary both verify actual format and
exact dimensions, SHA-256 evidence is shown, and filenames disclose dimensions,
lossy quality and extension. TIFF, subsampling/bit-depth controls, PPI, ICC and
metadata policy choices, multi-profile packages, watermarks and durable export
jobs remain pending.

- PNG, JPEG, WebP and TIFF; evaluate AVIF and JPEG XL later.
- Transparency, lossless/lossy quality, chroma subsampling and bit depth.
- Exact pixel dimensions, physical size and PPI/DPI validation.
- ICC selection, metadata retention and copyright/attribution policy.
- Multi-profile social, web, email, print and marketplace outputs.
- Watermarks, filename templates, export preview and packaged variants.
- Final-byte dimension/format validation, checksum and provenance.

## IE-17 — Explicit generative features

- Generative fill, removal, expansion and background replacement.
- Prompted object addition/replacement, similar variants and product staging.
- Creative upscaling, reference-guided generation and style transfer.
- Face reconstruction only with explicit consent and review.
- Region-level evidence, model/provider disclosure and content provenance.

Generative capabilities must be labelled separately from enhancement and
ordinary correction. They must never silently invent documentary, identity,
text, logo or product information.

## IE-18 — Customer trust and usability

- Clear distinction between correction and invented content.
- Rejectable automatic recommendations and meaningful strength controls.
- No silent resize, quality reduction, colour-space conversion or overwrite.
- Explain the selected processing route, its limits and local/cloud execution.
- Privacy controls and location-metadata removal by default.
- Keyboard, touch, screen-reader and high-contrast support.
- Large-file resource estimates, background progress and honest device limits.
- Downloadable processing report, history and provenance.

## Candidate implementation sequence

This is a planning proposal, not implementation approval:

1. Preserve the foundation while continuing evidence-driven enhancement fixes.
2. Crop, rotate, straighten and perspective correction.
3. Core light/tone controls.
4. Core colour controls.
5. Exact resize and export controls.
6. Presets and non-generative variants.
7. Selections, masks and local adjustments.
8. Background and cleanup tools.
9. Projects, named versions and batch recipes.
10. Advanced RAW, colour, multi-image and explicitly generative capabilities.

## Proposed editor UX for product-owner review

The Email Studio screenshots suggest a useful desktop pattern:

- A compact left icon rail groups tool families.
- Selecting a family opens a searchable, dockable tool panel.
- A contextual properties inspector shows only controls relevant to the active
  tool, layer, mask or selection.
- The image canvas remains central and visually dominant.
- A compact floating bottom bar owns zoom, fit, pan and comparison controls.
- The top bar owns filename, save state, undo/redo, warnings, project save and
  export; it should not contain detailed editing controls.
- Panels may dock, float, move, resize, collapse, pin and reset on large screens.
- Layout preference is saved per customer, with a one-click Reset workspace.
- On standard laptops, only one secondary panel should need to be open. On
  tablets it becomes a side sheet; on phones it becomes a bottom sheet.
- Every icon requires a text label/tooltip, keyboard access and a sufficiently
  large hit target. Icons alone must not carry meaning.

Suggested initial rail groups are Enhance, Adjust, Crop, Select/Mask, Retouch,
Background, Layers, History and Export. Unreleased groups remain absent rather
than disabled clutter.

The design goal is progressive disclosure: a new customer can complete one
task without understanding the whole editor, while an experienced customer can
customize a dense professional workspace.

## Research basis

- Adobe Photoshop: non-destructive layers/masks and contextual task bar.
- Adobe Lightroom: focused photo controls, collapsible panels, versions and
  local masks.
- Affinity Photo: professional raster, RAW, HDR, panorama and stacking workflows.
- Topaz Photo: content-specific restoration, denoise, sharpen, focus, face and
  text-preservation workflows.
- Canva and Pixlr: approachable one-click tools and progressive editing.
- Photoroom: product-image consistency, brand rules and batch automation.
