# Plan: 注册、激励与邮件反滥用闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `PLAN-RAP-001` |
| 版本 | `1.0.0` |
| 日期 | `2026-08-01` |
| 状态 | `In implementation — T10–T20 isolated foundations in progress` |
| 规格 | [spec.md](./spec.md) (`SPEC-RAP-001`) |
| 任务 | [task.md](./task.md) |
| 验收 | [checklist.md](./checklist.md) |

> 这是一份独立实施计划。T10–T20 可在隔离 worktree 以 `SPEC-OPS-REGMAIL-001` 已提交的后端基线并行完成；涉及 auth 整合与前端的阶段仍必须等待其稳定合入 `develop`。绝不在移动端 UI worktree 或其 `AdminPage.tsx` 改动上直接开工。

---

## 1. 目标、边界与交付顺序

### 1.1 目标架构

```text
                         public registration status
                                    │
                                    ▼
LoginPage ── managed Turnstile ──► POST /auth/register
                                    │
                  Redis preflight / provider verify / rate buckets
                                    │
                                    ▼
                User + PointAccount(0) + pending GrowthReward
                                    │
                                    ▼
                  authenticated email verification claim
                                    │
              ┌─────────────────────┴────────────────────┐
              ▼                                          ▼
    emailVerified + value gate                    InviteRelation qualification
              │                                          │
              └──────── held GrowthReward ───────────────┘
                                    │
               leased reward cron + PostgreSQL atomic claim
                                    │
                                    ▼
                       PointAccount + PointLog once

Admin MFA ──► Abuse overview / invite suspension / held-reward void
```

### 1.2 不可跨越的边界

- `registrationEnabled` 的唯一总开关、SMTP 状态和 admin test mail 继续由前置规格拥有；本计划只在其稳定 API 上演进。
- Redis 此前属于可降级缓存；本波新建的 abuse limiter 是**安全依赖**，不能复用 cache 的 fallback-to-DB 语义。
- Turnstile site key 可公开，secret、siteverify request/response、SMTP credential、邮件 token 永远不出后端环境或浏览器短暂表单内存。
- `emailVerified` 资格只针对明确列出的高价值写操作，不可把所有 `/api/orders` 或所有登录态路由一刀切，避免阻断售后和已购交付。
- `PointLog` 是已发资产账本；不会因为邀请码暂停或 reward void 删除/反写历史账本。

### 1.3 实施阶段

| 阶段 | 内容 | 关键出口 |
| --- | --- | --- |
| 0 | 基线、依赖确认、生产密钥/Redis/Turnstile 准备 | 前置规格合入；隔离 DB/Redis 可用 |
| A | 配置、安全原语、Redis limiter、Turnstile adapter | 生产 fail-closed 编译/单测通过 |
| B | Schema migration、注册/验证/邮件服务和奖励账本 | 并发事务测试证明不重复发奖 |
| C | 资格 guards、reward cron、运营 API/审计/指标 | 高价值写入口完整受保护 |
| D | 前端体验与管理后台 | 不改移动端契约；E2E 绿 |
| E | staging 演练、灰度、生产启用 | 依据 release checklist 逐项勾选 |

---

## 2. As-Is → To-Be 技术映射

| 现有位置 | 现状 | 本波变更 |
| --- | --- | --- |
| `server/src/modules/auth/routes.ts` | register/邮件仅有 MemoryStore IP limiter；GET 直接验证邮箱 | 新 abuse middleware、Turnstile 前置、认证 POST verify、legacy GET 安全弃用 |
| `server/src/modules/auth/service.ts` | 注册即时发 `registerReward` / `inviteReward` | 创建 0 余额账户 + pending ledger；验证时资格判定；不直接发积分 |
| `server/src/middlewares/auth.ts` | `requireActiveUser` 仅查封禁 | 新窄 `requireVerifiedEmail`，只接指定写路由 |
| `server/src/lib/redis.ts` | 可用于缓存，公开接口无 Lua / eval 类型 | 扩展精确 `eval` 能力与 testing fake；新增 `abuseLimiter.ts` 不调用 cache fallback |
| `server/src/config/index.ts` | Redis/SMTP 已有；无 CAPTCHA/abuse hash config | 增加严格环境 schema、production guard 和安全 public descriptor |
| `server/prisma/schema.prisma` | InviteRelation 无状态；无 held reward/audit 模型 | 增加 referral state、GrowthReward、AbuseEvent 和索引；单 migration |
| `server/src/main.ts` | 多个 leased cron | 加 `startGrowthRewardCron` / `stopGrowthRewardCron`，复用 cron lease 模式 |
| `src/pages/LoginPage.tsx` | 注册表单无 CAPTCHA，成功文案硬编码立即赠送 | 受 registration status 驱动的 Turnstile、延迟奖励文案 |
| `src/pages/VerifyEmailPage.tsx` | URL query token 自动匿名 GET 验证 | fragment token、登录会话绑定 POST、无会话时引导登录后重发 |
| `src/components/EmailVerificationBanner.tsx` | 可关闭的可选提示 | 高价值动作的共享 gate UI / resend cooldown；视觉提示可关闭但服务端 gate 不可绕过 |
| `src/pages/ProfilePage.tsx` | 宣传“每邀请一人注册立得 200” | 显示资格期、额度和延迟发放，不承诺即时奖励 |
| `src/pages/AdminPage.tsx` | 系统配置面板 | 仅在移动端合入后插入独立 `AbuseProtectionPanel`；这是唯一预期前端冲突点 |

