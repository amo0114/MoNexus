# MoNexus Production GA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the current `origin/master` baseline to M2 gray-launch readiness by making tests repeatable, adding operational recovery, completing account/admin controls, adding live system configuration, improving observability, and polishing the already-merged UI system.

**Architecture:** Keep the existing React/Vite frontend and Express/Prisma/PostgreSQL backend. Implement M2 work as small short-lived branches from `origin/master`; do not continue feature implementation on the documentation branch `docs/production-ga-prd`. Backend changes stay inside `server/**`, operational changes in `scripts/**` and `docs/operations/**`, and UI polish in `src/**`.

**Tech Stack:** React 18, Vite, TypeScript, Zustand, Tailwind, Express 4, Prisma 6, PostgreSQL 16, Zod, Vitest, GitHub Actions, Docker Compose, pino, Sentry or GlitchTip-compatible SDK.

---

## Branch Discipline

- Current documentation branch: `docs/production-ga-prd`.
- Stable implementation baseline: `origin/master@4ed16e6`, which already includes PR #2 UI redesign.
- Each task below should be implemented from `origin/master` on a short branch:
  - `chore/m2-test-and-health`
  - `ops/m2-backup-runbook`
  - `feat/m2-password-change`
  - `feat/m2-admin-user-ban`
  - `feat/m2-system-config`
  - `feat/m2-observability`
  - `fix/m2-ui-polish`
- Do not modify the unrelated local `.gitignore` change or untracked `design-system/monexus/icons-*` asset directories unless a task explicitly asks for design asset cleanup.

## File Structure

### Backend Runtime

- `server/src/app.ts`: Express middleware, routes, health endpoint, observability middleware registration.
- `server/src/config/index.ts`: environment parsing and static fallback values.
- `server/src/lib/prisma.ts`: singleton Prisma client.
- `server/src/lib/httpError.ts`: typed application errors.
- `server/src/middlewares/errorHandler.ts`: error response envelope.
- `server/src/middlewares/auth.ts`: authentication, admin guard, merchant guard.

### Backend Modules

- `server/src/modules/auth/schema.ts`: Zod request schemas for auth endpoints.
- `server/src/modules/auth/routes.ts`: auth route declarations and rate limits.
- `server/src/modules/auth/controller.ts`: auth HTTP handlers and cookie side effects.
- `server/src/modules/auth/service.ts`: password hashing, refresh-token storage, password reset, email verification.
- `server/src/modules/admin/schema.ts`: admin Zod schemas.
- `server/src/modules/admin/routes.ts`: admin route declarations.
- `server/src/modules/admin/controller.ts`: admin HTTP handlers.
- `server/src/modules/admin/service.ts`: admin business logic, `AdminLog`, user and merchant operations.
- `server/src/modules/points/service.ts`: check-in reward and point history.

### New Backend Libraries

- Create `server/src/lib/systemConfig.ts`: read integer config values from `SystemConfig` with typed fallback values.
- Create `server/src/lib/logger.ts`: pino logger instance.
- Create `server/src/middlewares/requestLogger.ts`: request id and request logging middleware.
- Create `server/src/lib/errorReporter.ts`: Sentry/GlitchTip wrapper with no-op fallback.

### Tests

- Existing tests live in `server/src/__tests__/*.test.ts`.
- Create `server/src/__tests__/health.test.ts`.
- Extend `server/src/__tests__/auth-tokens.test.ts`.
- Extend `server/src/__tests__/admin.test.ts`.
- Create `server/src/__tests__/system-config.test.ts`.

### Frontend

- `src/App.tsx`: protected routes and `/_dev/tokens` route.
- `src/api/auth.ts`: auth API helpers.
- Create `src/api/adminConfig.ts`: admin config API helpers.
- `src/pages/ProfilePage.tsx`: personal center; add password-change UI.
- `src/pages/AdminPage.tsx`: admin console; add config and ban/unban controls.
- `src/components/EmailVerificationBanner.tsx`: warning token polish.
- `src/index.css`: design tokens; add warning tokens if missing.
- `src/components/ui/Tabs.tsx`: focus-ring audit target.

### Operations

- Create `scripts/backup.sh`.
- Create `docs/operations/runbook.md`.
- Update `.github/workflows/ci.yml` only if a task adds OpenAPI lint or new verification commands.

---

## Task 1: Baseline Test Repair and Health Check

**Files:**
- Modify: `server/src/app.ts`
- Create: `server/src/__tests__/health.test.ts`
- Reference: `server/package.json`
- Reference: `server/src/__tests__/setup.ts`

- [ ] **Step 1: Start from the correct branch**

Run:

```bash
git fetch --all --prune
git switch -c chore/m2-test-and-health origin/master
```

Expected: new branch `chore/m2-test-and-health` based on `origin/master`.

- [ ] **Step 2: Repair local backend dependencies**

Run:

```bash
cd server
npm install
```

Expected: `server/node_modules/@rolldown/binding-linux-x64-gnu` exists after install on Linux.

- [ ] **Step 3: Verify current test startup**

Run:

```bash
npm test
```

Expected before code changes: tests start. If PostgreSQL is not running, failure should be a database connection error, not `Cannot find native binding`.

- [ ] **Step 4: Write failing health test**

Create `server/src/__tests__/health.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { api } from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('GET /api/health', () => {
  it('should include database health when postgres is reachable', async () => {
    const res = await api.get('/api/health').expect(200)

    expect(res.body.status).toBe('ok')
    expect(res.body.db).toBe('ok')
    expect(typeof res.body.time).toBe('string')
  })

  it('should return 503 when postgres probe fails', async () => {
    const spy = vi
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('db unavailable'))

    const res = await api.get('/api/health').expect(503)

    expect(res.body.status).toBe('fail')
    expect(res.body.db).toBe('fail')
    expect(typeof res.body.time).toBe('string')

    spy.mockRestore()
  })
})
```

- [ ] **Step 5: Run failing test**

Run:

```bash
cd server
npm test -- health.test.ts
```

Expected: second test fails because `/api/health` currently always returns 200 and has no `db` field.

- [ ] **Step 6: Implement DB-aware health endpoint**

Modify `server/src/app.ts`:

```ts
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import { config } from './config/index.js'
import { prisma } from './lib/prisma.js'
import { errorHandler } from './middlewares/errorHandler.js'
import { authRoutes } from './modules/auth/routes.js'
import { productRoutes } from './modules/products/routes.js'
import { pointRoutes } from './modules/points/routes.js'
import { orderRoutes } from './modules/orders/routes.js'
import { adminRoutes } from './modules/admin/routes.js'
import { merchantRoutes } from './modules/merchant/routes.js'
import { uploadsRoutes } from './modules/uploads/routes.js'

const app = express()

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后再试',
    },
  },
})

app.use(helmet())
app.use(cors({
  origin: config.frontendOrigin,
  credentials: true,
}))
app.use(cookieParser())
app.use(express.json({ limit: '1mb' }))
app.use('/api', apiLimiter)

app.use('/api/auth', authRoutes)
app.use('/api/products', productRoutes)
app.use('/api/points', pointRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/merchant', merchantRoutes)
app.use('/api/uploads', uploadsRoutes)

app.get('/api/health', async (_req, res) => {
  const time = new Date().toISOString()
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', time, db: 'ok' })
  } catch {
    res.status(503).json({ status: 'fail', time, db: 'fail' })
  }
})

app.use(errorHandler)

export { app }
```

- [ ] **Step 7: Run health test**

Run:

```bash
cd server
npm test -- health.test.ts
```

Expected: both tests pass.

- [ ] **Step 8: Run backend build and full tests**

Run:

```bash
cd server
npm run build
npm test
```

Expected: TypeScript build passes and full backend tests pass.

- [ ] **Step 9: Commit**

Run:

```bash
git add server/src/app.ts server/src/__tests__/health.test.ts server/package-lock.json server/package.json
git commit -m "chore(m2): repair backend tests and add db health probe"
```

If `npm install` does not change `server/package-lock.json` or `server/package.json`, omit those files from `git add`.

---

## Task 2: Backup Script and Operations Runbook

**Files:**
- Create: `scripts/backup.sh`
- Create: `docs/operations/runbook.md`
- Modify: `.gitignore` only if backup output paths are not already ignored

- [ ] **Step 1: Start from master**

Run:

```bash
git fetch --all --prune
git switch -c ops/m2-backup-runbook origin/master
```

Expected: new branch `ops/m2-backup-runbook`.

- [ ] **Step 2: Create backup script**

Create `scripts/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[ERROR] DATABASE_URL is required." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/monexus}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/monexus-${TS}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[INFO] Writing backup to ${OUT}"
pg_dump "$DATABASE_URL" | gzip > "$OUT"
chmod 600 "$OUT"

echo "[INFO] Removing backups older than ${RETENTION_DAYS} days from ${BACKUP_DIR}"
find "$BACKUP_DIR" -type f -name 'monexus-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "[INFO] Backup complete: ${OUT}"
```

- [ ] **Step 3: Make script executable**

Run:

```bash
chmod +x scripts/backup.sh
```

Expected: script mode includes executable bit.

- [ ] **Step 4: Write runbook**

Create `docs/operations/runbook.md`:

```md
# MoNexus Operations Runbook

## Scope

This runbook covers M2 gray-launch operations for MoNexus on the production Docker Compose stack.

## Required Secrets

- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`
- `JWT_SECRET`
- `FRONTEND_ORIGIN`
- `COOKIE_SECURE`
- `STORAGE_ENDPOINT`
- `STORAGE_BUCKET`
- `STORAGE_ACCESS_KEY`
- `STORAGE_SECRET_KEY`
- `SMTP_HOST`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

## Local Startup

```bash
bash scripts/dev-up.sh --seed
```

Open:

- Frontend: `http://localhost:5173`
- Backend health: `http://localhost:3000/api/health`

## Production Startup

```bash
cp .env.example .env
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
curl -fsS http://localhost/api/health
```

Expected health response:

```json
{ "status": "ok", "db": "ok" }
```

## Stop Services

```bash
docker compose -f docker-compose.prod.yml down
```

## Restart Backend

```bash
docker compose -f docker-compose.prod.yml restart server
docker compose -f docker-compose.prod.yml logs --tail=100 server
```

## Database Migration

The production backend container runs `npx prisma migrate deploy` before starting. For manual migration:

```bash
docker compose -f docker-compose.prod.yml exec server npx prisma migrate deploy
```

## Backup

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DB?schema=public'
export BACKUP_DIR=/var/backups/monexus
bash scripts/backup.sh
```

## Restore to Staging

```bash
createdb monexus_restore_check
gunzip -c /var/backups/monexus/monexus-YYYYMMDDTHHMMSSZ.sql.gz | psql 'postgresql://USER:PASSWORD@HOST:5432/monexus_restore_check?schema=public'
```

After restore:

```bash
psql 'postgresql://USER:PASSWORD@HOST:5432/monexus_restore_check?schema=public' -c 'select count(*) from "User";'
```

## Emergency: Adjust User Points

Use the admin UI first. If the UI is unavailable, run SQL only with a second operator watching:

```sql
begin;
update "PointAccount" set "balance" = "balance" + 100 where "userId" = 123;
insert into "PointLog" ("userId", "type", "amount", "balanceAfter", "reason", "createdAt")
select 123, 'in', 100, "balance", 'emergency admin adjustment', now()
from "PointAccount"
where "userId" = 123;
commit;
```

## Emergency: Suspend Merchant

Use the admin UI first. If the UI is unavailable:

```sql
begin;
update "Merchant" set "status" = 'suspended' where "id" = 123;
update "User" set "role" = 'user' where "id" = (select "userId" from "Merchant" where "id" = 123);
update "RefreshToken" set "revoked" = true where "userId" = (select "userId" from "Merchant" where "id" = 123);
commit;
```

## Common Faults

### PostgreSQL connection failure

```bash
docker compose -f docker-compose.prod.yml ps postgres
docker compose -f docker-compose.prod.yml logs --tail=100 postgres
```

### Port already in use

```bash
docker ps
sudo lsof -i :80
```

### Disk full

```bash
df -h
du -sh /var/backups/monexus
docker system df
```

### SMTP unavailable

Check `SMTP_HOST`, `SMTP_USER`, `SMTP_FROM`, and backend logs. Password reset remains unavailable until SMTP recovers.

### MinIO or S3 unavailable

Existing images remain available through object storage if the provider is reachable. New uploads fail until storage recovers.

## Rollback

```bash
git checkout <previous-release-tag>
docker compose -f docker-compose.prod.yml up -d --build
curl -fsS http://localhost/api/health
```
```

- [ ] **Step 5: Shell-check by running script without env**

Run:

```bash
bash scripts/backup.sh
```

Expected: exits non-zero with `[ERROR] DATABASE_URL is required.`

- [ ] **Step 6: Run docs diff**

Run:

```bash
git diff -- scripts/backup.sh docs/operations/runbook.md
```

Expected: only backup script and runbook content appear.

