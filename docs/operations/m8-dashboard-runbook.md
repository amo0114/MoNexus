# M8 Merchant Dashboard Runbook

> M8 经营数据看板（`/merchant/dashboard` + `/api/merchant/dashboard/*`）的运维 runbook：监控信号、慢查询排查 SQL、L1/L2 回滚操作。
> 范围：仅 M8 dashboard 相关运维操作。M5 deploy / nginx / systemd 回滚仍走 `docs/operations/rollback-runbook.md`（本 runbook 不替代它）。
> 配套契约文档：`docs/api/dashboard.md`。

## 2.1 监控

dashboard 的两个端点在 service 层每次调用末尾输出结构化日志（`server/src/modules/dashboard/service.ts` `logDuration`）：

```json
{ "op": "dashboard.summary",     "merchantId": 17, "duration_ms": 42 }
{ "op": "dashboard.timeseries",  "merchantId": 17, "duration_ms": 138 }
```

将这两条 op 名作为 Sentry transaction / APM 指标采集源：

| 信号源 | op 名 | 关键指标 |
| --- | --- | --- |
| Sentry transactions | `dashboard.summary` | `duration_ms` p95 / p99 |
| Sentry transactions | `dashboard.timeseries` | `duration_ms` p95 / p99 |

### 告警规则

| 规则名 | 触发条件 | 持续 | 路由标签 |
| --- | --- | --- | --- |
| `m8-dashboard-slow` | `dashboard.summary` 或 `dashboard.timeseries` 的 `duration_ms` p95 > 500ms | 持续 5 min | 复用 `api-latency-p2`（Sentry 既有通道；见 `docs/operations/sentry-alert-rules.md`） |

告警触发后进入 §2.2 慢查询排查；若 SQL 已优化但 p95 仍越线 → 视严重程度评估 L1 / L2 回滚。

## 2.2 慢查询排查

> ⚠ 以下 SQL 字段名 / 表名大小写与 `server/prisma/schema.prisma` 实际定义对齐（PostgreSQL 双引号保留大小写）。所有查询使用占位符 `:merchantId` / `:since` / `:until`，**不**含真实 ID。`:since` / `:until` 形如 `now() - interval '30 days'` / `date_trunc('day', now()) + interval '1 day'`。

### Step 1 — 对照 `summary`

```sql
-- step 1a: 本月订单数（对照 summary.monthOrderCount；含所有状态）
SELECT count(*) AS month_order_count
FROM "Order"
WHERE "merchantId" = :merchantId
  AND "createdAt" >= date_trunc('month', now())
  AND "createdAt" <  date_trunc('month', now()) + interval '1 month';

-- step 1b: 本月积分流水（对照 summary.monthPointsRevenue；排除 refunded）
SELECT COALESCE(SUM("price"), 0) AS month_points_revenue
FROM "Order"
WHERE "merchantId" = :merchantId
  AND "createdAt" >= date_trunc('month', now())
  AND "createdAt" <  date_trunc('month', now()) + interval '1 month'
  AND "status" <> 'refunded';

-- step 1c: 在售商品数（对照 summary.onSaleProductCount）
SELECT count(*) AS on_sale_product_count
FROM "Product"
WHERE "merchantId" = :merchantId
  AND "status" = 'active';

-- step 1d: 待结算积分（对照 summary.pendingSettlementPoints）
SELECT COALESCE(SUM("settlementAmount"), 0) AS pending_settlement_points
FROM "Settlement"
WHERE "merchantId" = :merchantId
  AND "status" = 'pending';
```

### Step 2 — 对照 `timeseries.points`（按日趋势）

```sql
-- step 2: 窗口内按日分组（对照 timeseries.points）；与 service.getSeriesPoints 一致
SELECT
  to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS d,
  count(*)::int                                AS order_count,
  COALESCE(SUM("price"), 0)::int               AS points_revenue
FROM "Order"
WHERE "merchantId" = :merchantId
  AND "createdAt" >= :since
  AND "createdAt" <  :until
  AND "status" <> 'refunded'
GROUP BY date_trunc('day', "createdAt")
ORDER BY date_trunc('day', "createdAt") ASC;
```

