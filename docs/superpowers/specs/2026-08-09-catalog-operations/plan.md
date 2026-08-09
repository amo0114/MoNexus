# Plan: 商品目录、分类治理与库存操作

| 字段 | 值 |
| --- | --- |
| 文档 ID | PLAN-CATALOG-OPS-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 输入 | [spec.md](./spec.md) |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| 并行契约 | [PAR-CMI-001](../2026-08-09-catalog-merch-identity-parallel-contract.md) |

---

## 1. 工程目标与非目标

### 1.1 目标

- 在现有 Product/Offer/InventoryItem 上增加 draft/publish，而不复制商业真相源。
- 将四个代码常量迁移为平台可治理分类，并保留历史 type snapshot。
- 把商品创建、Offer 配置、可售量和发布做成明确状态机。
- 为商家分类申请、管理员平台商品和 Xboard 完整导入提供可审计 API/UI。
- 以数据库唯一约束、幂等 key 和 source hash 消除重复外部商品。
- 通过单一 Foundation Owner 与单一 CMI Integration Owner 让 Catalog 与 Merch 多 Agent 并行。

### 1.2 非目标

- 不实现热卖/推广/badge；
- 不改订单状态机、退款、结算、通知事件；
- 不下载外部图片、不调用 Image 2；
- 不建立分类树、属性系统或全局 Query 框架；
- 不替换现有 InventoryItem 加密/授权边界。

---

## 2. 目标架构

~~~text
ProductCategory（平台治理）
       │
       ▼
Product draft ── publish readiness ──► active
       │                                  │
       ├─ Offer A（价格/库存/履约真相）   └─ public catalog
       │      ├─ InventoryItem[]
       │      └─ InventoryLog[]
       └─ Offer B（独立 capacity/履约）

Merchant CategoryApplication ─► Admin review ─► Category create/map

Xboard preview（零写入）
       ├─ sourceHash
       ├─ sanitized content
       ├─ category + platform cover
       └─ SKU conflict report
                │
                ▼ confirm + idempotency
      Product draft + Offers + ExternalCatalogLink + AdminLog（同事务）
~~~

正确性边界：

- Catalog REST/DB 是事实源；前端 stepper 不是工作流真相源。
- 发布门禁每次都读取当前 Offer/InventoryItem，不信任 preview 或客户端统计。
- 外部 catalog 网络调用发生在 DB transaction 之前；transaction 内只写已规范化、已 hash 的快照。
- Category 只作为 taxonomy；Offer deliveryMode 继续独立校验。

---

## 3. 模块与建议目录

### 3.1 后端

