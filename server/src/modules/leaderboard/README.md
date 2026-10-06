# Leaderboard Module

当前规则见 [SPEC-LEADERBOARD-001](../../../../docs/specs/points-leaderboard.md)（1.1）。

- `GET /api/leaderboard?scope=total|month|week` 要求登录且未封禁，返回 Top 100 与自己的精确排名。
- 当前读侧按 `[北京时间自然周期起点, 请求截止时刻)` 累计正额 `in` 流水，包含今天，不依赖每日 cron。退款、消费、冻结、释放不计。
- `getLeaderboard` 在同一 SQL 里完成当前排名、今日零点基线排名、身份投影。只返回最多 101 行；同分按最后一笔获得时间、userId 排序。
- 资格在当前查询判定；他人响应仅有 rank/displayName/avatarUrl/points/isMe/prevRank，没有 userId、email 原文或余额。
- `updatedAt` 是本次查询截止时刻，`dataThrough` 是对应北京日期；空榜也返回有效时间，不再借用总榜 computedAt。
- 默认头像由 `auth/avatarPresets.ts` 按不可变用户 ID 映射固定 v2.3 名单，保存的头像优先。前端自己的头像使用相同映射。
- 原 `refreshLeaderboards` / cron / `LeaderboardEntry` 保留历史快照，仍按截至昨日聚合，并补刷最近结束的周／月；当前 API 不读取这些快照。

## 时间与数值约束

全部边界通过 businessTime helpers。`timestamp without time zone` 列存裸 UTC；JS Date 参数必须经 `::timestamptz AT TIME ZONE 'UTC'` 绑定，否则非 UTC 数据库会话会错移窗口。聚合为 bigint，API 序列化前检查 JS 安全整数范围。

## 验证

`server/src/__tests__/leaderboard.test.ts` 保留历史快照、事务、租约与 API 鉴权／隐私测试；`leaderboard-current.test.ts` 覆盖当日统计、边界、跨年、同分、日基线变化、资格与头像；前端 `src/pages/LeaderboardPage.test.tsx` 覆盖展示与重拉生命周期。
