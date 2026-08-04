# 实施计划：积分排行榜

| 字段 | 值 |
| --- | --- |
| 关联规格 | SPEC-LEADERBOARD-001 (`points-leaderboard.md`) |
| 日期 | 2026-08-01 |
| 状态 | Plan Ready — 阶段 A（后端）与阶段 B（前端）文件不相交，可并行；阶段 C 收口 |
| 修订 | — |
| 分析来源 | 双探索代理全库摸底（后端/前端各一）+ Claude 综合；口径与默认项已经用户裁定 |

## 1. 影响实现的关键代码事实（已核实）

| # | 事实 | 影响 |
| --- | --- | --- |
| F1 | `PointLog` 除主键零索引（48 个迁移目录核实；PG 不自动为 FK 建索引） | 必须新增 `@@index([type, createdAt])`，否则时间窗聚合全表扫 |
| F2 | 获得口径已定义：`computeLifetimeEarnedPoints`（memberTier.ts:64）= `SUM(amount) WHERE type='in'`；`accounting.ts:128` 注释明确 refund 不计 | 榜单聚合谓词与其保持字面一致（LB-01） |
| F3 | 写 `'in'` 的路径：签到 `points/service.ts:43`、成长奖励 `growthRewards.ts:554`、管理员调整 `admin/service.ts:176` | 测试造数用这些语义（type/amount/createdAt 直插 PointLog 即可） |
| F4 | `User`：无 avatar；`status` ∈ {'正常','已封禁'}；`role` ∈ {user,admin,merchant}；无软删 | 资格谓词 = `status != '已封禁' AND role != 'admin'` |
| F5 | displayName 惯例：`reviews/service.ts:18` `nickname?.trim() \|\| maskEmail(email)`；maskEmail 在 `lib/email.ts` | 直接复用，禁止另造脱敏 |
| F6 | cron 模板：`growthRewardCron.ts`（60s timer + 24h lease 窗口 + module `running` 布尔 + finally release + test 短路 + `__runXxxForTests`） | 逐条照抄结构 |
| F7 | `businessTime.ts` 只有日级 helper；`dashboard/service.ts:45-62` 用 host-local Date 算月边界（已知隐患） | 新增周/月/物理时刻 helper；禁止拷贝 dashboard 写法 |
| F8 | `calendarDayToUtc` 返回「日历日的 UTC-午夜存储值」，不是北京 0 点物理时刻 | 流水过滤只能用新的 `businessDayStartUtc`，混用即错 8 小时 |
| F9 | 成功响应裸 JSON；错误封套在 errorHandler；GET 聚合参考 `modules/dashboard/`（`::int` cast、bigint 归一、logDuration） | 模块四件套照 dashboard 形制 |
| F10 | Redis 默认关（`REDIS_ENABLED=false`）；`cache.ts` CacheName 封闭 union | 本次不触碰缓存层 |
| F11 | `__tests__/setup.ts:15-47` 硬编码清库表列表 | 新表 `LeaderboardEntry` 必须加入，否则测试间泄漏 |
| F12 | 前端无 react-query / 动画库 / i18n / 单测 runner；三主题（light/dark/soft）CSS 变量；全局 reduced-motion kill switch（index.css:219）；可复用 RangeFilter / TopProducts / Skeleton / EmptyState / Reveal | 阶段 B 全部用现有设施，零新依赖 |
| F13 | e2e 惯例：`data-testid` + `e2e/helpers.ts` loginAs；PR→develop 的 E2E 需 `run-e2e` 标签 | 阶段 C 提 PR 时打标签 |
| F14 | OpenAPI 契约 `docs/superpowers/specs/monexus-api-openapi.json`，先例把契约同步当显式任务 | A.7 |
| F15 | 今天是 8 月 1 日：`dashboard.service.test.ts` 存在**已知月初 flake**（memory 与 #66 已记录），与本特性无关 | 跑测试时忽略该文件失败；新写的月边界测试必须注入 now，不得踩同一坑 |

## 2. 已消解的决策点

| ID | 决策 | 依据 |
| --- | --- | --- |
| C1 | 口径 = 期间「获得」，非余额 | 激励活跃而非囤分；余额榜惩罚消费、月/周无法定义（存量/可负）、与会员等级叙事冲突；用户已确认 |
| C2 | 存储 = Postgres 全量快照表，非 Redis zset | Redis 默认关闭；每日刷新 = 静态读 |
| C3 | 周起点周一；week key = `W<周一日期>`，month key = `M<YYYY-MM>`，total = `ALL` | 周一日期作 key 规避 ISO week-year 跨年 |
| C4 | 并列 = points desc → `MAX(in.createdAt)` asc → userId asc | LB-04，先达到者靠前，确定性 |
| C5 | 资格 = 非 admin、非封禁；merchant 参与；快照时判定 | 用户选默认 |
| C6 | 读侧 Top 100；写侧全量快照支持精确 me | 用户选默认 |
| C7 | 新周期首日 = 空态文案，不展示上期定格 | 用户选默认 |
| C8 | 头像 = displayName 首字符字圆 + CSS 特效框（无真实头像） | 用户选 A |
| C9 | 他人零 userId 下发；行内 `isMe` 布尔由服务端计算 | LB-07 |
| C10 | 补刷 = 1 号补上月、周一补上周；更早周期已定格不再触碰 | LB-10；否则周期末日流水永远进不了定格版 |
| C11 | 鉴权 = `authenticate + requireActiveUser` | 与 points 模块同姿态 |
| C12 | 首刷空窗契约：`top:[]`、`updatedAt/dataThrough: null` | 部署后 cron 立即首 tick，空窗秒级 |
| C13 | 不做定点对时；lease 24h 窗口每日一轮即可 | cutoff 语义与运行时刻无关；照搬既有 daily 模式 |
| C14 | 快照替换 = 单事务 delete + createMany | MVCC 保证读侧原子切换（LB-08） |
| C15 | 测试时钟：service/batch 一律注入 `now`；期望值用 businessTime helpers 推导（bizDate 模式），不用 setSystemTime | CI 是 UTC、本机 +0800（F15） |

