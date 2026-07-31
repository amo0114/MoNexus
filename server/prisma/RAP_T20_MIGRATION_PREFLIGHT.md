# T20 RAP migration isolation and verification

Status: **verified on the isolated PostgreSQL database `monexus_rap_test`**.

The single generated migration is
`20260731170039_registration_abuse_prevention`. It was created by the
lockfile-compatible Prisma CLI with `migrate dev --name
registration_abuse_prevention`; its SQL was never hand-authored or edited.

## Scope and generated result

The migration contains only the T20 data-model changes:

- `User.referralSuspended` with a `false` default;
- `InviteRelation` status/timestamps/qualification day plus qualification
  indexes, with `legacy` as the non-null migration default;
- `GrowthReward` and its unique keys, indexes, and relations;
- `AbuseEvent` and its nullable `SetNull` user relations and time indexes.

Before generating it, the Prisma schema was minimally aligned with three
existing historical migration facts: the Faka cancellation index and the two
Faka `updatedAt` database defaults. This prevents the RAP migration from
silently dropping unrelated, already-deployed structures. No historical
migration SQL or runtime code was changed.

## Required isolated execution protocol

Run from the RAP worktree root with Node 20/npm 10 and installed local server
dependencies. The PostgreSQL container listens only in its own network
namespace, so do not try host `localhost`, alter a default URL, or expose a
connection string.

```bash
set -euo pipefail

rap_root="$(git rev-parse --show-toplevel)"
rap_node_bin="$(dirname "$(command -v node)")"
if ! "$rap_node_bin/node" -e 'process.exit(process.versions.node.startsWith("20.") ? 0 : 1)'; then
  echo "Node 20 must be active before running the RAP migration protocol" >&2
  exit 2
fi

# Read the existing development connection only to derive the disposable DB
# name; do not print either connection string.
set -a
source /root/projects/MoNexus-new/server/.env
set +a
rap_database_url="$("$rap_node_bin/node" -e '
  const u = new URL(process.env.DATABASE_URL)
  u.pathname = "/monexus_rap_test"
  process.stdout.write(u.toString())
')"

RAP_DATABASE_URL="$rap_database_url" "$rap_node_bin/node" -e '
  const u = new URL(process.env.RAP_DATABASE_URL)
  const db = decodeURIComponent(u.pathname.slice(1))
  if (!["postgres:", "postgresql:"].includes(u.protocol) || db !== "monexus_rap_test") {
    throw new Error("RAP_DATABASE_URL must target only monexus_rap_test")
  }
  console.log("RAP database target confirmed: monexus_rap_test")
'

rap_db_pid="$(docker inspect --format '{{.State.Pid}}' monexus-db)"
rap_prisma() {
  nsenter -t "$rap_db_pid" -n -- env \
    PATH="$rap_node_bin:$PATH" \
    DATABASE_URL="$rap_database_url" \
    "$rap_root/server/node_modules/.bin/prisma" "$@"
}
```

Only after the guard reports the expected database name may Prisma run:

```bash
rap_prisma migrate status --schema "$rap_root/server/prisma/schema.prisma"
rap_prisma migrate dev --name registration_abuse_prevention --skip-generate \
  --schema "$rap_root/server/prisma/schema.prisma"
rap_prisma generate --schema "$rap_root/server/prisma/schema.prisma"
```

Use the worktree's lockfile-compatible
`server/node_modules/.bin/prisma`; never use an unpinned `npx prisma`, which
can download an incompatible major CLI. The commands must not run with
`DATABASE_URL`, `TEST_DATABASE_URL`, or another fallback target that has not
passed the guard.

## Fixture, replay, and model proof

Before generation, apply only the existing migration head to
`monexus_rap_test`, then insert a non-production fixture containing one
historical `InviteRelation`, a non-zero `PointAccount`, one `PointLog`, and an
unverified user. The recorded pre-migration values for this run were:

| Measure | Value |
| --- | ---: |
| InviteRelation count | 1 |
| PointAccount count | 1 |
| PointAccount balance sum | 137 |
| PointLog count | 1 |

After the generated migration applied, the historical relation was `legacy`,
`GrowthReward` remained empty, and the PointAccount/PointLog values remained
`1 / 137 / 1`. This proves the migration did not issue a reward or alter the
existing point ledger.

Replay every time the migration head changes:

```bash
rap_prisma migrate reset --force --skip-seed --skip-generate \
  --schema "$rap_root/server/prisma/schema.prisma"
rap_prisma migrate deploy --schema "$rap_root/server/prisma/schema.prisma"
rap_prisma migrate status --schema "$rap_root/server/prisma/schema.prisma"
rap_prisma generate --schema "$rap_root/server/prisma/schema.prisma"
```

Run the focused contract suite in the same network namespace. `REDIS_ENABLED`
is disabled only for this model suite because its global setup otherwise tries
to reset the unrelated local cache; T20 does not exercise Redis behavior.

```bash
nsenter -t "$rap_db_pid" -n -- env \
  PATH="$rap_node_bin:$PATH" \
  REDIS_ENABLED=false \
  DATABASE_URL="$rap_database_url" \
  TEST_DATABASE_URL="$rap_database_url" \
  "$rap_root/server/node_modules/.bin/vitest" run \
  "$rap_root/server/src/__tests__/rap-rewards-model.test.ts"
```

Expected evidence is 4/4 focused tests passing, a clean `migrate status`, and
`git diff --check`. No migration is accepted without this isolated proof.

## Recorded verification

| Check | Result |
| --- | --- |
| `migrate dev` generation/apply | `20260731170039_registration_abuse_prevention` created and applied on `monexus_rap_test` |
| Historical fixture after apply | 1 relation became `legacy`; `GrowthReward=0`; PointAccount/PointLog stayed `1 / 137 / 1` |
| Reset / deploy / status replay | 47 migrations applied; deploy reported no pending migrations; status reported schema up to date |
| Prisma client generation | Prisma Client `6.19.3` generated from this schema |
| Focused model suite | `src/__tests__/rap-rewards-model.test.ts`: 4/4 passed |
| Server typecheck | `npm run build` passed with Node `20.19.5` / npm `10.8.2` |
