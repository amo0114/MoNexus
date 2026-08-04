# Spec：积分排行榜

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-LEADERBOARD-001 |
| 版本 | 1.0.0 |
| 日期 | 2026-08-01 |
| 状态 | Ready for Implementation |
| 产品 | MoNexus |
| 关联模块 | `server/src/modules/leaderboard`（新）、`server/src/lib/businessTime.ts`、`server/prisma/schema.prisma`、`src/pages/LeaderboardPage.tsx`（新） |

---

## 1. 背景

积分体系已上线：`PointLog` 记录全部积分流水（`type` ∈ in/out/hold/release/refund），获得途径为每日签到（含等级加成）、注册/邀请奖励（成熟后发放）、管理员手工调整；会员等级由累计获得积分驱动（`computeLifetimeEarnedPoints`，只计 `type='in'`）。但积分目前只有个人视角（余额、明细、等级徽章），没有任何横向比较与激励面。

本特性提供总榜 / 本月榜 / 本周榜三张排行榜，每日刷新一次，Top 3 以颁奖台样式突出展示（金/银/铜头像框特效），4 名及以后为行式列表，并始终告知用户自己的排名。

## 2. 目标与非目标

### 2.1 目标

1. 登录用户可查看总榜、本月榜、本周榜（读侧 Top 100），并看到自己的排名与积分（未上榜也有明确反馈）。
2. 榜单每日刷新一次；页面明确标注数据截至日期，不承诺实时。
3. Top 1/2/3 颁奖台展示（第一名居中垫高），金/银/铜特效头像框；其余为行式列表，自己所在行高亮。
4. 榜单口径与会员等级完全一致：只计「获得」（`type='in'`）。

### 2.2 明确不在范围内

1. 不做真实头像（上传/存储/审核）；头像展示为 displayName 首字符的渐变字圆（现状全站无 avatar 字段）。
2. 不做往期榜单回看 UI（快照数据天然定格保留，将来可加，见 LB-10）。
3. 不做实时榜/推送；不引入 Redis 依赖（`cache.ts` 的 CacheName 封闭 union 本次不动；需要时后续迭代加 wrapCache）。
4. 不修改任何积分获取/消费规则，不新增积分玩法。

## 3. 领域规则与不变量

| ID | 规则 |
| --- | --- |
| LB-01 | 计分口径：窗口内 `PointLog.type='in'` 的 `amount` 之和。`out/hold/release/refund` 一律不计，与 `computeLifetimeEarnedPoints`（`server/src/lib/memberTier.ts`）谓词一致；两处口径修改必须同步。 |
| LB-02 | 三榜窗口按北京时间（Asia/Shanghai）：总榜 = 全历史；本月榜 = 自然月；本周榜 = 自然周，**周一**为一周起点。 |
| LB-03 | 数据右边界（cutoff）= 刷新当日北京时间 00:00 对应的物理时刻，即数据截至昨日 24:00。周期窗口 = `[periodStartUtc, min(periodEndUtc, cutoff))`。 |
| LB-04 | 排名全序：points 降序 → 窗口内最后一笔 `in` 的 `createdAt` 升序（先达到该分数者靠前）→ `userId` 升序。确定性、可重跑复现。 |
| LB-05 | 参与资格：`role != 'admin'` 且 `status != '已封禁'`；merchant 参与。资格在快照生成时判定（每日快照语义：封禁次日消失，不做读时实时剔除）。 |
| LB-06 | 窗口内无 `in` 流水的用户不入该期快照；其「我的排名」为 null（前端展示未上榜文案）。 |
| LB-07 | 公开面对「他人」只含 rank / displayName / points；`displayName = nickname?.trim() \|\| maskEmail(email)`（reviews 同款，`server/src/lib/email.ts`）。绝不返回他人 userId / email / 余额。 |
| LB-08 | 刷新幂等：同一 (scope, periodKey) 任意次重跑结果一致；快照替换在单事务内完成，读侧任意时刻只见完整的旧份或新份。 |
| LB-09 | 多实例安全：刷新经 CronLease 互斥 + 窗口节流，全舰队每日至多成功一轮（与既有 daily 任务同语义）；意外重复执行由 LB-08 兜底无害。 |
| LB-10 | 周期定格：每轮刷新覆盖当前周期，并在周期切换日补刷刚结束的周期（每月 1 日补刷上月、每周一补刷上周），保证定格快照包含周期最后一天的流水；定格后的 periodKey 不再被覆盖，历史数据自然保留。 |
| LB-11 | 时间边界一律经 `businessTime` helpers（显式时区），禁止 host-local Date 边界运算；物理时刻换算利用 Asia/Shanghai 恒为 UTC+8（1991 年起无夏令时）。禁止拷贝 `dashboard/service.ts` 的本地时区月边界写法（已知隐患）。 |

