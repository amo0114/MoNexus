# Spec：用户留存 v1（连签体系 · 今日面板 · 主动触达）

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-ENGAGE-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-11-09 |
| 状态 | Implemented（分支 `feat/user-engagement-v1`）— 2026-11-09 用户确认：单 PR 交付；P4（QQ 回流）暂缓；满勤月上限 200–250 |
| 实施计划 | [user-engagement-v1.plan.md](user-engagement-v1.plan.md) |

## 1. 背景与目标

现状：用户基本只在每月续订套餐时打开网站。站内签到已有，但 QQ 机器人可完成签到且无累计激励；积分只用于兑换套餐；首页对游客与登录用户完全相同；除邮件外没有召回渠道。

目标：给用户「非续费日也打开网站」的理由，并以可度量的方式验证效果。

本 spec 范围（用户 2026-11-09 选定）：

1. 连签体系：连签日历、连签阶梯奖励、补签卡、月度全勤奖励；形成「QQ 签到、网站看进度领大奖」的分工。
2. 签到/领奖庆祝动效。
3. 主动触达：PWA 可安装 + Web Push。（QQ 机器人推送活动/上新已暂缓，见 §9 L6。）
4. 登录后首页「今日」面板。
5. 前端工具选型（锦上添花，按需引入）。

不在范围（见 §9 待办）：积分新去处 / 小额商品 / 抽奖、上新与运营节奏、月榜奖励、数据看板。Xboard 不与本项目耦合，本 spec 不涉及任何 Xboard 数据。

## 2. 基线（实施前事实，2026-11-09 核实）

### 2.1 代码基线

| 项 | 值 |
| --- | --- |
| origin/develop | `74d6f56`（Merge PR #331） |
| 本文起草分支 | `docs/system-review-standard-20261108`（`3873e8b`）；实施分支必须从最新 `origin/develop` 切出 |
| Node / npm | 22.x / 10.x（`scripts/check-runtime.mjs` 强制） |

### 2.2 行为基线

| # | 事实 | 位置 |
| --- | --- | --- |
| B1 | 签到 `POST /api/points/checkin`：`authenticate + requireActiveUser + requireVerifiedEmail`；`CheckinRecord @@unique([userId, date])` 是唯一幂等依据；`date` 为上海日 `YYYY-MM-DD` 字符串 | `server/src/modules/points/routes.ts`、`service.ts:18` |
| B2 | 奖励 = SystemConfig `checkinReward`（代码默认 50，生产已调为 5）× 会员等级加成；写 `PointLog type='in'` | `points/service.ts:32-56` |
| B3 | `type='in' AND amount>0` 同时决定会员等级累计（`computeLifetimeEarnedPoints`）与排行榜（LB-01）；新增任何 `in` 奖励都会抬高等级和榜单 | `lib/memberTier.ts:82` |
| B4 | 机器人与站内共用同一 `checkin()`，`source` 仅统计（web / qq）；机器人只拉不推：`/api/bot/checkin`、`/profile`、`/unchecked`（限流，只返回 platformId） | `modules/chatbot/routes.ts` |
| B5 | 无连签、补签、全勤、待领取奖励概念；前端签到只有 Profile 页一个按钮 | `src/pages/ProfilePage.tsx:333` |
| B6 | 站内通知：`Notification` 表 + SSE 实时（`notificationRealtime` flag）；邮件仅用于订阅到期等 | `modules/notifications/` |
| B7 | 已有 `public/site.webmanifest`（standalone），无 Service Worker；CSP 已含 `worker-src 'self' blob:` | `nginx.conf:32` |
| B8 | `/` 对游客与登录用户都是 `StorePage`（FluidOrb + 「发现实用好物。」+ 搜索 + 商品流） | `src/App.tsx:110`、`StorePage.tsx:752` |
| B9 | SystemConfig 是整数 KV，每个键必须有显式区间（`RANGE_CONFIG_KEYS`），奖励上限 `MAX_REWARD_POINTS = 1_000_000` | `lib/systemConfig.ts` |
| B10 | 并发惯例：同主体串行用 `pg_advisory_xact_lock`；cron 必须走 `cronLease` | `orders/fileAccess.ts:70` 等 |

### 2.3 前端基线

