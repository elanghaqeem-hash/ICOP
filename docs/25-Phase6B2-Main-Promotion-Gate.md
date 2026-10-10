# Phase 6B2 — Controlled Promotion to `main`

Date: 10 October 2026. Change scope: source-code branch promotion for a **new, explicitly tenant-opt-in AI assistant**. This record does not certify production runtime readiness, service security, legal compliance, or any Cloudflare deployment.

## Reconciliation and scope

- Original development PR [#5](https://github.com/elanghaqeem-hash/ICOP/pull/5) was stacked on `feature/phase5-source-integration`. That parent PR [#1](https://github.com/elanghaqeem-hash/ICOP/pull/1) is already merged to `main`; Phase6A SLA/credit notes and Phase6B1 tender keyword assistant were also promoted in an independent source-only release.
- PR #5 base has now been changed to `main` and GitHub reports no merge conflict. The resulting diff is restricted to Phase6B2: SQL migration 013; tender compliance generation/review routes; configurable AI feature flag; dashboard; five existing test cases and defensive defaults; supporting docs. No Phase6A/6B1 files should be duplicated.
- New safeguard: `tender_compliance` **defaults DISABLED unless an authorized tenant administrator explicitly enables it** through `PUT /api/v1/ai/features`; `GET /api/v1/ai/features` shows the same effective status.
- When disabled, the pending-suggestions read returns `{items: [], enabled: false}` without accessing migration-013 tables. Generation and review writes fail closed with `AI_DISABLED`. Mobile UI explains why creation is disabled.
- No production credentials, pricing secrets, API tokens, signing certificates or real tender content are part of this source promotion.

## GitHub checks before merging

1. PR base is `main`, not a historical feature branch; GitHub reports `mergeable=true` and zero active conflicts.
2. GitHub Actions **must run on a PR event with base `main`** after the final safeguard commit, and API 16-suite regressions, Web typecheck/Next build, BFF smoke, and both production dependency audits must pass. Do not substitute successful runs from the former PR base.
3. Migration `013_phase6_tender_suggestions.sql` must be tested against migrations 001–012. Duplicate migrations or schema replacement are forbidden.
4. Confirm the new opt-in regression and explicit default OFF, maker-checker, audit, tenant data scoping, rejection of revoked evidence and downgraded hallucinated quotes.
5. Review any PR review threads and the current branch head before merging. Use GitHub's expected-head check, never force-push.
6. Prefer a distinct human reviewer for authorization, especially for changes in AI security and bid compliance.

## Runtime deployment gate — separately required

No automatic rollout is authorized by source-code CI. **Before activating `tender_compliance` in a real tenant**:

- Verify repository visibility (currently public) is acceptable to the owner; business secrets, customer data, vendor terms and private pricing must never be committed.
- Establish a genuine HTTPS staging environment and operator identity, tested PostgreSQL DB connections, tested backup/restore, secrets management and internal API reachability.
- Apply migration 013 through the versioned migrator with a recoverable snapshot and verify `schema_migrations`; ensure MFA, BFF sessions, CSRF and multi-tenant boundaries remain intact.
- Perform independent security review/pentest and mobile UAT with *approved redacted sample* RKS documents; verify the AI provider contract/data residency/retention policies, cost limits, prompt-injection handling and claim provenance.
- Exercise maker-checker with two real distinct authorized reviewers, revoke evidence between suggestion and acceptance, verify denied cross-tenant reads/writes and complete audit trail; obtain Tender, Legal, IT Security and owner acceptance.
- Activate `tender_compliance` only for the explicitly approved tenant. Monitor `ai_calls`, latency/error budget, exception logs and potential cost growth.

## Operational rollback

- Immediate non-destructive kill switch: tenant admin sets `tender_compliance: false`; generator/acceptance routes are then blocked. PENDING suggestions are preserved for review if later re-enabled.
- If runtime deployment causes incidents, roll back to the previously proven application version using the hosting provider's rollback capability; verify database compatibility before reverting migration 013. Do not delete financial or audit data to roll back.
- If schema migration has not been applied, keep feature OFF and defer full UI functionality. Never assume a GitHub CI `PASS` implies live API or production deployment is healthy.

## Current gate disposition

**PREPARED FOR SOURCE REVIEW — PRODUCTION ACTIVATION BLOCKED** pending real staging, independent security assessment, data-owner UAT and explicit operational release authorization. Retargeting and successful CI alone are insufficient evidence of live readiness.
