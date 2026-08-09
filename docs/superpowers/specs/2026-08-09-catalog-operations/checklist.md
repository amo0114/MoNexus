# Checklist: 商品目录、分类治理与库存操作

| 字段 | 值 |
| --- | --- |
| 文档 ID | CHK-CATALOG-OPS-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all implementation checks unverified** |
| 规格 | [SPEC-CATALOG-OPS-001](./spec.md) |

规则：只有同一 commit 上的可重现证据才能勾选。代码存在、mock 通过、手工改数据库、刷新页面或 feature-off skip 都不是证据。

---

## 1. P0 — 文档、Foundation 与并行边界

- [ ] **CHK-CAT-DOC-001** — O-CAT-01~11 与 PAR-CMI-001 已批准；六件套 Frozen。
- [ ] **CHK-CAT-DOC-002** — `D/S/F`、通知 delta、ancestor命令及共享热点 owner 已记录；`S^=D`且`S→F`可证明。
- [ ] **CHK-CAT-DOC-003** — REQ/AC/Task/Implement/CHK 追溯无断链。
- [ ] **CHK-CAT-PAR-001** — schema/migrations 单 owner；products/Store 单 CMI Owner；Admin/Merchant hosts 由 Catalog FE 整文件持锁至 `H`，再移交同一 CMI Owner，零并发写入。
- [ ] **CHK-CAT-PAR-002** — Catalog diff 不含通知 worktree、notification模块、Layout/appStore/auth middleware。
- [ ] **CHK-CAT-PAR-003** — 各 lane Worktree/DB/ports 唯一且 trap 只清自己资源。

---

## 2. P0 — Migration 与数据库约束

- [ ] **CHK-MIG-001** — preflight 输出 type/image/status/default Offer/external SKU 脱敏计数。
- [ ] **CHK-MIG-002** — 空库 migrate deploy/status/diff 无 drift。
- [ ] **CHK-MIG-003** — legacy clean fixture 升级后 Product/Offer/Inventory/Order/Log 计数不丢失。
- [ ] **CHK-MIG-004** — 四类精确回填；未知/空 type 到 inactive legacy category；categoryId 零 null。
- [ ] **CHK-MIG-005** — legacy active/inactive 状态保持，publishedAt 按契约回填。
- [ ] **CHK-MIG-006** — external SKU/category脏数据 fixture 以清晰 guard 失败，不静默删除/合并。
- [ ] **CHK-MIG-007** — ProductCategory/ExternalCatalogLink FK/unique/status约束数据库层生效。
- [ ] **CHK-MIG-008** — `prisma db push` 未使用；本波 migrations 只有 Foundation owner提交。

---

## 3. P0 — 分类治理

- [ ] **CHK-CAT-001** — Category code/normalized label unique、code immutable、排序稳定。
- [ ] **CHK-CAT-002** — public registry 只 active；legacy productTypes 来自 DB 并标 deprecated。
- [ ] **CHK-CAT-003** — 管理员 CRUD/reorder/activate/deactivate 全鉴权/MFA/AdminLog。
- [ ] **CHK-CAT-004** — 被引用分类只可 deactivate，物理 delete 被拒。
- [ ] **CHK-CAT-005** — 分类不改变/限制 Offer deliveryMode；创建/编辑 UI一致。
- [ ] **CHK-CAT-006** — 商家只能创建/读取/撤回自己的 application。
- [ ] **CHK-CAT-007** — 同 merchant+normalizedLabel 至多一条 pending。
- [ ] **CHK-CAT-008** — create_new/map_existing/reject transaction + CAS + AdminLog正确。
- [ ] **CHK-CAT-009** — 双管理员并发审核仅一个成功，无重复 Category。
- [ ] **CHK-CAT-010** — label rename 不改历史 Product.type/订单快照。
- [ ] **CHK-CAT-011** — inactive category 历史商品仍可读，新首次发布不可用。
- [ ] **CHK-CAT-012** — category mutation 后 registry/product list cache正确失效。

---

## 4. P0 — Product draft/publish

