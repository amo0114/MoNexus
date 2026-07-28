# Checklist: M3 身份与特权操作安全收口

| 字段 | 值 |
| --- | --- |
| 文档 ID | CHK-M3-ISH-001 |
| 版本 | 1.27.0 |
| 日期 | 2026-07-27 |
| 规格 | [spec.md](./spec.md) |
| 计划 | [plan.md](./plan.md) |
| 任务 | [task.md](./task.md) |

---

## 0. 使用方式

1. 实现中，每完成一项把 - [ ] 改成 - [x]，并在证据处记录 PR、commit、测试命令或 staging 记录。
2. 评审时抽查全部 P0；任一 P0 未勾选不得合入 develop。
3. P0 是身份安全硬门槛；P1 可以书面豁免，但 production release 前文档/runbook P1 自动升为 P0。
4. 任何豁免不得降低“管理员无 MFA 不能访问 admin API”或“秘密不泄露”的不变量。

### 签署

| 角色 | 姓名 | 日期 | 结果 |
| --- | --- | --- | --- |
| 实现者 | | | ☐ Ready for Review |
| Reviewer | | | ☐ Approved / ☐ Changes requested |
| QA | | | ☐ AC 通过 |
| 运维 / secrets owner | | | ☐ 发布密钥已就绪 |

---

## 1. 范围与过程门禁（P0）

- [ ] **CHK-PROC-01** PR 基于最新 develop，目标分支为 develop；未直接写 develop/master。
- [ ] **CHK-PROC-02** D-01 至 D-07 已确认；PR 链接本 spec 并明确 D-03 未实现 admin per-action step-up。
- [ ] **CHK-PROC-03** 范围只含管理员 MFA、设备会话、bcrypt、相关审计/文档；未混入 OAuth、Passkey、短信、通用风控、GDPR、订阅或支付。
- [ ] **CHK-PROC-04** 所有 P0 任务在 task.md 看板为 Done。
- [ ] **CHK-PROC-05** migration 由 prisma migrate dev 生成；没有手写 SQL migration 或绕过 migration 的 schema 变更。
- [ ] **CHK-PROC-06** diff 不含 .env、真实密钥、TOTP seed、recovery code、cookie、access/refresh token、数据库 dump。
- [ ] **CHK-PROC-07** 未通过测试后门、NODE_ENV 特判、sleep 重试或弱化旧断言获得绿灯。

**证据：** 2026-07-27 基线：`feat/m3-identity-security-hardening` 自 `origin/develop@bf25d01` 创建，独立 worktree；仅使用 `monexus_m3_ish_test`（Prisma 6.19.3，31 migrations up to date）。`auth/auth-tokens/refresh-token-wiring/auth-active-user`：4 files、36 tests PASS；frontend build 与 server build PASS。P6a 合入后必须 rebase 并重跑最终门禁。

---

## 2. 数据模型、密钥与迁移（P0）

