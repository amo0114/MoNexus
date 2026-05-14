# OpenAPI M5 Decision Note

Review date: 2026-05-14. Scope: decide whether M5 deployment, alerting, gray release, and rollback work changes the public MoNexus HTTP API contract.

## Decision

M5 is an OpenAPI no-op. Keep `docs/superpowers/specs/monexus-api-openapi.json` at `info.version` `1.3.0`; do not bump to `v1.4.0`.

## Evidence

M5 adds operator workflows, operations documents, and env example documentation only:

- `.github/workflows/deploy.yml`
- `.github/workflows/alert-routing-test.yml`
- `.github/workflows/sentry-alert-check.yml`
- `docs/operations/deployment-target.md`
- `docs/operations/secrets-management.md`
- `docs/operations/sentry-alert-rules.md`
- `docs/operations/alert-routing.md`
- `docs/operations/gray-release.md`
- `docs/operations/rollback-runbook.md`
- `.env.example`
- `server/.env.example`

The M5 branch does not add or change a public MoNexus endpoint, request body, response body, auth scheme, error envelope, or HTTP status contract. The only `server/**` file changed by the M5 merge range is `server/.env.example`, which documents environment names and does not define an API route, controller, service, middleware, or Prisma schema contract.

The new workflows call existing operational endpoints only:

- `GET /api/health/live`
- `GET /api/health/ready`
- `GET /api/metrics` remains the M4 metrics endpoint already documented in OpenAPI `v1.3.0`.

Slack, Sentry, SSH, nginx, systemd, PM2, and GitHub Actions interactions are external operations integrations. They are not part of the public MoNexus HTTP API surface documented by OpenAPI.

## When to Bump

Bump OpenAPI to `v1.4.0` only when a future change modifies the public HTTP contract, such as:

- adding, removing, or renaming a `/api/*` endpoint
- changing request or response schemas
- changing authentication or authorization behavior visible to API callers
- changing public error codes, response status codes, pagination, or query parameters
- adding a public operational endpoint beyond the M4 health and metrics contracts

If a future M5 follow-up adds a real endpoint, update `docs/superpowers/specs/monexus-api-openapi.json`, change `info.version` to `1.4.0`, and include the route/schema evidence in the same commit.
