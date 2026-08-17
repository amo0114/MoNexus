# Specify: 管理员平台商品发布闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `SPEC-ADMIN-PUB-001` |
| 版本 | `0.1.0` |
| 状态 | **Frozen for Implementation** |
| 日期 | `2026-08-17` |

## 1. 问题陈述

当前 XBoard confirm 正确地创建 `merchantId=null`、`status=draft` 的平台商品，后端也已经提供：

- `GET /api/admin/products/:id/readiness`；
- `POST /api/admin/products/:id/publish`；
- `POST /api/admin/products/:id/unpublish`。

但是管理员“商品与库存”页面没有展示商品状态，也没有 readiness、发布、重新上架或下架入口。
XBoard 导入成功后只刷新列表并关闭弹窗。结果是：

1. 管理员看到“导入成功”，但商品不会出现在商城；
2. 页面没有解释商品仍是草稿；
3. 页面没有提供下一步；
4. 唯一完成路径是人工调用管理员 API。

这是前端工作流未闭环，不是 XBoard 数据问题，也不是 draft 状态机错误。

### 1.1 编写基线证据

实施 Agent 应先点验这些锚点，不要重新猜测问题来源：

- `server/src/modules/admin/service.ts:1792-1809`：XBoard confirm 明确创建 `status:'draft'`、
  `merchantId:null`；
- `server/src/modules/admin/routes.ts:119-124`：admin readiness/publish/unpublish 路由已经存在；
- `server/src/modules/admin/controller.ts:67-90`：现有 readiness 和状态响应 DTO；
- `server/src/modules/catalog/productPublication.ts:51-99`：readiness 与 publish CAS 同事务；
- `src/pages/AdminPage.tsx:467-600`：列表有 XBoard 名额、库存和删除操作，但没有状态/发布动作；
- `src/pages/AdminPage.tsx:892-895`：XBoard import 回调目前只刷新列表；
- `src/components/catalog/AdminFakaImportPreview.tsx:222-245`：confirm 成功 toast 后关闭流程；
- `src/components/catalog/ProductPublicationChecklist.tsx:56-70`：当前组件把稳定码和 raw Offer ID
  投影到用户界面，需要在共享组件中修正；
- `src/api/admin.ts:105-189`：已有平台 create/inventory/delete/capacity adapter，但缺少产品列表和
  readiness/publish/unpublish adapter。

## 2. 目标与非目标

### 2.1 目标

1. XBoard 导入成功后，在同一任务上下文中进入权威发布检查。
2. 管理员能从商品列表识别草稿、已发布和已下架。
3. 管理员能发布平台草稿、重新上架平台商品和下架已发布平台商品。
4. 发布失败时保留草稿并给出可理解、可重试的信息。
5. 所有写操作使用既有管理员 API、Admin + MFA 鉴权和服务端 readiness gate。
6. 以组件、API contract 和真实 XBoard E2E 证据冻结闭环。

### 2.2 非目标

- 不自动发布 XBoard 商品。
- 不修改 Product 状态枚举、publishedAt、readiness 条件或 CAS 事务。
- 不修改 XBoard catalog、HMAC、sourceHash、幂等、SKU、capacity 或富文本净化。
- 不新增管理员商品编辑器，不解决所有 readiness 问题的编辑入口。
- 不允许管理员 UI 发布/下架商家所有的商品。
- 不修改订单、库存真相源、营销/精选/推广或商家发布流程。
- 不修改 schema、migration、生产配置或对象存储。
- 不在本卡重构 AdminLog。参见 `DEBT-APUB-001`。

## 3. 用户与任务

### 3.1 主要用户

通过 MFA 的平台管理员。

### 3.2 关键任务

1. 管理员预览并确认导入一个 XBoard 套餐。
2. 系统明确告知商品已保存为草稿，并自动执行发布检查。
3. 条件满足时，管理员点击“发布到商城”。
4. 条件不满足时，管理员看到人类可理解的待处理项，选择稍后处理。
5. 管理员回到商品列表后，可以再次打开发布检查。
6. 已发布平台商品可以下架；已下架平台商品可以重新上架。

## 4. 冻结产品决策

### 4.1 状态机保持不变

~~~text
XBoard confirm / 平台手工创建
              |
              v
            draft -- readiness pass + explicit publish --> active
              ^                                            |
              |                                            v
              +----- explicit republish <-------------- inactive
~~~

导入成功和发布成功是两个不同结果。界面不得把“导入成功”写成“已上架”。

### 4.2 可操作对象

