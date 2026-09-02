# PLAN_ID d91c84ec — canary evidence (PENDING)

Prepared: 2026-09-02. Branch:
`execute-plan/d91c84ec-pr-5-ops-canary`. Base: `origin/develop@d8ca6b0`.

This is an evidence **template**. It does **not** enable live, deploy, switch
ALTCHA, reload OpenResty, or mutate production `.env`.

**Rule:** every live row stays `PENDING` until the owner authorizes a window
and the operator pastes the real command, UTC time, and exit code. Do not
write PASS, green, or a SHA you did not observe. Empty fields are honest.

Companion: `docs/operations/d91c84ec-ops-closure.md`.

## Window record

| Field | Value |
| --- | --- |
| Owner / stop authority | _pending_ |
| Production window authorized? | **no** (this PR is review-only) |
| Phase A authorized? (image + IP + QR, Turnstile stays) | **no** |
| Phase B authorized? (ALTCHA cutover) | **no** |
| Operator | _pending_ |
| Window start (UTC) | _pending_ |
| Window end (UTC) | _pending_ |

## A. Docs PR static checks (this PR only)

These are the only rows that may be filled when this PR is created.

| Check | Command | Result | UTC |
| --- | --- | --- | --- |
| Base is `origin/develop@d8ca6b0` | `git merge-base --is-ancestor d8ca6b0a2c57a7d27012c3a95dc1ef6ec16a075f HEAD` | pass (ancestor before this PR commit) | 2026-09-02T11:29:29Z |
| `git diff --check` | `git diff --check origin/develop` | pass (exit 0) | 2026-09-02T11:29:29Z |
| Evidence sheet contains no fabricated live PASS | visual review of sections B–H | pass (all live rows still `PENDING`) | 2026-09-02T11:29:29Z |

No Playwright, no live VMQFox ¥1/¥10, no mainland registration, no OpenResty
reload, no `HUMAN_VERIFICATION_PROVIDER` write.

## B. Pre-deploy (Phase A — PENDING)

Fill only after production-window authorization.

| # | Check | Backup path / SHA / output | Result |
| --- | --- | --- | --- |
| B1 | Current MoNexus image tag / container SHA | _pending_ | PENDING |
| B2 | Current VMQFox unit SHA (expected prod baseline `a528e92…` unless recorded otherwise) | _pending_ | PENDING |
| B3 | Target deploy SHA (40 hex, `origin/master` after release) | _pending_ | PENDING |
| B4 | VPS `.env` backup (`chmod 600`); path only, never contents | _pending_ | PENDING |
| B5 | OpenResty site-file backup (`chmod 600`); path only | _pending_ | PENDING |
| B6 | PostgreSQL backup per portable-backup-restore | _pending_ | PENDING |
| B7 | Publish Docker images amd64+arm64 for target SHA | _pending_ | PENDING |
| B8 | Private `.env` still `HUMAN_VERIFICATION_PROVIDER=turnstile` + Turnstile trio; `DEPLOY_TOPOLOGY=cloudflare_openresty_nginx`; `TRUST_PROXY=2` | _pending_ (do not paste secrets) | PENDING |
| B9 | `npm run prod:env` / `scripts/check-prod-env.sh` without printing the file | _pending_ | PENDING |
| B10 | `nginx -t` on the OpenResty config | _pending_ | PENDING |

## C. OpenResty / client IP (Phase A — PENDING)

Do not claim these from logs collected before this window.

| # | Check | How | Result |
| --- | --- | --- | --- |
| C1 | OpenResty reload (only if owner authorized a config change) | `nginx -t` then reload; record UTC | PENDING |
| C2 | Cloudflare-normal request: session IP class is `public`, not `192.168.208.1` | classify only; do not paste full IP | PENDING |
| C3 | Spoofed `X-Forwarded-For: 1.2.3.4` (or similar) does **not** become the session IP | header ignored / overwritten | PENDING |
| C4 | Loopback / host-local request is not treated as a public client | class `loopback` or `private` | PENDING |
| C5 | Five new logins after hop fix are not all the same private/CGNAT address | count of distinct public class | PENDING |
| C6 | `monexus_rate_limited_total` has no raw-IP label | scrape / metrics text | PENDING |

Do not lower `API_RATE_LIMIT_MAX` until C2–C6 pass and a quiet window is
recorded.

