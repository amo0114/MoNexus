# Spec: 商品目录、分类治理与库存操作

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-CATALOG-OPS-001 |
| 版本 | 0.1.2 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| Owner | MoNexus Project Owner |
| 产品 | MoNexus |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| 配套文档 | [README.md](./README.md) · [plan.md](./plan.md) · [task.md](./task.md) · [implement.md](./implement.md) · [checklist.md](./checklist.md) |
| 跨规格契约 | [PAR-CMI-001](../2026-08-09-catalog-merch-identity-parallel-contract.md) |

---

## 1. 目的、现状与问题

### 1.1 目的

建立一套可以由平台治理、商家清晰操作、历史数据可迁移、Xboard 可幂等导入的商品目录系统，同时保留现有订单、Offer、库存、履约和敏感交付安全边界。

### 1.2 已核实基线

| 事实 | 基线位置 | 含义 |
| --- | --- | --- |
| `Product` 保存展示信息和兼容商业投影 | `server/prisma/schema.prisma` Product | Product 不是 SKU/库存真相源 |
| `Offer` 注释明确为价格、库存、履约真相源 | `server/prisma/schema.prisma` Offer | 所有库存操作必须绑定 Offer |
| `InventoryItem.offerId` 非空；content 在 product 级唯一 | schema / inventory migration | 即时库存是敏感交付单元，不能并入商品表单 |
| Product + 默认 Offer + 额外 Offer 已原子创建 | `merchant/service.ts:createMyProduct` | 不重建 SKU 模型，只改变草稿/发布和 UX |
| 商家即时库存已有 preview → import，管理员端仍直接导入 | merchant inventory modal / AdminPage | 复用后端预检并统一交互 |
| 分类是 `businessRegistry.productTypes` 中四个中文常量 | `server/src/lib/businessRegistry.ts` | 新增分类必须发版，平台无法治理 |
| Product.type 是裸 String，没有 categoryId | Prisma Product | 可兼容迁移，不是数据库 enum 限制 |
| 创建向导写明分类只影响展示；编辑 Modal 仍按分类切换 deliveryMode | 两个前端表单 | 当前语义矛盾，需冻结为“分类不驱动履约” |
| Xboard catalog、import schema 和 Product create 均无图片 | FakaBridge types/admin schema/service | 导入无图是契约缺失，不是偶发失败 |
| Xboard 每次直接 create Product；Offer externalSku 仅有 index | admin service / Offer schema | 重试和并发可产生重复 Product/Offer |
| 管理 UI 只有 Xboard 导入，没有手工平台商品向导 | `src/pages/AdminPage.tsx` | 平台自营发布能力不完整 |

### 1.3 根因

当前系统已完成 SKU/Offer 和库存安全基础，但目录治理仍停留在早期形态：分类由部署代码控制；Product 创建默认 active；媒体不是发布前置；外部目录没有稳定身份；“创建商品”表单混入可售量配置，而秘密库存又必须发布后另行导入。这使商家难以理解操作边界，也让管理员无法可靠扩展分类或导入完整商品。

### 1.4 成功标准

1. 商家和管理员创建的新商品先成为 draft，任何秘密库存都不进入商品创建请求。
2. 所有可售量变化走 Offer-scoped inventory/capacity API 并留下 InventoryLog。
3. 平台可新增、排序、停用分类；商家可申请，审核有状态、理由和 AdminLog。
4. 新建商品用稳定 categoryId；分类改名不改变历史 Product.type snapshot 或订单快照。
5. Xboard 同一 plan 的重复/并发 confirm 最终只产生一个 Product 和唯一 external SKU Offers。
6. Xboard 商品在发布前必有平台托管封面或分类默认封面。
7. 管理员可手工创建 `merchantId=null` 的平台商品并使用同一 Offer/库存/发布规则。
8. 迁移不丢历史商品、Offer、InventoryItem、Order 或 InventoryLog；空库和升级库都可重放。

---

## 2. 范围

### 2.1 范围内

- Product draft/inactive/active 发布状态与 readiness gate；
- 商品创建、编辑、发布和库存/名额操作的 UI 分离；
- Offer-first 库存选择、preview/import/void/capacity adjustment；
- 动态 ProductCategory、管理员 CRUD/排序/停用；
- CategoryApplication 商家申请、撤回、管理员批准/映射/拒绝；
- legacy Product.type → categoryId 迁移及兼容窗口；
- 管理员手工平台商品创建；
- Xboard import preview/confirm、封面策略、富文本净化、external identity 与幂等；
- 公开 category registry、筛选和 Product category DTO；
- migration、审计、缓存失效、回归和发布/回滚资产。

### 2.2 明确范围外

