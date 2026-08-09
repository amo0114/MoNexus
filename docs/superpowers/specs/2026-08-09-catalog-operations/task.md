# Tasks: 商品目录、分类治理与库存操作

| 字段 | 值 |
| --- | --- |
| 文档 ID | TASK-CATALOG-OPS-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all tasks Pending** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) |

规格已经 Owner 冻结。任何任务仍须先满足 `S`、依赖与 Entry Gate 才能切换为 In Progress；每个任务先 Red test，再实现，再运行目标与直接受影响回归，完成时把证据写入 implement/checklist。

---

## 1. 全局规则

1. 只修改 Owned files；共享热点以 PAR-CMI-001 文件锁为准。
2. `schema.prisma` 和本波 migrations 只有 T-FND-001 Owner 可改。
3. `products/service.ts` 与 `StorePage.tsx` 只有 T-CAT-INT-001 Owner 可改。
4. Catalog Agent 禁止修改通知 worktree/files、`Layout.tsx`、`appStore.ts`、notification event matrix。
5. 测试不得访问真实 Xboard、生产对象存储、生产 DB 或真实商品。
6. 不能用 mock service 代替 DB unique/concurrency/migration 证据。
7. 任何 secret inventory/content/object key 不得进入 fixture snapshot、日志或截图。
8. 一个 Agent 同时只能持有一张 Implement 卡；一个共享热点同时只能有一个 owner。

---

## 2. 文档与 Foundation

### T-CAT-DOC-001 — Owner freeze 与 delta audit

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-NF-007~010 |
| 依赖 | Owner approval |
| 状态 | Pending |

**Owned**：本规格六件套、PAR-CMI-001 的 Catalog 映射；不得改业务代码。

**工作**：记录 O-CAT-01~11；六件套统一 Frozen；把最新 origin/develop 记为 `D`，创建直接父提交为 `D` 的 docs-only Frozen spec SHA `S`；对通知分支和共享热点做 delta audit；记录 implementation baseline/owner/ports/DB。

**DoD**：ID/版本/状态/基线一致；D/CAT/REQ/AC/Task/CHK 无断链；`S^=D` 且 `D..S` 没有业务/schema diff。

**验证**：`rg` 一致性、`git diff --check`、spec-only diff audit。

### T-FND-001 — Catalog/Merch Shared Foundation

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 / 串行 Gate |
| 对应需求 | REQ-CAT-F-015、REQ-CAT-NF-006 |
| 依赖 | T-CAT-DOC-001 产出的 `S`、SPEC-MERCH-001 freeze、PAR-CMI-001 freeze |
| 状态 | Pending |

**Owned**

- `server/prisma/schema.prisma`；
- 本波 Catalog/Merch migrations；
- shared catalog/merch contracts/constants；
- foundation migration tests/scripts。

**Must Not Touch**：service/controller/routes/UI、notification/auth/Layout、生产 DB。

**工作**

- [ ] 运行 type/image/status/default Offer/external SKU preflight。
- [ ] 新增 Category/Application/Product 增量/ExternalCatalogLink/Offer unique。
- [ ] 同时落 SPEC-MERCH-001 已批准的 MerchandisingRun/Snapshot/Package/Campaign/Editorial/Entitlement models，以及 single-running、run-snapshot FK、Campaign/PointLog/adjustment 关系和 scheduled/active/paused partial unique，避免第二 schema owner。
- [ ] seed 四类+legacy，回填 categoryId/publishedAt，guard 后 tighten。
- [ ] external duplicate guard 遇脏数据 RAISE，不静默删除。
- [ ] 生成/冻结共享 DTO/status/error constants。
- [ ] 空库和 legacy fixture migrate deploy/status/diff。

**DoD**：PAR-CMI-001 3.4 全通过；提交只含 foundation；协调者记录 Foundation SHA `F`，且 `git merge-base --is-ancestor <S> <F>` 为 exit 0。

---

## 3. Catalog Backend

### T-CAT-BE-001 — Category repository、Registry 与管理 API

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-F-007、009~010、REQ-CAT-NF-002、008 |
| 依赖 | T-FND-001 |
| 状态 | Pending |

**Owned**

- `server/src/modules/catalog/constants.ts`
- `categorySchema.ts`、`categoryService.ts`、controller/routes/tests
- `server/src/modules/config/service.ts`
- `server/src/lib/businessRegistry.ts`（只移除产品分类权威）

**Must Not Touch**：Prisma schema/migrations、products service、merchant/admin 大 service、delivery modes registry、Merch module。

**工作**

- [ ] code/label/defaultCover validator 与 active/inactive/reorder CAS。
- [ ] public active registry、admin pagination/CRUD、AdminLog。
- [ ] 被引用 delete 拒绝；code PATCH 拒绝。
- [ ] registry generation cache 与 mutation invalidation。
- [ ] legacy productTypes 由 DB 投影，记录 deprecated usage。