| 项 | 值 |
| --- | --- |
| 已有动效设施 | Island 通知队列、`ScratchReveal`、`AnimatedCounter`、`FluidOrb`、`HeartBurst`、`Reveal`；66 处 CSS keyframes；全局 reduced-motion 开关 |
| 动画库 / 组件库 | 无动画库；Radix（dialog / tabs）+ 自有 `components/ui/*` |
| 入口 chunk | `index-*.js` gzip **154.7 KiB**（158 403 B） |
| 全量产物 | gzip 1165 KiB / 90 文件；`check:bundle-budget`（上限 150 KiB，统计全量）**已超标且未接入 CI**，不能作为本次防线 |
| 本次防线 | 入口 chunk gzip 增量 ≤ **5 KiB**；新依赖一律动态 import，落在非入口 chunk |

### 2.4 指标基线（上线 P1 前采集 ≥14 天）

现有数据只能近似「活跃」：`CheckinRecord`（按 source）、`Order`、`TrafficDailyVisitor`（按浏览器匿名 visitorId，不含 userId）。缺少「登录用户 × 访问日」，因此本 PR 一并新增 `UserActiveDay`。用户决定不等 14 天基线、与功能同批上线：M3–M5 用存量数据做上线前后对比；M1/M2 没有上线前基线，以上线后周趋势为准。

| 指标 | 口径 | 来源 |
| --- | --- | --- |
| M1 人均月活跃天数 | 上海自然月内 `UserActiveDay` 行数 / 当月活跃用户数 | P0 新表 |
| M2 非续费日活跃占比 | 活跃日中当天无下单的占比 | `UserActiveDay` ⋈ `Order` |
| M3 站内签到占比 | `CheckinRecord.source='web'` / 全部签到 | 现有 |
| M4 周签到人数 | 每周 distinct userId | 现有 |
| M5 续费率 | 上月下单用户中本月再下单的占比 | 现有 `Order` |
| M6（上线后）领取率、补签次数、Push 订阅数、Push 点击率 | 新表 / deeplink 参数 | P1–P3 |

基线 SQL 见 plan §指标 SQL。成功判据（上线 4 周后）：M3 较上线前 4 周 ↑、M5 不下降；M1/M2 周趋势 ↑。

## 3. 连签体系

### 3.1 规则

| ID | 规则 |
| --- | --- |
| CK-01 | 连签按上海自然日计算，**站内与 QQ 签到都计入**（沿用 B4 单一 claim）。 |
| CK-02 | `CheckinRecord` 新增 `streak Int`：该日结束时的连续天数，写入时 = 前一日记录的 `streak + 1`，前一日无记录则为 1。存量数据由迁移用 gaps-and-islands 窗口函数回填。 |
| CK-03 | 当前连签：今日已签取今日 `streak`；今日未签且昨日已签取昨日 `streak`（状态「待续」）；否则为 0。 |
| CK-04 | 阶梯里程碑固定为 3 / 7 / 14 / 30 天（代码常量），金额由 SystemConfig 配置；连签超过 30 天后每满 30 天（60、90…）再发一次 30 天档奖励。 |
| CK-05 | 月度全勤：某上海自然月内每一天都有 `CheckinRecord`（含补签）即达成，发一次全勤奖励。 |
| CK-06 | 里程碑与全勤奖励**不直接入账**，生成「待领取」记录，只能在网站领取（QQ 侧只提示并给出链接）。这就是「QQ 签到、网站领大奖」的分工。 |
| CK-07 | 待领取有效期 = SystemConfig `checkinRewardClaimDays`（默认 30 天）；过期为惰性判定（读侧以 `expiresAt` 为准），不建 cron。 |
| CK-08 | 奖励金额在生成时快照到记录上；领取时按快照入账。后台改配置不影响已生成的奖励，不悄悄改变条件。 |
| CK-09 | 里程碑和全勤奖励按基础额发放，**不叠加会员等级加成**（等级加成只作用于每日签到，见 B2）。 |
| CK-10 | 奖励入账写 `PointLog type='in'`，计入会员等级与排行榜（与 LB-01 口径一致）。是否改为不计入见决策 D4。 |
| CK-11 | 金额为 0 的档位不生成奖励，前端阶梯条隐藏该档；全部为 0 时体验等同只有连签日历。默认值见 §3.6。 |

### 3.2 补签

