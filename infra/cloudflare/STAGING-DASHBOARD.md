# ICOP Staging Dashboard ↔ Cloudflare Access

## Why this is needed
The existing \`icop\` Next.js BFF uses a different \`__Host-icop-session\` cookie
and an upstream bearer JWT. The independent staging API uses a D1-bound
\`__Host-icop-staging-session\` cookie that validates Cloudflare Access on every
request. Forwarding the JWT, copying cookies, or forwarding Access context
through Service Bindings is **not** safe or supported.

## Staging-only architecture
Cloudflare Access + Independent MFA → \`icop-staging-api\` Worker
→ \`handleStagingDashboard\` → D1-authenticated \`handleAuthV1\`
→ Service Binding \`ICOP_FRONTEND\` → existing \`icop\` Next.js UI (GET only).

- GET /login serves a responsive staging-only login UI (the live `icop` Worker
  still contains an outdated readiness form);
  POST /api/v1/auth/login runs the verified D1/Access/MFA password flow on the
  **same origin** and sets Secure HttpOnly session cookies.
- GET /api/v1/auth/me validates the D1 token, tenant and user role and returns
  the shape expected by Next Shell. Permissions come from the staging server,
  not a client header. No JWT or session token is exposed to JavaScript.
- GET / and other UI paths require a valid server-side session, then render
  the existing Next.js frontend via a GET-only service binding for dashboard and static Next assets.
- POST /api/v1/auth/logout performs a same-origin check, invokes D1 session
  revocation and clears the cookie; navigation to /login is handled by Shell.
- Protected static and Next assets are proxied only after Access verifies the
  owner. Auth cookies are stripped from requests and \`Set-Cookie\` from frontend
  responses, preventing cross-worker cookie contamination.
- Business API endpoints that are **not migrated to D1** return 503
  \`STAGING_BUSINESS_API_NOT_MIGRATED\`, never dummy data or a fake success.
- \`/health\`, readiness and owner activation/reset retain their original
  behavior. \`AUTH_ACTIVATION_ENABLED=false\` stays unchanged.
- This **does not deploy or change** the existing \`icop\` production Worker,
  and must not be represented as a finished business-API integration.

## Deployment checklist
1. Review code, run both node test suites and GitHub CI.
2. Confirm Cloudflare Access application on \`icop-staging-api\` only permits
   \`elang.haqeem@gmail.com\` with Independent MFA.
3. Add the Cloudflare **service** binding \`ICOP_FRONTEND\` pointing at
   Worker \`icop\`, environment \`production\`. Do not add client
   credentials or passwords.
4. Deploy \`staging-dashboard-worker.mjs\` (as \`worker.mjs\`) and
   \`staging-dashboard.mjs\` in the SAME multipart script deployment; inherit
   existing D1, session HMAC secret, Access audience and authentication flags.
5. Re-read script and settings to confirm both modules, Access/MFA flags,
   D1, secret and \`AUTH_ACTIVATION_ENABLED=false\`.
6. Test fresh anonymous visit: Cloudflare Access challenge, then responsive
   staging login page backed by the existing D1 auth module. Verify same-origin password login → / dashboard and
   \`/api/v1/auth/me\` returns approved role with permissions.
7. Confirm unknown business endpoints return 503 after login and 401
   without a D1 session. Confirm logout revokes the D1 session and redirects
   to login. Test new/fresh browser and mobile screen width.
8. Review Cloudflare request logs without reading password, cookies or
   bearer secrets.
9. Restore original Worker modules and remove \`ICOP_FRONTEND\` binding if
   any authenticated page is bypassed or Next Service Binding fails.

## Known limitations
- No migrated CRM, pricing, quotation or tender business API backend in the
  Cloudflare staging Worker. Data-backed dashboard widgets are not ready.
- Super-admin authorization is enforced for protected staging requests;
  full RBAC for all future tenant roles/modules requires the relevant
  server endpoints to be migrated and verified.
- Session duration is 30 minutes; an expired session redirects to login.
- The KDF in this staging Worker is a versioned chained PBKDF2 variant,
  which needs separate security review for production.
