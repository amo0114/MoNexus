# Parallel Contract: Catalog / Merchandising / Identity

| 字段 | 值 |
| --- | --- |
| 文档 ID | PAR-CMI-001 |
| 版本 | 0.1.1 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| 关联规格 | SPEC-CATALOG-OPS-001 v0.1.1 · SPEC-MERCH-001 v0.1.1 · SPEC-IDENTITY-SYNC-001 v0.1.0 |
| 批准人 | MoNexus Project Owner |
| 批准日期 | 2026-08-09 |
| 技术复审指纹 | Draft artifact SHA-256 `a6cbb48da46fd9987d5101b476f401e02e69d0786a8028ebda9c00ecc8f35841` |
| 并行中的外部工作 | SPEC-NOTIFY-RT-001，`feat/order-notification-realtime` |

本文件是三份规格审核通过后进行多 Agent 实施时的唯一跨规格协调契约。三份规格分别冻结业务语义；本文件只冻结共享文件所有权、前置提交、Worktree/数据库/端口隔离与合并顺序。它不是第四份业务规格。

Owner 已批准三份规格与本并行契约。v0.1.1 唯一修订把 CMI Foundation DAG 改为 `S→A_CMI→F0→B_CAT→F`；只有共同基线 `F` 记录后，Catalog/Merch 业务实施 lane 才可按各自 Entry Gate 启动（Identity lanes 仍从 `S` 启动）。

---

## 1. 为什么需要 Shared Foundation Gate

SPEC-CATALOG-OPS-001 与 SPEC-MERCH-001 都需要新增数据库模型，并最终影响公开商品投影。若两个实施 Agent 分别修改以下文件，就只能“同时开发、最后人工解冲突”，不能称为互不干扰：

- `server/prisma/schema.prisma`；
- `server/prisma/migrations/**`；
- `server/src/modules/products/service.ts` 与公开 Product DTO；
- `src/pages/StorePage.tsx`；
- 商家商品写 schema 中遗留的 `isHot`。

因此冻结一条串行且可证明的 CMI Foundation DAG：Foundation Owner 只落数据库结构、迁移与共享类型（`F0`），Catalog Category Bootstrap Owner 完成分类 bootstrap/resolver 与 required categoryId callers（`B_CAT`），协调者记录共同业务基线 `F`（可等于 `B_CAT`）。`F0`/`B_CAT` 都不解锁业务 lanes；只有 `F` 通过后，各 Catalog/Merch lane 从同一 `F` 分叉并行。

IDENTITY-SYNC 不依赖商品 Foundation，可以与 F0/B_CAT/F 链同时推进；它的 `Layout.tsx` 集成卡必须等待通知实时化对该文件的 Owner 释放。

~~~text
latest origin/develop D
          │ Owner approval（v0.1.0 freeze）
          ▼
Frozen spec-only SHA S（S^ = D；docs-only v0.1.0）
          ├──────────────► Identity Backend + Core/FE（S 为祖先；不碰 Layout/auth middleware）
          │
          ▼
A_CMI（v0.1.1 docs-only amendment；A_CMI^ = S；只改 PAR + Catalog/Merch 六件套；不碰 Identity）
          │
          ▼
Foundation schema tip F0（从 A_CMI 分叉；单 owner；schema/migrations/shared-contracts；categoryId 最终 NOT NULL）
          │
          ▼
Catalog Category Bootstrap B_CAT（从 F0 分叉；分类 bootstrap/resolver + required categoryId callers；串行特殊卡）
          │
          ▼
共同业务基线 F（全量 Foundation qualification Gate；B_CAT 为 F 祖先；F 可等于 B_CAT；只有 F 解锁业务 lanes）
          │
  ┌────────┼──────────────┐
  ▼        ▼              ▼
Catalog BE  Catalog FE    Merchandising BE/FE
           │              │
           └─► Catalog host release SHA H
  └────────┴──────────────┘
                      ▼
     CMI merge baseline M_CMI（F + lane tips + H 共同可达）
                      ▼
     CMI Integration Owner（products/Store/hosts）
                      ▼
                Cross-spec QA

Notification release N + Identity Core/FE C_ID
                      ▼
