# Task Breakdown: M3 身份与特权操作安全收口

| 字段 | 值 |
| --- | --- |
| 文档 ID | TASK-M3-ISH-001 |
| 版本 | 1.20.0 |
| 日期 | 2026-07-27 |
| 规格 | [spec.md](./spec.md) |
| 计划 | [plan.md](./plan.md) |
| 清单 | [checklist.md](./checklist.md) |

---

## 1. 使用说明

### 1.1 WBS 约定

| 字段 | 含义 |
| --- | --- |
| ID | 稳定任务号，供 commit / PR / checklist 引用 |
| Pri | P0 为合并阻断；P1 是本波应完成但可经书面豁免拆 follow-up |
| 估算 | S ≤2h；M 2–6h；L 6–12h（单人有效工时） |
| 依赖 | 必须完成的前置任务 |
| DoD | 任务最小完成定义，不替代全量 checklist |

### 1.2 执行规则

1. 先完成 T-00 并在 PR 写明 D-01 至 D-07 的确认结论。
2. 后端行为先写失败测试；安全代码不得靠测试专用 bypass 或睡眠等待。
3. 迁移只通过 prisma migrate dev 生成；绝不把 MFA secret、recovery code、challengeId 或真实 key 放进 fixture、snapshot 或 commit。
4. 共享文件 service.ts、routes.ts、auth middleware、LoginPage、ProfilePage 一次只能有一个集成负责人修改，避免“各自正确、合并失效”。
5. 每完成一张任务卡，将状态改为 Done，并同步 checklist 证据。

### 1.3 状态看板

| ID | 状态 | 负责人 | 备注 |
| --- | --- | --- | --- |
| T-00 | Done | Codex | 基线与决策确认（证据见 implement.md §7） |
| T-BE-01 | Done | Codex | 本地交付 `2f212e8`；G-PR-01（P6a→develop rebase/复核）仍 pending，故不可开 PR |
| T-BE-02 | Done | Codex | 本地交付 `2483b0f`；12 条原语/日志测试与 server build PASS |
| T-BE-03 | Done | Codex | I-04 本地完成：MFA 登录/绑定、离线 break-glass 原子服务与 14 条定向回归通过；仍不可开 PR |
| T-BE-04 | Done | Codex | I-03 本地完成：会话 API、D-07 锁协议与三条管理员锁序回归均通过；P6c→develop rebase 仍阻止 PR |
| T-BE-05 | Done | Codex | I-04 本地完成：admin MFA guard、bcrypt 收口、非 admin-router 旁路收口与全量回归通过；仍不可开 PR |
| T-BE-06 | Todo | | P1：MFA 安全区与 revoke-all API |
| T-FE-01 | Todo | | LoginPage MFA 流 |
| T-FE-02 | Todo | | 账户安全与设备会话 UI |
| T-FE-03 | Todo | | P1：恢复码重生、换机与全会话退出 UI |
| T-QA-01 | Todo | | 后端安全/并发/迁移测试 |
| T-QA-02 | Todo | | Playwright 与全量验证 |
| T-DOC-01 | Todo | | OpenAPI、README、runbook、secrets |

状态枚举：Todo | In Progress | Blocked | Done | Cancelled。

---

## 2. 任务总表

| ID | 标题 | Pri | 估算 | 依赖 | Phase | 需求 |
| --- | --- | --- | --- | --- | --- | --- |
| T-00 | 确认安全决策并跑基线 | P0 | S | — | 0 | D-01..D-07 |
| T-BE-01 | 演进身份与 session 数据模型 | P0 | M | T-00 | A | F-020, NF-01 |
| T-BE-02 | 建立 TOTP、加密、challenge、redact 与安全事件原语 | P0 | L | T-BE-01 | A | F-010–013, F-030–031 |
| T-BE-03 | 实现管理员 MFA 登录与首次绑定 API | P0 | L | T-BE-02, T-BE-04 | C | F-010–014 |
| T-BE-04 | 实现稳定会话族与会话管理 API | P0 | L | T-BE-01 | B | F-020–023 |
| T-BE-05 | 挂载 MFA 守卫并完成 bcrypt 收口 | P0 | M | T-BE-03, T-BE-04 | B/C | F-014, F-025, F-032 |
| T-BE-06 | MFA 安全区与 revoke-all API | P1 | M | T-BE-03, T-BE-04, T-BE-05 | C/D | F-015, F-016, F-024 |
| T-FE-01 | 实现登录 MFA challenge / 绑定 UX | P0 | L | T-BE-03 | D | F-010–013 |
| T-FE-02 | 实现账户安全与设备会话 UX | P0 | M | T-BE-04, P6a→develop 后 rebase | D | F-021–023 |
| T-FE-03 | MFA 安全区与全会话退出 UX | P1 | M | T-BE-06, P6a→develop 后 rebase | D | F-015, F-016, F-024 |
| T-QA-01 | 补后端行为、秘密与迁移回归测试 | P0 | L | T-BE-05 | E | AC-01–07 |
| T-QA-02 | 补 E2E 并运行全量门禁 | P0 | M | T-FE-01, T-FE-02, T-QA-01 | E | AC-08 |
| T-DOC-01 | 同步契约与受控恢复运行手册 | P1 | M | T-BE-05 | E | NF-01, F-030 |