- [ ] **CHK-DATA-01** User 有 mfaEnabled、加密 seed、mfaVersion 等必要字段；任何 public/profile/admin serializer 都没有选择 seed 字段。
- [x] **CHK-DATA-02** MfaRecoveryCode 只存 hash，有 user 归属、usedAt 和唯一性约束；无明文列。
- [x] **CHK-DATA-03** AuthChallenge 是随机 UUID、5 分钟、单次、最多 5 次失败；过期/超限/成功后不可复用。
- [x] **CHK-DATA-04** RefreshToken 有稳定 sessionId；同一 refresh rotation 的新旧 token 继承同一 sessionId 和 sessionStartedAt；sessionId 是 family ID，不能建 token 行全局 unique。
- [x] **CHK-DATA-05** SecurityEvent 只存安全事件 type、不可逆 IP 关联/安全 device hint 和安全摘要；不存秘密或原始 IP。
- [ ] **CHK-DATA-06** 单一 Prisma-generated migration 在隔离 PostgreSQL 成功应用：`sessionId` SQL default 为 `gen_random_uuid()`，pre-migration legacy token 均取得非空且彼此不同的 family ID / session 时间；部署前 legacy admin refresh session 全吊销；不得手改 SQL 或把 Prisma client-side uuid 当回填。
- [x] **CHK-DATA-07** 新增索引支持按 userId、sessionId、活动/过期状态列会话；会话列表不做全表扫描。
- [x] **CHK-DATA-08** MFA_ENCRYPTION_KEY 是 base64 32-byte 值；production 缺失/非法时服务拒绝启动；无默认生产 key。
- [x] **CHK-DATA-09** AES-256-GCM 对 seed 的 IV/tag/tamper failure 均正确处理；解密错误不返回内部详情。
- [x] **CHK-DATA-10** 所有 migrate/status/drift 命令显式传专用 `monexus_m3_ish_test` URL；shadow database 也是隔离资源，未调用默认 `monexus_test` / compose；若 Prisma UTC migration 目录需纠正，M3-only rename 的 SQL hash 与专用库 replay 证据齐全。

**I-01 pre-rebase 证据：** `20260727110000_identity_security_hardening`；SHA-256 `d7674f9747f7fdfd32e7272d678f45ce3b9e96d35fd59cbcbfab3c5ec441e55a`；同一 `monexus_m3_ish_test` legacy fixture → generated migration → reset/replay；`prisma migrate status` 为 32 migrations / up to date；`migrate diff --from-url "$M3_ISH_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` 为 No difference detected；config / foundation / revoke 14 tests PASS；隔离全量后端回归为 62 files / 497 tests PASS（712.46s）。P6a rebase 后必须重新核验；CHK-DATA-01、04、06 仍待后续 API/session 集成或发布动作。

---

## 3. 管理员 MFA（P0；显式标记 [P1] 的项不阻塞 P0 PR）

- [x] **CHK-MFA-01** admin 密码正确且 mfaEnabled=false 时仅返回 202 mfa_enrollment_required；没有 accessToken、refresh cookie 或后台数据。
- [x] **CHK-MFA-02** enrollment start 返回 QR provisioning URI 与手动密钥，但数据库只保留加密 pending seed。
- [x] **CHK-MFA-03** 正确 6 位 TOTP confirm 原子地开启 MFA、生成 10 枚 recovery code hash、写安全事件、建立新会话。
- [x] **CHK-MFA-04** recovery code 明文只在生成响应一次出现；之后 API 仅可见剩余数量，不能再次取回。
- [x] **CHK-MFA-05** mfaEnabled=true 的 admin 正确密码只返回 202 mfa_required；正确 TOTP 才有 cookie/token。
- [x] **CHK-MFA-06** 错误 TOTP、错误/已用 recovery code、过期/已消费/超限 challenge 都不创建 RefreshToken 或 access token。
- [x] **CHK-MFA-07** challenge 并发 confirm / verify 只有一个成功，另一个得到安全错误。
- [x] **CHK-MFA-08** 恢复码一次登录后立即标记 used；重复使用被拒并保留正确审计。
- [ ] **CHK-MFA-09** **[P1]** 管理员重生 recovery code 要求当前密码 + 当前 MFA 因子，旧码在同一事务作废。
- [ ] **CHK-MFA-10** **[P1]** 管理员换机/重绑定要求当前密码 + 因子；成功 bump mfaVersion、吊销其他会话、发新恢复码。
- [x] **CHK-MFA-11** 没有 HTTP “关闭 MFA”或任意管理员重置他人 MFA 的后门。
- [x] **CHK-MFA-12** TOTP 固定为 6 digits / 30 sec / window≤1；测试不依赖真实等待。
- [x] **CHK-MFA-13** 离线 `resetAdminMfaForBreakGlass` 仅为非路由服务：同一 user-lock transaction 清空 User 与 pending challenge 的 seed/verified 状态、作废 recovery/challenge、bump version、吊销 session 并写受控 caseRef；任一步失败整体回滚。