- [ ] **Step 7: Commit**

Run:

```bash
git add scripts/backup.sh docs/operations/runbook.md
git commit -m "ops(m2): add postgres backup script and runbook"
```

---

## Task 3: Password Change

**Files:**
- Modify: `server/src/modules/auth/schema.ts`
- Modify: `server/src/modules/auth/routes.ts`
- Modify: `server/src/modules/auth/controller.ts`
- Modify: `server/src/modules/auth/service.ts`
- Modify: `server/src/__tests__/auth-tokens.test.ts`
- Modify: `src/api/auth.ts`
- Modify: `src/pages/ProfilePage.tsx`

- [ ] **Step 1: Start from master**

Run:

```bash
git fetch --all --prune
git switch -c feat/m2-password-change origin/master
```

- [ ] **Step 2: Write backend failing tests**

Append to `server/src/__tests__/auth-tokens.test.ts`:

```ts
describe('POST /api/auth/password-change', () => {
  it('should reject unauthenticated password changes', async () => {
    await api
      .post('/api/auth/password-change')
      .send({ oldPassword: 'old-password', newPassword: 'new-password' })
      .expect(401)
  })

  it('should reject an incorrect old password', async () => {
    const { user, password } = await createTestUser('change-wrong@test.local')
    const { accessToken } = await loginAs(user.email, password)

    const res = await api
      .post('/api/auth/password-change')
      .set(authHeader(accessToken))
      .send({ oldPassword: 'wrong-password', newPassword: 'new-password' })
      .expect(400)

    expect(res.body.error.message).toMatch(/旧密码/)
  })

  it('should update password and revoke refresh tokens', async () => {
    const { user, password } = await createTestUser('change-ok@test.local')
    const login = await loginAs(user.email, password)

    await api
      .post('/api/auth/password-change')
      .set(authHeader(login.accessToken))
      .send({ oldPassword: password, newPassword: 'changed-password' })
      .expect(200)

    await api
      .post('/api/auth/refresh')
      .set('Cookie', login.cookies)
      .expect(401)

    await api
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(401)

    await api
      .post('/api/auth/login')
      .send({ email: user.email, password: 'changed-password' })
      .expect(200)
  })
})
```

- [ ] **Step 3: Run failing password-change tests**

Run:

```bash
cd server
npm test -- auth-tokens.test.ts
```

Expected: password-change tests fail because route does not exist.

- [ ] **Step 4: Add schema**

Modify `server/src/modules/auth/schema.ts`:

```ts
export const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1, '请输入旧密码'),
  newPassword: z.string().min(6, '新密码至少 6 位'),
})
```

- [ ] **Step 5: Add service function**

Modify `server/src/modules/auth/service.ts` and add:

```ts
export async function changePassword(userId: number, oldPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw notFound('用户不存在')
  if (user.status === '已封禁') throw badRequest('账号已被封禁')

  const valid = await bcrypt.compare(oldPassword, user.password)
  if (!valid) throw badRequest('旧密码不正确')

  const hashed = await bcrypt.hash(newPassword, 10)
  await prisma.$transaction(async tx => {
    await tx.user.update({
      where: { id: userId },
      data: { password: hashed },
    })
    await revokeAllUserRefreshTokens(userId, tx)
  })

  return { ok: true }
}
```

- [ ] **Step 6: Add controller**

Modify `server/src/modules/auth/controller.ts` and add:

```ts
export async function passwordChange(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.changePassword(req.user!.userId, req.body.oldPassword, req.body.newPassword)
    clearRefreshTokenCookie(res)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}
```

- [ ] **Step 7: Add route**

Modify imports in `server/src/modules/auth/routes.ts`:

```ts
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailQuerySchema,
  passwordChangeSchema,
} from './schema.js'
```

Add route:

```ts
router.post('/password-change', authLimiter, authenticate, validate(passwordChangeSchema), controller.passwordChange)
```

- [ ] **Step 8: Run backend tests**

Run:

```bash
cd server
npm test -- auth-tokens.test.ts
npm run build
```

Expected: password-change tests pass and TypeScript build passes.

- [ ] **Step 9: Add frontend API helper**

Modify `src/api/auth.ts`:

```ts
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await api.post('/auth/password-change', { oldPassword, newPassword })
}
```

- [ ] **Step 10: Add Profile UI state and handler**

Modify `src/pages/ProfilePage.tsx`:

1. Import `KeyRound` from `lucide-react`.
2. Import `changePassword` from `../api/auth`.
3. Add `security` to the tab union:

```ts
const [activeTab, setActiveTab] = useState<'orders' | 'history' | 'security'>('orders')
```

4. Add state:

```ts
const [oldPassword, setOldPassword] = useState('')
const [newPassword, setNewPassword] = useState('')
const [confirmPassword, setConfirmPassword] = useState('')
const [changingPassword, setChangingPassword] = useState(false)
```

5. Add handler:

```ts
async function handleChangePassword(e: React.FormEvent) {
  e.preventDefault()
  if (newPassword !== confirmPassword) {
    showToast('两次输入的新密码不一致', 'error')
    return
  }
  setChangingPassword(true)
  try {
    await changePassword(oldPassword, newPassword)
    showToast('密码已修改，请重新登录')
    logout()
    navigate('/login')
  } catch (err) {
    showToast(getApiErrorMessage(err, '修改密码失败'), 'error')
  } finally {
    setChangingPassword(false)
  }
}
```

6. Add tab trigger:

```tsx
<TabsTrigger value="security">账号安全</TabsTrigger>
```

7. Add tab content:

```tsx
<TabsContent value="security">
  <form onSubmit={handleChangePassword} className="max-w-md space-y-4">
    <div className="flex items-center gap-2 mb-2 text-[var(--color-text)]">
      <KeyRound className="w-5 h-5 text-[var(--color-primary)]" />
      <h3 className="font-heading font-bold">修改密码</h3>
    </div>
    <input
      type="password"
      className="input"
      placeholder="旧密码"
      value={oldPassword}
      onChange={(e) => setOldPassword(e.target.value)}
      required
    />
    <input
      type="password"
      className="input"
      placeholder="新密码，至少 6 位"
      value={newPassword}
      onChange={(e) => setNewPassword(e.target.value)}
      minLength={6}
      required
    />
    <input
      type="password"
      className="input"
      placeholder="再次输入新密码"
      value={confirmPassword}
      onChange={(e) => setConfirmPassword(e.target.value)}
      minLength={6}
      required
    />
    <button type="submit" disabled={changingPassword} className="btn-primary">
      {changingPassword ? '修改中...' : '保存新密码'}
    </button>
  </form>
</TabsContent>
```

