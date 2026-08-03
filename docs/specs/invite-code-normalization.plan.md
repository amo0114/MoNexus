# Plan：邀请体系重构——资格 + 名额 + 一次性码（SPEC-INVITE-001 v2.0.0）

配套 spec：`docs/specs/invite-code-normalization.md`（v2）。develop 拉特性分支实施,PR 目标 develop。

## 前置事实（实施者需知）

- 现行常驻码：`server/prisma/schema.prisma:17` `inviteCode String @unique @default(uuid())` → 本次**删除该列**,受影响面：`buildAuthUser`（`auth/service.ts:106`）、`src/api/auth.ts` 用户类型、`ProfilePage.tsx:444-462` 邀请卡、`seed.ts:70/93/106` 固定码、`__tests__/helpers.ts` 的 `TEST-` 码、若干 e2e。
- 注册链路：`registerUser`（`auth/service.ts:282`）;RAP 候选解析 `resolveEligibleReferralInviteCandidate` + `reservePendingReferralCandidate`（Redis 预约,**本次从码路径移除**,见 spec IV-09,`abusePolicy.ts` 的 `consumePendingReferralRelation` 保留给其他调用方或删除——grep 确认无其他调用方后可删）。
- 关系+奖励创建：`createPendingReferralGrowthReward`（`growthRewards.ts:219`,锁 inviter 行）——保留,但其入参候选改由"已领用的码"给出。
- 等级：`server/src/lib/memberTier.ts`（`resolveTier` + `getCurrentTierConfig`;lifetime 口径 `computeLifetimeEarnedPoints`,type='in' 求和,与 leaderboard LB-01 同口径）。
- SystemConfig 注册范式与 BOOLEAN_KEYS：`server/src/lib/systemConfig.ts`（参照 `registrationEnabled`;注意该文件有 union 封闭 + 校验表 + 分组/单位/描述五处要同步）。
- 时间边界：`server/src/lib/businessTime.ts`,月周期 periodKey 参照 leaderboard 的 `M2026-08` 风格;CI 是 UTC、本机 +0800（memory）,月初边界测试要显式钉时区。
- 模块样板：`server/src/modules/leaderboard`（新模块的 routes/controller/service/README 结构参照）。
- 测试基建：TEST_DATABASE_URL + REDIS_ENABLED=false + API_RATE_LIMIT_MAX=3000;e2e 需 Node 20 + TOTP seed(memory)。

## 任务分解

### T1 码工具库（server/src/lib/inviteCode.ts,新）

