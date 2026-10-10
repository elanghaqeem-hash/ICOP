# Phase 5 — Gate 4C: Approval Step-up, Multi-Tenant Isolation & MFA Recovery

**Status:** Source implemented on PR #1, with CI evidence recorded below. Not a production sign-off.

## Basis dokumen dan provenance

This work continues the owner-provided Phase 1–4 source and Phase 5 README. The latest uploaded `icop-phase5-dev/README.md` is byte-identical to `README.md` in the previously provided Phase 5 source ZIP, and should be treated as the **same baseline document**, not a newly validated code revision. The authoritative implementation is the live GitHub feature branch.

References to uploaded source artifacts:
- `docs/04-Role-Permission-DoA.md`: 20 roles, role-permission matrix, maker-checker, most stringent DoA and append-only approval decisions;
- `docs/17-Phase2b-Phase4-Gate-Report.md`: real business modules for tender, FlexGuard wallet, contracts, documents, projects, billing and helpdesk;
- `docs/18-Phase5-Security-and-Release-Checklist.md`, `docs/19-Phase5-Session-BFF-and-CSRF.md`, `docs/20-Phase5-Gate4B-TOTP-MFA-and-Tenant-Isolation.md`: earlier security hardening and blockers.

Claims about the older reports are **source-reported functional gates**, not proof of an independently audited live production deployment.

## Gate 4C implementation

### A. Decision Center: fresh TOTP step-up

- `apps/api/src/lib/approval-mfa.ts` requires a verified MFA claim with `mfaAt` within 300 seconds for roles that require MFA.
- `apps/api/src/modules/quotations/routes.ts` enforces step-up before **all approval decisions** (Approve / Reject / Request Revision), on the backend rather than by hiding a UI button.
- `POST /api/v1/auth/mfa/step-up` requires the user's **existing verified MFA session** plus a **new unused TOTP code**. The secret remains encrypted in PostgreSQL. A replayed code is rejected and failed attempts lead to lockout.
- A new short-freshness JWT remains exclusively in an `httpOnly Secure SameSite` session cookie through Next.js BFF. The browser does not receive raw JWTs.
- The mobile Decision Center prompts for TOTP when receiving `MFA_STEP_UP_REQUIRED`. The original decision is resumed only after step-up succeeds.

**Security note:** 300-second freshness is not a cryptographic transaction-signing proof bound to a specific approval ID. For very high-risk signatures, consider WebAuthn/passkeys with transaction-specific challenge and appropriate UAT.

### B. Cross-tenant object-level and list isolation

`apps/api/tests/e2e.phase5.tenant-isolation.test.ts` creates real tenant A rows plus a second tenant B with legitimate `company_admin` role. It validates that tenant A can read records, but tenant B cannot discover/read records through ID endpoints or list endpoints for:

1. CRM customers
2. Tenders
3. Quotations
4. Restricted documents
5. Contracts
6. Projects
7. Invoices / billing
8. FlexGuard wallets

The tests exercise live PostgreSQL-backed API routes, **not just guessed 404 IDs or missing-role 403 checks**. These tests do not yet cover every nested document/file download, customer portal cross-customer restrictions or cross-tenant S3 bucket policy.

### C. Controlled recovery of lost MFA devices

Migration `apps/api/migrations/011_phase5_mfa_recovery.sql` and `apps/api/src/modules/auth/recovery.ts` implement:

- `GET /api/v1/auth/mfa/recovery-targets`: eligible active users in the same tenant;
- `GET /api/v1/auth/mfa/recovery-requests`: recovery queue and history in the same tenant;
- `POST /api/v1/auth/mfa/recovery-requests`: first administrator submits a justification of at least 20 characters, targeting another user;
- `POST /api/v1/auth/mfa/recovery-requests/:id/approve`: **second independent administrator** approves within 24 hours;
- `POST /api/v1/auth/mfa/recovery-requests/:id/reject`: independent rejection.

Admin controls: only `company_admin` / `super_admin` with **active MFA and fresh ≤300-second step-up** can take recovery actions. The applicant cannot approve their own request or act as the target. PostgreSQL transactions lock pending requests for review. Only one pending recovery is permitted per user and tenant, and recovery reasons/audit events remain recorded.

On approval, the target's MFA secret is invalidated, `token_version` is incremented (all old sessions revoked), and `force_password_change` is set. Next login requires the user's password, password rotation and **new MFA enrollment**. No temporary login password or universal MFA bypass is generated.

Mobile admin interface: `/security/mfa-recovery` in authenticated ICOP navigation. Workflow provides eligible user selection, justification, independent approval/rejection, queue display and fresh TOTP verification.

**Operational gap:** if every recovery-capable administrator has lost MFA, no self-service recovery is permitted. A separately governed break-glass/offline identity verification runbook must be approved by the owner before production. Additional evidence-attachment and dual-control verification should be assessed in UAT.

## Test record

- **CI commit:** `8bfd99e8c6335269d6dbfbeda6764c3e7922acb7`.
- **GitHub Actions run:** https://github.com/elanghaqeem-hash/ICOP/actions/runs/38040624016
- **Results:** 4/4 CI jobs PASS; **144/144 API tests PASS across 12 suites**, Web typecheck/build and BFF HTTP security smoke PASS; API/Web `npm audit --omit=dev --audit-level=high` PASS.
- New Gate 4C tests: 8 business-module isolation, step-up recency/replay, 5 two-person recovery tests.
- Staging HTTPS, independent penetration test, backup restore, external identity assurance and actual live provider connection **not tested by this CI**.

## Remaining production gate

- [ ] Keep GitHub repository private (or demonstrate approval to publish pricing and proprietary policy implementation).
- [ ] Deploy to isolated HTTPS staging with correct `APP_PUBLIC_ORIGIN`, `API_INTERNAL_URL`, signed TLS, secret manager and **production-equivalent** MFA policy.
- [ ] Test complete two-person recovery workflow on real desktop/Android/iOS devices; back-up credentials and offline incident recovery runbook.
- [ ] Extend tenant negative tests to nested resources: signed files, object store, exports, attachments, portal customer isolation, cross-tenant permission update, audit logs, S3 object keys.
- [ ] Test role changes and adverse interleavings (concurrent OTP, recovery approval races, expired recovery request, state changes between recovery request and approval).
- [ ] Verify UAT of price/cost confidentiality, SoD, board-level delegated authority, legal templates, payment ledger and audit trails.
- [ ] Configure log redaction/observability, SAST/DAST and independent pentest, rate limits across all replicas, incident response, secret rotation, backup/restore proof.
- [ ] Verify real SMTP/S3/VIDA credentials in **sandbox**; Privy adapter remains pending official API support as stated by original source.
- [ ] Obtain formal owner security and business sign-off and documented rollback before production merge.

**Decision:** Gate 4C functional code/CI is green, but the **production release gate remains BLOCKED**. PR stays Draft.
