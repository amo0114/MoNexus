# Merchant Dashboard API

> M8 first release. Two read-only endpoints under `/api/merchant/dashboard/*` for the
> merchant 经营数据 page (summary cards + 7/30/90-day timeseries).
> Source of truth: `server/src/modules/dashboard/{routes,controller,schemas,service}.ts`.

## 1. 概述

| 项 | 值 |
| --- | --- |
| Base path | `/api/merchant/dashboard` |
| Auth | Bearer JWT，复用既有 `authenticate` 中间件（`Authorization: Bearer <token>`） |
| 角色 | 必须为商家用户：`requireActiveUser` + `requireMerchant`（非商家或被封禁直接拒绝） |
| merchantId | 仅从 token 关联的 `Merchant` 行解析；**`query` / `body` / `params` 中的任何 `merchantId` 字段均被静默忽略**（不返回 400，不暴露存在性） |
| Rate limit | 复用项目既有 `express-rate-limit` 全局策略（与 `/api/merchant/*` 其他路由一致） |
| 写入 | **无**。两个端点都是 read-only，不写任何表 |
| Content-Type | 响应统一 `application/json; charset=utf-8` |

错误响应共用项目通用 schema（见 `server/src/middlewares/errorHandler.ts`）：

```json
{
  "requestId": "req_xxxxxxxx",
  "error": {
    "code": "<ErrorCode>",
    "message": "<中文消息>"
  }
}
```

`ErrorCode` 取值见 `server/src/lib/httpError.ts`：`UNAUTHENTICATED` / `FORBIDDEN` / `NOT_FOUND` / `BAD_REQUEST` / `VALIDATION_ERROR` / `INTERNAL_SERVER_ERROR`。

## 2. `GET /api/merchant/dashboard/summary`

返回当前商家的本月经营摘要（4 张卡片数据）。

### 请求

| 参数 | 位置 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- | --- |
| `Authorization` | header | 是 | `Bearer <jwt>` | 商家用户的 access token |

无 query / body / path 参数。

### 响应（200 OK）

```json
{
  "monthOrderCount": 128,
  "monthPointsRevenue": 25600,
  "onSaleProductCount": 12,
  "pendingSettlementPoints": 4200
}
```

字段定义（与 `server/src/modules/dashboard/schemas.ts` `DashboardSummarySchema` 对齐）：

| 字段 | 类型 | 约束 | 含义 |
| --- | --- | --- | --- |
| `monthOrderCount` | integer | ≥ 0 | 自然月起至今的订单总数（含所有状态） |
| `monthPointsRevenue` | integer | ≥ 0 | 自然月起至今的积分流水合计（按 `Order.price` 累加；`status='refunded'` 已排除） |
| `onSaleProductCount` | integer | ≥ 0 | 当前商家在售商品数（`Product.status='active'`） |
| `pendingSettlementPoints` | integer | ≥ 0 | 当前商家待结算积分合计（`Settlement.status='pending'` 的 `settlementAmount` 累加） |

所有值均为 **非负整数**（满足 SHARED-RULES §3 "Points: All amounts are non-negative integers"）。

### 错误码

| Status | `error.code` | 触发条件 |
| --- | --- | --- |
| `401` | `UNAUTHENTICATED` | 缺失 / 失效 / 错误的 Bearer token |
| `403` | `FORBIDDEN` | token 有效但用户被封禁，或非商家 role |
| `404` | `NOT_FOUND` | 用户是商家 role 但 `Merchant` 表中无对应行（owner-boundary：商家账户不存在；message: `商家账户不存在`） |
| `500` | `INTERNAL_SERVER_ERROR` | 服务异常（DB 不可用 / 未捕获异常） |

> 404 仅由 `attachMerchantId` 中间件触发；当前 controller 路径不基于 path-param，故"跨 merchant 注入"不会到达此 404 —— 任何 query/body/params 中的伪造 `merchantId` 都被无视而非校验。

### `curl` 示例

**成功（200）**

