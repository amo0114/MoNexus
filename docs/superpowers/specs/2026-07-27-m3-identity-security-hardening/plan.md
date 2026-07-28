# Plan: M3 身份与特权操作安全收口

| 字段 | 值 |
| --- | --- |
| 文档 ID | PLAN-M3-ISH-001 |
| 版本 | 1.27.0 |
| 日期 | 2026-07-27 |
| 状态 | Frozen for Implementation |
| 规格 | [spec.md](./spec.md)（SPEC-M3-ISH-001） |
| 任务分解 | [task.md](./task.md) |
| 验收清单 | [checklist.md](./checklist.md) |

> 实施前必须先确认 spec 的 D-01 至 D-07。所有工作从最新 develop 建 feature 分支并通过 PR 合回 develop。后端行为先写测试；不使用 git add -A；不以关闭 MFA 或测试后门换取绿灯。

---

## 1. 目标与非目标

### 1.1 Goal

以现有 JWT + HttpOnly refresh cookie + Prisma 架构为基础，完成以下安全收口：

- 管理员强制 TOTP，密码校验不再直接等于后台会话；
- access token 与稳定设备会话族关联，admin API 立即识别被吊销会话；
- 用户可见、可控自己的登录设备；
- 认证安全事件可追溯，秘密不进入日志；
- bcrypt 10 平滑升级到 12。

### 1.2 Non-goals

完整边界见 spec §2.2。实施中尤其禁止：

- 修改真实支付、积分业务或订单状态机；
- 用 OAuth、短信或 Passkey 替代本波 TOTP；
- 把 admin step-up 弹窗混入本 PR；
- 给前端持久化 refresh token、challenge 或 MFA secret；
- 以手写 Prisma migration 替代 prisma migrate dev。

---

## 2. 现状与目标架构

### 2.1 As-Is

~~~text
Login(email, password)
  → bcrypt.compare(rounds=10)
  → RefreshToken(hash, userAgent, ip)
  → JWT(userId, role) + HttpOnly refresh cookie

Admin routes
  authenticate → requireActiveUser → requireAdmin
~~~

刷新 token 已经原子轮换并检测重放，但 token 行没有稳定 session family，也没有 MFA 证明或会话管理 UI。

### 2.2 To-Be

~~~text
                         ┌────────────────────────┐
                         │ User + MFA models       │
                         │ encrypted TOTP seed     │
                         │ recovery code hashes    │
                         └───────────┬────────────┘
                                     │
