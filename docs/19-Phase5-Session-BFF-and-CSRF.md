# Phase 5 Gate 4A — Browser session BFF, httpOnly cookies, CSRF

Status: **implementation on feature branch, pending staging UAT / security review**.

## Security boundary

- Browser calls same-origin Next.js `/api/v1/*` route handlers.
- Next.js forwards requests to private `API_INTERNAL_URL` and attaches JWT from a server-visible `httpOnly` cookie. Browser JS **cannot read JWT**. Raw access tokens from the backend login and password-change responses are not returned to browser.
- Browser reads a distinct CSRF cookie (not the auth cookie) and sends `x-icop-csrf` on unsafe methods. BFF requires both matching Origin and CSRF token. The e-sign webhook is narrowly exempt from browser Origin/CSRF checks; Fastify validates its provider HMAC signature.
- Authentication state is derived on page load from `GET /api/v1/auth/me`, not from persisted browser metadata; local in-memory user metadata is used only for immediate navigation and display.
- Logout clears BFF cookies, while `logout-all` also increments server token version and invalidates issued JWTs; password change rotates the cookie after revoking previous tokens.
- Cookie policy: `httpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`, short max age (8h). `__Host-` cookie names in production prevent domain-scoping/cookie-tossing.
- Reverse proxy must serve the application over HTTPS. Route handler forwards only allowlisted HTTP headers, no client Authorization header or arbitrary upstream URL.
- API core remains bearer-authenticated for controlled service clients and automated tests; it should not be directly exposed from public Internet except where explicitly secured. JWT TTL and BFF max-age must be kept aligned.

## Verification gates

- CI source typecheck and production Next build: `apps/web`.
- BFF HTTP smoke: `node tests/auth-bff-smoke.mjs` in `apps/web`; starts real Next production build and a mock API server and tests login cookie attributes, no JWT leak, origin + CSRF, authorized upload/download, password rotation, logout-all, HMAC webhook forwarding.
- API migration tests: existing PostgreSQL/OCR/S3 integration suites.
- Dependency audits: `npm audit --omit=dev --audit-level=high` for both apps.

## Staging deployment requirements

1. Configure `API_INTERNAL_URL` to the HTTPS API endpoint or private service DNS accessible **from Next.js server-side**. Avoid defaults such as localhost on hosted production environments.
2. In production, configure a valid strong `JWT_SECRET`, managed PostgreSQL `DATABASE_URL`, `ALLOWED_ORIGINS`, `TRUST_PROXY` only behind trusted front proxies, encryption key, `NODE_ENV=production`; do not check them into GitHub.
3. TLS terminated at trusted ingress, HSTS and host validation, access logs with cookie/authorization redaction, ingress-level limits for large uploads and document processing.
4. Confirm same-origin requests use real HTTPS Origin and that `__Host-` cookies persist after login, password change, mobile deep links, and page reload.
5. Exercise tenant-separation negative tests, cross-origin CSRF, invalid/replayed sessions, captured-token revocation, password reset, mobile session expiry, and end-to-end UAT.

## Explicitly NOT yet completed

- MFA / TOTP / phishing-resistant passkeys and privileged step-up: **not implemented by this change**. Treat this as a blocker for broad production rollout.
- Persisted server-side session store/refresh token and per-device session inventory: **not implemented**; JWT sessions rely on `token_version` for global revocation and JWT TTL otherwise.
- Independent penetration test, SAST/DAST, dependency SBOM, mobile/browser E2E, live VIDA/SMTP/S3, backup/restore drill, and real staging deployment: **not verified**.
- CORS, public webhook endpoint, cookie domain, and DNS must be validated against the final staging topology. The BFF intentionally does not proxy arbitrary public API calls.

**Decision:** Passing this test gate is necessary but not sufficient for a production security sign-off. Keep PR in draft until review and remaining Phase 5 gates.