## 3. PBT 性质（不变量 → 证伪策略）

- [ ] P.1 **口径等价**：随机五类 type 混合流水下，总榜 points ≡ `computeLifetimeEarnedPoints`；任何不等即证伪
- [ ] P.2 **窗口封闭**：北京时区月/周边界 ±1 秒的 `in` 流水恰好落入正确周期；同一断言在 UTC 环境（CI）同样成立
- [ ] P.3 **排序全序 + 幂等**：随机并列样本下 rank 唯一、无洞、按 C4 稳定；重跑两次快照逐行一致
- [ ] P.4 **资格投影**：封禁 / admin 用户造数后刷新，不出现在任何榜；其 me 恒 null
- [ ] P.5 **定格**：模拟 8-31 与 9-1 两轮刷新（注入 now），上月快照含 31 日流水，且 9-1 之后再刷不改变上月 periodKey 的行
- [ ] P.6 **白名单投影**：响应序列化后 top 行键集恰为 {rank, displayName, points, isMe}；以 email/userId 作金丝雀扫描全响应
- [ ] P.7 **原子性**：刷新事务中途注入失败 → 回滚后旧快照完整保留
- [ ] P.8 **lease 互斥**：双实例并发 runBatch（`force: true`）恰一方执行（参照 P6 并发 barrier 惯例）

## 4. 任务清单

### 阶段 A：后端（只动 `server/**` 与 OpenAPI json；与 B 并行）

- [ ] A.1 prisma：`LeaderboardEntry` 模型 + `PointLog @@index([type, createdAt])`；migration `<ts>_points_leaderboard`；`npx prisma generate`；`setup.ts` 清库列表加 `LeaderboardEntry`
- [ ] A.2 `businessTime.ts`：`businessMonthStart` / `businessWeekStart` / `businessDayStartUtc` + 单测（跨年周、月边界、UTC 环境断言、与 `calendarDayToUtc` 的语义区分注释）
- [ ] A.3 `modules/leaderboard/service.ts`：`refreshLeaderboards({now})`（周期集合 → 聚合 SQL → 排序 → 事务替换）与 `getLeaderboard(scope, userId, {now})`（Top100 + me + displayName 批量 join + periodLabel/dataThrough 推导）
- [ ] A.4 `modules/leaderboard/{schema,controller,routes}.ts` + `app.ts` 挂载 `/api/leaderboard`
- [ ] A.5 `modules/leaderboard/cron.ts`（照 F6 模板，lease 名 `leaderboard-refresh`，24h）+ `main.ts` start/stop 注册
- [ ] A.6 测试 `__tests__/leaderboard.test.ts`（P.1–P.8 + 验收 1–6；供 API 断言的 supertest 用例含鉴权矩阵）
- [ ] A.7 OpenAPI json 增 `GET /api/leaderboard`（含响应 schema 与 400）
- [ ] A.8 `modules/leaderboard/README.md`（模块速览，形制同 auth/admin README）

### 阶段 B：前端（只动 `src/**`；不触 `server/**`、`e2e/**`；零新依赖）

- [ ] B.1 `src/api/leaderboard.ts`：类型 + `getLeaderboard(scope)`（严格对齐 §4.4 契约，含 null 空窗）
- [ ] B.2 `src/pages/LeaderboardPage.tsx` + 子组件（`Podium`、`RankRow`、`MyRankBar`，可同文件或 `src/pages/leaderboard/` 目录）+ `index.css` 金/银/铜 keyframes（§5.3 约束全部落实）
- [ ] B.3 `App.tsx` 路由 + 三入口（BottomTabBar 买家「排行」/ Layout 桌面 / MobileNavDrawer）
- [ ] B.4 Skeleton / EmptyState / 吸底条避让 BottomTabBar / 三主题核对 / reduced-motion / data-testid（§5.5 全集）
- [ ] B.5 根 `npm run build`（tsc + vite）零错误

### 阶段 C：收口（A+B 完成后）

- [ ] C.1 `e2e/leaderboard.spec.ts`：seed 快照数据 → 三 tab 切换、颁奖台、me 条断言
- [ ] C.2 服务端全量回归（注意 F15 的月初 flake 豁免）→ 提交 → PR → develop（打 `run-e2e` 标签）

## 5. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| R1 | PointLog 加索引在生产锁表 | 现库量级小（签到/奖励笔数），沿用普通 CREATE INDEX；量级超预期时改 CONCURRENTLY 手工迁移 |
| R2 | 快照表膨胀 | 行数 ≈ 活跃用户 × 周期数，年量级十万内；暂不清理，将来按 periodKey 归档 |
| R3 | 新周期首日空榜观感 | 空态文案引导签到；「上期定格」展示留作后续迭代（C7） |
| R4 | 改昵称与快照错位 | displayName 读时计算（C9 配套），已消解 |
| R5 | 双实例双跑 | lease 互斥 + 幂等双保险（LB-08/09） |