**I-04 证据：** `auth-mfa` 14/14 PASS：首次绑定、TOTP/recovery、并发单胜者、挑战超限、break-glass 成功/审计失败 rollback/非 admin 拒绝与 `/auth/mfa/break-glass` 404；全量 server 75 files / 611 tests PASS（915.71s）。

---

## 4. Token、管理员守卫与密码（P0）

- [x] **CHK-AUTH-01** 完成 MFA 的 admin access token 仅包含必要 userId、role、sid、mfaVerified、mfaVersion claims；不含 TOTP/recovery secret。
- [x] **CHK-AUTH-02** 非 admin 的登录、刷新、登出成功契约仍可用，未被 202 MFA 流破坏。
- [x] **CHK-AUTH-03** requireAdminMfa 位于所有 admin routes（含 portable-backups 子路由）之前；订单文件仲裁取证路径仅当 role=admin 时也委托同一 guard，买家/商家不受影响。
- [x] **CHK-AUTH-04** 旧 admin token、缺 sid token、mfaVersion 不匹配、mfaEnabled=false、过期/吊销 session 全部无法访问 admin API 或其他 admin 专属高权限能力；文件仲裁取证拒绝时不返回 URL、也不写 FileGrantLog；public announcements 对这类 token 降级 visitor，不能返回 admin audience 或写其回执。
- [x] **CHK-AUTH-05** 被封禁 admin 仍在角色/MFA guard 前被拒绝；普通 user/merchant 仍不能访问 admin API。
- [x] **CHK-AUTH-06** admin session 吊销后，同一已签发 access token 访问 admin API 立即返回 SESSION_REVOKED。
- [x] **CHK-AUTH-07** rotation 消费 token 与无原因 legacy revoked token 的 replay 保持 revoke-all-user 强语义并写 session_replay_detected；服务端明确 revoke reason 的 token 只被拒绝，不能误伤其他活动 session。每个 RefreshToken create/rotation/family/global revoke 在同 user transaction advisory lock 内锁后重读；旧 rotation predecessor 必须识别同 family 的 explicit terminal marker，CAS=0 也须重读分类。任何同 tx 的 `User` 状态/角色/密码写入一律采用 advisory→`User` 锁序，不能先写 `User` 再进入 revoke helper。
- [x] **CHK-AUTH-08** 注册、改密、重置密码新 hash 均是 bcrypt rounds=12。
- [x] **CHK-AUTH-09** bcrypt 10 旧 hash 仅在非 admin 正确完成正常登录后升级为 12；错误密码、封禁、admin MFA pre-auth challenge 未完成均不写 hash，也不保存可跨请求使用的密码材料。
- [x] **CHK-AUTH-10** login 在锁内重验 status/password 后才签发 initial session；reset/change/ban/approve/suspend 的全用户 revoke 以闭合 reason（默认 `revoke_all`）与 `session_revoked` audit 收口，不能新写 null reason。三条管理员 `User` 变更路径都在其首个 `User` write 前取得同 user advisory lock。
- [x] **CHK-AUTH-11** 管理员成功改密或重置密码在同一 user-lock 事务中消费其全部未消费 MFA pre-auth challenge、递增 `mfaVersion` 并吊销 session；旧 challenge 无法完成 MFA，失败密码变更不触碰 challenge/version。

**I-03 本地证据：** `auth-sessions` 11/11 PASS，覆盖 rotation/family、owner/current、single/revoke-others、explicit-terminal/replay、stale logout、global revoke audit、真实 advisory queue，以及 ban/approve/suspend 对 password-style `User` write 的三路径 lock-order。二次独立安全复审无 P0/P1。

