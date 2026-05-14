# Production Deployment Target

Review date: 2026-05-14. Scope: choose the first production target for MoNexus M5 and define the minimal manual deploy path. This document does not add business features and does not store credential values.

## Candidate Matrix

| Target | Fit for MoNexus | Strengths | Gaps / risks | Decision |
| --- | --- | --- | --- | --- |
| Cloudflare Pages | Medium for frontend, weak for the existing backend shape | Native Vite static deployment with `npm run build` and `dist`; preview deployments are built in. Source: [Cloudflare Pages Vite guide](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/index.md). | Pages Functions run on the Workers runtime with a subset of Node.js APIs rather than a dedicated long-running Express process. Source: [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/index.md). The current Express + Prisma backend would need an adapter or a second API host. | Do not choose as the default full-stack target. Viable later for frontend-only hosting if the API stays elsewhere. |
| Vercel | Medium for frontend/serverless, weak for current artifact model | Express can run on Vercel as a Vercel Function. Source: [Express on Vercel](https://vercel.com/guides/using-express-with-vercel). Strong frontend previews and CDN defaults. | Express becomes a function, so runtime limits apply: bundle size, request duration, request body size, and function process model. Source: [Vercel Functions Limits](https://vercel.com/docs/functions/limitations). The existing backend expects a normal Node process, Prisma migration entry, logs, and operational control. | Do not choose as the default target. Revisit only if the app is intentionally reshaped around serverless operations. |
| Fly.io | High if managed app hosting is preferred | Runs Node apps well, supports Dockerfile deployment, `fly launch`, `fly deploy`, rolling updates, app-level configuration, and Fly secrets. Sources: [JavaScript on Fly.io](https://fly.io/docs/js/) and [Deploy with a Dockerfile](https://fly.io/docs/languages-and-frameworks/dockerfile/). | Adds a platform dependency and would need Fly app config, Fly auth, and a separate production database decision. Fly Postgres unmanaged is not the same as a managed database service. Source: [Fly Postgres](https://fly.io/docs/postgres/). | Preferred managed-hosting backup if the user explicitly wants app hosting instead of a VPS. |
| Self-hosted nginx + systemd / PM2 | High | Matches M4 artifacts directly: static frontend in `dist`, compiled backend in `server/dist`, Prisma migrations on the host, existing runbook style, and normal Linux operations. nginx reverse proxy supports passing API traffic to the backend. Source: [nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html). PM2 can generate startup scripts for systemd-backed restarts. Source: [PM2 Startup Script](https://pm2.keymetrics.io/docs/usage/startup/). | Requires an operator-controlled VPS, OS patching, TLS renewal, host monitoring, and a disciplined release directory layout. | Recommended default. Use systemd as the primary supervisor; PM2 is acceptable when the operator already uses it. |

## Recommendation

Default to self-hosted nginx + systemd. It is the smallest maintainable path for the current repository because it preserves the existing React static build, Express server process, Prisma migration flow, M4 artifact layout, backup script, health checks, and runbook conventions. It also keeps gray release and rollback work concrete for A5/A6: switch nginx or a release symlink, restart one service, and smoke `/api/health/live` plus `/api/health/ready`.

Use PM2 only when the host already standardizes on PM2 for Node process management. Otherwise prefer a native `monexus-api.service` unit because systemd is present on the expected Linux VPS baseline and integrates cleanly with journald.

If the user explicitly prefers managed app hosting, choose Fly.io as the backup target. Cloudflare Pages and Vercel remain useful frontend-first platforms, but they do not match the current full-stack backend and deployment artifact model without extra adaptation.

## Production Prerequisites

- A Linux VPS with nginx, Node.js 20, npm, tar, curl, and either systemd or PM2.
- PostgreSQL 16 reachable from the backend host.
- Object storage already provisioned according to the production runbook.
- DNS records for the frontend origin and API origin.
- TLS certificates installed and auto-renewed on the host.
- A non-root deploy user that can write to the MoNexus release directory and restart only the MoNexus backend service.
- Host layout:

```text
/opt/monexus/
  current -> /opt/monexus/releases/<commit-sha>
  releases/
    <commit-sha>/
      frontend/
      server/
```

- nginx configured so the frontend root points at `/opt/monexus/current/frontend` and `/api/` proxies to the backend process on localhost.
- Runtime environment stored on the host, outside the repo, for the backend process.
- A GitHub environment named `production` with these protected values configured before enabling live deploy:

```text
DEPLOY_SSH_HOST
DEPLOY_SSH_USER
DEPLOY_SSH_PRIVATE_KEY
```

Optional GitHub environment variables:

```text
DEPLOY_SSH_PORT
DEPLOY_BASE_PATH
PRODUCTION_HEALTHCHECK_URL
VITE_API_URL
VITE_SENTRY_DSN
```

## Deployment Steps

Manual workflow entry: GitHub Actions -> **Production Deploy** -> **Run workflow**.

1. Select `ref` to deploy. Use `master` for normal production deploys or an exact commit SHA for a rollback entry.
2. Select `environment`. Use `production` for the first real target.
3. Keep `dry_run` enabled for the first pass. The workflow builds artifacts and prints the deployment plan without opening SSH.
4. Confirm the target host has the release layout, nginx config, backend runtime environment, and service supervisor in place.
5. Disable `dry_run` only after the GitHub environment protected values exist.
6. The workflow builds frontend and backend, packages artifacts, uploads them to the selected host, extracts into `/opt/monexus/releases/<sha>`, updates `/opt/monexus/current`, installs production backend dependencies, runs `prisma migrate deploy`, restarts the backend service, reloads nginx, and optionally calls the configured health check URL.
7. After deployment, manually verify:

```bash
curl -fsS https://<api-origin>/api/health/live
curl -fsS https://<api-origin>/api/health/ready
curl -fsS https://<frontend-origin>/BUILD_INFO.json
```

## Rollback Entry

Fast rollback uses the same release directory model:

1. Identify the last known-good release:

```bash
ssh <deploy-user>@<host> 'ls -1 /opt/monexus/releases | tail -n 10'
```

2. Switch the active release and restart:

```bash
ssh <deploy-user>@<host> '
  set -euo pipefail
  cd /opt/monexus
  ln -sfn /opt/monexus/releases/<known-good-sha> current
  sudo systemctl restart monexus-api
  sudo nginx -t
  sudo systemctl reload nginx
'
```

3. If the host uses PM2 instead of systemd:

```bash
ssh <deploy-user>@<host> '
  set -euo pipefail
  cd /opt/monexus
  ln -sfn /opt/monexus/releases/<known-good-sha> current
  cd current/server
  pm2 reload monexus-api || pm2 start dist/main.js --name monexus-api
  sudo nginx -t
  sudo systemctl reload nginx
'
```

4. Smoke the same health endpoints and `BUILD_INFO.json`.

Database rollback is not automatic. If `prisma migrate deploy` applied a bad migration, stop and follow the M5 rollback runbook once A6 lands it; prefer restore into staging and a forward fix over an unsafe manual down migration.

## Downstream Notes

- A2 should own the final protected-value inventory and GitHub environment protection policy.
- A5 should extend this target with blue/green or gray release behavior using the release directory and nginx switch points.
- A6/A8 should link this document from the M5 runbook rather than duplicating every command.
- `.github/workflows/cd.yml` remains unchanged; the new deploy workflow repeats the build commands locally so M4 artifact output contracts stay stable.