Identity merge baseline M_ID ─► Identity Integration Owner ─► Identity QA
~~~

---

## 2. 分支、Worktree、数据库和端口

本规格冻结以下可证明 DAG；“最新 develop”只能用于产生 `S`，不能绕过 `S` 直接成为实施分支基线：

- `D`：Owner Freeze 时记录的最新 `origin/develop` SHA；
- `S`：以 `D` 为直接父提交、只包含三套六件套与 PAR-CMI-001 的 Frozen spec-only commit（v0.1.0）；
- `A_CMI`：本次 v0.1.1 docs-only amendment，直接父为 `S`；只修改 PAR-CMI-001 与 Catalog/Merch 六件套；实际 SHA 在 commit 后由协调者记录，不在文档伪造自引用；
- `F0`：Foundation Owner 从 `A_CMI` 分叉的 schema/migrations/shared-contracts tip；包含 Catalog+Merch 全部冻结 models/constraints，`Product.categoryId` 完成 nullable→backfill→zero-null→最终 NOT NULL；通过 §3.2 F0 schema Gate；F0 不要求完整 application/server build（required categoryId 在 `B_CAT` 前会使既有 callers 类型不兼容）；
- `B_CAT`：Catalog Category Bootstrap Owner 从 `F0` 分叉的独立原子提交；只含分类 bootstrap/resolver、legacy type→categoryId resolution、required categoryId 编译必需的 Product create/upsert production callers、seed、test helpers/fixtures 与必要输入类型；通过 §3.3；
- `F`：完整 Foundation qualification Gate 合格后的共同业务基线；`B_CAT` 必须是其祖先（若 `B_CAT` tip 已通过全量 Gate，`F` 可等于 `B_CAT`；禁止空 evidence commit）；只有 `F` 解锁业务 lanes；
- `H`：Catalog Frontend 完成所有 `AdminPage.tsx`/`MerchantDashboardPage.tsx` Catalog-owned 修改后的 host release tip；`F` 必须是其祖先；
- `M_CMI`：使 `F`、Catalog BE tip、`H`、Merch BE tip、Merch FE/Assets tip 全部成为祖先的 CMI merge baseline；CMI wiring 从它开始；
- `N`：通知 Owner 释放 `Layout.tsx` 的 notification release SHA；
- `C_ID`：包含所需 Identity Core/FE commits 的 handoff tip，且 `S` 为其祖先；
- `M_ID`：同时以 `N` 与 `C_ID` 为祖先的 Identity Layout merge baseline；Identity Layout 只能从它开始。

任何较新的 `origin/develop` 只能通过显式 merge/rebase 纳入，同时仍须保持相应 `S/A_CMI/F0/B_CAT/F` 的祖先关系并重跑 delta Gate。禁止从当前分叉的 `wip/root-mixed-20260808` 创建实施分支。

| Lane | 建议分支 | 独立 Worktree | 专用测试库 | 必含祖先/起始基线 | Backend | Frontend |
| --- | --- | --- | --- | --- | ---: | ---: |
| Shared Foundation | `feat/catalog-merch-foundation` | `/root/projects/worktrees/monexus-catalog-merch-foundation` | `monexus_test_catalog_merch_foundation` | 从 `A_CMI` 分叉；产出 `F0`（schema tip） | 3120 | 不启动 |
| Catalog Category Bootstrap | `feat/catalog-category-bootstrap` | `/root/projects/worktrees/monexus-catalog-category-bootstrap` | `monexus_test_catalog_bootstrap` | 从 `F0` 分叉；产出 `B_CAT`（串行特殊卡；`F` 记录后释放） | 3129 | 不启动 |
| Catalog Backend | `feat/catalog-ops-backend` | `/root/projects/worktrees/monexus-catalog-ops-backend` | `monexus_test_catalog_ops_be` | 从 `F` 分叉 | 3121 | 不启动 |
| Catalog Frontend | `feat/catalog-ops-frontend` | `/root/projects/worktrees/monexus-catalog-ops-frontend` | `monexus_test_catalog_ops_fe` | 从 `F` 分叉；产出 `H` | 3122 | 5192 |
| Merch Backend | `feat/merchandising-backend` | `/root/projects/worktrees/monexus-merchandising-backend` | `monexus_test_merch_be` | 从 `F` 分叉 | 3123 | 不启动 |
| Merch Frontend / Assets | `feat/merchandising-frontend` | `/root/projects/worktrees/monexus-merchandising-frontend` | `monexus_test_merch_fe` | 从 `F` 分叉 | 3124 | 5194 |
| Identity Backend | `fix/identity-profile-cache-contract` | `/root/projects/worktrees/monexus-identity-profile-backend` | `monexus_test_identity_backend` | 从 `S` 分叉 | 3125 | 不启动 |
| Identity Core / FE | `fix/identity-profile-sync` | `/root/projects/worktrees/monexus-identity-profile-sync` | `monexus_test_identity_sync` | Core 从 `S`；FE 从包含 `S` 的 Core contract tip | 3127 | 5195 |
| Identity Layout Integration | `fix/identity-profile-layout-integration` | `/root/projects/worktrees/monexus-identity-profile-layout` | `monexus_test_identity_layout` | 从 `M_ID` 开始 | 3128 | 5198 |
| Cross-spec Integration | `feat/catalog-merch-integration` | `/root/projects/worktrees/monexus-catalog-merch-integration` | `monexus_test_catalog_merch_integration` | 从 `M_CMI` 开始 | 3126 | 5196 |