- 自然热卖算法、推广排序、平台精选、合作伙伴和 badge；由 SPEC-MERCH-001 负责；
- 法币支付、广告预算、CPM/CPC；
- AI 同步生成商品封面；P0 只允许上传资产或平台默认封面；
- 多级分类树、品牌、属性模板、Tag、多语言分类；
- 新的 deliveryMode、订单状态机或 InventoryItem secret 结构；
- 改变退款、结算、低库存通知语义；
- 向商家/管理员推送分类审核通知；
- 物理删除历史分类或重写历史订单快照；
- 全站 TanStack Query 迁移。

---

## 3. 术语

| 术语 | 定义 |
| --- | --- |
| Catalog Product | 面向买家展示的 Product 容器 |
| Offer | 可购买 SKU；价格、库存、履约真相源 |
| Inventory Item | instant_inventory 的一个敏感交付单元 |
| Capacity | instant_fixed/manual_service limited Offer 的数字可售名额 |
| Draft | 尚未通过发布门禁、公开 API 不可见的 Product |
| Category code | 不随展示名改变的稳定 ASCII 标识 |
| Type snapshot | Product.type 中创建/归类时冻结的分类展示名 |
| External identity | provider + externalProductId / externalSku 的稳定唯一身份 |
| Preview | 只读校验和规范化结果，不产生 Product/Offer/库存 |
| Confirm | 重新验证 preview hash 后执行的幂等写事务 |

---

## 4. 冻结决策

| ID | 决策 |
| --- | --- |
| D-CAT-01 | Offer 是价格、库存、履约真相源；Product.price/stock/deliveryMode 等继续由既有同步函数维护为投影 |
| D-CAT-02 | `POST merchant/admin products` 只创建 Product + Offers，默认 status=draft，不导入 InventoryItem、不调用 capacity adjustment |
| D-CAT-03 | 发布是独立、原子、服务端权威 action；客户端“看起来完整”不能绕过 readiness |
| D-CAT-04 | Product status 扩展为 `draft|active|inactive`；draft=从未发布，inactive=已发布后下架；首次发布记录 publishedAt |
| D-CAT-05 | 分类只承担展示、检索、运营排序，不限制 deliveryMode 或交付字段结构 |
| D-CAT-06 | ProductCategory 使用稳定 code；label/icon/defaultCover 可改，code 创建后不可改 |
| D-CAT-07 | 分类只允许 active/inactive；被 Product 或申请引用时禁止物理删除 |
| D-CAT-08 | Product 新增 categoryId，并长期保留 type 作为 label snapshot；分类改名不批量重写 type |
| D-CAT-09 | 新写路径由服务端从 category.label 派生 type；客户端不得同时提交 categoryId 与任意 type |
| D-CAT-10 | 商家分类申请只有 pending 能 approve/reject/withdraw；批准可以 create_new 或 map_existing |
| D-CAT-11 | 审核事务同时更新申请、必要时创建分类并写 AdminLog；重复审核使用状态 CAS |
| D-CAT-12 | instant_inventory 只允许 preview/import/void；非 instant limited 只允许 capacity adjustment；所有操作显式 Offer ID |
| D-CAT-13 | 未传 offerId 只保留单 SKU/默认 Offer 兼容；新 UI 和新 API fixture 必须显式传 offerId |
| D-CAT-14 | `voidMyInventory` 返回目标 Offer availableStock；Product 汇总库存另名返回，禁止混为 `stock` |
| D-CAT-15 | 管理员库存导入升级为与商家一致的 preview → confirm，不保留直接盲导入 UI |
| D-CAT-16 | Xboard preview 不写数据库；confirm 必须重取 source、核对 sourceHash、封面和 external identity |
| D-CAT-17 | Xboard P0 不抓远程图片；封面只可来自平台注册公共 StoredObject 或 ProductCategory.defaultCoverUrl |
| D-CAT-18 | Xboard richDescription 在服务端 allowlist 净化，删除 script/style/event handler/危险 URL/远程 img；前端再 DOMPurify |
| D-CAT-19 | `ExternalCatalogLink(provider, externalProductId)` 与 Offer `(externalIntegration, externalSku)` 使用数据库唯一约束 |
| D-CAT-20 | 同一 Idempotency-Key + 同一 requestHash 重放返回原 Product；相同 key 不同 hash 返回 409；同 external identity 不同 key 返回已存在资源冲突 |
| D-CAT-21 | 平台手工商品使用同一 draft/publish/Offer/库存 API，publisher 由 admin auth 推导为 merchantId=null |
| D-CAT-22 | legacy active/inactive 商品原状态不变；已发布商品可保留 inactive 分类，新的首次发布必须使用 active 分类 |
| D-CAT-23 | 公开列表只返回 active；draft/inactive 不因直接猜 ID 通过公开详情泄露 |
| D-CAT-24 | 本规格不新增或修改通知事件；审核结果在 UI/REST 中查询 |

---

## 5. 目标数据模型

字段名为冻结的逻辑契约；Prisma 关系名可在不改变外部语义时调整。

### 5.1 ProductCategory

