# Phase 6B2 — Tender Compliance AI Suggestions (source-derived)

**Date:** 2026-10-10. **Branch:** `feature/phase6-source-reconciliation`; stacked PR #5. No merge or production deployment.

## Sources and provenance
The owner-uploaded `icop-cyberbusiness360-phase6-src.zip` contains `apps/api/src/modules/tenders/assistant.ts`, `apps/api/src/lib/grounding.ts`, migration `012_tender_assistant_chatbot.sql`, `docs/20-Tender-Assistant-Chatbot-Gate.md`, and `apps/api/tests/e2e.assistants.test.ts`. These provide the acceptance behavior for AI compliance suggestions (fact verification, fail-closed citations, and explicit accept/reject).

The snapshot's own test-count claims are not GitHub release evidence. This integration preserves GitHub Gate4C MFA/BFF/session and the new Phase6A SLA and credit-note implementation.

## Implemented in this increment

- New isolated `013_phase6_tender_suggestions.sql` migration, avoiding uploaded `010–013` numbering collisions and importing **only** the tender suggestion table, not unreviewed chatbot/session tables.
- `POST /api/v1/tenders/:id/assistant/compliance-suggest` is protected by `tender.write` + `ai.use`, at most 6 requests/minute. Only **UNREVIEWED/CLARIFY non-COMMERCIAL requirements** are considered. Commercial terms and internal pricing never enter the model prompt.
- Tenant facts must be `status='VERIFIED'` and valid now **and** on the tender submission date (if known). Candidate factual evidence must match the requirement; max 4 source candidates per requirement.
- Provider returns JSON using `ref, status, facts, quote, rationale`. Every COMPLY, PARTIAL or NON_COMPLY without a verified quote from the **referenced candidate fact** is downgraded server-side to CLARIFY. Any unknown ref is rejected. No unsupported certifications, references, staffing or prices are presented as verified.
- Suggestions remain `PENDING`; the generation endpoint **never edits** tender requirements. `GET /api/v1/tenders/:id/assistant/suggestions` returns tenant- and tender-scoped pending suggestions.
- `POST /api/v1/tenders/:id/assistant/suggestions/:sid/decide` uses a PostgreSQL row lock, `tender.write` permission and **a different human reviewer** from the maker. ACCEPT rechecks the still-current requirement and re-queries facts for VERIFIED status, validity and the same quote. Reject changes only the suggestion, not the requirement. Decisions and generation are audit-logged; accepted suggestion updates original compliance matrix.
- Responsive Tender Assistant view displays provider rationale, matching evidence, verified quote, human accept/reject buttons and clear unsupported-evidence warnings. Existing deterministic 6B1 brief and keyword retrieval remain available.
- AI feature `tender_compliance` is included in per-tenant AI controls, and completion goes through existing provider secret manager and redaction gateway.

## Explicit limitations and release controls

- A literal quote establishes *source traceability* but does not by itself establish that the requirement is legally or technically met. Human review remains mandatory.
- Source facts can include confidential details: perform a tenant privacy/AI provider consent review before enabling external LLM use in staging.
- This is **not** an automated bid compliance conclusion. No tender status transition, proposal submission, commercial bid assessment or external tender portal action is added.
- Quote validation assumes the underlying company fact is accurately VERIFIED; a formal document or evidence attachment is still the evidence-of-record.
- Full AI question answering with RKS citations, pgvector/hybrid search, customer chatbot KB and accounting from uploaded snapshot remain separate future increments, not part of 6B2.
- Production blocked by HTTPS staging, external privacy/security assessment, relevant owner/legal/technical UAT, no-leak tenant stress testing, source repository privacy, and formal sign-off.

## Acceptance suite
`apps/api/tests/e2e.phase6.tender-compliance.test.ts` provides 5 PostgreSQL integration cases: permission checks; VERIFIED-only valid facts; fake citation downgrade and commercial exclusion; second-person maker-checker and cross-tenant isolation; fact revocation fail-closed; accepted/rejected state and audit trail.

**CI result:** see [GitHub PR #5](https://github.com/elanghaqeem-hash/ICOP/pull/5) for the latest run. Report 6B2 as passed only after GitHub Actions has verified the final commit.