- `generateInviteCode()`：字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`,`crypto.randomBytes` 映射 8 位（32 整除 256,无取模偏差）。
- `normalizeInviteCode(raw)`：trim + upper,`^[A-Z0-9]{8}$` 不符返回 null。
- 单测:格式/字母表排除项/归一化。

### T2 Schema 迁移

- 新表 `InviteCode`（spec §4 原样）+ `User` 删 `inviteCode` 列、加两条反向 relation。
- migration 一步完成:`CREATE TABLE` + `DROP COLUMN "inviteCode"`(存量常驻码直接作废,spec IV-10 已论证零成本;无 data migration)。
- `prisma generate` 后注意 memory「codex 宿主 prisma clobber」坑。

### T3 发码域模块（server/src/modules/invite,新）

- service:
  - `getInviteEligibility(userId, tx?)`:实现 IV-04 判定,返回 `{ eligible, reason }`,reason ∈ `not_verified | account_too_young | suspended | tier_too_low | role_paused`（配额 0 时）。admin 短路(仅要求状态正常)。
  - `getMyInvites(userId)`:资格 + 当月配额(businessTime 月窗口 count `InviteCode` where issuerId, createdAt in window) + 码列表(status 惰性折算 expired,IV-02)。
  - `createInviteCode(userId)`:事务内 `SELECT ... FOR UPDATE` 锁 User 行 → 复核资格 → count 当月已生成(admin 跳过) → 超额 409 → 生成写入(P2002 重试 ≤5,重试仅重掷码值)。
- routes/controller:`GET /invites/me`、`POST /invites`(authenticate 中间件,无 admin 要求);挂载进 app 路由注册处;README 按模块惯例。
- 单测:资格矩阵(role × tier × verified × age × suspended)、月边界(钉 Asia/Shanghai,防 CI UTC 分叉)、并发超发(pg_stat_activity barrier 惯例,参照 P6 并发测试)、admin 不限量。

### T4 注册链路改造（auth/service.ts + schema.ts + growthRewards.ts）

- schema.ts:`inviteCode` 改为归一化 transform + 8 位格式校验,坏格式 400「邀请码格式不正确」。
- `registerUser` 顺序:`assertRegistrationEnabled` → `enforceRegistrationProtection` → **invite-only 检查(IV-08)** → 查邮箱重复 → bcrypt → 事务:
  1. `tx.user.create`(不再传 inviteCode)。
  2. 携码时原子领用(IV-03):`tx.inviteCode.updateMany({ where: { code, status: 'active', expiresAt: { gt: now } }, data: { status: 'used', usedByUserId, usedAt } })`,count≠1 → 抛 400「邀请码无效或已失效」回滚整个注册。
  3. 领用成功后锁 issuer 行复核 `status='正常' && !referralSuspended`(IV-07 后半),失败同文案 400 回滚。
  4. 通过 → 复用 `createPendingReferralGrowthReward` 建关系+冻结奖励(其内部 `isEligibleReferralInviter` 复核对码路径放宽为上一步口径——tier/账龄在发码时已验,此处不重验;需在 growthRewards.ts 为码路径提供入口或参数化,**勿改动邮箱验证 qualified 管线的原口径**)。
  - 删除码路径的 `reservePendingReferralCandidate` 调用;`resolveEligibleReferralInviteCandidate` 若再无调用方一并删除。
  - 锁序:User(新用户,create 自带) → InviteCode 行(updateMany) → issuer User 行,全库统一此序,README 记录。
- `getPublicRegistrationStatus`:增 `inviteRequired`。
- `buildAuthUser` 及返回类型移除 `inviteCode`。

### T5 SystemConfig 五个新 key

- `registrationInviteOnly`(BOOLEAN_KEYS,默认 0)、`inviteMinTierRank`(0–3,默认 2)、`inviteQuotaUserMonthly`(默认 3)、`inviteQuotaMerchantMonthly`(默认 10)、`inviteCodeTtlDays`(1–90,默认 14)。五处同步:union、默认值表、描述、分组「账户与注册」、单位/校验表。
- 回归 `system-config.test.ts`。

### T6 前端

- `src/api/invites.ts`(新):两端点客户端 + 类型。
- `ProfilePage`:邀请卡重做(spec §6.1,含每枚码「复制邀请码/复制邀请链接」双操作,链接 = `${window.location.origin}/i/${code}`);删常驻码展示与 `'MOYUAN26'` 回退。
- `App.tsx`:公开路由 `/i/:code` → 落地组件校验 `^[A-Za-z0-9]{8}$`(宽松大小写,归一化交 LoginPage)后 `navigate('/login?invite=<CODE>', { replace: true })`,非法则去 `/login`。
- `LoginPage`:`useSearchParams` 读 `invite` → 自动 `setIsRegister(true)` + 预填(归一化大写) + `replaceState` 清参(spec IV-14,防刷新重放与分享泄露);`inviteRequired` 必填态 + 8 位前端预校验 + 400 透出。**注意:该文件当前有并行 logo/品牌 agent 在改,实施前先同步/rebase。**
- `src/api/auth.ts`:用户类型删 `inviteCode`,RegistrationStatus 增 `inviteRequired`。
- 管理侧:`AdminConfigPanel` BOOLEAN_KEYS 增补;`RegistrationControlPanel` 加 invite-only 开关;数值 key 走既有通用面板无需新 UI。

### T7 seed / 测试适配

- seed.ts:删固定码;可选为 admin 预生成 1 枚长效码便于本地联调(非必须)。
- `__tests__/helpers.ts`:建用户不再需要码;新增"发一枚可用码"helper(直插 InviteCode 行,绕过资格,供注册用例造数)。
- e2e:涉邀请码用例改为"先以 admin 生成码再注册";新增 invite-only 面板开关用例(并入 registration gate spec);标 run-e2e 惯例走 CI。
- 迁移后断言:User 表无 inviteCode 列引用残留(tsc 即可兜底)。

### T8 Turnstile 组件打磨(独立小任务,可与 T6 同 PR)

现状判定(2026-08-02 核查 `src/components/auth/TurnstileWidget.tsx`):组件用的是 CF 官方低摩擦模式 `execution: 'execute'` + `appearance: 'interaction-only'`——挂件在切到注册表单时即挂载,提交时才 `execute`,且只有 CF 判定可疑才弹交互框。"点提交才出现验证"**是刻意设计而非 bug**(多数用户全程无感;提交时取 token 也规避了 token 300 秒过期问题),保留该模式。要修的是观感:

1. **空盒子问题**:`phase==='ready'` 时容器是一个只有边框内无内容的空框(`min-h-px` + border + padding)挂在表单里——这就是"样式没做好"的主要来源。改法:利用 render 选项的 `before-interactive-callback` / `after-interactive-callback` 跟踪 iframe 是否可见,仅在(loading/checking/unavailable 文案 或 交互框可见)时渲染带边框容器,否则整个容器 `hidden`。
2. render 选项补 `size: 'flexible'`(替代默认 300px 固定宽,随表单撑满)、`language: 'zh-cn'`、`theme`(站点为单主题则定值,否则 'auto')。
3. `checking` 态与提交按钮 loading 态已联动,补一行常驻微文案「提交时将自动完成安全验证」于注册表单底部,消除"验证突然弹出"的意外感。

### T8b 【建议项,实施前找用户拍板】forgot-password 加 Turnstile

`POST /auth/forgot-password` 无 authLimiter(注释:邮件配额由跨实例 Redis mail limiter 兜底),但机器人仍可对任意邮箱触发发信直至烧穿配额(骚扰第三方 + 邮件信誉损耗)。建议复用注册侧整套模式:后端 `enforce*` 校验 `action: 'forgot_password'` token(沿 registration gate 的 fail-closed 语义)、`ForgotPasswordPage` 挂同款 widget。登录/reset-password/send-verification 已有限流+authLimiter+认证保护,**不加**,避免无谓摩擦。

## 任务依赖

T1 → T2 → (T3, T4 并行,T4 依赖 T5 的 key;T3 依赖 T5 的名额 key) → T6 → T7 收尾。T8 无依赖可随 T6;T8b 拍板后独立实施。建议实施顺序:T1+T2+T5 → T3 → T4 → T6 → T7。

## 风险与注意

1. **RAP 语义改动点只有两处**,勿扩散:(a) 码路径移除 Redis pending 预约(IV-09,生成侧名额已替代其防滥用职能);(b) 注册时 inviter 复核对码路径放宽为「状态正常 + 未暂停」。邮箱验证后的 qualified/quota/void 管线一律不动,`referralDailyQualifiedLimit`/`referralLifetimeQualifiedLimit` 继续生效——运营侧注意月名额与这两个上限的乘积关系(默认 3/月 vs 生命周期 20,自然月 3 也 ≤ 每日 3,不冲突)。
2. 领码失败回滚整个注册(用户已过 Turnstile):文案要引导重试;invite-only 关闭时用户可去掉码重注册。
3. 月度名额边界:CI UTC vs 本机 +0800(memory),所有窗口测试显式构造 Asia/Shanghai 时刻。
4. `expired` 是惰性状态:任何读侧(列表/领用)都必须以 `expiresAt` 为准,禁止只看 status 字段。
5. 删列是破坏性 schema 变更:确认无并行分支依赖 `User.inviteCode`(当前 logo agent 只动 UI 品牌,不冲突;上线跟随既有 migrate deploy)。