| Product | 状态展示 | 管理员发布动作 |
| --- | --- | --- |
| `merchantId=null`, `draft` | 草稿 | 发布 |
| `merchantId=null`, `active` | 已发布 | 下架 |
| `merchantId=null`, `inactive` | 已下架 | 重新上架 |
| `merchantId!=null`, 任意状态 | 对应中文状态 | 无发布/下架按钮；显示“由商家管理” |

XBoard 商品通过 `merchantId=null` 和 FakaBridge Offer 识别；发布权限不依赖页面上的
“XBoard”徽标，服务端仍是最终权限和状态权威。

### 4.3 XBoard 导入后的连续流程

Confirm 成功后：

1. 保留成功创建的 Product；不得因为后续 readiness 请求失败而回滚或再次 confirm。
2. 刷新管理员商品数据。
3. 从导入表单切换到“商品已导入，准备发布”结果态，或无缝打开独立发布对话框。
4. 自动请求 `GET /api/admin/products/:id/readiness`。
5. ready 时主操作为“发布到商城”，次操作为“稍后处理”。
6. not ready 时发布按钮禁用，显示待处理项和“重新检查”；次操作仍为“稍后处理”。
7. readiness 网络失败时显示：
   “商品已导入并保存为草稿，发布检查暂时失败。可重试或稍后在商品列表继续。”
8. “稍后处理”关闭对话框，不调用 publish，也不删除草稿。

不得在 visible copy 中突出 Product ID。内部 test id、请求路径和日志可以继续使用 ID。

### 4.4 商品列表

“商品与库存”增加状态列或与商品名称同层的状态标记，必须在桌面和移动端可扫描：

- `draft` -> “草稿”；
- `active` -> “已发布”；
- `inactive` -> “已下架”；
- 未知值 -> “状态未知”，不得直接显示 raw value。

平台商品操作：

- 草稿：“发布”；
- 已下架：“重新上架”；
- 已发布：“下架”；
- 每行写操作有独立 loading/disabled guard，不阻塞其他行；
- 快速双击只允许一个请求；
- 成功后重新读取列表，不靠本地伪造最终状态。

商家商品不展示上述动作，避免平台管理员误替商家公开尚未准备的草稿。

### 4.5 发布检查

客户端每次打开发布对话框都请求服务端 readiness。不得使用列表中的封面、库存或状态自行计算。

| 稳定码 | 用户文案 | 可见的建议动作 |
| --- | --- | --- |
| `COVER_REQUIRED` | 需要为商品设置有效封面 | 稍后处理 |
| `CATEGORY_INACTIVE` | 当前商品分类已停用，请先更换或启用分类 | 可导航到目录治理时提供“前往目录治理” |
| `OFFER_NOT_SELLABLE` | “<规格名>”当前不可售 | XBoard 商品可提示检查套餐配置；即时库存商品使用既有导入库存入口 |
| `EXTERNAL_IDENTITY_INVALID` | XBoard 连接或套餐规格当前不可用，请检查平台连接配置 | 重新检查 |
| 未知码 | 发布条件尚未全部满足 | 重新检查 |

约束：

- 稳定码只允许存在于 `data-code` 和测试/日志中，不得成为 visible 或 accessible copy。
- 不显示 `field`、raw `offerId`、`merchantId`、`externalSku` 或 `null`。
- 如果无法将 offerId 映射到规格名，显示“有规格当前不可售”，不得显示数字 ID。
- ready 只由响应的 `ready` 决定；不得用 `issues.length === 0` 覆盖服务端的显式 false。

### 4.6 发布

点击“发布到商城”调用 `POST /api/admin/products/:id/publish`。

- 成功：关闭对话框，刷新列表，toast `“<商品名>”已发布到商城`。
- 422 `PRODUCT_NOT_READY`：保留对话框，把 `details[]` 投影为检查项，禁止成功 toast。
- 409：显示“商品状态已变化，请刷新后重试”，重新读取 readiness 和列表。
- 401/403/MFA：沿用全局认证处理，不降级到 merchant API，不重试写请求。
- 网络失败：保留对话框和草稿，恢复按钮，允许人工重试。

### 4.7 下架与重新上架

下架前必须确认：

> 下架后商品将从商城隐藏，已有订单和可售资源不会删除。确定下架吗？

确认后调用 `POST /api/admin/products/:id/unpublish`。取消不发请求。

- 成功 toast：`“<商品名>”已下架`；
- 重新上架必须重新走 readiness 对话框，不得直接切换 active；
- 页面不得声称删除库存、取消订单或撤销 XBoard 用户。

## 5. API 契约

### 5.1 前端适配器

`src/api/admin.ts` 新增并导出：

