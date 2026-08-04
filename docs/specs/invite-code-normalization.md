# Spec：邀请体系重构——资格准入 + 周期名额 + 一次性邀请码

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-INVITE-001 |
| 版本 | 2.1.0（2.1 增补邀请链接；v1「常驻码规范化」方案被 v2 整体取代） |
| 日期 | 2026-08-02 |
| 状态 | Ready for Implementation |
| 产品 | MoNexus |
| 关联模块 | `server/prisma/schema.prisma`、`server/src/modules/invite`（新）、`server/src/modules/auth/*`、`server/src/lib/systemConfig.ts`、`server/src/lib/memberTier.ts`、`src/pages/ProfilePage.tsx`、`src/pages/LoginPage.tsx`、`src/components/admin/*` |

---

## 1. 背景与模型转变

### 1.1 现状核查结论（2026-08-02，代码 + 开发库实测）

1. 现行模型是「每用户一枚常驻邀请码」：`User.inviteCode @unique @default(uuid())`，自助注册用户为 36 位 UUID，seed 账号为手写字符串，格式不统一且任何人（含刚注册、未验证邮箱的账号）个人中心都展示邀请码。
2. 邀请人资格校验（`growthRewards.ts:171`：状态正常 + 邮箱已验证 + 未被暂停 + 账龄 ≥ 30 天）发生在**被邀请人注册时**且失败**静默降级**——码人人可见可分发，但绑定悄悄失败。开发库 `InviteRelation` 为 0 行即此机制所致。
3. 管理后台已有全局注册开关 `registrationEnabled`，无邀请码注册（invite-only）模式。

### 1.2 产品决策（本版核心）

**资格前置到「发码侧」：没有邀请资格的账号根本不给邀请入口，而不是让不合格者发码后静默失败。** 具体：

1. 邀请资格向**高等级会员**开放（会员等级 = 累计获得积分驱动的 bronze/银卡/金卡/铂金体系），门槛后台可调。
2. 邀请不是无限的：合格用户按**周期获得邀请名额**，用名额**生成一次性邀请码**（一码一人，用后即废）。
3. 管理员：**生成邀请码不限量**（注意语义：是"可以无限生成码"，不是"一个码无限次使用"——码本身仍然一次性）。
4. 商家（merchant 角色）：周期名额高于普通用户。
5. 常驻个人码退役：`User.inviteCode` 字段删除，邀请码成为独立的可生成、可过期、可撤销的实体。

## 2. 目标与非目标

### 2.1 目标

1. 新表 `InviteCode`：一次性邀请码,8 位大写短码,有生成者、有效期、使用状态、使用者。
2. 发码资格：admin 恒可发（不限量）;merchant 与普通用户需满足基础资格（状态正常、邮箱已验证、未被 `referralSuspended`、账龄 ≥ `referralInviterMinAgeDays`),普通用户额外要求会员等级 ≥ 配置门槛（默认金卡）。
3. 周期名额：按**上海时区自然月**计,普通合格用户 / 商家各自有可配额度;名额在**生成时消耗**,过期未用不返还。
4. 注册侧：携码注册即**原子领用**该码（并发安全,严格一次性）;码不存在/已用/过期/已撤销/生成者被暂停 → **显式 400**,不再有任何静默路径。
5. `registrationInviteOnly` 开关（沿承 v1）：开启后注册必须携有效邀请码。
6. 邀请关系与奖励管线维持 RAP 现状：领码成功 → 建 `pending_verification` 关系 + 冻结 referral 奖励 → 被邀请人邮箱验证后进入 qualified 流程。
7. 个人中心：合格用户看到「剩余名额 + 生成按钮 + 我的码列表（状态/有效期/复制）」;不合格用户**无生成入口**,仅展示不可交互的等级门槛提示（如「金卡及以上会员可邀请好友」,兼作升级激励）。
8. 管理后台：名额/门槛/有效期配置项进既有 config 面板;admin 自身在个人中心同一入口发码（不限量）。

### 2.2 明确不在范围内