只有共同基线 `F` 解锁 Catalog/Merch 业务 lanes；`F0` 与 `B_CAT` 都不能。若 `B_CAT` tip 已通过全量 Gate，协调者记录 `F = B_CAT`；否则由唯一 Foundation Owner 提交 corrective delta 后记录该 tip 为 `F`。禁止空 evidence commit。

隔离规则：

1. Playwright 全部 `reuseExistingServer=false`、Vite `strictPort=true`。
2. 任何 destructive DB 命令前解析 URL，并断言数据库名与本表精确相等。
3. Agent 只能停止自己记录的 PID、容器 project 与临时目录。
4. 禁止使用默认 `monexus_test`、通知规格的 `monexus_test_notification_realtime`、端口 3112/3113/5182。
5. 不访问 staging/production 数据库、真实商家、真实推广或真实订单。

每条 Gate 的 Evidence Ledger 必须记录实际 SHA，并保存以下命令的 exit 0；仅记录“基于/包含”文字不构成证据：

~~~bash
git merge-base --is-ancestor <D> <S>
git merge-base --is-ancestor <S> <A_CMI>
git merge-base --is-ancestor <A_CMI> <F0>
git merge-base --is-ancestor <F0> <B_CAT>
git merge-base --is-ancestor <B_CAT> <F>      # B_CAT 必须为 F 祖先（相等时对同一 commit 仍 exit 0）
git merge-base --is-ancestor <F> <catalog-or-merch-lane-tip>
git merge-base --is-ancestor <H> <M_CMI>
git merge-base --is-ancestor <catalog-or-merch-lane-tip> <M_CMI>
git merge-base --is-ancestor <N> <M_ID>
git merge-base --is-ancestor <C_ID> <M_ID>
~~~

---

## 3. CMI Foundation DAG — F0 / B_CAT / F

### 3.1 节点定义（v0.1.1 Owner 批准的唯一修订）

- `A_CMI`：本次 v0.1.1 docs-only amendment，直接父为 `S`；只修改 PAR-CMI-001 与 Catalog/Merch 六件套；实际 SHA 在 commit 后由协调者记录，不在文档伪造自引用。
- `F0`：Foundation Owner 从 `A_CMI` 分叉的 schema/migrations/shared-contracts tip；只落 Foundation Owned files。
- `B_CAT`：Catalog Category Bootstrap Owner 从 `F0` 分叉的独立原子提交；串行特殊卡。
- `F`：完整 Foundation qualification Gate 合格后的共同业务基线；`B_CAT` 必须是其祖先；只有 `F` 解锁业务 lanes。

### 3.2 F0 — Foundation schema tip（唯一 Owner）

Foundation Owner 独占：

- `server/prisma/schema.prisma`；
- 本波 Catalog/Merch migrations；
- 新增的纯类型/常量契约文件；
- migration replay / drift 专用测试。