~~~ts
type AdminProductStatus = 'draft' | 'active' | 'inactive'

interface AdminProductReadiness {
  ready: boolean
  productId: number
  issues: Array<{
    code: string
    field: string
    offerId: number | null
  }>
}

interface AdminProductStatusResult {
  id: number
  status: AdminProductStatus
  publishedAt: string | null
}

getAdminProducts(): Promise<AdminProductListItem[]>
getAdminProductReadiness(productId: number): Promise<AdminProductReadiness>
publishAdminProduct(productId: number): Promise<AdminProductStatusResult>
unpublishAdminProduct(productId: number): Promise<AdminProductStatusResult>
~~~

固定路径：

| 方法 | 路径 |
| --- | --- |
| GET | `/admin/products` |
| GET | `/admin/products/:id/readiness` |
| POST | `/admin/products/:id/publish` |
| POST | `/admin/products/:id/unpublish` |

禁止调用 `/merchant/products/...`，禁止在前端直接写 `status`。

### 5.2 后端

本规格不要求修改后端生产代码。现有 admin route 的：

- `authenticate -> requireActiveUser -> requireAdmin -> requireAdminMfa`；
- readiness wire DTO；
- publish/unpublish 事务、CAS、publishedAt 和 cache invalidation；

均保持不变。如果实施中发现现有契约与本规格不一致，停止并报告，不得扩张 schema 绕过。

## 6. 可访问性与响应式

- 状态不能只用颜色表达，必须有中文文本。
- 对话框必须有可聚焦标题、关闭/取消动作和 loading 文案。
- disabled 按钮不得是唯一的问题说明来源。
- 发布、重新上架和下架使用 lucide 图标加明确文字；图标不得替代语义。
- 360px 宽度下状态和操作换行，不允许覆盖商品名、价格或库存。
- 请求期间布局尺寸稳定，不因 spinner 改变表格列宽。

## 7. 验收标准

| ID | Given / When / Then |
| --- | --- |
| AC-APUB-001 | Given XBoard confirm 成功；Then Product 保持 draft，界面立即进入发布检查，不再形成死路 |
| AC-APUB-002 | Given 导入成功；When readiness 尚未返回；Then 不自动调用 publish |
| AC-APUB-003 | Given admin product list；Then draft/active/inactive 显示为草稿/已发布/已下架 |
| AC-APUB-004 | Given merchantId!=null；Then 管理员列表不显示发布、重新上架或下架动作 |
| AC-APUB-005 | Given 平台草稿；When 打开发布；Then 先 GET readiness，再决定 CTA 是否可用 |
| AC-APUB-006 | Given ready=true；When 点击发布；Then 只调用 admin publish，成功刷新为已发布 |
| AC-APUB-007 | Given readiness issues；Then 显示人类文案/规格名，不显示稳定码、field 或 raw ID |
| AC-APUB-008 | Given publish 时发生 422；Then 保留草稿和对话框并展示最新 issues |
| AC-APUB-009 | Given 导入后选择稍后处理；Then 不调用 publish，列表仍可再次发布该草稿 |
| AC-APUB-010 | Given active 平台商品；When 取消下架确认；Then 不调用 unpublish |
| AC-APUB-011 | Given active 平台商品；When 确认下架；Then 刷新为已下架，文案不声称删除订单/资源 |
| AC-APUB-012 | Given inactive 平台商品；When 重新上架；Then 再次通过 readiness，不直接写 active |
| AC-APUB-013 | Given 快速双击任一写按钮；Then 同一商品只产生一个 in-flight 请求 |
| AC-APUB-014 | Given readiness 网络失败；Then 已导入草稿保留，用户可重试或稍后处理 |
| AC-APUB-015 | Given API adapter；Then 只使用 `/admin/products/...`，不调用 merchant 路径 |
| AC-APUB-016 | Given 360px 和桌面 viewport；Then 状态、名称和操作无重叠或截断 |
| AC-APUB-017 | Given 真实 XBoard fixture；When UI 导入并发布；Then admin API 返回 active，公开商品可见 |
| AC-APUB-018 | Given 完成实现；Then catalog-ops backend、frontend、XBoard E2E 和 quick gate 全绿 |

## 8. 已知债务

`DEBT-APUB-001`：现有 admin publish/unpublish controller 未把 `adminUserId` 传给 service，
共享 publication transaction 也未写 AdminLog。因此本规格不能声称管理员发布/下架已有 actor 审计。

这是安全治理债务，但不是本次“已有 API 缺前端入口”的修复前置。要补齐必须单独制定事务内
审计契约，不能在 UI 卡中用事务外 AdminLog 写入冒充原子审计。