---

## 3. 配置与安全原语

### 3.1 环境配置

新增后端环境变量，全部经 `config/index.ts` 解析；`TURNSTILE_SECRET_KEY` 与 `ABUSE_HASH_KEY` 进入 logger redact、Sentry request sanitization 和 secrets-management 文档。

| 变量 | 类型 / production 规则 | 用途 |
| --- | --- | --- |
| `ABUSE_PROTECTION_MODE` | `off \| enforce`；生产只能 `enforce` | 非生产允许显式 off；生产不允许静默无保护启动 |
| `ABUSE_HASH_KEY` | canonical base64、解码后恰 32 bytes；production 必填 | HMAC email/IP 用，独立于 JWT secret |
| `TURNSTILE_SITE_KEY` | 非空公开字符串；production enforce 必填 | 只出现在安全 public registration descriptor |
| `TURNSTILE_SECRET_KEY` | 非空 secret；production enforce 必填 | siteverify 服务端凭证 |
| `TURNSTILE_ALLOWED_HOSTNAMES` | 逗号分隔、规范化 hostname 非空集合；production enforce 必填 | 精确验证 Turnstile 响应 hostname |

`REDIS_ENABLED=true`、`REDIS_REQUIRED=true` 是 `ABUSE_PROTECTION_MODE=enforce` 的额外生产启动条件。即使 `/ready` 后续短暂 degrade，保护调用也不能继续放行。

### 3.2 Turnstile adapter

建议新模块 `server/src/modules/auth/humanVerification.ts`：

```ts
type HumanVerificationResult =
  | { kind: 'verified' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }

type HumanVerifier = {
  verifyRegistration(input: { token: string; ip: string | undefined }): Promise<HumanVerificationResult>
}
```

- 使用 Node 20 内置 `fetch` 和 `AbortSignal.timeout(3_000)`；provider endpoint 常量不可配置。
- 向 provider 只发送 secret、response token、可选 `remoteip`；不把完整 response 附加到 Error 或 logger。
- `success`、`action`、hostname 三项全匹配才返回 `verified`。未知/不完整 response 归类 `rejected`；网络、超时、5xx、配置错误归类 `unavailable`。
- `__setHumanVerifierForTesting()` 仅在 test module 中可用；没有 header、query、环境布尔值或 frontend flag 能绕过验证。

### 3.3 Redis atomic limiter

在 `server/src/lib/redis.ts` 的窄 `RedisLike` 接口增加 `eval`，不要向业务层暴露 raw client。新 `server/src/lib/abuseLimiter.ts` 使用固定 Lua：

```lua
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
```

接口返回 `{ allowed, retryAfterSeconds }`，调用端根据规格定义的多个 bucket 按顺序消费。每个 key 使用：

```text
${CACHE_KEY_PREFIX}:abuse:v1:${flow}:${dimension}:${hmac-or-id}:${window}
```

HMAC 输入固定为 `v1\0${normalizedValue}`；email 经过前置规格的 trim/lowercase schema，IP 去掉空白并限制长度。任何 Redis 异常抛出专用 `AbuseProtectionUnavailableError`，由 route 映射为 503，而不是吞掉后放行。

### 3.4 错误与日志

在 `httpError.ts` 添加封闭 ErrorCode 与助手：

- `EMAIL_VERIFICATION_REQUIRED` (403)
- `HUMAN_VERIFICATION_REQUIRED` (400)
- `HUMAN_VERIFICATION_FAILED` (403)
- `HUMAN_VERIFICATION_UNAVAILABLE` (503)
- `ABUSE_PROTECTION_UNAVAILABLE` (503)

