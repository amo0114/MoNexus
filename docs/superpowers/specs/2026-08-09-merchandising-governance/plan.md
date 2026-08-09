# Plan: 热卖、推广与平台身份展示

| 字段 | 值 |
| --- | --- |
| 文档 ID | PLAN-MERCH-001 |
| 版本 | 0.1.1 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 输入 | [spec.md](./spec.md) |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |

---

## 1. 工程目标

以独立领域模块提供可解释的 merchandising projection，禁止 Product 上继续累积“热卖/推广/认证”布尔字段。自然热卖、付费推广、编辑精选和商家合作权益各自拥有事实来源、生命周期、权限与展示位置。

非目标：法币/竞价/个性化推荐/点击归因/通知事件/订单状态变化/运行时AI。

---

## 2. 模块架构

~~~text
server/src/modules/merchandising/
  constants.ts
  contracts.ts
  ranking/
    repository.ts
    compute.ts
    lifecycle.ts
    cron.ts
  promotions/
    schema.ts
    service.ts
    billing.ts
    controller.ts
    routes.ts
  editorial/
    service.ts
  entitlements/
    service.ts
    cron.ts
  publicProjection.ts
  publicController.ts
  publicRoutes.ts
  adminRoutes.ts
  merchantRoutes.ts
  __tests__/**

src/components/merchandising/
  BadgeMark.tsx
  SponsoredShelf.tsx
  EditorialShelf.tsx
  MerchantPartnerMark.tsx
  PromotionPackagePicker.tsx
  PromotionCampaignPanel.tsx
  AdminPromotionManager.tsx
  AdminEditorialManager.tsx

src/api/merchandising.ts
src/types/merchandising.ts
~~~

边界：

- ranking只读Order/Product/Category，写run/snapshot；不改Product.sales/isHot。
- billing只通过既有PointAccount/PointLog transaction helper，不改Order/Settlement。
- publicProjection是Catalog products service的唯一接入adapter。
- Merch frontend输出独立组件；StorePage由 CMI Integration Owner 独占，AdminPage/MerchantDashboard 只在 Catalog host release `H` 后由同一 CMI Integration Owner 接收整文件锁并挂载。

---

## 3. Shared Foundation（F0 → B_CAT → F）

v0.1.1 修订后执行 DAG 为 `S→A_CMI→F0→B_CAT→F`。`F0`（Foundation Owner）从 `A_CMI` 分叉统一创建 MerchandisingRun、Snapshot、Package、Campaign、EditorialFeature、Entitlement及PointLog关联/partial unique。它必须落 Spec §5 的 FK/onDelete/CHECK、Run completed/failed terminal fields、全局 single-running partial unique、run-snapshot关系、Campaign charge/refund/adjustment 字段、幂等 key/hash checks 和 scheduled/active/paused placement unique；Merch Agent不得自行修改schema/migration。Merch 不参与 `B_CAT`，只消费最终共同基线 `F`；Merch schema 仍 `F0` 落地。

Foundation（F0）migration 前检查：

- legacy Product.isHot=true数量；
- PointAccount/PointLog约束和余额非负；
- Product/merchant ownership异常；
- SystemConfig key冲突；
- partial unique所需extension/数据库能力。

`F0` 只建结构/constraint/shared types（F0 diff 严格 feature-free）；不写run、不扣款、不创建package、不过滤Store。

---

## 4. 关键方案

### 4.1 Ranking run

- 单一cron owner，PostgreSQL advisory lock防多实例重复。
- config和数据库时间在run开始冻结。
- SQL聚合成功创建的 Order，window半开区间，排除refunded；pending/processing 人工单的积分为 hold/frozen，不使用“全部已扣款”的错误假设。
- 短事务先持久化 running；第二事务写全部 snapshots 并 CAS completed。失败时第二事务整体回滚，再由独立短事务 CAS failed；硬退出遗留 running 由 advisory lock owner 按 `hotRunTimeoutMinutes` 用数据库时间回收。
- active run查询使用“最新completed”，不使用全局内存布尔。
- retention worker只删超过48h成功snapshot/超过7d失败诊断，保留当前cursor run。

### 4.2 Organic integration

`publicProjection.decorate(products, runId)` 批量读取 snapshot/editorial/entitlement，禁止 N+1。CMI Integration Owner 负责：

- cursor编码runId/score/id/filterHash；
- list order与cache key；
- Product DTO挂载projection；
- Store组件组合。

Merch Agent用adapter contract tests证明输入ID→输出projection，不改products service。

### 4.3 Promotion billing

- PromotionPackage是价格事实；Campaign保存不可变snapshot。
- Campaign create 使用 `(merchantId,requestIdempotencyKey)` unique + Spec §11 版本化 canonical payload hash；adjustment 把 campaign-scoped key/hash 固定在唯一决定字段。两条路径共享 key validator/hash helper与冻结测试向量。
- admin approve / merchant retry使用同一billing函数和row lock。
- 条件扣PointAccount.balance，创建PointLog，再写campaign状态；idempotency由campaign chargePointLogId和状态CAS。
- payment_failed不创建point log。
- scheduled开跑前取消全额 refund；active/paused 以 `adjustmentDecidedAt IS NULL` 最多做一次 0..charge 的显式决定。金额>0原子增余额+唯一PointLog refund，金额=0只写不可变决定/AdminLog；两者均不可二次调整。
- 所有可用户重试的mutation支持Idempotency-Key或状态幂等。

### 4.4 Campaign lifecycle

- 共享cron/定时tick按数据库时间 scheduled→active、active→expired。
- paused仍占placement；暂停期结束时间P0不顺延，管理UI明确。
- Product/Merchant inactive只影响公开eligibility，不自动退款/延长；管理员决定cancel/adjust。
- public sponsored endpoint以10分钟bucket哈希轮换并缓存≤60s。

### 4.5 Editorial/Entitlement

- Editorial query按time+status+Product active，独立shelf。
- partner自动job聚合charged-refunded campaign积分，不读取PointLog reason文本。
- 自动grant/extend/expire幂等；manual grant/revoke走admin service。
- public projection只返回code/label/validUntil/tooltip所需最小字段。

### 4.6 Asset pipeline

Asset Agent独占design/output目录。先读取项目品牌资产作为reference，运行api-image脚本，检查输出，保存metadata/review。Runtime Agent只使用批准review中的视觉token重建SVG/CSS；概念PNG默认不进bundle。

CI检查：public runtime资产必须在approved manifest、sha256一致、总gzip≤150KiB；repo搜索不得出现API key/base_url。

---

## 5. 阶段

### Phase A — Freeze/Foundation/legacy cleanup

- Owner批准O-MERCH-01~12；
- F0 schema Gate → Catalog Category Bootstrap（`B_CAT`）→ 共同基线 `F`；只有 `F` 解锁业务 lanes；
- Product.isHot legacy count并迁移/cleanup false；
- SystemConfig keys和default package seed策略冻结。

### Phase B — Ranking repository/compute

- run lifecycle/advisory lock；
- Order聚合、排名、atomic completed、retention；
- manual recompute/admin runs。

### Phase C — Organic public adapter

- batch projection、cursor fixture、cache invalidation contract；
- no-run/failure/refund/tie tests；
- legacy isHot写拒绝合同交给Catalog backend owner。

### Phase D — Promotion packages/campaign/billing

- package admin CRUD；
- merchant request/list/cancel/retry；
- admin review/approve/reject/pause/resume/cancel/adjust；
- point concurrency/idempotency/placement unique。

### Phase E — Sponsored public/UI

- sponsored endpoint/rotation/disclosure；
- merchant campaign UI、admin manager；
- CMI Integration Owner 挂载 shelf。

### Phase F — Editorial/identity/partner

- editorial admin/public；
- platformOwned projection；
- partner auto/manual lifecycle；
- badge/tooltip/accessibility components。

### Phase G — Image 2 concept/runtime visual

- 参考项目品牌生成概念板；
- 人工review；
- runtime SVG/CSS/token；
- asset manifest/budget/a11y/visual regression。

### Phase H — Cross-spec integration/QA

- Catalog products service/StorePage单owner接线；
- 真实PG ranking/payment concurrency；
- storefront/merchant/admin E2E；
- points/orders/products/notification regression；
- performance/secret/disclosure审计。

### Phase I — 发布/回滚

- migrations+backend先上；
- ranking run完成但UI flag关闭；
- admin配置package/editorial；
- frontend canary；
- 移除legacy isHot展示；
- 观察后全量。

---

## 6. 并行边界

共同基线 `F` 后可并行：

- ranking backend；
- promotion backend；
- editorial/entitlement backend；
- frontend components/API/types；
- Image2 concept（不依赖生产代码）；
- QA fixture/harness。

文件锁：

- `modules/merchandising/ranking/**`、`promotions/**`、`editorial/entitlements/**`可分owner；
- PointAccount/points helper区域只Promotion billing owner修改；
- AdminPage/MerchantDashboard/StorePage不由Merch lane改；输出独立子组件给 CMI Integration Owner；
- AdminPage/MerchantDashboard 在 `H` 前由 Catalog Frontend 整文件持锁，`H` 后由 CMI Integration 整文件持锁；不存在 mount 区域并发锁；
- schema/migrations `F0` only（Foundation Owner）；Merch 不参与 `B_CAT`；products service/StorePage CMI Integration only；CMI 只能从包含 `F`、全部 lane tips 与 `H` 的 `M_CMI` 开始；
- notification/Layout/appStore绝对不改。

---

## 7. 测试策略

| 层 | 证据 |
| --- | --- |
| Unit | window边界、rank/tie/hot、cursor、hash rotation、status transition、禁词 |
| Real PG | atomic run、advisory lock、approve/charge、retry、cancel/refund、partial unique、100并发 |
| API | admin MFA、merchant ownership、public field allowlist、status/errors |
| Component | badge order/max、disclosure、tooltip、package/campaign flows、unknown code |
| Browser | organic hot、sponsored、editorial、platform-owned、partner、admin/merchant操作 |
| Performance | 10万Order/1万Product run、public P95、bundle/asset budget |
| Regression | points、orders/refund、product list/cursor/cache、admin、notifications |

时间测试使用数据库时钟/fake clock边界，不用长sleep。Payment测试用专用真实PG，断言PointAccount+PointLog+Campaign整体状态。

---

## 8. 可观测性

有界metrics：

- `merchandising_run_total{outcome=completed|failed|skipped_lock}`；
- `merchandising_run_duration_seconds`；
- `merchandising_snapshot_products`；
- `promotion_campaign_transition_total{from,to}`（枚举）；
- `promotion_charge_total{outcome=charged|insufficient|replayed|failed}`；
- `promotion_public_items{placement}`；
- `merchant_entitlement_transition_total{source,outcome}`。

禁止ID、merchant、product、campaign、email、reason、余额作为label。日志可以含内部ID但不得含余额、完整PointLog reason、token或审核长文本。

---

## 9. 发布

1. 部署 F0 migrations 和 backend，UI仍关闭；cleanup legacy isHot=false。
2. 手动run ranking，验证计数/抽样/上一run fallback。
3. 创建测试PromotionPackage，专用merchant完成request→approve→charge→public disclosure。
4. 验证cancel/refund和point ledger。
5. 配置editorial/partner测试项。
6. 发布前端canary，检查所有推广明确标注和badge禁词。
7. 全量并保持organic/sponsored/editorial独立指标。

---

## 10. 回滚

- frontend隐藏新shelves/badges，organic退回id排序；不得恢复legacy isHot。
- 停止ranking/promotion/entitlement cron，上一数据保留。
- 禁用PromotionPackage防新申请；已有active campaign按时间继续或由admin逐个cancel，不能批量SQL退款。
- 代码回滚不撤已执行migration，不删除PointLog/Campaign/Run；forward-fix。
- 若disclosure缺失，立即隐藏全部sponsored endpoint/UI，而不是混入organic。

---

## 11. 停止条件

- running/partial snapshot被public读取；
- refund订单仍长期计入下一run；
- duplicate charge、负余额、超额/重复refund；
- sponsored无文字disclosure或进入organic score；
- merchant能写hot/platformOwned/platformPick/partner；
- “认证/担保”禁词出现；
- runtime调用image provider或commit secret；
- shared hotspots发生双owner；
-性能或回归Gate失败。

---

## 12. 完成信号

Owner冻结、F0 schema Gate、`B_CAT`、共同基线 `F`、Phase A~I、AC-MERCH-001~029、Checklist P0、真实PG并发/性能、资产review、兼容/回滚及PAR Gate全部通过后，Plan才完成。

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-09 | Frozen for Implementation | Owner 批准：自然热卖、积分推广、精选/自营/合作权益、Image2 资产治理 |
| 0.1.1 | 2026-08-09 | Frozen for Implementation | Owner 批准唯一修订：CMI Foundation DAG 改为 S→A_CMI→F0→B_CAT→F；Merch 只消费最终 F、不参与 B_CAT，schema 仍 F0 落地 |
