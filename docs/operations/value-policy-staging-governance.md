# ValuePolicy Staging Governance Runbook

This runbook operates only the isolated `staging` GitHub Environment and
`/opt/monexus-staging`. Production governance remains disabled and production
must keep `POINT_VALUE_POLICY_MODE=off`.

## Frozen Rehearsal Policy

| Field | Value |
| --- | --- |
| policy id | `vp_cny_100_staging_20260826_v1` |
| version | `2026082601` |
| effective at | `2026-08-26T00:00:00.000Z` |
| ratio | `100 PTS = 1 CNY` (`1 / 1` CNY atomic per point) |
| disclosure | `zh-CN-v1` |
| D-02 record SHA-256 | `02a0d6642fec6cf542805d20970eb9d489dae8180775bc719349d1153867a998` |
| D-03 record SHA-256 | `72c148a645f9aaff6deb656757d6637e5688c1a987a76830badf6786464a2971` |

The seven-day lead time is a database and service contract. Do not change the
clock, update lifecycle rows manually, disable triggers, or use `prisma db
push` to accelerate the rehearsal.

## Protected Secrets

Configure these only as secrets in the GitHub `staging` Environment:

- `VALUE_POLICY_STAGING_MAKER_EMAIL`
- `VALUE_POLICY_STAGING_MAKER_PASSWORD`
- `VALUE_POLICY_STAGING_MAKER_TOTP`
- `VALUE_POLICY_STAGING_CHECKER_EMAIL`
- `VALUE_POLICY_STAGING_CHECKER_PASSWORD`
- `VALUE_POLICY_STAGING_CHECKER_TOTP`

The two emails and 32-character Base32 TOTP factors must be different. Passwords
must be at least 16 characters. The workflow sends the actor payload only on
stdin through pinned-host-key SSH; values are never placed in argv or logs.

The staging-only server command rejects any environment except
`NODE_ENV=production`, `MONEXUS_DEPLOY_ENV=staging`, and database name
`monexus_staging`. It creates or rotates only the two explicitly supplied
actors, revokes their old sessions, and uses the real password → MFA → admin
HTTP routes for governance.

## Workflow Operations

Run **ValuePolicy Staging Governance** from GitHub Actions.

| Operation | Exact confirmation | Effect |
| --- | --- | --- |
| `schedule` | `SCHEDULE_100PTS_CNY_STAGING` | create → independent approve → schedule; mode remains off |
| `activate_shadow` | `ACTIVATE_100PTS_CNY_STAGING_SHADOW` | after effective time, activate then atomically switch staging to shadow |
| `enable_enforce` | `ENABLE_100PTS_CNY_STAGING_ENFORCE` | after a successful shadow observation window, switch staging to enforce |
| `rollback_off` | `ROLLBACK_VALUE_POLICY_STAGING_OFF` | switch staging back to off |

Mode changes edit only `/etc/monexus/staging.env`, run the strict staging
preflight, recreate affected services, and run smoke checks. A failed change or
failed public policy verification forces the mode back to `off`.

## Evidence

Archive each run URL and the safe output containing only actor user IDs, policy
ID/version/status, lifecycle actor IDs, and effective time. Never archive
passwords, TOTP factors, access tokens, cookies, the private staging env file,
or SSH material.

After `schedule`, public `/api/value-policy/current` must remain 404
`VALUE_POLICY_DISABLED`. After `activate_shadow` or `enable_enforce`, it must
return the frozen policy ID, `1 / 1` ratio, and exact approved disclosure.