---

## 3. 详细任务卡

### T-00 — 确认安全决策并跑基线

**类型：** setup / spike  
**要求：** 从最新 develop 创建 feat/m3-identity-security-hardening；不在 develop 直接写代码。

**只读优先文件：**

- docs/superpowers/specs/2026-07-27-m3-identity-security-hardening/spec.md
- server/prisma/schema.prisma
- server/src/modules/auth/service.ts、controller.ts、schema.ts、routes.ts
- server/src/middlewares/auth.ts
- server/src/lib/logger.ts、server/src/config/index.ts
- server/src/__tests__/auth.test.ts、auth-tokens.test.ts、refresh-token-wiring.test.ts、auth-active-user.test.ts

**步骤：**

- [x] 记录 D-01 至 D-07 已冻结；D-03 仅实施“登录 MFA + admin 活动会话校验”，不在本波加入逐操作 step-up；D-07 规定 explicit revoke 不扩大为全用户 replay。
- [x] 记录部署前提：secrets owner 必须在发布前为所有 API 实例配置同一枚 32-byte base64 `MFA_ENCRYPTION_KEY`；不读取或创建真实值，实际配置保留为 `CHK-REL-01` 发布门禁。
- [x] 确认隔离 PostgreSQL 已可用：只使用 `monexus_m3_ish_test`；不启动、停止或重启 P6a 的 compose 服务。
- [x] 运行 auth 基线（4 files、36 tests PASS）：

~~~text
cd server
TEST_DATABASE_URL='postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_m3_ish_test?schema=public' npx vitest run auth auth-tokens refresh-token-wiring auth-active-user
~~~

- [x] 运行 `npm --prefix server run build` 与 `npm run build`（均 PASS）。
- [x] 写入本任务的 implement/checklist 基线证据，不复制 token、cookie 或环境值。

**DoD：** 决策无歧义，四个 auth 测试集和双端 build 绿。

---

### T-BE-01 — 演进身份与 session 数据模型

**类型：** backend / migration  
**需求：** REQ-F-020、REQ-NF-01  
**建议 Owns：**

- server/prisma/schema.prisma
- server/prisma/migrations/（仅 prisma migrate dev 生成的产物）
- server/src/config/index.ts
- server/.env.example
- .env.example
- server/src/scripts/revokeLegacyAdminRefreshSessions.ts（新，受版本控制、只由部署 runbook 调用）
- server/vitest.config.ts、server/src/__tests__/config-production-guards.test.ts、server/src/__tests__/setup.ts
- 迁移 legacy-fixture / legacy-admin revoke 专用测试

**步骤：**

- [x] 仓库负责人已授权在隔离 worktree 并行开始；记录基线 `bf25d01` 与 P6a 预期 migration `20260727090000_p6a_subscription_foundation`。P6a 合入后、开 PR 前必须 rebase、人工确认 schema/migration 均保留并记录新的 HEAD。
- [x] 向 User、RefreshToken 添加 spec §5.1 所需字段、关系与会话查询索引；`sessionId` 是 family 标识，**不得**建全局 unique。
- [x] 新增 MfaRecoveryCode、AuthChallenge、SecurityEvent 模型；recovery/challenge 可随 User 清理，SecurityEvent 必须保留审计（`userId` 可 SetNull），并在 test setup 显式清理全部三个新模型。
- [x] 为 MFA_ENCRYPTION_KEY 建立严格规范 base64 32-byte env parser；production 缺失/格式错误启动失败，vitest 只注入格式正确的测试值，不在 `.env` 提供默认 key。
- [x] 将 `sessionId` 声明为 `@default(dbgenerated("gen_random_uuid()")) @db.Uuid`，session 时间声明为数据库 timestamp default；生成的 SQL 必须含 PostgreSQL default，不能使用 client-side `uuid()` 误充历史数据回填。
- [x] 在专用库生成一个 migration（目录时间戳必须排序在 P6a migration 之后）：`DATABASE_URL="$M3_ISH_DATABASE_URL" npx prisma migrate dev --name identity_security_hardening`。`M3_ISH_DATABASE_URL` 必须显式指向 `monexus_m3_ish_test`；shadow database 也必须是隔离资源。若 Prisma UTC timestamp 仍较早，只可重命名未提交的 M3-only 目录，校验 migration.sql hash 不变后 reset/replay 专用库；绝不动 P6a 目录。
- [x] 在同一可丢弃专用 `monexus_m3_ish_test` 先创建 legacy User/RefreshToken fixture，再应用 migration；断言既有行 `sessionId` 非空且彼此不同、session 时间非空，并检查生成 SQL 的 database default；之后 reset/replay 此同一专用库。不得创建或连接额外的非专用数据库。
- [x] 写并测试幂等、分批的 legacy-admin revoke 命令：仅吊销 migration 前的 admin refresh token，写受控 revoke reason，不写/不回显 tokenHash 或其他秘密。
- [x] 运行 `DATABASE_URL="$M3_ISH_DATABASE_URL" npx prisma migrate status` 与 drift 检查；增加 migration/config/revoke guard 测试。

