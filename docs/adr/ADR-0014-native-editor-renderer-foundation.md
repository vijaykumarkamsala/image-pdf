# ADR-0014: Native Editor Renderer Foundation

**Status:** Accepted for Recovery 2D
**Date:** 31 August 2026
**Task:** RECOVERY-2D

## Context

Recovery 2D needs selection, transforms, grouping, text, raster/vector objects,
zoom and deterministic preview evidence. The renderer cannot become the native
document format because Create PDF and Edit & Manage PDF must later reuse the
same editor services without inheriting an image-canvas serialization model.

Current primary-source evidence was reviewed before selecting a dependency:

- Fabric.js 7.4.0 is MIT licensed, written in TypeScript, released in May 2026,
  and provides an interactive object model, selection/controls, grouping,
  viewport transforms, object caching, text editing, raster filters and JSON/SVG
  import/export. Its own documentation warns that SVG round trips are not 1:1
  and that Fabric objects should not be application data stores.
- Konva 10.3.0 is MIT licensed and actively maintained. It has strong React
  bindings, transforms, layered canvas performance and scene serialization. Its
  scene graph is a lower-level drawing model, React remains the preferred state
  owner, and professional SVG/text import would require more custom translation.
- PixiJS 8.18.x is MIT licensed, TypeScript-first and actively maintained. It is
  the strongest high-throughput WebGL/WebGPU renderer of the candidates and has
  a capable scene graph, masking and accessibility extensions. It does not
  provide the required editor controls, stable application serialization or
  document-oriented import behavior without a substantial custom editor engine.

Primary sources:

- https://fabricjs.com/docs/core-concepts/
- https://fabricjs.com/docs/using-custom-properties/
- https://github.com/fabricjs/fabric.js/releases/tag/v740
- https://github.com/fabricjs/fabric.js/blob/master/LICENSE
- https://konvajs.org/docs/overview.html
- https://konvajs.org/docs/react/index.html
- https://github.com/konvajs/konva/releases/tag/v10.3.0
- https://pixijs.com/8.x/guides/concepts/architecture
- https://pixijs.com/8.x/guides/components/scene-objects
- https://github.com/pixijs/pixijs/releases/tag/v8.18.1
- https://github.com/pixijs/pixijs/blob/dev/LICENSE

## Decision

Use **Fabric.js 7.4.0** as the initial browser rendering and pointer-interaction
adapter.

The Product V2 native document contracts remain authoritative. The adapter:

1. Projects supported native artboard/layer state into Fabric objects.
2. Converts Fabric selection and transform events into typed native operations.
3. Never persists `canvas.toJSON()` as document state.
4. Never treats Fabric SVG import/export as compatibility proof.
5. Uses a DOM layer tree, properties controls and keyboard commands as the
   accessible interaction surface; canvas pixels alone are not accessibility
   evidence.
6. Produces preview derivatives with document-version and snapshot provenance.

The renderer interface is deliberately small enough to replace Fabric with a
future Canvas2D, WebGL/WebGPU, server or native renderer without migrating stored
documents.

## Large-Document and Mobile Boundary

- Ordinary navigation renders bounded previews and must not decode full-size
  originals unnecessarily.
- Preview dimensions and texture budgets are enforced before renderer loading.
- Desktop receives pointer transforms and the complete panel workspace.
- Tablet uses drawers/docks around the same native operations.
- Phone uses review, version access and bounded transform/adjustment controls; it
  does not instantiate the full professional panel layout.
- A later native app shares contracts, not Fabric or DOM canvas code.

## Security and Import Boundary

Raster layers can reference only accepted immutable source versions or approved
derivative objects. SVG remains behind a sanitiser interface and compatibility
report; active content, external references and unsupported structures fail
closed. PSD and AI-compatible imports report unsupported structures and preserve
the source until separately approved import adapters exist.

## Consequences

Fabric reduces custom selection/transform/rendering code and is commercially
suitable under MIT. The application still owns coordinate conversion,
accessibility, native serialization, autosave, history, import compatibility,
memory policy and deterministic testing. Fabric version upgrades require
renderer determinism, pointer, visual and security regression review.

Konva remains the first migration candidate if Fabric stability or import limits
become unacceptable. PixiJS remains a possible high-performance preview backend
after evidence shows the Canvas2D/WebGL threshold requires it.
