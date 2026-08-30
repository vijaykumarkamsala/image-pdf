# Intelligent Visual Production Workspace — Product V2 Authority

**Status:** Approved grooming baseline
**Version:** 2.0
**Date:** 29 August 2026
**Product name:** To be decided

## Purpose

This folder is the authoritative product baseline created after the product-owner redesign and the read-only takeover audit of the existing repository.

Earlier POC documents remain useful as historical benchmark evidence, but they no longer define the customer product, release boundary, interface, billing behaviour or recovery architecture.

## Document precedence

1. Current explicit product-owner instruction
2. `PRODUCT_CONSTITUTION.md`
3. `FUNCTIONAL_REQUIREMENTS.md`
4. `USER_FLOWS_AND_EDGE_CASES.md`
5. `PRODUCT_DECISION_REGISTER.md`
6. `RECOVERY_ARCHITECTURE_AND_DELIVERY_PLAN.md`
7. `QUALITY_AND_RELEASE_PLAN.md`
8. `RESEARCH_EVIDENCE.md`
9. Earlier POC and discovery documents, only where they do not conflict with V2

`AGENTS_V2.md` is the approved replacement for the repository-root `AGENTS.md` when Recovery 0 is implemented.

An implementation agent must report contradictions and request product-owner approval. It must not silently choose an older requirement.

## Approved product scope before external tester release

- Image & Graphic Studio
- Create PDF
- Edit & Manage PDF
- Print and physical-production profiles
- Digital-output profiles
- Projects, collections and subprojects
- Collaboration, sharing, comments and optional approvals
- Google Drive, SharePoint/OneDrive and Dropbox connectivity
- Native e-sign UI and public API
- Public API for stable core product capabilities
- Privacy, retention, diagnostics, administration and testing foundations
- Shadow pricing/metering with customer charge fixed at zero during testing

Video editing and live customer charging are excluded. Product naming, final prices, final runtime models, exact factory tolerances and final infrastructure vendors remain evidence-based decisions.

## Implementation rule

The existing verified processing and test assets are candidates for reuse. The legacy customer UI and prototype Python HTTP surface do not control the new product architecture.

Do not begin implementation from these documents until the product owner approves the first recovery task plan.
