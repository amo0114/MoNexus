# MoNexus Production GA Multi-Agent Assignment

| Field | Value |
| --- | --- |
| Date | 2026-05-12 |
| Status | Ready for agent dispatch |
| Stable baseline | `origin/master@4ed16e6` |
| Documentation branch | `docs/production-ga-prd` |
| Current human dev branch to preserve | `feat/coin-asset` |
| PRD | `docs/superpowers/specs/2026-05-12-monexus-production-ga-prd.md` |
| Implementation plan | `docs/superpowers/plans/2026-05-12-monexus-production-ga-implementation.md` |

---

## 1. Executive Rule

All M2 Production GA implementation agents must start from `origin/master@4ed16e6`.

Do not implement M2 work on:

- `feat/coin-asset`
- `docs/production-ga-prd`
- `master`
- `feat/ui-redesign`

The current main workspace is on `feat/coin-asset` and contains active local work. Treat it as occupied. Use new worktrees for all tasks below.

---

## 2. Shared Context for Every Agent

### Product Boundary

MoNexus is an internal points-based marketplace for digital goods. It has three roles:

- `user`: earns and spends internal points.
- `merchant`: manages products, inventory, orders, and settlements after approval.
- `admin`: manages users, merchants, products, settlements, system configuration, and operations.

Hard product exclusions:

- No real payment integration.
- No fiat recharge.
- No withdrawal.
- No refund to fiat.
- No physical shipping.
- No public marketplace where users list their own goods.

### Current Baseline

`origin/master@4ed16e6` already includes:

- PR #1 production readiness.
- PR #2 UI redesign.
- Concentric brand mark.
- All 10 major pages.
- Layout, Modal, Toast, and design-system migration.

Therefore:

- `feat/ui-redesign` is not a pending development branch.
- UI polish is incremental work on top of `origin/master`.
- The prunable `feat/ui-redesign` worktree can be cleaned separately, but no implementation agent should touch it.

### Important Existing Invariants

- All point amounts are non-negative integers.
- Admin write actions must create `AdminLog` records.
- Point balance mutations must create `PointLog` records.
- Password reset and password change must revoke outstanding refresh tokens.
- Banned users cannot log in or refresh.
- Merchant ownership boundaries should return 404 rather than leaking resource existence.
- User status uses Chinese strings in the current schema:
  - normal: `正常`
  - banned: `已封禁`

---

## 3. How to Prepare an Agent Worktree

Use this pattern for every implementation agent:

```bash
git fetch --all --prune
git worktree add ../monexus-<agent-slug> -b <branch-name> origin/master
cd ../monexus-<agent-slug>
```

If the agent runs in this same local repository, it can read the docs branch directly:

```bash
git show docs/production-ga-prd:docs/superpowers/specs/2026-05-12-monexus-production-ga-prd.md
git show docs/production-ga-prd:docs/superpowers/plans/2026-05-12-monexus-production-ga-implementation.md
git show docs/production-ga-prd:docs/superpowers/plans/2026-05-12-monexus-production-ga-agent-assignments.md
```

If the agent runs in a separate clone or remote environment, first push `docs/production-ga-prd` or paste these three documents into that agent prompt.

---

## 4. Global Rules for All Agents

### Required Development Discipline

Each agent must:

- Work only in its assigned branch and worktree.
- Modify only files listed in its ownership section unless a blocker requires a documented exception.
- Start with tests where the task has backend behavior.
- Run the verification commands listed in its task card.
- Commit its changes with one focused commit.
- Report changed files, commands run, results, and known risks.

### Prohibited Actions

No agent may:

- Commit directly to `master`.
- Commit to `feat/coin-asset`.
- Revert or delete another agent's changes.
- Modify unrelated icon assets under `design-system/monexus/icons-*`.
- Modify `.gitignore` unless explicitly assigned by the coordinator.
- Introduce payment, wallet recharge, withdrawal, or fiat concepts.
- Perform broad refactors outside the assigned module.
- Add a new framework when existing React, Express, Prisma, Zod, and Tailwind patterns are enough.

### Standard Completion Report

Every agent must end with this report format:

```text
Status: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED
Branch:
Commit:
Files changed:
Tests and checks run:
Result:
Manual checks:
Risks:
Integration notes:
```

---

## 5. Parallelization Strategy

### Wave 0: Coordination

- A0 prepares docs, branch list, merge order, and final integration checks.

### Wave 1: Low-conflict foundational work

Can run in parallel:

- A1: backend test repair and DB-aware health check.
- A2: backup script and runbook.
- A10: UI M2 polish.

Do not run A8 backend observability before A1 is merged, because both touch `server/src/app.ts`.

### Wave 2: Account and admin backend work

Can mostly run in parallel after A1:

- A3: password-change backend.
- A5: admin ban/unban backend.

Do not merge A6 system config until A3 and A5 have been reviewed, because A6 touches auth/admin/points shared modules.

