# M9 体验打磨（Experience Polish）— 运营说明

> 适用版本：`integration/m9-rc`（commits `fb4d89f` / `7c5d436` / `10f9201` / `abe4d55` / `7b125aa`）
> 数据库迁移：`20260610030207_m9_inventory_log_and_images`

## 1. M9 改动摘要

| Agent | 范围 | 内容 |
| --- | --- | --- |
| A1 | 后端·商家 | 新增库存流水表 `InventoryLog`（导入/作废落账）、库存作废 API、商品多图 `Product.images`（最多 6 张 URL） |
| A2 | 后端·管理 | `GET /admin/users`、`GET /admin/orders` 支持搜索/筛选并改为分页对象响应；`GET /admin/config` 返回中文 `description/group/unit/hint` 元数据；商品详情移除假评价数据源 |
| A3 | 商家端 UI | 商品列表筛选（关键词/状态/类型/发货模式/低库存开关）、库存流水弹窗 + 作废表单、商品表单升级（多图上传、图文介绍编辑/预览） |
| A4 | 管理端 UI | 系统配置页中文分组渲染（主标签为中文描述，英文 key 为辅助小字）、用户/订单搜索分页、佣金调整二次确认弹窗 |
| A5 | 用户端 UI | 商城「加载更多」追加式分页、商品详情图集（主图 + 缩略图）、移除买家评价区、订单争议/关闭确认弹窗 |
| A6 | 测试与文档 | 新增 3 个 E2E spec（admin-config / merchant-inventory / store-pagination）+ 本文档 |

## 2. A1/A2 新增 API

所有接口前缀 `/api`，需 `Authorization: Bearer <accessToken>`。商家接口要求 `role=merchant` 且商家 `status=active`；管理接口要求 `role=admin`。

### 2.1 POST `/merchant/products/:id/inventory/void` — 作废库存（A1，新增）

按入库时间先进先出，将 `count` 条 `available` 库存项置为 `void`，同事务扣减 `Product.stock` 并写入流水。

请求体：