| ID | 规则 |
| --- | --- |
| MK-01 | 仅能补签今天之前 `checkinMakeupWindowDays`（固定 7 天，代码常量）内未签的日期，不能补未来或今天。 |
| MK-02 | 每次补签消耗 `checkinMakeupPrice` 积分（写 `PointLog type='out'`），这同时也是一个积分去处。请求必须携带 `expectedPrice`，与当前价格不一致返回 `PRICE_CHANGED`，不得按变化后的价格扣费。 |
| MK-03 | 每个上海自然月最多补签 `checkinMakeupMonthlyLimit` 次（按补签发生的月份计，`source='makeup'` 且 `createdAt ∈ businessMonthRange`）；0 = 关闭补签。 |
| MK-04 | 补签**不发每日签到奖励**，只恢复连签和全勤资格，避免用积分套签到奖励。 |
| MK-05 | 补签写 `CheckinRecord(source='makeup')`，随后按顺序重算该日之后、直到下一个缺口的记录的 `streak`（受 MK-01 约束，至多 7 行），再评估 CK-04 / CK-05。 |
| MK-06 | UI 文案沿用「补签卡」，但不建卡片库存：一次补签 = 一张卡，按价格即时扣费。用户也不必理解库存概念。 |

### 3.3 奖励去重键

`CheckinReward @@unique([userId, kind, periodKey, milestone])`：

- `kind='streak'`：`periodKey` = 该段连签的起始日（今日日期 − streak + 1），`milestone` = 3/7/14/30/60/…
- `kind='monthly'`：`periodKey` = `YYYY-MM`，`milestone` = 当月天数。

补签合并两段连签时起始日前移：已在前一段拿过的档位按新起始日去重不会重复发；后一段已拿过的档位保留（两次都是真实达成的）。

### 3.4 并发

签到、补签、领取三个写事务开头统一执行 `pg_advisory_xact_lock(hashtextextended('checkin:' || userId, 0))`，按用户串行。签到仍保留唯一约束兜底（B1）。领取对 `CheckinReward` 使用条件更新 `WHERE state='claimable' AND expiresAt > now()`，影响行数为 0 时按当前状态返回。

### 3.5 API（全部在 `/api/points` 下，沿用 `authenticate + requireActiveUser`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/checkin/status` | **向后兼容扩展**：保留 `hasCheckedIn`，新增 `streak`、`streakState`（`done` / `pending` / `broken`）、`month: { key, daysInMonth, checkedDates[] }`、`milestones: [{ days, reward, reached }]`、`nextMilestone`、`monthlyReward`、`claimable: [{ id, kind, milestone, amount, expiresAt }]`、`makeup: { price, monthlyLimit, usedThisMonth, windowDays, eligibleDates[] }`。只返回当月月历。前端遇到旧版后端只返回 `hasCheckedIn` 时隐藏连签 UI、保留签到按钮（滚动发布兼容）。 |
| POST | `/checkin` | 响应新增 `streak`、`newRewards[]`，原字段不变。 |
| POST | `/checkin/makeup` | `requireVerifiedEmail`；body `{ date, expectedPrice }`；返回 `{ date, streak, balanceAfter, newRewards[] }`。错误：已签 400，越窗 400，次数用尽 400，余额不足沿用现有错误，价格变化 `PRICE_CHANGED`。 |
| POST | `/checkin/rewards/:id/claim` | `requireVerifiedEmail`；非本人或不存在返回 **404**；已领取返回 200 和原结果（幂等）；已过期返回 400 `REWARD_EXPIRED`（新增 ErrorCode）。 |

机器人签到与站内共用 `checkin()`，连签与待领取奖励自动生效；机器人接口本期不改（随 L6 一并处理）。

### 3.6 新增 SystemConfig 键

| 键 | 区间 | 默认 | 说明 |
| --- | --- | --- | --- |
| `checkinStreakReward3` / `7` / `14` / `30` | 0..`MAX_REWARD_POINTS` | 5 / 10 / 15 / 25 | 阶梯奖励 |
| `checkinMonthlyReward` | 0..`MAX_REWARD_POINTS` | 20 | 全勤奖励 |
| `checkinMakeupPrice` | 1..`MAX_REWARD_POINTS` | 20 | 单次补签价格 |
| `checkinMakeupMonthlyLimit` | 0..31 | 2 | 0 = 关闭补签 |
| `checkinRewardClaimDays` | 1..90 | 30 | 待领取有效期 |

