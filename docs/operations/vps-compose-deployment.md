# Single-domain VPS Docker deployment

This is the recommended deployment path when an operator has a public Linux
VPS. It uses the repository's existing Docker images and Compose stack; no
GitHub Pages, Render, Neon, R2, API subdomain, or Cloudflare Tunnel is needed.

For a VPS whose public web server is managed by **1Panel OpenResty**, follow
[the dedicated 1Panel deployment runbook](./vps-1panel-openresty-deployment.md).
Do not add Caddy to that host: OpenResty already owns ports 80 and 443.

```text
https://monexus.oai-o.com
  -> Cloudflare DNS / proxy
  -> host Caddy (:443 on VPS)
  -> web (Nginx + React)
     -> /api      -> server (Express + Prisma)
     -> /uploads  -> MinIO (private Compose network)
  -> Postgres + Redis + MinIO persistent volumes
```

## 1. Prepare the VPS

Use a current Debian or Ubuntu host with at least 2 vCPU, 4 GB RAM, and 40 GB
of SSD. Both x86_64 and ARM64 VPSes are supported: the GHCR release images are
published as a multi-platform manifest. Install Docker Engine and Docker
Compose v2.24.4 or later, plus Caddy on the **host**. The VPS must allow
inbound TCP 80 and 443; do not expose PostgreSQL, Redis, MinIO, or the
application web container directly.

Clone the repository into a durable path such as `/opt/monexus`.

## 2. Create the DNS record

In Cloudflare, add only this record; it does not touch the existing apex,
`app`, or `api` records:

```text
Type: A
Name: monexus
Target: <VPS public IPv4>
Proxy: DNS only (initially)
```

Keep it DNS-only until Caddy acquires its Let's Encrypt certificate. Afterwards
enable Cloudflare proxying and set Cloudflare SSL/TLS mode to **Full (strict)**.
Never use Flexible mode.

## 3. Configure production environment

Copy the existing template and edit it only on the VPS:

```bash
cd /opt/monexus
cp .env.example .env
chmod 600 .env
```

At minimum replace all placeholders and set these values:

```dotenv
FRONTEND_ORIGIN=https://monexus.oai-o.com
APP_BASE_URL=https://monexus.oai-o.com
COOKIE_SECURE=true
TRUST_PROXY=1

# docker-compose.vps.yml binds this only to loopback. Host Caddy owns :80/:443.
# Change this if the host already uses 18089, and update the Caddy upstream too.
WEB_PORT=18089

# Keep all object storage inside this Compose project.
STORAGE_ENDPOINT=http://minio:9000
STORAGE_REGION=us-east-1
STORAGE_BUCKET=monexus-uploads
STORAGE_ACCESS_KEY=<strong-minio-user>
STORAGE_SECRET_KEY=<strong-minio-password>
STORAGE_PUBLIC_URL_BASE=https://monexus.oai-o.com/uploads
STORAGE_FORCE_PATH_STYLE=true

POSTGRES_USER=monexus
POSTGRES_PASSWORD=<strong-unique-password>
POSTGRES_DB=monexus
JWT_SECRET=<at-least-32-character-random-secret>
REDIS_PASSWORD=<strong-unique-password>
# Registration abuse protection is fail-closed after SPEC-RAP-001. Generate
# ABUSE_HASH_KEY separately from JWT/MFA keys; use a production Turnstile
# widget whose hostname list contains exactly monexus.oai-o.com.
ABUSE_PROTECTION_MODE=enforce
ABUSE_HASH_KEY=<independent-32-byte-standard-base64-secret>
TURNSTILE_SITE_KEY=<production-turnstile-site-key>
TURNSTILE_SECRET_KEY=<production-turnstile-secret-key>
TURNSTILE_ALLOWED_HOSTNAMES=monexus.oai-o.com
REDIS_ENABLED=true
REDIS_REQUIRED=true
REDIS_URL=redis://redis:6379
REDIS_TLS=false

# Public legal documents and registration/checkout consent evidence.
# Production requires this exact enabled/enforce pair; never set the fixture
# path there because it is reserved for isolated tests.
LEGAL_PAGES_ENABLED=true
LEGAL_PAGES_ENFORCEMENT=enforce

# Pin releases in production. `latest` is acceptable only for a disposable demo.
MONEXUS_IMAGE_TAG=latest
MONEXUS_PULL_POLICY=always
```

