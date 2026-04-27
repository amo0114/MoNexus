# PostgreSQL 与认证安全重构设计

**日期：** 2026-04-27

## 目标

将 MoNexus 从当前偏 MVP 的本地开发形态收敛为可前后端独立开发、可稳定联调的生产化基础方案。范围包括 PostgreSQL 切换、必填环境变量校验、Prisma migration、统一请求校验、统一错误响应、安全中间件，以及 Refresh Token 从前端持久化迁移到后端 HttpOnly Cookie。

## 当前状态

- 前端位于项目根目录，技术栈为 React、TypeScript、Vite、Zustand、Axios、TailwindCSS。
- 后端位于 `server/`，技术栈为 Node.js、TypeScript、Express、Prisma、Zod、JWT。
- 当前 `server/prisma/schema.prisma` 使用 SQLite，但根目录 `docker-compose.yml` 已定义 PostgreSQL 16。
- 当前后端 `validate()` 只校验 `req.body`，`params` 和 `query` 由控制器直接读取或 `parseInt`。
- 当前错误处理直接返回 `err.message`。
- 当前前端持久化 `accessToken` 与 `refreshToken`。

## 设计原则

1. 前后端开发分离：后端任务不得修改前端文件，前端任务不得修改后端文件。
2. 共享契约先行：接口路径、响应结构、Cookie 行为、错误结构和联调验收标准先固定。
3. 每项可标记：计划书中的每个任务和步骤都使用 checkbox，完成后立即勾选。
4. 不做双模式过渡：Refresh Token 目标形态直接采用 HttpOnly Cookie，不继续支持 body refreshToken 作为长期契约。
5. 后端是安全边界：CORS、Cookie、限流、Helmet、配置校验、错误收敛均由后端负责。
6. 前端只消费契约：前端负责 `withCredentials`、Access Token 内存/状态管理、刷新失败退出登录，不直接处理 refresh token。

## 共享契约

### 认证响应

`POST /api/auth/login` 成功：

```json
{
  "user": {
    "id": 1,
    "email": "user@example.com",
    "role": "user",
    "inviteCode": "MOYUAN26",
    "points": 5000
  },
  "accessToken": "jwt-access-token"
}
```

同时后端设置 `refreshToken` HttpOnly Cookie。

`POST /api/auth/refresh` 成功：

```json
{
  "accessToken": "jwt-access-token"
}
```

请求体为空，refresh token 只从 Cookie 读取。

`POST /api/auth/logout` 成功：

```json
{
  "ok": true
}
```

后端吊销当前 refresh token 并清除 Cookie。

### Cookie 策略

- Cookie 名称：`refreshToken`
- `httpOnly: true`
- `sameSite`：开发环境使用 `lax`，生产跨站部署时使用 `none` 并要求 `secure: true`
- `secure`：由 `COOKIE_SECURE` 控制，生产必须为 `true`
- `path`：`/api/auth`
- `maxAge`：7 天

### 错误响应

所有错误响应统一为：

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

通用错误码：

- `VALIDATION_ERROR`
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `BAD_REQUEST`
- `INTERNAL_SERVER_ERROR`
- `RATE_LIMITED`

### CORS 与凭证

- 后端必须配置 `credentials: true`。
- 后端只允许 `FRONTEND_ORIGIN` 指定的前端来源。
- 前端 Axios 必须配置 `withCredentials: true`。

## 后端设计

### 文件边界

后端可修改：

- `server/package.json`
- `server/package-lock.json`
- `server/prisma/schema.prisma`
- `server/prisma/migrations/**`
- `server/.env.example`
- `server/src/config/index.ts`
- `server/src/app.ts`
- `server/src/main.ts`
- `server/src/lib/prisma.ts`
- `server/src/lib/httpError.ts`
- `server/src/lib/cookies.ts`
- `server/src/middlewares/validate.ts`
- `server/src/middlewares/errorHandler.ts`
- `server/src/middlewares/auth.ts`
- `server/src/modules/**`
- `server/src/prisma/seed.ts`

后端不得修改：

- `src/**`
- 根 `package.json`
- 根 `vite.config.ts`
- 前端样式或组件文件

### 数据库

- Prisma datasource 从 `sqlite` 改为 `postgresql`。
- 使用 `prisma migrate dev --name init_postgresql` 生成初始 migration。
- 移除以 `db push` 作为主流程的思路，保留可选开发命令但计划中以 migration 为准。
- `DATABASE_URL` 必须指向 PostgreSQL。
- `docker-compose.yml` 继续作为本地 PostgreSQL 依赖。

### 配置校验

后端启动时必须校验以下变量：