**I-04 追加证据：** `auth-mfa` 14/14；`announcements` 14/14；文件交付 admin 取证关键分支 2/2；portable-backups routes 2/2；全量 server 75 files / 611 tests PASS。旧 admin refresh 不轮换、无 sid / 无 MFA / 版本失配 / session revoke、文件无 URL/无 FileGrantLog、公告 visitor 降级及密码变更 challenge 作废均有回归。

---

## 5. 设备会话（P0；显式标记 [P1] 的项不阻塞 P0 PR）

- [x] **CHK-SES-01** GET /auth/sessions 仅返回请求用户的 active、未过期 session，current 标记与 JWT sid 一致。
- [x] **CHK-SES-02** session summary 只含 sessionId、deviceLabel、ipHint、sessionStartedAt、lastUsedAt、current；不含 raw IP、完整 UA、tokenHash 或 revoked token。
- [x] **CHK-SES-03** refresh rotation 后 sessionId 保持不变，lastUsedAt 更新；会话列表不会把一次刷新显示成新设备。
- [x] **CHK-SES-04** DELETE /auth/sessions/:id 只能吊销自己的**非当前**目标会话；他人/猜测 UUID 返回 404，current session 返回 `CURRENT_SESSION_REQUIRES_LOGOUT` 并只能走既有 logout。
- [x] **CHK-SES-05** 被单独吊销的会话 refresh 失败；其他 session 正常工作（明确吊销不触发全用户 replay）；rotation replay 仍按 CHK-AUTH-07 全用户吊销。覆盖 rotation→explicit revoke→旧 predecessor refresh 和 rotation→stale-cookie logout，证明显式吊销返回后无 active successor。
- [x] **CHK-SES-06** revoke-others 只吊销非当前 session；current 不被误伤。
- [ ] **CHK-SES-07** **[P1]** revoke-all 吊销所有 session、清当前 refresh cookie，客户端退出登录。
- [x] **CHK-SES-08** 所有 revoke/replay 有 SecurityEvent，reason/type 受控且不含 token。
- [ ] **CHK-SES-09** 普通业务 access token 的“至迟当前 15 分钟 TTL / refresh 失效”语义在 UI/文档说明；不声称不真实的全局即时失效。

**I-03 本地证据：** `auth-sessions` 11/11 PASS；完整后端回归 65 files / 520 tests PASS（575.53s）。

---

## 6. 前端 UX 与隐私（P0 / P1）

### 6.1 P0

- [x] **CHK-FE-01** LoginPage 将 202 MFA challenge 作为登录流程状态，不触发自动 refresh 或错误重放。
- [x] **CHK-FE-02** 初次绑定页在未签发会话前不渲染 Layout/admin 内容。
- [x] **CHK-FE-03** QR、手动密钥、TOTP 输入、恢复码切换、错误/超限提示均可用；成功或取消后秘密 state 被清空。
- [x] **CHK-FE-04** 恢复码只展示一次，需用户确认已保存才能继续；不写 localStorage、Zustand persist、URL、console。
- [x] **CHK-FE-05** 账户安全区显示设备会话；单个/其他吊销都有确认、loading 防重与正确 logout。
- [x] **CHK-FE-06** 页面只显示 API 的脱敏 deviceLabel/ipHint，不暴露/重组 raw IP、完整 UA 或秘密。
- [x] **CHK-FE-07** 关键操作有可访问名称与稳定 data-testid；320px/375px 下无阻断布局。

### 6.2 P1

- [ ] **CHK-FE-08** 管理员安全区显示 MFA 已启用和恢复码剩余数。
- [ ] **CHK-FE-09** 恢复码重生、换机流程有明确“会使其他会话失效”的文案和确认。
- [ ] **CHK-FE-10** 会话列表加载/空状态/错误状态不会影响 ProfilePage 其他功能。
- [ ] **CHK-FE-11** **[P1]** revoke-all 有明确确认、清当前 auth state、跳转登录；不复用默认服务或保存秘密。

