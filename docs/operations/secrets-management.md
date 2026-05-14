# Production Secrets Management

Review date: 2026-05-14. Scope: M5 production and staging secret inventory for frontend, backend, PostgreSQL, JWT, Sentry, SMTP, S3-compatible storage, metrics, backup, deploy, and alert routing. No secret values belong in this repository.

## Default Approach

Use GitHub Actions Environments named `staging` and `production`.

GitHub environment secrets are only available to jobs that declare the matching environment, and jobs must pass configured environment protection rules before those secrets can be read. GitHub also supports repository, organization, and environment-level secrets. Sources: [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) and [Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/using-secrets-in-github-actions).

### Environment Policy

| Environment | Required reviewers | Deployment branches/tags | Secret owner | Intended use |
| --- | --- | --- | --- | --- |
| `staging` | 0 required; optional reviewer from Ops when testing production-like credentials | `master`, `integration/m5-rc`, `ops/m5-*`, release tags | Ops lead | Dry-runs, staging deploys, alert-rule tests, smoke before production |
| `production` | At least 1 required reviewer from repo admins or Ops; disallow self-review where GitHub plan supports it | `master` and signed release tags only | Ops lead with Security backup | Production deploy, production backup, production alert routing |

Use **environment secrets** for credential material and **environment variables** for public or non-sensitive configuration. Frontend Vite values are embedded into static assets at build time, so `VITE_API_URL` and `VITE_SENTRY_DSN` must be treated as public environment variables, not secrets.

## Inventory