1. 不做多次使用码、不做自定义码、不做换绑。
2. 不做管理后台的全量码列表/单码撤销 UI（`referralSuspended` 暂停某用户即冻结其全部未用码,已覆盖滥用处置;单码管理留待需要时加）。
3. 不改会员等级体系与奖励金额/成熟管线;不改 `referralDailyQualifiedLimit` / `referralLifetimeQualifiedLimit`（继续作为奖励侧兜底,运营需保证月名额 ≤ 生命周期上限的合理比例）。
4. 不做名额返还/顺延、不做邀请码转赠。

## 3. 领域规则与不变量

| ID | 规则 |
| --- | --- |
| IV-01 | 码格式：`^[A-Z0-9]{8}$` 存储;生成字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（剔除 I/O/0/1）,CSPRNG 生成,全表唯一,撞唯一约束重试 ≤5 次。输入归一化 trim + 大写后匹配。 |
| IV-02 | 码生命周期：`active → used | expired | revoked`。`used` 由注册事务原子迁移;`expired` 为惰性判定（`expiresAt < now` 即视同过期,无需定时任务改状态,读侧统一口径）;`revoked` 预留（本期仅 schema 支持）。 |
| IV-03 | 严格一次性：领用 = 条件更新 `WHERE code=? AND status='active' AND expiresAt > now` 影响行数必须为 1,在注册事务内执行;并发两注册同码时恰一人成功。 |
| IV-04 | 发码资格（生成时判定,事务内锁 User 行复核）：admin → `status='正常'` 即可;merchant / user → 状态正常 + `emailVerified` 非空 + 未 `referralSuspended` + 账龄 ≥ `referralInviterMinAgeDays`;user 额外要求 `resolveTier(lifetimeEarned) ≥ inviteMinTierRank`。不满足 → 403,响应含结构化原因码（前端渲染门槛提示）。 |
| IV-05 | 名额周期 = 上海时区自然月（`businessTime` helpers,禁 host-local 边界运算）。额度：admin 不限;merchant = `inviteQuotaMerchantMonthly`（默认 10）;user = `inviteQuotaUserMonthly`（默认 3）;0 = 暂停该角色发码。计数口径 = 当月已生成的码数（含已用/已过期,不返还）。 |
| IV-06 | 名额并发安全：生成事务内 `SELECT ... FOR UPDATE` 锁发码人 User 行后 count-then-insert,杜绝并发超发（沿用 P6 锁序惯例,该事务只锁 User 行）。 |
| IV-07 | 注册领码失败一律显式：不存在/已用/过期 → 400「邀请码无效或已失效」（统一文案,不区分泄露码状态）;生成者当前 `referralSuspended` 或状态非正常 → 同文案 400（滥用处置即时冻结其存量未用码的效果）。 |
| IV-08 | `registrationInviteOnly` ∈ {0,1} 默认 0。开启时无码注册 → 400「当前仅限邀请注册」;检查位于 `assertRegistrationEnabled` 与滥用防护之后、查邮箱重复之前。`GET /auth/registration-status` 增加 `inviteRequired`。 |
| IV-09 | 领码成功后邀请关系创建**不再有静默降级**：码在 IV-07 通过即建 `InviteRelation(pending_verification)` + 冻结 referral 奖励。RAP 的 Redis pending-relation 预约（`consumePendingReferralRelation`）从码路径移除——其防的"无限常驻码堆积 pending 关系"前提已被生成侧名额消灭;奖励侧 qualified 配额与资格复核保持不动。 |
| IV-10 | `User.inviteCode` 列删除;auth 响应/前端类型同步移除该字段。历史常驻码全部作废（当前生产 `InviteRelation` 0 行、无已生效邀请传播,作废零成本;`InviteRelation` 存量表结构不动）。 |
| IV-11 | 码有效期 = 生成时刻 + `inviteCodeTtlDays`（默认 14,1–90）。展示与判定统一用 `expiresAt` 物理时刻。 |
| IV-12 | 所有新配置走 SystemConfig 封闭 union（数值型）：`registrationInviteOnly`{0,1}、`inviteMinTierRank`{0=不限,1=银卡,2=金卡,3=铂金;默认 2}、`inviteQuotaUserMonthly`（默认 3）、`inviteQuotaMerchantMonthly`（默认 10）、`inviteCodeTtlDays`（默认 14,1–90）。变更经既有 `PUT /admin/config/:key`（MFA + AdminLog）。 |
| IV-13 | 邀请链接 = `${origin}/i/<code>`（专用短前缀路由,不用裸 `域名/码`——裸路径与现有及未来顶级路由冲突且无自描述性）。`/i/:code` 为纯前端公开落地路由:码格式合法 → 跳转 `/login?invite=<code>` 自动进入注册态并预填邀请码;格式非法 → 跳转普通注册页不带参。**不提供公开的码状态预检接口**（防枚举探测）,码是否有效一律由注册提交时后端裁决。链接与手填码后端完全等价、无新增服务端面。 |
| IV-14 | 码会出现在 URL（链接分享是明示行为）:可接受面已由一次性 + 短有效期收敛;前端不得把 `invite` 参数写入持久化存储或上报类日志,预填后应从地址栏 `replaceState` 清除参数。 |

