# Tasks: 注册、激励与邮件反滥用闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `TASK-RAP-001` |
| 版本 | `1.0.0` |
| 状态 | `T00, T10–T51 complete on feat/registration-abuse-prevention; T01/T52 remain release-owner work` |
| 规格 | [spec.md](./spec.md) |
| 计划 | [plan.md](./plan.md) |

> 每项任务必须在对应测试先行或同次提交完成；任务完成不等于可合并，最终以 [checklist.md](./checklist.md) 为准。

---

## 1. 依赖图与并行边界

```text
OPS-REGMAIL merged + latest develop
             │
             ▼
  T00 baseline / isolated resources
             │
   ┌─────────┴───────────┐
   ▼                     ▼
T10 config/redis       T20 migration/models
   │                     │
   └───────┬─────────────┘
           ▼
 T30 human verifier + mail limiter + auth service
           │
     ┌─────┴─────────┐
     ▼               ▼
 T40 value gates   T50 rewards/referral/cron/audit/admin API
     │               │
     └───────┬───────┘
             ▼
        T60 frontend
             │
             ▼
        T70 docs / E2E / release rehearsal
```

| 任务组 | 可与什么并行 | 禁止碰触 |
| --- | --- | --- |
| T10–T20 | 可以并行，只要 schema owner 独占 `schema.prisma` 与 migration | 正在进行的移动端 worktree、其 `AdminPage.tsx` |
| T30–T50 | T40 与 T50 可在稳定中间件/模型后并行 | 不在不同 worktree 同时改 `auth/service.ts`；由一个 owner 串行整合 |
| T60 | 只在移动端 PR 合入后开始 | `mobile-ui-polish.spec.ts`、`mobile-regression.spec.ts`、导航/safe-area CSS |
| T70 | 可和最后前端收尾并行 | 不改迁移 SQL 或生产 `.env` |

---

## 2. Phase 0 — 基线与前置检查

- [x] **T00 — Rebase/隔离确认**
  - 从最新 `develop` 建 `feat/registration-abuse-prevention` 和独立 worktree。
  - 确认 `SPEC-OPS-REGMAIL-001` 已合入并存在 `registrationEnabled` / mail status 契约。
  - 使用显式 `RAP_DATABASE_URL`（仅 `monexus_rap_test`）与 `RAP_REDIS_URL`；记录当前 migration head。
  - DoD：worktree 干净；`npm --prefix server run build`、目标 auth/points/orders/merchant 测试绿。

- [ ] **T01 — 生产依赖演练设计**
  - 确认 staging Turnstile keys、Redis HA、真实 SMTP sender 与 SPF/DKIM/DMARC owner；不记录真实值。
  - 定义 `ABUSE_PROTECTION_MODE=enforce` 部署变量映射和 `check-prod-env.sh` preflight 输入。
  - DoD：运维负责人确认 A-02/A-03/A-04；没有在 repo 或 task 日志输出秘密。

---

## 3. Phase A — 配置、安全原语与 Redis limiter

- [x] **T10 — 环境 schema 与 production guard**
  - 文件：`server/src/config/index.ts`、`.env.example`、`server/.env.example`、`scripts/check-prod-env.sh`。
  - 加入 `ABUSE_PROTECTION_MODE`、`ABUSE_HASH_KEY`、Turnstile 三变量及 production enforce 校验。
  - 复用 MFA canonical-base64 校验模式为 `ABUSE_HASH_KEY` 建独立 parser；禁止 production `off`。
  - DoD：缺/错变量在启动和 preflight 一致失败；非生产 test adapter 可显式注入。
  - Evidence：`23e26eb`；production guard 16/16、`check-prod-env.sh` 语法/placeholder 验证通过。

- [x] **T11 — 秘密 redaction 与安全 error code**
  - 文件：`server/src/lib/logger.ts`、`server/src/lib/httpError.ts`、相关 logger/error tests。
  - 增加 Turnstile/HMAC/reply body redact 路径、五个封闭 error code/helper。
  - DoD：金丝雀 token/secret 出现在 req、nested error、Sentry breadcrumb 或 serializer 都被删除/遮蔽；业务 error code 不被误 redact。
  - Evidence：`23e26eb`；Turnstile/HMAC/provider-body redaction 金丝雀由 primitives suite 覆盖。