**DoD**：并发 reorder/activate 安全；public 只 active；category mutation 后 cache 收敛；性能预算通过。

### T-CAT-BE-002 — CategoryApplication 状态机与审核

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-F-008、REQ-CAT-NF-004~005 |
| 依赖 | T-CAT-BE-001 |
| 状态 | Pending |

**Owned**：catalog application schema/service/controller/routes/tests；admin/merchant routes 只挂载子 router。

**Must Not Touch**：Merchant application/role approval语义、notification dispatcher、User role。

**工作**

- [ ] merchant list/create/withdraw ownership。
- [ ] pending normalized duplicate constraint 转业务错误。
- [ ] admin list、create_new/map_existing/reject。
- [ ] transaction CAS + Category create/map + AdminLog。
- [ ] reviewReason 与 response allowlist；不产生 notification。

**DoD**：双审核只一项成功；withdraw 后不可审核；merchant 隔离；日志无申请全文。

### T-CAT-BE-003 — Draft、readiness、publish 与平台商品 API

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-F-001~003、011、REQ-CAT-NF-001、004、008 |
| 依赖 | T-FND-001、T-CAT-BE-001 |
| 状态 | Pending |

**Owned**

- `server/src/modules/catalog/publicationReadiness.ts` + tests
- merchant/admin product schema/controller/service 中目录创建/发布最小区域
- Product commercial/cache tests（不改 public projection）

**Must Not Touch**：orders/checkout状态机、products service、InventoryItem import、Merch fields、schema/migrations。

**工作**

- [ ] merchant/admin create 默认 draft、categoryId→type snapshot、limited stock=0。
- [ ] create body 拒绝 secret inventory/type+categoryId/isHot 等越权字段。
- [ ] readiness 完整矩阵和稳定 detail codes。
- [ ] publish/unpublish CAS、publishedAt、projection/cache invalidation。
- [ ] admin manual create 固定 merchantId=null + AdminLog。
- [ ] public/checkout active guard contract tests 交给 Integration/QA 验证。

**DoD**：AC-CAT-001~004、024；发布 transaction 不执行远程 I/O；legacy active 状态不变。

### T-CAT-BE-004 — Offer-first 库存统一

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-F-004~006、REQ-CAT-NF-001、005 |
| 依赖 | T-FND-001 |
| 状态 | Pending |

**Owned**

- merchant inventory/capacity service/schema/tests
- admin inventory preview/confirm glue
- `lib/inventoryImport.ts`、`lib/inventoryLog.ts` 必要最小调整

**Must Not Touch**：InventoryItem content serializer/checkout领取 SQL、orders/refund policy、schema/migrations、low-stock通知语义。

**工作**

- [ ] 新 UI/API path 显式 offerId；default Offer 只兼容旧客户端。
- [ ] Admin preview 与 Merchant domain analyzer 共用。
- [ ] confirm 事务内重算、并发 unique 转稳定错误。
- [ ] void response 按 Offer 统计并另返 Product aggregate。
- [ ] capacity negative/CAS/reason 和动作互斥回归。

**DoD**：AC-CAT-005~009；日志 actor/offer/batch正确；任何响应不泄露已有 content。

### T-CAT-BE-005 — Xboard preview、媒体、净化与幂等 confirm

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-F-012~014、REQ-CAT-NF-004~005、008 |
| 依赖 | T-FND-001、T-CAT-BE-001、T-CAT-BE-003 |
| 状态 | Pending |

**Owned**

- `server/src/modules/catalog/externalCatalog.ts`、`contentSanitizer.ts`
- FakaBridge contract/admin import schema/service/controller/routes 的最小区域
- Xboard catalog/import/add-offer tests

**Must Not Touch**：真实 provider、Faka provisioning/checkout、storage provider管理、任意远程下载、Merch AI assets。

**工作**

- [ ] preview normalized rows/issues/sourceHash，零 DB 写。
- [ ] Uploaded StoredObject/category default cover validator。
- [ ] server allowlist sanitizer + hostile fixture。
- [ ] confirm 重新 fetch/hash，网络失败零写。
- [ ] Idempotency-Key/requestHash/external link/Offer unique replay/conflict。
- [ ] Product draft + Offers + link + AdminLog 同 transaction。

**DoD**：AC-CAT-018~023；并发两个进程仍唯一；响应/log无 credential/object key/危险 HTML。

---

## 4. Catalog Frontend

文件锁总则：T-CAT-FE-002～004 在同一 Catalog Frontend Worktree 内串行编辑宿主；任务描述中的“库存区域/商品区域/最小 mount”只是工作范围，不是区域级并发授权。任一时刻 `AdminPage.tsx`、`MerchantDashboardPage.tsx` 各只有一个整文件 Owner。