其他 Agent 在 `F0` 合并前只能用规格中的 DTO fixture 开发纯前端或纯算法模块；不得自行创建“临时 schema”或第二套 migration。

Foundation Worktree 必须从 `A_CMI` 分叉；`F0` 的证据必须证明 `A_CMI` 是祖先。Foundation Owner 不得从另一个“更新的 develop”重建一条不包含 `A_CMI` 的平行提交链。

`F0` 包含 Catalog+Merch 全部冻结 models/constraints。`Product.categoryId` 在 `F0` 完成 nullable→backfill→zero-null→最终 NOT NULL；禁止最终 nullable、DB default/trigger，或把收紧推迟给业务 lane。

`F0` 明确不要求完整 application/server build：required categoryId 在 `B_CAT` 完成前会使既有 callers 类型不兼容。

#### F0 必须包含（Foundation Owned files）

Catalog 结构：

- `ProductCategory`；
- `CategoryApplication`；
- `Product.categoryId` 关系与历史回填（最终 NOT NULL）；
- `Product.status` 支持 `draft`；
- `Product.publishedAt` 与 legacy active/inactive 回填；
- `ExternalCatalogLink`；
- `Offer(externalIntegration, externalSku)` 数据库唯一约束及重复数据 preflight。

Merchandising 结构：

- `MerchandisingRun`，含 completed/failed terminal fields/status CHECK、全局 single-running partial unique、completed active 查询索引与 stale-running timeout SystemConfig；
- `ProductMerchandisingSnapshot`；
- `PromotionPackage`；
- `PromotionCampaign`；
- `EditorialFeature`；
- `MerchantEntitlement`；
- `MerchandisingRun → Snapshot → Product/Category` FK/onDelete/CHECK；
- PromotionCampaign 与 Merchant/Product/Package/User/PointLog 的 FK/onDelete、charge/refund unique、create/adjustment idempotency key+hash/checks、adjustmentDecidedAt/by/reason 字段；
- `(productId,placementSnapshot)` 对 `scheduled|active|paused` 的 partial unique；
- PointLog charge/refund 命名反向关系与幂等关联字段，以冻结规格批准后的“scheduled全退、active/paused最多一次0..charge调整”语义。

共享契约：

- Catalog/category DTO 与稳定 code；
- public Product `category` 与 `merchandising` projection 类型；
- badge code、placement、campaign status、category application status 常量；
- `Product.isHot` 标记为 deprecated，禁止新增业务依赖。

#### F0 禁止包含（Foundation Owned files）

- 分类 CRUD/审核 service；
- 热卖计算 job；
- 推广购买/退款业务；
- 商家/管理员页面；
- `StorePage.tsx` 或公开商品查询整合；
- 头像、通知或 Layout 修改；
- Image 2 产物。

#### F0 schema Gate 证据（不是 F full build Gate）

- `prisma format` / `prisma validate` / `prisma generate` 全绿；
- 空库与 legacy-clean fixture `prisma migrate deploy` / `migrate status` / `migrate diff` 通过、无 drift；
- dirty preflight（external duplicate 等）expected-fail 清晰报错，不静默删除；
- 数据库约束测试、categoryId zero-null、feature-free diff 通过。

### 3.3 B_CAT — Catalog Category Bootstrap（串行特殊卡）

Catalog Category Bootstrap Owner 从 `F0` 分叉，唯一 Owned：

- 分类 bootstrap/resolver 与 legacy type→categoryId resolution；
- 所有 required categoryId 编译必需的 Product create/upsert production callers；
- seed、test helpers/fixtures 与必要输入类型（merchant/admin/Xboard/seed）。

禁止：完整 category CRUD/application/publish/public projection/Store/merchandising；不得修改 schema/migrations。

`B_CAT` 是业务 lanes 前的串行特殊卡：`F0` 与 `B_CAT` 都不能解锁业务 lanes。`B_CAT` 串行阶段独占其 caller/fixture 文件；`F` 记录后释放，Catalog backend 按原卡接管，不得制造双 Owner。

### 3.4 F — 共同业务基线（只有 F 解锁业务 lanes）