~~~text
ProductCategory
  id                Int PK
  code              String UNIQUE, ^[a-z][a-z0-9_-]{1,63}$, immutable
  label             String, 1..50 Unicode code points
  normalizedLabel   String, lower/trim canonical, UNIQUE
  description       String?, <=500
  iconKey           String?, <=64
  defaultCoverUrl   String?, platform public asset only
  sortOrder         Int, default 0
  status            active | inactive
  createdByUserId   Int
  updatedByUserId   Int
  createdAt         DateTime
  updatedAt         DateTime
~~~

规则：

- code 不复用；停用后也不能被另一分类占用。
- defaultCoverUrl 只能指向平台注册公共对象或仓库静态资源。
- 排序为 `sortOrder ASC, id ASC`。
- 不包含 allowedDeliveryModes；分类不得成为履约 schema 开关。

### 5.2 CategoryApplication

~~~text
CategoryApplication
  id                  Int PK
  merchantId          Int
  proposedLabel       String 1..50
  normalizedLabel     String
  proposedCode        String?（仅建议，平台可调整）
  description         String 20..1000
  exampleProducts     String? <=1000
  status              pending | approved | rejected | withdrawn
  resolution          create_new | map_existing | null
  approvedCategoryId  Int?
  reviewedByUserId    Int?
  reviewedAt          DateTime?
  reviewReason        String? 1..500
  createdAt           DateTime
  updatedAt           DateTime
~~~

规则：同一 merchant + normalizedLabel 同时最多一条 pending；商家只能读自己的申请、创建和撤回 pending；管理员能读全部并审核。

### 5.3 Product 增量

~~~text
Product
  categoryId   Int FK ProductCategory ON DELETE RESTRICT
  type         String  # 历史 label snapshot，继续公开兼容
  status       draft | active | inactive
  publishedAt DateTime?
~~~

新写入必须有 categoryId。首次 active 时写 publishedAt；后续下架/重上架不改首次时间。

### 5.4 ExternalCatalogLink

~~~text
ExternalCatalogLink
  id                 Int PK
  provider           String  # P0 固定 faka_bridge
  externalProductId  String  # Xboard plan_id canonical decimal string
  productId          Int UNIQUE
  sourceHash         String  # normalized source SHA-256
  sourceSnapshot     Json    # allowlist metadata，不含 secret/HTML 原文
  idempotencyKey     String
  requestHash        String
  importedByUserId   Int
  createdAt          DateTime
  updatedAt          DateTime
  UNIQUE(provider, externalProductId)
  UNIQUE(provider, idempotencyKey)
~~~

Offer 增加数据库唯一 `(externalIntegration, externalSku)`；externalSku 入库前 trim + lowercase canonical。PostgreSQL 允许多条 `(NULL,NULL)`，不影响普通 Offer。

`Idempotency-Key` 的 P0 作用域固定为“`/api/admin/faka/import` confirm endpoint × provider”，不按管理员 userId 分区；因此另一管理员重试同一导入也能得到原结果。相同 key 可由未来不同 provider 独立使用。header 在 OWS trim 后必须匹配 `[A-Za-z0-9._:-]{1,128}`，服务端按原值保存，不做大小写折叠。

---

## 6. 商品状态机与发布门禁

~~~text
create ─► draft
           ├─ edit catalog / offers
           ├─ import inventory or adjust capacity（独立审计写）
           └─ publish readiness pass ─► active

active ── unpublish ─► inactive ── publish readiness pass ─► active
draft  ── abandon/delete（仅无订单、无 sold item）
~~~

### 6.1 Readiness

所有条件由服务端同一事务中的权威读取判断：

1. name/description/category/media 符合 schema；
2. 首次发布 category.status=active；历史已发布商品可保留其 inactive category；
3. `images[0]` 与 `imageUrl` canonical cover 一致且非空；
4. 至少一个 active Offer；每个 active Offer 的商业/履约配置有效；
5. 至少一个 active Offer 当前 sellable：
   - instant_inventory：存在至少一条该 Offer 的 available InventoryItem；
   - instant_fixed unlimited：fixed content/file 完整；
   - instant_fixed limited：stock > 0 且 fixed content/file 完整；
   - manual_service unlimited：人工/自动/Faka 配置完整；
   - manual_service limited：配置完整且 stock > 0；
6. 外部集成 Offer 的 external identity 唯一且 provider 配置校验通过；发布事务不执行远程网络调用，只检查最近一次本地校验结果仍有效。

失败返回 422：

~~~json
{
  "error": {
    "code": "PRODUCT_NOT_READY",
    "message": "商品尚未满足发布条件",
    "details": [
      { "code": "COVER_REQUIRED", "field": "images", "offerId": null },
      { "code": "OFFER_NOT_SELLABLE", "field": "offers", "offerId": 42 }
    ]
  }
}
~~~

客户端不得把 details 文案作为稳定机器码；稳定码是 `details[].code`。

