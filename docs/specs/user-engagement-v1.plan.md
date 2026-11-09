# 实施计划：用户留存 v1

| 字段 | 值 |
| --- | --- |
| 关联规格 | SPEC-ENGAGE-001 ([user-engagement-v1.md](user-engagement-v1.md)) |
| 日期 | 2026-11-09 |
| 状态 | Implemented — 单 PR，分支 `feat/user-engagement-v1`；与规格的实现差异以 spec 为准 |
| 基线 | origin/develop `74d6f56`；入口 chunk gzip 154.7 KiB（详见 spec §2） |

## 0. 交付方式

- 一个分支 `feat/user-engagement-v1`（从 `origin/develop` 74d6f56 切出）、一个 PR，按 commit 拆分：P0 活跃记录 → P1 连签 → P2 今日面板 → P3 Push → 文档/契约。
- PR 带 `run-e2e`（改了 auth 中间件、nginx、SW，并新增签到旅程），标签在 `gh pr create` 时带上。
- 新表加入 `server/src/__tests__/setup.ts` TRUNCATE 列表。OpenAPI 契约目前不覆盖 points / notifications 模块，本次沿用现状不补。
- 本地使用独立测试库 `monexus_test_engage` 与独立 worktree，不与并行的修复分支共用数据库、目录或端口。
- 测试按最小原则，只补关键回归。

## P0 活跃记录

**改动**

1. Schema：`UserActiveDay { userId Int, day String /* YYYY-MM-DD 上海 */, @@id([userId, day]) }`，FK 指向 User 并设 `onDelete: Cascade`。
2. `middlewares/auth.ts` 的 `authenticate` 在验签成功后调用 `recordActiveDay(userId)`：
   - 进程内 `Map<userId, day>` 做 memo，同一进程同一天只写一次；
   - `INSERT ... ON CONFLICT DO NOTHING`，fire-and-forget，失败只 `logger.warn`，**绝不阻塞请求**；
   - 日期用 `businessDateString()`。
3. 不新增接口，不改前端。

**验证**：一个后端集成测试，覆盖同一用户同日多次请求只产生一行、跨日产生新行；用现有 auth 测试回归。

## 指标 SQL

上线后由用户在生产只读执行（M3–M5 可直接取上线前 4 周做对比）：

```sql
-- M1 人均月活跃天数 / M2 非续费日活跃占比
WITH a AS (SELECT "userId", day FROM "UserActiveDay" WHERE day >= :from),
o AS (
  SELECT DISTINCT "userId",
         to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day
  FROM "Order" WHERE "createdAt" >= :fromTs
)
SELECT count(*)::float / count(DISTINCT a."userId") AS days_per_user,
       avg((o."userId" IS NULL)::int)               AS non_order_day_ratio
FROM a LEFT JOIN o USING ("userId", day);

-- M3 站内签到占比 / M4 周签到人数
SELECT date_trunc('week', date::date) AS wk,
       count(DISTINCT "userId")       AS users,
       avg((source = 'web')::int)     AS web_ratio
FROM "CheckinRecord" WHERE date >= :from GROUP BY 1 ORDER BY 1;

-- M5 续费率（上月下单用户中本月再下单；:prevFrom/:curFrom/:curTo 用 businessMonthRange 的 UTC 边界）
WITH prev AS (SELECT DISTINCT "userId" FROM "Order" WHERE "createdAt" >= :prevFrom AND "createdAt" < :curFrom),
cur  AS (SELECT DISTINCT "userId" FROM "Order" WHERE "createdAt" >= :curFrom  AND "createdAt" < :curTo)
SELECT count(cur."userId")::float / NULLIF(count(*), 0) AS renewal_rate
FROM prev LEFT JOIN cur USING ("userId");

-- L1 参考：积分余额分布
SELECT width_bucket(balance, 0, 2000, 10) AS bucket, count(*)
FROM "PointAccount" GROUP BY 1 ORDER BY 1;
```


## P1 连签体系 + 庆祝动效

### A. 后端