**DoD：** 单一 Prisma-generated database-default migration、legacy fixture、legacy-admin revoke、migrate status/drift、config production guard 通过；无 secret default、无共享库/共享 shadow DB 访问。**该本地 DoD 不解除 P6a 合入后的 rebase/人工复核/复验闸门。**

**本地证据（2026-07-27；仍不可开 PR）：**

- M3-only migration：`20260727110000_identity_security_hardening`；`migration.sql` SHA-256 为 `d7674f9747f7fdfd32e7272d678f45ce3b9e96d35fd59cbcbfab3c5ec441e55a`。Prisma UTC 生成的未提交 M3-only 目录曾早于已知 P6a timestamp，重命名后 SQL hash 不变。
- 同一可丢弃 `monexus_m3_ish_test`：pre-migration legacy RefreshToken fixture → generated migration，既有行获得非空且彼此不同的 UUID、非空 session 时间；随后 reset/replay 同一专用库。
- `DATABASE_URL="$M3_ISH_DATABASE_URL" npx prisma migrate status`：32 migrations、schema up to date；`prisma migrate diff --from-url "$M3_ISH_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code`：No difference detected。
- 定向验证：`config-production-guards`、`auth-identity-foundation`、`legacy-admin-session-revocation` 共 14 tests PASS；`npm --prefix server run build` PASS。全量后端回归：`TEST_DATABASE_URL="$M3_ISH_DATABASE_URL" npm --prefix server test`，62 files / 497 tests PASS（712.46s）。上述命令只指向专用库，未调用 compose/共享端口。

---

### T-BE-02 — 建立 MFA 安全原语

**类型：** backend  
**依赖：** T-BE-01  
**需求：** REQ-F-010–013、REQ-F-030–031、REQ-NF-02–03、NF-08  
**建议 Owns：**

- server/package.json、server/package-lock.json
- server/src/modules/auth/mfa.ts（新）
- server/src/modules/auth/securityEvents.ts（新）
- server/src/lib/logger.ts
- server/src/__tests__/auth-mfa-crypto.test.ts（新）

**步骤：**

- [x] 安装最小 TOTP 依赖；不引入认证框架或远程 MFA 服务。
- [x] 实现 CSPRNG seed、AES-256-GCM encrypt/decrypt、provisioning URI、固定时间可注入 TOTP verify。
- [x] 实现 recovery code 生成、hash、原子一次性 claim；生成数量固定为 10。
- [x] 实现 AuthChallenge 创建、读取、失败计数、原子 consume；TTL=5min、max attempts=5；pending seed 只由 MFA 模块加密后写入。
- [x] 实现 SecurityEvent 的受控 type/detailSafe serializer 和 IP HMAC / device hint。
- [x] 将 mfaCode、recoveryCode、recoveryCodes、challengeId、manualKey、provisioningUri、mfaSecret、MFA_ENCRYPTION_KEY 及 MFA API body 的 `code` 添加到 Pino redact；根业务 error `code` 保持可观测。
- [x] 写测试：正确/错误 key、tamper tag、相邻 TOTP window、过期/超限 challenge、恢复码重放、logger 无明文。

**DoD：** 所有 crypto/secret 测试绿；测试输出本身也不回显秘密。

**本地证据（2026-07-27；仍不可开 PR）：** `2483b0f`；`otpauth@9.4.1`；`auth-mfa-crypto` 与 `auth-security-events` 共 12 tests PASS，`npm run build` PASS。只使用 `monexus_m3_ish_test`；独立只读安全复审发现的 MFA API `code` 日志泄露风险已由 request/error body 精确脱敏与回归测试关闭。测试失败只报告安全字段名或布尔结果，不回显 seed、TOTP 或 recovery code。

---

### T-BE-03 — 实现管理员 MFA 登录与首次绑定 API

**类型：** backend  
**依赖：** T-BE-02、T-BE-04
**需求：** REQ-F-010–014
**建议 Owns：**

- server/src/modules/auth/service.ts
- server/src/modules/auth/controller.ts
- server/src/modules/auth/schema.ts
- server/src/modules/auth/routes.ts
- server/src/modules/orders/routes.ts（仅 admin 文件仲裁取证路径的条件 MFA guard；不改 buyer/merchant 语义或 fileAccess）
- server/src/modules/announcements/controller.ts（仅 admin audience 解析复用 MFA/session 校验；失败降级 visitor，不改公共 all 公告）
- server/src/lib/cookies.ts（只有确有 cookie 契约改动才触碰）
- server/src/__tests__/auth-mfa.test.ts（新）

