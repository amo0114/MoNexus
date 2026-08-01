# Dedicated Staging Deployment

Review date: 2026-08-01. This is the deployment path for the registration-abuse
protection rehearsal. It is intentionally isolated from
`https://monexus.oai-o.com/`: no production database, Redis endpoint, SMTP
sender, object-storage bucket, secret, or Compose project may be reused.

```text
https://staging.monexus.oai-o.com
  -> dedicated staging VPS Caddy (:443)
  -> loopback-only web container (:18081)
  -> server + PostgreSQL + Redis + MinIO (monexus-staging Compose project)
  -> Mailpit SMTP catcher (loopback-only :18082)
```

## 1. Fixed safety boundary

- Host path is `/opt/monexus-staging`; the deployment workflow rejects any
  other path.
- The private runtime environment is `/etc/monexus/staging.env`, mode `0600`.
  It remains on the staging host; GitHub Actions receives only the SSH deploy
  key and pinned host key.
- `scripts/staging-compose.sh` refuses a Compose project other than
  `monexus-staging`, enables `selfhost-storage` and `staging-mail`, and applies
  the loopback-only VPS overlay.
- Mailpit must not be exposed through Caddy or a public firewall rule. Inspect
  it through an authenticated SSH tunnel.
- Do not restore a production database or object bucket for this rehearsal.
  Use synthetic accounts and staging-only files.

## 2. One-time host and DNS setup

Use a current Ubuntu VPS with at least 2 vCPU, 4 GB RAM, 40 GB SSD, and inbound
TCP 80/443. The staging host must be a different server from the production
site. The host does not need Node: the staging launcher performs its preflight
inside Docker's Node 20 image when Node is absent.

Create a DNS-only A record before Caddy obtains a certificate:

```text
Type: A
Name: staging
Target: <dedicated staging VPS public IPv4>
Proxy: DNS only until the certificate succeeds
```

Then append, rather than overwrite, the site block in
[`deploy/staging/Caddyfile`](../../deploy/staging/Caddyfile) to the host's
`/etc/caddy/Caddyfile` and validate it:

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Create a non-root deploy account which can run Docker, plus only the two
staging paths used by the workflow:

```bash
sudo adduser --disabled-password --gecos '' monexus-deploy
sudo usermod -aG docker monexus-deploy
sudo install -d -o monexus-deploy -g monexus-deploy -m 0750 /opt/monexus-staging
sudo install -d -o monexus-deploy -g monexus-deploy -m 0750 /opt/monexus-staging/releases
sudo install -d -o monexus-deploy -g monexus-deploy -m 0700 /etc/monexus
sudo install -o monexus-deploy -g monexus-deploy -m 0600 /dev/null /etc/monexus/staging.env
```

On a fresh Ubuntu host, prefer the reviewed root bootstrap in this repository
instead of manually mixing package sources. It installs Docker Engine + Compose
v2 and Caddy, adds `monexus-deploy` to the Docker group, creates only the
staging paths above, and appends a dedicated Caddy include without overwriting
other site blocks:

```bash
sudo STAGING_HOST=staging.monexus.oai-o.com \
  bash deploy/staging/bootstrap-host.sh
```

