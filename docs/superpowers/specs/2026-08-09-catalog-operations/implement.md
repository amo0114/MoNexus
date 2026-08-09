# Implement Protocol: 商品目录、分类治理与库存操作

| 字段 | 值 |
| --- | --- |
| 文档 ID | IMPL-CATALOG-OPS-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all Implement cards Pending** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) · [checklist.md](./checklist.md) |
| 并行契约 | [PAR-CMI-001](../2026-08-09-catalog-merch-identity-parallel-contract.md) |

---

## 1. 入口门槛

- [ ] IMPL-CAT-ENTRY-001：Owner 已逐项批准 O-CAT-01~11。
- [ ] IMPL-CAT-ENTRY-002：Catalog 六件套内部版本/状态/基线一致，PAR 记录批准版本；全部 Frozen，docs-only `S` 及直接父提交 `D` 已记录。
- [ ] IMPL-CAT-ENTRY-003：实施 Agent 已完整阅读六件套、PAR-CMI-001 和两份产品基础设计。
- [ ] IMPL-CAT-ENTRY-004：已 fetch origin；`S^=D`，当前 Foundation/lane HEAD 对 `S/F` 的 ancestor 命令与 delta audit 已记录。
- [ ] IMPL-CAT-ENTRY-005：通知 realtime 当前 HEAD/未提交 shared hotspots 已记录，未进入其 worktree。
- [ ] IMPL-CAT-ENTRY-006：Foundation Owner、migration names/DB、`F`、Catalog host release `H`（未到阶段则明确 Pending）和 CMI handoff 已登记。
- [ ] IMPL-CAT-ENTRY-007：当前 Implement 卡 Owned/Must Not Touch/DoD 已复制到活动卡。
- [ ] IMPL-CAT-ENTRY-008：专用 Worktree/DB/ports 已验证唯一且空闲。
- [ ] IMPL-CAT-ENTRY-009：不需要生产 DB/Xboard/storage secret/真实商品；fixture provider 已准备。
- [ ] IMPL-CAT-ENTRY-010：任何新增 sanitizer 依赖已由 Owner 明确批准并锁定版本；否则停止。

任一项未满足不得编码。规格已 Frozen 不等于当前 Implement 卡的 Entry Gate 已通过。

---

## 2. Git 与 Worktree

规格只写 worktree：

`/root/projects/worktrees/monexus-catalog-inventory-merchandising`

实施使用 PAR-CMI-001 表中的独立 worktrees。规则：

- `S` 必须以 Freeze 时最新 develop `D` 为直接父提交且只含 docs；Foundation 从 `S` 分叉并产出 `F`；
- Catalog BE/FE、Merch BE/FE 全部从 `F` 分叉，任何较新 develop 合并都必须保留 `S/F` 祖先；
- CMI Integration 只能从 `M_CMI` 开始；`F`、Catalog/Merch lane tips 与 host release `H` 必须都是 `M_CMI` 祖先；
- 每张卡一个或多个原子 commit，但每个 commit 只包含一个业务意图；
- shared hotspot 只能在指定 Integration worktree 修改；
- 禁止在 `/root/projects/MoNexus-new` 当前 WIP 或通知 worktree 实施；
- 禁止 reset --hard、clean -fd、强推、覆盖未提交修改或改写 migration。

活动卡开工记录：

~~~text
Implement card:
Task:
Status: Pending | In Progress | Blocked | Done
Agent:
Start HEAD / merge-base:
Frozen spec-only SHA S / parent D:
Foundation SHA F:
Catalog host release H / lock owner:
Required ancestor checks:
Worktree / branch:
DB name / ports:
Owned files:
Shared locks held:
Must Not Touch:
Target tests:
Rollback:
~~~

完成补充：

~~~text
End HEAD / commits:
Changed files:
Commands + exit codes + test counts:
REQ / AC / CHK evidence:
Migration/data counts:
Known limitations:
Next CMI Integration Owner:
Released whole-file locks / release SHA:
~~~

---

## 3. Runtime、数据库与外部 fixture

| 项 | 契约 |
| --- | --- |
| Node/npm | 仓库 engines；先执行 `npm run check:runtime` |
| PostgreSQL | 本地兼容版本；各 lane 使用 PAR-CMI 专用库 |
| Xboard | 本地 fixture HTTP server；不得访问真实实例 |
| Storage | memory/local fixture；不得写生产 bucket |
| Vite/Backend | PAR-CMI 固定 ports，strict/reuse=false |

Destructive database 操作前：

1. 关闭 shell xtrace；
2. 解析 URL；
3. 打印脱敏 host/port/db name；
4. 断言 db name 等于活动卡专用库；
5. 只终止本卡创建的连接/process。

Foundation migration suite 至少维护：