```json
{ "count": 1, "reason": "卡密失效" }
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| count | int > 0 | 是 | 作废条数，超过可用库存返回 400「可作废库存不足」 |
| reason | string ≤ 500 | 否 | 作废原因，写入流水备注 |

示例响应（200）：

```json
{ "voided": 1, "stock": 3 }
```

### 2.2 GET `/merchant/products/:id/inventory/logs` — 库存流水（A1，新增）

仅记录导入（`import`，delta 为正）与作废（`void`，delta 为负）。

Query：`page`（默认 1）、`pageSize`（默认/上限受系统配置 `defaultPageSize` / `maxPageSize` 约束）。

示例响应（200）：

```json
{
  "items": [
    {
      "id": 12,
      "productId": 5,
      "merchantId": 1,
      "actorUserId": 3,
      "action": "void",
      "delta": -1,
      "reason": "E2E 自动化作废",
      "createdAt": "2026-06-10T10:45:00.000Z"
    }
  ],
  "total": 12,
  "page": 1,
  "pageSize": 10
}
```

### 2.3 GET `/admin/users` — 用户列表（A2，响应结构变更 + 搜索）

Query：`q`（按邮箱/邀请码模糊搜索，1–100 字符）、`page`、`pageSize`（≤ `maxPageSize`）。

**Breaking change**：响应由裸数组改为分页对象：

```json
{ "items": [ { "id": 2, "email": "test@moyuan.net", "role": "user", "...": "..." } ], "total": 42, "page": 1, "pageSize": 20 }
```

### 2.4 GET `/admin/orders` — 订单列表（A2，响应结构变更 + 筛选）

Query：`status`（订单状态枚举）、`q`、`page`、`pageSize`。响应同样为 `{ items, total, page, pageSize }` 分页对象。

### 2.5 GET `/admin/config` — 系统配置（A2，新增元数据字段）

每个配置项在原 `key/value/defaultValue/updatedAt/updatedBy` 基础上新增：

| 字段 | 说明 |
| --- | --- |
| description | 中文描述（管理端主标签） |
| group | 中文分组名（见 §3） |
| unit | 单位（可空），如「积分」「天」「bps」 |
| hint | 填写提示（可空），如阈值约束说明 |

示例响应元素：

```json
{
  "key": "checkinReward",
  "value": 50,
  "defaultValue": 50,
  "description": "每日签到奖励积分",
  "group": "奖励发放",
  "unit": "积分",
  "hint": null,
  "updatedAt": "2026-06-10T10:40:00.000Z",
  "updatedBy": 1
}
```

`PUT /admin/config/:key` 行为不变（非负整数校验 + 会员等级阈值/加成联动校验 + 审计日志）。

## 3. 配置分组对照表

来源：`server/src/lib/systemConfig.ts`（managed list，前端按 `GROUP_ORDER` 顺序渲染）。

| 分组 | key | 中文描述 | 单位 | 默认值 |
| --- | --- | --- | --- | --- |
| 奖励发放 | registerReward | 新用户注册奖励积分 | 积分 | 取自环境配置 `config.registerReward` |
| 奖励发放 | checkinReward | 每日签到奖励积分 | 积分 | 取自环境配置 `config.checkinReward` |
| 奖励发放 | inviteReward | 邀请新用户奖励积分 | 积分 | 取自环境配置 `config.inviteReward` |
| 安全 | refreshTokenMaxAgeDays | Refresh Token 有效天数 | 天 | 取自 `config.refreshTokenMaxAgeMs` 换算 |
| 分页限制 | defaultPageSize | 列表默认分页大小 | 条/页 | businessRegistry.pagination.defaultPageSize |
| 分页限制 | maxPageSize | 列表最大分页大小 | 条/页 | businessRegistry.pagination.maxPageSize |
| 库存 | lowStockThreshold | 低库存提醒阈值 | 件 | businessRegistry.inventory.lowStockThreshold（5） |
| 会员等级 | memberTierSilverThreshold | 银卡会员累计积分门槛 | 积分 | 1000 |
| 会员等级 | memberTierGoldThreshold | 金卡会员累计积分门槛 | 积分 | 5000 |
| 会员等级 | memberTierPlatinumThreshold | 铂金会员累计积分门槛 | 积分 | 20000 |
| 会员等级 | memberTierSilverBonusBps | 银卡签到/邀请奖励加成基点（万分之） | bps | 500 |
| 会员等级 | memberTierGoldBonusBps | 金卡签到/邀请奖励加成基点（万分之） | bps | 1000 |
| 会员等级 | memberTierPlatinumBonusBps | 铂金签到/邀请奖励加成基点（万分之） | bps | 2000 |

约束提醒：会员等级阈值必须满足 银卡 < 金卡 < 铂金；加成基点范围 0–10000。

## 4. 回滚说明

### 4.1 应用层

- 前后端必须同进退：A2 将 `GET /admin/users`、`GET /admin/orders` 由数组改为 `{items,total,page,pageSize}`，仅回滚其中一端会导致管理端列表解析失败。
- 回滚方式：将部署版本切回 M8 标签（`1ce2ade` 之前的发布产物），或在 `integration/m9-rc` 上 `git revert 7b125aa abe4d55 10f9201 7c5d436 fb4d89f`（按依赖逆序）。

### 4.2 数据库迁移 down 思路

M9 仅含一个迁移 `20260610030207_m9_inventory_log_and_images`，均为加法变更，回滚 SQL：

```sql
-- 1. 移除库存流水表（连带外键与索引）
DROP TABLE IF EXISTS "InventoryLog";

-- 2. 移除商品多图列
ALTER TABLE "Product" DROP COLUMN IF EXISTS "images";
```

注意：

- `InventoryLog` 删除即丢失导入/作废审计数据，回滚前如需留档先 `pg_dump -t '"InventoryLog"'` 备份。
- `Product.images` 删除会丢失商家已配置的多图；详情页会自动回退到单图 `imageUrl`，无功能性损坏。
- 库存作废产生的 `InventoryItem.status='void'` 与 `Product.stock` 扣减是业务数据，不随迁移回滚还原；如需恢复请按流水备份反向核对。
- 系统配置新元数据（description/group/unit/hint）为代码层常量映射，无 DB 变更，无需回滚动作。

## 5. E2E 覆盖（A6 新增）

| Spec | 场景 |
| --- | --- |
| `e2e/admin-config.spec.ts` | 管理员登录 → 系统配置 Tab → 5 个中文分组 + 中文主标签断言 → 修改 `checkinReward` 保存 → Toast → 改回原值 |
| `e2e/merchant-inventory.spec.ts` | 商家登录 → 关键词搜索/空结果/低库存开关 → 导入 1 条唯一库存 → 作废 1 条 → 流水新增 void 记录、库存净变化为 0（可重复执行） |
| `e2e/store-pagination.spec.ts` | 用户登录 → 商城首屏 20 个商品 → 「加载更多」追加渲染 → 详情页图集可见、无买家评价区（不足 21 个商品时由管理员 API 一次性补占位商品） |

运行：`npm run e2e`（本地自动拉起 server:3000 + vite:5173）。注意后端 `/api` 全局限流 300 次/15 分钟（内存计数）：短时间内反复跑全量 e2e 会触发 429 导致登录失败，重启 server 进程即可重置。