## 4. 后端设计

### 4.1 数据模型（Prisma migration）

```prisma
model LeaderboardEntry {
  id         Int      @id @default(autoincrement())
  scope      String   // 'total' | 'month' | 'week'
  periodKey  String   // 'ALL' | 'M2026-08' | 'W2026-07-27'（周一的日历日）
  rank       Int
  userId     Int
  points     Int
  computedAt DateTime // 本批次刷新时刻
  user       User     @relation(fields: [userId], references: [id])

  @@unique([scope, periodKey, userId])
  @@index([scope, periodKey, rank])
}
```

- `PointLog` 增 `@@index([type, createdAt])`（现状除主键零索引，时间窗聚合必须）。
- 周 periodKey 用「周一日期」而非 ISO 周号，规避 ISO week-year 跨年边界。
- **快照存全量**合格且窗口内有得分的用户（不在写侧截断 Top 100），以支持精确「我的排名」；Top 100 截断只发生在读侧。
- 新表必须加入 `server/src/__tests__/setup.ts` 的清库表列表。

### 4.2 businessTime 扩展

`server/src/lib/businessTime.ts` 新增纯函数（dateStr 进出，与现有风格一致）：

- `businessMonthStart(dateStr): string` — 所在月 1 号；
- `businessWeekStart(dateStr): string` — 所在周的周一；
- `businessDayStartUtc(dateStr): Date` — 该北京日历日 00:00 的物理 UTC 时刻（`new Date(dateStr + 'T00:00:00+08:00')`，注释注明无 DST 依据）。注意与既有 `calendarDayToUtc`（日历日的规范存储值）语义不同，流水过滤只能用本函数。

### 4.3 刷新任务

`server/src/modules/leaderboard/cron.ts` 照 `growthRewardCron.ts` 模板：60s timer + `acquireCronLeaseWithHeartbeat('leaderboard-refresh', 24h)`；`main.ts` 注册 start/stop；`NODE_ENV=test` 下 starter 直接返回，导出 `__runLeaderboardRefreshForTests`。不做「定点 00:05」对时——lease 窗口保证每日约一轮，cutoff 语义（LB-03）与运行时刻无关。

单轮 `refreshLeaderboards({ now = new Date() } = {})`：

1. `today = businessDateString(now)`，`cutoff = businessDayStartUtc(today)`；
2. 刷新集合 = `{ (total,'ALL'), (month, 本月), (week, 本周) }` ∪ `{ (month, 上月) | today 为 1 号 }` ∪ `{ (week, 上周) | today 为周一 }`；
3. 每个 (scope, periodKey)：raw SQL 聚合（`SUM(amount)::int`、`MAX(createdAt)`，`GROUP BY userId`，JOIN User 过滤资格）→ 按 LB-04 排序定 rank → 事务内 delete + createMany 原子替换。

### 4.4 API

新模块 `server/src/modules/leaderboard/{routes,controller,service,schema}.ts`，`app.ts` 挂载 `/api/leaderboard`，router 级 `authenticate, requireActiveUser`（与 points 模块同姿态）。

`GET /api/leaderboard?scope=total|month|week`（Zod 校验，缺省 `total`）：

```json
{
  "scope": "week",
  "periodKey": "W2026-07-27",
  "periodLabel": "07-27 ~ 08-02",
  "dataThrough": "2026-07-31",
  "updatedAt": "2026-07-31T16:05:03.000Z",
  "top": [ { "rank": 1, "displayName": "星河", "points": 1280, "isMe": false } ],
  "me": { "rank": 57, "points": 80 }
}
```

