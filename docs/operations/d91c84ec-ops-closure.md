# PLAN_ID d91c84ec — 运维收口、部署前检查与回滚

Status: **docs only**. This PR does **not** deploy, does **not** switch
`HUMAN_VERIFICATION_PROVIDER`, does **not** edit OpenResty, and does **not**
change production environment variables on the host.

Canary evidence: `docs/operations/d91c84ec-canary-evidence.md`. Every live
check there is `PENDING`. Do not fill PASS/FAIL until the owner authorizes a
production window and the command actually ran.

Related: `docs/operations/vps-1panel-openresty-deployment.md`,
`docs/operations/compose-production-deploy.md`,
`docs/operations/rollback-runbook.md`,
`docs/operations/runbook.md` §40,
`docs/operations/vmqfox-runbook.md`,
`docs/operations/payment-alerts.md`.

Plan: `docs/specs/vmqfox-native-checkout-trusted-proxy-registration-v1.plan.md`
PLAN_ID `d91c84ec` PR-5 / §11.

## 1. Merged code (not a production SHA)

`origin/develop@d8ca6b0` contains the function PRs. Production still runs the
previously deployed image until a later, separately authorized release.

| PR | GitHub | Merge commit |
| --- | --- | --- |
| PR-0 ancestry | #182 | `0cb8614f32d7537bed889617206984cc3ed87dc7` |
| PR-1 trusted proxy / session IP | #183 | `35dc1490299109f80e912e5db523658d3e9fa692` |
| PR-2 same-origin ALTCHA | #184 | `0a48ad40895051e4ae354b367fcc73ed5dd4045c` |
| PR-3 VMQFox native QR adapter | #185 | `a527e5bf9e4571647742098a8a0e6a35f7d3385f` |
| PR-4 branded QR UI | #186 | `d8ca6b0a2c57a7d27012c3a95dc1ef6ec16a075f` |

This document is PR-5. It does not rewrite payment credit, schema, VMQFox, or
OpenResty snippets already landed in PR-1.

## 2. Hard constraints for the first production window

1. Keep `HUMAN_VERIFICATION_PROVIDER=turnstile` and the Turnstile site / secret
   / hostname trio in the **private** VPS `.env` on the first backend image of
   this stack. Compose `HUMAN_VERIFICATION_PROVIDER:-altcha` is the *steady-state
   default after cutover*. Applying it without `ALTCHA_HMAC_KEY` fails boot.
   ALTCHA cutover is **not** part of the first window.
2. Do not edit OpenResty or reload it in the same unobserved step as the
   Express hop change. `nginx -t` first, then a dedicated OpenResty reload.
   **Before** the new backend image, only verify the OpenResty `$remote_addr` /
   overwrite-XFF contract (access-log remote addr versus a spoofed inbound
   `X-Forwarded-For`). Session IP class and rate-limit keys are Express
   hop-count behaviour: verify them **only after** the target backend SHA is
   the running `server` image.
3. `docker-compose.prod.yml` default `TRUST_PROXY:-1` is the **nginx**
   topology (`DEPLOY_TOPOLOGY=nginx`). The live 1Panel host must keep
   `DEPLOY_TOPOLOGY=cloudflare_openresty_nginx` and `TRUST_PROXY=2` in the
   private file. `TRUST_PROXY=true` is invalid and must never be restored.
4. Leave `API_RATE_LIMIT_MAX` at the current live value (production had been
   raised to `3000` as a 429 workaround) until the IP canary in the evidence
   sheet passes. Only then lower to `1500`.
5. Do not set `VMQFOX_MODE=disabled` as an emergency stop. Do not delete
   orders, reverse credited points, backfill session IPs, or edit VMQFox
   collection codes.
6. Proof, `publicToken`, `payUrl`, secrets, and raw client IPs must not enter
   URL query, ordinary logs, screenshots, tickets, or metrics labels.

## 3. Topology reminder (already in PR-1 docs)