### Wave 3: Config and admin UI work

Sequential preference:

- A6: system config backend.
- A4: password-change frontend.
- A7: admin console frontend for ban/unban and system config.

A7 owns `src/pages/AdminPage.tsx` and should run after backend routes are stable.

### Wave 4: Observability and documentation

Can run after A1, with coordinator-managed conflict resolution:

- A8: backend observability.
- A9: frontend error boundary and Sentry integration.
- A11: OpenAPI and module READMEs.

A11 should be last among feature-contract docs so it can reflect final endpoints.

---

## 6. Merge Order

Recommended integration order:

1. `chore/m2-test-and-health`
2. `ops/m2-backup-runbook`
3. `feat/m2-password-change-api`
4. `feat/m2-admin-user-ban-api`
5. `feat/m2-system-config-api`
6. `feat/m2-password-change-ui`
7. `feat/m2-admin-console-ui`
8. `feat/m2-observability-backend`
9. `feat/m2-observability-frontend`
10. `fix/m2-ui-polish`
11. `docs/m2-contract-readmes`

Known conflict zones:

| File | Possible agents | Coordinator action |
| --- | --- | --- |
| `server/src/app.ts` | A1, A8 | Merge A1 first, then rebase A8 and preserve health endpoint plus logger/error reporter middleware. |
| `server/src/modules/auth/service.ts` | A3, A6 | Merge A3 first, then wire config reads in A6 without removing password-change logic. |
| `server/src/modules/admin/service.ts` | A5, A6 | Merge A5 first, then add config functions in A6 below existing admin user controls. |
| `src/pages/ProfilePage.tsx` | A4, current `feat/coin-asset` | Do not develop A4 on `feat/coin-asset`; later integration must manually preserve coin asset UI work if both branches merge. |
| `src/pages/AdminPage.tsx` | A7, A10 | Prefer A7 first, then A10 rebase for responsive/focus polish. |
| `src/index.css` | A10, A9 | A10 owns tokens; A9 should not add global visual tokens unless necessary. |

---

## 7. Agent A0: Coordinator and Integrator

### Mission

Control the workstream, prevent branch pollution, review each agent result, and produce the final release-candidate integration branch.

### Branch

```text
integration/m2-production-ga-rc
```

Create this branch only after at least A1, A2, A3, and A5 have completed review.

### Owns

- Merge order.
- Review notes.
- Final verification.
- Release-candidate smoke checklist.
- Conflict resolution.

### Does Not Own

- Feature implementation.
- UI redesign.
- Coin asset work.

### Required Actions

1. Confirm each agent branch starts from `origin/master`.
2. Confirm each agent has one focused commit unless there is a clear reason.
3. Run spec compliance review against the PRD and implementation plan.
4. Run code quality review for each branch.
5. Merge branches in the order listed above.
6. Run final verification commands:

```bash
npm run build
npm --prefix server run build
npm --prefix server test
```

7. Run local stack smoke test if environment is available:

```bash
bash scripts/dev-up.sh --seed
curl -fsS http://localhost:3000/api/health
```

Expected health response includes:

```json
{ "status": "ok", "db": "ok" }
```

### Completion Criteria

- Integration branch contains all accepted M2 branches.
- Build and backend tests pass or blockers are documented with command output.
- Manual smoke checklist is complete.
- No unrelated `feat/coin-asset` files are merged accidentally.

---

## 8. Agent A1: Backend Test Repair and DB-Aware Health Check

### Mission

Make backend tests runnable in the local Linux environment and upgrade `/api/health` so it verifies PostgreSQL connectivity.

### Branch

```text
chore/m2-test-and-health
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a1-health -b chore/m2-test-and-health origin/master
cd ../monexus-a1-health
```

### Owns

- `server/src/app.ts`
- `server/src/__tests__/health.test.ts`
- `server/package-lock.json` only if `npm install` legitimately changes it

### Must Not Touch

- `src/**`
- `docs/operations/**`
- `server/src/modules/auth/**`
- `server/src/modules/admin/**`
- `server/prisma/schema.prisma`

### Detailed Tasks

1. Run:

```bash
cd server
npm install
npm test
```

2. Confirm the original native binding failure is gone. If PostgreSQL is unavailable, record that separately instead of hiding it.

3. Add `server/src/__tests__/health.test.ts` with coverage for:

- Healthy DB returns HTTP 200.
- Response body includes `status: "ok"`, `db: "ok"`, and string `time`.
- Failed `prisma.$queryRaw` returns HTTP 503.
- Failed response body includes `status: "fail"`, `db: "fail"`, and string `time`.

4. Modify `server/src/app.ts`:

- Import `prisma`.
- Change `/api/health` handler to async.
- Run `await prisma.$queryRaw\`SELECT 1\``.
- Return 200 when successful.
- Return 503 when the probe throws.

5. Keep the response simple and stable:

```json
{
  "status": "ok",
  "time": "2026-05-12T00:00:00.000Z",
  "db": "ok"
}
```

### Verification

```bash
cd server
npm test -- health.test.ts
npm test
npm run build
```

### Commit

```bash
git add server/src/app.ts server/src/__tests__/health.test.ts server/package-lock.json
git commit -m "chore(server): add database health probe"
```

Only include `server/package-lock.json` if it changed for a legitimate dependency repair.

### Handoff Notes

Tell A8 that `/api/health` is now async and uses Prisma. A8 must preserve this behavior when adding request logging and error reporting.

---

## 9. Agent A2: Backup Script and Operations Runbook

### Mission

Add a practical PostgreSQL backup script and an operations runbook that a new operator can follow during gray launch.

### Branch

```text
ops/m2-backup-runbook
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a2-ops -b ops/m2-backup-runbook origin/master
cd ../monexus-a2-ops
```

### Owns

- `scripts/backup.sh`
- `docs/operations/runbook.md`
- `docs/operations/README.md` only if needed to link the runbook

### Must Not Touch

- `server/src/**`
- `src/**`
- `server/prisma/schema.prisma`
- `.github/workflows/**`

### Detailed Tasks

1. Create `scripts/backup.sh`.

Required behavior:

- `set -euo pipefail`
- Require `DATABASE_URL`.
- Use `BACKUP_DIR`, default `/var/backups/monexus`.
- Use `RETENTION_DAYS`, default `30`.
- Create the backup directory if missing.
- Generate timestamped gzip dump: `monexus-YYYYMMDDTHHMMSSZ.sql.gz`.
- Use `pg_dump "$DATABASE_URL" | gzip -c > "$backup_file"`.
- Prune old backups with `find`.
- If `RCLONE_REMOTE` is set, copy the backup file with `rclone copy`.
- Print the final backup path.

2. Make the script executable.

3. Create `docs/operations/runbook.md`.

Runbook must cover:

- Service start and stop.
- Health check.
- Manual backup.
- Backup restore into staging.
- Daily cron example.
- Emergency user point adjustment.
- Emergency user ban.
- Merchant suspension.
- Logs to inspect.
- PostgreSQL connection failure.
- Disk full.
- Port occupied.
- Rollback procedure.

4. Do not include real secrets or production hostnames.

### Verification

```bash
bash -n scripts/backup.sh
test -x scripts/backup.sh
rg -n "DATABASE_URL|pg_dump|RETENTION_DAYS|restore|rollback|health" docs/operations/runbook.md scripts/backup.sh
```

If a local PostgreSQL database is available, also run one real backup against a disposable database and document the command result.

### Commit

```bash
git add scripts/backup.sh docs/operations/runbook.md docs/operations/README.md
git commit -m "ops: add backup script and gray launch runbook"
```

Only include `docs/operations/README.md` if created.

### Handoff Notes

Tell A0 whether backup restore was only syntax-reviewed or actually exercised against a local database.

---

## 10. Agent A3: Password Change Backend

### Mission

Add authenticated password change to the backend. This is the API and test portion only.

### Branch

```text
feat/m2-password-change-api
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a3-password-api -b feat/m2-password-change-api origin/master
cd ../monexus-a3-password-api
```

### Owns

- `server/src/modules/auth/schema.ts`
- `server/src/modules/auth/routes.ts`
- `server/src/modules/auth/controller.ts`
- `server/src/modules/auth/service.ts`
- `server/src/__tests__/auth-tokens.test.ts`
- `server/src/__tests__/auth.test.ts` only if the repo's existing tests make this file a better fit

### Must Not Touch

- `src/pages/ProfilePage.tsx`
- `src/api/auth.ts`
- `server/src/modules/admin/**`
- `server/prisma/schema.prisma`

### API Contract