- 所有 Catalog/Merch lanes 只能从 `F` 分叉；`B_CAT` 必须是 `F` 祖先。
- 若 `B_CAT` tip 已通过全量 Gate，`F` 可等于 `B_CAT`；禁止空 evidence commit。
- 若需 Foundation-owned corrective delta，由唯一 Foundation Owner 提交后记录该 tip 为 `F`。

### 3.5 F full build Gate 证据

在 `F0`/`B_CAT` 基础上，`F` 必须额外同时证明：

- 从空库 `prisma migrate deploy` 成功；
- 从带四类商品、未知 legacy `type`、多 Offer、Xboard Offer 的基线 fixture 升级成功；
- category 回填后零 `Product.categoryId IS NULL`；
- 已有 external SKU 重复时 migration 以可理解 preflight 失败，不静默删除；
- migration rollback 文档明确，且不声称自动回滚已完成的数据迁移；
- `prisma migrate status`、`prisma migrate diff`、数据库约束测试与 build 全绿；
- `F0` diff 严格 feature-free（不含 feature service/UI）；
- `B_CAT` 只允许已批准的 bootstrap/resolver/required-categoryId callers/fixtures；
- `F` 聚合 diff 除 `F0` 与 `B_CAT` 明确范围外，不得包含其他 Catalog/Merch 业务或任何 UI。

只有 `F` Gate 通过且 SHA 被协调者记录后，Catalog/Merch lanes 才能从 `F` 作为共同父提交分叉。

---

## 4. 文件所有权矩阵

| 文件/区域 | 唯一 Owner | 其他 lane 的接入方式 |
| --- | --- | --- |
| `server/prisma/schema.prisma`、本波 migrations | `F0`（Foundation Owner） | 禁止直接修改；提出 delta 交回 Foundation Owner；`F0` 后由 `F` 基线继承，业务 lanes 仍只读 |
| 分类 bootstrap/resolver、legacy type→categoryId resolution、required categoryId 编译必需的 Product create/upsert production callers、seed、test helpers/fixtures 与必要输入类型 | `B_CAT`（Catalog Category Bootstrap Owner，串行阶段独占；`F` 记录后释放） | `F` 记录后 Catalog backend 按原卡接管；不得制造双 Owner |
| `server/src/modules/products/service.ts`、controller/routes/schema | CMI Integration Owner | Catalog/Merch 提供独立 adapter 和 contract tests |
| `src/pages/StorePage.tsx` | CMI Integration Owner | Catalog 提供 CategoryFilter；Merch 提供 SponsoredShelf/BadgeMark |
| `server/src/modules/merchant/schema.ts`、`service.ts` | Catalog Backend Owner | Merch 的 `isHot` 禁写要求以 contract test 交给该 Owner 落地 |
| `server/src/modules/admin/service.ts` | Catalog Backend Owner | Merch 使用独立 `modules/merchandising`，不得编辑 admin service |
| `src/pages/AdminPage.tsx`、`src/pages/MerchantDashboardPage.tsx` | Catalog Frontend Owner 持有整文件写锁直至 `H`；记录 `H` 后整文件锁一次性移交 CMI Integration Owner | Merch 只交独立子组件；CMI 在 `H` 之后仅 mount 已完成组件，不重写 Catalog 内部逻辑 |
| `server/src/lib/businessRegistry.ts` | Catalog Backend Owner | 仅保留非分类静态 registry；Merch 禁止修改 |
| `src/types/merchant.ts`、`src/api/merchant.ts` | Catalog Frontend Owner | Merch 新建独立 types/api 文件 |
| `src/pages/merchant/ProductCreateWizard.tsx`、`src/components/merchant/MerchantProductFormModal.tsx` | Catalog Frontend Owner | 同时移除 isHot 并统一 category/delivery 语义；Merch 只交 contract fixture |
| `src/types/merchandising.ts`、`src/api/merchandising.ts`、`components/merchandising/**` | Merch Frontend Owner | Store integration 只 import 公开组件 |
| `server/src/modules/merchandising/**` | Merch Backend Owner | Catalog 只调用公开 projection adapter |
| `server/src/modules/auth/controller.ts` 的 GET/PATCH me header + profile tests | Identity Backend Owner | 不修改 auth middleware/token/session service |
| `src/stores/authStore.ts`、`src/auth/profileSync*` | Identity Core Owner；最终 raw-writer closure 时显式转 Identity Integration Owner | 通知只消费公开 login/user 状态，不修改 identity internals |
| `src/api/auth.ts`、`src/api/authRefresh.ts` 的 profile/refresh guard 区域 | Identity Core Owner | 保持 refresh cookie rotation；其他规格只消费 API |
| `ProfileIdentityCard.tsx`、`MobileNavDrawer.tsx`、`App.tsx`、identity avatar components | Identity Frontend Owner | 不修改 Layout/appStore/notification |
| `src/components/Layout.tsx` | 通知 T-FE-002，释放后转 Identity Integration Owner | 不能同时编辑；每次移交记录 commit |
| `server/src/middlewares/auth.ts` | 通知 realtime 直至其相关卡完成 | Identity 规格不得修改该文件 |
| `src/stores/appStore.ts`、notification realtime files | 通知 realtime | Catalog/Merch/Identity 禁止修改 |