- `empty`；
- `legacy_clean`（四类+未知 type+无图 active+多 Offer）；
- `legacy_dirty_external_duplicate`（预期非零失败）；
- `legacy_dirty_offer_invariant`（预期非零失败）。

---

## 4. 文件锁

### 4.1 Shared Foundation 独占

- `server/prisma/schema.prisma`
- 本波 migrations
- shared DTO/constants

Foundation Gate 后，业务 Agent 对这些文件为只读。缺字段必须 Blocked/Ask First。

### 4.2 Catalog Backend 独占

- `server/src/modules/catalog/**`
- merchant/admin product/inventory区域按 task 交接
- `businessRegistry.ts`、config registry Catalog 区域

同一时刻 `merchant/service.ts` 和 `admin/service.ts` 各只能有一个 Catalog backend owner。

### 4.3 Catalog Frontend 独占

- `components/catalog/**`、catalog API/types
- ProductCreateWizard / MerchantProductFormModal / MerchantDashboard / AdminPage 分别在活动卡登记宿主整文件锁
- `AdminPage.tsx`、`MerchantDashboardPage.tsx` 仅持有到 Catalog host release `H`；`H` 后不得继续编辑

### 4.4 CMI Integration 独占

- `server/src/modules/products/**`
- `src/pages/StorePage.tsx`
- `src/pages/AdminPage.tsx`、`src/pages/MerchantDashboardPage.tsx`（仅在 `H` 后整文件接管）
- public Product cursor/cache接线

T-CAT-INT-001 与 T-MERCH-INT-001 由同一 CMI Integration Owner/Worktree 串行执行，不得拆给两个 Agent。

### 4.5 永不由本规格修改

- 通知 worktree 与 `server/src/modules/notifications/**`
- notification realtime protocol/dispatcher
- `src/components/Layout.tsx`、`src/stores/appStore.ts`
- `server/src/middlewares/auth.ts`
- orders 状态机、退款/结算、delivery secret授权
- production env/DB/storage/Xboard

---

## 5. 三色权限

### Green

- 当前卡 Owned files；
- 专用 DB/ports/fixture tests；
- 添加本卡 unit/integration/component/E2E；
- 填本卡证据和对应 Checklist；
- 只读检查其他 worktree/shared contract。

### Yellow — Ask First

- 任何 D-CAT/CAT/REQ/AC、API code/status、readiness 或 migration 语义变化；
- 非 Owned/shared hotspot；
- 新依赖、远程图片、AI、真实 provider；
- schema/migration delta（交 Foundation owner）；
- checkout/notification/low-stock/cache全局语义；
- rebase/merge 出现语义冲突。

### Red

- 访问/修改生产或 staging 数据；
- 输出 InventoryItem content、credential、object key、完整数据库 URL；
- 静默删除/合并脏 legacy 数据；
- 直接设置 Product active 绕过 publish；
- 用 page.reload/DB update/private method 伪造 E2E；
- 同时占用他人 shared hotspot；
- 破坏性 Git 或清理他人进程/worktree。

---

## 6. Implement 卡顺序

| 卡 | 映射 Task | 状态 | 进入条件 | 提交 Gate |
| --- | --- | --- | --- | --- |
| I-CAT-001 | T-CAT-DOC-001、T-FND-001 | Pending | Owner freeze → `S` | `S→F` ancestry + Foundation replay/drift Gate |
| I-CAT-002 | T-CAT-BE-001 | Pending | Foundation SHA | category registry/admin tests |
| I-CAT-003 | T-CAT-BE-002 | Pending | I-CAT-002 contract | application CAS/auth tests |
| I-CAT-004 | T-CAT-BE-003 | Pending | Foundation+category | draft/readiness/publish tests |
| I-CAT-005 | T-CAT-BE-004 | Pending | Foundation | inventory/capacity concurrency |
| I-CAT-006 | T-CAT-BE-005 | Pending | category+draft APIs | Xboard preview/idempotency/sanitizer |
| I-CAT-007 | T-CAT-BE-001～005 consolidation Gate | Pending | I-CAT-002～006 | backend build/contract fixtures |
| I-CAT-008 | T-CAT-FE-001 | Pending | frozen DTO | wizard/component tests |
| I-CAT-009 | T-CAT-FE-002 | Pending | inventory DTO | Offer-first E2E |
| I-CAT-010 | T-CAT-FE-003 | Pending | category DTO | category/application UI |
| I-CAT-011 | T-CAT-FE-004 | Pending | admin/Xboard DTO | platform/Xboard UI E2E |
| I-CAT-012 | T-CAT-INT-001 | Pending | `M_CMI` 建立、`H` 与全部 lane tips可达 | shared projection/Store/hosts contract |
| I-CAT-013 | T-CAT-QA-001 | Pending | DB code complete | empty/upgrade/dirty migration suite |
| I-CAT-014 | T-CAT-QA-002 | Pending | BE+integration | security/concurrency/perf Gate |
| I-CAT-015 | T-CAT-QA-003 | Pending | all P0 | E2E/compat/rollback/PR Gate |

