# Tasks: 热卖、推广与平台身份展示

| 字段 | 值 |
| --- | --- |
| 文档 ID | TASK-MERCH-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all tasks Pending** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) |

所有Task在Owner Freeze前保持Pending。Shared schema/migrations由PAR-CMI的T-FND-001唯一Owner实施；Merch业务Agent不得修改。

---

## 1. 全局规则

1. 先失败测试→最小实现→直接回归→证据。
2. Merch lane 只写 `modules/merchandising/**` 和独立前端组件/API/types；宿主/shared files 由 CMI Integration Owner 持锁。
3. 积分测试使用专用真实PG，不用mock balance证明并发。
4. 不访问生产数据、不创建真实推广、不调用第三方支付。
5. Image2只由Asset卡运行api-image脚本，读取runtime provider；不得输出key/base_url。
6. 不修改Order/Settlement/Notification语义或通知worktree。

---

## 2. 文档与Foundation

### T-MERCH-DOC-001 — Freeze、delta与contract fixtures

**P0 / Pending**。Owned：本六件套、PAR中的Merch映射、纯JSON DTO fixtures。工作：记录O-MERCH-01~12、Frozen、Freeze base `D` 与 docs-only SHA `S`、points/products/通知delta；冻结status/error/placement/badge contracts。DoD：`S^=D`、零业务/schema diff，追溯完整。

### T-FND-001 — Shared Foundation（引用）

**P0 / Pending**。由PAR-CMI单Owner从 `S` 实施，Merch只审核模型满足 Spec §5：Run/Snapshot/Package/Campaign/Editorial/Entitlement、Run terminal fields/status checks/single-running、run-snapshot FK、Campaign/PointLog/adjustment 关联、Campaign create/adjustment 的 idempotency key+canonical payload hash/checks 与唯一约束、scheduled/active/paused partial unique、SystemConfig keys（含 run timeout）。Foundation SHA `F` 是以下所有BE卡前置，且必须证明 `S→F`。

---

## 3. Backend

### T-MERCH-BE-001 — Ranking run repository/lifecycle

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-002、004、REQ-MERCH-NF-001、005 |
| 依赖 | T-FND-001 |
| 状态 | Pending |

**Owned**：`modules/merchandising/ranking/repository.ts`、lifecycle/cron/admin run query、tests。

**Must Not Touch**：Order service、Product sales/isHot、schema/migration、products service、global cron unrelated code（main 接线由 CMI Integration Owner 完成）。

**工作**：advisory lock；短事务 running → snapshot+completed 原子事务 → 独立 failed 收尾；config+DB time freeze；按 hotRunTimeoutMinutes 回收硬退出遗留 running；retention；manual recompute rate/auth；metrics。

**DoD**：两个进程仅一run；注入 compute/commit/catch-failure transaction 失败均无 partial snapshot且上一run可读；kill -9 遗留 running 可按 DB 时间回收，旧进程不能再 completed；running不公开；stop/restart无孤儿lock/timer。

### T-MERCH-BE-002 — Order聚合、Hot与public projection adapter

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-001~004、012 |
| 依赖 | T-MERCH-BE-001；Catalog category contract |
| 状态 | Pending |

**Owned**：ranking compute、`publicProjection.ts`、cursor/projection fixtures、tests。

**Must Not Touch**：orders/refund代码、products service/cache、merchant schema/UI、StorePage。

**工作**：window/status口径；category rank/tie；snapshot批量写；no-run fallback；batch decorate避免N+1；run-pinned cursor contract；legacy isHot不可见fixture。

**DoD**：AC-MERCH-003～008；SQL/测试证明不读Product/Offer.sales或isHot；1000 products batch查询有界。

### T-MERCH-X-001 — isHot禁写跨规格合同

**P0 / Pending**。Owned仅contract tests/fixture，实际`merchant/schema.ts/service.ts`、wizard/modal和products sort由Catalog/CMI owners修改。合同要求传isHot 400 FIELD_NOT_WRITABLE、DB不变、legacy false、不进入DTO/sort。Merch Agent不得抢shared file锁。

### T-MERCH-BE-003 — PromotionPackage/Campaign基础状态机

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-005~007、REQ-MERCH-NF-004~005 |
| 依赖 | T-FND-001 |
| 状态 | Pending |

**Owned**：promotions constants/schema/service/controller/routes中package/request/review非billing区域、tests。

**Must Not Touch**：points service、billing.ts、public sponsored、Order/Settlement、AdminPage/MerchantDashboard。

**工作**：package CRUD immutable code/snapshot；merchant ownership/request/cancel；Campaign create 强制 `Idempotency-Key`，使用 Spec §11 共享 validator/canonicalizer/测试向量，持久化 merchant-scoped key + canonical payload hash，并实现同 key/同 payload 返回既有 Campaign、同 key/异 payload稳定409；admin list/reject/review fields；状态CAS；placement collision预检；API allowlist/AdminLog；public/merchant/admin DTO 与 log/metric 均不回显内部 key/hash。