共享热点的“唯一 Owner”是文件级写锁，不是代码审查建议。未持锁 Agent 发现需要改动时，只能提交 contract fixture、adapter 或变更请求；不得顺手编辑。

---

## 5. 并行 Lane 输出契约

### 5.1 Catalog Backend

只输出分类/申请、draft/publish、Offer 库存、Xboard import preview/confirm 与 ExternalCatalogLink service/API；不修改公开商品 projection、不实现 badge/推广。

### 5.2 Catalog Frontend

只输出可复用 CategorySelect/CategoryApplication、商品 draft/publish、Offer-first 库存工作台、管理员手工商品与 Xboard preview UI；不修改 StorePage、不实现热卖 badge。Catalog-owned host 修改全部完成并通过测试后，协调者把 Catalog FE tip 记录为 `H`，同时释放 `AdminPage.tsx` 与 `MerchantDashboardPage.tsx` 的整文件锁；`H` 之后 Catalog Frontend 不得再编辑这两个文件，除非先暂停 CMI 卡并登记一次新的反向移交。

### 5.3 Merch Backend

只输出 `modules/merchandising/**`：snapshot job、推广套餐/活动、积分扣款、editorial/entitlement、public projection adapter；不修改 Product/merchant/admin 既有 service。

### 5.4 Merch Frontend / Assets

只输出 `components/merchandising/**`、独立 API/types、管理/商家推广子页面和经审核的资产；不得直接修改 StorePage、AdminPage、MerchantDashboardPage 或 Layout。宿主页面在 `H` 记录后由 CMI Integration Owner 接入。

### 5.5 Identity Backend / Core / Frontend

Identity Backend 只输出 auth controller no-store/完整 projection tests；Identity Core 只输出 auth profile coordinator/store/auth API refresh guard；Identity Frontend 只输出 ProfileIdentityCard/UserAvatar/Mobile/App/显式 workflow 接线。三者使用独立 Worktree，以已提交 contract 交接；都不修改 Layout、appStore、notification 模块或 auth middleware。

### 5.6 CMI Integration Owner

在 `M_CMI` 已建立、所有 lane commit 通过自身 DoD 且 Catalog host release `H` 已记录后才工作，独占：

- public Product projection 调用 Catalog/Merch adapters；
- StorePage 组合 CategoryFilter + SponsoredShelf + BadgeMark；
- 持有 `AdminPage.tsx`、`MerchantDashboardPage.tsx` 整文件写锁并挂载已经完成的 Catalog/Merch 子组件；
- 只做 CMI wiring，不重写 Catalog/Merch lane 内算法或 `H` 中的 Catalog 逻辑。

`T-CAT-INT-001` 与 `T-MERCH-INT-001` 必须由同一 CMI Integration Owner/Worktree 串行执行；它们不是两个可以同时持有 shared files 的 Agent。

### 5.7 Identity Integration Owner

在 `M_ID` 已建立且通知 Owner 已释放文件锁后才工作，独占：

- 将 Layout 的裸 `/auth/me` 调用替换为 identity coordinator，并接入 desktop `UserAvatar`/visibility calibration；
- Layout 和所有 profile caller 迁移后，按 T-ID-INT-002 单独删除 authStore deprecated raw writer；
- 只做 Identity wiring，不重写 notification 或 Identity Core 算法。

