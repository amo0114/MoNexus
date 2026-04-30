# MoNexus 商家与结算契约

**日期：** 2026-04-29

## 1. 目标与边界

本契约冻结 MoNexus 从“用户端 + 单管理员后台”升级为“用户端 + 商家端 + 平台管理端”所需的商家、商品归属、订单分润与结算接口。前端、后端、集成分支均以本文档为唯一字段与接口真相来源。

范围内：

- 普通用户提交商家入驻申请。
- 平台管理员审核、拒绝、停用商家并配置抽成比例。
- 商家管理自有商品、库存、订单、结算与资料。
- 用户端商品与订单展示商家摘要。
- 兑换商家商品时生成订单、积分流水、发货记录与结算记录。

范围外：

- 真实支付、提现、法币钱包、外部金融系统。
- 商家发行积分、接收积分或自行打款。
- 商家商品平台审核流。
- 批量结算部分成功返回；本阶段批量中任一记录不可结算则整体失败。

## 2. 基础类型

```ts
type UserRole = 'user' | 'admin' | 'merchant'
type MerchantStatus = 'pending' | 'active' | 'suspended' | 'rejected'
type SettlementStatus = 'pending' | 'settled'
type ProductStatus = 'active' | 'inactive'
```

金额、积分、佣金金额、结算金额均为整数积分。`commissionRate` 在响应中统一为字符串，避免前端浮点精度歧义；请求中仍按接口定义提交数字。

## 3. 数据结构

### 3.1 Merchant

```ts
interface Merchant {
  id: number
  userId: number
  name: string
  description: string | null
  status: MerchantStatus
  commissionRate: string
  contactEmail: string | null
  contactPhone: string | null
  createdAt: string
  updatedAt: string
  approvedAt: string | null
  approvedBy: number | null
}
```

状态流转：

```text
pending -> active
pending -> rejected
active -> suspended
suspended -> active
rejected -> pending  // 仅当后端明确允许重新申请时使用；否则重复申请返回 409
```

本阶段默认后端对重复申请返回 `409 CONFLICT`，前端展示当前申请状态或引导联系平台。

### 3.2 AuthUser

```ts
interface AuthUser {
  id: number
  email: string
  role: UserRole
  status: string
  inviteCode: string
  points: number
  createdAt?: string
  merchant: null | {
    id: number
    name: string
    status: MerchantStatus
    commissionRate: string
  }
}
```

`GET /api/auth/me` 是前端判断角色、商家状态与入口展示的唯一入口。

前端展示规则：

- `role === 'admin'`：显示平台管理入口。
- `role === 'merchant' && merchant?.status === 'active'`：显示商家后台入口。
- `role === 'user' && merchant?.status === 'pending'`：显示“商家申请审核中”。
- `role === 'user' && merchant?.status === 'rejected'`：显示“申请被拒绝，可重新申请或联系平台”。
- `role === 'user' && merchant?.status === 'suspended'`：显示“商家账号已被停用，请联系平台”。
- `merchant === null`：显示“申请成为商家”入口。

管理员审核通过或停用商家后，旧 access token 中的 `role` 可能仍是旧值。前端必须重新调用 `/api/auth/refresh` 获取新 access token，随后调用 `/api/auth/me`；如果刷新失败则要求用户重新登录。前端每次调用 `/api/auth/me` 后，应比对返回的 `role` 与当前 access token 解析出的 `role`；若不一致，应主动刷新 token 后再放行角色敏感入口，避免用户点击商家入口后遭遇误导性的 403。

前端展示 `commissionRate` 时应格式化为百分比，例如将 `"0.1000"` 展示为 `10%`，避免直接朗读小数字符串。

### 3.3 MerchantProduct

```ts
interface MerchantProduct {
  id: number
  merchantId: number | null
  name: string
  description: string | null
  richDescription: string | null
  type: string
  icon: string
  imageUrl: string | null
  price: number
  originalPrice: number | null
  stock: number
  sales: number
  isHot: boolean
  status: ProductStatus
  createdAt: string
  merchant?: { id: number; name: string } | null
  _count?: { inventory: number }
}
```

`merchantId === null` 表示平台自营商品。商家端只能创建和维护 `merchantId` 属于自己的商品。

### 3.4 MerchantOrder

```ts
interface MerchantOrder {
  id: number
  userId: number
  productId: number
  merchantId: number
  price: number
  commissionRate: string
  commissionAmount: number
  settlementAmount: number
  status: string
  createdAt: string
  user?: { id: number; email: string }
  product?: { id: number; name: string; icon: string; type: string }
  delivery?: { content: string; status: string } | null
  settlement?: Settlement | null
}
```

商家只能查询 `merchantId` 属于自己的订单。商家端不展示用户积分余额、平台内部日志或管理员操作信息。

### 3.5 Settlement