| `DEPLOY_TOPOLOGY` | Path | `TRUST_PROXY` |
| --- | --- | --- |
| `nginx` | bundled Nginx → Express | `1` |
| `caddy` | Caddy → bundled Nginx → Express | `2` |
| `cloudflare_openresty_nginx` | Cloudflare → OpenResty → bundled Nginx → Express | `2` |

Cloudflare is not an Express hop. OpenResty must overwrite `X-Forwarded-For`
with `$remote_addr` after `real_ip` from Cloudflare CIDRs. Bundled Nginx then
appends one hop. Application code must not read `CF-Connecting-IP` itself.

## 4. Pre-deploy checklist (not executed in this PR)

Copy this list into the evidence sheet when a window is authorized. Do not
tick boxes here.

1. Record the currently running MoNexus image tag / container SHA, VMQFox
   `a528e92` (or the live unit SHA), and the GitHub release SHA that will be
   deployed. Write them only in the evidence sheet.
2. Copy VPS `.env` and the 1Panel OpenResty site file to a root-only backup
   path (`chmod 600`). Record the backup path, not the file contents.
3. Confirm GitHub Actions `CI OK` and Publish Docker images for that SHA
   (amd64 + arm64).
4. `nginx -t` on the OpenResty config that implements PR-1 `real_ip` /
   overwrite-XFF. Reload OpenResty only after that succeeds, and only if the
   owner authorized an OpenResty change. This PR does not perform that reload.
5. Confirm the private `.env` already has, and will keep for the first image:
   `DEPLOY_TOPOLOGY=cloudflare_openresty_nginx`, `TRUST_PROXY=2`,
   `API_RATE_LIMIT_MAX=3000`, `HUMAN_VERIFICATION_PROVIDER=turnstile`,
   Turnstile trio present, `ABUSE_PROTECTION_MODE=enforce`, Redis required.
   Do not add `ALTCHA_HMAC_KEY` or set `altcha` as a substitute for keeping
   Turnstile on this window. Do not paste `API_RATE_LIMIT_MAX=1500` until C7.
6. Confirm `WEB_PORT` stays loopback-only. No second path that bypasses
   OpenResty + bundled Nginx to Express.
7. `scripts/check-prod-env.sh` / `npm run prod:env` against the private file
   without printing it.
8. Database backup per `docs/operations/portable-backup-restore.md` before
   the image switch. This stack has no new Prisma migration; still take a
   backup.
9. Alert window: note current
   `monexus_rate_limited_total`, `recharge_paid_not_credited_total`,
   `payment_amount_mismatch_total`, and registration 503/403 rates. Labels
   never include raw IP.

Compose production deploy does **not** rewrite VPS `.env`. The operator must
pin Turnstile in that private file **before** the first image of this stack.
GitHub Actions is not authorization to switch ALTCHA.

## 5. Authorized production sequence (later; not this PR)

Execute only after the owner names a window. Stop at the end of phase A unless
a **second** authorization names phase B.

### Phase A — image + IP + native QR (Turnstile stays)

1. OpenResty `$remote_addr` / overwrite-XFF contract already live, or complete
   §4.4 first. This step does **not** prove session IP or rate-limit keys.
2. Deploy backend image while `HUMAN_VERIFICATION_PROVIDER=turnstile` and
   `API_RATE_LIMIT_MAX=3000`. Record the running `server` image SHA (evidence
   C0) before any session-IP row.
3. Deploy frontend that understands the challenge descriptor.
4. Prove `GET /api/auth/registration-status` still returns
   `challenge.provider=turnstile`.
5. After C0: IP canary (Cloudflare-normal, spoofed `X-Forwarded-For`,
   loopback). Record class distribution of five new logins; they must not
   share one private/CGNAT proxy hint. Classify only; do not retain full IP.
6. After C0: confirm 429s spread by source via
   `monexus_rate_limited_total{limiter,route_group}`.