### 6.2 创建与可售量分离

- Product create 请求不接受 InventoryItem content。
- 新 create 请求的 limited Offer 初始 stock 固定 0；旧兼容字段 stock 在服务端忽略并记录 deprecated metric，compat window 后返回 400。
- 向导保存 draft 后进入“可售量”步骤，调用现有 inventory/capacity API；失败只保留 draft，不回滚已保存的目录信息。
- 库存和容量日志的 actor、Offer、delta、reason/batch 语义保持不变。

---

## 7. 分类 API 与兼容契约

### 7.1 公共 Registry

`GET /api/config/registry` 增加：

~~~json
{
  "productCategories": [
    { "id": 1, "code": "network-node", "label": "网络节点", "iconKey": "network", "sortOrder": 10 }
  ],
  "productTypes": [
    { "value": "网络节点", "label": "网络节点", "deprecated": true }
  ],
  "deliveryModes": []
}
~~~

- public 只返回 active categories。
- `productTypes` 保留一个滚动兼容窗口，来自 DB category label，不再来自 hard-coded registry。
- 新 frontend 使用 categoryId/code；旧 frontend 的 type 由后端映射 active category label。

### 7.2 管理员分类

~~~text
GET    /api/admin/product-categories?status=&page=&pageSize=
POST   /api/admin/product-categories
PATCH  /api/admin/product-categories/:id
POST   /api/admin/product-categories/:id/activate
POST   /api/admin/product-categories/:id/deactivate
POST   /api/admin/product-categories/reorder
~~~

- code 创建后不可 PATCH。
- deactivate 不改 Product；公开筛选仍能通过已有 Product DTO 显示 label snapshot，但新选择列表不返回。
- 每个 mutation 写 AdminLog，detail 只写字段名/状态，不写富文本全文。

### 7.3 商家申请与管理员审核

~~~text
GET    /api/merchant/category-applications
POST   /api/merchant/category-applications
POST   /api/merchant/category-applications/:id/withdraw

GET    /api/admin/category-applications?status=&merchantId=&page=&pageSize=
POST   /api/admin/category-applications/:id/approve
POST   /api/admin/category-applications/:id/reject
~~~

approve body 二选一：

~~~json
{ "resolution": "create_new", "category": { "code": "cloud-tool", "label": "云工具", "description": "...", "iconKey": "cloud" }, "reviewReason": "符合平台目录" }
~~~

~~~json
{ "resolution": "map_existing", "categoryId": 12, "reviewReason": "已存在等价分类" }
~~~

审核使用 `where id + status=pending` CAS；第二次审核返回 409 `CATEGORY_APPLICATION_ALREADY_REVIEWED`。

### 7.4 商品写/读

- 新 create/update body 使用 `categoryId`。
- 若同时传 type，返回 400 `LEGACY_TYPE_WITH_CATEGORY_ID`；旧客户端只传 type 时在兼容窗口映射。
- public/merchant/admin Product DTO 增加：

~~~json
"category": { "id": 1, "code": "network-node", "label": "网络节点" },
"type": "网络节点"
~~~

- public list 首选 `categoryCode`；兼容 `category=<legacy label>` 一个窗口。
- inactive category 的已有商品仍返回 category DTO，防止历史解释丢失。

---

## 8. Offer-first 库存契约

### 8.1 UI 动作词

| Offer 形态 | 唯一主要动作 |
| --- | --- |
| instant_inventory | 导入交付库存 / 作废交付库存 |
| instant_fixed limited | 调整可售名额 |
| manual_service limited | 调整服务名额 |
| 任意 unlimited | 无补库存动作 |

多 Offer 商品先选择 Offer，再显示动作；不得用 Product.stock 作为操作对象。

### 8.2 Preview/confirm

- Merchant/Admin instant inventory 都先 preview；confirm 服务端重新运行全部校验。
- 单次 1000 行、单项 5000 字符、总 500k、结构化字段与重复校验沿用现有限制。
- Preview 永不回显已存在 InventoryItem.content；结构化敏感字段预览继续遮蔽。
- confirm 并发唯一冲突整体回滚并返回稳定重复详情。

### 8.3 Void response

~~~json
{
  "offerId": 42,
  "voided": 3,
  "availableStock": 7,
  "productAvailableStock": 19
}
~~~

`availableStock` 只统计目标 Offer；旧含混的 `stock` 字段在兼容窗口等于 offer availableStock 并标记 deprecated，随后删除。

---

## 9. Xboard import

### 9.1 Preview

`POST /api/admin/faka/import/preview`

请求包含 planId、选择的 period/SKU/价格/有效期、productName、categoryId、cover choice。服务端读取远端 catalog 并返回：

- normalized plan/offer rows；
- sourceHash；
- period/SKU 重复与数据库冲突；
- capacity 可用性摘要；
- category/default cover 结果；
- sanitized description/richDescription preview；
- `canConfirm` 与结构化 issues；
- 不返回 Xboard credential、远端内部错误正文或任意对象 key。