```bash
curl -fsS "http://localhost:3000/api/merchant/dashboard/summary" \
  -H "Authorization: Bearer $MERCHANT_TOKEN"
# {
#   "monthOrderCount": 128,
#   "monthPointsRevenue": 25600,
#   "onSaleProductCount": 12,
#   "pendingSettlementPoints": 4200
# }
```

**未鉴权（401）**

```bash
curl -sS -o - -w '\n%{http_code}\n' "http://localhost:3000/api/merchant/dashboard/summary"
# {
#   "requestId": "req_3f1a...",
#   "error": { "code": "UNAUTHENTICATED", "message": "未登录" }
# }
# 401
```

## 3. `GET /api/merchant/dashboard/timeseries`

返回当前商家在所选窗口（7d / 30d / 90d）内的日趋势、热销 TOP10、状态分布。

### 请求

| 参数 | 位置 | 必填 | 类型 | 取值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `Authorization` | header | 是 | `Bearer <jwt>` | — | 商家用户的 access token |
| `range` | query | 是 | string | `7d` / `30d` / `90d` | 时间窗（自然日）；其他值返回 400 |

### 响应（200 OK）

```json
{
  "range": "30d",
  "points": [
    { "date": "2026-04-23", "orderCount": 4, "pointsRevenue": 800 },
    { "date": "2026-04-24", "orderCount": 6, "pointsRevenue": 1200 }
  ],
  "top10": [
    { "productId": 17, "name": "高速节点 A", "soldCount": 32, "pointsRevenue": 6400 }
  ],
  "statusBreakdown": {
    "paid": 18,
    "fulfilled": 96,
    "refunded": 4
  }
}
```

字段定义（与 `schemas.ts` `DashboardTimeseriesSchema` 对齐）：

| 字段 | 类型 | 约束 | 含义 |
| --- | --- | --- | --- |
| `range` | string | `'7d' \| '30d' \| '90d'` | 回显请求的 `range` |
| `points` | array | ≤ 90 项（90d 窗口上限；7d 窗口 ≤ 7 项；30d 窗口 ≤ 30 项；无订单的日子不会出现在数组） | 按日聚合的趋势点；按日期升序 |
| `points[].date` | string | `YYYY-MM-DD` | 自然日（数据库时区，由 `to_char(date_trunc('day', ...))` 产出） |
| `points[].orderCount` | integer | ≥ 0 | 当日订单数（排除 `status='refunded'`） |
| `points[].pointsRevenue` | integer | ≥ 0 | 当日 `Order.price` 合计（排除 `status='refunded'`） |
| `top10` | array | ≤ 10 项 | 窗口内该商家热销商品；按 `soldCount` desc → `pointsRevenue` desc → `productId` asc 排序 |
| `top10[].productId` | integer | > 0 | 商品 id |
| `top10[].name` | string | — | 商品名（来自 `Product.name`） |
| `top10[].soldCount` | integer | ≥ 0 | 窗口内该商品订单数（排除 `refunded`） |
| `top10[].pointsRevenue` | integer | ≥ 0 | 窗口内该商品积分收入（`Order.price` 合计，排除 `refunded`） |
| `statusBreakdown.paid` | integer | ≥ 0 | 窗口内 `status ∈ {'paid','pending','processing'}` 订单数 |
| `statusBreakdown.fulfilled` | integer | ≥ 0 | 窗口内 `status ∈ {'fulfilled','delivered','completed','closed'}` 订单数 |
| `statusBreakdown.refunded` | integer | ≥ 0 | 窗口内 `status='refunded'` 订单数 |

> 状态聚合常量见 `service.ts`：`PAID_STATUSES` / `FULFILLED_STATUSES`。`statusBreakdown` 三类之间**不互斥求和**；这是各自类别的独立计数。

窗口边界：右开区间 `[start, end)`，`end` 取当日次日 0 点，`start = end − rangeDays`。

### 错误码