---

## 6. API/DTO Contract-first 规则

1. `F0` commit 固定 DTO fixture 后，前后端可各自在独立 worktree 并行（`B_CAT` 只补 required categoryId callers/fixtures，不新增业务 DTO）。
2. 前端不得从页面代码猜测数据库字段；只依赖公开 DTO。
3. 后端不得因前端实现方便而泄露 InventoryItem.content、支付明细、内部推广审核备注或外部对象 key。
4. Contract fixture 变化必须先更新对应 SPEC 的 D/REQ/AC 和版本；Frozen 后需重新 Owner 批准。
5. CMI Integration Owner 只能消费已通过 contract tests 的 adapter；不得在共享热点复制一份分类/热卖逻辑。

---

## 7. 通知实时化隔离

SPEC-NOTIFY-RT-001 当前独立 Worktree：

`/root/projects/worktrees/monexus-order-notification-realtime`

Catalog/Merch/Identity Agent 绝对禁止：

- 进入该 Worktree 写文件、切分支、stash、reset 或清理；
- 修改 `server/src/modules/notifications/**`、realtime protocol、notification dispatcher；
- 使用通知专用 DB/端口；
- 为商品/推广变化新增通知事件（另立增量规格）；
- 覆盖通知 Agent 对 `server/src/middlewares/auth.ts`、`Layout.tsx`、`appStore.ts` 的改动。

当前 Catalog/Merch 功能不依赖实时通知。未来“推广审核结果”“分类申请结果”是否产生站内通知属于范围外，必须在通知规格完成后另立事件矩阵增量。

---

## 8. 合并顺序与 Commit 粒度

固定顺序：

1. 协调者记录最新 `origin/develop` 为 `D`；Owner 批准三份 Draft 与 PAR-CMI-001 后，以 `D` 为直接父提交创建 docs-only Frozen spec-only commit `S`（v0.1.0，已完成）。
2. Owner 于 2026-08-09 批准 v0.1.1 CMI Foundation DAG 唯一修订；协调者以 `S` 为直接父提交创建 docs-only amendment `A_CMI`（只改 PAR-CMI-001 与 Catalog/Merch 六件套，不碰 Identity）。
3. Foundation Owner 从 `A_CMI` 分叉，单 Owner 落 shared schema/migrations/contracts 并通过 F0 schema Gate，记录 Foundation schema tip `F0`；Identity Backend/Core 也从 `S` 分叉并可并行。
4. Catalog Category Bootstrap Owner 从 `F0` 分叉，以独立原子提交完成分类 bootstrap/resolver 与 required categoryId callers，记录 `B_CAT`；`F0`/`B_CAT` 均不解锁业务 lanes。
5. 协调者运行完整 Foundation qualification Gate：若 `B_CAT` tip 通过全量 Gate，记录 `F = B_CAT`；否则由唯一 Foundation Owner 提交 corrective delta 后记录该 tip 为 `F`。只有 `F` 解锁业务 lanes。
6. Catalog BE/FE 与 Merch BE/FE/Assets 全部从 `F` 分叉；Identity Frontend 从包含 `S` 的 Core contract commit 开始。每个原子 Task 独立 commit，禁止一个 commit 同时包含 schema、业务、UI 和证据回填。
7. Catalog FE 的全部 host 修改完成后记录 `H`，把 `AdminPage.tsx`、`MerchantDashboardPage.tsx` 整文件锁移交给 CMI Integration Owner；此后 Catalog FE 不再写这两个文件。
8. 协调者建立 `M_CMI`，证明 `F`、Catalog/Merch 各 lane tip 与 `H` 都是其祖先；CMI Integration Owner 从 `M_CMI` 开始，按“backend adapters → public projection/StorePage → frontend hosts”串行接线。
9. 通知 T-FE-002 完成并记录 release `N`；协调者建立同时包含 `N` 与 Identity Core/FE handoff `C_ID` 的 `M_ID`。Identity Integration Owner 只能从 `M_ID` 做 Layout 接线，全部 caller 清零后再以独立 commit删除 raw writer。
10. 合并 Identity Backend → Core/FE → Layout → writer closure；所有最终候选 HEAD 必须保留 `S` 祖先，Catalog/Merch/CMI 还必须保留 `F` 祖先。分别运行专用 Gate，最后运行 Cross-spec regression。