- [ ] **CHK-PROD-001** — 商家/管理员 create 原子 Product+Offers、默认 draft、limited stock=0。
- [ ] **CHK-PROD-002** — create 不接受 InventoryItem content、isHot、认证/精选、任意 merchantId。
- [ ] **CHK-PROD-003** — readiness覆盖 cover/category/Offer/履约/至少一个sellable Offer。
- [ ] **CHK-PROD-004** — readiness failure 422稳定 codes且状态不变。
- [ ] **CHK-PROD-005** — publish CAS 原子 active/publishedAt/projection/cache；无远程 I/O。
- [ ] **CHK-PROD-006** — unpublish 保留库存/订单/日志，再发布仍走 readiness。
- [ ] **CHK-PROD-007** — public list/detail/checkout 均拒绝 draft/inactive。
- [ ] **CHK-PROD-008** — legacy active商品上线不被自动下架。
- [ ] **CHK-PROD-009** — type+categoryId同传拒绝；legacy type兼容窗口映射正确。
- [ ] **CHK-PROD-010** — admin平台商品 merchantId=null 由服务端推导并写审计。

---

## 5. P0 — Offer-first 库存

- [ ] **CHK-INV-001** — 新 UI/API 显式选择 Offer；default Offer只作为旧客户端兼容。
- [ ] **CHK-INV-002** — instant inventory 只显示/允许 import/void；capacity动作被拒。
- [ ] **CHK-INV-003** — non-instant limited 只显示/允许 capacity；inventory import被拒。
- [ ] **CHK-INV-004** — Admin/Merchant 都先 preview；confirm transaction内重算。
- [ ] **CHK-INV-005** — duplicate/template/empty/limit错误零写入、零审计假记录。
- [ ] **CHK-INV-006** — capacity并发不会负数，reason/actor/offer/log正确。
- [ ] **CHK-INV-007** — void只作废 available，竞争不足整体失败。
- [ ] **CHK-INV-008** — void response availableStock 属目标 Offer，productAvailableStock为汇总。
- [ ] **CHK-INV-009** — preview/response/log/snapshot 不泄露既有 InventoryItem.content。

---

## 6. P0 — Xboard 与媒体

- [ ] **CHK-XBD-001** — preview读取fixture catalog、规范化rows/issues/sourceHash且零业务写。
- [ ] **CHK-XBD-002** — uploaded cover对应active StoredObject；响应不暴露objectKey。
- [ ] **CHK-XBD-003** — category default cover被复制为Product snapshot；无封面不可confirm。
- [ ] **CHK-XBD-004** — P0 无remote_url/远程下载/同步AI调用路径。
- [ ] **CHK-XBD-005** — sanitizer移除script/style/iframe/on*/危险URL/remote img，前端二次净化。
- [ ] **CHK-XBD-006** — confirm重新fetch/hash，source变化或provider失败零写。
- [ ] **CHK-XBD-007** — Idempotency-Key同key/hash replay返回原Product；同key异hash 409。
- [ ] **CHK-XBD-008** — provider+externalProductId和integration+SKU DB unique。
- [ ] **CHK-XBD-009** — 并发不同key导同plan/SKU最终唯一，冲突返回existingProductId。
- [ ] **CHK-XBD-010** — Product draft+Offers+ExternalLink+AdminLog同事务，任一失败整体回滚。

---

## 7. P0 — 前端与公开接入

- [ ] **CHK-UI-001** — 向导保存draft后可继续availability/publish，失败不丢输入。
- [ ] **CHK-UI-002** — 分类选择不自动改deliveryMode；无isHot/认证/精选开关。
- [ ] **CHK-UI-003** — publish checklist按稳定codes定位问题并可键盘操作。
- [ ] **CHK-UI-004** — 多Offer库存动作词清晰、selector/preview/confirm状态正确。
- [ ] **CHK-UI-005** — 分类管理/申请/审核UI保留筛选分页、阻止重复提交。
- [ ] **CHK-UI-006** — Admin平台商品与Xboard preview UI不干扰其他Admin tabs。
- [ ] **CHK-UI-007** — Store category code切换重置list/cursor/scroll缓存，无旧结果混入。
- [ ] **CHK-UI-008** — public Product category DTO和legacy type在old/new客户端兼容。
- [ ] **CHK-UI-009** — `F`、lane tips、`H` 均为 `M_CMI` 祖先；products/Store/`H` 后两个 hosts 只有 CMI Integration Owner 修改并消费既有 adapters/components。

---

## 8. P0 — 安全、性能与可观测性