| # | 任务 | 要点 |
| --- | --- | --- |
| A1 | Migration：`CheckinRecord.streak Int NOT NULL DEFAULT 1`，回填存量 | 回填按用户 gaps-and-islands：`date::date - row_number() OVER (PARTITION BY "userId" ORDER BY date)` 分组，组内 `row_number` 即为 streak |
| A2 | Migration：`CheckinReward` 表 | 字段：`id, userId, kind, milestone, periodKey, amount, state('claimable'/'claimed'), expiresAt, claimedAt?, pointLogId? UNIQUE, createdAt`；`@@unique([userId, kind, periodKey, milestone])`；`@@index([userId, state, expiresAt])`；加入测试 TRUNCATE 列表 |
| A3 | SystemConfig 新键（spec §3.6） | `systemConfigKeys`、`RANGE_CONFIG_KEYS`、描述、分组、单位、`config/index.ts` 默认值，四处同步；管理端配置面板会自动展示 |
| A4 | `points/streak.ts`：`computeStreakForInsert`、`recomputeForward`（≤7 行）、`evaluateRewards(tx, userId, today)` | 纯逻辑与 tx 读写分开；里程碑常量 `[3, 7, 14, 30]`，30 天之后每满 30 天再发一次；金额为 0 的档位跳过；`createMany skipDuplicates` 去重 |
| A5 | 改 `checkin()` | 事务开头加 advisory lock（spec §3.4）→ 写入时带 `streak` → 原有入账流程 → `evaluateRewards`；响应追加 `streak` 和 `newRewards`。机器人经 `checkinForBot` 自动获得同样行为 |
| A6 | 新 `makeup(userId, date, expectedPrice)` | 依次校验：锁 → 窗口 → 月限 → 价格（`PRICE_CHANGED`）→ 扣费（复用 checked mutation 的 debit，`PointLog out`，reason `补签 YYYY-MM-DD`）→ 写记录（`source='makeup'`）→ `recomputeForward` → `evaluateRewards` |
| A7 | 新 `claimReward(userId, rewardId)` | 不存在或非本人返回 404；用条件更新抢占状态；入账 `PointLog in`，reason `连签 N 天奖励` / `M 月全勤奖励`，写回 `pointLogId`；已领取幂等返回；已过期返回 `REWARD_EXPIRED`（加入 `ErrorCode`） |
| A8 | 扩展 `getCheckinStatus(userId, month?)` | spec §3.5 的字段；`month` 只允许当月或上月，其他值返回 400 |
| A9 | 路由与 Zod schema | `POST /checkin/makeup`、`POST /checkin/rewards/:id/claim`；两者都要 `requireVerifiedEmail` |
| A10 | 机器人加法字段 | `/bot/checkin`、`/bot/profile` 增加 `streak`、`claimableCount`、`claimPath` |

**后端测试**（`server/src/__tests__/checkin-streak.test.ts`）

1. 连续、断签、跨月边界的 streak 正确，用 `businessTime` 构造日期，并在 UTC 下运行；
2. 补签合并两段连签：streak 前推重算正确，里程碑不重复发放；
3. 补签越窗、超月限、`PRICE_CHANGED`、不发每日奖励；
4. 月末签到或补签补齐当月后生成全勤奖励；
5. 领取：本人成功、他人 404、重复领取幂等、过期返回 `REWARD_EXPIRED`；
6. 并发：同一用户「今日签到」与「补签昨日」并发执行，最终 streak 一致（沿用 `pg_stat_activity` barrier 写法）；
7. 迁移回填：迁移测试中构造存量数据，校验 streak 回填值。

### B. 前端

| # | 任务 | 要点 |
| --- | --- | --- |
| B1 | `src/api/checkin.ts` 类型与调用 | 通过 `api/client.ts` 调用；`expectedPrice` 取自最近一次 status |
| B2 | `components/checkin/CheckinCard.tsx`（紧凑态 + 完整态） | 月历、阶梯条、待领取列表、补签入口（`ConfirmDialog`）；颜色只用现有 token，透明度用 `--color-primary-tint(-strong)`，**不要写 `bg-[var(--x)]/8`** |
| B3 | Profile 页接入，替换原签到按钮区域；加 `#checkin` 锚点 | 保留现有 `completionFeedback` 和 session context 校验写法（`ProfilePage.tsx:150-176`） |
| B4 | `lib/celebrate.ts`：`celebrate()` 内部 `await import('canvas-confetti')` | reduced-motion 时直接返回；import 失败静默跳过；只在 spec FX-01 列出的场景调用 |
| B5 | `PRICE_CHANGED` 处理 | 提示「补签价格已更新」并刷新 status，不自动重试 |

**前端测试**：`CheckinCard` 的主要渲染态（未签 / 已签 / 待续 / 有待领取 / 补签关闭）；`celebrate` 在 reduced-motion 下不 import。

**E2E**（1 条，`e2e/checkin-streak.spec.ts`）：签到 → 达成 3 天里程碑（seed 前 2 天记录，并把 3 天档金额配为非 0）→ 领取 → 余额变化。