预算（用户 2026-11-09 确认可接受 200–250 / 月）：以生产 `checkinReward = 5` 计，满勤 30 天 = 30×5 + 5 + 10 + 15 + 25 + 20 = **225**（不含会员等级对每日签到的加成）。断签会重新开始一段连签，可能再拿 3 天档，但断签损失的每日奖励更多，月总额只会更低。补签不发每日奖励，不会抬高上限。代码默认值即为上述值，上线后可在后台调整；若生产 `checkinReward` 改动，需同步复核总额。

### 3.7 前端

- 新组件 `CheckinCard`（`src/components/checkin/`）：月历网格（7 列，已签、补签、今日、可补签四种态）、阶梯进度条（里程碑节点 + 下一档提示）、待领取列表、补签确认（复用 `ConfirmDialog`，展示价格与剩余次数）。
- Profile 页保留顶部签到按钮，其下新增完整态 `CheckinCard`（不重复签到按钮）；锚点 `#checkin` 供推送与后续机器人链接使用。
- 文案明确「QQ 签到也算连签；大奖需在网站领取」。

## 4. 庆祝动效

| ID | 规则 |
| --- | --- |
| FX-01 | 签到成功、领取成功、达成全勤时触发；补签成功只走普通完成反馈（花钱的操作不做庆祝）。 |
| FX-02 | 使用 `canvas-confetti`，**仅在触发时动态 import**，不进入入口 chunk。 |
| FX-03 | `prefers-reduced-motion: reduce` 下不触发（库参数 `disableForReducedMotion: true`，并与全局 reduced-motion 开关一致）；数字变化继续用现有 `AnimatedCounter`。 |
| FX-04 | 动效与 `completionFeedback` 的 Island / Toast 并行，不替换现有反馈；动态 import 失败时静默跳过动效，反馈文案照常显示（动效不承载信息）。 |

## 5. 今日面板（登录用户首页）

| ID | 规则 |
| --- | --- |
| HM-01 | 仅登录用户：`StorePage` 顶部用 `TodayPanel` 替换 Hero（FluidOrb + 标语）；游客保持 B8 原样。搜索与商品流不变。 |
| HM-02 | 内容：①签到卡（连签数、今日按钮、待领取列表，`CheckinCompact`）②积分余额与「流水」入口。公告已由 Layout 的 `AnnouncementBanner` 全站展示，不在面板重复。管理员不显示面板。 |
| HM-03 | 不新增聚合接口：面板只调用 `/points/checkin/status`，失败时只隐藏签到块。 |
| HM-04 | 移动端高度不超过首屏的 40%，商品流须在首屏可见。 |
| HM-05 | 「可兑换推荐（积分够换）」依赖商品流按价格过滤，留到积分去处一期（§9 L1）。 |

## 6. 主动触达

### 6.1 PWA + Web Push

| ID | 规则 |
| --- | --- |
| PW-01 | 手写最小 `public/sw.js`，只处理 `push` 与 `notificationclick`，**不做离线缓存、不拦截 fetch**。理由：现有 `chunkRecovery` 与 nginx 缓存策略已处理版本切换，引入 precache 会多出一层「旧版本卡住」的风险。 |
| PW-02 | nginx 对 `/sw.js` 设置 `Cache-Control: no-cache`；manifest 补 `start_url` / `scope`。maskable 图标需设计资产，未做。 |
| PW-03 | 订阅只能由用户主动点击触发（通知页 / Profile 的「开启推送」），不在页面加载时弹权限请求。iOS 仅在「添加到主屏幕」后支持，未安装时展示安装指引。 |
| PW-04 | 新表 `PushSubscription(userId, endpoint UNIQUE, p256dh, auth, userAgent, createdAt, lastSuccessAt)`；独立模块 `modules/push`：`GET /api/push/public-key`、`POST /api/push/subscriptions`（同 endpoint 改绑到当前用户）、`DELETE /api/push/subscriptions`（按 endpoint，只能删自己的，否则 404）。主动退出登录时前端先解绑本设备订阅。 |
| PW-05 | Push 只是提示通道，事实来源是业务表（`CheckinReward` / `CheckinRecord` / `Announcement`），因此签到类推送不另写 `Notification` 行。Payload 只含 title / body / deeplink / tag，不含订单内容或敏感字段。 |
| PW-06 | 奖励待领取在签到 / 补签事务提交后 fire-and-forget 发送；连签提醒与公告广播由 `modules/push/cron.ts`（`cronLease`）发送。均不在业务事务内外呼。推送服务返回 404/410 时删除该订阅，其他失败只记日志、不重试（尽力而为）。 |
| PW-07 | 首批事件：连签快断（每天 20:00 上海时间之后一次，24h 租约去重；昨日连签 ≥3、今日未签、有订阅的正常用户）、奖励待领取（生成待领取时）。 |
| PW-08 | 广播类：公告新增 `pushEnabled` 勾选；公告生效（published 且在时间窗内）后，cron 先条件更新 `pushedAt` 占位再按受众角色广播，每条公告最多推送一次。 |
| PW-09 | env：`WEB_PUSH_ENABLED`（默认 false）、`WEB_PUSH_VAPID_PUBLIC_KEY`、`WEB_PUSH_VAPID_PRIVATE_KEY`、`WEB_PUSH_SUBJECT`；写入 `config/index.ts` 与 `.env.example`（只放占位符）。关闭时接口返回 `enabled:false`，前端隐藏入口。 |