- [ ] **Step 11: Run frontend build**

Run:

```bash
npm run build
```

Expected: frontend build passes.

- [ ] **Step 12: Commit**

Run:

```bash
git add server/src/modules/auth/schema.ts server/src/modules/auth/routes.ts server/src/modules/auth/controller.ts server/src/modules/auth/service.ts server/src/__tests__/auth-tokens.test.ts src/api/auth.ts src/pages/ProfilePage.tsx
git commit -m "feat(auth): add logged-in password change"
```

---

## Task 4: Admin User Ban and Unban

**Files:**
- Modify: `server/src/modules/admin/schema.ts`
- Modify: `server/src/modules/admin/routes.ts`
- Modify: `server/src/modules/admin/controller.ts`
- Modify: `server/src/modules/admin/service.ts`
- Modify: `server/src/__tests__/admin.test.ts`
- Modify: `src/pages/AdminPage.tsx`

- [ ] **Step 1: Start from master**

Run:

```bash
git fetch --all --prune
git switch -c feat/m2-admin-user-ban origin/master
```

- [ ] **Step 2: Write failing tests**

Append to `server/src/__tests__/admin.test.ts`:

```ts
describe('Admin user ban and unban', () => {
  it('should ban a user, revoke refresh tokens, and reject future login', async () => {
    await createTestUser('ban-admin@test.local', 'admin123', 'admin')
    const { user } = await createTestUser('ban-target@test.local', 'pass123', 'user')
    const targetLogin = await loginAs('ban-target@test.local', 'pass123')
    const admin = await loginAs('ban-admin@test.local', 'admin123')

    const res = await api
      .put(`/api/admin/users/${user.id}/ban`)
      .set(authHeader(admin.accessToken))
      .send({ reason: 'abuse' })
      .expect(200)

    expect(res.body.status).toBe('已封禁')

    await api
      .post('/api/auth/refresh')
      .set('Cookie', targetLogin.cookies)
      .expect(401)

    await api
      .post('/api/auth/login')
      .send({ email: 'ban-target@test.local', password: 'pass123' })
      .expect(400)
  })

  it('should unban a user and allow login again', async () => {
    await createTestUser('unban-admin@test.local', 'admin123', 'admin')
    const { user } = await createTestUser('unban-target@test.local', 'pass123', 'user')
    await prisma.user.update({ where: { id: user.id }, data: { status: '已封禁' } })
    const admin = await loginAs('unban-admin@test.local', 'admin123')

    const res = await api
      .put(`/api/admin/users/${user.id}/unban`)
      .set(authHeader(admin.accessToken))
      .expect(200)

    expect(res.body.status).toBe('正常')

    await api
      .post('/api/auth/login')
      .send({ email: 'unban-target@test.local', password: 'pass123' })
      .expect(200)
  })
})
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
cd server
npm test -- admin.test.ts
```

Expected: new tests fail because ban/unban routes do not exist.

- [ ] **Step 4: Add schema**

Modify `server/src/modules/admin/schema.ts`:

```ts
export const banUserSchema = z.object({
  reason: z.string().min(1, '请填写封禁原因'),
})
```

- [ ] **Step 5: Add service functions**

Modify `server/src/modules/admin/service.ts`:

```ts
export async function banUser(adminUserId: number, targetUserId: number, reason: string) {
  if (adminUserId === targetUserId) throw badRequest('不能封禁当前管理员账号')

  return prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: targetUserId } })
    if (!user) throw notFound('用户不存在')
    if (user.status === '已封禁') throw badRequest('用户已被封禁')

    const updated = await tx.user.update({
      where: { id: targetUserId },
      data: { status: '已封禁' },
      select: { id: true, email: true, role: true, status: true, createdAt: true },
    })

    await revokeAllUserRefreshTokens(targetUserId, tx)

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '封禁用户',
        targetType: 'user',
        targetId: targetUserId,
        detail: reason,
      },
    })

    return updated
  })
}

export async function unbanUser(adminUserId: number, targetUserId: number) {
  return prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: targetUserId } })
    if (!user) throw notFound('用户不存在')
    if (user.status !== '已封禁') throw badRequest('用户未被封禁')

    const updated = await tx.user.update({
      where: { id: targetUserId },
      data: { status: '正常' },
      select: { id: true, email: true, role: true, status: true, createdAt: true },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '解封用户',
        targetType: 'user',
        targetId: targetUserId,
        detail: '用户状态恢复正常',
      },
    })

    return updated
  })
}
```

- [ ] **Step 6: Add controller handlers**

Modify `server/src/modules/admin/controller.ts`:

```ts
export async function banUser(req: Request, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id as unknown as number
    res.json(await adminService.banUser(req.user!.userId, targetId, req.body.reason))
  } catch (err) { next(err) }
}

export async function unbanUser(req: Request, res: Response, next: NextFunction) {
  try {
    const targetId = req.params.id as unknown as number
    res.json(await adminService.unbanUser(req.user!.userId, targetId))
  } catch (err) { next(err) }
}
```

- [ ] **Step 7: Add routes**

Modify imports in `server/src/modules/admin/routes.ts` to include `banUserSchema`, then add routes after adjust:

```ts
router.put('/users/:id/ban', validate({ params: idParamSchema, body: banUserSchema }), controller.banUser)
router.put('/users/:id/unban', validate({ params: idParamSchema }), controller.unbanUser)
```

- [ ] **Step 8: Run backend tests**

Run:

```bash
cd server
npm test -- admin.test.ts auth.test.ts
npm run build
```

Expected: admin and auth tests pass.

- [ ] **Step 9: Add Admin UI controls**

Modify `src/pages/AdminPage.tsx`:

1. Add handlers near `confirmAdjust()`:

```ts
async function handleBanUser(userId: number) {
  const reason = window.prompt('请输入封禁原因：')
  if (!reason) return
  try {
    await api.put(`/admin/users/${userId}/ban`, { reason })
    showToast('用户已封禁')
    loadTabData('users')
  } catch (err: any) {
    showToast(getApiErrorMessage(err, '封禁失败'), 'error')
  }
}

async function handleUnbanUser(userId: number) {
  if (!window.confirm('确认解封该用户？')) return
  try {
    await api.put(`/admin/users/${userId}/unban`)
    showToast('用户已解封')
    loadTabData('users')
  } catch (err: any) {
    showToast(getApiErrorMessage(err, '解封失败'), 'error')
  }
}
```

2. In the users table action column, add:

```tsx
{u.status === '已封禁' ? (
  <ActionLink tone="cta" onClick={() => handleUnbanUser(u.id)}>解封</ActionLink>
) : (
  <ActionLink tone="danger" onClick={() => handleBanUser(u.id)}>封禁</ActionLink>
)}
```

If `ActionLink` does not support `danger`, extend the local helper component:

```tsx
type ActionTone = 'primary' | 'cta' | 'danger'
```

and map `danger` to `text-red-500 hover:text-red-600`.

- [ ] **Step 10: Run frontend build**

Run:

```bash
npm run build
```

Expected: frontend build passes.

- [ ] **Step 11: Commit**

Run:

```bash
git add server/src/modules/admin/schema.ts server/src/modules/admin/routes.ts server/src/modules/admin/controller.ts server/src/modules/admin/service.ts server/src/__tests__/admin.test.ts src/pages/AdminPage.tsx
git commit -m "feat(admin): add user ban and unban controls"
```

---

## Task 5: System Configuration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: Prisma migration via `npx prisma migrate dev --name add_system_config`
- Create: `server/src/lib/systemConfig.ts`
- Modify: `server/src/modules/auth/service.ts`
- Modify: `server/src/modules/points/service.ts`
- Modify: `server/src/modules/admin/schema.ts`
- Modify: `server/src/modules/admin/routes.ts`
- Modify: `server/src/modules/admin/controller.ts`
- Modify: `server/src/modules/admin/service.ts`
- Create: `server/src/__tests__/system-config.test.ts`
- Create: `src/api/adminConfig.ts`
- Modify: `src/pages/AdminPage.tsx`

- [ ] **Step 1: Start from master**

Run:

```bash
git fetch --all --prune
git switch -c feat/m2-system-config origin/master
```

- [ ] **Step 2: Add Prisma model**

Modify `server/prisma/schema.prisma`:

```prisma
model SystemConfig {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
  updatedBy Int?

  updatedByUser User? @relation("SystemConfigUpdatedBy", fields: [updatedBy], references: [id])
}
```

Add relation to `User`:

```prisma
updatedConfigs SystemConfig[] @relation("SystemConfigUpdatedBy")
```

- [ ] **Step 3: Create migration**

Run:

```bash
cd server
npx prisma migrate dev --name add_system_config
```

Expected: new migration directory under `server/prisma/migrations`.

- [ ] **Step 4: Create config helper**

Create `server/src/lib/systemConfig.ts`:

```ts
import { prisma } from './prisma.js'
import { config } from '../config/index.js'

export type SystemConfigKey =
  | 'registerReward'
  | 'checkinReward'
  | 'inviteReward'
  | 'refreshTokenMaxAgeDays'

const defaults: Record<SystemConfigKey, number> = {
  registerReward: config.registerReward,
  checkinReward: config.checkinReward,
  inviteReward: config.inviteReward,
  refreshTokenMaxAgeDays: Math.floor(config.refreshTokenMaxAgeMs / (24 * 60 * 60 * 1000)),
}

export const systemConfigKeys = Object.keys(defaults) as SystemConfigKey[]

export function isSystemConfigKey(key: string): key is SystemConfigKey {
  return systemConfigKeys.includes(key as SystemConfigKey)
}

export function getDefaultSystemConfigValue(key: SystemConfigKey) {
  return defaults[key]
}

export async function getSystemConfigNumber(key: SystemConfigKey) {
  const row = await prisma.systemConfig.findUnique({ where: { key } })
  if (!row) return defaults[key]

  const parsed = Number(row.value)
  if (!Number.isInteger(parsed) || parsed < 0) return defaults[key]
  return parsed
}

export async function listSystemConfigValues() {
  const rows = await prisma.systemConfig.findMany()
  const byKey = new Map(rows.map(row => [row.key, row]))

  return systemConfigKeys.map(key => {
    const row = byKey.get(key)
    return {
      key,
      value: row ? Number(row.value) : defaults[key],
      defaultValue: defaults[key],
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    }
  })
}
```

- [ ] **Step 5: Use config helper in registration**

Modify `server/src/modules/auth/service.ts`:

```ts
import { getSystemConfigNumber } from '../../lib/systemConfig.js'
```

Inside `registerUser`, before the transaction:

```ts
const registerReward = await getSystemConfigNumber('registerReward')
const inviteReward = await getSystemConfigNumber('inviteReward')
```

Replace `config.registerReward` and `config.inviteReward` inside `registerUser` with these local constants.

Return:

```ts
user: buildAuthUser(user, registerReward),
```

- [ ] **Step 6: Use config helper in check-in**

Modify `server/src/modules/points/service.ts`:

```ts
import { getSystemConfigNumber } from '../../lib/systemConfig.js'
```

Inside `checkin` before transaction:

```ts
const checkinReward = await getSystemConfigNumber('checkinReward')
```

Replace `config.checkinReward` in `checkin` with `checkinReward`.

- [ ] **Step 7: Add admin schema**

Modify `server/src/modules/admin/schema.ts`:

```ts
export const updateSystemConfigSchema = z.object({
  value: z.number().int().min(0, '配置值必须为非负整数'),
})

export const systemConfigKeyParamSchema = z.object({
  key: z.enum(['registerReward', 'checkinReward', 'inviteReward', 'refreshTokenMaxAgeDays']),
})
```

- [ ] **Step 8: Add admin service functions**

Modify `server/src/modules/admin/service.ts`:

```ts
import {
  listSystemConfigValues,
  getDefaultSystemConfigValue,
  isSystemConfigKey,
  SystemConfigKey,
} from '../../lib/systemConfig.js'
```

Add:

```ts
export async function listSystemConfigs() {
  return listSystemConfigValues()
}

export async function updateSystemConfig(adminUserId: number, key: SystemConfigKey, value: number) {
  if (!isSystemConfigKey(key)) throw badRequest('未知配置项')
  if (!Number.isInteger(value) || value < 0) throw badRequest('配置值必须为非负整数')
  if (key === 'refreshTokenMaxAgeDays' && value < 1) throw badRequest('refreshTokenMaxAgeDays 至少为 1')

  return prisma.$transaction(async tx => {
    const updated = await tx.systemConfig.upsert({
      where: { key },
      create: { key, value: String(value), updatedBy: adminUserId },
      update: { value: String(value), updatedBy: adminUserId },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '更新系统配置',
        targetType: 'systemConfig',
        targetId: null,
        detail: `${key}: ${getDefaultSystemConfigValue(key)} -> ${value}`,
      },
    })

    return {
      key,
      value: Number(updated.value),
      defaultValue: getDefaultSystemConfigValue(key),
      updatedAt: updated.updatedAt,
      updatedBy: updated.updatedBy,
    }
  })
}
```