Generate secrets locally on the VPS, for example:

```bash
openssl rand -base64 48
```

The production server validates object storage, so do not remove the MinIO
variables even if product-image uploads are not immediately used.

## 4. Configure Caddy on the host

Caddy is deliberately not a Compose service: one host-level Caddy instance
can serve this app and any other sites, while it is the sole owner of public
ports 80 and 443. Add the site block from
[`deploy/vps/Caddyfile`](../../deploy/vps/Caddyfile) to the host's
`/etc/caddy/Caddyfile`. Its upstream must match `WEB_PORT` in `.env`:

```caddy
monexus.oai-o.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:18089
}
```

Validate and reload after adding the block (do not overwrite other sites in
an existing Caddyfile):

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 5. Start and verify

If the GHCR packages are private, log in once with a GitHub token that has
`read:packages` access:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

Validate the final Compose configuration, then pull and start the stack:

```bash
bash scripts/vps-compose.sh config
bash scripts/vps-compose.sh up
curl -fsS https://monexus.oai-o.com/api/health/live
curl -fsS https://monexus.oai-o.com/api/health/ready
```

The first server boot runs `prisma migrate deploy`. Do **not** seed a public
database: the bundled seed contains publicly known demo credentials. It is
only appropriate for an isolated, disposable local demo database:

```bash
docker compose --env-file .env -f docker-compose.prod.yml -f docker-compose.vps.yml \
  --profile selfhost-storage exec server npm run db:seed
```

## Releases and rollback

Pushing to `master` publishes `ghcr.io/amo0114/monexus-web` and
`ghcr.io/amo0114/monexus-server`. To update the VPS after that workflow
finishes:

```bash
cd /opt/monexus
bash scripts/vps-compose.sh up
```

Prefer an immutable `MONEXUS_IMAGE_TAG=sha-<commit>` for a real release. To
roll back, set the last known-good tag in `.env` and run the same command.

## Backups

PostgreSQL and MinIO are persistent Docker volumes, not backups. Schedule the
repository backup script daily. It creates an age-encrypted PostgreSQL dump
and, with `BACKUP_OBJECT_MODE=compose-minio`, an age-encrypted MinIO snapshot
through the private Compose network. Keep the age private identity off this
VPS, and configure `RCLONE_REMOTE` as an offsite `rclone crypt` remote.

```bash
cd /opt/monexus
set -a; . /etc/monexus/backup.env; set +a
bash scripts/backup.sh
```

Follow [the backup and restore rehearsal](./runbook.md#3-encrypted-database-and-object-backup)
before relying on the first artifact. Test database *and object* restoration in
an isolated environment; do not treat the local named volumes as recovery media.

### Single-node Redis

The bundled Redis service is intentionally a single, authenticated local
service for cache and registration-abuse limiter state. It has no published
port, is reachable only as `redis` on the Compose network, and writes AOF with
`appendfsync everysec`. It is **not** Redis HA: a host failure also stops this
application, and public registration plus user-email sends must fail closed
until the host is recovered. Do not add Sentinel, a replica, or a second Redis
endpoint unless the application itself has a separate failover target.

After each production deployment, verify persistence without printing the
password:

```bash
cd /opt/monexus
bash scripts/vps-compose.sh exec redis sh -c \
  'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli INFO persistence | grep "^aof_enabled:1$"'
```

`redisdata-prod` survives a normal container restart but is not an offsite
backup. The recovery priority is PostgreSQL and MinIO; limiter windows can
expire naturally after a host-loss recovery.

Do not commit `.env`, backups, passwords, GitHub tokens, or private keys.

For the registration-abuse rehearsal, use the separate
[dedicated staging deployment](./staging-deployment.md), never this production
host or its environment file.