Preview 不创建 Product/Offer/ExternalCatalogLink/AdminLog。

### 9.2 Cover choice

二选一：

~~~json
{ "mode": "uploaded", "imageUrl": "/uploads/<content-hash>.webp", "images": ["/uploads/<content-hash>.webp"] }
~~~

~~~json
{ "mode": "category_default" }
~~~

Confirm 时服务端再次验证 Uploaded URL 对应 active StoredObject；category_default 将当前 defaultCoverUrl 复制进 Product，之后分类换图不隐式改变历史商品。

P0 禁止 coverMode=remote_url 或 ai_generate。未来若抓远程图，必须另立 SSRF/版权/对象存储规格。

### 9.3 Confirm 和幂等

`POST /api/admin/faka/import` 必须带 `Idempotency-Key` header 与 preview 的 sourceHash。

`requestHash` 在 strict schema 校验和字段规范化后计算：将 confirm DTO（provider、canonical planId/sourceHash、productName、categoryId、cover choice、按请求顺序保留的 normalized offers）递归按 object key 字典序排列、保留 array 顺序，以 UTF-8 JSON 编码后取 SHA-256 lowercase hex；header 本身、actor、credential、远端 HTML 原文不进入 hash。未知字段拒绝，不能靠“hash 未覆盖”静默忽略。实现必须用共享 canonicalizer 和冻结 fixture，不能由 preview/confirm 各写一套。

1. 重新获取并规范化 source；hash 不同返回 409 `FAKA_SOURCE_CHANGED`，要求重新 preview。
2. 校验 requestHash、cover、category、SKU unique。
3. 同一事务创建 draft Product、Offers、ExternalCatalogLink、AdminLog。
4. unique conflict 时读取已存在 link：同 key+hash 返回原结果并标 `replayed=true`；其他情况返回 409 并带 existingProductId。
5. Product 不自动发布；管理员完成 readiness 后显式 publish。

### 9.4 富文本

服务端 allowlist 只保留基础段落、列表、强调、标题和安全站内/https link；删除 script/style/iframe/object/form、所有 `on*` 属性、`javascript:`/`data:` URL 和全部远程 img。存储的是净化结果，详情页 DOMPurify 再净化。

---

## 10. 管理员手工平台商品

管理员 UI 新增“新建平台商品”，复用目录/Offer/媒体/可售量子组件，但：

- actor 由 Admin auth/MFA 获取；请求不接受 merchantId；
- server 固定 merchantId=null；
- 默认 draft，不自动获得 hot/精选/推广；
- 发布门禁与商家商品相同；
- Product/Offer create 与 AdminLog 同一事务；
- UI 文案为“平台商品”，视觉“平台自营”由 SPEC-MERCH-001 projection 决定。

---

## 11. 迁移契约

### 11.1 Preflight

迁移前只读报告必须列出：

- Product.type distinct/count；
- null/空 type；
- externalIntegration+normalized externalSku 重复组；
- Product 无 Offer、多个 default Offer、Offer 投影漂移；
- imageUrl/images 不一致；
- active 无图商品数量。

任何 external SKU 重复、无默认 Offer 或无法解释的 type 都必须先由 Owner 选择修复策略；migration 不静默删/合并。

### 11.2 数据迁移

1. 创建四个 active category 与一个 inactive `legacy-unclassified`。
2. Product.type 精确匹配四类时回填对应 category；未知/空回填 legacy-unclassified，type 原值保留，空值写“待归类”仅作为 snapshot 修复并记录计数。
3. 添加 publishedAt：legacy active/inactive 使用 createdAt；draft 为空。
4. 添加 ExternalCatalogLink/约束前先运行 duplicate preflight。
5. categoryId 初始 nullable → 回填 → 验证零 null → 设置 NOT NULL（由 `F0` Foundation Owner 在 Foundation schema tip 完成；禁止最终 nullable、DB default/trigger 或把收紧推迟给业务 lane）。
6. 扩展 Product status CHECK，不重写 legacy active/inactive。

### 11.3 兼容发布

后端先发布并同时支持 old type/new categoryId；迁移完成后发布新前端；观察一个兼容窗口后移除旧写路径。公开 type 字段本规格不计划删除。

---

## 12. 不变量