**步骤：**

- [x] 将 login 返回类型建成明确 union：非 admin 正常登录；admin 返回 enrollment 或 login challenge。
- [x] 断言 challenge 响应绝不设置 refresh cookie 或 access token。
- [x] 添加 enrollment start / confirm 与 MFA verify 的 schema 和 route；恢复码只作为首次绑定/登录因子，不在本 P0 任务加入重生或换机 endpoint。
- [x] confirm / verify 使用事务完成 challenge claim、MFA state、recovery hash、安全事件、refresh session 创建；中间任一步失败都不能半写。
- [x] enrollment confirm 在同一用户 advisory lock 内二次确认 `mfaEnabled=false`，并消费其余未消费 enrollment challenge；同一或旧 challenge 不能覆盖已启用的 seed / recovery code。
- [x] 已绑定 admin 只能经 method=totp 或 method=recovery 登录；错码、超限、已用 code 均无会话副作用。
- [x] 实现离线 break-glass 所需的可复用服务级原子操作 `resetAdminMfaForBreakGlass({ userId, caseRef })`，但不暴露 HTTP route；在同一 user advisory lock transaction 内清空 User 与 pending challenge 的 MFA seed/verified 状态、作废未用 recovery code/未消费 challenge、bump mfaVersion、以 `mfa_break_glass_reset` 吊销全部 session 并写受控 caseRef SecurityEvent。是否由 runbook / script 调用由 T-DOC-01 约束。

**DoD：** AC-01 至 AC-03 后端通过；普通用户/商家 login 契约未变化。

**本地证据（2026-07-28；仍不可开 PR）：** `auth-mfa` 14/14 PASS，覆盖首次绑定、TOTP/recovery、并发 enrollment 单胜者、挑战超限、离线 break-glass 成功/审计回滚/非 admin 拒绝与无 HTTP route；全量 server 为 75 files / 611 tests PASS（915.71s），只使用 `monexus_m3_ish_test`。

---

### T-BE-04 — 实现稳定 session family 与会话管理 API

**类型：** backend  
**依赖：** T-BE-01  
**需求：** REQ-F-020–023
**建议 Owns：**

- server/src/modules/auth/sessionService.ts（新，或受控拆分）
- server/src/modules/auth/service.ts（只在已协商 API 边界后）
- server/src/modules/auth/controller.ts
- server/src/modules/auth/schema.ts
- server/src/modules/auth/routes.ts
- server/src/__tests__/auth-sessions.test.ts（新）
- server/src/modules/admin/service.ts（仅 P1 死锁修复：import 与 ban / approve / suspend 三个事务中的 lock 调用；不得重排或触碰 P6 业务逻辑）

**D-07 追加边界（不新增 migration）：** 本任务可在上述 auth/session owned files 内新增 user-scoped transaction lock 与全用户 revoke audit。P1 并发复审推翻了“完全不改 admin service”的旧边界：`banUser`、`approveMerchant`、`suspendMerchant` 均在同一事务内先写 `User`、后调用会取得 session lock 的 helper，和改密/重置形成锁顺序反转。仅在本隔离 worktree 对这三处增加 lock-before-write；不改 P6 业务分支、SQL 或格式。任何直接新写 `RefreshToken` 的后续 MFA 代码必须复用本任务创建的 locked helper。

**步骤：**

- [x] 首次 login/register token 行创建 sessionId；login 在锁内重读 status/password 后才创建 initial token，注册在锁内重读可登录状态；rotation 继承 sessionId/sessionStartedAt 并刷新 lastUsedAt；所有创建、rotation、单族/其他/全用户吊销先获取同一 user 的 PostgreSQL transaction advisory lock，锁后重新读取状态；缺 `sid` 的 legacy access token 保持普通业务 API 兼容，但 session management 以 401 要求 refresh/login。
- [x] list API 只查询 owner 的 active、未过期 session；输出脱敏 summary，current 来自 JWT sid。
- [x] DELETE sessionId 使用 owner-scoped update，但只允许非 current family；非 owner、随机 UUID 都返回 404，current family 返回 `CURRENT_SESSION_REQUIRES_LOGOUT`，只能经既有 `/auth/logout` 吊销。
- [x] revoke-others 排除 current sessionId；当前 logout 继续只吊销当前族，即使其 raw cookie 已被 concurrent rotation 消费也要终结所属活动族。revoke-all 留给 P1 的 T-BE-06。
- [x] 所有吊销写 session_revoked SecurityEvent，reason 采用受控枚举。
- [x] 全用户 revoke 的新写入默认 reason=`revoke_all`，并在同一 tx 写受控 `session_revoked`（按 family 计数）；null reason 仅保留给历史行。密码 reset/change 与现有 ban/role 调用必须经该 helper，不直接 update RefreshToken。若同一 tx 会写 `User`，先取得 user advisory lock、再 `tx.user.update`，helper 的同 tx 重入锁保持安全；封禁、审核通过与停用商家三处全部遵守。
- [x] rotation 消费 token 与无原因 legacy revoked token 保持 revoke-all-user + session_replay_detected；服务端明确的 logout/single_session/revoke_others/revoke_all 等终结 reason 只拒绝该会话，不能误伤当前族。旧 rotation predecessor 必须检查同 family 的终结 marker，不能仅按本行 reason 判定。
- [x] 写两 session、两用户、轮换继承、单吊销、其他吊销、replay、rotation→explicit revoke→旧 predecessor refresh、rotation→stale-cookie logout、全用户 revoke 默认 reason/audit 回归测试；以真实 Prisma transaction 的 Promise gate / connection-affinity 证明同 user 锁排队，不用 sleep 或测试后门证明锁后排序。另以实际 `banUser`、`approveMerchant`、`suspendMerchant` 分别与持有同一 advisory lock 后写 `User` 的真实 PostgreSQL transaction 证明管理员路径先排队、password-style 路径可完成、双方不形成 advisory↔User 行锁反转。