The host bootstrap does not create runtime secrets or application data. It
uses Caddy's official signed stable APT repository because the Ubuntu mirror
may not publish an ARM64 `caddy` package. It does not alter provider firewalls;
ensure the provider allows TCP 80 and 443. See the [official Caddy installation
instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

Add the GitHub Actions staging deploy public key to
`/home/monexus-deploy/.ssh/authorized_keys`, then capture the SSH host key in
known-hosts format. Do not send SSH passwords or private keys in chat.

## 3. Runtime configuration and external dependencies

Start from [`.env.staging.example`](../../.env.staging.example) and fill the
private host file. The normal preflight must pass without
`--allow-placeholders`:

```bash
cd /opt/monexus-staging/current
bash scripts/check-prod-env.sh --mode staging --env-file /etc/monexus/staging.env
```

Required staging-specific choices:

| Dependency | Required staging value |
| --- | --- |
| Redis | Bundled `redis`, password protected, `REDIS_ENABLED=true`, `REDIS_REQUIRED=true`, `CACHE_KEY_PREFIX=monexus:staging` |
| Turnstile | Separate real widget with only `staging.monexus.oai-o.com` allowed; use its staging site and secret keys |
| SMTP | `SMTP_HOST=mailpit`, port `1025`, no credentials; never a production sender |
| Storage | Bundled MinIO and two names beginning `monexus-staging-` |
| Protection keys | New, independent staging `ABUSE_HASH_KEY`, JWT/MFA, metrics, Redis, and webhook keys |

For Mailpit inspection, tunnel rather than opening a public port:

```bash
ssh -L 18082:127.0.0.1:18082 monexus-deploy@<staging-host>
```

Open `http://127.0.0.1:18082` locally only after the tunnel is established.

## 4. GitHub Environment values

The repository's empty `staging` GitHub Environment is dedicated to this
workflow. Add the following there; do not add them at repository scope or to
`production`:

| Name | Type | Purpose |
| --- | --- | --- |
| `STAGING_SSH_HOST` | secret | Dedicated staging host IP or hostname |
| `STAGING_SSH_USER` | secret | `monexus-deploy` |
| `STAGING_SSH_PRIVATE_KEY` | secret | GitHub Actions deploy key only |
| `STAGING_SSH_PORT` | secret | SSH port, normally `22` |
| `STAGING_SSH_KNOWN_HOSTS` | secret | Pinned known-hosts line captured at bootstrap |
| `STAGING_HEALTHCHECK_URL` | variable | `https://staging.monexus.oai-o.com/api/health/ready` |

The workflow deliberately does not receive the Turnstile, SMTP, database,
Redis, application, or storage secrets. Those values stay in the host's
private environment file.

## 5. Deploy and rollback

After completing the above setup, run **Staging Compose Deploy** from GitHub
Actions. First use `dry_run=true`; it packages an immutable source archive but
does not open SSH. Then deploy a known-good base commit, followed by the RAP
feature commit or branch with `dry_run=false`.

The workflow builds the selected source on the staging host, runs the strict
environment preflight, starts the isolated Compose project, runs loopback
health/metrics smoke, and finally checks the public readiness URL. It writes
releases under `/opt/monexus-staging/releases/<full-sha>` and only changes the
`current` symlink after a successful local smoke.

For the rollback drill select `release_action=rollback` and supply a previous
full staging release SHA. This is an application rollback only: do not delete
the Prisma migration, `GrowthReward`, `AbuseEvent`, or ledger data. Use
`registrationEnabled` and `emailVerificationRequiredForValue` as the supported
operational switches.

## 6. RAP staging evidence (T01/T52)

Record redacted results—not credentials, raw mail fragments, full emails, IPs,
or Turnstile response bodies—for all of the following before claiming T52:

1. `registration-status`, loopback readiness, public readiness, metrics, and
   Redis health are green with `ABUSE_PROTECTION_MODE=enforce`.
2. A real browser on `staging.monexus.oai-o.com` completes the staging
   Turnstile widget and creates a synthetic account; Mailpit receives the
   fragment-token verification mail.
3. An invalid challenge is rejected without a created account/reward; stopping
   Redis in the staging Compose project returns the controlled failure and no
   registration/mail side effect. Restart Redis and repeat readiness.
4. Verification-mail throttling, generic password-reset response,
   unverified-value block, verified-value success, invite cap, delayed reward
   hold/release, and MFA admin void all match the specification.
5. Run the workflow rollback drill to the earlier staging release, record
   readiness before/after, and confirm no migration or ledger deletion was
   attempted.

Keep `emailVerificationRequiredForValue=0` in production until staging passes,
the production protection layer has been observed for at least 24 hours, and
the user-notification window is complete.

### Evidence log: 2026-08-01

The dedicated staging release `54066fbb7063` has the following redacted
evidence. These results complete the isolated staging rehearsal; they are not
a production approval.

- Public and loopback `/api/health/ready` returned `200`; the strict staging
  preflight passed with the isolated Redis, SMTP catcher, storage, and abuse
  configuration.
- Redis rejects unauthenticated requests and passes its authenticated health
  probe. With Redis stopped, registration returned controlled
  `503 ABUSE_PROTECTION_UNAVAILABLE` and did not create an account, reward,
  verification token, or Mailpit message. Readiness recovered after Redis was
  restarted.
- The real Turnstile script and managed challenge iframe loaded for the
  staging hostname. An invalid token returned
  `403 HUMAN_VERIFICATION_FAILED` with no account, reward, verification-token,
  or mail side effect. A headless browser must not be used to bypass the
  managed CAPTCHA.
- For a unique synthetic unknown mailbox, `POST /api/auth/forgot-password`
  returned `200` with only the generic `message` field; Mailpit stayed at
  `0 -> 0` messages. No raw email address, token, or email content was saved
  in this document.
- A real browser completed a synthetic registration, managed Turnstile, login,
  verification-email delivery through Mailpit, and authenticated fragment
  verification. Aggregate-only database checks confirmed a consumed token,
  no active verification token, a verified user, and a held registration
  reward.
- A dedicated public preflight rate rehearsal for requests without a CAPTCHA
  returned 20 controlled `400` responses followed by one `429 RATE_LIMITED`;
  public readiness remained `200`.
- Isolated synthetic fixtures exercised real login, MFA enrollment, admin
  configuration, mail, verification, value-gate, reward, and admin-abuse
  APIs. The unverified checkin was denied with zero point writes; the verified
  checkin succeeded. The verification mail's immediate resend was throttled
  without a second message. A verified reward moved held -> granted through
  the normal cron. Referral quota produced one qualified/held relation and one
  quota-exhausted/voided relation. An MFA administrator voided a held reward
  and created both required audit records.
- A source release for `8b44217d2669` passed staging build, strict preflight,
  loopback smoke, and public readiness. The application was then rolled back
  to `54066fbb7063` using the supported release switch and passed smoke and
  public readiness again. The RAP Prisma migration, GrowthReward rows, and
  PointLog rows remained present throughout; no schema or ledger deletion was
  attempted. The temporary bootstrap SSH key was revoked afterwards while the
  permanent GitHub Actions deploy key remained authorized.

The staging value gate remains enabled (`1`); the temporary hold and referral
quota settings were restored to `7`, `3`, and `20`. A staging workflow file
that has not reached the repository default branch cannot be manually
dispatched by GitHub Actions, so the release rehearsal used the same checked-in
archive, host-validation, build, smoke, and symlink-switch procedure directly
on the dedicated staging host.

### Production-readiness audit: 2026-08-01

An authorised, read-only audit of the production mail host was
performed without reading environment-file values, mail bodies, recipients,
tokens, or credentials, and without sending a message.

- Mailu SMTP, front, IMAP, admin, resolver, antispam, and related mail
  services were running. The production application was healthy and its SMTP
  configuration was present. From the application container, the configured
  SMTP target was reachable; its configured STARTTLS transport presented a
  hostname-valid certificate with more than 30 days remaining. A single
  Nodemailer authentication `verify()` also succeeded without sending mail or
  exposing credentials.
- The Mailu queue was empty at the time of inspection. Public DNS checks found
  MX, SPF, DMARC, and a DKIM record for the configured, domain-aligned sender.
  Postfix's Rspamd milter and the Rspamd DKIM signing configuration were also
  present. This establishes delivery-path readiness, but does not replace a
  post-deploy authenticated admin mail-panel test to a controlled mailbox.
- ClamAV's service endpoint responded, but its container health check is
  currently `unhealthy` because it expects legacy PID files that are absent.
  Treat this as an operational remediation item; do not silently waive the
  health check before the release window.
- Production Redis requires authentication and responds to authenticated
  probes, but it is a single primary with zero connected replicas. On
  2026-08-01 the release owner selected this single-node local-Compose
  topology: no Redis HA, Sentinel, or replica is planned for this release.
  The release must instead verify authenticated private-network access, AOF
  persistence, and the documented fail-closed behavior for registration and
  user-email sends during a Redis or host outage.
- The running production application predates RAP and has not loaded the
  production `ABUSE_*` or Turnstile settings. This audit made no production
  changes.

Release, on-call, and rollback owner: the repository operator (the same named
human for all three roles), confirmed on 2026-08-01. A support owner, release
window, and alert contact route must still be recorded before a production
deploy.

Still required: production single-node Redis final validation (authentication,
AOF, health check, and no public port), the post-deploy authenticated Mail
Panel delivery test and daily quota confirmation, ClamAV health-check
remediation, the support owner, production alert/contact route and release
window, and the 24-hour
production protection observation before the production value gate is enabled.
Do not set a production release gate from this staging evidence.
