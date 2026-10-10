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
| Business calendar, public holidays, per-contract SLA | Schema + Jakarta time calculator, fallback policy, ticket pause/resume, admin and contract UI | **Implementation and 4 API regression tests PASS**, live staging UAT pending |
| Credit notes (DPP + PPN, refund, maker-checker) | API + invoice UI + SoD + MFA recency + 5 PostgreSQL tests | **Implementation plus 5 API regression tests PASS**; final combined CI is [38044507793](https://github.com/elanghaqeem-hash/ICOP/actions/runs/38044507793) |
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


## SLA acceptance derived from uploaded Phase 6 tests

- `apps/api/src/lib/businessTime.ts`: deterministic Asia/Jakarta calculation; weekends and administrator-maintained holidays excluded in BUSINESS mode.
- `apps/api/src/modules/helpdesk/routes.ts`: effective contract/tenant/default SLA is applied when tickets are opened or priority changes; P1/P2 default 24x7, P3/P4 default working hours. A paused ticket stops resolution breach checks until customer reply unpauses and extends resolution.
- `/api/v1/helpdesk/calendar`, `/api/v1/helpdesk/holidays`, `/api/v1/contracts/:id/sla`: tenant-aware policy management and audit events.
- UI: `/helpdesk/settings` and contract detail use source-informed SLA editor. Input must reflect the signed contract, never automatically assert the policy is legally valid.
- `apps/api/tests/e2e.phase6.sla.test.ts`: weekend/holiday date vectors, admin authority, tenant calendar, contract SLA precedence, pause and resume (4 tests passed in real PostgreSQL CI).

**Regulatory reminder:** Default service windows are configurable product policies, not a contractual or regulatory assertion. Admin must verify Indonesian national holidays and joint leave against the approved official calendar for the period.

## Verified GitHub integration test gate (10 Oct 2026)

- CI [run 38044507793](https://github.com/elanghaqeem-hash/ICOP/actions/runs/38044507793), commit `3adb5080920831def4a3ab45705627601cb0ab26`: **SUCCESS, 4/4 jobs**.
- **153/153 Vitest regressions pass, 14 suites**, no skipped tests, including 5 Phase 6 credit note and 4 Phase 6 SLA tests.
- Web TypeScript / Next production build / BFF security HTTP smoke **PASS**, API typecheck & build **PASS**; both production dependency audits **PASS** at configured high/critical threshold.
- This covers the explicitly integrated Phase 6A **credit note + effective SLA** slice only. The source snapshot's 206/206 self-reported tests cover additional modules not yet present in this repository; do not compare totals as though scopes were equal.
- The current successful CI is not a real provider/staging load or security test, and cannot certify tax-compliance or accounting correctness without DEIT Finance sign-off.
