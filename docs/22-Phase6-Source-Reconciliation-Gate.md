# ICOP Phase 6 — Source Reconciliation and Incremental Integration Gate

Date: 2026-10-10. Branch: `feature/phase6-source-reconciliation` (stacked on Gate4C `feature/phase5-source-integration`). **Status: INTEGRATION IN PROGRESS; not approved for production.**

## Original owner-provided sources

- `icop-cyberbusiness360-phase6-src.zip` (385 archive entries, SHA-256 `9e6c9fe207ba75d729b358ef5c7ffecf9f5fd7af254ec4dddaf938c2985a51da`)
- `icop-phase6-incremental(1).bundle` (SHA-256 `94d2a8725f3cad5ed706f4f3695c24de8089be64e20737168338ce43961ed174`)
- Internal documents in archive: `docs/18-Phase5-Gate-Report.md`, `docs/19-UAT-Pack.md`, `docs/20-Tender-Assistant-Chatbot-Gate.md`, `docs/21-Semantic-Search-Accounting-Gate.md`, and two ops reports.

The uploaded Phase 6 reports **claim** Phase 5 163/163, tender/chatbot 183/183, and semantic/accounting 206/206 successful local tests on the author's snapshot. These are **source-reported historical acceptance claims**, **NOT** evidence that those modules pass CI in this GitHub integration. Production sign-off was not furnished.

## Collision and security review

The uploaded zip's database migrations are:

| Uploaded original | Target in GitHub integration | Action |
|---|---|---|
| `010_phase5_security.sql` | Already replaced by GitHub `010_phase5_mfa.sql` + `011_phase5_mfa_recovery.sql` | **Do not import** duplicate MFA columns / alternate session model |
| `011_phase5_sla_credit_rag.sql` | `012_phase6_sla_credit_rag.sql` | Imported and renamed, retaining 010/011 history |
| `012_tender_assistant_chatbot.sql` | `013_phase6_tender_assistant_chatbot.sql` | Pending route security reconciliation |
| `013_semantic_accounting.sql` | `014_phase6_semantic_accounting.sql` | Pending pgvector/ledger correctness and key-management review |

The new snapshot uses alternate browser auth (Fastify-set cookies) and TOTP recovery-code design, while current GitHub Gate4C already implements a Next.js BFF with httpOnly JWT, CSRF, fresh MFA step-up, and **two independent administrators** for MFA recovery. **Do not copy the uploaded auth routes or replace current migrations/lockfiles.** Keep the existing Next16, React19, Fastify5 and current validated dependency lockfiles unless current vulnerability evidence demands changes.

## Scope and statuses

| Feature from uploaded sources | Scope | State on this branch |
|---|---|---|
| Business calendar, public holidays, per-contract SLA | Schema + source business time functions, ticket pause/resume | **Schema imported**; SLA runtime/UI UAT pending |
| Credit notes (DPP + PPN, refund, maker-checker) | API + invoice UI + SoD + MFA recency + regression | **Implemented on this branch**, CI pending |
| Full-text search indexes | document pages, proposal sections, tender requirements, verified facts | **Schema imported**, complete RAG UI pending |
| Tender Assistant | readiness brief, grounded RKS QA, compliance suggestion review | Pending controlled transfer, grounding tests |
| Customer chatbot and KB | deterministic per-customer data, public articles only, approval workflow, handoff to ticket | Pending; do not expose cross-customer data |
| Hybrid semantic search pgvector | vector(1024), HNSW, eligibility-at-query, keyword fallback | Pending `014`, Postgres extension and key review |
| Double-entry accounting | subledger, credit-note journal, FlexGuard revenue, export outbox, sandbox connector | Pending Finance chart-of-account signoff; never claim production accounting |
| Key-ring rotation, worker, scheduler | secrets rotation, retentions, 15-minute jobs | Pending separate security and operational review |

## Credit-note acceptance derived from uploaded `e2e.phase5.test.ts`

1. Finance can create draft with reason; amount never exceeds remaining ex-VAT base across issued/pending credits.
2. Source-tax-rate PPN is applied; no hard-coded tax for credit-note corrections.
3. **Maker-checker**: same actor cannot approve/reject their own draft. Roles mapped to `billing.approve`; approval also requires Gate4C fresh-TOTP when enforced by policy.
4. Approval changes outstanding, and settled state correctly reflects credit + prior payments.
5. Refund due is separately surfaced when credit exceeds outstanding (not treated as cash paid).
6. Nonexistent or cross-tenant records return 404 and cannot be approved; audit trail records create/issue/reject.
7. Customer portal displays credited/outstanding amounts without internal pricing data.
8. UAT must validate legal/accounting treatment of refunds and applicable tax rate, including whether a tax invoice correction is required.

## Owner UAT / release gates

Uploaded `docs/19-UAT-Pack.md` includes scenarios U01–U32 (not necessarily consecutive IDs) across authentication, quotation/DoA, tender, chatbot, SLA, billing, accounting and integrations. Reuse the scenarios as **acceptance specifications**, not as proof of completed deployment. Scenario U14 governs credit notes. U15–U17 cover calendar/contract/pause SLA. U27–U32 cover tender assistant, KB, chatbot, semantic search and accounting.

Release remains blocked by: live staging HTTPS and secrets, malware-scan/upload review, full tenant-scope negative tests, backups/restores, independent pentest, verified MFA recovery SOP, Finance-approved chart of accounts and actual provider sandbox runs. Keep both PRs in Draft until gate sign-off.