**DoD：** AC-05 通过；显式吊销成功返回后不存在同家族 active successor；同一用户的 admin status/role 变化与 password-session mutation 不会形成 advisory↔`User` 行锁反转；任何 API 响应不含 raw IP、完整 UA、tokenHash。

**本地证据（2026-07-27；仍不可开 PR）：** `auth-sessions` 11/11 PASS（含三条真实管理员路径的 PostgreSQL lock-order 回归）；完整后端 `npm test` 为 65 files / 520 tests PASS（575.53s）；`npm --prefix server run build` 与根 `npm run build` PASS。二次独立安全复审无 P0/P1 阻断。所有测试只使用 `monexus_m3_ish_test`，未启动共享 runtime；P6c 未进入 develop 前 G-PR-01 继续阻止 PR。

---

### T-BE-05 — 挂载 admin MFA 守卫并完成 bcrypt 收口

**类型：** backend / integration  
**依赖：** T-BE-03、T-BE-04，以及 P6a 合入 develop 后的安全分支 rebase（当前 P6a 拥有 ProfilePage）  
**需求：** REQ-F-014、REQ-F-025、REQ-F-032  
**建议 Owns：**

- server/src/middlewares/auth.ts
- server/src/modules/admin/routes.ts
- server/src/modules/auth/service.ts
- server/src/__tests__/auth-mfa-guard.test.ts（新）
- server/src/__tests__/auth-tokens.test.ts

**步骤：**

- [x] AuthPayload 增加 sid、mfaVerified、mfaVersion；所有完成 MFA 的 admin token 填充正确 claims。
- [x] 实现 requireAdminMfa：验证 claims、User MFA 版本/状态与活动 RefreshToken session。
- [x] 在 admin 路由组 requireAdmin 后挂载；不得漏掉 portable-backups 等子路由。
- [x] 对 `/orders/:id/files/download-url` 增加仅 role=admin 才触发的同一 MFA guard；无 MFA / old session 不返回 URL、不写 FileGrantLog，买家/商家现有语义不变。
- [x] 公告 public audience resolver 不得只信任 admin role：admin 定向公告及其回执需要同一 MFA/session 校验；不满足时保持 visitor fallback，不泄露 admin audience。
- [x] 发布兼容：缺 sid / 无 MFA claim 的旧 admin token 一律拒绝；旧 admin refresh token 不能续签。
- [x] 将 bcrypt rounds 固定为 12；注册/改密/重置直接使用 12；仅非 admin 成功完成正常登录时对正确旧 hash 重哈希。错误密码、封禁和 admin MFA pre-auth 均不写 hash，也不把密码/等效材料存进 challenge。
- [x] 管理员成功改密或重置密码时，在既有 user advisory lock 事务内消费全部未消费 MFA pre-auth challenge、递增 mfaVersion、再吊销 refresh session；失败路径不得消费 challenge 或改变版本。
- [x] 覆盖：旧 admin token、被吊销 admin session、被封禁 admin、无 MFA cookie、普通 user admin API、旧 admin refresh 不轮换、rehash 成功/失败，以及密码变更前 challenge 在变更后不可完成 MFA 登录。

**DoD：** AC-04、AC-06、AC-07 通过；无 admin endpoint 绕过。

**本地证据（2026-07-28；仍不可开 PR）：** `auth-mfa` 14/14 PASS；`announcements` 14/14、文件交付 admin 取证关键分支 2/2、portable-backups routes 2/2 PASS；server build、root build、38 migrations status 与 drift 均 PASS / clean；全量 server 为 75 files / 611 tests PASS（915.71s）。

---

### T-BE-06 — MFA 安全区与 revoke-all API（P1）

