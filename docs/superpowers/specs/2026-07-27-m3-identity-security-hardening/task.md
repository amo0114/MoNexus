# Task Breakdown: M3 身份与特权操作安全收口

| 字段 | 值 |
| --- | --- |
| 文档 ID | TASK-M3-ISH-001 |
| 版本 | 1.0.0 |
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

1. 先完成 T-00 并在 PR 写明 D-01 至 D-06 的确认结论。
2. 后端行为先写失败测试；安全代码不得靠测试专用 bypass 或睡眠等待。
3. 迁移只通过 prisma migrate dev 生成；绝不把 MFA secret、recovery code、challengeId 或真实 key 放进 fixture、snapshot 或 commit。
4. 共享文件 service.ts、routes.ts、auth middleware、LoginPage、ProfilePage 一次只能有一个集成负责人修改，避免“各自正确、合并失效”。
5. 每完成一张任务卡，将状态改为 Done，并同步 checklist 证据。

### 1.3 状态看板

| ID | 状态 | 负责人 | 备注 |
| --- | --- | --- | --- |
| T-00 | Done | Codex | 基线与决策确认（证据见 implement.md §7） |
| T-BE-01 | In Progress | Codex | 经负责人授权在隔离 worktree 并行实现；P6a 合入后、PR 前必须 rebase/复核 |
| T-BE-02 | Todo | | MFA crypto、challenge、redact、安全事件 |
| T-BE-03 | Todo | | MFA 登录/绑定 API |
| T-BE-04 | Todo | | RefreshToken session family 与会话 API |
| T-BE-05 | Todo | | admin guard、bcrypt 升级、回归集成 |
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
| T-00 | 确认安全决策并跑基线 | P0 | S | — | 0 | D-01..D-06 |
| T-BE-01 | 演进身份与 session 数据模型 | P0 | M | T-00 | A | F-020, NF-01 |
| T-BE-02 | 建立 TOTP、加密、challenge、redact 与安全事件原语 | P0 | L | T-BE-01 | A | F-010–013, F-030–031 |
| T-BE-03 | 实现管理员 MFA 登录与首次绑定 API | P0 | L | T-BE-02 | B | F-010–014 |
| T-BE-04 | 实现稳定会话族与会话管理 API | P0 | L | T-BE-01 | C | F-020–023 |
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

- [x] 记录 D-01 至 D-06 已冻结；D-03 仅实施“登录 MFA + admin 活动会话校验”，不在本波加入逐操作 step-up。
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
- [ ] 向 User、RefreshToken 添加 spec §5.1 所需字段、关系与会话查询索引；`sessionId` 是 family 标识，**不得**建全局 unique。
- [ ] 新增 MfaRecoveryCode、AuthChallenge、SecurityEvent 模型；recovery/challenge 可随 User 清理，SecurityEvent 必须保留审计（`userId` 可 SetNull），并在 test setup 显式清理全部三个新模型。
- [ ] 为 MFA_ENCRYPTION_KEY 建立严格规范 base64 32-byte env parser；production 缺失/格式错误启动失败，vitest 只注入格式正确的测试值，不在 `.env` 提供默认 key。
- [ ] 将 `sessionId` 声明为 `@default(dbgenerated("gen_random_uuid()")) @db.Uuid`，session 时间声明为数据库 timestamp default；生成的 SQL 必须含 PostgreSQL default，不能使用 client-side `uuid()` 误充历史数据回填。
- [ ] 在专用库生成一个 migration（目录时间戳必须排序在 P6a migration 之后）：`DATABASE_URL="$M3_ISH_DATABASE_URL" npx prisma migrate dev --name identity_security_hardening`。`M3_ISH_DATABASE_URL` 必须显式指向 `monexus_m3_ish_test`；shadow database 也必须是隔离资源。
- [ ] 在独立 `monexus_m3_ish_migration_test` 先创建 legacy User/RefreshToken fixture，再应用 migration；断言既有行 `sessionId` 非空且彼此不同、session 时间非空，并检查生成 SQL 的 database default。
- [ ] 写并测试幂等、分批的 legacy-admin revoke 命令：仅吊销 migration 前的 admin refresh token，写受控 revoke reason，不写/不回显 tokenHash 或其他秘密。
- [ ] 运行 `DATABASE_URL="$M3_ISH_DATABASE_URL" npx prisma migrate status` 与 drift 检查；增加 migration/config/revoke guard 测试。

**DoD：** 单一 Prisma-generated database-default migration、legacy fixture、legacy-admin revoke、migrate status/drift、config production guard 通过；无 secret default、无共享库/共享 shadow DB 访问。

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