**证据：** `e2e/m3-identity-security-hardening.spec.ts` 的 M3 专用 UI suite：202 enrollment / 已绑定 recovery 登录、失败因子 `refreshRequests=0`、无 Layout、恢复码确认前 access token 与所有 recovery code 不在 `monexus-auth`、current/other 设备确认吊销、320px/375px 无横向溢出；6/6 PASS（3103/5178，`reuseExistingServer=false`）。

---

## 7. 秘密、日志与审计（P0）

- [x] **CHK-SEC-01** Pino redact 覆盖 password、verificationPassword、mfaCode、recoveryCode(s)、challengeId、manualKey、provisioningUri、mfaSecret、MFA_ENCRYPTION_KEY。
- [x] **CHK-SEC-02** 单测直接检查 logger / error / audit / API 序列化输出，不出现上述秘密原文。
- [x] **CHK-SEC-03** SecurityEvent 至少覆盖 enrollment、MFA 登录成功/失败、recovery 使用、session revoke、refresh replay、break-glass reset。
- [ ] **CHK-SEC-04** AdminLog 的既有业务审计不被删除或弱化；新增关联摘要不含 token/seed/recovery code。
- [x] **CHK-SEC-05** 错误消息不区分 recovery code 是否存在/已用，也不泄露内部加密、challenge 或数据库错误。
- [x] **CHK-SEC-06** Sentry / request logger 不附带 MFA request body；异常中没有 secrets。

**证据：** `2483b0f` 的 `auth-security-events` 覆盖闭合 SecurityEvent serializer、IP HMAC、固定 UA hint、MFA request/error body 脱敏（含 API `code` 但不脱敏根业务 error code）与无秘密输出；`auth-mfa-crypto` 覆盖 AES-GCM、TOTP、recovery code 与 challenge 原语；I-04 `auth-mfa` 覆盖 MFA API、generic factor errors 与 break-glass `caseRef` 审计。全量 server 75 files / 611 tests PASS；CHK-SEC-04 的业务 AdminLog 文档审计留给 I-06。

---

## 8. 验收场景（P0）

| AC | 描述 | 通过 |
| --- | --- | --- |
| AC-01 | 管理员首次绑定 | ☑ |
| AC-02 | 已绑定管理员 TOTP 登录 | ☑ |
| AC-03 | 恢复码一次性 | ☑ |
| AC-04 | 管理后台强制 MFA | ☑ |
| AC-05 | 会话隔离与单会话吊销 | ☑ |
| AC-06 | 管理员被吊销会话即时失效 | ☑ |
| AC-07 | bcrypt 升级与秘密不泄露 | ☑ |
| AC-08 | 全量回归（本地 verifier 通过；PR CI 修复中） | ☐ |

详细 Given/When/Then 见 spec.md §10。

**I-06 执行约束：** `e2e/m3-identity-security-hardening.spec.ts` 的 mock UI suite 不能勾选 AC-08。只有真实 HTTP / cookie / admin guard 的 M3 real suite 才能勾选：fixture 只能是 `monexus_m3_ish_test` 中 `m3-ish-e2e-*@test.invalid` 的短生命周期 admin；config 必须在 webServer 前拒绝其他 DB pathname；每个额外 context 显式 baseURL，trace/screenshot/video 均不产出 MFA 秘密；TOTP 必须来自真实 UI manual key 且错误码明确避开前/当前/后 30 秒允许窗口；一枚内存 recovery code 必须成功登录且复用失败无会话；A 必须经 Profile 的 `session-revoke-device` UI 精确吊销 B，A 的真实 admin stats 仍为 200，B 的 refresh 与 admin API 必须分别为 401 和 401 / `SESSION_REVOKED`；afterEach 只精确清理 fixture 自身的 auth/security 子记录与 User，不允许 `migrate reset` 或全库删除。

---

## 9. 自动化与构建门禁（P0）