password login ── admin ──► AuthChallenge (5 min, one-time, limited)
                                     │
              ┌──────────────────────┴──────────────────────┐
              │                                               │
              ▼                                               ▼
       TOTP enrollment                                  TOTP/recovery verify
              │                                               │
              └───────────────────► create session ◄─────────┘
                                         │
                     RefreshToken sessionId (stable on rotation)
                                         │
                       JWT(userId, role, sid, mfa, mfaVersion)
                                         │
                 requireAdminMfa validates user + session live
                                         │
                                  /api/admin/*

Profile security card ── GET /auth/sessions ── revoke one / other / all
~~~

### 2.3 边界策略

| 边界 | 策略 |
| --- | --- |
| 正常用户/商家登录 | 保持现有 200 { user, accessToken } 与 cookie 行为 |
| 管理员初次/后续登录 | 返回 202 preauth challenge；未完成 MFA 不创建 RefreshToken |
| refresh rotation | 新 token 行继承 sessionId、sessionStartedAt；lastUsedAt 更新 |
| admin API | 每次经过 requireAdminMfa 查询/验证 User MFA 版本与该 session 活跃状态 |
| 非 admin 业务 API | 不新增每请求 session DB 查询；吊销在 refresh 被拒后生效，最长沿用 15 分钟 access token TTL |
| refresh replay | rotation 消费 token 与无原因 legacy revoked token 保留“全用户 refresh token 全部吊销”并写 security event；logout/单设备/其他设备等明确 revoke reason 只拒绝该终结会话，不能误伤当前活动族 |

---

## 3. 技术方案

### 3.1 数据与 migration

建议新增模型和字段：

| 位置 | 变更 |
| --- | --- |
| User | mfaEnabled、mfaSecretEncrypted、mfaVerifiedAt、mfaVersion |
| MfaRecoveryCode | 高熵 codeHash、usedAt、user 关系与索引 |
| AuthChallenge | UUID、purpose、加密 pending seed、TTL、used/attempt 状态 |
| SecurityEvent | user、session、type、ipHash、deviceHint、detailSafe、时间 |
| RefreshToken | sessionId UUID、sessionStartedAt、lastUsedAt、revokedAt、revokeReason、相应索引 |

实施要点：

1. 仓库负责人已授权 M3-ISH 在独立 worktree 并行编辑自身的 schema/migration；不得读取或修改 P6a 未提交文件。P6a 合入后、M3-ISH 开 PR 前必须 rebase，并人工核对 P6a 与 M3-ISH 的 migration 顺序、`User` / `RefreshToken` 块；有语义冲突则先修订本计划再继续。
2. 所有 Prisma 写操作显式携带专用连接，例如 `DATABASE_URL="$M3_ISH_DATABASE_URL" npx prisma migrate dev --name identity_security_hardening`；`M3_ISH_DATABASE_URL` 只能指向 `monexus_m3_ish_test`。不得依赖 `.env` 默认值，不得使用 `monexus_test`、开发库、staging 或生产库。若 Prisma CLI 以 UTC 生成的目录早于已知 P6a timestamp，只可在提交前重命名本任务目录、保持 generated SQL 的 hash 不变、reset/replay 专用库；不得改 P6a 文件。
3. 使用一个 Prisma 生成 migration：`sessionId` 在 schema 中以 `@default(dbgenerated("gen_random_uuid()"))` 取得 PostgreSQL database-generated UUID，session 时间以数据库 timestamp default 取得值，不为 `sessionId` 加全局 UNIQUE。Prisma shadow database 必须由同一隔离凭据创建；若环境需要显式 shadow URL，只能使用另一个专用 `monexus_m3_ish_*` 数据库，绝不能指向共享库。
4. 生成 migration 后，在同一专用 `monexus_m3_ish_test` 中先插入 pre-migration legacy fixture、再应用 migration，断言每条既有 RefreshToken 获得不同、非空的 UUID 和非空 session 时间；随后 reset/replay 该**同一可丢弃专用库**，再继续测试。验证 SQL 确实含 database default，不能把 Prisma client-side `uuid()` 误当成数据回填。不得创建、连接或暗示另一个未实际隔离验证的数据库。
5. migration 应用后、启动新 API 前运行受版本控制的 legacy-admin revoke 命令，吊销所有旧 admin RefreshToken；命令必须幂等、分批、可测试，且只在隔离库验证后才可进入部署 runbook。
6. session family 的唯一性不是 token 行唯一性：`RefreshToken.sessionId` 可在同一轮换族的多行重复；用 user/session/active/expiry 索引支持查询，不能加全局 unique。
7. 所有秘密字段使用 select 白名单；User profile、AdminLog、SecurityEvent serializer 永远不读取/返回 mfaSecretEncrypted。

### 3.2 TOTP 与加密模块

新增一个窄模块，例如 server/src/modules/auth/mfa.ts：

| 能力 | 设计 |
| --- | --- |
| TOTP | 引入小型 TOTP 库（建议 otpauth）；固定 6 digits / 30 秒 / SHA-1 / window=1 |
| seed | 使用 CSPRNG 生成；只在首次绑定/换机时短暂返回给浏览器 |
| at-rest encryption | AES-256-GCM；密文格式含 version、iv、ciphertext、tag；每次独立随机 iv |
| key | config.mfaEncryptionKey 由 MFA_ENCRYPTION_KEY 读取，base64 解码后必须恰为 32 bytes |
| recovery codes | 一次生成 10 个高熵人可抄写代码；以 hash 存储并用原子 updateMany claim，永不存明文 |
| challenge | UUID opaque id；purpose=admin_enroll/admin_login/admin_reconfigure；5 分钟、5 次尝试、成功即 consumed |

前端二维码可使用小型 qrcode 库在浏览器内由 provisioningUri 绘制；后端不生成长驻图片文件。二维码与手动密钥同样是秘密，组件卸载即从内存移除。

### 3.3 Auth service 变化

1. 将 generateAccessToken 改为接收 sessionId、mfaVerified 与 mfaVersion，并将 sessionId 仅写成 JWT `sid` claim。
2. 将 createStoredRefreshToken 返回该行的 sessionId；首次登录创建 UUID，轮换时传入前一行 sessionId 和 sessionStartedAt。
3. loginUser 在密码验证成功后：
   - 非 admin：可按需 rehash，然后照旧创建 session；
   - admin 未绑定：创建 enrollment challenge，返回 challenge 结果；
   - admin 已绑定：创建 login challenge，返回 challenge 结果。
4. MFA confirm/verify 在同一事务中 claim challenge、校验 code、写安全事件、创建 session；成功后才由 controller 设置 cookie。
5. refreshAccessToken 继承 sessionId；读取 user 后若是 admin，额外确认 mfaEnabled，旧/异常 session 不得续签。所有创建、rotation 和显式 session mutation 通过同一用户的 PostgreSQL transaction-scoped advisory lock 串行；raw token 的首读只解析 userId，取得锁后必须重新读取 token/family，再作 CAS、replay 或终结判断。rotation 消费 token 与无原因 legacy revoked token 的 replay 沿用全用户强制失效策略；`logout`、`single_session`、`revoke_others`、`revoke_all`、MFA reset/migration 等服务端明确终结 reason 只返回 session 已失效，不能让被吊销设备反向踢出当前活动族。判断旧 predecessor 时查询整个 family 的显式终结 marker，不能只看该 predecessor 仍保留的 `refresh_rotation`；logout 即使带来已经 rotation 的旧 cookie，仍吊销同一 family 的活动 successor。
6. revoke 一个会话使用 sessionId 更新该族所有未撤销 RefreshToken；DELETE session 只接受非当前族，当前族始终使用既有 logout 并清 cookie。
7. bcrypt 工具统一为常量 PASSWORD_BCRYPT_ROUNDS=12；register、change password、reset password 使用它。只有成功完成正常会话创建的非 admin 登录，才检测 getRounds 后做 compare-and-set 式按需升级；admin MFA pre-auth 不保存密码且不重哈希。管理员成功改密或重置时，在同一 user advisory lock 事务内消费全部未消费 `AuthChallenge`、递增 `mfaVersion`，再吊销 session；这样旧密码得到的五分钟 pre-auth 不能跨越密码安全边界。
8. 导出仅供离线 runbook/script 调用的 `resetAdminMfaForBreakGlass({ userId, caseRef })`；不得由 controller 或 route 引用。它在同一 user advisory lock transaction 内重读 admin、清空 User 与 pending challenge 的 MFA seed/verified 状态、作废未使用 recovery code 与未消费 challenge、递增 `mfaVersion`、以 `mfa_break_glass_reset` 吊销所有 refresh session，并写同类型的受控 SecurityEvent。任一步失败必须整体回滚。

#### 3.3.1 Refresh mutation 的事务锁与调用顺序（D-07）

采用 repository 已验证的 `pg_advisory_xact_lock(classid, userId)` 模式，新增独立 classid 的窄 helper；不新增 Prisma model 或 migration。锁必须在 caller 的现有 transaction connection 上取得，不能在 callback 中回退到全局 `prisma`。

| 调用者 | 固定顺序 |
| --- | --- |
| `loginUser` / register 的初始 session | 只读定位 user → transaction → user lock → 重读 status（login 同时重验 password）→ `RefreshToken.create` → commit |
| `refreshAccessToken` | tokenHash 首读只取 userId → transaction → user lock → token/User/family 重读 → expiry/status/CAS/replay 判定 → successor create 或 revoke → commit |
| cookie logout | tokenHash 首读定位 user/family（包含已 rotation 行）→ transaction → user lock → family 重读 → 终结所有 active token → commit |
| DELETE session / revoke-others | transaction → user lock → current/target families 重读 → owner/current 判断及 revoke/event → commit |
| password reset/change | transaction → user lock → claim/reset artifact、`User` password 写入（admin 同时 `mfaVersion + 1`）→ consume all pending `AuthChallenge` → `revokeAllUserRefreshTokens`（同 tx 重入锁）→ audit → commit |
| admin ban / approve merchant / suspend merchant | transaction → 只读校验 → user lock → 任意 `User` status/role 写入 → `revokeAllUserRefreshTokens`（同 tx 重入锁）→ admin/security audit → commit |
| `revokeAllUserRefreshTokens`（独立调用或 replay） | 使用传入 tx 或自建 tx → user lock → 查询 active families → `revoke_all`/明确 reason 的 update + `session_revoked` audit → commit |
| 后续 MFA session issuance | 必须复用 initial-session helper，在同一 user lock 内创建；不能直接写 `RefreshToken` |

`refresh_replay` 仍是安全事件后的强制全用户失效，不属于 D-07 的 explicit terminal marker。`expired` 及未知的非 null/non-rotation reason 只拒绝本 token；只有 null/`refresh_rotation` 会继续 family-marker/replay 分支。

**锁序约束：**同一事务需要同时修改 `User` 和 refresh session 时，advisory lock 一律先于 `User` 行写锁。不得将 `tx.user.update` 放在会取得该 advisory lock 的 revoke helper 之前，否则与 password reset/change 的“advisory → User”路径会形成数据库死锁。回归使用真实 PostgreSQL 事务、deferred Promise gate 与 `pg_locks` 的实际排队状态；不使用 mock、sleep 或人为放宽超时。

### 3.4 中间件与安全事件

扩展 AuthPayload：

~~~text
userId, role, sid?, mfaVerified?, mfaVersion?
~~~

新增 requireAdminMfa：

1. 先检查 token claims，避免无意义查询；
2. 按 userId 查询 User 的 mfaEnabled/mfaVersion/status；
3. 按 sessionId 查询未撤销、未过期 RefreshToken；
4. 任一不符合时返回契约化 MFA_REQUIRED 或 SESSION_REVOKED；
5. 绝不把 tokenHash、IP、TOTP 或 seed 写入错误。

`/api/orders/:id/files/download-url` 保留买家/商家交付语义，但其中 admin 具有仲裁取证、读取已吊销文件的专属能力；在该单一路由使用条件 middleware：role 非 admin 时直接 next，role=admin 时委托同一 `requireAdminMfa`。该 middleware 必须位于 fileAccess/controller 之前，因此旧 token 不会得到 presigned URL 或新增 FileGrantLog。

公告 public endpoint 不改为受保护资源；其 audience resolver 对数据库当前 role=admin 的用户委托相同 MFA/session 校验，失败时只降级为访客 `all` audience。这样不会把公共公告请求变成 401/403，同时不会让旧 admin token 读取 admin-only 内容或创建该内容回执。

安全事件采用专用函数，例如 recordSecurityEvent。事件 detailSafe 只允许受控枚举和数值/安全摘要；IP 用 HMAC(jwtSecret, ip) 或独立密钥形成不可逆关联 hash；UA 只保存解析后的短 deviceHint。

Pino redact 追加 MFA request fields、challengeId、provisioningUri、manualKey、recoveryCodes、MFA_ENCRYPTION_KEY。新增测试须直接序列化 logger payload 证明原文不存在。

### 3.5 会话 API 与 UI

服务层提供：

| 函数 | 责任 |
| --- | --- |
| listActiveSessions(userId, currentSessionId) | active/未过期 session summary，device/IP 脱敏，排序 current → lastUsedAt |
| revokeSession(userId, sessionId, reason) | owner-scoped 更新；非属主按 404 处理，current session 返回 CURRENT_SESSION_REQUIRES_LOGOUT |
| revokeOtherSessions(userId, currentSessionId) | 保留当前族、吊销其余族 |
| revokeAllSessions(userId, reason) | 吊销所有族；当前请求返回后前端清理状态 |

设备会话 API 必须有 JWT `sid` 才能判定 current；发布前签发、缺少 `sid` 的普通 access token 保持既有业务 API 的最长 15 分钟兼容，但访问 `/auth/sessions*` 时返回 401 并要求 refresh/login。

前端只扩展：

- src/api/auth.ts 的 union 登录结果与 session API；
- src/pages/LoginPage.tsx 的 MFA challenge/绑定步骤；
- src/pages/ProfilePage.tsx 或一个独立 AccountSecurity 组件；
- 必要的 AuthUser 类型，不把 challenge/seed 放入 authStore persist。

### 3.6 OpenAPI、README 与运维

必须同步：

- docs/superpowers/specs/monexus-api-openapi.json；
- server/src/modules/auth/README.md；
- server/.env.example、根 .env.example；
- docs/operations/runbook.md 与 docs/operations/secrets-management.md。

runbook 至少包含：

1. 生成并放置 MFA_ENCRYPTION_KEY 的方式（只写命令和位置，不写真实值）；
2. 所有实例必须使用同一 key 的部署检查；
3. 首次管理员绑定前的发布通知；
4. 双人批准的 break-glass：离线确认身份、记录工单、清空某一 admin MFA、递增版本、吊销所有会话、要求立即重新绑定；
5. 禁止通过 SQL 读取或复制 seed / recovery hash 来“恢复”账户。

---

## 4. 实施阶段

### Phase 0 — 基线与决定（S）

| 活动 | 出口 |
| --- | --- |
| 阅读 spec / task，记录 D-01..D-07 已确认 | 无开放范围歧义 |
| 在最新 develop 建 feat/m3-identity-security-hardening | worktree 干净 |
| 跑现有 auth、refresh、active-user 测试与双端 build | 基线绿 |
| 确认生产 secrets 管理可提供 MFA_ENCRYPTION_KEY | 不在代码中回退到默认密钥 |

### Phase A — Schema、配置与安全原语（M）

| 交付 | 对应 |
| --- | --- |
| 单一 database-default Prisma migration、legacy fixture 与管理员吊销验证 | REQ-F-020 |
| config production guard、AES-GCM/TOTP/recovery/challenge primitive | REQ-F-010–013, NF-01–03 |
| logger redact 和 SecurityEvent 基础 | REQ-F-030–031 |
| 迁移/加密/日志单元测试 | NF-08 |

出口：migration 在隔离 PostgreSQL 应用、drift clean；任何秘密都没有落在测试日志。

### Phase B — 稳定会话族与会话管理（M）

| 交付 | 对应 |
| --- | --- |
| session family 创建/refresh rotation 继承、用户级 transaction lock、会话列表、单个/其他吊销服务与 API（P0） | REQ-F-020–023 |
| owner 404、current DELETE 拒绝、脱敏 serializer、安全事件 | REQ-F-021, F-030 |
| refresh replay / stale predecessor / rotation-revoke ordering 回归与 JWT `sid` contract | REQ-F-020, DR-09 |

出口：AC-05 的后端测试全绿；session service 成为 MFA session creation / guard 的唯一族语义来源。

### Phase C — 后端 MFA 登录、admin guard 与 bcrypt（L）

| 交付 | 对应 |
| --- | --- |
| login 202 union 与 MFA enroll/verify controller、schema、routes | REQ-F-010–014 |
| JWT `sid` / MFA claims 与 requireAdminMfa | REQ-F-013–014, F-025 |
| bcrypt 12 / restricted opportunistic rehash；管理员密码变更作废 pre-auth challenge / bump MFA version | REQ-F-032, DR-03 |
| 无 HTTP route 的离线 break-glass 原子 reset 与工单审计 | D-04, REQ-F-030 |
| admin immediate invalidation 与 portable-backups guard 回归 | REQ-F-025, DR-09 |

出口：AC-01、AC-02、AC-03、AC-04、AC-06、AC-07 的后端测试全绿。

### Phase D — 前端体验（M）

| 交付 | 对应 |
| --- | --- |
| LoginPage MFA challenge、QR、恢复码一次展示 | REQ-F-010–013 |
| Profile account security / sessions：列表、单个/其他吊销（P0） | REQ-F-021–023 |
| 管理员恢复码重生/换机与 revoke-all（P1） | REQ-F-015–016, F-024 |
| loading、错误、a11y、testid 和非持久化检查 | REQ-NF-05, NF-08 |

出口：首次绑定、后续 TOTP 登录、恢复码登录和退出其他设备可手工走通。

> **并行 gate（已解除）：** P6 已进入 `develop`，M3-ISH 已在 `4568ee4` 完成 rebase。I-05 可在**自己的 M3-ISH worktree** 修改 LoginPage、ProfilePage 和独立 auth 组件；不得读取、编辑、格式化、测试、切换或迁移 P7b worktree / branch，也不得占用其运行时资源。

### Phase E — QA、文档与发布演练（M）

| 交付 | 对应 |
| --- | --- |
| 专用库 vitest、独立端口 Playwright、双端 build、migration/drift、production env checks | AC-08 |
| OpenAPI/module README/runbook/secrets 文档 | §3.6 |
| staging 强制绑定、admin route / session revoke smoke | AC-01–08 |

出口：checklist 所有 P0 项勾选，PR Ready for Review。

---

## 5. 依赖与并行边界

~~~text
Phase 0
  │
  ▼
Phase A ──► Phase B ──► Phase C ──► Phase D ──► Phase E
                      │                  │
                      └──── API contract ┘
~~~

建议并行仅在明确不重叠时进行：

| 轨道 | 可拥有文件 | 注意 |
| --- | --- | --- |
| BE foundation | schema、config、mfa primitive、logger | 必须先于 auth service |
| BE session | sessionService、auth service 的 refresh/session 边界、session tests | 必须先冻结 `sid` / rotation / revoke 语义，才允许 MFA 集成 |
| BE auth | auth service/controller/schema/routes、auth middleware | 在 BE session 完成后串行集成 MFA login、guard 与 bcrypt |
| FE | LoginPage、Profile security 子组件、auth client | 只能在 API contract 定稿后开始 |
| QA/docs | 新测试、OpenAPI、runbook | 依赖真实 route/错误码，不可提前臆造 |

共享冲突高风险文件：server/src/modules/auth/service.ts、server/src/modules/auth/routes.ts、server/src/middlewares/auth.ts、src/pages/ProfilePage.tsx、src/api/auth.ts。若多人协作，应让单一负责人合并各共享文件，或先抽出独立模块再并行。当前 P6a 已占用 ProfilePage，详见 implement.md §2；安全分支在 rebase 前不修改它。

---

## 6. 测试策略

| 层级 | 覆盖 |
| --- | --- |
| Unit | AES-GCM round trip / 错 key、TOTP 时间窗口、恢复码 hash/一次性 claim、device/IP 脱敏、bcrypt rehash 判定 |
| Integration | admin login 202 → enroll → verify → admin guard；challenge 超时/超限；recovery code；session list/revoke；refresh rotation/replay；rotation 后 stale predecessor 的 explicit revoke 与 family-marker 判定；真实 transaction lock 的无 sleep 排队/connection-affinity 证明 |
| Security regression | no cookie before MFA、旧 token 拒绝、owner 404、raw secret/log redaction、admin revoked token 立即拒绝 |
| E2E | admin 首次绑定、窗口外错误 TOTP、真实 recovery code 一次性登录；两个 browser context 的精确单设备 revoke；非 admin 登录回归 |
| Build / deploy | frontend build、server build、Prisma migration status/drift、production env guard |

测试实现要求：

- 通过 injectable clock 或 TOTP adapter 固定时钟；禁止等待 30 秒。
- Playwright 可从首次绑定页面读取手动密钥并在测试进程生成 TOTP，不设后门 API；错误码必须显式避开 `now - 30s` / `now` / `now + 30s` 的允许集合，不能只换一个 secret 侥幸期望失败。
- 单元/集成/迁移测试一律显式使用 `monexus_m3_ish_test`；不得在生产、共享开发库、P6a 库或默认 `monexus_test` 建测试管理员。
- 不得运行 `npm run verify:local(:no-e2e)` 或默认 `npm run e2e`：它们会管理共享 compose / 默认数据库 / 3000、5173。T-QA-02 必须新增专用验证入口，固定后端 3103、前端 5178、专用数据库，并设 `reuseExistingServer=false`；端口/数据库不可用即失败，不借用已有服务。
- 任何 log assertion 都只断言“秘密不存在”，不把秘密原样输出到失败信息。

### 6.1 I-06 真实 E2E 与验证入口设计（编码前冻结）

| 组件 | 方案 | 安全 / 隔离边界 |
| --- | --- | --- |
| UI contract | 保留 `e2e/m3-identity-security-hardening.spec.ts` | 仅 mock 浏览器契约，不能勾选 AC-08 |
| 真实 E2E | 新增 `e2e/m3-identity-security-hardening.real.spec.ts` 与其最小 DB fixture helper | 真实 HTTP、真实 cookie、真实 guard；不增加 test-only HTTP API |
| fixture | 测试进程以显式 `M3_ISH_DATABASE_URL` 的 Prisma client 建随机 namespaced admin，密码仅存测试进程内存 | 只允许数据库名 `monexus_m3_ish_test`；`enrollAdministrator` 只在测试闭包内返回 UI 获得的 manual key/recovery codes，绝不写 artifact、日志或异常；每场景 afterEach 精确删除 fixture 的 auth/security 子记录和 User，启动时仅回收同前缀遗留项 |
| TOTP / recovery | 从真实 enrollment UI 读取 manual key，在 Playwright 进程生成当前码；新 context 用一枚 recovery code 真正登录并验证复用失败 | 错 TOTP 必须显式避开允许的前/当前/后 30 秒窗口；不从 DB 读取 seed，不等待时间窗口，不记录 manual key / code，不让失败再建 session |
| session E2E | A/B 两个独立 browser context；A 经 Profile 的 `session-revoke-device` 确认 UI 精确吊销 B | A 的真实 `/api/admin/stats` 仍为 200；B refresh 为 401、B admin API 为 401 / `SESSION_REVOKED`；不直写 token revoke 状态，不复用 cookie/context |
| runner | `scripts/verify-m3-identity-security-hardening.sh` + 根 `verify:m3-identity-security-hardening` script | config 在 webServer 前严格解析 DB pathname；只跑 status/diff、全量 server vitest、双端 build、production env template guard 和专用 Playwright；默认 config 必须 ignore real spec；禁止 compose、`migrate reset`、默认 E2E |

新 Playwright config 继续固定 `3103/5178`、单 worker 和 `reuseExistingServer=false`，并匹配 mock 与 real 两类 M3 文件。验证脚本若同时收到 `M3_ISH_DATABASE_URL` 与 `TEST_DATABASE_URL`，两者必须相同；任何一个指向非专用库即拒绝执行。config 还必须在 webServer 创建前用 URL pathname 精确拒绝非 `monexus_m3_ish_test` 的目标；所有额外 `browser.newContext()` 显式继承 `test.info().project.use.baseURL`，`trace: 'off'`、`screenshot: 'off'`、不启用 video。`openAdmin()` 必须等待精确 `GET /api/admin/stats` 的 200，而不是只验证静态 dashboard 文本。根 `playwright.config.ts` 必须以 `testIgnore` 排除 `.real.spec.ts`，否则默认 CI 会在加载 fixture 时因缺少 `M3_ISH_DATABASE_URL` 失败；该排除不影响 M3 专用 config 的两类测试匹配。

### 6.2 Break-glass 离线入口与 production preflight

- `server/src/scripts/resetAdminMfaForBreakGlass.ts` 只能通过服务端 package 的显式 `auth:break-glass-reset -- --user-id=<positive-int> --case-ref=<OPS-123>` 调用已冻结的原子服务；不得增加 controller、route、测试环境 bypass 或直接 SQL 清 seed/recovery/session。
- CLI 只输出受控 `userId`、`caseRef`、`revokedCount` 与新 `mfaVersion`，不读取或打印任何 MFA seed、recovery code、token、cookie、密码或数据库 URL；输入不合规则失败且不产生状态变化。
- `scripts/check-prod-env.sh` 必须和 server 启动 guard 一样校验 `MFA_ENCRYPTION_KEY` 是 canonical standard-base64 的 32-byte 值。`--allow-placeholders` 只允许模板 lint，真实 staging/production deploy 仍拒绝缺失/非法值。

---

## 7. 发布与回滚

### 7.1 发布前

1. 在 staging 配置独立 MFA_ENCRYPTION_KEY 并验证生产 guard。
2. 以 staging admin 完成 AC-01 至 AC-06；确认 QR、恢复码、会话吊销体验。
3. 通知管理员：上线后旧会话会失效，首次登录需携带 TOTP authenticator。
4. 确认至少两名指定运维人员可执行 break-glass SOP，且密钥备份记录的是版本/位置而非值。

### 7.2 发布顺序

1. 暂停/排空旧 API 实例，避免旧代码继续接受无 MFA admin token，应用已验证的 database-default migration。
2. 在受控发布环境运行版本化 legacy-admin revoke 命令，验证所有旧 admin refresh session 已吊销。任何一步失败都不启动新 API，也不回滚到无 MFA 后台。
3. 启动包含 MFA config guard 的新 API；所有实例使用相同密钥。
4. 验证 health/readiness、production env guard、普通用户登录。
5. 使用指定管理员走首次绑定、访问 admin stats、查看 session、在另一浏览器撤销会话。
6. 观察 SecurityEvent / 应用错误 15 分钟，再恢复常规运维。

### 7.3 回滚原则

该波是安全边界变更，不能把“回滚到未强制 MFA 的旧 admin API”当作常规手段。

| 场景 | 处理 |
| --- | --- |
| migration 前失败 | 不切流，保留旧版本；修复后重试 |
| 新版本启动失败 | 先修 config/key 或前向修复；必要时在代理层临时拒绝 /api/admin，而不是重新开放无 MFA 后台 |
| 单个管理员锁定 | 走 break-glass SOP，绝不加 HTTP bypass |
| 发现业务功能回归 | 保持 admin MFA guard，针对业务部分发布最小前向 hotfix |

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 强制绑定造成管理员锁定 | 中 | 高 | 恢复码 + 双人离线 SOP + staging 演练 |
| 多实例 key 不一致 | 中 | 高 | 启动配置校验、发布前密钥版本核验、所有实例同一 secret source |
| sessionId migration/rotation 写错 | 中 | 高 | 隔离库迁移 + 并发 refresh/replay 回归 + data invariant 检查 |
| 202 login 被 Axios 当错误或误刷新 | 中 | 中 | 客户端 union 显式处理；只对会话型 401 自动 refresh |
| Auth 模块改动过大 | 高 | 高 | 按 Phase 拆 commit；保留非 admin 登录契约；逐步集成测试 |
| 机密经新字段进入日志 | 中 | 高 | redact 白名单、专用安全事件 serializer、回归测试 |
| P0 范围蔓延到所有风控/隐私事项 | 高 | 中 | checklist 拒收范围外；另建 follow-up spec |

---

## 9. 度量与完成信号

| 信号 | 目标 |
| --- | --- |
| admin 无 MFA 登录成功率 | 0 |
| admin API 因缺 MFA 拒绝 | 发布后短期可观测，稳定后接近 0 |
| 活跃管理员 MFA 覆盖 | 100% |
| session revoke 后 refresh 成功 | 0 |
| MFA secret / recovery code 日志泄露 | 0 |
| bcrypt 12 覆盖 | 新写入 100%；活跃用户随成功登录逐步升高 |

---

## 10. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-07-27 | 初版，聚焦管理员 MFA、设备会话与 bcrypt 收口 |
| 1.1.0 | 2026-07-27 | 明确 P6a rebase gate、两阶段生成 migration/回填策略与零干扰验证入口 |
| 1.2.0 | 2026-07-27 | 记录仓库负责人对隔离并行实现的授权；保留 P6a 合入后的 PR 前 rebase/迁移复核 |
| 1.3.0 | 2026-07-27 | 采用已验证的 `gen_random_uuid()` database default，实现可原子部署的单 migration；回填改为 legacy admin 吊销命令 |
| 1.4.0 | 2026-07-27 | 固化 M3-only migration timestamp 纠正流程，防止 Prisma UTC 命名排在已知 P6a migration 之前 |
| 1.5.0 | 2026-07-27 | 将 legacy fixture/replay 明确为同一可丢弃专用库的连续验证，不创建第二数据库 |
| 1.6.0 | 2026-07-27 | 依据 auth/session impact review 将稳定会话族前置于 MFA 集成，并冻结 `sid`、current logout 与 bcrypt pre-auth 边界 |
| 1.7.0 | 2026-07-27 | 同步 I-01 专用库 migration/status/drift 证据；不改变后续实施顺序 |
| 1.8.0 | 2026-07-27 | 同步 I-01 全量隔离后端回归证据；不改变后续实施顺序 |
| 1.9.0 | 2026-07-27 | 同步 I-01 本地完成 / G-PR-01 PR 闸门分离；不改变后续实施顺序 |
| 1.10.0 | 2026-07-27 | 同步 I-02 安全原语、受控审计与日志脱敏的本地验证证据；不改变后续实施顺序 |
| 1.11.0 | 2026-07-27 | 冻结显式 session revoke 与 rotation replay 的区分，保证 AC-05 当前设备不被已吊销其他设备的 cookie 重放误伤 |
| 1.12.0 | 2026-07-27 | 将 D-07 落为可执行并发方案：同用户 advisory xact lock、锁后重读、family marker 优先与 stale-cookie logout；新增并发排序验收 |
| 1.13.0 | 2026-07-27 | 补齐 D-07 锁协议的精确调用图、登录锁后凭据复核、closed revoke reason/audit 与“无需 migration”边界 |
| 1.14.0 | 2026-07-27 | P1 并发复审将管理员封禁/商家角色变化纳入固定锁序：先 user advisory lock，再写 `User`，并以真实 PostgreSQL 事务验证无锁顺序反转 |
| 1.15.0 | 2026-07-27 | I-03 本地交付并验证该锁序：三条管理员路径与 password-style 写入真实并发通过；全量后端 65 files / 520 tests、server/root build 均通过 |
| 1.16.0 | 2026-07-28 | P6/P7 已进入 develop 后完成 M3 独立 rebase，启动 I-04；保持独立 worktree/runtime 边界 |
| 1.17.0 | 2026-07-28 | I-04 将订单文件仲裁取证与 public announcement 的 admin audience 接入统一 MFA/session 校验 |
| 1.18.0 | 2026-07-28 | 密码安全边界细化：管理员成功改密/重置在同一锁定事务消费所有 pre-auth challenge、递增 MFA version、再吊销 session |
| 1.19.0 | 2026-07-28 | 补齐 D-04 已冻结的离线 break-glass：明确服务级原子操作、无 controller/route、恢复码/challenge/seed/session 全量作废与 caseRef 审计 |
| 1.20.0 | 2026-07-28 | break-glass 最小暴露审计：已消费的 pending challenge 同时清空加密 seed，不留无用的密文材料 |
| 1.21.0 | 2026-07-28 | P6→develop rebase 已完成，Phase D 的 ProfilePage ownership gate 解除；I-05 仍受独立 worktree/runtime 与前端秘密不持久化约束。 |
| 1.22.0 | 2026-07-28 | Phase D 的 P0 前端路径已在 M3 专用 worktree 完成并以独立 UI suite 验证；Phase E 的真实整栈 E2E、文档与发布门槛仍保持未完成。 |
| 1.23.0 | 2026-07-28 | Phase E 编码前冻结真实 E2E 的 fixture、TOTP、双 context 吊销、严格 cleanup 和专用 runner 方案；mock UI suite 明确不承担 AC-08。 |
| 1.24.0 | 2026-07-28 | Phase E 运维实现细化：break-glass 只经受限离线 CLI 触达原子服务，production preflight 同步验证 canonical 32-byte MFA key。 |
| 1.25.0 | 2026-07-28 | I-06 复审收紧 real-E2E 证据：DB 必须在 config 启动前拒绝错误目标，context 显式 baseURL、失败产物关闭；新增确定性错 TOTP、真实 recovery 单次性、精确单设备吊销与 admin stats 断言。 |
| 1.26.0 | 2026-07-28 | I-06 以单一隔离 verifier 完成本地执行：38 migrations status/drift clean、76 files / 618 tests、双端 build、staging template guard 与 10/10 M3 Playwright PASS；PR/CI/发布门槛未因本地证据自动解除。 |
| 1.27.0 | 2026-07-28 | PR #53 CI 复审将默认/隔离 Playwright 的收集边界补为可执行规则：默认 E2E ignore real spec，M3 config 独占 real fixture 与数据库。 |