BE 与纯组件工作可在 Foundation 后并行；I-CAT-009～011 一旦编辑 Admin/Merchant hosts，必须在同一 Catalog Frontend Worktree 按整文件锁串行，全部完成后产出 `H`。I-CAT-012 是唯一 shared integration 串行点。I-CAT-013、I-CAT-014 可并行，I-CAT-015 最后执行。

---

## 7. 实施纪律

### 7.1 Red → Green → Refactor

1. 先写会失败的行为/约束测试。
2. 实现最小代码。
3. 跑目标测试和直接受影响回归。
4. 绿色后再抽取 adapter/component。
5. 证据记录后才 Done。

### 7.2 人工复核清单

改 publish：确认同一 transaction 读取 readiness、写 status/publishedAt、同步投影/cache；无远程 I/O。

改库存：确认明确 Offer、confirm 重算、unique/CAS 最终裁决、log 同 transaction；响应无 content。

改分类：确认 code immutable、label rename 不回写 Product.type、inactive history 可读、审核 CAS+AdminLog。

改 Xboard：确认 preview 零写、confirm 重取/hash、cover注册、sanitizer、external DB unique、replay语义。

改 public Store：确认 active guard、category cursor/cache、Merch adapter调用、旧/new兼容。

### 7.3 邻近 bug

不属于 AC 的邻近问题只记录 file:line/影响/建议，不顺手修。若阻断本规格，使用 Ask First 模板并说明 scope/migration影响。

---

## 8. 分层验证入口

目标命令由相应 QA Task 创建；命令不存在不能记为 skip。

~~~bash
# 静态
npm run check:runtime
npm run build
cd server && npm run build

# Foundation/migration
bash scripts/verify-catalog-foundation.sh

# Backend
bash scripts/verify-catalog-ops-backend.sh

# Browser
npx playwright test --config playwright.catalog-ops.config.ts \
  e2e/catalog-product-lifecycle.spec.ts \
  e2e/catalog-category-governance.spec.ts \
  e2e/catalog-xboard-import.spec.ts

# Final
bash scripts/verify-catalog-ops.sh
git diff --check
~~~

既有至少回归：merchant inventory/images、offers、product commercial/database constraints、structured delivery、FakaBridge、multi-SKU、gallery、instant-fixed、checkout 和 notification相关 build/tests。

---

## 9. Evidence Ledger

| 时间 | HEAD | I/T | REQ/AC/CHK | 命令/动作 | 结果 | Artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 |

证据必须含 exit code、测试数、耗时、脱敏 DB/ports、fixture revision。Migration 证据含前后计数和 expected-failure。E2E 保留 trace/screenshot 路径；不得截图秘密库存文本。

---

## 10. PR Gate

| Gate | 要求 | 状态 | Evidence |
| --- | --- | --- | --- |
| G-CAT-PR-001 | 六件套/PAR Frozen、全部 P0 Task/CHK Done | Pending | 待填 |
| G-CAT-PR-002 | `D/S/F/H/M_CMI`、ancestor命令、delta与宿主整文件锁移交记录完整 | Pending | 待填 |
| G-CAT-PR-003 | empty/upgrade/dirty migration replay/status/diff通过 | Pending | 待填 |
| G-CAT-PR-004 | backend/frontend build与contract tests通过 | Pending | 待填 |
| G-CAT-PR-005 | 分类、publish、库存、Xboard 专用 suites通过 | Pending | 待填 |
| G-CAT-PR-006 | 既有 product/offer/checkout/Faka/notification回归通过 | Pending | 待填 |
| G-CAT-PR-007 | AC-CAT-001~028 当前 HEAD 证据完整 | Pending | 待填 |
| G-CAT-PR-008 | secret/XSS/SSRF/object-key/ownership审计通过 | Pending | 待填 |
| G-CAT-PR-009 | 性能预算、cache、compat、rollout/rollback演练通过 | Pending | 待填 |
| G-CAT-PR-010 | PR 含规格、migration、监控、风险、回滚、证据索引 | Pending | 待填 |

任一 Pending/Failed 不得宣称 ready to merge。

---

## 11. Blocked 模板

~~~text
Blocked card/task:
Current HEAD / Foundation SHA:
Exact blocker and evidence:
Shared hotspot owner:
Frozen decision affected:
Safe alternatives:
Recommended option:
Schema/migration/API impact:
Work safely completed:
~~~

---

## 12. 完成交接

~~~text
Outcome:
Branch / HEAD / D / S / F / H / M_CMI:
Spec version:
Tasks / commits:
Migrations and preflight counts:
API compatibility window:
Validation summary:
Security/media result:
Performance/cache result:
Rollout/rollback:
Known limitations:
PAR-CMI handoff owner:
PR Gate status:
~~~
