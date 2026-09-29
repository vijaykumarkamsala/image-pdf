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

- Exposure, brightness, contrast, gamma, highlights, shadows, whites and blacks.
- Levels, tone curve, histogram and clipping warnings.
- Dynamic-range recovery, local contrast, clarity, texture and dehaze.
- Protected shadow lifting and highlight recovery.
- Explainable automatic tonal correction.

## IE-04 — Colour

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

- Built-in and user-created presets.
- Film looks, controlled grain, vignette, glow and bloom.
- Depth blur, bokeh, selective colour, colour splash and double exposure.
- Tilt-shift, motion effects, posterization, halftone and pixel-art treatments.
- Cartoon/illustration conversion, vintage effects and campaign variants.
- Randomized but repeatable preset variants.

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