**类型：** backend
**依赖：** T-BE-03、T-BE-04、T-BE-05
**需求：** REQ-F-015、REQ-F-016、REQ-F-024
**建议 Owns：**

- server/src/modules/auth/service.ts、controller.ts、schema.ts、routes.ts
- server/src/modules/auth/sessionService.ts
- server/src/__tests__/auth-mfa-security-settings.test.ts（新）

**步骤：**

- [ ] 添加恢复码剩余数的安全摘要；不得返回历史或未使用 recovery code 明文。
- [ ] 恢复码重生与换机都要求当前密码 + 现有 TOTP/recovery 因子；同一事务作废旧码，换机成功 bump mfaVersion 并吊销其他会话。
- [ ] 添加 owner-scoped revoke-all：吊销全部 session、清当前 refresh cookie、写受控 `session_revoked` 事件。
- [ ] 覆盖旧码失效、错误密码/因子不写入、换机后旧 admin token 失效、revoke-all 及 cookie 清理。

**DoD：** P1 API 不削弱 P0 MFA/session guard；所有新秘密仍只在单次响应出现。

---

### T-FE-01 — 实现登录 MFA challenge / 绑定 UX

**类型：** frontend  
**依赖：** T-BE-03  
**需求：** REQ-F-010–013  
**建议 Owns：**

- src/api/auth.ts
- src/pages/LoginPage.tsx
- src/components/auth/MfaEnrollment.tsx（新）
- src/components/auth/MfaVerification.tsx（新）
- 根 package.json、package-lock.json（若二维码库在 root 安装）

**步骤：**

- [ ] 将 login API 返回建模为 discriminated union；202 不触发 toast error 或 refresh。
- [ ] challengeId、manualKey、provisioningUri 仅放组件 state；unmount、取消、成功后主动清空。
- [ ] 首次绑定页显示二维码、手动 key、6 位输入；成功后显示 recovery codes 与“已保存”确认。
- [ ] 已绑定路径提供 TOTP / recovery code 切换，失败后保留正确阶段但清空 code。
- [ ] 不把 recovery codes 或 MFA seed 写入 useAuthStore、URL、console、analytics。
- [ ] 添加可访问 label、键盘焦点、data-testid；320px 宽度手工检查。

**DoD：** AC-01/02/03 的前端路径可用；普通登录不回归。

---

### T-FE-02 — 实现账户安全与设备会话 UX

**类型：** frontend  
**依赖：** T-BE-04
**需求：** REQ-F-021–023
**建议 Owns：**

- src/api/auth.ts
- src/pages/ProfilePage.tsx
- src/components/auth/SessionManager.tsx（新）

**步骤：**

- [ ] 给所有登录用户呈现活跃设备卡；加载失败不影响订单/积分页面。
- [ ] 在 P6a 合入/rebase 前，不得修改 ProfilePage；此时只允许实现独立组件和 API client。
- [ ] 当前设备不可误显示为“其他”；current family 不提供 DELETE，退出当前设备只走既有 logout；单吊销/其他吊销均有确认与 loading 防重。
- [ ] 删除其他成功后 re-fetch；logout 成功后由既有流程导航。
- [ ] 使用 API 返回的 deviceLabel/ipHint，前端不自行保存或猜测原始 UA/IP。

**DoD：** AC-05 手工通过，移动端无严重溢出，所有危险按钮二次确认。

---

### T-FE-03 — MFA 安全区与全会话退出 UX（P1）

**类型：** frontend
**依赖：** T-BE-06、P6a→develop 后 rebase
**需求：** REQ-F-015、REQ-F-016、REQ-F-024
**建议 Owns：**

- src/api/auth.ts
- src/pages/ProfilePage.tsx
- src/components/auth/AdminMfaSecurity.tsx（新）

**步骤：**

- [ ] 管理员显示 MFA 已开启与恢复码剩余数，但不显示 seed 或历史 recovery code。
- [ ] 恢复码重生、换机、退出全部设备都有“其他会话会失效”的确认与 loading 防重；退出全部成功后清本地 auth state 并导航登录。
- [ ] 从 API error 正确还原表单状态；challenge/手动密钥/recovery code 只在组件内存中，取消、unmount、成功后清空。
- [ ] 为上述高风险操作补可访问名称与稳定 data-testid。

**DoD：** P1 UI 不持久化秘密，且不会让 P0 SessionManager 的列表、单吊销和其他吊销回归。

---

### T-QA-01 — 补后端安全、并发与迁移回归测试

**类型：** test  
**依赖：** T-BE-05  
**需求：** AC-01–07、REQ-NF-01–09  
**建议 Owns：**

- server/src/__tests__/auth-mfa*.test.ts
- server/src/__tests__/auth-sessions.test.ts
- 现有 auth / refresh / admin guard 测试

**步骤：**