## 7. 前端工具选型

| 工具 | 结论 | 理由 |
| --- | --- | --- |
| `canvas-confetti` | **引入**（P1） | 体积小、可动态 import、支持 reduced-motion；无现成替代 |
| `vite-plugin-pwa` | **不引入** | 需求只是 push 与可安装；它的 precache/workbox 与现有 chunk 恢复和缓存策略重叠，手写约 40 行的 SW 足够 |
| Motion（framer-motion） | 暂不引入 | 现有 CSS 动效与 `Reveal` 已覆盖；仅当出现共享元素过渡或列表重排动画需求时再评估，引入时必须走路由级懒加载 |
| shadcn/ui | 不整体迁移 | 已有基于 Radix 的 `components/ui/*`，整体替换属于换技术方案；需要新的原语（如 Popover）时可单个拷入 shadcn 实现并适配现有 token |
| vaul | 不引入 | 已有 `PointsHistorySheet` / `MobileNavDrawer` 抽屉模式 |
| `web-push`（server） | **引入**（P3，需确认 D6） | VAPID 签名与加密的标准实现，自己实现不划算 |

## 8. 决策（2026-11-09 已确认）

| ID | 决策 |
| --- | --- |
| D1 | QQ 签到计入连签 |
| D2 | 里程碑与全勤奖励必须在网站领取，有效期 30 天 |
| D3 | 补签按 §3.2：付积分、7 天窗口、每月上限、不发每日奖励 |
| D4 | 连签与全勤奖励计入会员等级与排行榜（口径统一） |
| D5 | 金额按 §3.6，满勤月约 225 |
| D6 | 服务端引入 `web-push` |
| D7 | 在 `authenticate` 中间件记录 `UserActiveDay`（PR 带 `run-e2e`） |
| D8 | 单 PR 交付；QQ 回流暂缓 |

## 9. 暂记待办（本期不做，后续评估）

| ID | 事项 | 触发条件 / 备注 |
| --- | --- | --- |
| L1 | 积分新去处：小额商品（兑换码 / 虚拟权益 / 限量款）、积分抽奖（复用 `ScratchReveal`）、首页「积分够换」推荐 | 先看 §2.4 基线中积分余额分布：若大量用户长期存着积分没地方花，L1 优先级最高 |
| L2 | 上新与运营节奏：限时上新、每周特价、整点抢兑 | 依赖商家供给，可复用公告、精选、推广位 |
| L3 | 排行榜月度奖励（按月重置并奖励前几名） | 与 D4 联动：连签奖励计入榜单后，需要先评估刷榜风险 |
| L4 | 数据看板：把 §2.4 指标做成后台面板 | 指标需要长期观察时再做；P0 先用 SQL |
| L5 | Motion / shadcn 单组件引入 | 见 §7 触发条件 |
| L6 | QQ 机器人回流：`/bot/checkin`、`/bot/profile` 返回连签与待领取提示；`/bot/broadcasts` 拉取活动/上新；`/bot/unchecked` 带 streak | 用户 2026-11-09 暂缓 |