| Status | `error.code` | message | 触发条件 |
| --- | --- | --- | --- |
| `400` | `BAD_REQUEST` | `range 参数无效，仅支持 7d / 30d / 90d` | `range` 缺失或不在 `7d`/`30d`/`90d` 范围（由 Zod `RangeSchema` 校验失败抛出） |
| `401` | `UNAUTHENTICATED` | `未登录` | 缺失 / 失效 / 错误的 Bearer token |
| `403` | `FORBIDDEN` | — | 被封禁用户或非商家 role |
| `404` | `NOT_FOUND` | `商家账户不存在` | 用户是商家 role 但 `Merchant` 表中无对应行 |
| `500` | `INTERNAL_SERVER_ERROR` | `服务器内部错误` | 服务异常 |

> controller 中 `range` 校验先于鉴权剩余分支生效；即使 token 无效，只要 `range` 也非法，目前实现仍会触发 401（`authenticate` 中间件在 controller 之前先运行）。`range` 非法的 400 仅在用户已通过鉴权链后才会出现。

### `curl` 示例

**成功（200）**

```bash
curl -fsS "http://localhost:3000/api/merchant/dashboard/timeseries?range=30d" \
  -H "Authorization: Bearer $MERCHANT_TOKEN"
# {
#   "range": "30d",
#   "points": [ { "date": "2026-04-23", "orderCount": 4, "pointsRevenue": 800 }, ... ],
#   "top10":  [ { "productId": 17, "name": "高速节点 A", "soldCount": 32, "pointsRevenue": 6400 }, ... ],
#   "statusBreakdown": { "paid": 18, "fulfilled": 96, "refunded": 4 }
# }
```

**range 非法（400）**

```bash
curl -sS -o - -w '\n%{http_code}\n' \
  "http://localhost:3000/api/merchant/dashboard/timeseries?range=60d" \
  -H "Authorization: Bearer $MERCHANT_TOKEN"
# {
#   "requestId": "req_a7b2...",
#   "error": { "code": "BAD_REQUEST", "message": "range 参数无效，仅支持 7d / 30d / 90d" }
# }
# 400
```

## 4. 行为说明

- **Read-only**：两个端点都不写任何表（无 `INSERT` / `UPDATE` / `DELETE`），无审计日志写入。
- **merchantId 来源唯一**：仅由 `attachMerchantId` 中间件从 token 解析（`Merchant.userId = req.user.userId`）。任何 `query.merchantId` / `body.merchantId` / `params.merchantId` 都不会被 controller 或 service 读取 —— **既不报错也不生效**（静默忽略），与 SHARED-RULES §3 "do not leak resource existence" 一致。
- **Owner boundary**：当 token 关联的用户是商家 role 但 `Merchant` 表无对应记录时返回 404（`商家账户不存在`），而非 403，避免暴露"该用户被识别为商家但记录缺失"这一信号。
- **状态聚合**：`refunded` 的订单不计入 `monthPointsRevenue` / `points[].pointsRevenue` / `points[].orderCount` / `top10[].soldCount` / `top10[].pointsRevenue`，仅在 `statusBreakdown.refunded` 中体现。
- **金额单位**：所有"积分"字段（`*PointsRevenue` / `pendingSettlementPoints`）单位为**积分整数**，无小数；满足全平台 "All amounts are non-negative integers"。
- **时区**：日期分桶使用数据库时区（PostgreSQL `date_trunc('day', "createdAt")`）。生产部署确认 DB 时区与运营所在时区一致。
- **可观测**：service 层在每次调用末尾记录结构化日志 `{ op: 'dashboard.summary' | 'dashboard.timeseries', merchantId, duration_ms }`；用于 §运维 runbook 中的慢查询排查与告警。

## 5. 变更历史

| 日期 | 版本 | 变更 | 来源 |
| --- | --- | --- | --- |
| 2026-05-22 | M8 first release | 新增 `GET /summary` 与 `GET /timeseries`；read-only；merchantId from token | M8 A1 (`server/src/modules/dashboard/service.ts`) + A2 (`controller.ts` / `routes.ts` / `schemas.ts`) |

> 后续 patch（M8.1+）在本表末尾 append 新行；不修改既有行。