- [ ] 执行并补齐 spec 所有 AC 的 Given/When/Then 测试。
- [ ] 并发测试：同一个 challenge 的两个 confirm / verify 仅一个成功；同 recovery code 两次仅一次成功。
- [ ] 轮换和 replay 测试：sessionId 保持，重放仍全吊销。
- [ ] serializer test：session、安全事件、错误和 logger 均不含秘密/raw IP/完整 UA。
- [ ] migration invariant：database-default migration 后每条 legacy RefreshToken 都有初始独立 family ID，rotation 保持 family ID，新增索引/非空约束可用。
- [ ] 运行完整 server test。

**DoD：** 全量 vitest 绿，无通过删除或弱化现有 auth assertion 获得的绿。

---

### T-QA-02 — 补 E2E 并运行全量门禁

**类型：** test / integration  
**依赖：** T-FE-01、T-FE-02、T-QA-01  
**需求：** AC-08  
**建议 Owns：**

- e2e/admin-mfa.spec.ts（新）
- e2e/session-management.spec.ts（新）
- e2e helpers（确有需要时）
- playwright.m3-identity-security-hardening.config.ts（新）
- scripts/verify-m3-identity-security-hardening.sh（新）与根 package.json 的专用 script

**步骤：**

- [ ] E2E 首次 admin：password → QR/manual key → 生成 TOTP → bind → admin 页面。
- [ ] E2E 后续 admin：password → correct TOTP → admin；错误 TOTP 不进入后台。
- [ ] 两个 browser context 登录同用户，当前 context 吊销另一 context；验证另一 context refresh/admin API 被拒。
- [ ] 专用验证脚本必须拒绝非 `monexus_m3_ish_test` 目标、绝不调用 docker compose、绝不 reset/创建默认 `monexus_test`；只接受显式 `M3_ISH_DATABASE_URL` / `TEST_DATABASE_URL`。
- [ ] 专用 Playwright config 固定后端 3103、前端 5178、独立 browser context、`reuseExistingServer=false`；服务端 env 明确传入专用数据库、前端源、测试 JWT/MFA key。端口占用即失败，不复用 P6a / 默认服务。
- [ ] 运行专用验证入口、`npm --prefix server run build`、`npm run build`；不得运行 `npm run verify:local(:no-e2e)` 或默认 `npm run e2e`。
- [ ] 显式运行 `DATABASE_URL="$M3_ISH_DATABASE_URL" npx prisma migrate status` 和 drift 检查；记录命令和结果。

**DoD：** AC-08 通过；若 e2e 有既有 flaky retry，必须记录且不能掩盖本波失败。

---

### T-DOC-01 — 同步契约与受控恢复运行手册

**类型：** docs / ops  
**依赖：** T-BE-05  
**优先级：** P1（production release 前提升为 P0）  
**建议 Owns：**

- docs/superpowers/specs/monexus-api-openapi.json
- server/src/modules/auth/README.md
- docs/operations/runbook.md
- docs/operations/secrets-management.md
- 本目录 checklist.md 的证据栏

**步骤：**

- [ ] OpenAPI 写明 login 的 200/202 union、新 MFA 与 session 端点、401/403 错误码。
- [ ] auth README 描述 MFA/session invariants、rotation、普通 access token 与 admin immediate revoke 的差异。
- [ ] runbook 添加 key 配置、database-default migration/legacy-admin revoke 顺序、管理员首次绑定、双人 break-glass 与事件审查；不写真实 secret、recovery code 或 token。
- [ ] secrets inventory 增加 MFA_ENCRYPTION_KEY 的 owner、储存位置、轮换前提与恢复依赖。
- [ ] PR 描述链接本 spec，列 AC 结果和已知普通用户 access token 最长 15 分钟失效语义。

**DoD：** 文档可让无聊天上下文的运维人员安全执行发布与单 admin 恢复。

---

## 4. 依赖图

~~~text
T-00
 └─ T-BE-01
     ├─ T-BE-02 ─────────────┐
     └─ T-BE-04 ─────────────┼─ T-BE-03 ── T-BE-05 ──┬─ T-QA-01 ── T-QA-02
                              │                         ├─ T-FE-01 ────┘
                              │                         ├─ T-FE-02 ────┘
                              │                         └─ T-DOC-01
                              └─────────────────────────────────────────

P1 supplements after the P0 guard/session path:
T-BE-03 + T-BE-04 + T-BE-05 ──► T-BE-06 ──► T-FE-03
~~~

关键 P0 路径：

T-00 → T-BE-01 → T-BE-02 → T-BE-03 + T-BE-04 → T-BE-05 → T-FE-01 + T-FE-02 → T-QA-01 → T-QA-02。

---

## 5. 建议 commit 边界