| ID | 不变量 |
| --- | --- |
| CAT-001 | Offer 永远是商业/库存/履约真相源，Product 只作投影 |
| CAT-002 | InventoryItem.content 不得进入商品、分类、preview 日志或公开 DTO |
| CAT-003 | 新 Product create 不改变 InventoryItem 或 capacity |
| CAT-004 | 所有库存/容量 mutation 必须绑定 Offer、actor 和审计记录 |
| CAT-005 | instant inventory 不能使用 capacity adjustment；非 instant 不能导入 InventoryItem |
| CAT-006 | 可售量不得因并发调整降为负数 |
| CAT-007 | draft/inactive 不得出现在公开列表/详情/checkout |
| CAT-008 | 只有服务端 publish action 能把商品设为 active |
| CAT-009 | 分类不决定 deliveryMode、purchaseForm 或 deliveryFields schema |
| CAT-010 | category code 不可变、不复用；被引用分类不物理删除 |
| CAT-011 | Product.type 是历史 label snapshot，分类 rename 不批量改写 |
| CAT-012 | 只有 active category 可用于新商品首次发布 |
| CAT-013 | 商家不能创建/启停正式分类或审核自己的申请 |
| CAT-014 | 分类审核状态只能单向从 pending 进入终态；重复动作不产生第二分类 |
| CAT-015 | Xboard preview 零业务写入；confirm 重验 source/cover/unique |
| CAT-016 | 同 external plan 和 external SKU 在数据库层最多一个权威映射 |
| CAT-017 | Xboard P0 不抓任意远程 URL、不把远程 img 保存进 richDescription |
| CAT-018 | 管理员平台商品的 merchantId 由服务端固定为 null |
| CAT-019 | legacy 数据迁移不删除 Product/Offer/InventoryItem/Order/InventoryLog |
| CAT-020 | 本规格不修改订单状态机、通知事件或敏感交付授权 |

---

## 13. 功能需求

| ID | 需求 |
| --- | --- |
| REQ-CAT-F-001 | 创建商家/平台商品时原子创建 draft Product 与 Offers |
| REQ-CAT-F-002 | 独立 publish/unpublish action 实施服务端 readiness gate |
| REQ-CAT-F-003 | 向导把目录、Offer、可售量、发布拆成可恢复步骤 |
| REQ-CAT-F-004 | 即时库存和数字 capacity 通过 Offer-scoped 独立工作台管理 |
| REQ-CAT-F-005 | Merchant/Admin 库存导入都提供 preview、confirm、重复/结构错误反馈 |
| REQ-CAT-F-006 | 作废 response 与库存 UI 准确展示目标 Offer 和 Product 汇总 |
| REQ-CAT-F-007 | 管理员能 CRUD/reorder/activate/deactivate 动态分类并审计 |
| REQ-CAT-F-008 | 商家能创建、查看、撤回分类申请，管理员能批准/映射/拒绝 |
| REQ-CAT-F-009 | Registry 和 Product API 提供稳定 category DTO 与 legacy type 兼容 |
| REQ-CAT-F-010 | Store 能按 category code 筛选，分类变化重置 cursor/list state |
| REQ-CAT-F-011 | 管理员能手工创建、补库存并发布平台商品 |
| REQ-CAT-F-012 | Xboard 提供无写 preview、封面选择、source-change 检测与幂等 confirm |
| REQ-CAT-F-013 | Xboard rich content 服务端净化，媒体只用平台资产 |
| REQ-CAT-F-014 | ExternalCatalogLink 与 Offer external identity 数据库唯一 |
| REQ-CAT-F-015 | legacy type/category/status/media 数据安全回填并可审计 |

---

## 14. 非功能需求

| ID | 需求 |
| --- | --- |
| REQ-CAT-NF-001 | 库存并发安全、订单单事务与现有 checkout 不变量不得退化 |
| REQ-CAT-NF-002 | 分类列表 P95 ≤300ms（本地生产等价 DB、无冷启动），普通商品列表性能不劣化超过 10% |
| REQ-CAT-NF-003 | Preview 单次 1000 行在正常本地对象/DB 条件下 P95 ≤2s，不含 Xboard 网络时间 |
| REQ-CAT-NF-004 | 所有新 mutation 使用 active/auth/MFA/merchant ownership 现有边界 |
| REQ-CAT-NF-005 | API/log/AdminLog 不泄露 InventoryItem content、Xboard credential、对象 key 或富文本危险内容 |
| REQ-CAT-NF-006 | migration 必须在空库和 legacy fixture 库重放，无 drift、无数据静默丢失 |
| REQ-CAT-NF-007 | old frontend + new backend、新 frontend + new backend 滚动兼容 |
| REQ-CAT-NF-008 | 所有 cache 在 category/product/publish/inventory mutation 后正确失效 |
| REQ-CAT-NF-009 | Catalog 实施不修改 notification realtime owned files/worktree |
| REQ-CAT-NF-010 | 前后端 build、既有商品/Offer/库存/Xboard E2E 和新增 suite 全绿 |

---

## 15. 验收标准

