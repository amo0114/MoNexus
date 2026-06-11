# MoNexus 商品交付方式扩展设计（方案 A：最小演进，4 模式 + 类型化交付载荷）

日期：2026-06-11
状态：已评审通过（含 3 点修正）

## 1. 背景与目标

当前商品库存心智被限制为"卡密/兑换码"类商品：库存即一行一条的纯文本 `InventoryItem`。
项目已有 `Product.deliveryMode` 双模式骨架（`instant_inventory` 自动发码 / `manual_service` 人工交付），
贯穿下单事务、订单状态机、结算门控、businessRegistry 与前端表单。

本设计将交付方式从 2 值扩展为 4 值，解锁"固定内容/外部链接"与"文件下载"两类商品，
**不推翻现有骨架**，并与 `docs/operations/card-shop-go-live-plan.md` Phase 2 现金支付规划兼容。

### 范围内

| 模式 | 库存语义 | 交付时机 | 阶段 |
|---|---|---|---|
| `instant_inventory`（现有） | 一行一条，消耗型 InventoryItem | 即时 | — |
| `instant_fixed`（新增） | 固定内容（文本/链接），无限或限量 | 即时 | Phase 1 |
| `file_download`（新增） | 商家上传文件，无限或限量 | 即时 | Phase 2 |
| `manual_service`（现有） | 无库存，订单驱动 | 商家处理 | — |

### 范围外（明确暂缓）

- **账号池**：需要占用/释放/过期/封禁/并发/复用等持续生命周期管理，会显著复杂化订单状态机。
  现阶段"共享账号"品类继续用 `instant_inventory` 交付账号条目。待真实商家需求出现后单独设计。
- 文件下载的限次/限期/下载日志：二期增强，初版为"订单归属鉴权 + 永久可下载"。

## 2. 数据模型

```prisma
// Product 新增字段
stockMode        String  @default("limited")  // limited | unlimited（instant_inventory 强制 limited）
fixedContent     String?                      // instant_fixed 专用：固定交付内容
fixedContentType String  @default("text")     // text | url

// DeliveryRecord 新增字段
contentType String  @default("text")          // text | url | file
fileKey     String?                           // Phase 2：交付时快照的存储 key
fileName    String?                           // Phase 2：交付时快照
fileMime    String?                           // Phase 2：交付时快照
fileSize    Int?                              // Phase 2：交付时快照

// Phase 2 新模型
model ProductFile {
  id         Int      @id @default(autoincrement())
  productId  Int      @unique                 // 一商品一文件，1:1
  storageKey String
  fileName   String
  mimeType   String
  size       Int
  createdAt  DateTime @default(now())
}
```

要点：

- `stock` 继续只表示限量数量，不承担无限库存的魔法语义（不用 `-1`）。
  `stockMode=unlimited` 时下单跳过 stock 扣减、前端显示"不限"，`sales` 照常累加。
- **交付内容在购买时快照进 DeliveryRecord**：商家后改 `fixedContent` 或替换文件不影响已购订单。
- **文件交付快照完整元数据**（修正点 3）：DeliveryRecord 同时快照 `fileKey / fileName / fileMime / fileSize`，
  下载端点完全从 DeliveryRecord 取元数据，不回查当前 ProductFile，避免商家替换文件后旧订单拿到错误的文件名/类型/大小。
- **旧文件保留约束**（修正点 3）：商家替换商品文件时，旧 storageKey 仍被 DeliveryRecord 引用的，不得从对象存储删除。
  初版策略：替换文件只新增 storageKey、不删除旧对象（存储为内容寻址 sha256 key，天然去重）；
  清理任务留待后续（需先实现引用计数/扫描）。
- 不用 JSON 载荷，平铺字段，与现有 schema 风格一致（String + 代码层校验，无 Prisma enum）。

## 3. 订单状态机与下单流程

引入 `isInstantMode(mode)` 辅助函数（`instant_inventory | instant_fixed | file_download` 为即时模式），
替换散落各处的 `=== 'instant_inventory'` 硬编码：

- `server/src/modules/orders/fulfillment.ts`：`FULFILLMENT_MODES` 扩为 4 值；
  `disputed → delivered` 争议驳回特判（commit 80af51d）从"仅 instant_inventory"扩为"所有即时模式"。
- `server/src/modules/orders/service.ts` `createOrder` 按模式分支（单事务内）：
  - `instant_inventory`：现有逻辑不变（取最早 available InventoryItem，乐观锁占用）。
  - `instant_fixed`：校验 `fixedContent` 非空；`stockMode=limited` 时原子校验并扣减 `Product.stock`
    （`updateMany({ where: { id, stock: { gt: 0 } } })`，count!==1 视为售罄，防并发超卖）；
    不消耗 InventoryItem；订单直接 `delivered`，DeliveryRecord 内容取自 `Product.fixedContent`。
  - `file_download`（Phase 2）：同 instant_fixed 的库存逻辑；DeliveryRecord 写
    `contentType='file'` + 快照 ProductFile 四项元数据，`content` 存 fileName 供展示。
  - `manual_service`：现有逻辑不变（`pending → processing → delivered`）。
- `server/src/modules/merchant/service.ts`：
  - `respondToOrderDispute` resumeTarget：即时模式 → delivered，manual_service → processing。
  - `deliverOrderFulfillment` 守卫不变：仅 manual_service 允许商家手工交付。
- 结算门控（delivered/closed 可结算）零改动。

### 低库存判断（修正点 2）

低库存提醒覆盖**所有 `stockMode=limited` 的模式**，仅库存来源不同：

| 模式 | 低库存数据来源 |
|---|---|
| `instant_inventory` | 可用 InventoryItem 计数 |
| `instant_fixed` / `file_download`（limited） | `Product.stock` |
| `manual_service`、各模式 unlimited | 不参与库存提醒 |