- [x] **T12 — Redis Lua primitive**
  - 文件：`server/src/lib/redis.ts`、新 `server/src/lib/abuseLimiter.ts`、fake Redis test helper。
  - 扩展最小 `eval` 类型；实现 atomic count/TTL、hash key 构建、`AbuseProtectionUnavailableError`。
  - DoD：并发测试和 TTL 边界验证每 key 无孤儿 TTL；Redis timeout/circuit 不会 fallback 到 DB 或 process map。
  - Evidence：`23e26eb`；Lua/TTL/fail-closed 测试通过。

- [x] **T13 — 注册/邮件 bucket 策略**
  - 文件：新 `server/src/modules/auth/abusePolicy.ts`、`abuseLimiter.ts` tests。
  - 将 spec §5.3 的数字编码为命名 policy，形成组合 bucket 消耗 API；不把数字散落在 controller。
  - DoD：每个 flow 的顺序、副作用短路、retry-after 和无高基数 metrics 有单测。
  - Evidence：`23e26eb`；固定 bucket、短路和上海自然日窗口测试通过。

- [x] **T14 — Turnstile verifier adapter**
  - 文件：新 `server/src/modules/auth/humanVerification.ts`、tests。
  - 固定 endpoint、3 秒总超时、strict response parse、action/hostname 校验、test-only injection。
  - DoD：success/failed/timeout/network/malformed/hostname/action 矩阵全绿；没有 HTTP bypass。
  - Evidence：`23e26eb`；14/14 security primitives（含 malformed provider=503）通过。

---

## 4. Phase B — 数据 migration 与认证/邮件流程

- [x] **T20 — 设计/生成单一 Prisma migration**
  - 文件：`server/prisma/schema.prisma`、新 migration。
  - 加 User referral suspension、InviteRelation 状态字段、GrowthReward、AbuseEvent、关系与索引。
  - 在 `monexus_rap_test` 用 `prisma migrate dev` 生成；同时验证升级前 relation 全为 `legacy`、PointAccount/PointLog 未变。
  - DoD：`prisma migrate reset/deploy/status`、`prisma generate` 和 legacy fixture 全绿；不手写 SQL。
  - Evidence：`cf9d1e0`；`20260731170039_registration_abuse_prevention` 在 `monexus_rap_test` reset/deploy/status 重放通过，历史 fixture 保持 PointAccount/PointLog=`1/137/1`，模型契约 4/4。

- [x] **T21 — 受控 AbuseEvent 模块与 metrics**
  - 文件：新 `server/src/modules/auth/abuseEvents.ts`、`server/src/lib/metrics.ts`、tests。
  - 建封闭 event vocabulary、HMAC serializer、固定 safe detail、低基数 counters/histograms、90-day cleanup query。
  - DoD：未知 event/detail/free-form reason 被拒；所有泄露金丝雀断言失败；metrics label cardinality 静态测试通过。

- [x] **T22 — 邮箱 schema 与验证 token claim**
  - 文件：`auth/schema.ts`、`auth/routes.ts`、`auth/controller.ts`、`auth/service.ts`、`VerifyEmailPage` API contract tests。
  - 使用 normalized email；新增认证 POST verify；废止匿名 GET 写状态；每次 resend 作废旧 token。
  - DoD：不同 user token claim、expired/used token、并发 token claim、已验证 retry、old GET zero DB mutation 全覆盖。

- [x] **T23 — 用户邮件多维限流**
  - 文件：`auth/routes.ts` / service、mailer tests。
  - 在 send-verification 和 forgot-password 的每个发送/创建副作用前消耗 policy bucket；保持 reset public response generic。
  - DoD：超过额度时 CaptureMailer/Token 表零增；不存在/存在邮箱的 reset HTTP 外观一致；Redis outage zero side effect。

- [x] **T24 — 注册 Turnstile + limiter 管线**
  - 文件：`auth/schema.ts`、`auth/routes.ts`、`auth/controller.ts`、`auth/service.ts`。
  - 施行 gate→preflight→verifier→full bucket→密码 hash/transaction 的固定顺序；扩展 registration status 安全 descriptor。
  - DoD：每一种 reject 都在 User/PointAccount/InviteRelation/GrowthReward/RefreshToken 前；response 无 provider secret/error body。

---

## 5. Phase C — 资格门槛、邀请码/奖励、cron 与运营 API

- [x] **T30 — `requireVerifiedEmail` 中间件**
  - 文件：`server/src/middlewares/auth.ts`、auth middleware tests。
  - 读取当前 User.emailVerified/status；开关为 0 时 no-op；提供受控 403。
  - DoD：不信任 token/UI；被封禁逻辑保持优先/兼容；无 DB 异常泄漏。