- `top` ≤ 100 条；`isMe` 由服务端计算（前端高亮用，不下发他人 userId）。
- `me`：请求者不合格（admin/封禁）或本期无得分 → `null`。
- `dataThrough` = 快照 cutoff 的前一日（定格周期为周期末日）；`periodLabel`：总榜 `"全部"`、月榜 `"2026年8月"`、周榜 `"MM-DD ~ MM-DD"`。
- 部署后首轮 cron 未完成的空窗：`top: []`，`updatedAt: null`，`dataThrough: null`，前端空态。
- 新周期首日（周一 / 1 号）：本期快照为空，但总榜每轮必刷——`updatedAt` / `dataThrough` 回退取总榜批次。因此 `updatedAt: null` 严格等价于「系统尚无任何快照」，前端据此区分「榜单生成中」与「新周期刚开始」两种空态文案。
- 错误：非法 scope → 400 `VALIDATION_ERROR`（validate 中间件），无新增错误码。

### 4.5 性能

读路径全部走快照索引（`(scope, periodKey, rank)` 取 Top 100；`(scope, periodKey, userId)` 点查 me）+ 按 userId 批量取 displayName，毫秒级；全局 `/api` limiter 已覆盖，不加专用缓存。

## 5. 前端设计

### 5.1 页面与入口

- 路由 `/leaderboard` 挂入 `App.tsx` 受保护嵌套路由（自动获得鉴权 + Layout）。
- 入口三处：`BottomTabBar.tsx` 买家 tabs 增「排行」（lucide `Trophy`）、`Layout.tsx` 桌面导航、`MobileNavDrawer.tsx` 抽屉。

### 5.2 布局（自上而下）

1. 标题 + 分段切换器「总榜 / 本月榜 / 本周榜」（样式对齐 `RangeFilter.tsx` 的圆角 pill）+ 副文案「数据截至 {dataThrough} · 每日更新」。
2. 颁奖台：2-1-3 布局，第一名居中且垫高；每人 = 特效字圆（displayName 首字符，1st ≈ 80px，2nd/3rd ≈ 64px）+ 名次徽标 + displayName + 积分。
3. 第 4 名起：行式列表（rank、40px 字圆、displayName、points），`.card` 容器；`isMe` 行高亮（主题色 tint）。
4. 「我的排名」吸底条：me 不在可视区时显示「我的排名 第 N 名 · X 分」；`me = null` 时显示「本期暂未上榜，去签到赚积分」；移动端避让 BottomTabBar 与 safe-area。
5. 状态：加载 = `Skeleton`（3 圆 + 8 行）；空榜 = `EmptyState`（新周期首日文案「新的一周/月刚开始，明天见分晓」；首刷空窗通用文案）。

### 5.3 Top 3 特效（纯 CSS，keyframes 进 `index.css`）

- 🥇 第 1 名：金色 `conic-gradient` **旋转流光环**（~6s 匀速）+ 金色柔和外发光 + `Crown` 角标 + 轻微上下浮动（~3s ease-in-out）。
- 🥈 第 2 名：银色渐变静态环 + 微光；🥉 第 3 名：铜色渐变静态环 + 微光。
- 约束：金银铜为固定色板，但底色/文字/表面色走主题 CSS 变量，light / dark / soft **三主题逐一核对**；遵守全局 `prefers-reduced-motion` kill switch——动画仅装饰，静止状态布局与样式必须完整；不新增任何 npm 依赖。

### 5.4 数据获取

`src/api/leaderboard.ts`（axios client 惯例，导出 typed 函数与响应类型）；页面 `useEffect` + mounted flag + scope 变更重拉 + 失败 toast（对齐 `src/pages/merchant/Dashboard.tsx` 模式）；scope 为组件内 `useState`。

### 5.5 data-testid

`leaderboard-tab-total|month|week`、`leaderboard-podium`、`leaderboard-podium-1|2|3`、`leaderboard-row`、`leaderboard-me`、`leaderboard-empty`。

## 6. 验收标准

1. 三榜切换正确；总榜积分与会员等级的 lifetime earned 完全一致（同一用户同一数字）。
2. refund / release / hold / out 不影响任何榜单积分。
3. 周一刷新后：上周榜定格且包含周日流水；本周榜为空态。每月 1 日对上月同理。
4. 封禁与 admin 用户不出现在任何榜；merchant 正常出现；me 对不合格请求者为 null。
5. 全部响应无他人 email / userId；昵称缺失显示打码邮箱。
6. 多实例并发下每日至多一轮快照；同参数重跑幂等。
7. 三主题 + `prefers-reduced-motion` + 375px 移动端均视觉可用、无横向溢出。
8. 服务端测试全绿；根 `npm run build` 通过；e2e leaderboard spec 通过（PR 打 `run-e2e` 标签）。