```http
POST /api/auth/password-change
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Request:

```json
{
  "currentPassword": "OldPassw0rd!",
  "newPassword": "NewPassw0rd!"
}
```

Success:

```json
{
  "message": "密码已修改，请重新登录"
}
```

Required behavior:

- Requires authenticated user.
- Rejects wrong current password.
- Rejects weak new password using existing password strength conventions.
- Hashes new password with the same bcrypt strategy used by registration/reset.
- Revokes all refresh tokens for the user.
- Does not alter point balance, role, or status.
- If user is `已封禁`, protected auth middleware should already prevent normal use; do not create special bypass behavior.

### Required Tests

Add backend tests for:

- Successful password change.
- Old refresh token no longer refreshes after change.
- Old password no longer logs in.
- New password logs in.
- Wrong current password returns an error and does not change the password.
- Unauthenticated request is rejected.

### Implementation Notes

Prefer adding:

- `passwordChangeSchema` in `schema.ts`.
- `changePassword(userId, currentPassword, newPassword)` in `service.ts`.
- `changePasswordHandler` in `controller.ts`.
- Protected route in `routes.ts`.

Use the existing `revokeAllUserRefreshTokens` helper instead of duplicating token logic.

### Verification

```bash
cd server
npm test -- auth-tokens.test.ts
npm test -- auth.test.ts
npm run build
```

### Commit

```bash
git add server/src/modules/auth/schema.ts server/src/modules/auth/routes.ts server/src/modules/auth/controller.ts server/src/modules/auth/service.ts server/src/__tests__/auth-tokens.test.ts server/src/__tests__/auth.test.ts
git commit -m "feat(auth): add logged-in password change"
```

Only include the test files actually modified.

### Handoff Notes

Tell A4 the final endpoint path, request shape, success message, and any error message strings that the UI should display.

---

## 11. Agent A4: Password Change Frontend

### Mission

Expose password change in the user profile UI after A3 defines the backend contract.

### Branch

```text
feat/m2-password-change-ui
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a4-password-ui -b feat/m2-password-change-ui origin/master
cd ../monexus-a4-password-ui
```

If A3 is not merged into `origin/master`, base this branch from A3 after coordinator approval:

```bash
git switch -c feat/m2-password-change-ui feat/m2-password-change-api
```

### Owns

- `src/api/auth.ts`
- `src/pages/ProfilePage.tsx`

### Must Not Touch

- `server/**`
- `src/pages/AdminPage.tsx`
- `src/App.tsx`
- `src/components/ui/CoinIcon.tsx`
- `design-system/monexus/icons-*`

### UX Requirements

Add a security/password area inside the existing profile experience. Follow the current UI patterns from the merged design system.

Required fields:

- Current password.
- New password.
- Confirm new password.

Required behavior:

- Client validates new password and confirmation match.
- Submit calls A3 endpoint.
- Show loading state.
- Show backend error message when available.
- On success, clear auth state and force the user to log in again.
- Do not show or store refresh tokens in frontend state.
- Do not create a marketing-style page; keep it as a compact account control.

### Implementation Notes

Add an API helper:

```ts
export async function changePassword(payload: {
  currentPassword: string
  newPassword: string
}): Promise<{ message: string }> {
  const { data } = await api.post('/auth/password-change', payload)
  return data
}
```

Adjust the route prefix if existing `src/api/client.ts` already prefixes `/api`.

### Verification

```bash
npm run build
```

Manual checks:

- Profile page still renders for logged-in users.
- Empty fields show client-side validation.
- Mismatched confirmation is blocked.
- Successful change logs the user out or sends them to login.
- Existing profile order/history sections still render.

### Commit

```bash
git add src/api/auth.ts src/pages/ProfilePage.tsx
git commit -m "feat(profile): add password change control"
```

### Handoff Notes

Tell A0 if this branch is based on A3 rather than `origin/master`.

---

## 12. Agent A5: Admin User Ban and Unban Backend

### Mission

Add admin backend controls to ban and unban users, with refresh-token revocation and audit logs.

### Branch

```text
feat/m2-admin-user-ban-api
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a5-admin-ban-api -b feat/m2-admin-user-ban-api origin/master
cd ../monexus-a5-admin-ban-api
```

### Owns

- `server/src/modules/admin/schema.ts`
- `server/src/modules/admin/routes.ts`
- `server/src/modules/admin/controller.ts`
- `server/src/modules/admin/service.ts`
- `server/src/__tests__/admin.test.ts`

### Must Not Touch

- `src/pages/AdminPage.tsx`
- `server/src/modules/auth/service.ts` unless an existing token helper is not exported and the coordinator approves the change
- `server/prisma/schema.prisma`
- `server/src/modules/points/**`

### API Contract

Ban:

```http
PUT /api/admin/users/:id/ban
Authorization: Bearer <adminAccessToken>
Content-Type: application/json
```

Request:

```json
{
  "reason": "abuse"
}
```

Unban:

```http
PUT /api/admin/users/:id/unban
Authorization: Bearer <adminAccessToken>
```

Required behavior:

- Admin only.
- Ban sets `User.status = "已封禁"`.
- Unban sets `User.status = "正常"`.
- Ban revokes all outstanding refresh tokens for that user.
- Ban and unban create `AdminLog`.
- Prevent self-ban.
- Prevent banning admin users unless the PRD is explicitly revised.
- Return 404 for missing user.

### Required Tests

Add backend tests for:

- Admin can ban normal user.
- Banned user cannot log in.
- Existing refresh token cannot refresh after ban.
- Admin can unban user.
- Unbanned user can log in again with existing password.
- Non-admin cannot ban.
- Admin cannot ban self.
- Admin cannot ban another admin.
- `AdminLog` is written for ban and unban.

### Verification

```bash
cd server
npm test -- admin.test.ts
npm test -- auth-tokens.test.ts
npm run build
```

### Commit

```bash
git add server/src/modules/admin/schema.ts server/src/modules/admin/routes.ts server/src/modules/admin/controller.ts server/src/modules/admin/service.ts server/src/__tests__/admin.test.ts
git commit -m "feat(admin): add user ban controls"
```

### Handoff Notes

Tell A7 the final endpoint paths, response shapes, and any status strings needed for UI rendering.

---

## 13. Agent A6: System Configuration Backend

### Mission

Add live system configuration for reward values and expose admin APIs for reading/updating config.

### Branch

```text
feat/m2-system-config-api
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a6-system-config-api -b feat/m2-system-config-api origin/master
cd ../monexus-a6-system-config-api
```

Prefer starting after A3 and A5 are merged or available for rebase.

### Owns

- `server/prisma/schema.prisma`
- `server/prisma/migrations/**`
- `server/src/lib/systemConfig.ts`
- `server/src/modules/auth/service.ts`
- `server/src/modules/points/service.ts`
- `server/src/modules/admin/schema.ts`
- `server/src/modules/admin/routes.ts`
- `server/src/modules/admin/controller.ts`
- `server/src/modules/admin/service.ts`
- `server/src/__tests__/system-config.test.ts`

### Must Not Touch

- `src/pages/AdminPage.tsx`
- `src/api/adminConfig.ts`
- `src/**`
- `docs/operations/**`

### Config Keys

Support exactly these keys:

| Key | Default | Use |
| --- | ---: | --- |
| `registerReward` | `500` | points granted on registration |
| `checkinReward` | `50` | points granted on daily check-in |
| `inviteReward` | `200` | points granted to inviter |
| `refreshTokenMaxAgeDays` | `7` | optional config read for refresh-token lifetime if implemented safely |

If `refreshTokenMaxAgeDays` creates too much auth risk for this task, leave it readable/editable but do not wire token expiration until a separate review. Document the decision in the completion report.

### Data Model Requirements

Add `SystemConfig` with:

- `key` unique string.
- `value` integer.
- `description` optional string.
- `updatedAt`.
- `updatedBy` optional admin user relation.

Migration must be generated through Prisma, not handwritten loosely.

### API Contract

List:

```http
GET /api/admin/config
```

Update:

```http
PUT /api/admin/config/:key
Content-Type: application/json
```

Request:

```json
{
  "value": 100
}
```

Required behavior:

- Admin only.
- Unknown keys rejected.
- Values must be non-negative integers.
- Updates create `AdminLog`.
- Missing DB row falls back to static defaults from `server/src/config/index.ts`.

### Runtime Wiring

Replace hardcoded reads for:

- Registration reward in `server/src/modules/auth/service.ts`.
- Check-in reward in `server/src/modules/points/service.ts`.
- Invite reward where current invite reward is granted.

Do not change point transaction semantics.

### Required Tests

Add tests for:

- `GET /api/admin/config` returns all known keys with defaults.
- Admin can update `checkinReward`.
- Non-admin cannot update config.
- Unknown key is rejected.
- Negative value is rejected.
- Check-in uses the updated reward.
- Registration uses the updated reward.
- Config update writes `AdminLog`.

### Verification

```bash
cd server
npx prisma migrate dev --name add_system_config
npm test -- system-config.test.ts
npm test -- auth.test.ts
npm test -- points.test.ts
npm run build
```

Use the actual existing test filenames if they differ.

### Commit

```bash
git add server/prisma/schema.prisma server/prisma/migrations server/src/lib/systemConfig.ts server/src/modules/auth/service.ts server/src/modules/points/service.ts server/src/modules/admin/schema.ts server/src/modules/admin/routes.ts server/src/modules/admin/controller.ts server/src/modules/admin/service.ts server/src/__tests__/system-config.test.ts
git commit -m "feat(admin): add live system configuration api"
```

### Handoff Notes

Tell A7 the final config response type, allowed keys, and endpoint paths.

---

## 14. Agent A7: Admin Console Frontend

### Mission

Add admin UI for user ban/unban and system configuration after A5 and A6 backend contracts are stable.

### Branch

```text
feat/m2-admin-console-ui
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a7-admin-ui -b feat/m2-admin-console-ui origin/master
cd ../monexus-a7-admin-ui
```

If A5/A6 are not merged into `origin/master`, base from the coordinator's integration branch that includes both backend APIs.

### Owns

- `src/pages/AdminPage.tsx`
- `src/api/admin.ts` if existing admin API helpers live there
- `src/api/adminConfig.ts`

### Must Not Touch

- `server/**`
- `src/pages/ProfilePage.tsx`
- `src/App.tsx`
- `src/index.css` unless A10 has approved a token usage need
- `design-system/monexus/icons-*`

### UI Scope

User management:

- Show status clearly for `正常` and `已封禁`.
- Add ban action for normal non-admin users.
- Add unban action for banned non-admin users.
- Ask for ban reason in a compact modal or prompt following existing modal patterns.
- Disable self-ban if current admin user appears in the table.
- Refresh user list after action.

System config:

- Add an admin config section or tab.
- Show `registerReward`, `checkinReward`, `inviteReward`, and `refreshTokenMaxAgeDays`.
- Use numeric inputs.
- Reject negative values client-side.
- Save one key at a time.
- Show loading and error states.
- Refresh config after successful save.

### API Helpers

Create `src/api/adminConfig.ts`:

```ts
import api from './client'

export type AdminSystemConfigKey =
  | 'registerReward'
  | 'checkinReward'
  | 'inviteReward'
  | 'refreshTokenMaxAgeDays'

export interface AdminSystemConfig {
  key: AdminSystemConfigKey
  value: number
  defaultValue: number
  updatedAt: string | null
  updatedBy: number | null
}

export async function getAdminConfig(): Promise<AdminSystemConfig[]> {
  const { data } = await api.get<AdminSystemConfig[]>('/admin/config')
  return data
}

export async function updateAdminConfig(
  key: AdminSystemConfigKey,
  value: number,
): Promise<AdminSystemConfig> {
  const { data } = await api.put<AdminSystemConfig>(`/admin/config/${key}`, { value })
  return data
}
```

Adjust prefixes/types to match the final A6 response.

### Verification

```bash
npm run build
```

Manual checks:

- Admin page loads.
- User list still renders.
- Ban button appears only for eligible users.
- Unban button appears only for banned users.
- Config values load.
- Saving a config value updates UI without full page reload.
- Mobile width does not break admin tables.

### Commit

```bash
git add src/pages/AdminPage.tsx src/api/admin.ts src/api/adminConfig.ts
git commit -m "feat(admin): add user controls and config ui"
```

Only include `src/api/admin.ts` if modified.

### Handoff Notes

Tell A10 where responsive table wrappers or focus polish are still needed.

---

## 15. Agent A8: Backend Observability

### Mission

Add structured backend logging, request IDs, and backend error reporting while preserving the health endpoint from A1.

### Branch

```text
feat/m2-observability-backend
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a8-observability-api -b feat/m2-observability-backend origin/master
cd ../monexus-a8-observability-api
```

Start after A1 is merged or rebase on A1.

### Owns

- `server/package.json`
- `server/package-lock.json`
- `server/src/app.ts`
- `server/src/config/index.ts`
- `server/src/lib/logger.ts`
- `server/src/lib/errorReporter.ts`
- `server/src/middlewares/requestLogger.ts`
- `server/src/middlewares/errorHandler.ts`
- `server/src/types/express.d.ts` only if needed for request id typing
- `server/src/__tests__/observability.test.ts` if practical

### Must Not Touch

- `src/**`
- `server/src/modules/auth/service.ts`
- `server/src/modules/admin/service.ts`
- `server/prisma/schema.prisma`

### Dependencies

Install backend packages only:

```bash
cd server
npm install pino @sentry/node
```

If choosing `pino-http`, document why and include it explicitly.

### Required Behavior

- Generate or accept `x-request-id`.
- Add `x-request-id` to responses.
- Log method, path, status, duration, and user id when available.
- Avoid logging passwords, tokens, delivery credentials, or raw cookies.
- Add Sentry/GlitchTip-compatible backend error reporting behind `SENTRY_DSN`.
- In development without DSN, reporter is a no-op.
- Error responses include `requestId` so logs can be correlated.
- Preserve `/api/health` response from A1.

### Verification

```bash
cd server
npm run build
npm test
```

Manual check:

```bash
npm run dev
curl -i http://localhost:3000/api/health
```

Expected:

- Response includes `x-request-id`.
- Body still includes `status`, `time`, and `db`.

### Commit

```bash
git add server/package.json server/package-lock.json server/src/app.ts server/src/config/index.ts server/src/lib/logger.ts server/src/lib/errorReporter.ts server/src/middlewares/requestLogger.ts server/src/middlewares/errorHandler.ts server/src/types/express.d.ts server/src/__tests__/observability.test.ts
git commit -m "feat(server): add structured observability"
```

Only include files actually created or modified.

### Handoff Notes

Tell A9 the frontend Sentry env variable name to use.

---

## 16. Agent A9: Frontend Error Boundary and Error Reporting

### Mission

Add frontend error aggregation and a production-safe error boundary without changing the visual design system.

### Branch

```text
feat/m2-observability-frontend
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a9-observability-ui -b feat/m2-observability-frontend origin/master
cd ../monexus-a9-observability-ui
```

### Owns

- `package.json`
- `package-lock.json`
- `src/main.tsx`
- `src/lib/errorReporter.ts`
- `src/components/AppErrorBoundary.tsx`
- `src/vite-env.d.ts` if env typing is needed

### Must Not Touch

- `server/**`
- `src/pages/AdminPage.tsx`
- `src/pages/ProfilePage.tsx`
- `src/index.css` unless needed for a tiny existing-token-only fallback style

### Dependencies

```bash
npm install @sentry/react
```

### Required Behavior

- Use `import.meta.env.VITE_SENTRY_DSN`.
- In development without DSN, reporting is a no-op.
- Wrap the app with an error boundary.
- Fallback UI must use existing design-system styles and stay compact.
- Do not expose stack traces to end users.
- Preserve existing routing.

### Verification

```bash
npm run build
```

Manual check:

- App boots normally.
- Login and store pages render.
- No console error from missing Sentry DSN in development.

### Commit

```bash
git add package.json package-lock.json src/main.tsx src/lib/errorReporter.ts src/components/AppErrorBoundary.tsx src/vite-env.d.ts
git commit -m "feat(ui): add frontend error reporting boundary"
```

Only include `src/vite-env.d.ts` if modified.

### Handoff Notes

Tell A0 whether any environment variable documentation is needed in deployment docs.

---

## 17. Agent A10: UI M2 Polish

### Mission

Polish the already-merged PR #2 UI system for M2 without doing another redesign.

### Branch

```text
fix/m2-ui-polish
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a10-ui-polish -b fix/m2-ui-polish origin/master
cd ../monexus-a10-ui-polish
```

### Owns

- `src/App.tsx`
- `src/index.css`
- `src/components/EmailVerificationBanner.tsx`
- `src/components/ui/Tabs.tsx`
- `src/pages/AdminPage.tsx` only for responsive wrappers and only after A7 coordination

### Must Not Touch

- `server/**`
- `src/pages/ProfilePage.tsx`
- `src/components/ui/CoinIcon.tsx`
- `design-system/monexus/icons-*`
- Logo brief docs unless correcting a direct typo

### Detailed Tasks

1. Decide `/_dev/tokens` behavior for M2:

- Preferred: guard route behind `import.meta.env.DEV`.
- Production builds should not expose the design-token preview route.

2. Add warning semantic tokens to `src/index.css` if missing:

- warning background.
- warning border.
- warning text.
- warning icon/accent.

3. Update `EmailVerificationBanner`:

- Replace hardcoded amber Tailwind classes with warning tokens or established design-system classes.
- Preserve current copy and behavior.

4. Audit `Tabs` focus:

- Keyboard focus must be visible.
- Focus ring must work in light and dark mode.
- Do not shift layout on focus.

5. Admin responsive polish:

- If A7 has not completed, only document the needed AdminPage responsive changes.
- If A7 has completed, add wrappers so user/config tables do not overflow mobile viewports.

6. Scan for stale pre-redesign classes:

```bash
rg -n -- "--c-|apple-card|input-field|bg-amber|text-amber|border-amber" src
```

Any remaining hit must be removed or justified in the completion report.

### Verification

```bash
npm run build
rg -n -- "--c-|apple-card|input-field|bg-amber|text-amber|border-amber" src
```

Manual viewport checks:

- `/login` at 375px, 768px, 1440px.
- `/` at 375px, 768px, 1440px.
- `/profile` at 375px, 768px, 1440px.
- `/admin` at 375px, 768px, 1440px when admin UI is available.
- Dark mode banner, modal, cards, and focus rings.

### Commit

```bash
git add src/App.tsx src/index.css src/components/EmailVerificationBanner.tsx src/components/ui/Tabs.tsx src/pages/AdminPage.tsx
git commit -m "fix(ui): polish m2 focus contrast and dev routes"
```

Only include `src/pages/AdminPage.tsx` if modified.

### Handoff Notes

Tell A0 whether `/_dev/tokens` was removed, dev-guarded, or intentionally retained.

---

## 18. Agent A11: OpenAPI and Module Documentation

### Mission

Update API contract docs and module READMEs after feature endpoints stabilize.

### Branch

```text
docs/m2-contract-readmes
```

### Worktree

```bash
git fetch --all --prune
git worktree add ../monexus-a11-contract-docs -b docs/m2-contract-readmes origin/master
cd ../monexus-a11-contract-docs
```

Prefer starting from the coordinator integration branch after A3, A5, and A6 are merged.

### Owns

- `docs/superpowers/specs/monexus-api-openapi.json`
- `server/src/modules/auth/README.md`
- `server/src/modules/admin/README.md`
- `server/src/modules/orders/README.md`
- `server/src/modules/merchant/README.md`

### Must Not Touch

- `server/src/**` runtime code except README files.
- `src/**`
- `server/prisma/schema.prisma`

### Required Contract Additions

OpenAPI must include:

- `POST /api/auth/password-change`
- `PUT /api/admin/users/{id}/ban`
- `PUT /api/admin/users/{id}/unban`
- `GET /api/admin/config`
- `PUT /api/admin/config/{key}`
- Updated `/api/health` response with `db`.

Auth README must include:

- Register.
- Login.
- Refresh token rotation.
- Logout.
- `/me`.
- Password reset.
- Email verification.
- Password change.
- Token revocation invariants.

Admin README must include:

- User listing.
- User point adjustment.
- User ban/unban.
- Product management.
- Merchant approval/suspension.
- Settlement batch processing.
- System configuration.
- AdminLog invariant.

Orders README must include:

- Transaction boundary for redeeming products.
- Inventory single-use invariant.
- Settlement creation for merchant products.
- Delivery content exposure rules.

Merchant README must include:

- Merchant status model.
- Product ownership.
- Inventory import.
- Order visibility.
- Settlement visibility.

### Verification

```bash
node -e "JSON.parse(require('fs').readFileSync('docs/superpowers/specs/monexus-api-openapi.json', 'utf8')); console.log('openapi json ok')"
rg -n "password-change|/ban|/unban|admin/config|db" docs/superpowers/specs/monexus-api-openapi.json
rg -n "Password change|ban|System configuration|Settlement|Inventory" server/src/modules/*/README.md
```

### Commit

```bash
git add docs/superpowers/specs/monexus-api-openapi.json server/src/modules/auth/README.md server/src/modules/admin/README.md server/src/modules/orders/README.md server/src/modules/merchant/README.md
git commit -m "docs(m2): sync api contract and module readmes"
```

### Handoff Notes

Tell A0 which endpoint schemas were inferred from implemented code and which were copied from plan text.

---

## 19. Review Protocol for Every Agent Branch

Each branch must go through two reviews before merge.

### Review 1: Spec Compliance

Reviewer checks:

- Does the branch implement exactly its assigned task?
- Does it match the PRD and implementation plan?
- Are all required tests or manual checks present?
- Did the agent avoid unrelated files?
- Did the agent preserve product exclusions?

Reviewer output:

```text
Spec review: APPROVED / CHANGES_REQUESTED
Blocking issues:
Non-blocking notes:
Files inspected:
```

### Review 2: Code Quality

Reviewer checks:

- TypeScript builds.
- Prisma migration is valid if present.
- Transactions are correct.
- Auth and admin boundaries are enforced.
- Error messages are consistent.
- No secrets or sensitive tokens are logged.
- UI states include loading, error, disabled, and empty states where relevant.
- Mobile layout does not overflow.

Reviewer output:

```text
Code quality review: APPROVED / CHANGES_REQUESTED
Blocking issues:
Non-blocking notes:
Verification commands:
```

If a review requests changes, the original implementation agent should fix the branch and rerun verification.

---

## 20. Copy-Paste Prompt Template

Use this prompt when assigning a task to an external agent:

```text
You are Agent <ID> for MoNexus M2 Production GA.

