# Product V2 Visual Reference Package

**Status:** Approved product-direction reference
**Companion authority:** `../PRODUCT_V2_CONSOLIDATED_IMPLEMENTATION_AUTHORITY.md`
**Screen count:** 24 standalone previews plus 24 inspectable source fragments
**Mobile coverage:** One dedicated direction screen plus a written five-journey responsive coverage contract

## How to use this package

1. Extract the ZIP.
2. Open `index.html` in a browser.
3. Select any screen to open its standalone preview.
4. Give Codex the complete extracted folder under `docs/product-v2/visual-reference/` or another repository path approved by the product owner.
5. Keep the Consolidated Implementation Authority beside this package.

The authority document controls functional behaviour, architecture, security and delivery scope. These visuals control the approved experience direction: information hierarchy, calm density, visible actions, editor boundaries, progressive complexity and responsive behaviour.

When a visual and written authority appear to disagree, follow the authority order defined in the Consolidated Implementation Authority and report the contradiction.

## Package structure

```text
PRODUCT_V2_VISUAL_REFERENCE/
├── README.md
├── index.html
├── previews/     # standalone browser-openable references
└── sources/      # original interactive HTML fragments for implementation inspection
```

## Visual inventory and traceability

| Order | Visual | Primary decision captured | Authority relationship |
| ---: | --- | --- | --- |
| 01 | Guest home | Four equal parent outcomes, immediate file intake and calm product promise | Sections 2–5 |
| 02 | Signed-in home and activity | Recent work, attention items, durable jobs and equal creation outcomes | Sections 4–5 |
| 03 | Signed-in workspace | Workspace-level navigation and customer work context | Sections 4–5, 14 |
| 04 | Visual production experience | Connected customer journey from source through trustworthy output | Sections 3, 7, 9 |
| 05 | Intelligent upload analysis | Automatic analysis, recommended preview, intended-use inference and trust | Sections 3–4, 7 |
| 06 | Image & Graphic Studio | Professional canvas, floating panels, layers, AI assistant and contextual tools | Section 7 |
| 07 | Create PDF workspace | Quick and advanced creation opening one coherent page editor | Section 8 |
| 08 | Unified PDF workspace | Create/edit/manage PDF in one editor with page/object tooling | Section 8 |
| 09 | Print & Production | Profiles, production checks, physical/digital balance and approval | Section 9 |
| 10 | Export Center | Multi-profile outputs, preview, download, cloud save and share | Sections 9–10 |
| 11 | Project structure and files | Collections, projects, subprojects, Default Files and two project styles | Sections 5–6, 11 |
| 12 | File version history | Immutable originals, source versions, autosaves, named versions and restore | Sections 6, 11 |
| 13 | Projects and collaboration | Project activity, review, access and team coordination | Section 11 |
| 14 | Locks, comments and approvals | One editor per document, renewable lease, anchored comments and optional approval | Section 11 |
| 15 | Sharing and permissions | Invitations, app-native links, inheritance, overrides and audit | Section 11 |
| 16 | Cloud storage workflows | Import, personal/admin connections, external conflicts and safe save-back | Section 12 |
| 17 | Trash, recovery and retention | Recoverable deletion, purge disclosure, legal holds and external-file safety | Section 16 |
| 18 | Account and workspace onboarding | Universal workspace model and personal/shared workspace entry | Sections 4, 14 |
| 19 | Native e-sign workflow | Envelope preparation, routing, secure recipient experience and evidence | Section 13 |
| 20 | Privacy, support and diagnostics | Consent, staff access, safe traces, support packages and regions | Section 16 |
| 21 | Workspace processing and usage | Policy controls, automatic routing, Advanced override and free-testing usage | Sections 14–16 |
| 22 | Developer Center | Service accounts, OAuth, durable jobs, signed webhooks and safe logs | Section 17 |
| 23 | Release Command Center | Quality/licence gates, cohorts, feature flags, incidents and rollback | Section 19 |
| 24 | Mobile experience | Focused mobile boundaries and responsive continuity | Section 3.7 and mobile rules below |

## Mobile direction

The mobile visual is included at:

```text
previews/mobile-experience-direction-preview.html
sources/mobile-experience-direction.html
```

Mobile is not a separate application and not a reduced set of disconnected tools. It uses the same projects, versions, permissions, jobs, comments, approvals, sharing and signing domains.

One mobile concept is sufficient for the current overall design direction and Recovery 2A. It is not sufficient as the only mobile release evidence. As real capabilities are implemented, the product must add responsive designs and tests for:

1. Home, capture/upload and intelligent analysis.
2. Image comparison, recommended correction and focused light editing.
3. PDF review, assigned fields and recipient signing.
4. Projects, files, versions, collaboration and sharing.
5. Background jobs, export completion, download and cloud save.

### Mobile prioritises

- Capture/upload and safe intake.
- Review, compare and inspect source/output facts.
- Recommended safe corrections and a focused set of direct adjustments.
- Job progress, failure recovery and completed outputs.
- Comments, approvals, sharing and cloud save.
- Recipient signing and sender envelope status.
- Project/file browsing and version review.

### Desktop-class controls on small screens

Dense layer editing, advanced masks, precision paths, complex tables, master pages, production profile authoring and large batch configuration remain available through focused full-screen mobile task flows only where usability and device capability are verified. Otherwise, mobile offers review or handoff to desktop while preserving the exact work state.

The product must not hide critical warnings or imply that unsupported precision work was completed merely to claim feature parity.

### Android and iOS applications

The current product is responsive web/PWA. Separate Android and iOS applications are not part of Recovery 2A and must not be created from these references.

The backend, API contracts, authentication, deep links, resumable jobs, push-event abstraction and device security boundaries must remain native-app ready. A later approved native application may use React Native with Expo as its starting foundation, while sharing contracts and design tokens—not browser canvas/editor code.

## Implementation rules for Codex

- Do not paste these HTML fragments into the production app.
- Rebuild the approved experience using the production React design system and real domain contracts.
- Reuse wording only when it remains accurate for the implemented capability.
- Do not preserve sample names, identifiers, counts or statuses as hard-coded product data.
- Do not treat a visible control as permission to implement an unapproved backend shortcut.
- Do not expose quarantined AI, font or PDF capabilities just because a visual shows their intended future location.
- Preserve responsive hierarchy, keyboard access, touch targets, light/dark themes and error/empty/loading states.
- Add screenshot/visual-regression tests for implemented screens at approved desktop, tablet and phone widths.
- The current delivery increment controls which part of a visual may be implemented.

## Recommended repository placement

```text
docs/product-v2/
├── PRODUCT_V2_CONSOLIDATED_IMPLEMENTATION_AUTHORITY.md
└── visual-reference/
    ├── README.md
    ├── index.html
    ├── previews/
    └── sources/
```

The package is documentation and design evidence. It must not become a production runtime dependency.