- [ ] **Step 9: Add controller and routes**

Modify `server/src/modules/admin/controller.ts`:

```ts
export async function listConfig(_req: Request, res: Response, next: NextFunction) {
  try { res.json(await adminService.listSystemConfigs()) } catch (err) { next(err) }
}

export async function updateConfig(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.updateSystemConfig(
      req.user!.userId,
      req.params.key as any,
      req.body.value
    ))
  } catch (err) { next(err) }
}
```

Modify `server/src/modules/admin/routes.ts` imports and add:

```ts
router.get('/config', controller.listConfig)
router.put('/config/:key', validate({ params: systemConfigKeyParamSchema, body: updateSystemConfigSchema }), controller.updateConfig)
```

- [ ] **Step 10: Write backend tests**

Create `server/src/__tests__/system-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { api, createTestUser, loginAs, authHeader } from './helpers.js'

describe('Admin system config', () => {
  it('should list supported config keys', async () => {
    await createTestUser('config-admin@test.local', 'admin123', 'admin')
    const admin = await loginAs('config-admin@test.local', 'admin123')

    const res = await api
      .get('/api/admin/config')
      .set(authHeader(admin.accessToken))
      .expect(200)

    expect(res.body.map((item: any) => item.key)).toEqual([
      'registerReward',
      'checkinReward',
      'inviteReward',
      'refreshTokenMaxAgeDays',
    ])
  })

  it('should update checkin reward and use it for future checkins', async () => {
    await createTestUser('config-admin2@test.local', 'admin123', 'admin')
    await createTestUser('config-user@test.local', 'pass123', 'user', 0)
    const admin = await loginAs('config-admin2@test.local', 'admin123')
    const user = await loginAs('config-user@test.local', 'pass123')

    await api
      .put('/api/admin/config/checkinReward')
      .set(authHeader(admin.accessToken))
      .send({ value: 77 })
      .expect(200)

    const checkin = await api
      .post('/api/points/checkin')
      .set(authHeader(user.accessToken))
      .expect(200)

    expect(checkin.body.reward).toBe(77)
    expect(checkin.body.balanceAfter).toBe(77)
  })
})
```

- [ ] **Step 11: Run backend tests**

Run:

```bash
cd server
npm test -- system-config.test.ts auth.test.ts
npm run build
```

Expected: tests and build pass.

- [ ] **Step 12: Add frontend API**

Create `src/api/adminConfig.ts`:

```ts
import api from './client'

export interface AdminSystemConfig {
  key: 'registerReward' | 'checkinReward' | 'inviteReward' | 'refreshTokenMaxAgeDays'
  value: number
  defaultValue: number
  updatedAt: string | null
  updatedBy: number | null
}

export async function getAdminConfig(): Promise<AdminSystemConfig[]> {
  const { data } = await api.get<AdminSystemConfig[]>('/admin/config')
  return data
}

export async function updateAdminConfig(key: AdminSystemConfig['key'], value: number): Promise<AdminSystemConfig> {
  const { data } = await api.put<AdminSystemConfig>(`/admin/config/${key}`, { value })
  return data
}
```

- [ ] **Step 13: Add Admin UI tab**

Modify `src/pages/AdminPage.tsx`:

1. Extend tab union:

```ts
type AdminTab = 'dashboard' | 'users' | 'products' | 'orders' | 'logs' | 'merchants' | 'settlements' | 'config'
```

2. Add nav item:

```ts
{ id: 'config', label: '系统配置', icon: Settings },
```

3. Import Settings and API:

```ts
import { Settings } from 'lucide-react'
import { getAdminConfig, updateAdminConfig, AdminSystemConfig } from '../api/adminConfig'
```

4. Add state:

```ts
const [configs, setConfigs] = useState<AdminSystemConfig[]>([])
const [savingConfigKey, setSavingConfigKey] = useState<string | null>(null)
```

5. Load tab:

```ts
} else if (tab === 'config') {
  const data = await getAdminConfig()
  setConfigs(data)
}
```

6. Add handler:

```ts
async function handleUpdateConfig(key: AdminSystemConfig['key'], value: string) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    showToast('配置值必须为非负整数', 'error')
    return
  }
  setSavingConfigKey(key)
  try {
    await updateAdminConfig(key, parsed)
    showToast('配置已保存')
    loadTabData('config')
  } catch (err: any) {
    showToast(getApiErrorMessage(err, '保存失败'), 'error')
  } finally {
    setSavingConfigKey(null)
  }
}
```

7. Add content:

```tsx
{activeTab === 'config' && (
  <div className="space-y-4">
    <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">系统配置</h2>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {configs.map((item) => (
        <div key={item.key} className="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-background)]">
          <div className="text-sm font-bold text-[var(--color-text)]">{item.key}</div>
          <div className="text-xs text-[var(--color-text-muted)] mb-3">默认值：{item.defaultValue}</div>
          <div className="flex gap-2">
            <input
              className="input"
              type="number"
              min={0}
              defaultValue={item.value}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleUpdateConfig(item.key, event.currentTarget.value)
                }
              }}
            />
            <button
              className="btn-primary whitespace-nowrap"
              disabled={savingConfigKey === item.key}
              onClick={(event) => {
                const input = event.currentTarget.parentElement?.querySelector('input')
                if (input) handleUpdateConfig(item.key, input.value)
              }}
            >
              {savingConfigKey === item.key ? '保存中' : '保存'}
            </button>
          </div>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 14: Run full verification**

Run:

```bash
npm run build
cd server
npm run build
npm test -- system-config.test.ts auth.test.ts
```

Expected: frontend build, backend build, and selected backend tests pass.

- [ ] **Step 15: Commit**

Run:

```bash
git add server/prisma/schema.prisma server/prisma/migrations server/src/lib/systemConfig.ts server/src/modules/auth/service.ts server/src/modules/points/service.ts server/src/modules/admin/schema.ts server/src/modules/admin/routes.ts server/src/modules/admin/controller.ts server/src/modules/admin/service.ts server/src/__tests__/system-config.test.ts src/api/adminConfig.ts src/pages/AdminPage.tsx
git commit -m "feat(admin): add live system configuration"
```

---

## Task 6: Observability

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/config/index.ts`
- Create: `server/src/lib/logger.ts`
- Create: `server/src/middlewares/requestLogger.ts`
- Create: `server/src/lib/errorReporter.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/middlewares/errorHandler.ts`
- Modify: `package.json`
- Modify: `src/main.tsx`