**DoD**：价格等不可客户端覆盖；pending不扣款；缺失/越界 key、同 key 同/异 payload、并发首创、跨 merchant key 复用与内部字段 allowlist 全绿；权限/并发状态机全绿。

### T-MERCH-BE-004 — 积分扣退、Campaign lifecycle与Sponsored public

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-006~008、REQ-MERCH-NF-002~005 |
| 依赖 | T-MERCH-BE-003 |
| 状态 | Pending |

**Owned**：`promotions/billing.ts`、lifecycle cron、public sponsored controller/routes、points helper最小区域（独占）、real-PG tests。

**Must Not Touch**：Order point debit/refund语义、Settlement、schema/migration、products service/StorePage、真实余额。

**工作**：approve/retry atomic charge；payment_failed；partial unique冲突；scheduled/active/paused/expired；cancel/full refund；active/paused adjustment 强制 `Idempotency-Key`，复用 Spec §11 validator/canonicalizer/测试向量，以 campaign-scoped key+hash、行锁和 `adjustmentDecidedAt` CAS 实现最多一次0..charge决定（同 key/同 payload重放既有决定，同 key/异 payload或第二个新决定稳定409，>0才写refund PointLog）；10min rotation/cache/disclosure；metrics。

**DoD**：AC-MERCH-009～017、027；100并发无重复扣/负余额/超退；public字段最小。

### T-MERCH-BE-005 — Editorial、Platform identity与Entitlement

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-009~012 |
| 依赖 | T-FND-001、T-MERCH-BE-002、T-MERCH-BE-004 |
| 状态 | Pending |

**Owned**：editorial/entitlements modules、partner cron、public projection增量、tests。

**Must Not Touch**：Product merchantId写路径、Merchant审核/role、Product service、通知。

**工作**：editorial schedule/revoke/理由；platformOwned derive；promotion net spend聚合；partner grant/extend/expire；manual grant/revoke；禁词/tooltip projection。

**DoD**：AC-MERCH-018～024；inactive product/merchant不公开；历史grant不删除；无verified/guarantee字段。

---

## 4. Frontend

### T-MERCH-FE-001 — Badge/Disclosure/Shelf基础组件

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-008~012、REQ-MERCH-NF-006 |
| 依赖 | frozen DTO fixtures；可与BE并行 |
| 状态 | Pending |

**Owned**：`components/merchandising/{BadgeMark,SponsoredShelf,EditorialShelf,MerchantPartnerMark}.tsx`、styles、types、component/a11y tests。

**Must Not Touch**：StorePage、ProductDetail、AdminPage、MerchantDashboard、Layout、runtime image API。

**工作**：固定顺序/max3；推广文字disclosure；partner tooltip；unknown code ignore；loading/error empty states；responsive/a11y。

**DoD**：AC-MERCH-016、018、020、023～024；禁词测试；无纯色/纯图标语义。

### T-MERCH-FE-002 — Merchant Promotion UI

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-005～008、REQ-MERCH-NF-004、REQ-MERCH-NF-008 |
| 依赖 | Frozen Promotion DTO/error fixtures；可与 BE 并行 |
| 状态 | Pending |

**Owned**：`components/merchandising/PromotionPackagePicker.tsx`、`MerchantCampaignPanel.tsx`、merchant 区域的 `src/api/merchandising.ts`/types、独立 route/page 或可挂载子组件、对应 Playwright/component fixture。

**Must Not Touch**：`MerchantDashboardPage.tsx` 宿主（`H` 前 Catalog Frontend、`H` 后 CMI Integration 整文件 Owner）、auth/points store、商品编辑、StorePage、schema、Campaign backend状态机。

**工作**

- [ ] 展示套餐积分价格、固定时长、placement 和“不保证展示/点击/成交次数”。
- [ ] request/cancel/retry-payment 用服务端 package snapshot，不允许客户端改价格/时长。
- [ ] 覆盖 pending_review/payment_failed/scheduled/active/paused/expired/rejected/cancelled timeline。
- [ ] 双提交禁用、409/422/余额不足、网络重试和空/加载态可恢复。
- [ ] cancel 条件与 refund 语义用明确文案，不向 merchant 暴露内部 review/PointLog ID。
- [ ] 刷新列表保留当前 filter/page；未知 status 安全降级为不可操作。

**DoD**：AC-MERCH-009、011、013～017、027 的 merchant UI 路径有自动化证据；所有状态 fixture、键盘/a11y、重复提交与 disclosure Green。

