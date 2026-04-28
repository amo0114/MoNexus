# PostgreSQL Auth Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert MoNexus to PostgreSQL-backed production-ready auth and API infrastructure while keeping frontend and backend development isolated and contract-driven.

**Architecture:** Backend owns PostgreSQL, Prisma migrations, configuration validation, request validation, error envelopes, security middleware, refresh-token cookies, and auth endpoints. Frontend owns Axios credential behavior and auth state changes only, consuming the backend contract without touching backend files. Final integration validates login, refresh, protected API access, and logout across Vite and Express.

**Tech Stack:** Node.js, TypeScript, Express 4, Prisma 6, PostgreSQL 16, Zod, JWT, HttpOnly Cookie, React 18, Vite 6, Zustand, Axios.

---

## Mandatory Workflow Rules

- [ ] Mark each checkbox as complete immediately after finishing that step.
- [ ] Backend tasks may modify only `server/**`, `docker-compose.yml`, and backend-specific docs or env examples explicitly listed in that task.
- [ ] Frontend tasks may modify only `src/**`, root frontend config files explicitly listed in that task, and frontend package files if needed.
- [ ] Do not let frontend workers edit `server/**`.
- [ ] Do not let backend workers edit `src/**`.
- [ ] Keep the shared API contract below unchanged unless both frontend and backend tasks are updated together.
- [ ] Run the verification command listed in each task before marking the task complete.

## Shared Contract

### Auth Endpoints

- `POST /api/auth/register`
  - Request body: `{ "email": string, "password": string, "inviteCode"?: string }`
  - Success: `201` with `{ "user": User, "accessToken": string }`
  - Side effect: sets `refreshToken` HttpOnly Cookie.

- `POST /api/auth/login`
  - Request body: `{ "email": string, "password": string }`
  - Success: `200` with `{ "user": User, "accessToken": string }`
  - Side effect: sets `refreshToken` HttpOnly Cookie.

- `POST /api/auth/refresh`
  - Request body: empty.
  - Reads refresh token only from Cookie.
  - Success: `200` with `{ "accessToken": string }`
  - Side effect: rotates `refreshToken` HttpOnly Cookie.

- `POST /api/auth/logout`
  - Request body: empty.
  - Reads refresh token from Cookie if present.
  - Success: `200` with `{ "ok": true }`
  - Side effect: revokes current refresh token and clears Cookie.

- `GET /api/auth/me`
  - Requires `Authorization: Bearer <accessToken>`.
  - Success: `200` with `User`.

### User Shape

```ts
interface User {
  id: number
  email: string
  role: string
  inviteCode: string
  points: number
}
```

### Error Envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "参数校验失败",
    "details": [
      { "field": "params.id", "message": "必须是正整数" }
    ]
  }
}
```

Allowed error codes:

```ts
type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'INTERNAL_SERVER_ERROR'
  | 'RATE_LIMITED'
