# Plan: 管理员平台商品发布闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `PLAN-ADMIN-PUB-001` |
| 输入 | [spec.md](./spec.md) |
| 状态 | **Frozen for Implementation** |

## 1. 实现策略

采用前端闭环、后端契约复用：

1. 给 `src/api/admin.ts` 补齐 typed admin product/readiness/publish/unpublish adapter。
2. 新建可复用 `AdminProductPublicationDialog`，只负责 readiness、发布和结果状态。
3. 收紧 `ProductPublicationChecklist` 的用户投影：隐藏稳定码/raw ID，允许规格名映射。
4. 在 AdminPage 商品列表增加状态和平台商品发布动作。
5. XBoard 导入成功后把 productId/name 交给发布对话框，形成连续任务。
6. 用 API contract、组件、host wiring、server characterization 和真实 XBoard E2E 验证。

不复制 merchant `catalogApi`。管理员 adapter 使用独立 admin 路径，但共享纯 UI checklist。

## 2. 组件与数据流

~~~text
AdminFakaImportPreview
  confirm()
    POST /admin/faka/import
    onImported({ productId, productName, source: 'xboard' })
                         |
                         v
AdminPage owns publicationTarget
                         |
                         v
AdminProductPublicationDialog
    GET  /admin/products/:id/readiness
    POST /admin/products/:id/publish
    ProductPublicationChecklist
                         |
                         v
onPublished -> close -> getAdminProducts()

Admin product row
  draft/inactive -> open same dialog
  active         -> confirm -> POST /admin/products/:id/unpublish -> reload
~~~

`AdminPage` 是 target、列表刷新和 per-row mutation guard 的 owner。对话框不自行维护全局列表。

## 3. 文件影响面

### 3.1 预计修改

| 文件 | 变更 |
| --- | --- |
| `src/api/admin.ts` | AdminProduct 类型和四个 adapter |
| `src/api/admin.catalog.test.ts` | 固定 admin URL、method、response contract |
| `src/components/catalog/ProductPublicationChecklist.tsx` | 隐藏稳定码/raw ID，支持规格名投影 |
| `src/components/catalog/ProductPublicationChecklist.test.tsx` | 新用户文案和无 raw 技术值断言 |
| `src/components/catalog/AdminFakaImportPreview.tsx` | 导入结果回调携带发布目标；导入和发布仍分离 |
| `src/components/catalog/AdminCatalogWorkflows.test.tsx` | 固定 XBoard 导入后的 handoff |
| `src/pages/AdminPage.tsx` | typed list、状态、发布对话框、下架和刷新 |
| `src/pages/AdminPage.test.tsx` 或新 host test | 状态、平台/商家动作边界、回调 wiring |
| `e2e/catalog-xboard-import.spec.ts` | 真实导入 -> readiness -> 发布 -> 公开可见 |

### 3.2 预计新增

| 文件 | 用途 |
| --- | --- |
| `src/components/catalog/AdminProductPublicationDialog.tsx` | 管理员发布检查/发布对话框 |
| `src/components/catalog/AdminProductPublicationDialog.test.tsx` | ready/issues/race/retry/double-click |
| `server/src/modules/catalog/adminPublicationRoutes.test.ts` | 只做现有 admin route contract characterization；不得改后端生产代码 |

如果现有测试结构更适合把 route characterization 放入已有文件，可不新增文件，但必须避免把
admin 权限契约误写成 merchant ownership 契约。

## 4. 详细设计

### 4.1 Admin API adapter

- `getAdminProducts()` 替代 AdminPage 内直接 `api.get('/admin/products')`。
- list item 类型必须包含：`id/name/status/merchantId/offers` 及当前页面已有库存/Faka 投影。
- 不为省事把整个 DTO 定义成 `any`。
- readiness/result 类型与 controller wire DTO 一致。
- POST 无 body 时遵循现有 axios client 调用风格，不发送伪 status payload。

### 4.2 Publication dialog 状态

建议状态：

~~~ts
type LoadState = 'idle' | 'loading' | 'loaded' | 'error'
type Target = {
  id: number
  name: string
  offers?: Array<{ id: number; name: string }>
  origin: 'xboard-import' | 'product-list'
}
~~~