- [x] **T31 — 精确路由接线**
  - 文件：points/orders/merchant/uploads/delivery-file routes 和 route-level tests。
  - 仅接 spec §5.1 中的高价值 POST/PUT；售后、读/下载、checkout preview 明确回归。
  - DoD：受保护和豁免路径矩阵完全覆盖，所有 protected action zero mutation。

- [x] **T32 — 注册奖励 held ledger**
  - 文件：`auth/service.ts`、新 `growthRewards.ts`、tests。
  - 账户创建余额 0、注册 GrowthReward snapshot、AuthUser points 实际余额、前端 response contract。
  - DoD：无立即 PointLog；重试/邮件重复验证不重复创建 registration reward。

- [x] **T33 — 邀请资格与 qualification 并发协议**
  - 文件：`auth/service.ts`、`growthRewards.ts`、真实 PostgreSQL concurrency tests。
  - 注册时检查 inviter 当前资格/pending cap；验证时锁 inviter、按上海日和累计 count 竞争额度、转 relation/reward 状态。
  - DoD：最后一个名额、午夜边界、inviter ban/suspend、重复 verify、quota 0、legacy row 均无越界奖励。

- [x] **T34 — GrowthReward release/void service**
  - 文件：`growthRewards.ts`、accounting integration tests。
  - 用 row lock/condition claim 原子更新 account、PointLog、reward；void 只能 pending/held。
  - DoD：cron/retry/admin void 并发时余额=流水，granted 不可 void，封禁/暂停处理正确。

- [x] **T35 — leased reward cron + retention cleanup**
  - 文件：`growthRewardCron.ts`、`main.ts`、cron tests。
  - 复用 cron lease，批次 `FOR UPDATE SKIP LOCKED`，每分钟 release，日清 AbuseEvent >90d。
  - DoD：多实例 lease、batch error rollback、stop lifecycle、cleanup 不删未到期事件和关联账务。

- [x] **T36 — SystemConfig registry 与 admin config 契约**
  - 文件：`systemConfig.ts`、admin schema/tests、`src/api/adminConfig.ts` 后续同步。
  - 新增五个业务 key、严格 key-aware range 和跨字段 invariant；审计旧值→新值。
  - DoD：非法 bool/范围/组合都 400，前置 `registrationEnabled` 校验不回归。

- [x] **T37 — Admin abuse service/routes**
  - 文件：新 `modules/admin/abuse*`、`admin/routes.ts`、schema/controller tests。
  - overview/list/suspend/restore/void APIs，MFA/RBAC、caseRef、AdminLog + AbuseEvent 双审计。
  - DoD：分页、mask、filter、cannot void granted、unknown object 404/403 语义按既有约定全绿。

---

## 6. Phase D — 前端与 E2E

- [x] **T40 — Auth client/status/Turnstile component**
  - 文件：`src/api/auth.ts`、`TurnstileWidget.tsx`、types。
  - 安全 DTO union、token memory lifecycle、script cleanup、注册不可用状态。
  - DoD：site key/token 不进入 persistent store/URL/console；widget error 可以重试。

- [x] **T41 — 登录与验证邮箱 UX**
  - 文件：`LoginPage.tsx`、`VerifyEmailPage.tsx`、`EmailVerificationBanner.tsx`。
  - 延迟奖励 copy、fragment strip、authenticated POST、unverified resend cooldown、403 recovery。
  - DoD：加载/disabled/unavailable/verify success/failure 均可达；未登录用户没有 token 持久化或匿名验证路径。

- [x] **T42 — 高价值动作 guard UX**
  - 文件：`VerifiedActionGate.tsx`、ProductDetail/Profile/MerchantApply/upload callers。
  - 统一 CTA、局部表单保护与 verification refresh；不覆盖真实 server error。
  - DoD：375px/desktop 触控目标 40px、键盘可用、已有售后动作不被挡。

- [x] **T43 — 邀请状态文案**
  - 文件：`ProfilePage.tsx`、profile/API types。
  - 删除立即奖励承诺，显示资格期/暂停/额度满，邀请 code copy 保持兼容。
  - DoD：不向用户暴露被邀请人邮箱、IP、内部 event/reward IDs 或风控标签。

