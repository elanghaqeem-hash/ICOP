# ICOP Stage 3B — MFA recovery D1 migration gate

Status: **SOURCE TESTED — NOT APPLIED TO LIVE STAGING D1**.

Basis: uploaded `19-UAT-Pack.md`, U01 (10 one-time recovery codes),
U02 (lost-device reset requires a reason, revokes sessions and forces
re-enrollment), U24 (audit actor, time and IP). Existing Phase 6 source
retains the production Fastify/PostgreSQL implementation as the functional
baseline. Cloudflare D1 is a separate staging implementation.

## Implemented in PR #20
- `src/security/recovery-codes.mjs`: CSPRNG generates 10 independent
  128-bit codes, returns tenant/user-specific HMAC-SHA256 digests.
  **Never store codes in plaintext, browser caches, analytics, Git or logs.**
- `src/security/mfa-reset-policy.mjs`: pure fail-closed role/tenant/SoD,
  session-revocation and audit-plan checks. **No reset API is enabled.**
- `migrations/0004_mfa_recovery_codes.sql`: foreign-key-scoped recovery
  ledger, single-use consumption or revocation, immutable history triggers,
  migration marker written after successful DDL.
- `tests/test_recovery_ledger.py`: SQLite isolation tests for one-time
  use, tenant isolation, hash validity, expiry, revocation and immutability.
  GitHub CI runs these tests without production credentials.

## Cloudflare staging operational observation
- D1 HTTP query API returned SQLITE_ERROR `incomplete input` when
  executing the migration containing SQLite trigger bodies. Breaking the
  migration apart succeeded for table/index but failed on the trigger.
- The half-applied table/index had **0 rows**, and were safely rolled back
  using `DROP TABLE IF EXISTS mfa_recovery_codes` after verifying no
  migration marker. Read-only verification confirmed no leftover objects.
- **Current live D1 schema version is only 0001–0003.** Login and
  `ACCESS_IDENTITY_ENABLED` remain disabled; no tenant or user was added.
- Do NOT run the trigger-free version in a live authentication workflow.
  The entire 0004 migration and its safeguards must be present first.

## Controlled, staging-only alternative (operator workstation)

Use the existing source file rather than reconstructing statements via the
D1 HTTP query API. For an operator with authorized Cloudflare credentials:

```bash
cd infra/cloudflare/free-staging
# This uses Wrangler CLI and its native SQL file execution path.
# Inspect migration first; verify you are in the staging account/database.
npx wrangler d1 execute icop-staging-db --remote --config wrangler.jsonc \
  --file=migrations/0004_mfa_recovery_codes.sql

# Only after a successful, complete migration:
npx wrangler d1 execute icop-staging-db --remote --config wrangler.jsonc \
  --command="SELECT version FROM migration_history ORDER BY version"
npx wrangler d1 execute icop-staging-db --remote --config wrangler.jsonc \
  --command="SELECT name,type FROM sqlite_master WHERE name LIKE 'mfa_recovery_%' ORDER BY name"
```

If Wrangler also cannot apply triggers, STOP. Keep
`ACCESS_IDENTITY_ENABLED=false` and `ACCESS_MFA_CONFIRMED=false`;
do not mark 0004 applied, do not use recovery-code authentication.
Do not apply this migration to `totalarc-db` or any production database.

## Remaining UAT / release blockers
1. Activate and verify real MFA challenge on the **staging-specific**
   Cloudflare Access application. Account-member Allow alone is not enough.
2. Approve tenant DEIT and secure identity provisioning separately.
3. Implement **atomic** code consumption, storage rotation, verified admin
   reset, session invalidation, and append-only audit (actor, time, IP).
   Pure helpers and D1 schema alone do not satisfy U01/U02/U24.
4. Perform authenticated negative tests (cross-tenant, replay,
   concurrent consumption, session revocation, self-reset) and rollback/
   recovery rehearsal before considering `ACCESS_IDENTITY_ENABLED=true`.
5. PR #20 remains Draft. No production merge or deploy.