- `open + target.id` 改变时请求 readiness，并取消/忽略旧请求结果。
- close/unmount 后的响应不得写新 target 状态。
- `publishingRef` 防 React state flush 前的快速双击。
- 422 使用共享 `readinessErrorToIssues()`；随后可再 GET readiness，以 GET 为最终显示权威。
- readiness error 与 publish error 分开，不得把已导入草稿误报为“导入失败”。

### 4.3 Checklist 兼容改造

`ProductPublicationChecklist` 可新增：

~~~ts
offerNames?: ReadonlyMap<number, string> | Record<number, string>
publishLabel?: string
~~~

也可由 caller 预投影，但不得复制稳定码文案 switch。共享 `getReadinessIssueMessage` 仍是唯一文案源。

必须移除当前 visible stable code 和 `规格 <offerId>`。测试只从 `data-code` 读取机器码。
现有 merchant ProductCreateWizard 行为必须保持：ready gate、按钮 disabled 和错误回填不变。

### 4.4 AdminPage 状态与动作

- 把 `products: any[]` 替换为 typed list item。
- 保留现有 XBoard capacity、inventory import 和 delete 操作。
- 状态展示不能改变表格 row key 或库存派生。
- publication target 是独立 state，不塞入 Faka capacity 或 inventory target。
- 发布中由 dialog guard；下架用 `unpublishingProductIds` Set + ref guard。
- 任一成功操作后 `await loadTabData('products')`；失败不修改本地 status。

### 4.5 XBoard handoff

推荐把 `onImported(productId)` 扩展为结构化结果：

~~~ts
onImported(result: {
  productId: number
  productName: string
  origin: 'xboard-import'
}): void | Promise<void>
~~~

如果为了兼容现有调用保留 productId 参数，也必须提供可靠商品名，且不可再依赖异步 state
刷新后从数组中猜目标。Confirm 的 idempotency key/sourceHash 行为不得改变。

### 4.6 后端 contract characterization

只增加测试，证明：

1. 已完成 MFA 的 admin 可 GET readiness；
2. ready platform draft 可 POST publish 并返回 active/publishedAt；
3. 可 POST unpublish 并返回 inactive，publishedAt 保留；
4. 非 admin/MFA 不绕过已有 middleware（可以引用已有 auth 测试，避免重复重测试）。

测试不得为通过而修改 publication production code。

## 5. 测试矩阵

| 层 | 必测 |
| --- | --- |
| API unit | 四个 admin adapter 的 method/path/payload；禁止 merchant path |
| Checklist unit | ready/issues、未知码、规格名、无 visible code/raw ID、keyboard/disabled |
| Dialog component | loading、ready publish、not ready、422、网络失败、retry、close、double click |
| AdminPage host | 三状态、平台/商家边界、XBoard handoff、下架确认、reload |
| Server integration | admin readiness/publish/unpublish wire contract |
| Catalog XBoard E2E | UI 导入草稿 -> 自动检查 -> 发布 -> active -> 公开商品可见 |
| Regression | merchant draft publish、XBoard idempotency/source-change、catalog-ops suites |

## 6. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 导入成功但 readiness 失败被误报为导入失败 | 分离 confirm 和 publication 状态；明确草稿已保留 |
| 双击重复发布/下架 | per-product ref guard + disabled |
| 复用 merchant adapter 导致 403/越权语义混乱 | 独立 admin adapter contract test |
| 前端自行判断 ready | 每次打开都 GET readiness；POST 仍由服务端同事务重验 |
| 422 race 后显示旧 checklist | 解析 details，并重新 GET readiness |
| 技术码/ID泄露到用户界面 | component test 断言 visible/accessibility 文本均不含 code/ID |
| 管理员误发布商家商品 | merchantId 非空不渲染动作 |
| 触碰 XBoard/import 核心逻辑造成回归 | 生产后端 Must Not Touch；真实 XBoard E2E |

## 7. 发布与回滚

- PR 只合入 `develop`，Squash merge，required check `CI OK`，标签 `run-e2e`。
- 不在此任务部署 production。
- 回滚是回滚前端 commit；既有管理员 API 和已创建草稿不受影响。
- 若前端回滚，已发布商品保持服务端真实状态，不执行数据回滚。