```ts
interface Settlement {
  id: number
  merchantId: number
  orderId: number
  orderAmount: number
  commissionRate: string
  commissionAmount: number
  settlementAmount: number
  status: SettlementStatus
  settledAt: string | null
  createdAt: string
  merchant?: { id: number; name: string }
  order?: { id: number; price: number; createdAt: string }
}
```

结算记录由用户兑换商家商品时同步创建。`settlementAmount = orderAmount - commissionAmount`。

### 3.6 MerchantStats

```ts
interface MerchantStats {
  productCount: number
  orderCount: number
  totalRevenue: number
  pendingSettlement: number
}
```

## 4. 请求校验约定

### 4.1 商家申请

```ts
interface ApplyMerchantRequest {
  name: string
  description?: string
  contactEmail?: string
  contactPhone?: string
}
```

规则：

- `name`：必填，长度 1-100。
- `description`：可选。
- `contactEmail`：可选，必须为合法邮箱。
- `contactPhone`：可选。

### 4.2 商家资料更新

```ts
interface UpdateMerchantRequest {
  name?: string
  description?: string
  contactEmail?: string
  contactPhone?: string
}
```

### 4.3 商品创建与更新

```ts
interface CreateMerchantProductRequest {
  name: string
  description?: string
  richDescription?: string
  type: string
  icon?: string
  imageUrl?: string
  price: number
  originalPrice?: number
  isHot?: boolean
}

interface UpdateMerchantProductRequest extends Partial<CreateMerchantProductRequest> {
  status?: ProductStatus
}
```

规则：

- `name`、`type`：创建时必填且非空。
- `price`、`originalPrice`：正整数。
- `icon` 默认值为 `package`。
- `status` 仅允许 `active | inactive`。

### 4.4 库存导入

```ts
interface ImportInventoryRequest {
  items: string[]
}
```

`items` 至少 1 条，每条为非空字符串。前端多行文本应拆分、去空行后提交。

### 4.5 管理员审核与抽成

```ts
interface RejectMerchantRequest {
  reason?: string
}

interface UpdateCommissionRequest {
  commissionRate: number
}

interface BatchSettleRequest {
  settlementIds: number[]
}
```

规则：

- `commissionRate`：`0 <= commissionRate <= 1`。
- `settlementIds`：至少 1 个正整数。

## 5. 商家申请与商家端接口

| 方法 | 路径 | 权限 | 请求 | 响应 | 说明 |
|---|---|---|---|---|---|
| `POST` | `/api/merchant/register` | 登录用户 | `ApplyMerchantRequest` | `Merchant` | 提交入驻申请，成功返回 201 |
| `GET` | `/api/merchant/me` | active merchant | 无 | `Merchant` | 获取商家资料 |
| `PUT` | `/api/merchant/me` | active merchant | `UpdateMerchantRequest` | `Merchant` | 更新商家资料 |
| `GET` | `/api/merchant/stats` | active merchant | 无 | `MerchantStats` | 商家概览 |
| `GET` | `/api/merchant/products` | active merchant | `page?, pageSize?, status?` | `MerchantProduct[]` | 商家商品列表 |
| `POST` | `/api/merchant/products` | active merchant | `CreateMerchantProductRequest` | `MerchantProduct` | 创建商品，成功返回 201 |
| `PUT` | `/api/merchant/products/:id` | active merchant + ownership | `UpdateMerchantProductRequest` | `MerchantProduct` | 更新自有商品 |
| `POST` | `/api/merchant/products/:id/inventory` | active merchant + ownership | `ImportInventoryRequest` | `{ imported: number }` | 导入自有商品库存 |
| `GET` | `/api/merchant/orders` | active merchant | `page?, pageSize?` | `MerchantOrder[]` | 商家订单列表 |
| `GET` | `/api/merchant/orders/:id` | active merchant + ownership | 无 | `MerchantOrder` | 商家订单详情 |
| `GET` | `/api/merchant/settlements` | active merchant | `page?, pageSize?, status?` | `Settlement[]` | 商家结算列表 |

分页参数：

- `page` 默认 1。
- `pageSize` 默认 20，最大 100。
- 本阶段列表响应冻结为数组，不返回 `total`。需要总数分页时必须先变更契约。

权限规则：

- `/api/merchant/register` 允许已登录普通用户提交申请。
- 其他 `/api/merchant/*` 仅允许 `role === 'merchant'` 且商家状态为 `active` 的用户访问。
- 所有商品、订单、结算 mutation 或详情接口必须做 ownership 校验，不暴露其他商家资源。

## 6. 平台管理扩展接口