`isLowStockProduct` 据此重构，不再硬编码 instant_inventory。

### 与 Phase 2 现金支付 / InventoryReservation 的兼容（修正点 1）

预留语义按库存类型划分，**不能简化为"只有 instant_inventory 需要预留"**：

- `stockMode=unlimited`（instant_fixed / file_download）：无需预留。
- `instant_inventory`：预留具体 InventoryItem（reservation type = `inventory_item`）。
- `instant_fixed` / `file_download` 的 `stockMode=limited`：仍有超卖风险。
  积分即时兑换阶段由下单事务内原子扣 `Product.stock` 保证；
  现金支付阶段（存在 unpaid→paid 时间窗）必须有数量级预留——
  `InventoryReservation` 设计时需同时支持 `inventory_item` 与 `product_quantity` 两种预留类型，
  或在现金方案中单独定义"有限库存商品预留"。本设计在此处为现金方案预埋接口约束，不在本期实现。

## 4. Registry 与 API

- `server/src/lib/businessRegistry.ts`：deliveryModes 注册表新增
  `instant_fixed`（标签"固定内容/链接"，Phase 1）、`file_download`（标签"文件下载"，Phase 2）；
  productTypes 的模式映射保持宽松（各类型均可选）。前端表单自动跟随 registry。
- `server/src/modules/merchant/schema.ts` 交叉校验：
  - `instant_fixed` 必填 `fixedContent`：`text` ≤5000 字；`url` 必须为 http/https 协议、≤2048 字符，
    **拒绝 `javascript:` 等危险协议**（防存储型 XSS）。
  - `stockMode` ∈ {limited, unlimited}；`instant_inventory` 强制 limited。
  - 库存导入/作废接口对非 `instant_inventory` 商品返回 400。
- 序列化（`orders/serializers.ts`）：透出 `contentType`、`deliveryMode`；
  列表视图剥离交付内容（`omitDeliveryContent`）的现有守则不变。

### Phase 2 文件接口

- 上传：扩展 uploads 模块，文件类 MIME 白名单（zip / pdf / 常见文档），初版大小上限 **20MB**
  （multer 内存存储的安全范围；更大文件需改流式上传，留二期）。
- 下载：`GET /api/orders/:id/download` —— 校验请求者为订单归属用户（或管理员）+
  DeliveryRecord 存在且 `contentType=file` → 通过 storage adapter 流式回传，
  `Content-Disposition: attachment; filename=<快照 fileName>`。
  **全程不暴露公开 URL，不生成永久外链**。

## 5. 前端

- **商家发布表单**（`MerchantProductFormModal`）：模式 radio 已 registry 驱动，按所选模式条件渲染：
  - `instant_fixed`：「文本/链接」切换 + 内容输入 + 库存模式（不限 / 限量+数量）。
  - `file_download`（Phase 2）：文件上传 + 库存模式。
  - `instant_inventory` / `manual_service`：不变。
- **订单详情 / 购买成功弹窗**（`OrderDetailModal`、`SuccessModal`）按 `contentType` 渲染：
  - `text`：等宽文本块 + 复制按钮（现状）。
  - `url`：可点击链接（`rel="noopener noreferrer"`、展示完整 URL）+ 复制按钮。
  - `file`：下载按钮，指向鉴权下载端点。
- **商品详情页**（`ProductDetailPage`）：unlimited 显示"不限"，购买守卫跳过库存检查。
- 类型与 API 层同步：`src/types/order.ts`、`src/types/merchant.ts`、`src/api/orders.ts`、`src/api/merchant.ts`。

## 6. 错误处理与边界

- URL 内容仅允许 http/https，schema 层与前端渲染层双重防护。
- `instant_fixed` limited 并发下单：`updateMany` 条件更新防超卖，失败返回"库存不足"。
- 商家修改已售商品的模式/内容：已购订单不受影响（DeliveryRecord 快照）。
- unlimited 商品的 `stock` 字段忽略、不清零；切回 limited 时沿用原值，商家可编辑。
- `manual_service` 维持现状：stock 表示可接单数量，下单照常扣减；也可选 unlimited（不限接单），但不参与低库存提醒。
- 商家替换文件：旧对象保留（被订单引用），新订单交付新文件。

## 7. 测试

后端（vitest，TEST_DATABASE_URL）：

- 各模式 `createOrder` 集成测试：instant_fixed 下单即 delivered、内容快照正确；
  unlimited 不扣 stock；limited 并发售罄返回库存不足。
- instant_fixed 订单争议驳回回 delivered（状态机扩展）。
- 库存导入接口对 instant_fixed 商品返回 400。
- 低库存判断覆盖 instant_fixed limited。
- Phase 2：下载端点鉴权（他人订单 403、非文件订单 404、未登录 401）；快照元数据与替换文件后旧订单下载正确性。

e2e（Playwright）：

- 商家发布 instant_fixed（链接型）商品 → 用户购买 → 成功弹窗与订单详情显示可点击链接 →
  发起争议 → 商家驳回 → 状态恢复 delivered。
- Phase 2：文件商品全链路购买与下载。

## 8. 实施阶段

- **Phase 1**：schema 迁移（Product 三字段 + DeliveryRecord.contentType）、registry、
  createOrder 分支、状态机/低库存/争议逻辑泛化、商家表单、订单展示、测试。
- **Phase 2**：ProductFile 模型 + DeliveryRecord 文件快照四字段、上传扩展、鉴权下载端点、前端文件上传与下载按钮、测试。
- **Phase 3（暂缓，不承诺）**：账号池；文件限次/限期/下载日志；存储对象清理任务。