`RATE_LIMITED` 保持现有 429，且只使用通用中文 message。`loggerRedact` 加入 `turnstileToken`、`TURNSTILE_SECRET_KEY`、`ABUSE_HASH_KEY`、siteverify nested body/response 路径。验证失败的 detail 只允许固定 reason enum。

---

## 4. 数据、并发与账务方案

### 4.1 Prisma migration

一次 migration 包含：

1. `User.referralSuspended Boolean @default(false)`。
2. `InviteRelation.status String @default('legacy')`、`qualifiedAt DateTime?`、`voidedAt DateTime?`、`qualificationDay String?` 和 `[inviterId,status,qualifiedAt]` 索引。迁移前全部记录以 default `legacy` 保留。
3. `GrowthReward` 模型及 `dedupeKey` / `inviteRelationId` unique、`[state,availableAt]` 索引。
4. `AbuseEvent` 模型，外键使用审计保留语义（关联 User 删除时 `SetNull`），带时间/类型/邀请人索引。

迁移生成和验证必须显式指向专用数据库 `monexus_rap_test`。若前置/并行 migration 在本分支前合入，重新从 develop 生成，而非重命名或手改已提交 SQL。

### 4.2 注册事务

```text
assert registrationEnabled
→ abuse preflight IP bucket
→ verify Turnstile
→ abuse registration IP/email buckets
→ hash password
→ transaction:
     recheck email uniqueness
     create User
     create PointAccount(balance=0)
     create GrowthReward(registration, pending_verification, snapshot amount,
                         dedupeKey=registration:<userId>)
     if inviter qualifies now and pending bucket allows:
       create InviteRelation(pending_verification)
       snapshot invite reward/tier result into candidate referral reward metadata
→ initial refresh-session transaction (existing session lock protocol)
```

邀请码符合资格但 reward amount 需日后才创建时，把 snapshot 放在 `InviteRelation` 新的受控字段或将 inviter GrowthReward 在同一注册事务创建为 `pending_verification`。计划采用后者：`GrowthReward(inviteRelationId unique, kind='referral', state='pending_verification')` 在 relation 创建时创建，金额已冻结但尚未入账。

`buildAuthUser` 必须返回 PointAccount 实际 0 分，而不是原 `registerReward` 常量。前端不得显示“已赠送 500 积分”。

### 4.3 邮箱验证/邀请码 qualification 事务

```text
authenticate current user
→ Redis/bound token verification only (no external SMTP)
→ transaction:
     conditionally claim EmailVerificationToken
       WHERE !used && expiresAt > now && userId = currentUserId
     UPDATE User SET emailVerified=now WHERE emailVerified IS NULL
     transition registration GrowthReward pending_verification → held
       (availableAt=now + configured hold days)
     find current user's pending InviteRelation
     SELECT inviter User FOR UPDATE
     re-check inviter: normal, verified, aged, !referralSuspended
     count qualified total and Shanghai-day qualified rows under lock
     if quota remains:
       relation → qualified; qualifying date recorded
       referral GrowthReward → held (same availableAt)
     else:
       relation → quota_exhausted; referral reward → voided
     write safe AbuseEvents
```

如果 `User.emailVerified` 已非空，verification token 仍消费或返回通用成功均可，但不得再次 transition/release reward。实现选择：先条件 claim token；若 user 已验证，返回 `200 { ok:true, alreadyVerified:true }` 且不修改任何 GrowthReward，避免用户错误重试呈 400。

### 4.4 奖励 cron

新增 `server/src/modules/auth/growthRewardCron.ts`，每分钟运行一次，复用 `acquireCronLeaseWithHeartbeat('growthRewards', interval)`：

1. 每批最多 100 条 `state='held' AND availableAt<=now`。
2. 在一个数据库 transaction 内用 `FOR UPDATE SKIP LOCKED` 选取；逐条条件更新/重读 recipient status。
3. recipient 被封禁、inviter 已 suspended 或 relation voided 时 update `voided`；否则 `PointAccount.increment(amount)`、创建一条固定 reason 的 `PointLog`、写 `grantedAt/state='granted'`。
4. 任何异常回滚本批 transaction；下一次 tick 可重试。不能先标 granted 再事务外写账。

管理员 void 使用同一 row-lock 条件，和 cron 竞争时只能有一个状态迁移成功。cron 不调用 SMTP、Turnstile 或 Redis。

### 4.5 AbuseEvent 与管理员投影

新 `server/src/modules/auth/abuseEvents.ts` 采用 `securityEvents.ts` 同样的封闭词表/安全 serializer：