- `DATABASE_URL`
- `JWT_SECRET`
- `FRONTEND_ORIGIN`
- `COOKIE_SECRET` 或同等 cookie 签名密钥（如最终实现使用签名 Cookie）
- `COOKIE_SECURE`
- `NODE_ENV`
- `PORT`

如果缺失或格式错误，服务启动失败，并输出明确但不泄露密钥值的错误信息。

### 请求校验

`validate()` 升级为可同时校验：

- `body`
- `params`
- `query`

控制器不得直接 `parseInt(req.params.id)`。所有路径参数应通过 schema 转换为 number。

### 错误处理

- 使用自定义 `HttpError` 表示业务错误。
- Zod 错误统一返回 400 和 `VALIDATION_ERROR`。
- 认证错误返回 401 和 `UNAUTHENTICATED`。
- 权限错误返回 403 和 `FORBIDDEN`。
- 未识别错误返回 500 和固定文案，不向客户端透出内部错误信息。
- 服务端日志可记录内部错误。

### 安全中间件

- 添加 `helmet`。
- 添加 `express-rate-limit`，至少覆盖全局 API 和 auth 关键接口。
- CORS 使用 `FRONTEND_ORIGIN` 白名单和 `credentials: true`。
- JSON body size 设置明确上限。
- Cookie 解析使用 `cookie-parser`。

### Refresh Token

- 登录与注册成功时，后端生成 refresh token，存储 hash，设置 HttpOnly Cookie，响应体只返回 access token。
- 刷新时只读取 Cookie，不读取 body refreshToken。
- 刷新成功后轮换 refresh token：旧 token 标记 revoked，新 token 写库并重设 Cookie。
- 登出时吊销当前 refresh token 并清除 Cookie。

## 前端设计

### 文件边界

前端可修改：

- `src/api/client.ts`
- `src/stores/authStore.ts`
- `src/pages/LoginPage.tsx`
- 与登录/退出调用直接相关的前端文件
- 必要时根 `vite.config.ts` 只调整代理凭证相关配置

前端不得修改：

- `server/**`
- `docker-compose.yml`
- `server/prisma/**`
- 后端环境配置文件

### 状态管理

- `authStore` 不再保存 `refreshToken`。
- Zustand persist 只允许保存非敏感用户态，或最多保存 `user` 与 `isLoggedIn`；access token 是否持久化由实施阶段明确，推荐只放内存状态。
- `setTokens` 改为只接收 `accessToken`。

### Axios

- `api` 实例配置 `withCredentials: true`。
- 401 自动刷新时调用 `POST /api/auth/refresh`，请求体为空。
- 刷新成功后更新 access token 并重试原请求。
- 刷新失败后清理前端登录态。

### 登出

- 前端调用 `POST /api/auth/logout`。
- 无论接口是否成功，前端最终清理本地登录态。

## 联调设计

### 前置条件

- PostgreSQL 容器可启动。
- 后端 `.env` 使用 PostgreSQL `DATABASE_URL`，`FRONTEND_ORIGIN=http://localhost:5173`。
- 后端 migration 已执行。
- 后端 seed 已按新数据库跑通。
- 前端 dev server 运行在 `http://localhost:5173`。

### 联调流程

1. 启动 PostgreSQL。
2. 后端执行 migration 和 seed。
3. 启动后端 `localhost:3000`。
4. 启动前端 `localhost:5173`。
5. 登录成功，浏览器 DevTools 可见 `refreshToken` Cookie，但 JS 无法读取。
6. 普通 API 请求携带 Bearer access token。
7. access token 过期后，前端自动调用 refresh 接口并重试。
8. 登出后 Cookie 被清除，再访问受保护接口返回 401。

## 测试策略

后端：

- `npm run build`
- Prisma migration 验证
- 配置缺失启动失败验证
- 校验中间件 body/params/query 单元或集成验证
- 登录/刷新/登出接口验证
- 错误响应结构验证

前端：

- `npm run build`
- 登录流程手工验证
- 401 自动刷新手工验证
- 登出清理状态手工验证
- 浏览器确认 refresh token 不在 localStorage/sessionStorage

联调：

- 前后端同时启动，按完整登录、刷新、登出闭环验收。

## 范围外

- 不更换 Express 为 NestJS 或 Fastify。
- 不引入完整 E2E 测试框架。
- 不实现多租户、OAuth、短信验证码或第三方登录。
- 不做 UI 视觉重构。
- 不做微服务拆分。

## 自检结果

- 无占位符。
- PostgreSQL、配置校验、Prisma migration、统一校验、错误收敛、安全中间件、Refresh Cookie 均有对应设计。
- 前后端文件边界明确。
- 联调契约明确。
- 计划书需要使用 checkbox 跟踪每个任务和步骤。