# Alert Routing

Review date: 2026-08-18. Scope: alert routing from Sentry and ValuePolicy alert labels and manual GitHub Actions tests to the first responder path. Slack is the default route, email is the fallback route, and PagerDuty is documented only as an optional production P0/P1 path.

## Routing Matrix

| Routing label | Source rule | Severity | Primary route | Fallback route | Owner | PagerDuty |
| --- | --- | --- | --- | --- | --- | --- |
| `backend-error-p1` | `MoNexus Backend error spike` | P1 urgent | Slack incident channel via `ALERT_SLACK_WEBHOOK_URL` | Email to `ALERT_EMAIL_TO` from `ALERT_EMAIL_FROM` | Backend on-call | Optional in production when `PAGERDUTY_ROUTING_KEY` is configured |
| `release-regression-p1` | `MoNexus Release regression after deploy` | P1 urgent | Slack incident channel via `ALERT_SLACK_WEBHOOK_URL` | Email to `ALERT_EMAIL_TO` from `ALERT_EMAIL_FROM` | Release manager | Optional in production when `PAGERDUTY_ROUTING_KEY` is configured |
| `api-latency-p2` | `MoNexus API P95 latency` | P2 team notification | Slack team channel via `ALERT_SLACK_WEBHOOK_URL` | Email to `ALERT_EMAIL_TO` from `ALERT_EMAIL_FROM` | Backend on-call | No default page |
| `frontend-vitals-p2` | `MoNexus Frontend LCP/INP/CLS poor` | P2 team notification | Slack team channel via `ALERT_SLACK_WEBHOOK_URL` | Email to `ALERT_EMAIL_TO` from `ALERT_EMAIL_FROM` | Frontend on-call | No default page |
| `value-policy-p0` | `docs/operations/value-policy-alerts.md` | P0 urgent | Slack incident channel via `ALERT_SLACK_WEBHOOK_URL` | Email to `ALERT_EMAIL_TO` from `ALERT_EMAIL_FROM` | Backend on-call | Optional in production when `PAGERDUTY_ROUTING_KEY` is configured |
| `value-policy-p1` | `docs/operations/value-policy-alerts.md` | P1 urgent | Slack incident channel via `ALERT_SLACK_WEBHOOK_URL` | Email to `ALERT_EMAIL_TO` from `ALERT_EMAIL_FROM` | Backend on-call | Optional in production when `PAGERDUTY_ROUTING_KEY` is configured |

## Severity Policy

- P0 urgent: alert the incident channel immediately, assign an incident owner, and stop or roll back the affected rollout until the invariant is restored.
- P1 urgent: alert the incident channel immediately, assign an owner within 10 minutes, and escalate if the first responder is unavailable. Production PagerDuty can be added for P0/P1 only, but it is not required for M5.
- P2 team notification: notify the owning team channel during business hours or the next on-call review window. Escalate to P1 only if the symptom persists, combines with user-visible failures, or blocks a release.

## GitHub Environment Values

Configure these in GitHub Actions Environments for `staging` and `production`:

| Name | Type | Required | Purpose |
| --- | --- | --- | --- |
| `ALERT_SLACK_WEBHOOK_URL` | Environment secret | Recommended | Slack incoming webhook for the default alert path. |
| `ALERT_EMAIL_TO` | Environment variable | Fallback | Destination mailbox or list for email fallback. |
| `ALERT_EMAIL_FROM` | Environment variable | Fallback | Sender identity documented for fallback emails. |
| `PAGERDUTY_ROUTING_KEY` | Environment secret | Optional production only | Optional P0/P1 escalation path after an on-call policy exists. |

Do not paste webhook URLs, routing keys, mailbox passwords, or bearer tokens into the repository, PR comments, issue comments, or workflow logs.

## Test Notification Procedure

1. Open GitHub Actions -> **Alert Routing Test** -> **Run workflow**.
2. Select `staging` first. Keep `dry_run` enabled for the first pass.
3. Choose the routing label to rehearse. Use `value-policy-p0` and severity `P0` for the ValuePolicy production gate; use `frontend-vitals-p2` for team notification routing.
4. Confirm the dry run prints the planned route. Dry runs do not prove delivery.
5. Configure `ALERT_SLACK_WEBHOOK_URL` in the selected GitHub environment.
6. Re-run with `dry_run` disabled and confirm a Slack message arrives in the expected channel. A live rehearsal fails closed when the webhook is absent.
7. If Slack is not configured, confirm `ALERT_EMAIL_TO` and `ALERT_EMAIL_FROM` are present and send a manual email using the incident mailbox. The workflow records the fallback plan but does not store or use an SMTP password.
8. For production P1 routing only, configure `PAGERDUTY_ROUTING_KEY` after the PagerDuty service and escalation policy are approved. Rehearse that path outside the default workflow before enabling automatic paging.

## First Responder Checklist

1. Acknowledge the Slack or email notification and identify the routing label.
2. Open the matching Sentry rule from `docs/operations/sentry-alert-rules.md`.
3. Confirm environment, release, first-seen time, and whether the alert is P1 or P2.
4. For P1, post an incident thread with owner, current impact, next check-in time, and rollback candidate if this follows a deploy.
5. For P2, file or update the team tracking issue and watch the next alert window before escalating.
6. Check `/api/health/live`, `/api/health/ready`, `BUILD_INFO.json`, and the latest deploy workflow run when the alert is release-related.
7. If rollback is needed, hand off to the M5 rollback runbook and keep the routing thread updated until health checks recover.

## Handoff Notes

- A6 should reference this file for escalation and first responder ownership during rollback.
- A8 should link this routing matrix from the final M5 runbook rather than duplicating secret handling details.
- `.github/workflows/backup.yml` remains unchanged in A4; backup failure routing should be wired only when the coordinator assigns that workflow.