| ID | Given / When / Then |
| --- | --- |
| AC-CAT-001 | Given 商家完成目录/Offer；When 保存；Then 只创建 draft Product+Offers，公开 API/checkout 均不可见且无 InventoryItem/容量日志 |
| AC-CAT-002 | Given draft 缺封面/分类/可售 Offer；When publish；Then 422 返回稳定 readiness codes，状态仍 draft |
| AC-CAT-003 | Given draft 完整且至少一 Offer 可售；When publish；Then 原子 active、publishedAt 首次写入、公开列表/详情可见 |
| AC-CAT-004 | Given active 商品；When unpublish；Then 新 checkout 不可购买，库存/历史订单/日志不删除；再次通过门禁可 active |
| AC-CAT-005 | Given 多 Offer；When 管理库存；Then 必须先选 Offer，instant 与 capacity 动作互斥 |
| AC-CAT-006 | Given preview 有重复/模板错误；When confirm；Then 整体拒绝、零 InventoryItem/Log 新增 |
| AC-CAT-007 | Given 两个并发 capacity 减少；When 总减少超余额；Then 最多一个成功且 stock 永不负 |
| AC-CAT-008 | Given 作废 Offer A 三项且 Product 还有 Offer B；Then response availableStock 只属 A，productAvailableStock 为 A+B |
| AC-CAT-009 | Given admin 与 merchant 导入同一 fixture；Then preview/confirm 错误与统计语义一致，权限各自隔离 |
| AC-CAT-010 | Given admin 创建分类；Then registry/选择器按 sortOrder 出现，code 后续不可改 |
| AC-CAT-011 | Given 分类被商品引用；When deactivate/delete；Then deactivate 成功、物理 delete 被拒，历史商品仍有 category/type |
| AC-CAT-012 | Given 商家 pending 申请；When withdraw；Then 终态 withdrawn，管理员不能再批准 |
| AC-CAT-013 | Given 两管理员并发 approve；Then 状态 CAS 只允许一个成功，只创建/映射一个分类并写一次有效审核结果 |
| AC-CAT-014 | Given approve map_existing；Then 不创建重复 Category，申请指向已有 categoryId |
| AC-CAT-015 | Given category label 改名；Then category DTO 显示新 label，已有 Product.type/订单快照不变 |
| AC-CAT-016 | Given legacy old frontend 只提交 type；Then兼容窗口内后端映射；type+categoryId 同传被拒 |
| AC-CAT-017 | Given category filter 切换；Then list/cursor/scroll cache 按新 code 重置，无旧分类商品混入 |
| AC-CAT-018 | Given Xboard plan 无图；When preview 选 category_default；Then preview 有 canonical cover，confirm 创建有图 draft |
| AC-CAT-019 | Given uploaded cover 未登记/已禁用；When confirm；Then 422，零 Product/Offer/link |
| AC-CAT-020 | Given Xboard source preview 后改变；When confirm old sourceHash；Then 409 FAKA_SOURCE_CHANGED，要求重 preview |
| AC-CAT-021 | Given 同 key/hash 重放 confirm；Then 返回同 Product 且 replayed=true；同 key不同 hash 409 |
| AC-CAT-022 | Given 两个 key 并发导入同 plan/SKU；Then DB 最终一 Product/link/Offer identity，失败方得到 existingProductId |
| AC-CAT-023 | Given Xboard content 含 script/onerror/javascript/remote img；Then存储和响应均无危险节点/URL，纯文本摘要可读 |
| AC-CAT-024 | Given admin 手工创建平台商品；Then merchantId=null、默认 draft、无热卖/精选自选字段，并遵守同一发布/库存门禁 |
| AC-CAT-025 | Given legacy fixture 含四类、未知 type、无图 active、多 Offer/Xboard Offer；When migrate deploy；Then零数据丢失、categoryId全回填、状态不变、未知归待归类 |
| AC-CAT-026 | Given 分类/商品/publish/库存 mutation；Then public/merchant/admin cache 在定义窗口内失效，不需重启进程 |
| AC-CAT-027 | Given Catalog 分支与通知分支并行；Then Catalog diff 不包含 notification realtime owned files，通知回归全绿 |
| AC-CAT-028 | Given empty DB 与 upgraded DB；Then migrate deploy/status/diff、数据库 constraints、build 和全部回归通过 |

---

## 16. 风险与处理

| 风险 | 处理 |
| --- | --- |
| legacy type 值不在四类 | preflight + inactive legacy-unclassified；保留原 type snapshot |
| active 无图商品被新门禁影响 | grandfather existing status；公开展示使用 category default fallback，后台列入修复队列 |
| dynamic category 查询增加列表 join | categoryId/index、select allowlist、性能基线与 cache regression |
| 两套分类参数造成兼容歧义 | categoryId 与 type 禁止同传；兼容期监控 legacy usage 后移除旧写 |
| Xboard 网络在 confirm 期间变化 | DB 写前重取+sourceHash；不在 DB transaction 内做远程调用 |
| 并发重复导入 | ExternalCatalogLink + Offer DB unique，冲突读取已有资源 |
| sanitizer 改变套餐排版 | preview 展示净化结果；保留 plain description；不存危险原文到 Product |
| draft/status 扩展影响 checkout | public/service/checkout 均明确只接受 active，并做数据库约束回归 |
| Catalog/Merch 同改共享文件 | 强制 PAR-CMI-001 F0 Foundation Owner/B_CAT/CMI Integration Owner，其他 lane adapter-only |