7. After ≥24h of healthy public client IP class on that backend SHA, lower
   `API_RATE_LIMIT_MAX` from `3000` to `1500` as its own change (C7).
8. One minimum-amount WeChat QR and one Alipay QR. Credit is only
   `recordPaymentObservation → applyConfirmedPayment`. Buyer UI is 微信支付 /
   支付宝支付. Do not open `pay.snowvictor.com` in the browser.

### Phase B — ALTCHA cutover (separate authorization)

Follow `docs/operations/runbook.md` §40 step 3 / plan §6.5:

1. Write independent `ALTCHA_HMAC_KEY` (not `JWT_SECRET` / `ABUSE_HASH_KEY` /
   `MFA_ENCRYPTION_KEY`).
2. Switch `HUMAN_VERIFICATION_PROVIDER=altcha` and rebuild **server only**.
3. Confirm `registration-status` returns altcha and the browser Network tab
   does not request `challenges.cloudflare.com`.
4. One real new mailbox register + email verify from mainland network without
   VPN.

Do not run phase B in the same change as TRUST_PROXY, OpenResty, or the first
image. Missing `ALTCHA_HMAC_KEY` while Compose defaulting to `altcha` fails
boot.

## 6. Rollback

Use Compose SHA rollback in `docs/operations/compose-production-deploy.md` on
the current VPS. Do not mix the legacy `candidate`/`current` symlink model.

| Symptom | First action | Must not |
| --- | --- | --- |
| Shared 429 / all sessions private IP | Restore OpenResty + `.env` backups; roll the image. If the hop is correct and traffic is merely bursty, temporarily raise `API_RATE_LIMIT_MAX=3000`. | Restore `TRUST_PROXY=true`. Read `CF-Connecting-IP` in app code. |
| Registration / human-verification outage | Set `HUMAN_VERIFICATION_PROVIDER=turnstile` (trio still present) and rebuild server, then roll images if needed. Registration stays fail-closed. | `HUMAN_VERIFICATION_PROVIDER=off` or `ABUSE_PROTECTION_MODE=off`. |
| Native QR / VMQFox checkout | Remove `vmqfox` from `PAYMENT_ENABLED_PROVIDERS` **or** set `RECHARGE_ACCEPT_NEW_ORDERS=false`. Keep `vmqfox` registered and `VMQFOX_MODE=live` so webhooks ACK `success` and query-by-pay-id recovery continues. | `VMQFOX_MODE=disabled` as a live-stop. Delete orders. Reverse credited points. |

If a Prisma migration had applied (none in this stack), do not `migrate down`.
Prefer forward fix; restore only after staging rehearsal.

## 7. Metrics and alerts to watch

No new Prometheus rule ships in this PR. Watch existing series:

| Series / rule | Why |
| --- | --- |
| `monexus_rate_limited_total{limiter,route_group}` | 429 by limiter; labels never include raw IP |
| New session IP class (public vs private/CGNAT/ULA) | PR-1 canary; do not log full IP |
| `recharge_paid_not_credited_total{provider="vmqfox"}` | P0 `payment-paid-not-credited` |
| `payment_amount_mismatch_total{provider="vmqfox"}` | P0 `payment-amount-mismatch` |
| `payment_webhook_signature_failure_total{provider="vmqfox"}` | P1 surge rule |
| `payment_monitor_offline_total{provider="vmqfox"}` | P1 `payment-monitor-offline` |
| `payment_callback_retry_total` / `payment_webhook_ack_failure_total` | ACK retries |
| `payment_query_by_pay_id_recovery_total{provider="vmqfox",result}` | create-timeout recovery |
| Registration `403` / `503` without account rows | fail-closed verification |

A merge is not evidence that Alertmanager receivers fire.

## 8. What this PR ran

Local static checks only. No production SSH, no OpenResty reload, no env
rewrite, no live payment, no registration smoke.

Record exit codes in the evidence sheet under “docs PR static checks”.
