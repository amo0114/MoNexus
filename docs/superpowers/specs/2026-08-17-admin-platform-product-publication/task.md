# Tasks: 管理员平台商品发布闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `TASK-ADMIN-PUB-001` |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) |
| 状态 | **Frozen for Implementation** |

## 1. 执行规则

- 单一 Implementation Owner 负责所有生产代码取舍和最终验证。
- 子代理默认只做探索/核验，不并发编辑热点文件。
- 严格按 `T-APUB-001` 到 `T-APUB-006` 顺序执行。
- 每张卡完成后立即写证据，不得最后一次性补“all green”。
- 遇到后端契约不符、需要 schema/migration 或需要改 XBoard 核心逻辑时停止并报告。

## 2. 原子任务

### T-APUB-001 - Admin API contract 与类型

**依赖**：无。

**Owned**：

- `src/api/admin.ts`
- `src/api/admin.catalog.test.ts`

**工作**：

1. 定义 typed admin product/readiness/status result。
2. 新增 `getAdminProducts/getAdminProductReadiness/publishAdminProduct/unpublishAdminProduct`。
3. 固定 method/path，无 status write payload，无 merchant route。

**DoD**：API unit tests 精确断言四条路径并通过；AdminPage 后续不再直接 fetch products。

### T-APUB-002 - 用户化 readiness checklist

**依赖**：T-APUB-001 的类型可用。

**Owned**：

- `src/components/catalog/ProductPublicationChecklist.tsx`
- `src/components/catalog/ProductPublicationChecklist.test.tsx`
- 必要时 `src/api/catalog.ts` 的共享纯文案 helper

**工作**：

1. 保持稳定码驱动，但移除可见/可访问的 raw code。
2. 用规格名代替 Offer ID；无映射时使用通用文案。
3. 保持 merchant wizard 现有 ready/disabled/onPublish 契约。

**Must Not Touch**：merchant API 路径、readiness 稳定码、后端错误结构。

**DoD**：组件测试证明 DOM 可见文本和 accessible name 均无 raw code/ID。

### T-APUB-003 - 管理员发布对话框

**依赖**：T-APUB-001、T-APUB-002。

**Owned**：

- 新 `src/components/catalog/AdminProductPublicationDialog.tsx`
- 新 `src/components/catalog/AdminProductPublicationDialog.test.tsx`

**工作**：

1. open 时加载 readiness。
2. ready 时发布；not ready 时禁用并解释。
3. 支持 retry、稍后处理、422 更新、409 refresh、网络失败。
4. 加请求陈旧保护和 double-click guard。

**DoD**：组件测试覆盖 spec §7 的 AC-APUB-005/006/007/008/009/013/014。

### T-APUB-004 - AdminPage 列表闭环

**依赖**：T-APUB-003。

**Owned**：

- `src/pages/AdminPage.tsx`
- `src/pages/AdminPage.test.tsx` 或新 `src/pages/AdminPage.products.test.tsx`

**工作**：

1. 使用 `getAdminProducts()` 和 typed state。
2. 展示三种用户状态和未知回退。
3. 平台 draft/inactive 打开发布对话框。
4. 平台 active 确认下架；取消零请求；成功 reload。
5. 商家商品只展示状态和“由商家管理”。
6. 保持现有 Faka capacity、库存导入和删除行为。

**DoD**：host tests 覆盖状态、ownership 边界、下架确认、per-row guard 和 reload。

### T-APUB-005 - XBoard 导入后 handoff

**依赖**：T-APUB-004。

**Owned**：

- `src/components/catalog/AdminFakaImportPreview.tsx`
- `src/components/catalog/AdminCatalogWorkflows.test.tsx`
- `src/pages/AdminPage.tsx` 中仅 handoff 区域

**工作**：

1. Confirm 成功后把 productId/name 交给 publication target。
2. 不自动发布，不重复 confirm，不改变 idempotency/sourceHash。
3. readiness 失败与 import 失败分开提示。
4. 稍后处理后列表仍有发布入口。

**DoD**：组件/host test 证明 import success -> readiness dialog，且 publish 未被自动调用。

### T-APUB-006 - 真实链路与 Gate

**依赖**：前五卡完成。

**Owned**：

- `e2e/catalog-xboard-import.spec.ts`
- 可选 `server/src/modules/catalog/adminPublicationRoutes.test.ts`
- 本规格 Evidence Ledger/Checklist

**工作**：

1. 增加 admin route characterization，不改生产后端。
2. 扩展真实 XBoard fixture：导入 draft、自动 readiness、发布 active、公开可见。
3. 跑定向 frontend/server/E2E、catalog-ops gate、quick gate、diff check。
4. 记录 HEAD、环境、DB、端口、数量和退出码。

**DoD**：AC-APUB-001..018 均有证据，所有 P0 为 PASS。

## 3. 全局 Must Not Touch

除非 Owner 退回规格并书面扩张范围，禁止修改：

~~~text
server/prisma/schema.prisma
server/prisma/migrations/**
server/src/lib/fakaBridge/**
server/src/modules/catalog/externalCatalog.ts
server/src/modules/catalog/productPublication.ts
server/src/modules/catalog/publicationReadiness.ts
server/src/modules/admin/routes.ts
server/src/modules/admin/controller.ts
server/src/modules/admin/service.ts
server/src/modules/merchant/**
server/src/modules/orders/**
src/pages/StorePage.tsx（测试断言除外）
src/components/merchandising/**
.github/workflows/**
deploy/**
~~~

现有后端代码若必须改变才能完成任务，标记 Blocked，附 `file:line` 和失败证据；不得自行解锁。

## 4. 邻近债务处理

- `DEBT-APUB-001`（admin publish/unpublish 无 actor AdminLog）只记录，不实施。
- 发现管理员缺少完整商品编辑器时只记录，不扩建编辑器。
- 发现 merchant checklist 同样显示技术值时，T-APUB-002 可通过共享组件修正，但不得重写 merchant workflow。
