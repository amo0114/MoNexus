# Leaderboard Module

积分排行榜（SPEC-LEADERBOARD-001）。总榜 / 本月榜 / 本周榜三张，每日刷新一次，
读侧只查快照表，不碰 `PointLog`。

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | :---: | --- |
| GET | `/api/leaderboard?scope=total\|month\|week` | Bearer | 该期 Top 100 + 请求者自己的名次。`scope` 缺省 `total`，非法值 400 `VALIDATION_ERROR`。 |

Router 级 `authenticate + requireActiveUser`（与 points 模块同姿态）：匿名 401，
封禁 403。没有写端点——榜单只由 cron 生成。

## 计分口径

窗口内 `PointLog.type='in'` 的 `amount` 之和。`out` / `hold` / `release` / `refund`
一律不计。**这与 `lib/memberTier.ts` 的 `computeLifetimeEarnedPoints` 是同一口径，
两处修改必须同步**——否则总榜与会员等级会对同一用户给出两个"累计获得"。

参与资格 = `role != 'admin'` 且 `status != '已封禁'`，merchant 正常参与。资格在
**快照生成时**判定：封禁用户次日从榜上消失，不做读时实时剔除。

## 时间窗口

全部经 `lib/businessTime.ts` 的显式时区 helper，禁止 host-local `Date` 边界运算。

- 业务时区 Asia/Shanghai；周榜以**周一**为一周起点。
- cutoff = 刷新当日北京 00:00 的物理时刻，即**数据截至昨日 24:00**。
  周期窗口 = `[periodStart, min(periodEnd, cutoff))`。
- `businessDayStartUtc(dateStr)` 是日历日的**物理时刻**，`calendarDayToUtc` 是日历日
  的**存储值**（UTC 零点），两者差 8 小时。过滤 `createdAt` 只能用前者。

两个已经踩过的坑，改这里之前先读：

1. `dashboard/service.ts` 的月边界用 host-local `Date` 运算——不要照抄（LB-11）。
2. `PointLog.createdAt` 是 `timestamp without time zone`（存裸 UTC），而 `$queryRaw`
   把 JS `Date` 绑成 `timestamptz`。裸比较会让 PG 按**会话时区**重新解释裸列，窗口整体
   偏 8 小时；且该错误在 UTC 会话下不显形，只在中国时区的库上出现。聚合里统一用
   `${instant}::timestamptz AT TIME ZONE 'UTC'`，左侧保持裸列以便走
   `PointLog(type, createdAt)` 索引。回归用例：`__tests__/leaderboard.test.ts`
   「窗口边界不随 PG 会话时区漂移」。

## 快照模型

`LeaderboardEntry(scope, periodKey, rank, userId, points, computedAt)`。

- `periodKey`：`ALL` / `M<YYYY-MM>` / `W<周一日历日>`。周用**周一日期**而非 ISO 周号，
  规避 ISO week-year 的跨年歧义（2026-12-28 属 2027-W01）。
- 写侧存**全量**合格且窗口内有得分的用户，不截断——「我的排名」因此是精确值而不是
  "未上榜"；Top 100 只是读侧的 `LIMIT`。窗口内无 `in` 流水的用户不入快照。
- 排名全序（可重跑复现）：`points` 降序 → 窗口内最后一笔 `in` 的 `createdAt` 升序
  （先达到该分数者靠前）→ `userId` 升序。名次连续无并列。
- 替换 = 单事务内 `deleteMany` + `createMany`，MVCC 保证读侧只见完整的旧份或新份；
  事务开头按 `(scope, periodKey)` 取 advisory lock，同期两轮并发不会撞 unique 约束。

## 刷新任务

`cron.ts`：60s tick + `leaderboard-refresh` 24h 租约窗口 → 全舰队每日至多成功一轮。
不做「定点 00:05」对时——cutoff 只由业务日历日推导，与批次实际运行时刻无关；同日重复
执行只是重算同一窗口，幂等兜底。

每轮刷新集合 = 当前 `{total, month, week}` ∪ 周期切换日的补刷：**每月 1 日补刷上月、
每周一补刷上周**。没有补刷，周期最后一天的流水永远进不了定格快照（cutoff 恒在期末
之前）。更早的周期不在集合内，定格后的 `periodKey` 不再被触碰，历史自然保留。

`refreshLeaderboards({ now })` 的 `now` 可注入：cutoff 与期集合全部由它推导，测试
因此不依赖宿主时钟（CI 跑 UTC、开发机跑 +0800，两边必须同结果）。

## 响应边界

`top` 行的字段集恰为 `{ rank, displayName, points, isMe }`——**绝不返回他人 `userId` /
`email` / 余额**。`isMe` 由服务端计算，前端高亮不需要他人身份。
`displayName = nickname?.trim() || maskEmail(email)`，与 `reviews/service.ts` 的
`displayNameFor` 同口径，两处修改必须同步。

`me` 为 `null` 的两种情形：请求者不合格（admin），或本期无得分。

`updatedAt` / `dataThrough` 由快照的 `computedAt` 反推，**不由请求时刻反推**——cron
落后时不能谎称数据比实际更新。该期一行都没有（首刷空窗、或新周期首日窗口为空）时
返回 `top: []` 且两者均为 `null`，前端走空态。

## Related

- `docs/specs/points-leaderboard.md` — 规格（规则 LB-01…LB-11、验收标准）。
- `docs/superpowers/specs/monexus-api-openapi.json` — `GET /api/leaderboard` 契约。
- `src/__tests__/leaderboard.test.ts` — 性质 P.1–P.8 与验收 1–6。