### T-MERCH-FE-003 — Admin Promotion/Editorial/Entitlement UI

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-004～007、REQ-MERCH-F-009、REQ-MERCH-F-011、REQ-MERCH-NF-004、REQ-MERCH-NF-008 |
| 依赖 | Frozen admin DTO/error fixtures；可与 BE 并行 |
| 状态 | Pending |

**Owned**：`AdminPromotionManager`、`AdminEditorialManager`、`AdminEntitlementManager`、`AdminMerchandisingRunPanel`、admin 区域 merchandising API/types 和 tests。

**Must Not Touch**：`AdminPage.tsx` 宿主（`H` 前 Catalog Frontend、`H` 后 CMI Integration 整文件 Owner）、MFA middleware、PointAccount store、backend transaction、StorePage/Layout。

**工作**

- [ ] package CRUD、campaign approve/reject/pause/resume/cancel/一次 adjustment 全状态 UI。
- [ ] 余额不足/payment_failed 与 placement conflict 返回稳定可行动反馈；不伪装成功。
- [ ] adjustment 确认展示 charged/已退/本次 0..charge、理由；第二次或不同幂等重放明确409。
- [ ] editorial schedule/revoke 与 manual partner grant/revoke 需要 reason/expiry。
- [ ] run list/recompute 显示脱敏 config/status/failure code，不展示订单明细。
- [ ] internal reason 只在授权管理视图；绝不进入 public component/截图 fixture。

**DoD**：AC-MERCH-010～015、018、021～022、029 的 admin UI 路径；MFA/409/422、确认、禁词、filter/page、keyboard/a11y Green。

### T-MERCH-ASSET-001 — Image2概念与runtime视觉转译

| 字段 | 值 |
| --- | --- |
| 优先级 | P0（视觉交付） |
| 对应需求 | REQ-MERCH-F-013、REQ-MERCH-NF-006 |
| 依赖 | Owner批准视觉语义；不依赖BE |
| 状态 | Pending |

**Owned**：`docs/design/merchandising/concepts/**`、approved asset manifest、`public/assets/merchandising/**`（批准后）、Badge视觉tokens。

**Must Not Touch**：provider配置/auth.json/config.toml、业务数据、品牌logo重设计、runtime network调用。

**工作**

- [ ] 读取api-image SKILL和当前provider配置（不输出secret）。
- [ ] 使用项目品牌reference，脚本`generate_image.py`、gpt-image-2、opaque、n=1。
- [ ] 保存prompt/input roles/model/size/quality/hash和人工review。
- [ ] 拒绝含认证勾/担保暗示/错误文字的概念。
- [ ] 将批准方向转为SVG/CSS/HTML文本；可选纹理压缩入manifest。
- [ ] bundle、1x/2x、dark/light、a11y/visual regression。

**DoD**：AC-MERCH-025～026；repo无key/base_url；未批准稿不进public；runtime不import image SDK。

---

## 5. Integration

### T-MERCH-INT-001 — Public/Host wiring（CMI Integration Owner）

| 字段 | 值 |
| --- | --- |
| 优先级 | P0/共享热点锁 |
| 对应需求 | REQ-MERCH-F-001、003、008~012、REQ-MERCH-NF-002、007 |
| 依赖 | Catalog/Merch lane tips全部ready；Catalog host release `H` 已记录；`M_CMI` 已建立 |
| 状态 | Pending |

**Owned**：products service/schema/cache/cursor、StorePage；`H` 后接收 `AdminPage.tsx`、`MerchantDashboardPage.tsx` 整文件锁并做最小 mount；cron/main最小接线。

**Must Not Touch**：Merch算法/组件内部、schema/migration、notifications/Layout/appStore、Order/Settlement。

**工作**：移除legacy isHot sort/write/DTO；调用projection；run cursor；挂sponsored/editorial/partner/badges；宿主管理页面；cron lifecycle；cache invalidation。

**DoD**：本卡与 T-CAT-INT-001 由同一 CMI Integration Owner/Worktree 串行执行；shared files 在 `H` 后只有该 Owner 提交；`F`、所有 lane tips、`H` 均为 `M_CMI` 祖先；Catalog/Merch fixtures一致；AC-MERCH-001～002、007～008、016～024、028。

---

## 6. QA/发布

### T-MERCH-QA-001 — Ranking/Projection real-PG与性能

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-001～004、REQ-MERCH-NF-001～002/005 |
| 依赖 | T-MERCH-BE-001～002、T-MERCH-INT-001 的 public adapter |
| 状态 | Pending |

**Owned**：ranking fixture/performance harness、专用 DB scripts、query-plan/evidence；QA 不顺手修业务，失败退回 Owner。

**验证**：真实 PostgreSQL 两进程 advisory/single-running；running/atomic completed/独立 failed 三阶段故障注入；kill -9 stale timeout/recovery/旧事务 CAS；全 status/refund/window boundary/tie；run-pinned cursor/retention/409；10万 Order+1万 Product ≤10min；public P95、N+1/index plan、metrics label。

