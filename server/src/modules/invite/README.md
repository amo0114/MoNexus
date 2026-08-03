# Invite Module

一次性邀请码（SPEC-INVITE-001）。资格前置到**发码侧**：没有邀请资格的账号
没有邀请入口；注册侧的码是被原子领用的一次性票据，失败一律显式 400，
不再有任何静默降级路径。

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | :---: | --- |
| GET | `/api/invites/me` | Bearer | `{ eligible, reason?, tierRequired?, quota, codes }`。不合格用户返回 `eligible:false` + 原因码，不返回 codes；admin 的 `quota` 为 `null`（不限量）。 |
| POST | `/api/invites` | Bearer | 生成一枚码。403（无资格，消息按原因细分）/ 409（本月名额耗尽）/ 201。 |

Router 级 `authenticate + requireActiveUser`；资格判定是 service 的领域规则
（IV-04），不做路由级角色门。

## 发码资格（IV-04）

- admin：`status='正常'` 即可，名额不限（是"可无限生成码"，码本身仍一次性）。
- merchant / user：状态正常 + `emailVerified` 非空 + 未 `referralSuspended` +
  账龄 ≥ `referralInviterMinAgeDays`。
- user 额外要求 `resolveTier(lifetimeEarned) ≥ inviteMinTierRank`
  （0=不限 1=银卡 2=金卡 3=铂金，默认金卡）。
- 角色月名额配置为 0 = 该角色发码暂停（`role_paused`）。

原因码闭集：`not_verified | account_too_young | suspended | tier_too_low | role_paused`。

## 名额与并发（IV-05 / IV-06）

- 周期 = **上海时区自然月**（`lib/businessTime.ts`，periodKey `M<YYYY-MM>` 与
  leaderboard 同风格；禁止 host-local Date 边界运算）。
- 计数口径 = 当月**已生成**的码数（含已用/已过期），过期不返还。
- 生成事务：`SELECT ... FOR UPDATE` 锁发码人 User 行 → 锁下复核资格 →
  count-then-insert。该事务只锁这一行，无并发超发。
- 码值撞 `InviteCode.code` 唯一约束（P2002）时整个事务重跑，≤5 次。

## 码生命周期（IV-01 / IV-02 / IV-11）

- 存储格式 `^[A-Z0-9]{8}$`；生成字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
  （剔除 I/O/0/1，32 字符无取模偏差），CSPRNG（`lib/inviteCode.ts`）。
- `active → used | expired | revoked`。**`expired` 是惰性状态**：读侧一律以
  `expiresAt` 判定，无定时任务改写 status，任何读路径禁止只看 status 列。
- 有效期 = 生成时刻 + `inviteCodeTtlDays`（默认 14，1–90）。
- `revoked` 本期仅 schema 支持；`referralSuspended` 暂停某用户即时冻结其
  全部存量未用码（领用侧复核），已覆盖滥用处置。

## 注册领用（IV-03 / IV-07 / IV-09）

`claimInviteCodeForRegistration`（在 `registerUser` 事务内调用）：

1. 条件更新 `WHERE code=? AND status='active' AND expiresAt > now`，影响行数
   必须恰为 1——并发两注册同码时恰一人成功。
2. 领用成功后锁 issuer User 行复核 `status='正常' && !referralSuspended`。
3. 任何失败统一 400「邀请码无效或已失效」（不区分码状态，防枚举探测），
   并回滚**整个注册**。
4. 通过后建 `InviteRelation(pending_verification)` + 冻结 referral 奖励
   （`auth/growthRewards.ts` 的 `createClaimedReferralGrowthReward`——码路径
   不再重验 tier/账龄，发码时已验；邮箱验证后的 qualified 管线原口径不动）。

RAP 的 Redis pending-relation 预约已从码路径移除（IV-09）：其防的"无限常驻码
堆积 pending 关系"前提被生成侧名额消灭。

**锁序（全库统一，勿倒置）**：新用户 User 行（`tx.user.create` 自带）→
InviteCode 行（条件 updateMany）→ issuer User 行（`FOR UPDATE`）。

## 邀请链接（IV-13 / IV-14）

链接 = `${origin}/i/<code>`，纯前端公开落地路由，跳转
`/login?invite=<code>` 预填注册表单；**无公开的码状态预检接口**，码是否有效
一律由注册提交时后端裁决。前端预填后 `replaceState` 清除参数，不持久化。

## Related

- `docs/specs/invite-code-normalization.md` — 规格（IV-01…IV-14、验收标准）。
- `server/src/lib/inviteCode.ts` — 码生成与归一化。
- `server/src/__tests__/invite-codes.test.ts` / `invite-registration.test.ts` — 单测。
