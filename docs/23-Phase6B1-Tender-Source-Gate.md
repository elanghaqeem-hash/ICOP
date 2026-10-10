# Phase 6B1 — Tender Assistant: Deterministic Readiness and Source-Limited Evidence Lookup

**Source:** owner-uploaded `icop-cyberbusiness360-phase6-src.zip`, specifically `apps/api/src/modules/tenders/assistant.ts`, `apps/api/src/lib/grounding.ts`, `docs/20-Tender-Assistant-Chatbot-Gate.md`, `apps/api/tests/e2e.assistants.test.ts`, and `docs/19-UAT-Pack.md`.

**Implementation branch:** `feature/phase6-source-reconciliation`, stacked **Draft PR #5** on Gate4C parent PR #1. Existing cookie BFF/CSRF/privileged MFA, dual-admin MFA recovery, and tenant middleware **must not be replaced** with Phase 6 snapshot's different auth model.

## Scope of this increment
- `GET /api/v1/tenders/:id/assistant/brief`: deterministic source-grounded readiness. Tracks deadline/WIB, status gaps, RKS presence/extraction, mandatory unreviewed/non-complying requirements, high-risk open items, clarification drafts, company facts expiring by submission+30 days, Bid/No-Bid next action.
- `POST /api/v1/tenders/:id/assistant/search`: keyword-based evidence retrieval limited by **both tenant_id and tender_id**. It searches tender metadata, source RKS text (per page/chunk), requirement rows and answered *aanwijzing*. Returns ranked excerpts with source kind, filename/reference, link and explicit no-answer message when none matches. Up to eight snippets; request limit 30/minute per route.
- `/tenders/:id` tab `Asisten Tender`: responsive brief, prioritized actions and evidence search. Non-AI text-only results are clearly labelled, without inferred compliance outcome.
- Regression: multi-tenant negative queries (one admin per distinct tenant), irrelevant/no-data queries, source-only snippets from RKS/requirement/answered clarification, deterministic readiness and explicit browser no-result feedback.

## Scope explicitly deferred
This **does not** yet implement provider-generated answers, verbatim AI answer citation verification, pending suggestions, acceptance/rejection of AI compliance recommendations, full semantic pgvector retrieval or Chatbot Customer KB. Source's claimed *183/183* and *206/206* test passes are historical results **from a different snapshot**, not verified on this branch. User/owner must manually verify any RKS and its updates before submitting bids.

## Security and correctness
- Tender existence checked by `tenant_id` before retrieval. Every secondary DB source query is additionally filtered by tenant ID and tender ID.
- No AI provider receives raw RKS or customer data in this increment; no external AI is called for search.
- No write to `tender_requirements`, no status transition, and no autonomous compliance assessment.
- Database retains previous versioned migration chain 010 MFA, 011 recovery, 012 SLA and credit notes; 6B1 does not require new migrations.
- In the event OCR is missing or no keyword matches, return *not found in available materials*, not made-up sourcing.
- The optional full assistant from the uploaded source imports `semantic/indexer.ts` and `semantic/search.ts` which are not yet migrated. Full wholesale import would be unsafe until migrations and provider configuration are reconciled.

## Acceptance before next increment
- [ ] GitHub Actions API TypeScript build and all historical suites PASS.
- [ ] GitHub Actions Next.js web TypeScript/build + BFF security smoke PASS.
- [ ] PostgreSQL-backed new 6B1 regression tests for tenant isolation, grounded excerpts and no-hallucination PASS.
- [ ] API/Web production dependency audit PASS.
- [ ] UAT with actual approved RKS/KAK, addenda and legal owner clarification.
- [ ] Phase 6B2 (human-reviewed compliance suggestion) must never auto-update requirements; only VERIFIED and still-valid company facts may serve as evidence. Commercial scoring must remain excluded.
- [ ] Real HTTPS staging, mobile UAT, pentest, production secrets, Finance check and source repository privacy review still block release.

**Gate status:** CI to be verified on the final integration commit; source integration is not production authorization.