---

## 17. 假设与 Owner 待核实项

- PostgreSQL 版本支持当前 migration/partial index 惯例。
- P0 Xboard 可在 confirm 时重新读取 catalog；若 provider 无稳定响应，需要新增 snapshot TTL 决策。
- ProductCategory.defaultCoverUrl 的初始四张资产由平台在实施前准备；缺失时该分类不能作为 Xboard default cover。
- 本规格建议保留管理员“无订单硬删除”既有语义，但新增 category/external link 关系必须在同事务安全清理；是否长期保留已删除 Product 的审计另立治理规格。

---

## 18. Owner 批准记录

- [x] O-CAT-01~11 已逐项批准。
- [x] PAR-CMI-001 已批准。
- [x] 六份文档状态已统一切换为 Frozen for Implementation。

批准人：MoNexus Project Owner；批准日期：2026-08-09。

Owner 已于 2026-08-09 批准本规格与 PAR-CMI-001。实施证据仍只能在对应 Gate 真实满足后填写；不得预填 migration 或业务 Gate。

---

## 19. 需求追溯矩阵

| 需求 | Plan | Tasks | Implement | Checklist | 验收 |
| --- | --- | --- | --- | --- | --- |
| REQ-CAT-F-001~003 | Phase C/D | T-CAT-BE-003、T-CAT-FE-001 | I-CAT-004、008 | CHK-PROD-001~006 | AC-CAT-001~004 |
| REQ-CAT-F-004~006 | Phase C/E | T-CAT-BE-004、T-CAT-FE-002 | I-CAT-005、009 | CHK-INV-001~009 | AC-CAT-005~009 |
| REQ-CAT-F-007~010 | Phase B/F | T-CAT-BE-001~002、T-CAT-FE-003、T-CAT-INT-001 | I-CAT-002~003、010、012 | CHK-CAT-001~012 | AC-CAT-010~017 |
| REQ-CAT-F-011 | Phase D/F | T-CAT-BE-003、T-CAT-FE-004 | I-CAT-004、011 | CHK-PROD-001～003、CHK-PROD-010、CHK-UI-006 | AC-CAT-024 |
| REQ-CAT-F-012~014 | Phase E | T-CAT-BE-005、T-CAT-FE-004 | I-CAT-006、011 | CHK-XBD-001~010 | AC-CAT-018~023 |
| REQ-CAT-F-015 | Phase A/G | T-FND-001（F0）、T-CAT-BCAT-001（B_CAT）、T-CAT-QA-001 | I-CAT-001、I-CAT-BCAT、013 | CHK-MIG-001~008 | AC-CAT-025、028 |
| REQ-CAT-NF-001～005 | All | BE/FE/QA owners | I-CAT-002～014 | CHK-SEC-001～004、CHK-PERF-001～003、CHK-OPS-001～002、CHK-QA-001～005 | AC-CAT-005～009、023、026 |
| REQ-CAT-NF-006～010 | Phase G/H | T-CAT-QA-001～003 | I-CAT-013～015 | CHK-MIG-001～008、CHK-QA-001～006、CHK-REL-001～004、CHK-CAT-FINAL-001～005 | AC-CAT-025～028 |

---

## 20. 变更控制

1. Draft 修改须同步版本、README Owner decisions、Plan、Tasks、Implement、Checklist 和 PAR-CMI-001。
2. Frozen 后改变 D-CAT、CAT、REQ、AC、migration/backfill、API status/code 或发布门禁，须退回 Draft。
3. 实施中只能在 implement Evidence Ledger 记录不改变外部语义的澄清。
4. develop 或通知分支改变共享文件时，实施前做 delta audit；不得静默沿用旧 line/path。
5. Owner 于 2026-08-09 批准 v0.1.1 唯一修订：CMI Foundation DAG 改为 `S→A_CMI→F0→B_CAT→F`；只修执行 DAG/ownership/Gate，不改 D-CAT/CAT/REQ/AC/API/积分/展示。

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-09 | Frozen for Implementation | Owner 批准：draft/publish、动态分类、Offer-first 库存、平台商品、Xboard media/idempotency |
| 0.1.1 | 2026-08-09 | Frozen for Implementation | Owner 批准唯一修订：CMI Foundation DAG 改为 S→A_CMI→F0→B_CAT→F；categoryId 最终 NOT NULL 标 `F0` 归属 |
| 0.1.2 | 2026-08-13 | Frozen for Implementation | Owner 批准 QA 收口修订（AMD-CMI-012）：证据规则对齐 testing-policy；QA 卡收敛；T-MERCH-ASSET-001 拆出本次交付 |