- [x] **CHK-QA-01** auth、auth-tokens、refresh-token-wiring、auth-active-user 与新增 MFA/session tests 全部 PASS。
- [x] **CHK-QA-02** 包含并发 challenge / 恢复码 claim、refresh rotation/replay、admin session revoked 的回归测试；以真实 PostgreSQL transactions、Promise gate 和 `pg_locks` 排队观测覆盖 ban、approve、suspend 分别与 password-style `User` write 并发时的 advisory→`User` 无反转锁序。
- [x] **CHK-QA-03** server 全量 npm test PASS。
- [x] **CHK-QA-04** npm --prefix server run build PASS。
- [x] **CHK-QA-05** npm run build PASS。
- [x] **CHK-QA-06** `npm run verify:m3-identity-security-hardening` PASS：脚本只使用显式专用库，不调用 compose、不触碰默认 `monexus_test`。
- [x] **CHK-QA-07** Prisma migrate status/drift 检查 PASS，且命令显式使用 `M3_ISH_DATABASE_URL`。
- [x] **CHK-QA-08** admin MFA 和 session revoke Playwright tests 在 M3-ISH 专用 config（3103/5178、`reuseExistingServer=false`）PASS：config 在 webServer 前严格拒绝非专用 DB，context 显式 baseURL，`openAdmin()` 以 `GET /api/admin/stats` 200 证明真实 guard；错误 TOTP 避开允许窗口，recovery code 成功一次/复用失败无 session，`session-revoke-device` 精确吊销另一 context。
- [ ] **CHK-QA-09** 根 `playwright.config.ts` 忽略 `m3-identity-security-hardening.real.spec.ts`，默认 CI 的 `npm run e2e` 不加载隔离 fixture；M3 专用 config 的 mock + real suite PASS，`trace: 'off'`、`screenshot: 'off'`、video 未启用。
- [ ] **CHK-QA-10** CI 的 CI OK 聚合检查绿。

**证据：**

~~~text
isolated verifier: M3_ISH_DATABASE_URL=<isolated monexus_m3_ish_test> npm run verify:m3-identity-security-hardening → exit 0
prisma: 38 migrations up to date; migrate diff → No difference detected
vitest: 76 files / 618 tests PASS (754.49s)
server build: npm --prefix server run build → PASS
frontend build: npm run build → PASS
staging template guard: npm run prod:env:staging-template → PASS (expected placeholder warnings only)
playwright: M3 UI + real suite → 10/10 PASS (49.4s); no trace/screenshot/video artifacts
targeted safeguards: wrong DB config rejected before webServer; auth-break-glass CLI 7/7 PASS; OpenAPI JSON parse and bash -n PASS
PR #53 initial CI: default E2E incorrectly loaded the isolated real suite without M3_ISH_DATABASE_URL; CHK-QA-09 / AC-08 reopened pending config-ignore fix and CI rerun.
CI:
~~~

---

## 10. 文档与运维（P1；发布前 P0）

- [x] **CHK-DOC-01** OpenAPI 同步 login 200/202 union、MFA/session endpoints、错误码与 auth scheme。
- [x] **CHK-DOC-02** auth module README 写明 session rotation、admin MFA guard、普通与 admin 吊销语义。
- [x] **CHK-DOC-03** server/.env.example、根 .env.example、production guard 文档 MFA_ENCRYPTION_KEY，不提供任何默认真实 key；deploy 前检查与服务启动均拒绝缺失、非 canonical 或非 32-byte base64 值。
- [x] **CHK-DOC-04** secrets-management 记录 key owner、存放位置、备份/恢复依赖、轮换的“需另行设计”限制。
- [x] **CHK-DOC-05** runbook 包含发布前密钥核对、首次绑定、SecurityEvent 审查、两人审批 break-glass、强制重新绑定；break-glass 只能经不暴露 HTTP 的受限 CLI 调用原子服务，绝不允许 direct-SQL 清 seed/recovery/session。
- [x] **CHK-DOC-06** runbook 明确禁止 HTTP bypass、直接读取/导出 MFA seed/recovery hash，以及回滚到无 MFA admin API。
- [ ] **CHK-DOC-07** PR 描述清楚 D-03 的 step-up 边界、普通 access token 失效最大窗口和回滚策略。