| Name | Type | Environments | Owner | Purpose | Set in GitHub | Consumed by |
| --- | --- | --- | --- | --- | --- | --- |
| `VITE_API_URL` | Environment variable | `staging`, `production` | Frontend/Ops | Browser-facing API origin used during Vite build | Environment variables | `.github/workflows/cd.yml`; A1/A5 deploy workflow build job |
| `VITE_SENTRY_DSN` | Environment variable | `staging`, `production` | Observability | Public frontend Sentry or GlitchTip DSN baked into Vite build | Environment variables | `.github/workflows/cd.yml`; frontend bundle |
| `FRONTEND_ORIGIN` | Environment variable | `staging`, `production` | Backend/Ops | CORS origin and email-link fallback | Environment variables or deploy host env | backend runtime |
| `APP_BASE_URL` | Environment variable | `staging`, `production` | Backend/Ops | Public URL used in transactional email links when different from `FRONTEND_ORIGIN` | Environment variables or deploy host env | backend runtime |
| `DATABASE_URL` | Secret | `staging`, `production` | DBA/Ops | Backend Prisma connection string for app runtime and migrations | Environment secrets | backend runtime; A1/A5 deploy migration step |
| `POSTGRES_USER` | Secret | `staging`, `production` | DBA/Ops | PostgreSQL app role for self-hosted compose targets | Environment secrets | `docker-compose.prod.yml`; host provisioning |
| `POSTGRES_PASSWORD` | Secret | `staging`, `production` | DBA/Ops | PostgreSQL app role credential | Environment secrets | `docker-compose.prod.yml`; host provisioning |
| `POSTGRES_DB` | Environment variable | `staging`, `production` | DBA/Ops | PostgreSQL database name | Environment variables | `docker-compose.prod.yml`; host provisioning |
| `JWT_SECRET` | Secret | `staging`, `production` | Backend/Ops | Access-token signing material; rotate with forced refresh-token revocation plan | Environment secrets | backend runtime |
| `COOKIE_SECURE` | Environment variable | `staging`, `production` | Backend/Ops | Enables Secure cookie flag in HTTPS environments | Environment variables | backend runtime |
| `USER_STATUS_CACHE_TTL_SEC` | Environment variable | `staging`, `production` | Backend/Ops | In-memory status-cache TTL | Environment variables | backend runtime |
| `SENTRY_DSN` | Secret | `staging`, `production` | Observability | Backend Sentry or GlitchTip DSN | Environment secrets | backend runtime |
| `SENTRY_AUTH_TOKEN` | Secret | `staging`, `production` | Observability | Optional API credential for A3 alert-rule automation; not needed for runtime event ingestion | Environment secrets | A3 alert configuration workflow or manual script |
| `SENTRY_ORG` | Environment variable | `staging`, `production` | Observability | Sentry organization slug for alert-rule automation | Environment variables | A3 alert configuration workflow or manual script |
| `SENTRY_PROJECT_FRONTEND` | Environment variable | `staging`, `production` | Observability | Frontend Sentry project slug | Environment variables | A3 alert configuration workflow or manual script |
| `SENTRY_PROJECT_BACKEND` | Environment variable | `staging`, `production` | Observability | Backend Sentry project slug | Environment variables | A3 alert configuration workflow or manual script |
| `SMTP_HOST` | Environment variable | `staging`, `production` | Backend/Ops | SMTP relay host | Environment variables | backend runtime |
| `SMTP_PORT` | Environment variable | `staging`, `production` | Backend/Ops | SMTP relay port | Environment variables | backend runtime |
| `SMTP_SECURE` | Environment variable | `staging`, `production` | Backend/Ops | Nodemailer TLS mode | Environment variables | backend runtime |
| `SMTP_USER` | Secret | `staging`, `production` | Backend/Ops | SMTP auth user when relay requires auth | Environment secrets | backend runtime |
| `SMTP_PASS` | Secret | `staging`, `production` | Backend/Ops | SMTP auth password or provider token | Environment secrets | backend runtime |
| `SMTP_FROM` | Environment variable | `staging`, `production` | Backend/Ops | Verified sender address | Environment variables | backend runtime |
| `STORAGE_ENDPOINT` | Environment variable | `staging`, `production` | Storage/Ops | S3, R2, OSS, Backblaze, or MinIO endpoint | Environment variables | backend runtime; `docker-compose.prod.yml` |
| `STORAGE_REGION` | Environment variable | `staging`, `production` | Storage/Ops | SDK signing region | Environment variables | backend runtime; `docker-compose.prod.yml` |
| `STORAGE_BUCKET` | Environment variable | `staging`, `production` | Storage/Ops | Product image bucket | Environment variables | backend runtime; `docker-compose.prod.yml` |
| `STORAGE_ACCESS_KEY` | Secret | `staging`, `production` | Storage/Ops | Object-storage access credential | Environment secrets | backend runtime; `docker-compose.prod.yml` |
| `STORAGE_SECRET_KEY` | Secret | `staging`, `production` | Storage/Ops | Object-storage secret credential | Environment secrets | backend runtime; `docker-compose.prod.yml` |
| `STORAGE_PUBLIC_URL_BASE` | Environment variable | `staging`, `production` | Storage/Ops | Public CDN or bucket URL prefix rendered to clients | Environment variables | backend runtime |
| `STORAGE_FORCE_PATH_STYLE` | Environment variable | `staging`, `production` | Storage/Ops | S3 client path-style setting | Environment variables | backend runtime |
| `METRICS_TOKEN` | Secret | `staging`, `production` | Observability | Bearer token for `/api/metrics` | Environment secrets | backend runtime; Prometheus scrape config |
| `BACKUP_DATABASE_URL` | Secret | `production` | DBA/Ops | Read-only database URL for scheduled `pg_dump` | Repository secret today; move to `production` environment when `.github/workflows/backup.yml` is assigned for modification | `.github/workflows/backup.yml` |
| `RESTORE_TARGET_URL` | Secret | `staging` | DBA/Ops | Staging-only restore target for backup restore rehearsals | Environment secrets | manual restore commands / future rollback workflow |
| `DEPLOY_SSH_HOST` | Secret | `staging`, `production` | Ops | Target host for self-hosted deploy | Environment secrets | A1/A5 deploy workflow |
| `DEPLOY_SSH_USER` | Secret | `staging`, `production` | Ops | Non-root deploy user | Environment secrets | A1/A5 deploy workflow |
| `DEPLOY_SSH_PRIVATE_KEY` | Secret | `staging`, `production` | Ops | Private key for the deploy user | Environment secrets | A1/A5 deploy workflow |
| `DEPLOY_SSH_PORT` | Secret | `staging`, `production` | Ops | SSH port when not `22` | Environment secrets | A1/A5 deploy workflow |
| `DEPLOY_BASE_PATH` | Environment variable | `staging`, `production` | Ops | Base release directory, default `/opt/monexus` | Environment variables | A1/A5 deploy workflow |
| `PRODUCTION_HEALTHCHECK_URL` | Environment variable | `production` | Ops | Post-deploy readiness check URL | Environment variables | A1/A5 deploy workflow |
| `STAGING_HEALTHCHECK_URL` | Environment variable | `staging` | Ops | Staging post-deploy readiness check URL | Environment variables | A1/A5 deploy workflow |
| `ALERT_SLACK_WEBHOOK_URL` | Secret | `staging`, `production` | Observability | Slack incoming webhook for alert routing | Environment secrets | A4 alert routing |
| `ALERT_EMAIL_TO` | Environment variable | `staging`, `production` | Observability | Email destination for alert routing | Environment variables | A4 alert routing |
| `ALERT_EMAIL_FROM` | Environment variable | `staging`, `production` | Observability | Sender identity for alert emails | Environment variables | A4 alert routing |
| `PAGERDUTY_ROUTING_KEY` | Secret | `production` | Observability | Optional PagerDuty Events routing key for P0 escalation | Environment secrets | A4 alert routing |