禁止：

- 多 Agent 直接向同一个共享 worktree 写文件；
- 用“最后解决冲突”替代文件锁；
- cherry-pick 一个包含未拆分共享热点的大 commit；
- 为让分支编译而提交临时重复 model/type；
- force push、reset --hard、clean -fd、改写他人 migration。

---

## 9. Cross-spec Gate

- [ ] PAR-GATE-001：三份规格各自六件套的版本/状态/基线内部一致（Catalog/Merch v0.1.1、Identity v0.1.0）；PAR 已记录各规格批准版本与基线；Owner 批准后统一 Frozen，docs-only `S`（父 `D`）与 v0.1.1 docs-only amendment `A_CMI`（父 `S`）已记录。
- [ ] PAR-GATE-002：Foundation schema tip `F0`、Bootstrap `B_CAT`、共同基线 `F`、migration names、schema owner 已记录；`S→A_CMI→F0→B_CAT→F` 各 ancestor 命令为 exit 0（`B_CAT→F` 允许相等，相等时对同一 commit 仍 exit 0）。
- [ ] PAR-GATE-003：所有实施 worktree、DB、ports 唯一，且与通知任务不重叠。
- [ ] PAR-GATE-004：`schema.prisma` 与本波 migrations 只有一个 owner/提交链。
- [ ] PAR-GATE-005：`products/service.ts`、`StorePage.tsx` 只有 CMI Integration Owner 修改；`AdminPage.tsx`、`MerchantDashboardPage.tsx` 的 Catalog 整文件锁、host release `H`、CMI 整文件锁移交与 `H→M_CMI` 祖先证据完整。
- [ ] PAR-GATE-006：`Layout.tsx` 有明确从通知到 Identity 的移交 commit；`N` 与 `C_ID` 均为 `M_ID` 祖先，无同时写入。
- [ ] PAR-GATE-007：每个 lane 的 contract tests、DoD、commit 清单齐全。
- [ ] PAR-GATE-008：F0 schema Gate（`prisma format/validate/generate`、empty 与 legacy-clean `migrate deploy/status/diff`、dirty preflight expected-fail、DB constraints/zero-null/feature-free diff，不要求完整 build）与 F full build Gate（replay、drift、build 全绿）分别完成、不混淆。
- [ ] PAR-GATE-009：Catalog/Merch/Identity 各自专用 suite 全绿，通知相关回归无退化。
- [ ] PAR-GATE-010：最终集成没有敏感库存、token、审核备注、对象 key 或支付内部字段泄露。
- [ ] PAR-GATE-011：`S/A_CMI/F0/B_CAT/F/H/M_CMI/N/C_ID/M_ID`、Identity Backend/Core/FE/Layout 与 raw-writer closure 的 parent SHA/Owner/ancestor 命令证据完整。

任一 Gate 未满足，不能宣称三线可以安全并行合并。

---

## 10. 变更控制

- Draft 阶段 Owner 可调整 lane 与 ownership；须同步三份 `implement.md` 和 `task.md`。
- Frozen 后改变 Foundation 数据模型、共享热点 owner/host release、`S→A_CMI→F0→B_CAT→F→lane→M_CMI` 或 `N+C_ID→M_ID` 祖先关系、合并顺序或通知边界，必须把 PAR-CMI-001 与受影响规格退回 Draft。
- 实施中发现新的共享热点时，协调者先暂停相关两张卡、登记唯一 owner，再继续；禁止双方同时修改。

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-09 | Frozen for Implementation | Owner 批准：Shared Foundation Gate、整文件锁移交、可证明 DAG、Worktree/DB/端口和通知隔离 |
| 0.1.1 | 2026-08-09 | Frozen for Implementation | Owner 批准唯一修订：CMI Foundation DAG 改为 S→A_CMI→F0→B_CAT→F；F0/B_CAT 不解锁业务 lane、只有 F 解锁；Catalog/Merch 六件套升 v0.1.1、Identity 保持 v0.1.0 |