Baseline: origin/master@4ed16e6
Branch: <branch-name>
Worktree: create a new worktree; do not use feat/coin-asset.

Read these docs:
- docs/production-ga-prd:docs/superpowers/specs/2026-05-12-monexus-production-ga-prd.md
- docs/production-ga-prd:docs/superpowers/plans/2026-05-12-monexus-production-ga-implementation.md
- docs/production-ga-prd:docs/superpowers/plans/2026-05-12-monexus-production-ga-agent-assignments.md

Your assigned task is Agent <ID>: <task title>.

You may modify only the files listed under "Owns".
You must not touch the files listed under "Must Not Touch".
Follow the detailed tasks and verification commands exactly.
Commit your work with the specified commit message unless the implementation requires a more precise conventional commit.

Return:
Status:
Branch:
Commit:
Files changed:
Tests and checks run:
Result:
Manual checks:
Risks:
Integration notes:
```

---

## 21. Final Release Candidate Gate

After A0 merges accepted branches into `integration/m2-production-ga-rc`, run:

```bash
npm run build
npm --prefix server run build
npm --prefix server test
```

Then run or document the local smoke path:

```bash
bash scripts/dev-up.sh --seed
curl -fsS http://localhost:3000/api/health
```

Manual release-candidate checklist:

- Register a user.
- Verify `/api/auth/me`.
- Send verification email in console mailer mode.
- Reset password with captured console link.
- Change password from profile and confirm forced re-login.
- Sign in as admin.
- Ban a user and confirm login is rejected.
- Unban the user and confirm login works.
- Change `checkinReward` in Admin config.
- Sign in as normal user and check in; reward matches config.
- Create merchant application.
- Approve merchant.
- Sign in as merchant.
- Create product, upload image, import inventory.
- Redeem merchant product as user.
- Confirm merchant sees order and `settlementAmount`.
- Batch settle as admin.
- Run backup script against local database or documented staging database.
- Confirm `/api/health` reports `db: "ok"`.
- Confirm request IDs appear in backend responses.
- Confirm frontend build has no exposed `/_dev/tokens` production route unless intentionally dev-guarded.

Release candidate is not ready until all command output and manual checks are recorded in A0's final report.