- [x] **T44 — 管理员风控面板**
  - 文件：`src/api/adminAbuse.ts`、`AbuseProtectionPanel.tsx`、`AdminPage.tsx`。
  - 仅在 mobile UI 合入后进行；overview/card/list/action confirm/caseRef/toast。
  - DoD：不横向溢出、MFA API error 正确、suspend/void 确认与加载防重、没有秘密渲染。

- [x] **T45 — E2E 与回归隔离**
  - 文件：新 `e2e/registration-abuse-prevention.spec.ts`，必要 helper。
  - mock Turnstile 精确接口、真实 MFA admin helper、保护 gate / fragment / operations scenarios。
  - DoD：不修改 mobile regression spec；所有并行 test fixture 用唯一 email/隔离 DB，不能关闭 limiter 来求绿。

---

## 7. Phase E — 文档、验证与发布

- [x] **T50 — OpenAPI/module/runbook 同步**
  - API JSON、auth/admin READMEs、env examples、secrets management、runbook、deployment templates。
  - DoD：每个新错误/endpoint/secret/rollout/rollback 都有文档；无真实 secret。

- [x] **T51 — 全量验证**
  - 运行 targeted suites、server full test/build、frontend build、相关 Playwright、`git diff --check`、Prisma migration/replay/drift。
  - DoD：记录命令和精确 pass 数；任何 flaky retry 单列，不用“可能通过”代替证据。
  - Evidence：GitHub Actions [CI #30683242294](https://github.com/amo0114/MoNexus/actions/runs/30683242294) 于 2026-08-01 通过：backend `102 files / 863 tests`（547.88s）、Playwright `85 passed`（3.6m）、frontend build 与 `CI OK` 均 green；无 flaky retry。专用 `/monexus_rap_test` 已执行 `prisma migrate reset --force --skip-seed`、`migrate deploy`、`migrate status`，47 个 migration replay 后 schema up to date；临时 shadow database 的 `prisma migrate diff --from-migrations ... --to-schema-datamodel ... --exit-code` 返回 `No difference detected` 并已删除。

- [ ] **T52 — Staging 演练与灰度**
  - 真实 Redis/SMTP catcher/Turnstile staging、正常注册、恶意速率、验证、延迟奖励、admin void、roll back drill。
  - DoD：release checklist 的环境项由责任人签字；生产先观察后打开 email value gate。

---

## 8. 任务完成定义

每个任务完成时必须同时满足：

1. 代码/测试/文档在同一有意提交中，且不夹带他人 worktree 变更；
2. `git diff --check` 通过，TypeScript 无新增 `any` 绕过安全边界；
3. 新外部依赖都有 timeout、错误分类、test adapter 和 redact 覆盖；
4. 任何状态/账务变更均有失败/并发/重试测试；
5. PR 描述引用本 task ID、对应 spec requirement 和 checklist 证据。

---

## 9. 本地实施证据（2026-08-01）

| 项目 | 结果 |
| --- | --- |
| 隔离数据库 | 仅使用 `/monexus_rap_test`；`prisma migrate deploy` 报告 47 个 migration 且无 pending migration |
| 后端定向测试 | `growth-rewards`、`rap-admin-abuse`、`registration-auth-flow`：3 files / 20 tests passed |
| 构建 | `npm --prefix server run build`、`npm run build` 均通过（Node 20.19.5 / npm 10.8.2） |
| 浏览器回归 | `registration-abuse-prevention.spec.ts`：5 passed；包含管理员面板脱敏渲染与 caseRef 作废确认 |
| 文档检查 | `git diff --check` 与 OpenAPI JSON parse 通过 |
| Prisma replay / drift | 专用 `/monexus_rap_test` reset/replay/status：47 migrations、schema up to date；一次性 shadow database 的 migration→datamodel diff 为 `No difference detected`，随后已删除 |
| GitHub CI | [CI #30683242294](https://github.com/amo0114/MoNexus/actions/runs/30683242294)：backend 102 files / 863 tests、Playwright 85 passed、frontend build 与 `CI OK` 全绿 |

T51 已由上述 CI、reset/replay 与 drift 记录完成。T52 需要外部 staging Redis、Turnstile、SMTP catcher 与发布负责人，不能由本地 feature worktree 伪造完成。

---

## 10. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-08-01 | 初版原子任务、依赖图与完成定义。 |
| 1.1.0 | 2026-08-01 | 记录实现完成范围、本地验证证据及仍需 release-owner 的门禁。 |