- [ ] 安装最小 TOTP 依赖；不引入认证框架或远程 MFA 服务。
- [ ] 实现 CSPRNG seed、AES-256-GCM encrypt/decrypt、provisioning URI、固定时间可注入 TOTP verify。
- [ ] 实现 recovery code 生成、hash、原子一次性 claim；生成数量固定为 10。
- [ ] 实现 AuthChallenge 创建、读取、失败计数、原子 consume；TTL=5min、max attempts=5。
- [ ] 实现 SecurityEvent 的受控 type/detailSafe serializer 和 IP HMAC / device hint。
- [ ] 将 mfaCode、recoveryCode、recoveryCodes、challengeId、manualKey、provisioningUri、mfaSecret、MFA_ENCRYPTION_KEY 添加到 Pino redact；不要用过宽泛路径掩盖无关业务审计。
- [ ] 写测试：正确/错误 key、tamper tag、相邻 TOTP window、过期/超限 challenge、恢复码重放、logger 无明文。

**DoD：** 所有 crypto/secret 测试绿；测试输出本身也不回显秘密。

---

### T-BE-03 — 实现管理员 MFA 登录与首次绑定 API

**类型：** backend  
**依赖：** T-BE-02  
**需求：** REQ-F-010–014
**建议 Owns：**

- server/src/modules/auth/service.ts
- server/src/modules/auth/controller.ts
- server/src/modules/auth/schema.ts
- server/src/modules/auth/routes.ts
- server/src/lib/cookies.ts（只有确有 cookie 契约改动才触碰）
- server/src/__tests__/auth-mfa.test.ts（新）

**步骤：**

- [ ] 将 login 返回类型建成明确 union：非 admin 正常登录；admin 返回 enrollment 或 login challenge。
- [ ] 断言 challenge 响应绝不设置 refresh cookie 或 access token。
- [ ] 添加 enrollment start / confirm 与 MFA verify 的 schema 和 route；恢复码只作为首次绑定/登录因子，不在本 P0 任务加入重生或换机 endpoint。
- [ ] confirm / verify 使用事务完成 challenge claim、MFA state、recovery hash、安全事件、refresh session 创建；中间任一步失败都不能半写。
- [ ] 已绑定 admin 只能经 method=totp 或 method=recovery 登录；错码、超限、已用 code 均无会话副作用。
- [ ] 实现离线 break-glass 所需的可复用服务级原子操作，但不暴露 HTTP route；是否由 runbook / script 调用由 T-DOC-01 约束。

**DoD：** AC-01 至 AC-03 后端通过；普通用户/商家 login 契约未变化。

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

**步骤：**

- [ ] 首次 login/register token 行创建 sessionId；rotation 继承 sessionId/sessionStartedAt 并刷新 lastUsedAt。
- [ ] list API 只查询 owner 的 active、未过期 session；输出脱敏 summary，current 来自 JWT sid。
- [ ] DELETE sessionId 使用 owner-scoped update；非 owner、随机 UUID 都返回 404。
- [ ] revoke-others 排除 current sessionId；当前 logout 继续只吊销当前族。revoke-all 留给 P1 的 T-BE-06。
- [ ] 所有吊销写 session_revoked SecurityEvent，reason 采用受控枚举。
- [ ] 保持 refresh replay 的 revoke-all-user 语义，并记录 session_replay_detected。
- [ ] 写两 session、两用户、轮换继承、单吊销、其他吊销、replay 回归测试。

**DoD：** AC-05 通过；任何 API 响应不含 raw IP、完整 UA、tokenHash。

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

- [ ] AuthPayload 增加 sid、mfaVerified、mfaVersion；所有完成 MFA 的 admin token 填充正确 claims。
- [ ] 实现 requireAdminMfa：验证 claims、User MFA 版本/状态与活动 RefreshToken session。
- [ ] 在 admin 路由组 requireAdmin 后挂载；不得漏掉 portable-backups 等子路由。
- [ ] 发布兼容：缺 sid / 无 MFA claim 的旧 admin token 一律拒绝；旧 admin refresh token 不能续签。
- [ ] 将 bcrypt rounds 固定为 12；注册/改密/重置直接使用 12；正确旧 hash 登录时重哈希，错误密码不写。
- [ ] 覆盖：旧 admin token、被吊销 admin session、被封禁 admin、无 MFA cookie、普通 user admin API、rehash 成功/失败。

**DoD：** AC-04、AC-06、AC-07 通过；无 admin endpoint 绕过。

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
- [ ] 当前设备不可误显示为“其他”；单吊销/其他吊销均有确认与 loading 防重。
- [ ] 删除当前成功后调用 logout 并导航；删除其他成功后 re-fetch。
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
     ├─ T-BE-02 ── T-BE-03 ──┐
     └─ T-BE-04 ─────────────┼─ T-BE-05 ──┬─ T-QA-01 ── T-QA-02
                             │             ├─ T-FE-01 ────┘
                             │             ├─ T-FE-02 ────┘
                             │             └─ T-DOC-01
                             └─────────────────────────────

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
