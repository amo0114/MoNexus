# Plan: M3 身份与特权操作安全收口

| 字段 | 值 |
| --- | --- |
| 文档 ID | PLAN-M3-ISH-001 |
| 版本 | 1.9.0 |
| 日期 | 2026-07-27 |
| 状态 | Frozen for Implementation |
| 规格 | [spec.md](./spec.md)（SPEC-M3-ISH-001） |
| 任务分解 | [task.md](./task.md) |
| 验收清单 | [checklist.md](./checklist.md) |

> 实施前必须先确认 spec 的 D-01 至 D-06。所有工作从最新 develop 建 feature 分支并通过 PR 合回 develop。后端行为先写测试；不使用 git add -A；不以关闭 MFA 或测试后门换取绿灯。

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
| refresh replay | 保留“全用户 refresh token 全部吊销”的现有更强策略，并写 security event |

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
5. refreshAccessToken 继承 sessionId；读取 user 后若是 admin，额外确认 mfaEnabled，旧/异常 session 不得续签。
6. revoke 一个会话使用 sessionId 更新该族所有未撤销 RefreshToken；DELETE session 只接受非当前族，当前族始终使用既有 logout 并清 cookie。
7. bcrypt 工具统一为常量 PASSWORD_BCRYPT_ROUNDS=12；register、change password、reset password 使用它。只有成功完成正常会话创建的非 admin 登录，才检测 getRounds 后做 compare-and-set 式按需升级；admin MFA pre-auth 不保存密码且不重哈希。

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
| 阅读 spec / task，记录 D-01..D-06 已确认 | 无开放范围歧义 |
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
| session family 创建/refresh rotation 继承、会话列表、单个/其他吊销服务与 API（P0） | REQ-F-020–023 |
| owner 404、current DELETE 拒绝、脱敏 serializer、安全事件 | REQ-F-021, F-030 |
| refresh replay 回归与 JWT `sid` contract | REQ-F-020, DR-09 |

出口：AC-05 的后端测试全绿；session service 成为 MFA session creation / guard 的唯一族语义来源。

### Phase C — 后端 MFA 登录、admin guard 与 bcrypt（L）

| 交付 | 对应 |
| --- | --- |
| login 202 union 与 MFA enroll/verify controller、schema、routes | REQ-F-010–014 |
| JWT `sid` / MFA claims 与 requireAdminMfa | REQ-F-013–014, F-025 |
| bcrypt 12 / restricted opportunistic rehash | REQ-F-032 |
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

> **并行 gate：** 当前 P6a 正在修改 ProfilePage。安全分支可先新增独立 auth 组件与 API client，但不得编辑该挂载页；等 P6a 合入 develop 后先 rebase，再进行 Profile 会话管理集成。

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
| Integration | admin login 202 → enroll → verify → admin guard；challenge 超时/超限；recovery code；session list/revoke；refresh rotation/replay |
| Security regression | no cookie before MFA、旧 token 拒绝、owner 404、raw secret/log redaction、admin revoked token 立即拒绝 |
| E2E | admin 首次绑定与后续登录；两个 browser context 的 session revoke；非 admin 登录回归 |
| Build / deploy | frontend build、server build、Prisma migration status/drift、production env guard |

测试实现要求：

- 通过 injectable clock 或 TOTP adapter 固定时钟；禁止等待 30 秒。
- Playwright 可从首次绑定页面读取手动密钥并在测试进程生成 TOTP，不设后门 API。
- 单元/集成/迁移测试一律显式使用 `monexus_m3_ish_test`；不得在生产、共享开发库、P6a 库或默认 `monexus_test` 建测试管理员。
- 不得运行 `npm run verify:local(:no-e2e)` 或默认 `npm run e2e`：它们会管理共享 compose / 默认数据库 / 3000、5173。T-QA-02 必须新增专用验证入口，固定后端 3103、前端 5178、专用数据库，并设 `reuseExistingServer=false`；端口/数据库不可用即失败，不借用已有服务。
- 任何 log assertion 都只断言“秘密不存在”，不把秘密原样输出到失败信息。

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