- [ ] **Step 1: Start from master**

Run:

```bash
git fetch --all --prune
git switch -c feat/m2-observability origin/master
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install @sentry/react
npm --prefix server install pino @sentry/node
```

Expected: root and server lockfiles update.

- [ ] **Step 3: Add server env vars**

Modify `server/src/config/index.ts` env schema:

```ts
SENTRY_DSN: z.string().url().optional(),
```

Export:

```ts
sentryDsn: env.SENTRY_DSN,
```

- [ ] **Step 4: Create logger**

Create `server/src/lib/logger.ts`:

```ts
import pino from 'pino'
import { config } from '../config/index.js'

export const logger = pino({
  level: config.isProduction ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'oldPassword',
      'newPassword',
      'token',
      'refreshToken',
    ],
    remove: true,
  },
})
```

- [ ] **Step 5: Create request logging middleware**

Create `server/src/middlewares/requestLogger.ts`:

```ts
import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { logger } from '../lib/logger.js'

declare module 'express-serve-static-core' {
  interface Request {
    id?: string
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  req.id = crypto.randomUUID()
  res.setHeader('X-Request-Id', req.id)

  const startedAt = Date.now()
  res.on('finish', () => {
    logger.info({
      requestId: req.id,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      userId: req.user?.userId,
    }, 'request completed')
  })

  next()
}
```

- [ ] **Step 6: Create error reporter**

Create `server/src/lib/errorReporter.ts`:

```ts
import * as Sentry from '@sentry/node'
import { config } from '../config/index.js'

let enabled = false

export function initErrorReporter() {
  if (!config.sentryDsn || config.nodeEnv !== 'production') return
  Sentry.init({ dsn: config.sentryDsn, environment: config.nodeEnv })
  enabled = true
}

export function reportError(err: unknown, context?: Record<string, unknown>) {
  if (!enabled) return
  Sentry.withScope(scope => {
    for (const [key, value] of Object.entries(context ?? {})) {
      scope.setExtra(key, value)
    }
    Sentry.captureException(err)
  })
}
```

- [ ] **Step 7: Wire middleware**

Modify `server/src/app.ts`:

```ts
import { requestLogger } from './middlewares/requestLogger.js'
```

Add before routes:

```ts
app.use(requestLogger)
```

- [ ] **Step 8: Report server errors**

Modify `server/src/middlewares/errorHandler.ts` to import reporter and include request id:

```ts
import { reportError } from '../lib/errorReporter.js'
```

Inside error handler, before response:

```ts
if (status >= 500) {
  reportError(err, { requestId: req.id, path: req.path, method: req.method, userId: req.user?.userId })
}
```

Include `requestId` in the error response:

```ts
requestId: req.id,
```

- [ ] **Step 9: Initialize error reporter**

Modify `server/src/main.ts`:

```ts
import { initErrorReporter } from './lib/errorReporter.js'

initErrorReporter()
```

Call it before `app.listen`.

- [ ] **Step 10: Add frontend Sentry init**

Modify `src/main.tsx`:

```ts
import * as Sentry from '@sentry/react'

if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
  })
}
```

Wrap root render:

```tsx
<Sentry.ErrorBoundary fallback={<div className="p-6 text-sm text-red-500">页面加载失败，请刷新后重试。</div>}>
  <App />
</Sentry.ErrorBoundary>
```

- [ ] **Step 11: Build verification**

Run:

```bash
npm run build
npm --prefix server run build
```

Expected: both builds pass.

- [ ] **Step 12: Commit**

Run:

```bash
git add package.json package-lock.json server/package.json server/package-lock.json server/src/config/index.ts server/src/lib/logger.ts server/src/middlewares/requestLogger.ts server/src/lib/errorReporter.ts server/src/app.ts server/src/middlewares/errorHandler.ts server/src/main.ts src/main.tsx
git commit -m "feat(observability): add request logging and error reporting"
```

---

## Task 7: UI M2 Polish

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Modify: `src/components/EmailVerificationBanner.tsx`
- Modify: `src/components/ui/Tabs.tsx` if focus ring is missing
- Modify: `src/pages/AdminPage.tsx`
- Delete or restrict: `src/pages/_design-tokens.tsx`

- [ ] **Step 1: Start from master**

Run:

```bash
git fetch --all --prune
git switch -c fix/m2-ui-polish origin/master
```

- [ ] **Step 2: Decide and implement `/_dev/tokens` policy**

Recommended M2 policy: keep the page in source but expose it only in development.

Modify `src/App.tsx`:

```tsx
{import.meta.env.DEV && <Route path="/_dev/tokens" element={<DesignTokensPage />} />}
```

Expected: production build still includes source module only if Vite cannot tree-shake the static import. If bundle hygiene matters, replace static import with lazy import in a later UI task.

- [ ] **Step 3: Add warning tokens**

Modify `src/index.css` under `:root`:

```css
--color-warning: #D97706;
--color-warning-bg: #FFFBEB;
--color-warning-border: #FCD34D;
```

Modify `.dark`:

```css
--color-warning: #FBBF24;
--color-warning-bg: rgba(146, 64, 14, 0.18);
--color-warning-border: rgba(251, 191, 36, 0.35);
```

- [ ] **Step 4: Update EmailVerificationBanner**

Modify `src/components/EmailVerificationBanner.tsx` classes:

```tsx
<div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-warning-bg)] border border-[var(--color-warning-border)] text-[var(--color-text)] fade-in">
```

Icon:

```tsx
<MailWarning className="w-5 h-5 shrink-0 text-[var(--color-warning)]" />
```

Button:

```tsx
className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--color-warning)] hover:opacity-90 text-white disabled:opacity-60 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
```

Close button:

```tsx
className="p-1 rounded hover:bg-[var(--color-warning)]/10 transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
```

- [ ] **Step 5: Ensure Tabs focus is visible**

Inspect `src/components/ui/Tabs.tsx`. If `TabsTrigger` lacks focus styling, add:

```tsx
focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]
```

to the trigger class list.

- [ ] **Step 6: Admin table mobile polish**

In `src/pages/AdminPage.tsx`, ensure every table wrapper has:

```tsx
<div className="overflow-x-auto max-w-full">
```

and table has:

```tsx
className="admin-table min-w-[720px]"
```

For dense tables with many action columns, use `min-w-[920px]`.

- [ ] **Step 7: Search for old UI tokens**

Run:

```bash
rg -- '--c-|apple-card|input-field|bg-amber|text-amber|border-amber' src
```

Expected: no matches except intentional historical comments. Replace any runtime class matches with design-system tokens.

