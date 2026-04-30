# MoNexus PostgreSQL/Auth Security 审查与本地开发手册

## 1. 结论概览

当前仓库不是“一个工作区里前后端都已合并完成”的状态，而是拆成了两个工作区分别推进：

- 前端改动在主工作区：`/mnt/e/workspacePulic/MoNexus-new`
- 后端改动在独立 worktree：`/mnt/e/workspacePulic/MoNexus-new/.worktrees/backend-postgres-auth`

这意味着：

- 主工作区里的 `docs/superpowers/plans/2026-04-27-postgresql-auth-security.md` 主要记录了前端与联调勾选状态。
- backend worktree 里的同名计划书主要记录了后端勾选状态。
- 两边的代码目前还没有合并到同一份工作树，所以“计划书全部完成”不等于“当前根目录已经是完整可交付态”。

## 2. 审查结果

### 2.1 后端 worktree 审查结果

后端 worktree 的 PostgreSQL + 鉴权安全改造基本已经落地，主要证据如下：

- 后端脚本、依赖、环境校验已补齐：`server/package.json`、`server/.env.example`、`server/src/config/index.ts`
- Prisma 已切到 PostgreSQL：`server/prisma/schema.prisma`
- 初始 migration 已存在：`server/prisma/migrations/20260427154800_init_postgresql/migration.sql`
- 共享 Prisma Client 已抽出：`server/src/lib/prisma.ts`
- 统一错误封装、Cookie 工具、校验中间件已落地：
  - `server/src/lib/httpError.ts`
  - `server/src/lib/cookies.ts`
  - `server/src/middlewares/errorHandler.ts`
  - `server/src/middlewares/validate.ts`
- 鉴权链路已改成 `HttpOnly Cookie + Access Token`：
  - `server/src/modules/auth/routes.ts`
  - `server/src/modules/auth/controller.ts`
  - `server/src/modules/auth/service.ts`
  - `server/src/middlewares/auth.ts`
- API 安全中间件已加上：
  - `helmet`
  - `cors(credentials: true)`
  - `cookie-parser`
  - 全局 rate limit
  - auth 专用 rate limit

本次核对结果：

- `npm run build` 在 `backend-postgres-auth/server` 下通过
- 用显式环境变量启动 `npm start` 后，`GET /api/health` 返回 `200 OK`

### 2.2 前端主工作区审查结果

前端主工作区已完成 Cookie 鉴权消费侧改造，主要证据如下：

- `src/stores/authStore.ts`
  - 状态中不再保存 `refreshToken`
  - `persist` 只保留 `user` 和 `isLoggedIn`
- `src/api/client.ts`
  - `axios` 已设置 `withCredentials: true`
  - 401 时会调用 `/api/auth/refresh`
- `src/pages/LoginPage.tsx`
  - 登录/注册后只消费 `accessToken`
  - 再调用 `/auth/me` 拉用户资料
- `src/pages/ProfilePage.tsx`
  - 登出走 `/auth/logout`

本次核对结果：

- 主工作区 `npm run build` 通过
- 构建时有一个 Vite 警告：`src/components/Layout.tsx` 对 `src/api/client.ts` 既动态导入又静态依赖，属于代码组织问题，不阻塞构建

### 2.3 计划书完成情况

按“两个工作区合并后视角”看：

- 后端任务 `Task 2` 到 `Task 18`：已在 `backend-postgres-auth` worktree 中实现并勾选
- 前端任务 `Task 19` 到 `Task 24`：已在主工作区实现并勾选
- `Task 1`：文档确认项，无实际阻塞代码

按“当前根目录单独视角”看：

- 主工作区并不包含后端 PostgreSQL/auth 改造代码
- backend worktree 也不包含主工作区里的前端消费侧改动

所以当前真实状态应描述为：

- “实现已分头完成”
- “尚未合并为单一可交付工作树”

## 3. 当前审查发现

### 已修复 1：前端错误提示兼容统一错误结构

前端原先直接读取 `err.response?.data?.error`，在后端返回对象形态错误包时可能显示为 `[object Object]`。

当前已修复为统一错误消息提取逻辑，兼容：

- 旧字符串错误
- 新结构化错误 `error.message`

### 已修复 2：后端管理员更新商品补齐 typed 404

`backend-postgres-auth/server/src/modules/admin/service.ts` 中，`updateProduct()` 现在会先校验商品是否存在，不再把 Prisma 更新异常直接暴露为潜在 500。

### 剩余发现 1：计划书完成状态被拆散在两个工作区里

这不是代码 bug，但会直接影响项目判断：

- 主工作区计划书看起来像“前端已完成，后端未完成”
- backend worktree 计划书看起来像“后端已完成，前端未完成”

如果不先说明这一点，很容易误判项目真实进度。

### 剩余发现 2：订单模块与已勾选计划书存在不一致

backend worktree 的计划书中，`Task 11` 已勾选为完成，但当前订单模块代码并未完整落到计划书描述：

- `server/src/modules/orders/schema.ts` 只有 `createOrderSchema`
- `server/src/modules/orders/routes.ts` 没有 `listOrdersQuerySchema`
- `server/src/modules/orders/routes.ts` 没有 `GET /:id`
- `server/src/modules/orders/controller.ts` 也没有 `detail`

这更像“计划书勾选超前于代码”，属于合并前应再次确认的点。