| 任务组 | 建议 Conventional Commit |
| --- | --- |
| T-BE-01 | feat(auth): add mfa and refresh session schema |
| T-BE-02 | feat(auth): add encrypted totp security primitives |
| T-BE-03 + T-BE-05 | feat(auth): require mfa for administrator sessions |
| T-BE-04 | feat(auth): add device session management |
| T-BE-06 | feat(auth): add mfa security settings and revoke all |
| T-FE-01 | feat(ui): add administrator mfa login flow |
| T-FE-02 | feat(ui): add account device session controls |
| T-FE-03 | feat(ui): add administrator mfa security controls |
| T-QA-* | test(auth): cover mfa and session security flows |
| T-DOC-01 | docs(auth): document mfa session operations |

一个任务可按风险拆为多个 focused commit，但不要把 migration、秘密配置、前端视觉无关改动和业务功能混在同一 commit。

---

## 6. 完成定义

所有 P0 任务为 Done，且 checklist.md 的所有 P0 项均勾选，才可请求 PR → develop。production release 前，T-DOC-01 与发布演练也视为 P0，不允许以“文档后补”跳过 break-glass 与 secrets 说明。

---

## 7. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-07-27 | 初版 WBS，基于当前 auth / RefreshToken 实现 |
| 1.1.0 | 2026-07-27 | 增加 P6a rebase/两阶段迁移/专用验证门槛；将 F-015、F-016、F-024 收口为独立 P1 任务 |
| 1.2.0 | 2026-07-27 | 记录负责人授权的隔离并行实现；P6a rebase 保留为 PR 前强制步骤 |
| 1.3.0 | 2026-07-27 | 将无法原子部署的 two-phase backfill 改为已验证 PostgreSQL database default + legacy-admin revoke 命令 |
| 1.4.0 | 2026-07-27 | 记录 Prisma UTC timestamp 早于已知 P6a 时的 M3-only 无 SQL 改动重命名/replay 步骤 |
| 1.5.0 | 2026-07-27 | legacy fixture/replay 收口到同一可丢弃专用库，避免产生未验证的第二数据库依赖 |
| 1.6.0 | 2026-07-27 | 将 T-BE-04 前置为 MFA 集成前置条件；固定 JWT `sid`、非 current DELETE 与不跨 pre-auth 保存密码的 bcrypt 策略 |
| 1.7.0 | 2026-07-27 | 记录 T-BE-01 的 migration hash、legacy fixture/replay、status/drift 与定向验证证据；保留 P6a rebase 为未完成闸门 |
| 1.8.0 | 2026-07-27 | 补记 I-01 全量隔离后端回归：62 files、497 tests PASS；不改变 P6a rebase 闸门 |
| 1.9.0 | 2026-07-27 | 将本地任务完成与 PR 级 G-PR-01 闸门分离，T-BE-02 依此开始实施 |
| 1.10.0 | 2026-07-27 | 标记 T-BE-02 本地完成、启动 T-BE-04；记录 MFA 原语和日志安全复审/验证证据 |
| 1.11.0 | 2026-07-27 | 在 I-03 红测中解决 AC-05 与旧 replay 语义冲突，冻结 explicit revoke / rotation replay 分类 |
| 1.12.0 | 2026-07-27 | 基于 I-03 安全复审补充用户级事务锁、family marker 与 stale-cookie logout 的具体任务/DoD；无新增产品端点 |
| 1.13.0 | 2026-07-27 | 将 D-07 精确化为全 RefreshToken mutation 的 user lock 契约，列出 login/reset/change/global revoke/MFA 的接入点与无 migration 范围 |
| 1.14.0 | 2026-07-27 | P1 复审新增管理员三条 `User` 变更路径的锁序修复与真实 PostgreSQL 并发回归；以最小安全例外修改 shared admin service，仍不触碰 P6 业务逻辑 |
| 1.15.0 | 2026-07-27 | 标记 T-BE-04 / I-03 本地完成，回填三路径 lock-order、全量后端和双端构建证据；P6c rebase 闸门保持 pending |
| 1.16.0 | 2026-07-28 | 在 P6/P7 已进入 develop 后完成 M3 独立 worktree rebase，启动 I-04（T-BE-03 + T-BE-05）；仍不修改并行 worktree 或共享运行时 |
| 1.17.0 | 2026-07-28 | I-04 编码前只读安全复核发现 orders 文件仲裁取证及 public 公告中的 admin audience 不在 admin router；规范化为最小条件 MFA guard / visitor 降级，并收紧 enrollment sibling-challenge 单胜者约束 |
| 1.18.0 | 2026-07-28 | I-04 实现复核发现管理员密码变更会话吊销尚未作废已发出的 pre-auth challenge；先同步为同事务 challenge consume + `mfaVersion` bump，再补回归实现 |
| 1.19.0 | 2026-07-28 | I-04 复核发现 D-04 的 break-glass 原子服务仅有事件/枚举预置、尚无实现；先冻结其无 HTTP 路由、同事务全凭证作废与 caseRef 审计边界，再补实现/回归 |
| 1.20.0 | 2026-07-28 | break-glass 实现前残留审计收紧清理范围：pending enrollment/reconfigure challenge 的加密 seed 也必须置空，并由回归锁定 |
