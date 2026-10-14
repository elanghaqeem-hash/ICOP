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


## Phase 3C — guarded migration runner (14 October 2026)

The source PR now includes:
- \`scripts/migrate-recovery-0004.mjs\` (default \`--validate-source\`):
  validates canonical SQL triggers, expected Cloudflare staging Worker, D1
  identity, Access AUD and both fail-closed feature flags **without network**.
- \`--check\`: read-only authenticated Wrangler remote D1 preflight. Requires
  exact staging account, migrations 0001–0003 only, no partial recovery
  tables/triggers and zero tenants/users/auth sessions/audit rows.
- \`--apply\`: protected one-time SQL-file execution using Wrangler
  \`d1 execute --remote --file\`. Requires exact operator approval, makes a
  restricted local SQL export backup outside the repository, preserves that
  backup after success/failure, then validates migration marker, table, index,
  both immutable-state triggers, recovery table row count and SQLite FK
  integrity. **Does NOT seed any user or enable authentication.**

The runner is intentionally **NOT run automatically from GitHub CI** and
**NOT performed through the SQL-splitting Cloudflare D1 query API**.
Live migration remains pending until an authorized operator reviews the
gate and performs the file import with a valid Wrangler session/token.

From \`infra/cloudflare/free-staging\` on an authorized operator workstation:

\`\`\`sh
npm install
node scripts/migrate-recovery-0004.mjs --validate-source

# READ-ONLY remote preflight: correctly set account scope / CLI credentials.
export CLOUDFLARE_ACCOUNT_ID=208155f241d4da84e1a6a9b44b7a8d28
node scripts/migrate-recovery-0004.mjs --check

# Only AFTER written approval and verified empty staging database:
# mkdir /path/outside/repo/private-icop-backups && chmod 700 ...
export ICOP_D1_BACKUP_DIR=/absolute/private/backup/directory
export ICOP_D1_0004_APPROVED=APPLY_0004_STAGING_ONLY_8a454b5e-597a-49fd-a51e-1730786de740
node scripts/migrate-recovery-0004.mjs --apply
\`\`\`

Treat any preflight failure, migration exception or incomplete postflight as
a **STOP**. Do not retry by splitting SQL or marking the migration complete
manually. Preserve and securely review the backup; inspect D1 state with an
authorized operator before a reviewed rollback. Keep the two Access flags
\`false\`, PR Draft and Superadmin unprovisioned.
