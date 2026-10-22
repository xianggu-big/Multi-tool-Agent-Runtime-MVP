# acme-auth

A tiny authentication service used by the compaction A/B evaluation.

Modules:

- `src/auth/` — login, password, session, token
- `src/db/` — users and audit persistence
- `src/http/` — router and handlers
- `src/legacy/` — old cookie-v1 login path
- `docs/incident-2026-10.md` — incident report for the login 500

This fixture is read-only for the evaluation. Do not edit it.