| # | Check | Before | After | Result |
| --- | --- | --- | --- | --- |
| C7 | `API_RATE_LIMIT_MAX` 3000 → 1500 (own change, ≥24h after C2–C6) | _pending_ | _pending_ | PENDING |

## D. Registration while Turnstile stays (Phase A — PENDING)

Mainland completion of Turnstile is **not** a Phase A success criterion.

| # | Check | Result |
| --- | --- | --- |
| D1 | After backend image: `GET /api/auth/registration-status` → `challenge.provider=turnstile` | PENDING |
| D2 | After frontend image: same descriptor; old `turnstileToken` still accepted | PENDING |
| D3 | Invalid token → `403`, zero account / reward / mail rows | PENDING |
| D4 | Browser Network still allowed to load Turnstile (expected until Phase B) | PENDING |

## E. Native QR smoke (Phase A — PENDING)

Credit only via observation → `applyConfirmedPayment`. Quote ¥10.00 / paid
¥10.01 still credits 1000 PTS. Do not treat a screenshot of a QR as payment
evidence.

| # | Check | Amount | MoNexus order status | Result |
| --- | --- | --- | --- | --- |
| E1 | WeChat: local QR, `wxp:` content, label 微信支付, no `pay.snowvictor.com` | min allowed | _pending_ | PENDING |
| E2 | Alipay: local QR, `https://qr.alipay.com`, label 支付宝支付, official circular mark | min allowed | _pending_ | PENDING |
| E3 | Duplicate webhook still ACKs exact text `success`; single credit | — | _pending_ | PENDING |
| E4 | Create timeout recovery uses original `payId` (no second payId) if exercised | — | _pending_ | PENDING |

If the channel refuses a min-amount live charge, write `BLOCKED` with the
provider reason. Do not mark PASS.

## F. ALTCHA cutover (Phase B — PENDING, separate auth)

Do not fill this section during Phase A.

| # | Check | Result |
| --- | --- | --- |
| F0 | Separate written authorization for Phase B | PENDING |
| F1 | Independent `ALTCHA_HMAC_KEY` written (not reused secrets) | PENDING |
| F2 | `HUMAN_VERIFICATION_PROVIDER=altcha`; **server only** rebuilt | PENDING |
| F3 | `registration-status.challenge.provider=altcha` | PENDING |
| F4 | Browser Network: **zero** requests to `challenges.cloudflare.com` | PENDING |
| F5 | Mainland / no-VPN: one real new mailbox register + email verify | PENDING |
| F6 | Chrome 4× CPU throttle and one low-end Android: 10 solves, p95 < 3s, 20s hard timeout | PENDING |

## G. Alert window (PENDING)

| Rule / series | Window | Fires? | Result |
| --- | --- | --- | --- |
| `payment-paid-not-credited` | _pending_ | _pending_ | PENDING |
| `payment-amount-mismatch` | _pending_ | _pending_ | PENDING |
| `payment-webhook-signature-failure-surge` | _pending_ | _pending_ | PENDING |
| `payment-monitor-offline` | _pending_ | _pending_ | PENDING |
| `monexus_rate_limited_total` trend after C7 | _pending_ | _pending_ | PENDING |

A silent window is not proof that receivers are wired.

## H. Rollback drill (PENDING, optional)

Do not run against production unless the owner asks for a drill.

| # | Check | Result |
| --- | --- | --- |
| H1 | IP/429: restore OpenResty + `.env` backups; never `TRUST_PROXY=true` | PENDING |
| H2 | Registration: `HUMAN_VERIFICATION_PROVIDER=turnstile` first, then images | PENDING |
| H3 | QR: remove `vmqfox` from enabled **or** `RECHARGE_ACCEPT_NEW_ORDERS=false`; keep registered + `VMQFOX_MODE=live` | PENDING |

## Honest gaps (do not close by assertion)

- This file was created without production SSH.
- Phase A mainland registration is expected to remain Turnstile-bound.
- VMQFox min-amount smokes need a live channel and owner funds; they are not
  implied by unit tests.
- Alertmanager receiver deploy is out of scope.
- OpenResty CIDR list must be taken from https://www.cloudflare.com/ips/ at
  change time; do not freeze stale CIDRs in application code.