## Setup Procedure

1. Create `staging` and `production` under GitHub -> Settings -> Environments.
2. Configure protection rules:
   - `staging`: no hard approval gate by default; allow M5 wave branches and `integration/m5-rc`.
   - `production`: require at least one reviewer, restrict deployments to `master` and release tags, and disable admin bypass when the GitHub plan supports it.
3. Add environment variables first. These values are visible to workflow logs when printed, so never put credentials in variables.
4. Add environment secrets second. GitHub masks secret values in logs, but workflow authors must still avoid printing or passing them through command-line arguments.
5. Keep `BACKUP_DATABASE_URL` as a repository secret until the backup workflow is assigned for environment scoping. A2 does not modify `.github/workflows/backup.yml`.
6. Ask A1/A5 to consume the deploy names in this document. If `.github/workflows/deploy.yml` is absent on a Wave 1 branch, do not create it from A2.

## Rotation Rules

| Secret group | Rotation trigger | Rotation steps |
| --- | --- | --- |
| `JWT_SECRET` | Suspected signing leak, operator departure, or scheduled security rotation | Add new value to environment, deploy, revoke all refresh tokens, force re-login, retain incident note. |
| PostgreSQL credentials | DBA rotation window or access leak | Create new DB role credential, update GitHub environment and host env, restart backend, then remove old credential. |
| SMTP credentials | Provider rotation window or mail abuse incident | Rotate provider credential, update environment secret, redeploy/restart backend, send test password-reset email in staging. |
| Storage credentials | Storage provider rotation window or object access leak | Create least-privilege replacement key, update environment secret, smoke upload/download in staging, revoke old key. |
| `METRICS_TOKEN` | Scrape target leak or monitoring staff change | Update backend env and Prometheus scrape config in the same window, then restart backend. |
| Deploy SSH key | Deploy host operator change, runner compromise, or scheduled rotation | Add new public key to deploy user, update environment secret, dry-run deploy, remove old public key. |
| Alert routing credentials | Webhook/channel change or incident leak | Rotate webhook/routing key, send staging test alert, then update production. |
| `SENTRY_AUTH_TOKEN` | Observability owner change or API token scope change | Create scoped replacement token, update environment secret, run A3 alert-rule dry-run, revoke old token. |

## GitHub vs Doppler vs Vault

| Option | Role | Advantages | Costs / risks | Decision |
| --- | --- | --- | --- | --- |
| GitHub Actions Environments | Default | Already available where workflows run; supports environment secrets, environment variables, deployment protection rules, reviewers, and branch restrictions. | Tied to GitHub Actions; local host env still needs operator discipline; complex cross-repo sharing is limited. | Use now. |
| Doppler | Optional future layer | Can sync Doppler-managed secrets into GitHub repository, organization, or environment secrets, and can sync unmasked values as GitHub variables. Source: [Doppler GitHub Actions integration](https://docs.doppler.com/docs/github-actions). | Adds another SaaS, access model, audit surface, and source of truth. Existing GitHub secret values cannot be imported directly through GitHub's API. | Compare only; do not make it a default dependency. |
| HashiCorp Vault / HCP Vault | Optional future layer for larger ops | Centralized, audited privileged access and secret management; supports static secrets, certificates, identity, third-party secrets, and database secret plugins. Source: [What is Vault?](https://developer.hashicorp.com/vault/docs/what-is-vault). | Self-hosted Vault is operationally heavy; even managed HCP Vault adds policy, auth, network, and availability work beyond M5's minimum path. | Compare only; use later if MoNexus needs dynamic credentials or centralized multi-system secret governance. |

## Handoff Notes

- A1/A5: declare `environment: staging` or `environment: production` on deploy jobs before reading deploy secrets.
- A3: use `SENTRY_AUTH_TOKEN` only for alert-rule automation; DSNs are for event ingestion.
- A4: default to `ALERT_SLACK_WEBHOOK_URL` or email; `PAGERDUTY_ROUTING_KEY` is optional and production-only.
- A6/A8: link this inventory in rollback/runbook sections and avoid duplicating secret values.
- Operators: never paste values into docs, PR comments, issue comments, workflow logs, or screenshots.