### T-CAT-FE-001 — 商品 draft stepper 与发布 Checklist

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-F-001~003、009 |
| 依赖 | Foundation DTO fixture；可与 BE 并行 |
| 状态 | Pending |

**Owned**

- `src/components/catalog/ProductCategorySelect.tsx`
- `ProductPublicationChecklist.tsx`、`ProductAvailabilityStep.tsx`
- `src/pages/merchant/ProductCreateWizard.tsx`（该卡独占）
- `src/components/merchant/MerchantProductFormModal.tsx`（商品目录字段/isHot/category-delivery 接线区域，本卡独占）
- `src/types/catalog.ts`、`src/api/catalog.ts` 中 merchant contract

**Must Not Touch**：StorePage、MerchantDashboardPage、AdminPage、Merch badge、Layout/appStore。

**工作**

- [ ] categoryId select，不根据分类切 deliveryMode。
- [ ] 保存 draft 后保留 productId，可进入可售量步骤。
- [ ] 即时秘密库存不进入 create payload；capacity 调独立 API。
- [ ] readiness errors 映射稳定 code；失败保留输入/draft。
- [ ] 移除 isHot toggle/payload；不新增认证/精选开关。
- [ ] 创建向导与编辑 Modal 都保持“分类只影响展示/检索，不自动切 deliveryMode”。

**DoD**：组件 contract tests、atomic create错误、back/next、重复 submit、可访问性/testid 全通过。

### T-CAT-FE-002 — Offer-first 库存工作台

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-F-004~006 |
| 依赖 | T-CAT-BE-004 contract fixture |
| 状态 | Pending |

**Owned**：Merchant inventory/capacity modals、Catalog availability wrapper、`MerchantDashboardPage.tsx` 库存工作范围及活动期间整文件锁、component/E2E。

**Must Not Touch**：商品编辑其他字段、Offer backend、AdminPage、orders/notifications。

**工作**：先选 Offer；动作互斥；preview→confirm；错误/敏感预览；Offer/Product stock 分栏；background refresh 防旧响应覆盖。

**DoD**：AC-CAT-005~009 浏览器证据；无“补充商品库存”含混文案；多 SKU 选择保持。

### T-CAT-FE-003 — 分类管理与商家申请 UI

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-F-007~010 |
| 依赖 | Category API fixture；可与 backend 并行 |
| 状态 | Pending |

**Owned**：`components/catalog/AdminCategoryManager.tsx`、CategoryApplicationPanel、独立 API/types；若本卡执行 Admin/Merchant 宿主最小 mount，则沿用 Catalog Frontend 整文件锁且必须在 `H` 前提交。

**Must Not Touch**：StorePage、AdminPage 其他 tabs、Merchant role application、notification UI。

**工作**：CRUD/reorder/deactivate、pending review/create/map/reject、merchant create/withdraw/status；冲突/已审核 UX；inactive historical label。

**DoD**：keyboard/accessibility、双提交禁用、pagination/filter 保持、AC-CAT-010~016。

### T-CAT-FE-004 — 管理员平台商品与 Xboard preview UI

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-CAT-F-005、011~013 |
| 依赖 | T-CAT-BE-003~005 contracts |
| 状态 | Pending |

**Owned**：AdminPlatformProductWizard、AdminFakaImportPreview、`AdminPage.tsx` 商品工作范围及活动期间整文件锁、`src/api/admin.ts` 商品/import区域、E2E。

**Must Not Touch**：Admin users/settlement/storage/announcement区域、Merch管理页面、远程图片抓取、Image 2。

**工作**：手工平台商品、Admin inventory preview、Xboard preview/source change、uploaded/default cover、幂等 retry/existing product link。

**DoD**：AC-CAT-018~024；无封面不能 confirm；重试不新增 Product；现有 Faka capacity UI 回归。

---

### Catalog Host Release Gate（`H`，非独立业务卡）

T-CAT-FE-002～004 的宿主修改与直接回归全部完成后，协调者记录 Catalog Frontend tip 为 `H`，保存两份 host 的 diff/test evidence，并把 `AdminPage.tsx`、`MerchantDashboardPage.tsx` 整文件锁一次性移交 CMI Integration Owner。`H` 后 Catalog Frontend 不再编辑这两个文件；若必须返修，先暂停 CMI 卡并登记反向移交与新的 `H`。

---

## 5. 共享集成

### T-CAT-INT-001 — Public Product/Registry/Store 接线

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 / 共享热点锁 |
| 对应需求 | REQ-CAT-F-009~010、REQ-CAT-NF-002、007~009 |
| 依赖 | 全部 Catalog BE/FE 输出、Catalog host release `H`、SPEC-MERCH lane tips/adapters ready；已建立 `M_CMI` |
| 状态 | Pending |

**Owned（独占）**