- `type`、有限 enum `reason`、非负 count、`caseRef` 允许进入 `detailSafe`；不允许任意异常 message 或对象。
- IP/email 使用 `ABUSE_HASH_KEY` HMAC；UA 只允许既有 fixed device hint。
- `AbuseEvent` 写入失败时：安全拒绝/账务 transaction 必须回滚；纯 metrics 写失败不应改变业务结果。

新增 `server/src/modules/admin/abuseService.ts` 和 `abuseController.ts`。所有管理员 mutation 包一条 transaction：验证合法 caseRef → 锁目标 → 条件 state 更新 → AdminLog → AbuseEvent。列表仅返回 masked email、状态、金额、时间、caseRef、分页信息。

---

## 5. 路由与前端集成

### 5.1 后端路由落点

| 路由文件 | 变更 |
| --- | --- |
| `auth/routes.ts` | register 保护链；send-verification/reset limiter；POST verify；legacy GET 不再改 DB |
| `orders/routes.ts` | 仅 `POST /`、review create/update 加 `requireVerifiedEmail` |
| `points/routes.ts` | 仅 `POST /checkin` 加 gate |
| `merchant/routes.ts` | `/register` 加 gate；merchant 历史售后路径不重排 |
| `uploads/routes.ts` / `deliveryFileRoutes.ts` | upload POST 加 gate，public GET 不变 |
| `admin/routes.ts` | existing MFA middleware 后挂 `/abuse/*` |
| `app.ts` | 不新增 public bypass；按现有顺序挂载即可 |

路由顺序必须确保：认证/JSON schema 的可读错误可先于业务 gate；但所有外部/写副作用都只能发生在对应 abuse/verification guard 后。

### 5.2 前端文件落点

| 文件 | 变更 |
| --- | --- |
| `src/api/auth.ts` | registration status union、register token、POST verification API、typed error helpers |
| `src/components/TurnstileWidget.tsx` | 动态加载/cleanup 的窄组件；site key/token 仅 React memory |
| `src/pages/LoginPage.tsx` | 状态机增 available/unavailable/challenge；延迟奖励文案；不存 token |
| `src/pages/VerifyEmailPage.tsx` | fragment parse/立即移除；已登录才 POST；未登录提示登录后重新发送链接 |
| `src/components/EmailVerificationBanner.tsx` | resend cooldown、action-oriented copy、403 gate recovery |
| `src/components/VerifiedActionGate.tsx` | 可复用的购买/签到/申请/上传前 UX，不当作授权边界 |
| `src/pages/ProductDetailPage.tsx`、`ProfilePage.tsx`、`MerchantApplyPage.tsx` | 接入 gate；更新奖励/邀请状态文案 |
| `src/api/adminAbuse.ts`、`src/components/admin/AbuseProtectionPanel.tsx` | 独立 admin API/panel |
| `src/pages/AdminPage.tsx` | 移动端合入后仅插入 panel；保留 safe-area 与 tab layout |

Turnstile script 加载失败并不意味着可直接提交；UI 保留刷新 challenge 控件，server 将最终决定拒绝。管理员操作的所有表单使用 40px+ 触控目标及 keyboard-accessible Dialog。

---

## 6. 测试策略

### 6.1 后端

| 套件 | 关键证明 |
| --- | --- |
| `registration-abuse-limiter.test.ts` | Lua bucket 边界、并发、TTL、Redis outage、无下游 verifier/mailer 调用 |
| `human-verification.test.ts` | action/hostname/timeout/secret redaction、无 HTTP bypass |
| `email-verification-ownership.test.ts` | token 仅属主会话 claim；匿名 GET zero mutation；fragment flow contract |
| `email-send-abuse.test.ts` | verification/reset 多维限流、generic reset response、旧 token invalidation、mailer zero-call |
| `verified-value-gates.test.ts` | 指定 route 全覆盖及免拦截售后 route |
| `growth-rewards.test.ts` | snapshots、hold/cron、void、legacy migration、PointAccount/PointLog atomicity |
| `referral-quota-concurrency.test.ts` | 真实 PostgreSQL 锁下最后一个 quota 名额、重复 verify/cron、day boundary（Asia/Shanghai） |
| `admin-abuse-operations.test.ts` | MFA/RBAC、caseRef、masked projections、AdminLog/AbuseEvent、cannot void granted |

### 6.2 前端与 E2E