~~~text
server/src/modules/catalog/
  constants.ts                 # status/code/error enums
  categorySchema.ts
  categoryService.ts
  categoryController.ts
  categoryRoutes.ts
  applicationService.ts
  publicationReadiness.ts
  externalCatalog.ts           # source hash / identity / idempotency
  contentSanitizer.ts
  contracts.ts                 # Foundation 冻结 DTO
  __tests__/**

现有最小接入：
  modules/merchant/{routes,schema,service,controller}.ts
  modules/admin/{routes,schema,service,controller}.ts
  modules/products/{routes,schema,service,controller}.ts  # CMI Integration Owner
  modules/config/service.ts
  lib/businessRegistry.ts
  lib/inventoryImport.ts
~~~

边界：category/publication/external identity 逻辑进入 `modules/catalog`；现有 merchant/admin service 只做授权、ownership 和调用。不得在三个 service 各复制 readiness 或 source hash。

### 3.2 前端

~~~text
src/components/catalog/
  ProductCategorySelect.tsx
  CategoryApplicationPanel.tsx
  ProductPublicationChecklist.tsx
  ProductAvailabilityStep.tsx
  AdminCategoryManager.tsx
  AdminPlatformProductWizard.tsx
  AdminFakaImportPreview.tsx

src/types/catalog.ts
src/api/catalog.ts

宿主接入（文件级单 owner）：
  ProductCreateWizard.tsx
  MerchantDashboardPage.tsx
  AdminPage.tsx
  StorePage.tsx
  appStore registry types/service
~~~

页面只组合独立组件。`StorePage.tsx` 始终由 CMI Integration Owner 修改。`AdminPage.tsx`、`MerchantDashboardPage.tsx` 在 Catalog FE 阶段由同一 Catalog Frontend Owner 持有整文件锁；全部 Catalog-owned host 修改完成并测试后记录 host release `H`，再把两份整文件锁一次性移交 CMI Integration Owner。`H` 前后都禁止用“不同区域”允许两个 Agent 同时写。

---

## 4. Shared Foundation 方案

Owner Freeze 先以记录的最新 develop `D` 为直接父提交形成 docs-only Frozen spec SHA `S`。FND-CMI-001 必须从 `S` 分叉，并先于任何依赖 Prisma model 的 Catalog/Merch backend task。Foundation Owner：

1. 运行 legacy preflight 并保存脱敏计数；
2. 一次性冻结 Catalog/Merch models 与关系；
3. 按可审查顺序创建 migration（允许多个顺序 migration，但只有一个 owner）；
4. 添加 category seed/backfill、publishedAt 回填、external duplicate abort；
5. 添加 shared contracts/constants，不实现 service；
6. 在空库和升级 fixture 库验证 migrate deploy/status/diff。

Foundation Gate tip 记为 `F`，并以 `git merge-base --is-ancestor <S> <F>` 证明祖先关系。Catalog/Merch Agent 必须从 `F` 分支；若后续发现 schema 缺口，任务进入 Blocked，由 Foundation Owner 提交 delta；禁止在业务分支自行改 schema。

---

## 5. 数据迁移计划

建议顺序：

1. `catalog_categories_and_drafts`：Category/Application、Product nullable categoryId/publishedAt、status CHECK 扩展。
2. `catalog_backfill_categories`：seed 四类+legacy、回填、验证并 tighten categoryId。
3. `external_catalog_identity`：ExternalCatalogLink、Offer external unique；执行 duplicate guard。
4. Merch migrations 由同一 Foundation owner 继续，至少包含 MerchandisingRun/Snapshot/Package/Campaign/Editorial/Entitlement、single-running、run-snapshot FK、Campaign/PointLog/adjustment 关系和 scheduled/active/paused partial unique；字段级语义见 SPEC-MERCH-001 §5。

迁移 SQL 必须具有明确的 `DO $$ ... RAISE EXCEPTION` 数据 guard；发现重复/脏数据即阻断，不静默选择最低 ID 或删除记录。

`prisma db push` 在本项目禁止使用；只用 migration 工作流。

---

## 6. 关键技术方案

### 6.1 Draft 与 publish

- create transaction 只写 Product+Offers，status=draft、limited stock=0。
- readiness service 用一个 transaction snapshot 读取 Product/category/active Offers/available counts。
- updateMany `where id + owner + current status` 做状态 CAS；成功后同步 Product projection 和 cache。
- publish/unpublish API 幂等：已在目标状态且配置未变时返回当前资源；非法主体/未就绪用稳定错误。
- public product query、detail和 checkout 均要求 Product.status=active 与 Offer.status=active。

### 6.2 Category repository

- Registry DB 查询只返回 active，排序稳定，短 TTL cache。
- category mutation 与 application approval 后 bump registry cache generation 和 public product list cache。
- normalizedLabel 在服务端 Unicode trim/lower canonical；code 使用 ASCII regex。
- label rename 不回写 Product.type；new create 用最新 label 写 snapshot。

### 6.3 库存工作台

- 使用现有 analyze/import 和 DB unique，不把 preview 结果当 confirm 权威。
- Admin route 调用与 merchant 相同 domain service，仅 ownership/actor 不同。
- Offer selector 过滤不支持该动作的 Offer；server 仍二次拒绝。
- 所有后台刷新保留已输入文本和选择；成功后只清对应表单。

### 6.4 Xboard source hash

规范化输入仅包含：provider、planId、plan name、净化后内容摘要、选中 period、canonical SKU、offer name、price、validity、capacity summary、categoryId、cover snapshot。使用 key-sorted canonical JSON 计算 SHA-256。

Preview 返回 sourceHash；confirm 重新读取 source 并计算。若 Xboard 不可用，confirm 503 且零写入；不得使用过期客户端 preview 强行导入。

### 6.5 Idempotency

- `Idempotency-Key` 1..128 ASCII，可由管理员客户端 UUID 生成。
- requestHash 排除 token/request timestamp，包含所有会改变 Product/Offers 的字段。
- transaction 首先查询 idempotencyKey/external identity；再 create。
- unique P2002 等冲突转换成 replay 或 409，不暴露数据库 constraint 名。

### 6.6 内容和媒体

- Xboard remote content 视为不可信；server sanitizer allowlist 是主边界。
- Product image canonicalization 继续 `images[0] == imageUrl`。
- Uploaded cover 必须能映射到 active StoredObject；API 不返回 objectKey。
- category default cover 在 confirm 时复制 URL，保持商品历史稳定。

---

## 7. 分阶段实施

### Phase A — Spec freeze、delta audit、Foundation

- Owner 批准 O-CAT-01~11 和 PAR-CMI-001；
- 对最新 develop/通知分支做共享热点 delta audit；
- 运行 preflight、落 schema/migrations/contracts；
- 空库/升级库 Gate。

出口：Foundation SHA 已记录，零未解释脏数据，业务 lane 可分叉。

### Phase B — 分类 repository 与审核

- category CRUD/cache/registry；
- merchant applications；
- admin approve/map/reject + AdminLog；
- legacy type compatibility mapper。

出口：分类状态机、并发审核和 cache tests 全绿。

### Phase C — Draft、readiness 与商品 API

- merchant/admin create draft；
- publish/unpublish/readiness；
- public/checkout active guard；
- platform manual Product backend。

出口：缺项不可发布、完整商品原子发布、legacy 商品不下架。

### Phase D — 商家/平台创建 UI

- category select、draft stepper、availability step、publication checklist；
- admin platform Product wizard；
- 不开放 isHot/精选/认证字段。

出口：创建与可售量动作在 UI/API 上都分开。

### Phase E — 库存统一与 Xboard

- Admin preview parity；
- Offer-specific void response；
- Xboard preview/source hash/sanitizer/cover/idempotent confirm；
- ExternalCatalogLink query/admin error UX。

出口：并发导入唯一、无图/危险 HTML/重复 plan 用例通过。

### Phase F — Public registry/Store integration

由 CMI Integration Owner：

- products/config API DTO wiring；
- Store CategoryFilter；
- old/new query compatibility；
- 与 SPEC-MERCH-001 projection 组合。

出口：共享热点仅一位 owner 改动，contract fixture 一致。

### Phase G — Migration、E2E、性能与兼容

- 空库/升级迁移；
- merchant/admin/catalog/Xboard E2E；
- old frontend/new backend；
- list/category/preview performance；
- cache、security、notification regression。

### Phase H — 发布与兼容窗口

- backend+DB 先上线；
- 验证 legacy type/new category 双读写；
- 发布 frontend；
- 观察 legacy write metric；
- 后续版本关闭旧 type 写路径。

---

## 8. 依赖与并行图

~~~text
FND-CMI-001
  ├─► CAT-BE Category ─┐
  ├─► CAT-BE Product ──┼─► CMI Integration ─► System QA
  ├─► CAT-BE Xboard ───┤
  ├─► CAT-FE components┤
  └─► MERCH lanes ─────┘
~~~

Foundation 后可并行：Category backend、Product/publication backend、Xboard backend、Catalog UI components、Merch backend/frontend。

串行热点：

- schema/migrations：Foundation only；
- merchant schema/service：Catalog backend one owner；
- AdminPage/MerchantDashboard：Catalog frontend 整文件 owner 直至 `H`，随后移交 CMI Integration Owner；
- products service/StorePage：CMI Integration only；
- CMI Integration 只能从同时包含 `F`、Catalog/Merch lane tips 与 `H` 的 `M_CMI` 开始。

---

## 9. 测试策略

| 层 | 必须证明 |
| --- | --- |
| Unit | code/label normalization、readiness matrix、sourceHash、sanitizer、requestHash |
| DB constraints | category/external unique、status CHECK、FK restrict、stock nonnegative |
| Migration | empty + four categories + unknown type + duplicate external preflight |
| Backend integration | auth/ownership、CAS review、publish、inventory concurrency、idempotent confirm |
| Component | stepper、Offer action matrix、preview errors、admin category/application UI |
| Browser E2E | merchant draft→stock→publish、admin platform商品、Xboard preview→confirm、Store filter |
| Regression | merchant inventory/images、offers、checkout、gallery、FakaBridge、notifications |
| Performance | registry/list baseline、1000-row preview、cache invalidation |

核心 E2E 不允许通过手工数据库改 status、直接调用 private readiness 或 page.reload 掩盖状态同步。Xboard 使用本地 fixture server，不访问真实 provider。

---

## 10. 发布顺序

1. 备份/演练 migration，在 staging fixture 跑 preflight。
2. 部署兼容 backend，仍接受 legacy type，尚不发布新 frontend。
3. 执行 migrations，验证 categoryId zero-null/external duplicates/status counts。
4. 验证既有 storefront、checkout、merchant/admin。
5. 发布新 frontend，启用 draft/category/Xboard preview UI。
6. 观察错误率、legacy write count、publish failure reasons、duplicate import conflicts。
7. 兼容窗口后另一个受审 commit 禁止 legacy type 写入；公开 type snapshot 保留。

---

## 11. 回滚

- 前端可先回滚到旧 UI；兼容 backend 仍接受 type。
- 新 Product 保持 draft/active 数据，不删除 Category/ExternalCatalogLink。
- 代码回滚不得回滚已执行 migration；使用 forward-fix 恢复旧 API compatibility。
- 若 publish gate 有误，先隐藏新 publish UI并保持现有 active 商品，不通过 SQL 批量设 active。
- Xboard confirm 异常时关闭该 route/UI，preview 和已有商品保持可读。
- 不回滚/删除 InventoryItem、Order、InventoryLog 或 external identity 行。

---

## 12. 停止条件

出现任一情况立即停止发布：

- migration preflight 有未决 type/external duplicate；
- active legacy 商品数量或状态在迁移前后变化；
- checkout 能购买 draft/inactive Product；
- publish 能绕过 Offer availability；
- preview/日志泄露 InventoryItem content 或 object key；
- 并发 confirm 创建重复 external identity；
- sanitizer 保留危险 URL/event handler；
- Catalog diff 修改 notification realtime owned files；
- Store list P95 退化超过冻结预算。

---

## 13. 完成信号

只有 Owner 冻结、Foundation Gate、Phase A~H、AC-CAT-001~028、Checklist P0、迁移回放、专用 E2E、兼容/回滚演练及 PAR-CMI Cross-spec Gate 全通过，PLAN-CATALOG-OPS-001 才算完成。
