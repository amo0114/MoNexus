# Sentry Alert Rules

Review date: 2026-05-14. Scope: M5 alert rule definitions for the M4 Sentry, web-vitals, and metrics foundation. This document defines rule settings and validation steps only; it does not change application code and does not store Sentry credentials.

## Sources and Current Telemetry

- Backend exceptions are sent through `SENTRY_DSN` from `server/src/lib/errorReporter.ts`; request id, method, path, and user id are attached where available.
- Frontend errors are sent through `VITE_SENTRY_DSN` from `src/main.tsx` and `src/lib/errorReporter.ts`.
- Frontend web vitals are production-only and emit Sentry breadcrumbs, measurements, and low-cardinality tags such as `webvital.lcp.rating`, `webvital.inp.rating`, and `webvital.cls.rating`.
- API latency is already measured by M4 Prometheus metrics (`monexus_http_request_duration_seconds`). The Sentry API P95 alert below requires backend transaction/performance events in Sentry. Until that telemetry is enabled, keep the Sentry rule in dry-run documentation and use the Prometheus query from the runbook as the operational fallback.

Reference docs:

- Sentry alerts can notify through chat, email, on-call tools, issue trackers, and webhooks when rules match configured triggers/filters. Source: [Sentry Alerts](https://docs.sentry.io/product/monitors-and-alerts/alerts/).
- Sentry metric alert rules monitor metrics such as error count, latency, and failure rate. Source: [Create a Metric Alert Rule](https://docs.sentry.io/api/alerts/create-a-metric-alert-rule-for-an-organization/).
- Sentry frontend dashboards expose web vital views. Source: [Sentry Frontend Dashboards](https://docs.sentry.io/product/insights/frontend/web-vitals/).
- Core Web Vitals thresholds: LCP good <= 2.5s, INP good <= 200ms, CLS good <= 0.1; evaluate the 75th percentile for most users. Source: [web.dev Web Vitals](https://web.dev/articles/vitals).

## Rule Summary

| Rule name | Project | Severity | Threshold | Window | Owner | Routing label |
| --- | --- | --- | --- | --- | --- | --- |
| `MoNexus Backend error spike` | Backend Sentry project | P1 | Error event count >= 10, critical at >= 25 | 5 minutes | Backend on-call | `backend-error-p1` |
| `MoNexus API P95 latency` | Backend Sentry project | P2, escalate to P1 at critical | `p95(transaction.duration)` > 2000ms, critical > 5000ms | 10 minutes | Backend on-call | `api-latency-p2` |
| `MoNexus Frontend LCP poor` | Frontend Sentry project | P2 | `p75(LCP)` > 4000ms, or poor rating count >= 20 if only tags are available | 15 minutes | Frontend on-call | `frontend-vitals-p2` |
| `MoNexus Frontend INP poor` | Frontend Sentry project | P2 | `p75(INP)` > 500ms, or poor rating count >= 20 if only tags are available | 15 minutes | Frontend on-call | `frontend-vitals-p2` |
| `MoNexus Frontend CLS poor` | Frontend Sentry project | P2 | `p75(CLS)` > 0.25, or poor rating count >= 20 if only tags are available | 15 minutes | Frontend on-call | `frontend-vitals-p2` |
| `MoNexus Release regression after deploy` | Backend and frontend Sentry projects | P1 | New issue count >= 5 for the current release | 30 minutes after deploy | Release manager | `release-regression-p1` |

Severity policy:

- P1: page/on-call route after A4 wires routing. These affect backend correctness, availability, or a release.
- P2: notify the owning team channel. These affect performance or user experience but usually do not require a page unless they persist or combine with P1 symptoms.

## Rule Details

### MoNexus Backend error spike

- Type: Sentry metric alert.
- Dataset: backend error events.
- Environment: `production` first; duplicate as `staging` with the same threshold for smoke testing.
- Query/filter: backend project, environment `production`, event type error, exclude known low-priority validation/user errors if Sentry groups them separately.
- Aggregate: `count()`.
- Threshold: warning when count is >= 10 in 5 minutes; critical when count is >= 25 in 5 minutes.
- Owner: Backend on-call.
- Routing label: `backend-error-p1`.
- Validation:
  1. Confirm `SENTRY_DSN` is set for staging and events appear in the backend project.
  2. Trigger or replay at least one known staging backend exception and confirm it lands with `environment=staging`.
  3. Temporarily clone the rule in staging with threshold `>= 1 in 5 minutes`.
  4. Confirm the alert fires and includes the route label for A4.
  5. Reset staging threshold to match production.

### MoNexus API P95 latency

- Type: Sentry metric alert.
- Dataset: backend transaction/performance events.
- Environment: `production`.
- Query/filter: backend project, environment `production`, transaction name or route prefix matching `/api/*`.
- Aggregate: `p95(transaction.duration)`.
- Threshold: warning when P95 is > 2000ms for 10 minutes; critical when P95 is > 5000ms for 10 minutes.
- Owner: Backend on-call.
- Routing label: `api-latency-p2`.
- Validation:
  1. Confirm backend transaction events are present in Sentry. If not, use the M4 Prometheus P95 query until backend Sentry performance telemetry is added.
  2. In staging, create the same alert with a temporary threshold below current observed P95.
  3. Generate traffic against `/api/health/ready` and one authenticated API route.
  4. Confirm the staging alert transitions to triggered, then restore the normal threshold.
  5. Compare Sentry P95 with the runbook Prometheus query for the same window.

### MoNexus Frontend LCP poor

- Type: Sentry metric alert.
- Dataset: frontend transaction/performance events with web-vitals measurements.
- Environment: `production`.
- Query/filter: frontend project, environment `production`; prefer measurement `LCP`. If the Sentry UI normalizes measurement names, use the displayed LCP field. If measurement aggregation is unavailable, filter by tag `webvital.lcp.rating:poor`.
- Aggregate: `p75(LCP)`.
- Threshold: warning when p75 LCP is > 4000ms for 15 minutes; fallback tag threshold is >= 20 poor-rated LCP events in 15 minutes.
- Owner: Frontend on-call.
- Routing label: `frontend-vitals-p2`.
- Validation:
  1. Build staging with `VITE_SENTRY_DSN` set.
  2. Open the staging frontend in a production build and confirm a web-vitals breadcrumb and tag appear in Sentry.
  3. Create a staging copy with a temporary low threshold against current LCP.
  4. Confirm the alert fires and routes to the frontend-vitals label.
  5. Restore the production threshold.

### MoNexus Frontend INP poor

- Type: Sentry metric alert.
- Dataset: frontend transaction/performance events with web-vitals measurements.
- Environment: `production`.
- Query/filter: frontend project, environment `production`; prefer measurement `INP`. If the Sentry UI normalizes measurement names, use the displayed INP field. If measurement aggregation is unavailable, filter by tag `webvital.inp.rating:poor`.
- Aggregate: `p75(INP)`.
- Threshold: warning when p75 INP is > 500ms for 15 minutes; fallback tag threshold is >= 20 poor-rated INP events in 15 minutes.
- Owner: Frontend on-call.
- Routing label: `frontend-vitals-p2`.
- Validation:
  1. Confirm `webvital.inp.rating` tags exist on staging frontend events.
  2. Use a staging rule with a temporary low threshold or a tag count threshold of `>= 1`.
  3. Interact with product listing, product details, and exchange modal in the production build.
  4. Confirm the alert fires and includes the frontend-vitals route label.
  5. Restore the production threshold.

### MoNexus Frontend CLS poor

- Type: Sentry metric alert.
- Dataset: frontend transaction/performance events with web-vitals measurements.
- Environment: `production`.
- Query/filter: frontend project, environment `production`; prefer measurement `CLS`. If the Sentry UI normalizes measurement names, use the displayed CLS field. If measurement aggregation is unavailable, filter by tag `webvital.cls.rating:poor`.
- Aggregate: `p75(CLS)`.
- Threshold: warning when p75 CLS is > 0.25 for 15 minutes; fallback tag threshold is >= 20 poor-rated CLS events in 15 minutes.
- Owner: Frontend on-call.
- Routing label: `frontend-vitals-p2`.
- Validation:
  1. Confirm `webvital.cls.rating` tags exist on staging frontend events.
  2. Use a staging rule with a temporary low threshold or a tag count threshold of `>= 1`.
  3. Load homepage, catalog, product detail, auth pages, and admin shell in the production build.
  4. Confirm the alert fires and includes the frontend-vitals route label.
  5. Restore the production threshold.

### MoNexus Release regression after deploy

- Type: Sentry alert rule or metric alert, depending on project support.
- Dataset: backend and frontend issues for the current release.
- Environment: `production`.
- Query/filter: current release from the deploy workflow build metadata, new issues only, environment `production`.
- Threshold: >= 5 new issues within 30 minutes after deploy.
- Owner: Release manager.
- Routing label: `release-regression-p1`.
- Validation:
  1. Confirm deploy workflow sets or records a release identifier that Sentry can filter.
  2. In staging, create a release-specific clone for the current commit.
  3. Send one backend and one frontend smoke event to staging.
  4. Temporarily set the threshold to `>= 1` and confirm alert routing.
  5. Restore threshold and disable the staging clone after the rehearsal.

## Manual Sentry Setup Checklist

For each rule:

1. Open Sentry -> Alerts -> Create Alert.
2. Select the project and environment listed in the rule table.
3. Enter the rule name exactly as documented.
4. Configure threshold and window exactly as documented.
5. Add the routing label to the action description or integration payload so A4 can map it to Slack/email/PagerDuty.
6. Set the owner field or note to the documented owner.
7. Save the rule disabled in staging first, run validation, then enable production.

## Dry-run Helper Workflow

`.github/workflows/sentry-alert-check.yml` is intentionally read-only. It validates that the documented rule names still exist in this file and, when `SENTRY_AUTH_TOKEN` plus `SENTRY_ORG` are configured in the selected GitHub environment, performs a read-only Sentry API connectivity check. It does not create, update, or delete alert rules.

Required environment values for the optional API check:

- Secret: `SENTRY_AUTH_TOKEN`
- Variable: `SENTRY_ORG`
- Variable: `SENTRY_PROJECT_BACKEND`
- Variable: `SENTRY_PROJECT_FRONTEND`

## Handoff Notes

- A4 should route `backend-error-p1` and `release-regression-p1` to the urgent path, and `api-latency-p2` / `frontend-vitals-p2` to the team notification path.
- A5 should pass the release identifier to Sentry or preserve a deploy marker so the release regression rule can filter by deploy.
- A8 should link this file from the M5 runbook rather than duplicating thresholds.
