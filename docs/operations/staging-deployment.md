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

Use a current Debian/Ubuntu VPS with at least 2 vCPU, 4 GB RAM, 40 GB SSD,
Docker Engine with Compose v2, Caddy, Node 20, and inbound TCP 80/443. The
staging host must be a different server from the production site.

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
sudo install -d -o monexus-deploy -g monexus-deploy -m 0750 /opt/monexus-staging/releases
sudo install -d -o monexus-deploy -g monexus-deploy -m 0700 /etc/monexus
sudo install -o monexus-deploy -g monexus-deploy -m 0600 /dev/null /etc/monexus/staging.env
```

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