- `server/src/modules/products/{schema,service,controller,routes}.ts`
- `src/pages/StorePage.tsx`
- `src/pages/AdminPage.tsx`、`src/pages/MerchantDashboardPage.tsx`（仅 `H` 后接收整文件锁）
- public Product types/cache cursor 接线

**Must Not Touch**：Catalog/Merch adapter内部、schema/migrations、Layout、notification、checkout状态机。

**工作**

- [ ] category DTO/filter/legacy query 与 public active guard。
- [ ] 导入 Merch public projection adapter，不复制算法。
- [ ] CategoryFilter 与 Merch components 组合进 StorePage。
- [ ] 在不重写 `H` 内 Catalog 逻辑的前提下，将已完成的 Catalog/Merch 子组件 mount 到 Admin/Merchant hosts。
- [ ] cursor/cache key/compat contract 和 cache invalidation。
- [ ] old/new response滚动兼容。

**DoD**：本卡与 T-MERCH-INT-001 由同一 CMI Integration Owner/Worktree 串行执行；products/Store/两个 host 在 `H` 后只有该 Owner 修改；`F`、各 lane tip、`H` 均为 `M_CMI` 祖先；Catalog/Merch fixtures一致；AC-CAT-003~004、015~017、026。

---

## 6. QA、发布与交接

### T-CAT-QA-001 — Migration/constraint/replay Gate

**优先级/依赖**：P0；依赖 T-FND-001 和全部 DB 相关 backend。

**Owned**：专用 migration fixtures/scripts、database constraint tests；不得改 migration 来迎合失败 fixture，须交回 Foundation owner。

**DoD**：empty/legacy/dirty-expected-fail 三套；migrate deploy/status/diff；前后计数/hash；AC-CAT-025、028。

### T-CAT-QA-002 — Backend、安全、并发与性能 Gate

**优先级/依赖**：P0；依赖所有 BE/INT。

**Owned**：Catalog backend integration/performance harness、专用 DB setup。

**工作**：auth/ownership/MFA、review CAS、publish race、capacity race、inventory unique、Xboard multi-process idempotency、sanitizer、cache、P95。

**DoD**：REQ-CAT-NF-001~005、008；无敏感泄漏；测试顺序独立。

### T-CAT-QA-003 — Browser E2E、兼容、回滚与最终 Gate

**优先级/依赖**：P0；依赖所有 P0 task。

**Owned**：`playwright.catalog-ops.config.ts`、`e2e/catalog-*.spec.ts`、`scripts/verify-catalog-ops*.sh`、Checklist evidence、Implement ledger。

**Must Not Touch**：放宽生产代码、page DB hack、test.skip、通知专用环境。

**工作**：merchant draft→availability→publish；category申请/审核；admin platform商品；Xboard preview/confirm/replay；Store filter；old/new compat；rollback；全回归；PAR Gate。

**DoD**：一条 verify command 可复现；AC-CAT-001~028/全部 P0 CHK/G-PR 有当前 HEAD 证据。

---

## 7. 依赖总表

| Task | 前置 | 可并行 | 解锁 |
| --- | --- | --- | --- |
| T-CAT-DOC-001 | Owner | 无 | Foundation |
| T-FND-001 | Catalog+Merch+PAR freeze | Identity Core | 全 Catalog/Merch lanes |
| T-CAT-BE-001 | FND | BE-003/004/005、FE | BE-002、INT |
| T-CAT-BE-002 | BE-001 | BE-003~005、FE | QA |
| T-CAT-BE-003 | FND+BE-001 | BE-004/005、FE | FE-004、INT |
| T-CAT-BE-004 | FND | BE-001/002/003/005、FE | FE-002、QA |
| T-CAT-BE-005 | FND+BE-001/003 | BE-004、FE | FE-004、QA |
| T-CAT-FE-001~004 | contract fixtures | 纯组件相互并行；host edits整文件串行 | `H`、INT/QA |
| T-CAT-INT-001 | `M_CMI` + `H` + Catalog/Merch adapters | 无（共享热点） | System QA |
| T-CAT-QA-001、T-CAT-QA-002 | 对应 backend | FE E2E准备 | T-CAT-QA-003 |
| T-CAT-QA-003 | 全 P0 | 无 | PR |

---

## 8. 总体 DoD

- [ ] 所有 P0 Task Done 且当前 HEAD 证据可重现。
- [ ] Foundation/Integration/shared hotspot 没有双 owner。
- [ ] AC-CAT-001~028 全覆盖，没有手工 DB/生产资源伪证据。
- [ ] Migration 空库/升级/dirty guard 全通过，无 drift。
- [ ] Catalog/Merch/通知/订单/库存/Faka 回归全绿。
- [ ] Checklist、G-PR、compat、rollout/rollback、PAR-CMI-001 Gate 全通过。