**证据：** 文档链接 / staging 演练记录：________________

---

## 11. 发布就绪（P0）

- [ ] **CHK-REL-01** staging 中所有 API 实例使用同一独立 MFA_ENCRYPTION_KEY，production guard 已通过。
- [ ] **CHK-REL-02** 指定管理员已在 staging 完成首次绑定、后续登录、恢复码登录、session revoke 演练。
- [ ] **CHK-REL-03** 发布公告已通知管理员旧会话会失效和需准备 authenticator。
- [ ] **CHK-REL-04** 旧 API 实例在 migration/切流前被排空，避免无 MFA admin 路径与新版本并存。
- [ ] **CHK-REL-05** production 切流后立即抽测普通登录、admin MFA、admin stats、session list、另一设备吊销。
- [ ] **CHK-REL-06** 发布后 15 分钟监测 SecurityEvent、错误率和 Sentry，无异常秘密上报。
- [ ] **CHK-REL-07** break-glass 联系人/双人审批流程已验证，但未在生产实际触发。
- [ ] **CHK-REL-08** 回滚计划遵守 plan §7.3：前向修复或临时关闭 admin API，不重新开放无 MFA 后台。

---

## 12. 合并前最终门闩

复制到 PR 描述：

~~~markdown
## DoD Gate (M3-ISH)
- [ ] Process (CHK-PROC-*)
- [ ] Data / key / migration (CHK-DATA-*)
- [ ] Administrator MFA (CHK-MFA-*)
- [ ] Token / admin guard / bcrypt (CHK-AUTH-*)
- [ ] Device sessions (CHK-SES-*)
- [ ] Frontend P0 (CHK-FE-01..07)
- [ ] Secret / audit (CHK-SEC-*)
- [ ] AC-01 .. AC-08
- [ ] QA (CHK-QA-01..10)
- [ ] Release (CHK-REL-01..08)
~~~

仅当以上全部勾选，才可 Approve & Merge。

---

## 13. 豁免记录

| 检查项 ID | 原因 | 跟进 issue / spec | 批准人 | 日期 |
| --- | --- | --- | --- | --- |
| | | | | |

P0 豁免默认不允许。唯一例外是仓库负责人明确书面批准的紧急生产处置；该处置仍不得关闭 admin MFA guard 或降低秘密保护。

---