### Step 3 — 对照 `timeseries.top10`

```sql
-- step 3: TOP10 热销（对照 timeseries.top10）；与 service.getTopProducts 一致
-- 注：本表不存在 OrderItem / quantity；本项目订单粒度 = 1 product/order，soldCount = count(*)
SELECT
  o."productId"                                AS product_id,
  p."name"                                     AS name,
  count(*)::int                                AS sold_count,
  COALESCE(SUM(o."price"), 0)::int             AS points_revenue
FROM "Order" o
INNER JOIN "Product" p
  ON p."id" = o."productId"
 AND p."merchantId" = :merchantId
WHERE o."merchantId" = :merchantId
  AND o."createdAt" >= :since
  AND o."createdAt" <  :until
  AND o."status" <> 'refunded'
GROUP BY o."productId", p."name"
ORDER BY count(*) DESC, COALESCE(SUM(o."price"), 0) DESC, o."productId" ASC
LIMIT 10;
```

### Step 4 — 对照 `timeseries.statusBreakdown`

```sql
-- step 4: 状态分布（对照 timeseries.statusBreakdown）；与 service.getStatusBreakdown 一致
-- PAID_STATUSES     = ('paid', 'pending', 'processing')
-- FULFILLED_STATUSES = ('fulfilled', 'delivered', 'completed', 'closed')
SELECT
  count(*) FILTER (WHERE "status" IN ('paid', 'pending', 'processing'))                  AS paid,
  count(*) FILTER (WHERE "status" IN ('fulfilled', 'delivered', 'completed', 'closed'))  AS fulfilled,
  count(*) FILTER (WHERE "status" = 'refunded')                                          AS refunded
FROM "Order"
WHERE "merchantId" = :merchantId
  AND "createdAt" >= :since
  AND "createdAt" <  :until;
```

### 慢查询定位建议

- 用 `EXPLAIN (ANALYZE, BUFFERS)` 跑 step 2 / step 3 —— 这两个查询数据量最大。
- 关键索引：`Order("merchantId", "createdAt")`；如缺失需 DBA 评估补建。
- `step 3` 的 INNER JOIN 命中 `Product("merchantId")`；若 Product 表过大可考虑覆盖索引 `("id", "merchantId", "name")`。
- 若服务日志显示 `op=dashboard.timeseries` `duration_ms` 大幅高于 `dashboard.summary`：优先看 step 2 与 step 3。
- 时序方面，service 中 `getSeriesPoints` / `getTopProducts` / `getStatusBreakdown` 用 `Promise.all` 并发；总耗时取决于最慢一支。

## 2.3 L1 Rollback（热修，5 分钟）

> **触发条件**：dashboard 已上线，但需立即对 merchant 用户隐藏入口（如发现 UI bug / 数据偏差）；后端 API 仍可保留运行（不影响其他流）。

L1 利用 A3 的 commit 2 `feat(m8): expose dashboard in merchant sidebar` —— 该 commit 仅触碰 `src/pages/MerchantDashboardPage.tsx`（在该页内 `TABS` 数组中追加「经营数据」侧栏 tab 指向 `/merchant/dashboard`），revert 后侧栏入口立刻消失，其他模块零影响。

```bash
# 1. 进入仓库，确认 A3 commit 2（"feat(m8): expose dashboard in merchant sidebar"）的 sha
cd /path/to/MoNexus-new
git log --oneline <Base>..HEAD       # <Base> 为 integration/m8-rc 或 master（根据当前 checkout 位置）

# 2.a 仅当 HEAD 是 A3 commit 2（"feat(m8): expose dashboard in merchant sidebar"）时：
git revert HEAD

# 2.b 否则（在 integration 或 master 上、HEAD 已走过其他 commit）：
git revert <commit-2-sha>            # 用 step 1 找到的实际 sha

# 3. 通过常规 PR / merge 流程合入 master（不绕过 review、不 force-push）
```

