# ICOP Stage 3B — Cloudflare Access gate

Status: **ACCESS + APP MFA CONFIGURED / REAL MFA UAT PENDING / NOT RELEASE READY**
Verified against connected Cloudflare account on 2026-10-12 (Indonesia).
Environment: `icop-staging-api` ONLY; never `icop` production.

## Verified observations (Cloudflare API, read-only)

| Security gate | Observation | Outcome |
|---|---|---|
| Access application | `icop-staging-api - Cloudflare Workers` | Configured |
| Protect traffic | Worker Access / All traffic (dashboard verified) | Configured |
| Access app audience | `de8e1d54820b7a0c1ddbfc808f589e14ba04555256df734a0bea328476e0c904` | Matches Worker `ACCESS_AUD` |
| Identity provider | Cloudflare account | Configured |
| Access policy | `Cloudflare account members`, decision `allow` | Account members; not a single named admin |
| Policy `require` rules | Empty array; no explicit MFA override | Inherits application's independent MFA settings; check enforcement with real sign-in |
| Access session duration | 6 hours | Configured |\n| MFA application configuration | `mfa_disabled=false`; `totp`, `biometrics`, `security_key`; 6h | **Applied to staging and verified through Cloudflare API** |\n| Real MFA challenge (approved user) | Not tested | **UAT required before login activation** |
| Worker `ACCESS_IDENTITY_ENABLED` | `false` | Safe: explicitly disabled |
| Worker D1 | `icop-staging-db` | Bound |
| Staging tenant `DEIT` | Not provisioned; real DB has 0 tenants | BLOCKED |
| Staging users / sessions | 0 users / 0 sessions | No Superadmin |
| Application login / MFA | Not enabled; capability flags false | BLOCKED |

## CI and deployment gates

GitHub Actions `cloudflare-free-native-staging-ci.yml` deliberately separates:

1. **Unit/security tests (offline)**: D1 migration shape, tenant membership,
   role/MFA policy, session expiry/revocation, TOTP replay and Access identity
   fail-closed behaviors using synthetic in-memory fixtures.
2. **Unauthenticated live perimeter**: probes `/health`,
   `/api/v1/system/readiness`, `/api/v1/auth/access-me`, and
   `/api/v1/auth/me`. Each must be denied or redirected to Cloudflare Access.
   Successful public JSON responses mean the test FAILS. This is a negative
   security test, **not** an authenticated health test.

The old public JSON health smoke was intentionally removed from CI when
Access was enabled. A future **authenticated** live health/UAT test requires
a separately approved secure test principal and a suitable service-auth
policy/credential workflow, with no tokens committed to Git. Do not create
an Access bypass or disable the application merely to make CI pass.

## Next steps in Cloudflare Dashboard (owner approval required)

1. Cloudflare organization now allows independent MFA (`totp`, `biometrics`,\n   `security_key`). The staging application has been configured with\n   `mfa_disabled=false` and a 6-hour MFA duration. **Do not change other apps.**\n2. Perform an interactive, authorized staging sign-in to confirm the MFA\n   challenge and MFA device enrollment; inspect that the Allow policy has no\n   overriding `mfa_config` disabling MFA. A configuration read-back alone\n   cannot establish end-to-end MFA enforcement.
3. Consider limiting the Allow policy to named staging administrators
   instead of every member of the Cloudflare account. Keep a reviewed
   emergency administrator path to avoid lockout.
4. Verify an authorized admin with a real MFA challenge can reach the Worker,
   and unauthorized/anonymous users cannot. Be aware `/health` is now
   protected: browser-access checks require sign-in.
5. Obtain explicit approval to create only tenant `DEIT` in D1 staging,
   then provision accounts via controlled validated workflows. Do not copy
   passwords, production identity data or seed values from the frontend.
6. Supply `ACCESS_AUDIT_HMAC_KEY` as a staging Worker secret only after
   reviewing log/pseudonym retention requirements; never store key in Git.
7. Before toggling `ACCESS_IDENTITY_ENABLED`, verify exact Access audience,
   issuer, IdP/MFA requirements, tenant-scoped D1 mapping, role isolation,
   append-only audit, and negative authenticated tests. A read-only
   `202` identity onboarding response is **not** an ICOP application login.
8. Full Superadmin capability requires separate password/MFA enrollment,
   recovery/revocation, session issuance and tenant-level authorization UAT,
   plus sign-off. Leave business endpoints disabled before these pass.

## Internal Worker-to-Worker access gate

Cloudflare Access is an **edge admission control**, not a substitute for
application authorization. A future `icop-staging` frontend can call the
API through an internal Service Binding, rather than the public
`workers.dev` URL. Therefore every business handler must verify the
authoritative app session, tenant, MFA and role independently of which
transport invokes the Worker. Do not interpret an internal binding, a
request header, or the mere presence of `ctx.access` as an ICOP Superadmin
authorization. The API currently returns 503 to unported business routes.

Service Binding docs:
https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/

## Follow-up verification — MFA activation hold

- Connected Cloudflare API still reports **no `require` selectors** in the
  `Cloudflare account members` Access policy. This does **not** prove
  independent MFA is absent; it means an enforced MFA challenge has **not yet
  been verified**, and the security release gate remains blocked.
- The API helper now requires two independently controlled staging flags:
  `ACCESS_IDENTITY_ENABLED=true` and `ACCESS_MFA_CONFIRMED=true`, plus the
  valid `ACCESS_AUD`. Both flags remain `false` in the actual staging
  configuration. A flag is NOT evidence that MFA is really enforced: operators
  must first check the Cloudflare application settings and complete an
  interactive MFA challenge with an authorized test identity.
- New negative tests assert that enabled Access alone with a missing/false
  MFA flag never queries identity memberships and never creates audit records.
- No account / tenant `DEIT` / Superadmin credentials were provisioned,
  and production Worker bindings remain unchanged.
- Do not configure global Zero Trust MFA settings or replace the existing
  Access allow policy without an operator-reviewed lockout and rollback plan.

## References

- Cloudflare Workers Access: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Cloudflare independent MFA: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/
- Cloudflare MFA policy requirements: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/

**Do not merge PR #20 to production. Do not deploy to production.**

## MFA update — staging only (12 October 2026)

Cloudflare app ID `f61e1cef-4104-4e94-aa85-81b59ea0708e` was updated
using the authorized Cloudflare API. A subsequent **GET** confirmed:

- `mfa_config.mfa_disabled = false`
- `mfa_config.allowed_authenticators = [totp, biometrics, security_key]`
- `mfa_config.session_duration = 6h`
- Existing self-hosted Worker destination and single Allow policy preserved.
- Policy MFA override absent; app-level settings apply unless later changed.
- No change to production Worker, `icop` account permissions or D1 user data.

**Still not verified:** actual interactive MFA prompt, authenticators enrolled,
authorized user's email mapping to DEIT, password rotation, in-app MFA/session
issuance, recovery flows, tenant RBAC or business modules. Do not enable
`ACCESS_IDENTITY_ENABLED`, create Superadmin, or merge to production.

Manual MFA UAT: open the staging API URL in a fresh private browser window,
authenticate with an explicitly allowed Cloudflare account, and confirm
additional MFA challenge (or valid already-enrolled, unexpired independent
MFA session), then deny a separate unauthorized identity. Never publish the
MFA codes, recovery keys, session cookies or Access JWT in GitHub/chat.