### 剩余发现 3：主工作区根目录下的 `server/.env` 仍是旧 SQLite 本地配置

根目录当前 `server/.env` 仍是：

```dotenv
DATABASE_URL="file:./dev.db"
```

而 PostgreSQL 改造完成态使用的是 backend worktree 中的环境示例与 PostgreSQL 连接串。若后续合并 worktree，需要同步清理或重建本地后端环境文件，避免误用旧配置。

## 4. 本地运行方式

### 4.1 目录职责

- 前端开发目录：仓库根目录
- 后端开发目录：`.worktrees/backend-postgres-auth/server`

### 4.2 环境要求

- Node.js 20+
- npm
- Docker / Docker Compose

### 4.3 数据库

当前目标数据库是 PostgreSQL 16，不是 SQLite。

定义位置：

- 根目录 `docker-compose.yml`
- backend worktree `server/prisma/schema.prisma`

默认连接参数：

- Host: `localhost`
- Port: `5432`
- Database: `monexus`
- Username: `monexus`
- Password: `monexus_dev_2026`

连接串：

```bash
postgresql://monexus:monexus_dev_2026@localhost:5432/monexus?schema=public
```

### 4.4 启动数据库

在仓库根目录执行：

```bash
docker compose up -d postgres
```

### 4.5 配置后端环境变量

后端应使用 worktree 里的 `.env.example`：

路径：

- `.worktrees/backend-postgres-auth/server/.env.example`

建议在 `.worktrees/backend-postgres-auth/server/.env` 中写入：

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://monexus:monexus_dev_2026@localhost:5432/monexus?schema=public
JWT_SECRET=local-development-secret-must-be-at-least-32-chars
FRONTEND_ORIGIN=http://localhost:5173
COOKIE_SECURE=false
```

注意：

- 根目录 `server/.env` 目前还是旧配置，使用的是 SQLite，不属于这次 PostgreSQL 改造完成态

### 4.6 初始化后端数据库

进入后端 worktree：

```bash
cd .worktrees/backend-postgres-auth/server
```

安装依赖：

```bash
npm install
```

执行 migration：

```bash
npx prisma migrate deploy
```

导入种子数据：

```bash
npm run db:seed
```

### 4.7 启动后端

在 `.worktrees/backend-postgres-auth/server` 下执行：

```bash
npm run dev
```

启动成功日志：

```bash
MoNexus API running at http://localhost:3000
```

健康检查：

```bash
curl -i http://localhost:3000/api/health
```

### 4.8 启动前端

回到仓库根目录：

```bash
cd /mnt/e/workspacePulic/MoNexus-new
npm install
npm run dev
```

访问地址：

```text
http://localhost:5173
```

Vite 已通过 `vite.config.ts` 将 `/api` 代理到 `http://localhost:3000`。

## 5. 本地调试方式

### 5.1 前端调试

- 页面入口：`http://localhost:5173/login`
- 打开浏览器 DevTools
- 重点看：
  - `Application -> Cookies -> http://localhost:3000`
  - `Application -> Local Storage`
  - `Network -> /api/auth/login`
  - `Network -> /api/auth/refresh`
  - `Network -> /api/auth/logout`

鉴权预期：

- 登录成功后，浏览器应收到 `refreshToken` Cookie
- `localStorage` 中的 `monexus-auth` 不应包含 `refreshToken`
- Access Token 仍在前端内存状态中使用

### 5.2 后端调试

推荐调试点：

- `server/src/modules/auth/controller.ts`
- `server/src/modules/auth/service.ts`
- `server/src/middlewares/auth.ts`
- `server/src/middlewares/errorHandler.ts`

重点验证：

- 登录时是否写入 Cookie
- 刷新时是否只从 Cookie 取 Refresh Token
- 登出时是否 revoke token 并 clear cookie
- 401/403/400 是否都走统一错误结构

### 5.3 数据库调试

可选方式 1：Prisma Studio

```bash
cd .worktrees/backend-postgres-auth/server
npm run db:studio
```

可选方式 2：psql

```bash
psql "postgresql://monexus:monexus_dev_2026@localhost:5432/monexus?schema=public"
```

建议重点查看表：

- `User`
- `RefreshToken`
- `PointAccount`
- `PointLog`
- `Product`
- `InventoryItem`
- `Order`
- `DeliveryRecord`

## 6. 测试账号

来自 `backend-postgres-auth/server/src/prisma/seed.ts`：

- 管理员账号：`admin@moyuan.net / admin123`
- 普通用户：`test@moyuan.net / user123`

## 7. 推荐联调顺序

1. 启动 PostgreSQL
2. 在后端 worktree 执行 migration 和 seed
3. 启动后端 `:3000`
4. 启动前端 `:5173`
5. 使用 `test@moyuan.net / user123` 登录
6. 检查浏览器 Cookie 是否写入 `refreshToken`
7. 检查 `localStorage.monexus-auth` 中没有 `refreshToken`
8. 验证刷新、签到、兑换、登出

## 8. 当前最需要做的事

如果要把这套方案真正变成“当前项目已完成”而不是“两个工作区分别完成”，建议按这个顺序推进：

1. 先把 backend worktree 合并回主工作区
2. 合并时同步处理根目录旧 `server/.env` 的 SQLite 配置
3. 复核 backend worktree 的订单模块是否要补齐 `Task 11` 所写的 query/detail 路由
4. 合并后重新跑一次前后端联调与计划书勾选
