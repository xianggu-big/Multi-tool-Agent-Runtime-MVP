# Incident 2026-10: login 500

## Timeline

- 18:02:14 — POST /login with `{"email": null, "password": "x"}`.
- 18:02:14 — `normalizeEmail(null)` throws `TypeError: Cannot read properties of null (reading 'trim')`.
- 18:02:14 — `handleLogin` catches the error and returns HTTP 500.
- 18:02:15 — The client retries five times. Each failure increments the attempt counter.
- 18:02:16 — The account is now locked with `ACCOUNT_LOCKED` even though the password was never checked.
- 18:03:01 — The legacy cookie-v1 path receives the same payload. `normalizeEmailLegacy` turns null into `''` and does not trim, so it fails later with a different error.
- 18:04:20 — Audit review finds no `recordAudit` entry for the 500s. The generic catch in `handleLogin` never records the failure.
- 18:05:00 — Session cookie is still `acme_sid`; the incident is not a cookie-name problem.
- 18:06:00 — `AUTH_TIMEOUT_MS` is 1500; the timeout is not the root cause.

## Root-cause chain

1. Bad input reaches `normalizeEmail` without validation.
2. `normalizeEmail` calls `.trim()` on null and throws.
3. `handleLogin` maps the TypeError to a generic 500.
4. The 500 path skips `recordAudit`, so the failure is invisible in audit.
5. Repeated 500s hit `MAX_LOGIN_ATTEMPTS` and lock the account.
6. The legacy path hides the null differently and keeps whitespace.

## Minimal fix

Validate `email` and `password` before `normalizeEmail`, return 400 for missing fields,
and record an audit entry in the catch path. Keep the cookie name and timeout unchanged.