## 14. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-07-27 | 初版安全验收清单 |
| 1.1.0 | 2026-07-27 | 收口 session family/两阶段迁移、P1 标签与专用验证门禁 |
| 1.2.0 | 2026-07-27 | 将 P6a rebase 明确为 PR 前门禁；并行实现仍须保持 worktree/runtime 隔离 |
| 1.3.0 | 2026-07-27 | 将 migration 验收改为 database-generated UUID legacy-fixture 证明，并保留 legacy admin 吊销门禁 |
| 1.4.0 | 2026-07-27 | 增加 M3-only migration timestamp 纠正的 SQL hash / 专用库 replay 证据门槛 |
| 1.5.0 | 2026-07-27 | 明确 fixture/replay 证据只能来自同一可丢弃专用数据库 |
| 1.6.0 | 2026-07-27 | 与冻结实现顺序同步：明确非 current DELETE 和管理员 MFA pre-auth 不做 bcrypt rehash |
| 1.7.0 | 2026-07-27 | 记录 I-01 pre-rebase migration/config 证据并仅勾选已可本地验证的数据项 |
| 1.8.0 | 2026-07-27 | 补记 62 files / 497 tests 的隔离全量后端回归结果 |
| 1.9.0 | 2026-07-27 | 任务本地完成与 P6a→develop 的 PR 集成闸门分离；所有最终 P0 项仍需 rebase 后复核 |
| 1.10.0 | 2026-07-27 | 勾选已由 I-02 原语测试覆盖的数据/加密/TOTP/日志项，并记录 focused commit 与验证证据 |
| 1.11.0 | 2026-07-27 | 与 D-07 同步 explicit revoke / rotation replay 的独立验收语义 |
| 1.12.0 | 2026-07-27 | 加入 I-03 P0 并发门禁：用户级 transaction lock、锁后重读、family marker 和 stale-cookie logout 验收 |
| 1.13.0 | 2026-07-27 | 增加全 RefreshToken mutation、locked login 重验、global revoke reason/audit 与无需 migration 的 P0 验收 |
| 1.14.0 | 2026-07-27 | 加入 `User`/session 固定锁序及 ban、approve、suspend 三路径真实 PostgreSQL 无反转回归门禁 |
| 1.15.0 | 2026-07-27 | 回填 I-03 已覆盖的 stable family、D-07、session 与构建门禁证据；其余 MFA/guard/UI/rebase 发布门禁仍未完成 |
| 1.16.0 | 2026-07-28 | I-04 编码前安全复核将 orders 文件仲裁取证纳入 admin 专属能力门禁；要求条件 MFA guard、无 URL/无 FileGrantLog 回归，并同步 enrollment 单胜者约束 |
| 1.17.0 | 2026-07-28 | 同步 I-04 的 public announcement admin audience visitor 降级门禁与 rebase 后独立实现状态 |
| 1.18.0 | 2026-07-28 | 增加 CHK-AUTH-11：管理员成功密码变更必须消费 pre-auth challenge、递增 MFA version、吊销 session，并有成功/失败路径回归 |
| 1.19.0 | 2026-07-28 | 增加 CHK-MFA-13：D-04 break-glass 服务级原子 reset、无 HTTP route 与全量凭证作废/审计回归门禁 |
| 1.20.0 | 2026-07-28 | CHK-MFA-13 收紧为 pending challenge 密文也必须清空，防止 break-glass 留下无用敏感材料 |
| 1.21.0 | 2026-07-28 | I-05 在 P6→develop rebase 后开始执行；CHK-FE-01..07 保持未勾选，直至前端实现、独立验证与证据回填完成。 |
| 1.22.0 | 2026-07-28 | I-05 完成并勾选 CHK-FE-01..07；记录专用 UI suite 6/6、双端 build 与 diff-check。CHK-QA-08/09 和 AC-08 仍留给 I-06 的真实整栈验证。 |
| 1.23.0 | 2026-07-28 | 在 I-06 编码前将 AC-08 的 real-E2E/non-bypass/fixture cleanup 门槛写入 checklist；未提前勾选 QA 或 AC。 |
| 1.24.0 | 2026-07-28 | 记录 I-06 运维收口：MFA key 的 production preflight 与 server guard 必须一致；break-glass 仅走受限离线 CLI / 双人 SOP，未提前勾选文档门禁。 |
| 1.25.0 | 2026-07-28 | I-06 复审将 real-E2E 的启动前 DB 拒绝、baseURL/无失败产物、窗口外错误 TOTP、recovery 单次性、精确单设备 revoke 与真实 admin API 验证列为未勾选的 P0 QA 证据。 |
| 1.26.0 | 2026-07-28 | I-06 本地 verifier 退出 0 后勾选 AC-08（local）及 QA/DOC 已验证项；76 files / 618 tests、10/10 Playwright 与静态门禁已记录，PR/CI/release 项保持未勾选。 |
| 1.27.0 | 2026-07-28 | PR #53 CI 证明默认 E2E 未排除隔离 real suite；AC-08/CHK-QA-09 重新打开，待根 config ignore 修复和 CI OK 后再勾选。 |