```

### Refresh Cookie

- Name: `refreshToken`
- `httpOnly: true`
- `sameSite: 'lax'` for local development
- `secure: false` for local development, `true` in production
- `path: '/api/auth'`
- `maxAge: 7 days`

## File Responsibility Map

### Backend Files

- `server/package.json`: backend scripts and dependencies.
- `server/package-lock.json`: backend dependency lockfile.
- `server/.env.example`: documented backend environment variables.
- `server/prisma/schema.prisma`: PostgreSQL datasource and data model.
- `server/prisma/migrations/**`: Prisma migration history.
- `server/src/config/index.ts`: environment loading and required configuration validation.
- `server/src/lib/prisma.ts`: single PrismaClient export for all backend modules.
- `server/src/lib/httpError.ts`: typed HTTP error and error response helpers.
- `server/src/lib/cookies.ts`: refresh-token Cookie set/clear options.
- `server/src/middlewares/validate.ts`: body/params/query validation middleware.
- `server/src/middlewares/errorHandler.ts`: safe error envelope response.
- `server/src/middlewares/auth.ts`: Bearer access-token authentication and admin guard.
- `server/src/app.ts`: CORS, Helmet, rate limits, JSON limit, cookie parser, routes.
- `server/src/modules/auth/schema.ts`: auth body schemas.
- `server/src/modules/auth/routes.ts`: auth route declarations.
- `server/src/modules/auth/controller.ts`: auth HTTP handlers and Cookie side effects.
- `server/src/modules/auth/service.ts`: auth business logic and refresh-token storage/rotation.
- `server/src/modules/products/**`, `server/src/modules/admin/**`, `server/src/modules/orders/**`, `server/src/modules/points/**`: schema-driven param/query validation and safe errors.
- `server/src/prisma/seed.ts`: PostgreSQL-safe seed using shared Prisma client.

### Frontend Files

- `src/api/client.ts`: Axios credentials, access-token header, refresh flow without body token.
- `src/stores/authStore.ts`: remove refresh token from state and persistence.
- `src/pages/LoginPage.tsx`: consume login/register response without refresh token.
- `src/components/Layout.tsx`: logout flow if logout is triggered there.
- Other `src/**` files only if they currently call `setTokens`, `login`, or `logout` with refresh token.

### Integration Files

- `docker-compose.yml`: local PostgreSQL service only.
- `docs/superpowers/specs/2026-04-27-postgresql-auth-security-design.md`: approved design reference.
- `docs/superpowers/plans/2026-04-27-postgresql-auth-security.md`: this plan.

---

## Phase 1: Shared Contract Lock

### Task 1: Confirm shared backend/frontend contract before code changes

**Owner:** Tech Lead / Integrator

**Files:**
- Reference: `docs/superpowers/specs/2026-04-27-postgresql-auth-security-design.md`
- Modify: `docs/superpowers/plans/2026-04-27-postgresql-auth-security.md`

- [ ] **Step 1: Read the shared contract in this plan**

Confirm these four auth behaviors are the source of truth:

```text
login/register return { user, accessToken } and set HttpOnly refreshToken Cookie
refresh takes empty body and returns { accessToken }
logout clears refreshToken Cookie and returns { ok: true }
frontend never reads or stores refreshToken
```

Expected: no disagreement between implementation workers.

- [ ] **Step 2: Mark the contract as accepted**

Edit this task checkbox only after both frontend and backend workers acknowledge the contract.

Expected: this task's checkboxes are checked before Phase 2 starts.

- [ ] **Step 3: Commit contract documents if this repository is initialized as git**

Run:

```bash
git status --short
```

If git is available and docs are uncommitted, run:

```bash
git add docs/superpowers/specs/2026-04-27-postgresql-auth-security-design.md docs/superpowers/plans/2026-04-27-postgresql-auth-security.md
git commit -m "docs: define postgres auth security plan"
```

Expected: commit succeeds, or if this directory is not a git repository, record `Not a git repository; commit skipped` in the implementation notes.

---

## Phase 2: Backend Foundation

### Task 2: Add backend dependencies and scripts

**Owner:** Backend only

**Files:**
- Modify: `server/package.json`
- Modify: `server/package-lock.json`

- [x] **Step 1: Install backend runtime dependencies**

Run:

```bash
npm install --prefix server cookie-parser dotenv express-rate-limit helmet
```

Expected: `server/package.json` dependencies include `cookie-parser`, `dotenv`, `express-rate-limit`, and `helmet`.

- [x] **Step 2: Install backend type dependencies**

Run:

```bash
npm install --prefix server -D @types/cookie-parser
```

Expected: `server/package.json` devDependencies include `@types/cookie-parser`.

- [x] **Step 3: Replace backend scripts**

Update `server/package.json` scripts to this exact shape:

```json
{
  "dev": "tsx watch src/main.ts",
  "build": "tsc",
  "start": "node dist/main.js",
  "db:generate": "prisma generate",
  "db:migrate": "prisma migrate dev",
  "db:migrate:deploy": "prisma migrate deploy",
  "db:seed": "tsx src/prisma/seed.ts",
  "db:studio": "prisma studio"
}
```

Expected: `db:push` is no longer the primary database workflow.

- [x] **Step 4: Verify backend dependency install**

Run:

```bash
npm --prefix server run build
```

Expected at this step: build may fail because imports are not added yet, but dependency installation itself must complete. If build fails only because later tasks are not implemented, record the error and continue.

- [x] **Step 5: Commit backend dependency changes**

Run:

```bash
git add server/package.json server/package-lock.json
git commit -m "chore(server): add security and cookie dependencies"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 3: Add required environment configuration

**Owner:** Backend only

**Files:**
- Create: `server/.env.example`
- Modify: `server/src/config/index.ts`

- [x] **Step 1: Create backend environment example**

Create `server/.env.example` with:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://monexus:monexus_dev_2026@localhost:5432/monexus?schema=public
JWT_SECRET=replace-with-at-least-32-random-characters
FRONTEND_ORIGIN=http://localhost:5173
COOKIE_SECURE=false
```

Expected: no real production secret is committed.

- [x] **Step 2: Replace config implementation**

Replace `server/src/config/index.ts` with:

```ts
import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().refine(value => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
    message: 'DATABASE_URL must be a PostgreSQL connection string',
  }),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  FRONTEND_ORIGIN: z.string().url(),
  COOKIE_SECURE: z.coerce.boolean().default(false),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('[Config] Invalid environment variables')
  for (const issue of parsed.error.issues) {
    console.error(`[Config] ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

const env = parsed.data

if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
  console.error('[Config] COOKIE_SECURE must be true in production')
  process.exit(1)
}

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  frontendOrigin: env.FRONTEND_ORIGIN,
  cookieSecure: env.COOKIE_SECURE,
  jwtExpiresIn: '15m',
  refreshTokenMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  checkinReward: 50,
  registerReward: 500,
  inviteReward: 200,
}
```

Expected: config no longer has fallback JWT secrets.

- [x] **Step 3: Verify missing env fails safely**

Temporarily run with an empty environment:

```bash
cd server && env -i PATH="$PATH" npm run build
```

Expected: TypeScript build should not execute config and should compile. Runtime env validation is verified after app startup tasks.

- [x] **Step 4: Verify backend typecheck**

Run:

```bash
npm --prefix server run build
```

Expected: PASS after current task if later imports are not broken.

- [x] **Step 5: Commit configuration changes**

Run:

```bash
git add server/.env.example server/src/config/index.ts
git commit -m "feat(server): validate required environment"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 4: Create shared Prisma client module

**Owner:** Backend only

**Files:**
- Create: `server/src/lib/prisma.ts`
- Modify: `server/src/modules/auth/service.ts`
- Modify: `server/src/modules/points/service.ts`
- Modify: `server/src/modules/orders/service.ts`
- Modify: `server/src/modules/products/service.ts`
- Modify: `server/src/modules/admin/service.ts`
- Modify: `server/src/prisma/seed.ts`
- Modify: `server/src/middlewares/auth.ts`

- [x] **Step 1: Create Prisma client module**

Create `server/src/lib/prisma.ts`:

```ts
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
```

Expected: all modules can import Prisma from infrastructure, not auth service.

- [x] **Step 2: Update auth service import**

In `server/src/modules/auth/service.ts`, remove:

```ts
import { PrismaClient } from '@prisma/client'
```

Remove:

```ts
export const prisma = new PrismaClient()
```

Add:

```ts
import { prisma } from '../../lib/prisma.js'
```

Expected: auth service still uses `prisma` variable.

- [x] **Step 3: Update all service imports**

For every backend file importing Prisma from auth service:

```ts
import { prisma } from '../auth/service.js'
```

or:

```ts
import { prisma } from './auth/service.js'
```

replace it with the correct relative path to:

```ts
import { prisma } from '../../lib/prisma.js'
```

For `server/src/prisma/seed.ts`, use:

```ts
import { prisma } from '../lib/prisma.js'
```

Expected: only `server/src/lib/prisma.ts` creates `new PrismaClient()`.

- [x] **Step 4: Remove unused Prisma import from auth middleware**

In `server/src/middlewares/auth.ts`, delete this line:

```ts
import { prisma } from '../modules/auth/service.js'
```

Expected: auth middleware has no unused imports.

- [x] **Step 5: Verify single Prisma client construction**

Run:

```bash
grep -R "new PrismaClient" -n server/src
```

Expected output:

```text
server/src/lib/prisma.ts:3:export const prisma = new PrismaClient()
```

- [x] **Step 6: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 7: Commit Prisma module extraction**

Run:

```bash
git add server/src/lib/prisma.ts server/src/modules server/src/prisma/seed.ts server/src/middlewares/auth.ts
git commit -m "refactor(server): centralize prisma client"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

---

## Phase 3: PostgreSQL Migration

### Task 5: Switch Prisma datasource to PostgreSQL

**Owner:** Backend only

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/**`

- [x] **Step 1: Update Prisma datasource provider**

Change `server/prisma/schema.prisma` datasource to:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Expected: Prisma uses PostgreSQL.

- [x] **Step 2: Ensure local PostgreSQL is running**

Run:

```bash
docker compose up -d postgres
```

Expected: PostgreSQL container `monexus-db` is running.

- [x] **Step 3: Create local backend `.env` if missing**

If `server/.env` does not exist, create it from example and replace secrets:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://monexus:monexus_dev_2026@localhost:5432/monexus?schema=public
JWT_SECRET=local-development-secret-must-be-at-least-32-chars
FRONTEND_ORIGIN=http://localhost:5173
COOKIE_SECURE=false
```

Expected: `server/.env` exists locally and is not committed.

- [x] **Step 4: Generate Prisma migration**

Run:

```bash
cd server && npx prisma migrate dev --name init_postgresql
```

Expected: a new directory appears under `server/prisma/migrations/`, and Prisma Client is generated.

- [x] **Step 5: Verify migration status**

Run:

```bash
cd server && npx prisma migrate status
```

Expected: database schema is up to date.

- [x] **Step 6: Run seed against PostgreSQL**

Run:

```bash
npm --prefix server run db:seed
```

Expected: seed completes and logs seeded admin/test user information.

- [x] **Step 7: Commit PostgreSQL migration**

Run:

```bash
git add server/prisma/schema.prisma server/prisma/migrations
git commit -m "feat(server): migrate prisma to postgresql"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

---

## Phase 4: Backend Error and Validation Contract

### Task 6: Add typed HTTP errors

**Owner:** Backend only

**Files:**
- Create: `server/src/lib/httpError.ts`

- [x] **Step 1: Create HTTP error helper**

Create `server/src/lib/httpError.ts`:

```ts
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'INTERNAL_SERVER_ERROR'
  | 'RATE_LIMITED'

export interface ErrorDetail {
  field: string
  message: string
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: ErrorDetail[]
  ) {
    super(message)
  }
}

export function badRequest(message: string, details?: ErrorDetail[]) {
  return new HttpError(400, 'BAD_REQUEST', message, details)
}

export function unauthenticated(message = '未登录') {
  return new HttpError(401, 'UNAUTHENTICATED', message)
}

export function forbidden(message = '需要管理员权限') {
  return new HttpError(403, 'FORBIDDEN', message)
}

export function notFound(message = '资源不存在') {
  return new HttpError(404, 'NOT_FOUND', message)
}

export function conflict(message: string) {
  return new HttpError(409, 'CONFLICT', message)
}
```

Expected: business code can throw safe HTTP errors.

- [x] **Step 2: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 3: Commit HTTP error helper**

Run:

```bash
git add server/src/lib/httpError.ts
git commit -m "feat(server): add typed http errors"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 7: Replace global error handler with safe envelope

**Owner:** Backend only

**Files:**
- Modify: `server/src/middlewares/errorHandler.ts`

- [x] **Step 1: Replace error handler implementation**

Replace `server/src/middlewares/errorHandler.ts` with:

```ts
import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { HttpError } from '../lib/httpError.js'

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    })
    return
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: err.errors.map(issue => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
    })
    return
  }

  console.error('[Error]', err)
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误',
    },
  })
}
```

Expected: raw `err.message` is no longer returned for unknown errors.

- [x] **Step 2: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 3: Commit safe error handler**

Run:

```bash
git add server/src/middlewares/errorHandler.ts
git commit -m "feat(server): return safe error envelopes"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 8: Upgrade validation middleware for body params query

**Owner:** Backend only

**Files:**
- Modify: `server/src/middlewares/validate.ts`

- [x] **Step 1: Replace validation middleware**

Replace `server/src/middlewares/validate.ts` with:

```ts
import { Request, Response, NextFunction } from 'express'
import { z, ZodError, ZodSchema } from 'zod'
import { HttpError } from '../lib/httpError.js'

type RequestSchemas = {
  body?: ZodSchema
  params?: ZodSchema
  query?: ZodSchema
}

function formatZodError(scope: string, err: ZodError) {
  return err.errors.map(issue => ({
    field: [scope, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }))
}

export function validate(schema: ZodSchema): ReturnType<typeof validateRequest>
export function validate(schemas: RequestSchemas): ReturnType<typeof validateRequest>
export function validate(schemaOrSchemas: ZodSchema | RequestSchemas) {
  if ('safeParse' in schemaOrSchemas) {
    return validateRequest({ body: schemaOrSchemas })
  }
  return validateRequest(schemaOrSchemas)
}

function validateRequest(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const details = []

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body)
      if (result.success) req.body = result.data
      else details.push(...formatZodError('body', result.error))
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params)
      if (result.success) req.params = result.data
      else details.push(...formatZodError('params', result.error))
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query)
      if (result.success) req.query = result.data
      else details.push(...formatZodError('query', result.error))
    }

    if (details.length > 0) {
      next(new HttpError(400, 'VALIDATION_ERROR', '参数校验失败', details))
      return
    }

    next()
  }
}

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive('必须是正整数'),
})
```

Expected: old `validate(schema)` calls still work for body validation.

- [x] **Step 2: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 3: Commit validation middleware**

Run:

```bash
git add server/src/middlewares/validate.ts
git commit -m "feat(server): validate body params and query"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 9: Apply params and query validation to product routes

**Owner:** Backend only

**Files:**
- Modify: `server/src/modules/products/routes.ts`
- Modify: `server/src/modules/products/controller.ts`
- Modify: `server/src/modules/products/service.ts` only if service currently throws raw missing-resource errors.

- [x] **Step 1: Update product routes**

Modify `server/src/modules/products/routes.ts` so `/:id` routes use `idParamSchema`:

```ts
import { Router } from 'express'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import * as controller from './controller.js'

const router = Router()

router.get('/', controller.list)
router.get('/:id', validate({ params: idParamSchema }), controller.detail)

export { router as productRoutes }
```

Expected: product detail receives numeric `req.params.id`.

- [x] **Step 2: Update product controller id parsing**

In `server/src/modules/products/controller.ts`, replace product detail id parsing with:

```ts
const id = req.params.id as unknown as number
```

Expected: no `parseInt(req.params.id)` remains in products controller.

- [x] **Step 3: Replace not-found throw if present**

If `server/src/modules/products/service.ts` throws `new Error('商品不存在')`, replace it with:

```ts
import { notFound } from '../../lib/httpError.js'
```

and:

```ts
throw notFound('商品不存在')
```

Expected: product not found returns safe 404 envelope.

- [x] **Step 4: Verify no product parseInt remains**

Run:

```bash
grep -R "parseInt(req.params" -n server/src/modules/products || true
```

Expected: no output.

- [x] **Step 5: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 6: Commit product validation changes**

Run:

```bash
git add server/src/modules/products
git commit -m "feat(server): validate product route params"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 10: Apply params and query validation to admin routes

**Owner:** Backend only

**Files:**
- Modify: `server/src/modules/admin/schema.ts`
- Modify: `server/src/modules/admin/routes.ts`
- Modify: `server/src/modules/admin/controller.ts`
- Modify: `server/src/modules/admin/service.ts` only for safe HTTP errors.

- [x] **Step 1: Add admin query schema**

Append to `server/src/modules/admin/schema.ts`:

```ts
export const listUsersQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
})
```

Expected: admin user search query is typed.

- [x] **Step 2: Update admin route validation**

Update `server/src/modules/admin/routes.ts` imports:

```ts
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { adjustPointsSchema, createProductSchema, updateProductSchema, importInventorySchema, listUsersQuerySchema } from './schema.js'
```

For user listing route, use:

```ts
router.get('/users', validate({ query: listUsersQuerySchema }), controller.users)
```

For routes containing `:id`, use `validate({ params: idParamSchema })` or both params and body:

```ts
router.post('/users/:id/points', validate({ params: idParamSchema, body: adjustPointsSchema }), controller.adjustPoints)
router.patch('/products/:id', validate({ params: idParamSchema, body: updateProductSchema }), controller.updateProduct)
router.post('/products/:id/inventory', validate({ params: idParamSchema, body: importInventorySchema }), controller.importInventory)
```

Expected: admin routes do not rely on controller parsing for ids.

- [x] **Step 3: Update admin controller ids**

In `server/src/modules/admin/controller.ts`, replace every:

```ts
parseInt(req.params.id)
```

with:

```ts
req.params.id as unknown as number
```

Expected: no `parseInt(req.params.id)` remains in admin controller.

- [x] **Step 4: Replace raw conflict/not found errors if present**

In `server/src/modules/admin/service.ts`, use these imports when matching messages exist:

```ts
import { conflict, notFound, badRequest } from '../../lib/httpError.js'
```

Replace duplicate or invalid business cases with:

```ts
throw conflict('商品名称已存在')
throw notFound('用户不存在')
throw badRequest('库存数据无效')
```

Expected: known admin business errors return typed envelopes.

- [x] **Step 5: Verify no admin parseInt remains**

Run:

```bash
grep -R "parseInt(req.params" -n server/src/modules/admin || true
```

Expected: no output.

- [x] **Step 6: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 7: Commit admin validation changes**

Run:

```bash
git add server/src/modules/admin
git commit -m "feat(server): validate admin params and query"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 11: Apply params and query validation to orders and points routes

**Owner:** Backend only

**Files:**
- Modify: `server/src/modules/orders/schema.ts`
- Modify: `server/src/modules/orders/routes.ts`
- Modify: `server/src/modules/orders/controller.ts`
- Modify: `server/src/modules/orders/service.ts` only for safe HTTP errors.
- Modify: `server/src/modules/points/routes.ts`
- Modify: `server/src/modules/points/controller.ts`

- [x] **Step 1: Add order query schema**

Append to `server/src/modules/orders/schema.ts`:

```ts
export const listOrdersQuerySchema = z.object({
  status: z.string().trim().min(1).optional(),
})
```

Expected: order list query is typed if status filtering exists.

- [x] **Step 2: Update order route validation**

In `server/src/modules/orders/routes.ts`, import:

```ts
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { createOrderSchema, listOrdersQuerySchema } from './schema.js'
```

Use:

```ts
router.get('/', authenticate, validate({ query: listOrdersQuerySchema }), controller.list)
router.post('/', authenticate, validate(createOrderSchema), controller.create)
router.get('/:id', authenticate, validate({ params: idParamSchema }), controller.detail)
```

Expected: order id params are validated before controller.

- [x] **Step 3: Update order controller ids**

In `server/src/modules/orders/controller.ts`, replace `parseInt(req.params.id)` with:

```ts
req.params.id as unknown as number
```

Expected: no `parseInt(req.params.id)` remains in orders controller.

- [x] **Step 4: Update points route validation if params exist**

If `server/src/modules/points/routes.ts` has routes containing `:id`, import `validate` and `idParamSchema`, then apply:

```ts
validate({ params: idParamSchema })
```

Expected: points params are validated if points uses params.

- [x] **Step 5: Replace raw service errors with typed HTTP errors**

In `server/src/modules/orders/service.ts`, import when needed:

```ts
import { badRequest, notFound } from '../../lib/httpError.js'
```

Replace known business errors:

```ts
throw notFound('订单不存在')
throw notFound('商品不存在')
throw badRequest('积分不足')
throw badRequest('库存不足')
```

Expected: expected order business failures return typed envelopes.

- [x] **Step 6: Verify no route param parseInt remains in modules**

Run:

```bash
grep -R "parseInt(req.params" -n server/src/modules || true
```

Expected: no output.

- [x] **Step 7: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 8: Commit order and points validation changes**

Run:

```bash
git add server/src/modules/orders server/src/modules/points
git commit -m "feat(server): validate order and point requests"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

---

## Phase 5: Backend Security Middleware

### Task 12: Add CORS credentials, Helmet, rate limits, JSON limit, and cookie parser

**Owner:** Backend only

**Files:**
- Modify: `server/src/app.ts`

- [x] **Step 1: Replace app middleware setup**

Update `server/src/app.ts` imports:

```ts
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import { config } from './config/index.js'
import { errorHandler } from './middlewares/errorHandler.js'
import { authRoutes } from './modules/auth/routes.js'
import { productRoutes } from './modules/products/routes.js'
import { pointRoutes } from './modules/points/routes.js'
import { orderRoutes } from './modules/orders/routes.js'
import { adminRoutes } from './modules/admin/routes.js'
```

Replace middleware before routes with:

```ts
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
```

Expected: all `/api` routes have security middleware and CORS credentials.

- [x] **Step 2: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 3: Commit app security middleware**

Run:

```bash
git add server/src/app.ts
git commit -m "feat(server): add api security middleware"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 13: Add auth-specific rate limiter

**Owner:** Backend only

**Files:**
- Modify: `server/src/modules/auth/routes.ts`

- [x] **Step 1: Add auth limiter to auth routes**

Update `server/src/modules/auth/routes.ts`:

```ts
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { validate } from '../../middlewares/validate.js'
import { authenticate } from '../../middlewares/auth.js'
import { registerSchema, loginSchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: '认证请求过于频繁，请稍后再试',
    },
  },
})

router.post('/register', authLimiter, validate(registerSchema), controller.register)
router.post('/login', authLimiter, validate(loginSchema), controller.login)
router.post('/refresh', authLimiter, controller.refresh)
router.post('/logout', controller.logout)
router.get('/me', authenticate, controller.me)

export { router as authRoutes }
```

Expected: refresh no longer validates request body; logout route exists.

- [x] **Step 2: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected at this step: may fail because `controller.logout` is not implemented until Task 15. If the only error is missing `logout`, continue.

- [x] **Step 3: Commit auth routes**

Run:

```bash
git add server/src/modules/auth/routes.ts
git commit -m "feat(server): add auth rate limits and logout route"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

---

## Phase 6: Backend Refresh Token Cookie Flow

### Task 14: Add refresh-token Cookie helpers

**Owner:** Backend only

**Files:**
- Create: `server/src/lib/cookies.ts`

- [x] **Step 1: Create cookie helper**

Create `server/src/lib/cookies.ts`:

```ts
import { Response } from 'express'
import { config } from '../config/index.js'

export const refreshTokenCookieName = 'refreshToken'

const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'lax' as const,
  path: '/api/auth',
  maxAge: config.refreshTokenMaxAgeMs,
}

export function setRefreshTokenCookie(res: Response, refreshToken: string) {
  res.cookie(refreshTokenCookieName, refreshToken, refreshTokenCookieOptions)
}

export function clearRefreshTokenCookie(res: Response) {
  res.clearCookie(refreshTokenCookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/api/auth',
  })
}
```

Expected: controllers can set and clear refresh cookie consistently.

- [x] **Step 2: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS if Task 13 missing logout is already addressed later; otherwise same known missing logout error may remain.

- [x] **Step 3: Commit cookie helper**

Run:

```bash
git add server/src/lib/cookies.ts
git commit -m "feat(server): add refresh token cookie helpers"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 15: Refactor auth service for Cookie refresh rotation and logout

**Owner:** Backend only

**Files:**
- Modify: `server/src/modules/auth/schema.ts`
- Modify: `server/src/modules/auth/service.ts`

- [x] **Step 1: Remove refresh body schema export**

In `server/src/modules/auth/schema.ts`, remove:

```ts
export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})
```

Expected: refresh endpoint does not accept body token.

- [x] **Step 2: Add typed auth result helpers**

In `server/src/modules/auth/service.ts`, ensure imports include:

```ts
import { prisma } from '../../lib/prisma.js'
import { badRequest, unauthenticated, conflict } from '../../lib/httpError.js'
```

Use `conflict('该邮箱已注册')` instead of `new Error('该邮箱已注册')`.

Expected: known auth business errors use HTTP errors.

- [x] **Step 3: Ensure login/register return raw refresh token separately**

Update `registerUser` and `loginUser` return shape to include `refreshToken` for controller use, while controller will omit it from JSON:

```ts
return {
  user: {
    id: user.id,
    email: user.email,
    role: user.role,
    inviteCode: user.inviteCode,
    points: pointAccount.balance,
  },
  accessToken: generateAccessToken(user.id, user.role),
  refreshToken: rawRefreshToken,
}
```

Expected: service returns refresh token only to backend controller.

- [x] **Step 4: Replace refresh function signature**

Implement or replace refresh function with:

```ts
export async function refreshAccessToken(rawRefreshToken: string | undefined, ip?: string, userAgent?: string) {
  if (!rawRefreshToken) throw unauthenticated('Refresh Token 不存在')

  const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex')
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { include: { pointAccount: true } } },
  })

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw unauthenticated('Refresh Token 无效或已过期')
  }

  const nextRawRefreshToken = generateRefreshToken()
  const nextTokenHash = crypto.createHash('sha256').update(nextRawRefreshToken).digest('hex')

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        userId: stored.userId,
        tokenHash: nextTokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ip,
        userAgent,
      },
    }),
  ])

  return {
    accessToken: generateAccessToken(stored.user.id, stored.user.role),
    refreshToken: nextRawRefreshToken,
  }
}
```

Expected: refresh rotates tokens and returns new raw token for Cookie only.

- [x] **Step 5: Add logout service function**

Add to `server/src/modules/auth/service.ts`:

```ts
export async function logout(rawRefreshToken: string | undefined) {
  if (!rawRefreshToken) return

  const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex')
  await prisma.refreshToken.updateMany({
    where: {
      tokenHash,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  })
}
```

Expected: logout is idempotent.

- [x] **Step 6: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected at this step: may fail because controller still expects old refresh API. Continue to Task 16 if that is the only error.

- [x] **Step 7: Commit auth service refresh changes**

Run:

```bash
git add server/src/modules/auth/schema.ts server/src/modules/auth/service.ts
git commit -m "feat(server): rotate refresh tokens from cookies"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 16: Refactor auth controller for HttpOnly Cookie contract

**Owner:** Backend only

**Files:**
- Modify: `server/src/modules/auth/controller.ts`

- [x] **Step 1: Add cookie helper imports**

Add to `server/src/modules/auth/controller.ts`:

```ts
import { clearRefreshTokenCookie, refreshTokenCookieName, setRefreshTokenCookie } from '../../lib/cookies.js'
```

Expected: controller can manage refresh cookie.

- [x] **Step 2: Update register handler**

In `register`, after service call:

```ts
const result = await authService.registerUser(
  email, password, inviteCode,
  req.ip, req.headers['user-agent']
)
setRefreshTokenCookie(res, result.refreshToken)
res.status(201).json({ user: result.user, accessToken: result.accessToken })
```

Expected: response body excludes refreshToken.

- [x] **Step 3: Update login handler**

In `login`, after service call:

```ts
const result = await authService.loginUser(
  email, password,
  req.ip, req.headers['user-agent']
)
setRefreshTokenCookie(res, result.refreshToken)
res.json({ user: result.user, accessToken: result.accessToken })
```

Expected: response body excludes refreshToken.

- [x] **Step 4: Replace refresh handler**

Replace refresh handler body with:

```ts
export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.refreshAccessToken(
      req.cookies?.[refreshTokenCookieName],
      req.ip,
      req.headers['user-agent']
    )
    setRefreshTokenCookie(res, result.refreshToken)
    res.json({ accessToken: result.accessToken })
  } catch (err) {
    clearRefreshTokenCookie(res)
    next(err)
  }
}
```

Expected: refresh reads Cookie only and rotates Cookie.

- [x] **Step 5: Add logout handler**

Add:

```ts
export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.logout(req.cookies?.[refreshTokenCookieName])
    clearRefreshTokenCookie(res)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
}
```

Expected: `/api/auth/logout` is implemented.

- [x] **Step 6: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 7: Commit auth controller Cookie contract**

Run:

```bash
git add server/src/modules/auth/controller.ts
git commit -m "feat(server): issue refresh tokens as http only cookies"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 17: Update auth middleware to typed errors

**Owner:** Backend only

**Files:**
- Modify: `server/src/middlewares/auth.ts`

- [x] **Step 1: Replace direct 401/403 responses**

Replace `server/src/middlewares/auth.ts` with:

```ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import { forbidden, unauthenticated } from '../lib/httpError.js'

export interface AuthPayload {
  userId: number
  role: string
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    next(unauthenticated('未登录'))
    return
  }

  try {
    const token = header.slice(7)
    const payload = jwt.verify(token, config.jwtSecret) as AuthPayload
    req.user = payload
    next()
  } catch {
    next(unauthenticated('Token 已过期，请重新登录'))
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    next(forbidden('需要管理员权限'))
    return
  }
  next()
}
```

Expected: auth errors use global error envelope.

- [x] **Step 2: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 3: Commit auth middleware errors**

Run:

```bash
git add server/src/middlewares/auth.ts
git commit -m "feat(server): use typed auth errors"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

---

## Phase 7: Backend Verification

### Task 18: Verify backend runtime and API contract

**Owner:** Backend only

**Files:**
- No source modifications expected.

- [x] **Step 1: Start PostgreSQL**

Run:

```bash
docker compose up -d postgres
```

Expected: `monexus-db` is running.

- [x] **Step 2: Deploy migrations**

Run:

```bash
cd server && npx prisma migrate deploy
```

Expected: migrations applied successfully.

- [x] **Step 3: Seed database**

Run:

```bash
npm --prefix server run db:seed
```

Expected: seed completes.

- [x] **Step 4: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [x] **Step 5: Start backend**

Run:

```bash
npm --prefix server run dev
```

Expected: server logs `MoNexus API running at http://localhost:3000`.

- [x] **Step 6: Verify health endpoint**

In another terminal, run:

```bash
curl -i http://localhost:3000/api/health
```

Expected: `HTTP/1.1 200 OK` and JSON contains `"status":"ok"`.

- [x] **Step 7: Verify login sets Cookie and omits refresh token body**

Run:

```bash
curl -i -c /tmp/monexus-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@moyuan.net","password":"user123"}' \
  http://localhost:3000/api/auth/login
```

Expected:

```text
HTTP/1.1 200 OK
Set-Cookie: refreshToken=...
```

Response JSON contains `accessToken` and `user`, and does not contain `refreshToken`.

- [x] **Step 8: Verify refresh uses Cookie only**

Run:

```bash
curl -i -b /tmp/monexus-cookies.txt -c /tmp/monexus-cookies.txt \
  -X POST http://localhost:3000/api/auth/refresh
```

Expected: `HTTP/1.1 200 OK`, response JSON contains `accessToken`, and response updates `refreshToken` Cookie.

- [x] **Step 9: Verify logout clears Cookie**

Run:

```bash
curl -i -b /tmp/monexus-cookies.txt -c /tmp/monexus-cookies.txt \
  -X POST http://localhost:3000/api/auth/logout
```

Expected: `HTTP/1.1 200 OK`, response JSON is `{ "ok": true }`, and `Set-Cookie` clears `refreshToken`.

- [x] **Step 10: Verify validation envelope**

Run:

```bash
curl -i http://localhost:3000/api/products/not-a-number
```

Expected: `HTTP/1.1 400 Bad Request` and response JSON has `error.code` equal to `VALIDATION_ERROR`.

- [x] **Step 11: Commit backend verification notes if any docs were updated**

If no files changed, do not commit. If implementation notes were added, run:

```bash
git add <changed-doc-files>
git commit -m "docs(server): record backend verification"
```

Expected: no unnecessary commits.

---

## Phase 8: Frontend Auth Contract Update

### Task 19: Remove refresh token from frontend auth store

**Owner:** Frontend only

**Files:**
- Modify: `src/stores/authStore.ts`

- [ ] **Step 1: Update auth state interface**

In `src/stores/authStore.ts`, remove:

```ts
refreshToken: string | null
```

Change token methods to:

```ts
setAccessToken: (access: string) => void
login: (user: User, access: string) => void
logout: () => void
```

Expected: auth store no longer models refresh token.

- [ ] **Step 2: Update initial state and methods**

Replace store body with this shape:

```ts
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      isLoggedIn: false,

      setUser: (user) => set({ user }),
      setAccessToken: (access) => set({ accessToken: access }),

      login: (user, access) =>
        set({ user, accessToken: access, isLoggedIn: true }),

      logout: () =>
        set({ user: null, accessToken: null, isLoggedIn: false }),

      updatePoints: (points) =>
        set((state) => ({
          user: state.user ? { ...state.user, points } : null,
        })),
    }),
    {
      name: 'monexus-auth',
      partialize: (state) => ({ user: state.user, isLoggedIn: state.isLoggedIn }),
    }
  )
)
```

Expected: persisted storage excludes accessToken and refreshToken.

- [ ] **Step 3: Search for old token methods**

Run:

```bash
grep -R "refreshToken\|setTokens" -n src || true
```

Expected: output may show `src/api/client.ts` until Task 20, but `src/stores/authStore.ts` should no longer contain `refreshToken` or `setTokens`.

- [ ] **Step 4: Build frontend**

Run:

```bash
npm run build
```

Expected at this step: may fail because callers still use old methods. Continue to Task 20 if that is the only failure.

- [ ] **Step 5: Commit auth store change**

Run:

```bash
git add src/stores/authStore.ts
git commit -m "feat(frontend): remove refresh token from auth store"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 20: Update Axios refresh flow for Cookie credentials

**Owner:** Frontend only

**Files:**
- Modify: `src/api/client.ts`

- [ ] **Step 1: Enable credentials on Axios instance**

Update `src/api/client.ts` Axios instance:

```ts
const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  withCredentials: true,
})
```

Expected: browser sends refresh cookie to backend.

- [ ] **Step 2: Update refresh interceptor**

Replace the 401 refresh block with:

```ts
if (error.response?.status === 401 && !originalRequest._retry) {
  originalRequest._retry = true

  try {
    const { data } = await axios.post('/api/auth/refresh', undefined, { withCredentials: true })
    useAuthStore.getState().setAccessToken(data.accessToken)
    originalRequest.headers.Authorization = `Bearer ${data.accessToken}`
    return api(originalRequest)
  } catch {
    useAuthStore.getState().logout()
  }
}
```

Expected: refresh request sends empty body and uses Cookie.

- [ ] **Step 3: Verify no refresh token remains in client**

Run:

```bash
grep -R "refreshToken\|setTokens" -n src/api src/stores || true
```

Expected: no output.

- [ ] **Step 4: Build frontend**

Run:

```bash
npm run build
```

Expected at this step: may fail because login page still calls old store methods. Continue to Task 21 if that is the only failure.

- [ ] **Step 5: Commit Axios change**

Run:

```bash
git add src/api/client.ts
git commit -m "feat(frontend): refresh access tokens with cookie credentials"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 21: Update login/register consumers for new auth response

**Owner:** Frontend only

**Files:**
- Modify: `src/pages/LoginPage.tsx`
- Modify: other `src/**` files found by grep that call `login(user, access, refresh)` or `setTokens(access, refresh)`.

- [ ] **Step 1: Find old login and token call sites**

Run:

```bash
grep -R "login(.*refresh\|setTokens\|refreshToken" -n src || true
```

Expected: identify all frontend call sites that need updating.

- [ ] **Step 2: Update login success calls**

Where code currently does:

```ts
useAuthStore.getState().login(data.user, data.accessToken, data.refreshToken)
```

or equivalent, replace with:

```ts
useAuthStore.getState().login(data.user, data.accessToken)
```

If inside a component with store action:

```ts
login(data.user, data.accessToken)
```

Expected: no frontend code expects `data.refreshToken`.

- [ ] **Step 3: Update register success calls**

Where register success uses refresh token, use the same two-argument login call:

```ts
login(data.user, data.accessToken)
```

Expected: register consumes `{ user, accessToken }` only.

- [ ] **Step 4: Build frontend**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit login/register consumer changes**

Run:

```bash
git add src
git commit -m "feat(frontend): consume cookie based auth responses"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

### Task 22: Add frontend logout API call

**Owner:** Frontend only

**Files:**
- Modify: `src/components/Layout.tsx` or the file containing the logout button/action.
- Modify: `src/stores/authStore.ts` only if logout action signature must remain unchanged.

- [ ] **Step 1: Find logout call site**

Run:

```bash
grep -R "logout" -n src | head -20
```

Expected: identify the component that handles logout.

- [ ] **Step 2: Update logout action handler**

In the logout UI handler, call backend logout before clearing local state:

```ts
async function handleLogout() {
  try {
    await api.post('/auth/logout')
  } finally {
    useAuthStore.getState().logout()
    navigate('/login')
  }
}
```

If the file does not already import `api`, add:

```ts
import api from '../api/client'
```

Expected: logout clears backend Cookie and frontend state.

- [ ] **Step 3: Build frontend**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Verify no refresh token storage remains**

Run:

```bash
grep -R "refreshToken\|setTokens" -n src || true
```

Expected: no output.

- [ ] **Step 5: Commit logout integration**

Run:

```bash
git add src
git commit -m "feat(frontend): logout through backend auth endpoint"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

---

## Phase 9: Full Integration

### Task 23: Run backend and frontend together

**Owner:** Integrator

**Files:**
- No source modifications expected.

- [ ] **Step 1: Start PostgreSQL**

Run:

```bash
docker compose up -d postgres
```

Expected: PostgreSQL is healthy and listening on port 5432.

- [ ] **Step 2: Apply migrations**

Run:

```bash
cd server && npx prisma migrate deploy
```

Expected: migrations applied.

- [ ] **Step 3: Seed database**

Run:

```bash
npm --prefix server run db:seed
```

Expected: seed succeeds.

- [ ] **Step 4: Build backend**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [ ] **Step 5: Build frontend**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Start backend**

Run:

```bash
npm --prefix server run dev
```

Expected: backend running on `http://localhost:3000`.

- [ ] **Step 7: Start frontend**

Run in another terminal:

```bash
npm run dev
```

Expected: frontend running on `http://localhost:5173`.

- [ ] **Step 8: Verify browser login**

Open `http://localhost:5173/login`, log in with seeded user:

```text
Email: test@moyuan.net
Password: user123
```

Expected: login succeeds and navigates into the protected app.

- [ ] **Step 9: Verify Cookie security in browser**

In DevTools Application tab, inspect Cookies for `http://localhost:3000` or proxied origin.

Expected:

```text
refreshToken exists
HttpOnly is checked
JavaScript cannot read document.cookie value for refreshToken
localStorage monexus-auth does not contain refreshToken
```

- [ ] **Step 10: Verify API refresh behavior**

Manually expire or temporarily shorten access token during local testing, then trigger a protected API call.

Expected:

```text
/api/auth/refresh is called with credentials
request body is empty
response returns accessToken
original failed request is retried successfully
```

- [ ] **Step 11: Verify logout**

Click logout.

Expected:

```text
POST /api/auth/logout returns { ok: true }
refreshToken Cookie is cleared
frontend navigates to /login
protected API calls fail with 401 until login again
```

- [ ] **Step 12: Record integration result**

Add implementation note in the task tracker or PR description:

```text
Integration passed: PostgreSQL migration, login, refresh, protected API retry, logout, and token storage checks.
```

Expected: final reviewer can see exact completed checks.

---

## Phase 10: Final Quality Gates

### Task 24: Run security and quality checks

**Owner:** Integrator

**Files:**
- No source modifications expected unless checks reveal defects.

- [ ] **Step 1: Run backend build**

Run:

```bash
npm --prefix server run build
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Search for forbidden refresh-token storage**

Run:

```bash
grep -R "refreshToken" -n src || true
```

Expected: no frontend storage or request-body usage. Mentions in comments are not allowed unless they describe the backend Cookie contract in a doc.

- [ ] **Step 4: Search for raw backend errors**

Run:

```bash
grep -R "res.status(500).json({ error: err.message\|throw new Error" -n server/src || true
```

Expected: no raw error response patterns. Remaining `throw new Error` is allowed only for impossible internal programmer errors, not user-facing business cases.

- [ ] **Step 5: Search for unsafe param parsing**

Run:

```bash
grep -R "parseInt(req.params" -n server/src || true
```

Expected: no output.

- [ ] **Step 6: Search for SQLite datasource**

Run:

```bash
grep -R "provider = \"sqlite\"" -n server || true
```

Expected: no output.

- [ ] **Step 7: Final commit if fixes were required**

Run only if files changed during final checks:

```bash
git add server src package.json package-lock.json docker-compose.yml
git commit -m "fix: address postgres auth security verification"
```

Expected: commit succeeds, or if not in git, note that commit was skipped.

## Self-Review

- [ ] Spec coverage: PostgreSQL switch is covered by Tasks 2, 3, 5, 18, 23, 24.
- [ ] Spec coverage: `.env` required validation is covered by Task 3.
- [ ] Spec coverage: Prisma migration is covered by Task 5.
- [ ] Spec coverage: body/params/query validation is covered by Tasks 8, 9, 10, 11, 24.
- [ ] Spec coverage: safe error envelopes are covered by Tasks 6, 7, 17, 24.
- [ ] Spec coverage: security middleware is covered by Tasks 12 and 13.
- [ ] Spec coverage: Refresh Token HttpOnly Cookie storage is covered by Tasks 14, 15, 16, 19, 20, 21, 22, 23.
- [ ] Frontend/backend separation is explicitly stated in workflow rules and owner labels.
- [ ] Placeholder scan: no `TBD`, `TODO`, `implement later`, or unspecified validation remains.
- [ ] Type consistency: frontend `login(user, accessToken)`, backend `{ user, accessToken }`, refresh `{ accessToken }`, logout `{ ok: true }` are consistent.
