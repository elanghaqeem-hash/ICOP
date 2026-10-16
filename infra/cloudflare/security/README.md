# Cloudflare staging administrator activation (ICOP)

This integration is **staging-only**, not a production readiness sign-off. The main ICOP web frontend is not yet integrated with this separate Access-protected Worker.

## Installed endpoints

Worker: `icop-staging-api` (Cloudflare account selected by the ICOP owner).

- `GET /activate`: simple owner-managed password activation page.
- `POST /api/v1/auth/activate`: verified Access identity + MFA, password creation and one-time account provisioning.
- `GET /login` and `POST /api/v1/auth/login`: Access + MFA and password.
- `GET /api/v1/auth/me`, `POST /api/v1/auth/logout`: short-lived cookie-backed session and revocation.

**Authorized email:** `goehbudiarto@gmail.com`, tenant `DEIT`. Other Access identities are denied even if they can reach the Worker.

## Release checklist (do not bypass)

1. Confirm that Cloudflare Access protects the Worker itself (not only the health-page bookmark) and that `ctx.access.getIdentity()` returns the verified owner email.
2. **Human UAT:** owner completes an actual Cloudflare Access MFA challenge with a TOTP authenticator, security key, or biometric factor. Verify Access sign-in and policy audit events; a policy configuration alone is not sign-off.
3. Confirm all Access application policies usable by this identity enforce MFA. A less strict allow policy must not bypass the required MFA policy.
4. Confirm the D1 `DEIT` tenant exists, expected identity and audit tables exist, and no active account with that address conflicts.
5. Confirm Worker `SESSION_HMAC_KEY` secret exists (32 bytes, generated via CSPRNG; never log or commit it), D1 binding works, and `ACCESS_AUD` matches the Access application.
6. Only then enable `ACCESS_IDENTITY_ENABLED=true`, `ACCESS_MFA_CONFIRMED=true`, `AUTH_V2_ENABLED=true` and `AUTH_ACTIVATION_ENABLED=true` in the staging Worker.
7. Owner visits the Access-protected hostname `/activate`, completes Access/MFA and sets a *new* 16–128 character mixed-character password, not one shown in screenshots. The account is inserted only for the verified owner and activated once. No password or activation code goes through ChatGPT.
8. Verify password login, invalid password lockout (5 failures / 15 minutes), `/api/v1/auth/me`, logout, session expiry, password not logged, D1 audit records, and fail-closed conditions.
9. Disable `AUTH_ACTIVATION_ENABLED` after the successful one-time activation. Do not advertise the main ICOP app as live until frontend Access integration, DB/API parity, security audit and full application UAT pass.

## Design boundaries

- Uses PBKDF2-SHA256 600,000 iterations with independent random salt; stored hashes only.
- `mfa_enabled=1` in the dedicated staging D1 represents *Cloudflare Access enforced MFA*. It does not mean an ICOP-local TOTP secret was enrolled; the production API uses a distinct app-local MFA process.
- Secure HttpOnly SameSite=Strict cookie holds only a random opaque session token. D1 stores an HMAC hash of the token, tenant/user binding, MFA assurance, token version and expiry. Every session check verifies Access identity and DB membership.
- Access context is **not** propagated through Worker Service Bindings, so forwarding the login request through the current `icop` frontend does **not** authenticate the end user to `icop-staging-api`. A separate same-origin / Access integration is needed before that UI can log in.
- For local tests: `node --test infra/cloudflare/security/auth-v1.test.mjs` (no external credentials required).

Never use a real password from screenshots or seed credentials. Do not set release flags solely because a D1 schema or an Access configuration exists.