**DoD**：AC-MERCH-001～008 与 CHK-HOT-001～012、CHK-PERF-001～003、CHK-OPS-001～002 全有可重现证据；不使用 mock DB 或手工改 snapshot。

### T-MERCH-QA-002 — Promotion/Points并发、安全与API

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-MERCH-F-005～011、REQ-MERCH-NF-003～005 |
| 依赖 | T-MERCH-BE-003～005 |
| 状态 | Pending |

**Owned**：真实 PG concurrency/security harness、merchant/admin/public API contract、脱敏 evidence。

**验证**：100并发 approve/retry/cancel/scheduled refund/active adjustment；PointAccount/PointLog/Campaign/AdminLog 原子性；paused placement unique；零积分 adjustment；分别覆盖 Campaign create 与 adjustment 的冻结 hash 向量、缺失/非法 key、同 key 同 payload 重放、同 key 异 payload稳定409、第二 adjustment、跨 merchant/campaign key scope、并发重放及 key/hash 不出 DTO/log/metric；MFA/ownership/cross-merchant；public field allowlist；bounded metrics/log。

**DoD**：AC-MERCH-009～015、017、021～022、027；零负余额、重复扣款、超退、第二 adjustment、内部字段泄露。

### T-MERCH-QA-003 — Browser、资产、兼容与Final Gate

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 / Final |
| 对应需求 | REQ-MERCH-F-008～013、REQ-MERCH-NF-006～008 |
| 依赖 | 全部 P0 lane + T-MERCH-INT-001 + T-MERCH-QA-001～002 |
| 状态 | Pending |

**Owned**：`playwright.merchandising.config.ts`、`e2e/merchandising-*.spec.ts`、verify scripts、checklist/evidence；不得在 QA 卡直接修产品代码。

**验证**：organic/sponsored/editorial/platform-owned/partner 同屏语义；merchant/admin 全流程；disclosure/禁词/a11y/visual/mobile；Image2 manifest/hash/bundle/runtime-no-SDK；Catalog/points/orders/refund/products/admin/notification 回归；发布/回滚/PAR Gate。

**DoD**：AC-MERCH-016～020、023～026、028～029，且引用 T-MERCH-QA-001、T-MERCH-QA-002 evidence 覆盖全 29 AC；无 feature-off、人工 DB、未审资产或 skip 假绿。

---

## 7. 依赖表

| Task | 前置 | 可并行 | 解锁 |
| --- | --- | --- | --- |
| T-MERCH-DOC-001 | Owner | 无 | T-FND-001 |
| T-FND-001 | Catalog+Merch+PAR Frozen | Identity lanes | 全部 Merch BE |
| T-MERCH-BE-001 | T-FND-001 | T-MERCH-BE-003、FE、Asset | T-MERCH-BE-002 |
| T-MERCH-BE-002 | T-MERCH-BE-001 | T-MERCH-BE-003～004、FE | T-MERCH-BE-005、INT、QA-001 |
| T-MERCH-X-001 | frozen fixtures | BE/FE | T-MERCH-INT-001 |
| T-MERCH-BE-003 | T-FND-001 | T-MERCH-BE-001～002、FE | T-MERCH-BE-004 |
| T-MERCH-BE-004 | T-MERCH-BE-003 | T-MERCH-BE-001～002、FE | T-MERCH-BE-005、QA-002 |
| T-MERCH-BE-005 | T-MERCH-BE-002、T-MERCH-BE-004 | FE/Asset | T-MERCH-INT-001 |
| T-MERCH-FE-001～003 | frozen fixtures | 相互、BE | T-MERCH-INT-001、T-MERCH-QA-003 |
| T-MERCH-ASSET-001 | visual approval | 全部业务 lane | FE visual、T-MERCH-QA-003 |
| T-MERCH-INT-001 | `M_CMI` + `H` + Catalog/Merch outputs | 无（与 T-CAT-INT-001 同 Owner 串行） | T-MERCH-QA-001、T-MERCH-QA-003 |
| T-MERCH-QA-001、T-MERCH-QA-002 | 对应 BE/INT | 相互 | T-MERCH-QA-003 |
| T-MERCH-QA-003 | 全部 P0 | 无 | PR Gate |

---

## 8. 总体DoD

- [ ] P0 Task全部Done且证据在当前HEAD。
- [ ] schema/products/Store/Page宿主/通知文件Ownership零违规。
- [ ] AC-MERCH-001~029全部有自动化或明确受控证据。
- [ ] 无重复扣款、负余额、超退、partial run、无disclosure广告或认证误导。
- [ ] Image2和runtime assets满足review/secret/bundle Gate。
- [ ] Migration/points/orders/products/admin/notification回归、性能、a11y、rollout/rollback全绿。