| 方法 | 路径 | 权限 | 请求 | 响应 | 说明 |
|---|---|---|---|---|---|
| `GET` | `/api/admin/merchants` | admin | `status?, q?, page?, pageSize?` | `Merchant[]` | 商家列表 |
| `GET` | `/api/admin/merchants/:id` | admin | 无 | `MerchantDetail` | 商家详情 |
| `PUT` | `/api/admin/merchants/:id/approve` | admin | 无 | `Merchant` | 审核通过，同时用户变商家 |
| `PUT` | `/api/admin/merchants/:id/reject` | admin | `RejectMerchantRequest` | `Merchant` | 拒绝入驻 |
| `PUT` | `/api/admin/merchants/:id/suspend` | admin | 无 | `Merchant` | 停用商家，同时用户降回普通用户 |
| `PUT` | `/api/admin/merchants/:id/commission` | admin | `UpdateCommissionRequest` | `Merchant` | 调整抽成 |
| `GET` | `/api/admin/settlements` | admin | `status?, page?, pageSize?` | `Settlement[]` | 结算列表 |
| `POST` | `/api/admin/settlements/batch-settle` | admin | `BatchSettleRequest` | `{ settled: number }` | 批量结算 |

```ts
interface MerchantDetail extends Merchant {
  user?: { id: number; email: string; status: string; createdAt: string }
  products?: MerchantProduct[]
  orderCount?: number
  settlementCount?: number
}
```

管理员操作要求：

- 审核通过、拒绝、停用、调整抽成、批量结算均应写入 `AdminLog` 或等价审计记录。
- 审核通过与停用必须在事务内同步更新 `Merchant.status` 与 `User.role`。
- 批量结算只允许 `pending` 记录；任一记录不是 `pending` 时整体返回 `400 BAD_REQUEST`。

## 7. 用户端已有接口扩展

| 接口 | 扩展 |
|---|---|
| `GET /api/products` | 每个商品增加 `merchant?: { id: number; name: string } | null` |
| `GET /api/products/:id` | 商品详情增加 `merchant?: { id: number; name: string } | null` |
| `POST /api/orders` | 兑换商家商品时响应增加 `merchantId`, `merchantName` |
| `GET /api/orders` | 订单项增加 `merchant?: { id: number; name: string } | null` |
| `GET /api/orders/:id` | 订单详情增加 `merchant?: { id: number; name: string } | null` |

兑换规则：

- 平台自营商品按既有链路执行。
- 商家商品必须满足商品 `status === 'active'` 且商家 `status === 'active'`。
- 订单创建时快照 `merchantId`、`commissionRate`、`commissionAmount`。
- 订单、扣积分、库存绑定、发货、积分流水、结算记录必须在同一事务中完成。
- `PointLog` 应记录关联 `orderId`。

## 8. 错误信封与错误码

所有错误继续使用统一信封：

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "错误信息",
    "details": []
  }
}
```

| 场景 | HTTP | code | 前端处理 |
|---|---:|---|---|
| 未登录 | 401 | `UNAUTHENTICATED` | 跳转登录或展示未登录态 |
| 非管理员访问管理接口 | 403 | `FORBIDDEN` | 显示无权限 |
| 非 active 商家访问商家接口 | 403 | `FORBIDDEN` | 引导申请、等待审核或联系平台 |
| 重复申请商家 | 409 | `CONFLICT` | 展示当前申请状态 |
| 非本人商家资源 | 404 或 403 | `NOT_FOUND` 或 `FORBIDDEN` | 不暴露其他商家资源 |
| 抽成比例非法 | 400 | `VALIDATION_ERROR` | 表单字段错误 |
| 批量结算包含非 pending | 400 | `BAD_REQUEST` | 提示刷新列表后重试 |
| 商品下架、非 active 商家、库存不足、积分不足 | 400 | `BAD_REQUEST` | 展示兑换失败原因 |

## 9. 分支与文件边界

后端正式分支：`feat/backend-merchant-settlement`。

后端允许修改：

- `server/**`
- 后端相关 `docs/superpowers/**`
- 后端启动脚本中与后端启动有关的部分
- 共享契约文档，前提是先冻结并经前后端确认

后端不得修改：

- `src/**`
- 根 `package.json`
- 根 `vite.config.ts`
- 前端样式、组件、页面或状态管理文件

当前 `.worktrees/backend-postgres-auth` 位于 `integration/mvp-week1`，其历史包含前端改动，不能直接作为干净后端分支。B0 应从后端基线分支创建 `feat/backend-merchant-settlement`，再选择性重放 `server/**`、后端文档与契约文件改动。

## 10. 契约完成定义

- 本文档包含商家、结算、商品、订单相关类型、请求、响应、错误、权限和状态流转。
- 如继续维护 `docs/superpowers/specs/monexus-api-openapi.json`，其中必须同步覆盖 merchant/settlement 路径与 schema。
- 前端任务书引用本文档，不引用后端实现源码猜字段。
- 后端测试和前端 mock 数据使用本文档字段名。
- 分支边界验证中，后端分支 `git diff --name-only` 不出现 `src/**` 前端业务文件。