**验收**：入口 chunk gzip 增量 ≤ 5 KiB，`canvas-confetti` 落在独立 chunk（构建后执行 `gzip -c dist/assets/index-*.js | wc -c` 对比 158 403 B）。

## P2 今日面板

| # | 任务 | 要点 |
| --- | --- | --- |
| C1 | `components/home/TodayPanel.tsx` | 组合 `CheckinCard` 紧凑态、余额（`useAuthStore` 中的 `user.points`）、一条公告；各块独立加载，失败只隐藏该块 |
| C2 | `StorePage` 中：已登录渲染 `TodayPanel`，未登录渲染原 Hero | 只替换 Hero 这一段，搜索、分类、虚拟列表不动；注意 `storePageCache` 和滚动恢复不受影响 |
| C3 | 移动端高度约束（HM-04） | Playwright mobile 截图人工确认即可，不新增 E2E |

**测试**：`StorePage` 已有测试补一条「登录显示今日面板 / 游客显示 Hero」。

## P3 PWA + Web Push

| # | 任务 | 要点 |
| --- | --- | --- |
| D1 | 依赖：server 安装 `web-push` | 等 D6 确认；Node 22 + npm 10 下安装，同步 lockfile |
| D2 | env 与 config | spec PW-09；`WEB_PUSH_ENABLED=true` 时缺少密钥则启动失败（Zod refine）；`.env.example` 只写占位符；在 `scripts/check-prod-env.sh` 加检查 |
| D3 | Schema：`PushSubscription`、`PushDispatchState(id=1, lastNotificationId, lastAnnouncementId)`；`Announcement.pushEnabled Boolean @default(false)` | 加入测试 TRUNCATE 列表 |
| D4 | 订阅接口（spec PW-04） | endpoint 只接受 https，长度做上限；同一 endpoint 被其他用户订阅时改绑到当前用户（换账号登录同一浏览器的场景） |
| D5 | `notifications/pushWorker.ts`（`cronLease`，每分钟一次） | 按游标拉取白名单 eventType 的新 Notification，以及 `pushEnabled` 的新公告；逐条 `sendNotification`，有并发上限；404/410 删除订阅；游标在批次完成后推进 |
| D6 | `checkin.streak_at_risk` cron（20:00 上海时间） | 只发给有订阅的用户；通过 dispatcher 写 Notification（站内同时可见），由 worker 推送 |
| D7 | `checkin.reward_claimable` | 在 `evaluateRewards` 生成奖励的同一事务中经 dispatcher 写入 |
| D8 | `public/sw.js` | `push` 时 `showNotification(title, { body, data: { deeplink }, icon })`；`notificationclick` 时聚焦已有窗口或打开 deeplink，只允许同源路径 |
| D9 | 前端开关 `components/PushToggle.tsx`（通知页 + Profile） | 检测是否支持；iOS 未安装到主屏幕时显示指引；授权被拒时说明如何在浏览器设置里恢复；退出登录时取消订阅并调用 DELETE |
| D10 | nginx 与 manifest | `/sw.js` 设置 `no-cache`；manifest 补 maskable 图标和 `start_url`；`npm run check:nginx` |
| D11 | 管理端公告表单增加「推送」勾选 | 仅当 `WEB_PUSH_ENABLED` 时显示 |

**测试**：订阅 CRUD 与越权 404；worker 用 mock 的 `web-push` 覆盖游标推进与 410 删除；streak_at_risk 筛选条件。E2E：只做「开启推送按钮在不支持的环境中隐藏」的冒烟，真实推送用人工在真机上验收（Chrome Android + iOS 主屏幕各一次）。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 多账号刷连签奖励 | 签到与领取都要求邮箱已验证；注册为邀请制；奖励默认 0，由运营逐步开启 |
| 奖励抬高等级与排行榜 | D4 确认口径；上线前按 §3.6 估算单用户月上限 |
| `authenticate` 热路径写库 | 进程内 memo + fire-and-forget；P0 PR 带 run-e2e，并观察 p95 延迟 |
| 推送打扰导致用户取消订阅或拉黑 | 只推白名单事件；连签提醒每天最多一条；广播必须管理员勾选 |
| SW 导致页面卡在旧版本 | SW 不缓存、不拦截 fetch（PW-01） |
| CI 在 UTC 运行，本机是 +0800 | 日期相关测试一律用 `businessTime` 构造日期，并在 `TZ=UTC` 下复跑 |