效果：

- merchant 侧栏「经营数据」导航项消失。
- `/merchant/dashboard` 路由仍存在（直接访问 URL 仍可），API 仍接受请求。
- 若需更彻底（路由 + API 也下线）→ 走 §2.4 L2。

注意事项：

- **不要硬编码 commit sha** — 运维按当时仓库状态用 `git log` 取。
- **不要 `--amend` 任何 commit**（A3 提交规则禁止，且 amend 会破坏 commit 2 的锚点）。
- revert PR 也走标准 review → merge 流程，不走 force-push。

## 2.4 L2 Rollback（整体回滚，30 分钟）

> **触发条件**：M8 整体需下线（如发现严重数据泄漏 / 性能事故 / 边界绕过）。

L2 通过 revert `integration/m8-rc` 合入 `master` 的 merge commit 实现整体回退。

```bash
# 1. 找到 integration/m8-rc 合入 master 的 merge commit sha
cd /path/to/MoNexus-new
git log --oneline --merges master | head -20
# 找形如：abc1234 Merge pull request #XX from amo0114/integration/m8-rc

# 2. revert 整个 PR
git revert -m 1 <merge-commit-sha>

# 3. 通过常规 PR / merge 流程合入 master
```

效果：M8 全部内容一并回退，包括：

- `server/src/modules/dashboard/*`（A1 service + A2 controller/routes/schemas）。
- `src/pages/merchant/Dashboard.tsx` 与 `src/pages/merchant/dashboard/*`（A3 commit 1）。
- `src/api/merchant/dashboard.ts`（A3 commit 1）。
- `src/App.tsx` 中 `/merchant/dashboard` 路由项（A3 commit 1）。
- `src/pages/MerchantDashboardPage.tsx` 中追加的「经营数据」侧栏 tab 入口（A3 commit 2）。
- 本 runbook 与 `docs/api/dashboard.md`（A4）。

注意事项：

- `-m 1` 选 mainline parent；若搞错为 `-m 2` 会反向 revert（保留 dashboard 内容、丢弃 master 自身变化）—— **务必确认 `git log --merges` 中该 merge commit 第一 parent 是 master 主线**。
- L2 revert 不会自动跑数据库迁移 —— M8 不引入新表 / 新列（不写任何表），无需 schema rollback；若 M8.x 后续 patch 引入了 schema 变更，按 `docs/operations/rollback-runbook.md` §Prisma Migration Failure Fallback 单独处理。
- 仍走标准 PR review → merge 流程。

## 2.5 何时升级 L1 → L2

| 场景 | 路径 |
| --- | --- |
| 单纯 UI 问题（误导图表 / 文案错） | **L1 足够**，等修复后再 forward fix 重新暴露入口 |
| L1 已执行但 24h 内未修复 | 评估 L2 |
| 数据正确性事故（数字与 DB 实际状态不一致） | **直接 L2，不走 L1**（L1 不下线 API，错误数据仍可通过直访路由触达） |
| 安全 / 隐私事故（跨 merchant 数据泄漏、merchantId 注入未被忽略等） | **直接 L2，不走 L1**；同时按 `docs/operations/alert-routing.md` 走 P1 路由通知 |
| 性能事故（持续触发 `m8-dashboard-slow` 且影响其他流） | 评估 L2；若仅 dashboard p95 高、不影响其他端点 → 也可先 L1（隐藏入口 = 显著降低调用量）观察 |

## 2.6 后续 hotfix 预留

任何后续 M8 patch（M8.1 等）的运维步骤在本 runbook 末尾 append 新章节（§2.7、§2.8 …）即可，**不修改** §2.1–2.5 已发布内容。

API 契约的同类变更追加在 `docs/api/dashboard.md` §5 变更历史末尾，同样不动既有行。