- [ ] **Step 8: Build frontend**

Run:

```bash
npm run build
```

Expected: frontend build passes.

- [ ] **Step 9: Manual browser checks**

Start preview:

```bash
npm run preview -- --host 127.0.0.1
```

Check:

- `/login` at 375px, 768px, 1440px.
- `/` after login at 375px, 768px, 1440px.
- `/profile` at 375px, 768px, 1440px.
- `/admin` at 375px, 768px, 1440px.
- Dark mode navigation, cards, modal, toast, banner.

- [ ] **Step 10: Commit**

Run:

```bash
git add src/App.tsx src/index.css src/components/EmailVerificationBanner.tsx src/components/ui/Tabs.tsx src/pages/AdminPage.tsx
git commit -m "fix(ui): polish m2 focus contrast and dev routes"
```

If `src/components/ui/Tabs.tsx` or `src/pages/AdminPage.tsx` did not require edits, omit them from `git add`.

---

## Task 8: OpenAPI and Module README Cleanup

**Files:**
- Modify: `docs/superpowers/specs/monexus-api-openapi.json`
- Create: `server/src/modules/auth/README.md`
- Create: `server/src/modules/admin/README.md`
- Create: `server/src/modules/orders/README.md`
- Create: `server/src/modules/merchant/README.md`

- [ ] **Step 1: Start from master**

Run:

```bash
git fetch --all --prune
git switch -c docs/m2-contract-readmes origin/master
```

- [ ] **Step 2: Add auth module README**

Create `server/src/modules/auth/README.md`:

```md
# Auth Module

## Responsibilities

- Register users.
- Log users in.
- Rotate HttpOnly refresh tokens.
- Return `/me` profile data.
- Send password-reset and email-verification mail.
- Change password for logged-in users.

## Invariants

- Refresh tokens are stored as SHA-256 hashes only.
- Password reset and password change revoke outstanding refresh tokens.
- Public email endpoints must not reveal whether an account exists.
- Banned users cannot log in or refresh.

## Key Files

- `schema.ts`: Zod request schemas.
- `routes.ts`: route declarations and auth/mail rate limits.
- `controller.ts`: HTTP and cookie handling.
- `service.ts`: token, password, mail, and profile logic.
```

- [ ] **Step 3: Add admin module README**

Create `server/src/modules/admin/README.md`:

```md
# Admin Module

## Responsibilities

- Platform stats.
- User listing and point adjustment.
- User ban and unban.
- Platform-owned product and inventory management.
- Full order visibility.
- Merchant review, suspension, and commission updates.
- Settlement listing and batch settlement.
- System configuration.

## Invariants

- All admin writes create `AdminLog`.
- Batch settlement is all-or-nothing.
- Merchant approval and suspension revoke target-user refresh tokens.
- User ban revokes target-user refresh tokens.
```

- [ ] **Step 4: Add orders module README**

Create `server/src/modules/orders/README.md`:

```md
# Orders Module

## Responsibilities

- Create instant-delivery orders.
- Deduct user points.
- Reserve one available inventory item.
- Create delivery record.
- Create point log.
- Create merchant settlement for merchant-owned products.

## Invariants

- Order creation is a single database transaction.
- Inventory reservation uses `updateMany` with `status = 'available'` and validates `count === 1`.
- Delivery content is only visible to the buyer, owning merchant, or admin.
- Merchant settlement snapshots commission at order time.
```

- [ ] **Step 5: Add merchant module README**

Create `server/src/modules/merchant/README.md`:

```md
# Merchant Module

## Responsibilities

- Merchant onboarding application.
- Merchant profile.
- Merchant-owned products.
- Merchant-owned inventory import.
- Merchant-owned orders.
- Merchant-owned settlements.
- Merchant stats.

## Invariants

- All resource access is scoped by the authenticated user's merchant id.
- Regular users may apply for merchant onboarding.
- Only active merchants may access merchant workspace routes.
- Merchant order responses include `settlementAmount`.
```

- [ ] **Step 6: Sync OpenAPI**

Update `docs/superpowers/specs/monexus-api-openapi.json` to include any M2 endpoints implemented in previous tasks:

- `POST /api/auth/password-change`
- `PUT /api/admin/users/{id}/ban`
- `PUT /api/admin/users/{id}/unban`
- `GET /api/admin/config`
- `PUT /api/admin/config/{key}`
- `GET /api/health` response with `db`

For each path, include request body, response shape, auth requirement, and error envelope.

- [ ] **Step 7: Validate JSON**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('docs/superpowers/specs/monexus-api-openapi.json', 'utf8')); console.log('openapi json ok')"
```

Expected: prints `openapi json ok`.

- [ ] **Step 8: Commit**

Run:

```bash
git add docs/superpowers/specs/monexus-api-openapi.json server/src/modules/auth/README.md server/src/modules/admin/README.md server/src/modules/orders/README.md server/src/modules/merchant/README.md
git commit -m "docs(m2): sync contract and module readmes"
```

---

## Final Verification Before M2 Release Candidate

Run from the release candidate branch after merging the selected M2 task branches:

```bash
npm run build
npm --prefix server run build
npm --prefix server test
```

Start local stack:

```bash
bash scripts/dev-up.sh --seed
curl -fsS http://localhost:3000/api/health
```

Expected health response includes:

```json
{ "status": "ok", "db": "ok" }
```

Manual smoke checklist:

- Register a user.
- Verify `/api/auth/me`.
- Send verification email in console mailer mode.
- Reset password with captured console link.
- Change password from profile and confirm forced re-login.
- Sign in as admin.
- Ban a user and confirm login is rejected.
- Change `checkinReward` in Admin config.
- Sign in as normal user and check in; reward matches config.
- Create merchant application.
- Approve merchant.
- Sign in as merchant.
- Create product, upload image, import inventory.
- Redeem merchant product as user.
- Confirm merchant sees order and `settlementAmount`.
- Batch settle as admin.
- Run backup script against local database.

---

## Self-Review

- Spec coverage: covers all M2 P0 items from `2026-05-12-monexus-production-ga-prd.md`: test repair, health, backup/runbook, password change, ban/unban, SystemConfig, observability, UI polish, and contract/docs cleanup.
- Red-flag scan: no unresolved future-work markers from the no-placeholder list.
- Type consistency: uses current repository names: `RefreshToken`, `AdminLog`, `SystemConfig`, `PointLog`, `Merchant`, `Settlement`, `AuthUser`, `AdminTab`.
- Branch consistency: implementation branches start from `origin/master`, not the current documentation branch.