## 4. 数据模型

```prisma
model InviteCode {
  id           Int       @id @default(autoincrement())
  code         String    @unique // ^[A-Z0-9]{8}$，生成字母表见 IV-01
  issuerId     Int
  status       String    @default("active") // active | used | expired | revoked（expired 惰性，见 IV-02）
  expiresAt    DateTime
  usedByUserId Int?      @unique
  usedAt       DateTime?
  createdAt    DateTime  @default(now())

  issuer   User  @relation("InviteCodeIssuer", fields: [issuerId], references: [id])
  usedBy   User? @relation("InviteCodeUsedBy", fields: [usedByUserId], references: [id], onDelete: SetNull)

  @@index([issuerId, createdAt])      // 月度名额计数
  @@index([issuerId, status])         // 个人中心列表
}
```

`User`：删除 `inviteCode` 列;新增两条反向 relation。

## 5. API 面

| 端点 | 说明 |
| --- | --- |
| `GET /invites/me` | 登录用户：`{ eligible, reason?, tierRequired?, quota: { limit, used, remaining, periodKey } \| null(admin 为 null 表不限), codes: [{ code, status, expiresAt, usedAt }] }`;不合格用户返回 `eligible:false` + 原因码,不返回 codes。 |
| `POST /invites` | 生成一枚码;403（无资格）/ 409（名额耗尽）/ 201。 |
| `POST /auth/register` | 请求体 `inviteCode` 语义变更为一次性码,失败显式 400（IV-07/IV-08）。 |
| `GET /auth/registration-status` | 增 `inviteRequired`。 |

## 6. 前端

1. `ProfilePage` 邀请卡重做：合格 → 名额进度 + 生成 + 码列表（状态/过期时间,每枚码提供「复制邀请码」与「复制邀请链接」双操作,链接用 `window.location.origin` 拼 IV-13 形态）;不合格 → 锁定态提示（按 `reason` 渲染:等级不足显示「{门槛等级}及以上会员可邀请好友」,其余原因显示通用不可用文案）;删除现有常驻码展示与 `'MOYUAN26'` 硬编码回退。 |
2. `LoginPage`：`inviteRequired` 时邀请码必填;读取 `?invite=` 参数自动切注册态、预填并清参（IV-13/IV-14）;400 文案透出。
3. `App.tsx`：新增公开路由 `/i/:code`（落地跳转组件,无需登录态）。
4. 管理后台：五个新配置 key 自动进 `AdminConfigPanel`（分组「账户与注册」);`RegistrationControlPanel` 增加 invite-only 开关。

## 7. 验收标准

1. 铂金/金卡（默认门槛）正常用户可生成码,月内第 4 枚被 409 拒;银卡/bronze 用户 `GET /invites/me` 得 `eligible:false` 且个人中心无生成入口;admin 连续生成 > 名额上限不受限;merchant 上限 10。
2. 未验证邮箱 / 账龄不足 / 被 `referralSuspended` 的高等级用户同样 `eligible:false`（发不出码,而非发码后静默失败）。
3. 同一码并发两注册恰一成功;已用/过期/被暂停发码人的码注册 400。
4. 领码注册必产生 `pending_verification` 关系 + 冻结奖励;被邀请人验证邮箱后进入既有 qualified 流程（RAP 回归测试全绿）。
5. invite-only 开关行为同 IV-08;开关与配置变更均落 AdminLog。
6. `User.inviteCode` 删除后全套单测 + e2e 绿;auth 响应不再含该字段。