- [ ] **CHK-SEC-001** — merchant ownership/admin MFA/active/email gates未弱化。
- [ ] **CHK-SEC-002** — API/log/AdminLog/trace无库存secret、credential、object key、危险HTML。
- [ ] **CHK-SEC-003** — Xboard只连fixture；没有可利用SSRF路径。
- [ ] **CHK-SEC-004** — 错误不暴露constraint名、stack、远端响应正文。
- [ ] **CHK-PERF-001** — category registry P95≤300ms并记录样本/环境。
- [ ] **CHK-PERF-002** — 商品列表相对基线P95退化≤10%。
- [ ] **CHK-PERF-003** — 1000行本地preview P95≤2s（不含provider网络）。
- [ ] **CHK-OPS-001** — legacy type usage、publish failure code、import replay/conflict有有界指标。
- [ ] **CHK-OPS-002** — 指标无merchant/product/email/content/object key高基数标签。

---

## 9. P0 — QA、兼容与发布

- [ ] **CHK-QA-001** — normalization/readiness/hash/sanitizer/idempotency unit全绿。
- [ ] **CHK-QA-002** — category review/publish/inventory/Xboard真实PG integration全绿。
- [ ] **CHK-QA-003** — draft→availability→publish、分类申请审核、平台商品、Xboard、Store E2E全绿。
- [ ] **CHK-QA-004** — merchant inventory/images、offers、multi-SKU、gallery、structured delivery回归全绿。
- [ ] **CHK-QA-005** — checkout/orders/refund/FakaBridge/product constraint/commercial contract回归全绿。
- [ ] **CHK-QA-006** — notification realtime相关build/tests无退化且零owned-file冲突。
- [ ] **CHK-REL-001** — backend兼容层→migration→frontend固定发布顺序已演练。
- [ ] **CHK-REL-002** — old frontend+new backend、新frontend+newbackend通过。
- [ ] **CHK-REL-003** — frontend回滚和backend forward-fix runbook已演练，不回滚已执行migration。
- [ ] **CHK-REL-004** — legacy write兼容窗口/移除条件/指标owner已记录。

---

## 10. P1 — 后置

- [ ] **CHK-P1-001** — 根据真实需要评估多级分类/Tag/属性模板。
- [ ] **CHK-P1-002** — 如需远程图片，另立SSRF/版权/下载到自有storage规格。
- [ ] **CHK-P1-003** — 如需AI商品封面，另立异步MediaTask/审核/成本规格。
- [ ] **CHK-P1-004** — 兼容窗口数据表明legacy type写为零后，删除旧写mapper（公开snapshot不删除）。
- [ ] **CHK-P1-005** — 评估无订单硬删除是否改为长期审计保留。

P1 不阻断首次发布；提前实施任何 P1 属范围扩张。

---

## 11. AC 索引

| AC | 主要 Checklist |
| --- | --- |
| AC-CAT-001~004 | CHK-PROD-001~008、CHK-UI-001~003 |
| AC-CAT-005~009 | CHK-INV-001~009、CHK-UI-004 |
| AC-CAT-010~017 | CHK-CAT-001~012、CHK-UI-005、007~008 |
| AC-CAT-018~023 | CHK-XBD-001~010、CHK-UI-006 |
| AC-CAT-024 | CHK-PROD-002、010、CHK-UI-006 |
| AC-CAT-025 | CHK-MIG-001~008 |
| AC-CAT-026 | CHK-CAT-012、CHK-PROD-005、CHK-OPS-001 |
| AC-CAT-027 | CHK-CAT-PAR-001~003、CHK-QA-006 |
| AC-CAT-028 | CHK-MIG-002~008、CHK-QA-001~006 |

---

## 12. Final Gate

- [ ] **CHK-CAT-FINAL-001** — 所有P0 checkbox有当前HEAD证据。
- [ ] **CHK-CAT-FINAL-002** — implement G-CAT-PR-001~010全Passed。
- [ ] **CHK-CAT-FINAL-003** — 所有P0 tasks Done，无Blocked/In Progress。
- [ ] **CHK-CAT-FINAL-004** — git diff、secret scan、migration/drift/parallel ownership audit通过。
- [ ] **CHK-CAT-FINAL-005** — Owner审阅证据、migration、发布和回滚后明确批准合并。