- Turnstile 使用 mock script/verifier，不能请求真实 provider。
- 注册状态机：open + challenge、disabled、unavailable、provider failure、旧前端 direct API rejection。
- 未验证用户：可浏览/登录/发验证邮件，但购买/签到/商家申请/上传均出现可理解 gate；验证后 `/me` refresh，受限动作恢复。
- fragment token 不能出现在最终 URL、localStorage、sessionStorage、console 或 screenshot trace payload；未登录用户只能重新发送，不能匿名 verify。
- 管理员以真实 MFA helper 登录；panel 只接精确 pathname mock 或受控测试 fixture，mobile E2E 原文件不改。

### 6.3 PBT / 不变量

1. 任意并发 consume 序列的 `allowed` 次数不超过每一个 bucket limit。
2. Redis unavailable 输入下，注册、token 行、SMTP capture、积分账本计数均零增。
3. 对任意未验证 user / 受保护写路由组合，响应都是 `EMAIL_VERIFICATION_REQUIRED` 且副作用零增。
4. 任意 verifier 输出中，只有指定 success/action/hostname 三元组可创建账号。
5. 任意验证 token 只能被其 userId 的活动会话消耗一次；不同 user/session、expired、used 都不改变邮箱状态。
6. 任意 relation/cron/void 并发交错后，每个 `GrowthReward.dedupeKey` 最多对应一笔 PointLog，余额等于流水可用入账和。
7. 任意配置/时间序列下，qualified relation 数不超过邀请人 daily/lifetime cap；历史 legacy relation 从不转换为新奖励。
8. 任意 API/日志/审计/metrics 序列化都不含 token、完整邮箱、原始 IP、HMAC key、Turnstile secret 或 SMTP secret 金丝雀。

---

## 7. 风险、发布与回滚

| 风险 | 缓解 / 决策 |
| --- | --- |
| Redis 使注册/邮件变为依赖 | 仅限新账号/用户邮件路径 fail-closed；本发布使用认证、AOF `everysec` 的单机本地 Compose Redis，加 `REDIS_REQUIRED=true`、ready/alert 保证；不部署 Sentinel/副本，也不宣称 HA；已验证交易不依赖它 |
| Turnstile 或网络故障降低注册转化 | managed 模式最小摩擦；明确 transient UI；可临时关闭总注册开关，不安全地放开 CAPTCHA 不是应急手段 |
| 邮箱验证阻断老用户 | 默认 gate 0、至少 14 天提醒、保留售后/订单查询；用 support SOP 处理真实收不到邮件的用户 |
| 用户自动化点击邮件链接 | 认证绑定 POST 防止匿名 scanner 直接获得资格；不声称这替代 KYC |
| 账务迁移错误 | 历史 InviteRelation=legacy，新的 ledger 只对新注册生效；migration 后做 row count/balance reconciliation |
| 同时修改 schema 的分支 | 独立 worktree、rebase 后重新生成/验证 migration，禁止手工拼 SQL |
| AdminPanel 与移动 UI 冲突 | 后端/数据先行；前端仅在 mobile PR 合并后基于最新 develop 集成；AdminPage 改动手工 review |

### 7.1 回滚原则

- 先用 `registrationEnabled=0` 停止新的攻击面；不删除 migration、不清 Redis key、不篡改账本。
- 如验证门槛导致不可接受客服量，可将 `emailVerificationRequiredForValue=0` 回退；奖励 held 流程、Turnstile 和邮件 limiter 仍保持。
- Redis/Turnstile 事故应修复依赖或暂停注册；不得把 production `ABUSE_PROTECTION_MODE` 改为 off。
- 仅 held/pending reward 可经 caseRef void；granted 的纠正走现有积分调整并保留审计。

---

## 8. 文档同步

必须同步：

- `docs/superpowers/specs/monexus-api-openapi.json`：新/变更 auth/admin API、错误码、DTO；
- `server/src/modules/auth/README.md` 与 `server/src/modules/admin/README.md`：资格、邮件、邀请码、运维边界；
- 根与 server `.env.example`：所有新变量仅给占位符；
- `docs/operations/runbook.md`、`docs/operations/secrets-management.md`、部署模板与 `scripts/check-prod-env.sh`：Redis/Turnstile/ABUSE_HASH_KEY preflight、邮件/灰度/回滚 SOP；
- `src` 用户文案：删除“注册即送”“邀请一人即得”这类错误承诺。

---

## 9. 修订记录

当前发布决定：使用单机、持久化 Redis；主机故障下保护路径 fail-closed，不引入 Sentinel 或副本。

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-08-01 | 初版技术计划：安全依赖、数据迁移、并发账务、前后端和发布策略。 |
