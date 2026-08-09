# Checklist: 热卖、推广与平台身份展示

| 字段 | 值 |
| --- | --- |
| 文档 ID | CHK-MERCH-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all checks unverified** |
| 规格 | [SPEC-MERCH-001](./spec.md) |

Checkbox只能由当前HEAD可重现证据勾选。手工改DB、mock points、仅截图有badge、隐藏feature或未审核AI图都不构成通过。

---

## 1. P0 — 文档/Foundation/并行

- [ ] **CHK-MERCH-DOC-001** — O-MERCH-01~12、六件套、PAR-CMI均批准/Frozen。
- [ ] **CHK-MERCH-DOC-002** — `D/S/F`、通知delta、ancestor命令与owner锁已记录；`S^=D`且`S→F`可证明。
- [ ] **CHK-MERCH-DOC-003** — REQ/AC/Task/Implement/CHK追溯无断链。
- [ ] **CHK-MERCH-FND-001** — Run/Snapshot/Package/Campaign/Editorial/Entitlement/Point关联、FK/onDelete/CHECK、Run terminal fields/single-running、幂等key/hash checks、adjustment字段和partial unique由单Owner落地。
- [ ] **CHK-MERCH-FND-002** — legacy isHot preflight/cleanup false可审计，字段不再被业务读写。
- [ ] **CHK-MERCH-PAR-001** — Merch lane不改schema/migrations/products/Store/宿主/通知；Catalog FE 整文件持锁至 `H`，随后同一 CMI Owner 从 `M_CMI` 接管 hosts，且与 Catalog integration 串行。

---

## 2. P0 — 自然热卖

- [ ] **CHK-HOT-001** — merchant/admin API传isHot返回FIELD_NOT_WRITABLE，DB不变，UI无toggle。
- [ ] **CHK-HOT-002** — compute只读取Order window/status，不读Product/Offer.sales/isHot。
- [ ] **CHK-HOT-003** — 成功创建且status!=refunded口径覆盖pending/processing/delivered/disputed/closed/refunded；人工pending/processing按已冻结而非已扣积分理解。
- [ ] **CHK-HOT-004** — config默认/范围/单位和run snapshot正确。
- [ ] **CHK-HOT-005** — category rank、min5/top20%、tie productId完全确定。
- [ ] **CHK-HOT-006** — advisory lock下多实例一次run；running/failed不公开；硬退出 stale running 按DB时间/timeout可回收。
- [ ] **CHK-HOT-007** — running短事务、snapshots+completed原子事务、独立failed收尾的故障注入通过；失败无partial且保留上一run。
- [ ] **CHK-HOT-008** — refund在下一run收敛；inactive/draft不参与population。
- [ ] **CHK-HOT-009** — 无completed run安全fallback，不读legacy isHot。
- [ ] **CHK-HOT-010** — retention保留run-pinned cursor至少48h；过期409而非混页。
- [ ] **CHK-HOT-011** — organic sort/cursor/cache使用同run/filterHash，分页稳定。
- [ ] **CHK-HOT-012** — admin runs/recompute/失败诊断不泄露用户订单数据。

---

## 3. P0 — Promotion Package/Campaign/Points

- [ ] **CHK-PROMO-001** — active package固定code/placement/duration/price，merchant不能覆盖snapshot。
- [ ] **CHK-PROMO-002** — merchant只能为自己active Product申请/查看/cancel/retry。
- [ ] **CHK-PROMO-003** — pending/rejected/cancelled未扣款且状态CAS正确。
- [ ] **CHK-PROMO-004** — approve原子条件扣balance+PointLog+Campaign+AdminLog。
- [ ] **CHK-PROMO-005** — insufficient为payment_failed，零部分扣款；retry最多一次有效charge。
- [ ] **CHK-PROMO-006** — product+placement scheduled/active/paused DB唯一，双approve稳定冲突。
- [ ] **CHK-PROMO-007** — lifecycle按DB时间scheduled→active→expired，paused不顺延且占位。
- [ ] **CHK-PROMO-008** — scheduled平台cancel全额自动退，重复动作不二次退。
- [ ] **CHK-PROMO-009** — active/paused adjustment仅admin+reason，`adjustmentDecidedAt` CAS且P0最多一次；0积分留决定，>0写唯一refund log，均≤charge。
- [ ] **CHK-PROMO-010** — merchant无refund/admin transition权限，MFA边界不弱化。
- [ ] **CHK-PROMO-011** — 100并发approve/retry/cancel/refund无负余额、重复扣/超退。
- [ ] **CHK-PROMO-012** — 不存在法币、CPM/CPC、竞价、收益/展示次数承诺。
- [ ] **CHK-PROMO-013** — Campaign create 与 adjustment 的 key格式/scope、冻结canonical SHA-256向量、key/hash checks 持久化；同key同payload重放、异payload稳定409，DTO/log/metric不泄露key/hash。

---

## 4. P0 — Sponsored/Editorial/Public identity

- [ ] **CHK-PUBLIC-001** — sponsored只active Campaign+Product+Merchant，limit/cache正确。
- [ ] **CHK-PUBLIC-002** — 10分钟bucket轮换确定且公平，无DB每请求写。
- [ ] **CHK-PUBLIC-003** — 每个sponsored item同层级可见“推广”文字，不只颜色/icon/tooltip。
- [ ] **CHK-PUBLIC-004** — sponsored不进入organic cursor/score/hot统计。
- [ ] **CHK-EDIT-001** — Editorial只admin/MFA管理，schedule/revoke/reason/AdminLog正确。
- [ ] **CHK-EDIT-002** — 精选独立shelf/label，Product inactive不公开且不自动延长。
- [ ] **CHK-ID-001** — platformOwned只由merchantId=null派生，所有写入字段被拒。
- [ ] **CHK-ID-002** — partner净推广消费window/threshold/grant/extend/expire幂等。
- [ ] **CHK-ID-003** — manual partner grant/revoke需要reason/expiry/AdminLog，历史不删。
- [ ] **CHK-ID-004** — partner固定“平台合作伙伴”+不担保tooltip，无认证/担保词。
- [ ] **CHK-ID-005** — badge顺序平台自营→精选→热卖，max3；partner在商家区域，推广独立。
- [ ] **CHK-ID-006** — unknown code忽略，不fallback为任何认证。

---

## 5. P0 — UI与资产

- [ ] **CHK-UI-001** — Store sponsored/editorial/organic视觉分区清楚，mobile/desktop一致。
- [ ] **CHK-UI-002** — package购买前明确价格/时长/展位/不保证次数，双提交保护。
- [ ] **CHK-UI-003** — merchant campaign全状态/cancel/retry/payment_failed UX正确。
- [ ] **CHK-UI-004** — admin approve/reject/pause/resume/cancel/adjust有确认、理由、竞态反馈。
- [ ] **CHK-UI-005** — admin run/editorial/entitlement UI保留filter/page，无内部reason进入public。
- [ ] **CHK-UI-006** — badge/disclosure键盘、屏幕阅读器、对比度、缩放通过。
- [ ] **CHK-ASSET-001** — Asset卡完整读取api-image SKILL，使用bundled脚本/current provider/gpt-image-2。
- [ ] **CHK-ASSET-002** — output opaque、n=1、input roles/prompt/model/size/quality/hash/review齐全。
- [ ] **CHK-ASSET-003** — provider key/base_url/auth/config未输出/修改/commit。
- [ ] **CHK-ASSET-004** — 未审核概念不进public；错误文字/认证勾/担保暗示被拒。
- [ ] **CHK-ASSET-005** — runtime使用HTML文字+SVG/CSS/token，无image API/SDK/network。
- [ ] **CHK-ASSET-006** — runtime新增资产≤150KiB gzip，manifest hash、1x/2x/dark/light/visual regression通过。

---

## 6. P0 — 安全/可观测/性能

- [ ] **CHK-SEC-001** — public DTO无balance/pointLog/reviewer/internalReason/refund细节。
- [ ] **CHK-SEC-002** — merchant跨商家Product/Campaign/Entitlement隔离。
- [ ] **CHK-SEC-003** — Admin mutations均MFA+AdminLog；points另有不可变PointLog。
- [ ] **CHK-SEC-004** — error/log/trace无token/email/余额/长reason/constraint名/AI secret。
- [ ] **CHK-OPS-001** — run/charge/transition/public/entitlement metrics齐全且labels有界。
- [ ] **CHK-OPS-002** — cron start/stop幂等、多实例lock、无timer/job泄漏。
- [ ] **CHK-PERF-001** — 10万Order/1万Product production-like run≤10min并记录环境/计划。
- [ ] **CHK-PERF-002** — organic list P95退化≤10%；sponsored/editorial P95≤300ms。
- [ ] **CHK-PERF-003** — projection批量查询无N+1，run/snapshot索引计划可接受。
- [ ] **CHK-PERF-004** — frontend bundle/runtime asset预算通过。

---

## 7. P0 — QA/发布

- [ ] **CHK-QA-001** — window/rank/tie/cursor/rotation/status/禁词unit全绿。
- [ ] **CHK-QA-002** — ranking advisory/atomic/failure真实PG integration全绿。
- [ ] **CHK-QA-003** — charge/refund/placement/100并发真实PG全绿。
- [ ] **CHK-QA-004** — merchant/admin/public auth与field allowlist integration全绿。
- [ ] **CHK-QA-005** — organic/sponsored/editorial/platform/partner browser E2E全绿。
- [ ] **CHK-QA-006** — disclosure/a11y/visual/assets/bundle Gate全绿。
- [ ] **CHK-QA-007** — points/orders/refund/products/cache/cursor/admin/Catalog回归全绿。
- [ ] **CHK-QA-008** — notification build/tests无退化，Merch零owned-file冲突。
- [ ] **CHK-REL-001** — migration/backend→ranking验证→config→frontend canary顺序已演练。
- [ ] **CHK-REL-002** — legacy isHot清理后frontend rollback不恢复旧语义。
- [ ] **CHK-REL-003** — 隐藏sponsored/停新申请/停cron/forward-fix回滚已演练。
- [ ] **CHK-REL-004** — active Campaign处理和PointLog不可删除原则写入runbook。

---

## 8. P1 — 后置

- [ ] **CHK-P1-001** — 法币/第三方支付/发票另立支付规格。
- [ ] **CHK-P1-002** — 真实impression/click/转化需求出现后另立计量/反欺诈规格。
- [ ] **CHK-P1-003** — 个性化推荐/ML排序另立隐私与评估规格。
- [ ] **CHK-P1-004** — 稳定运行后另立migration删除legacy Product.isHot字段/索引。
- [ ] **CHK-P1-005** — 如需更多badge/merchant plan，先做文案误导和权益计费评审。

---

## 9. AC索引

| AC | Checklist |
| --- | --- |
| AC-MERCH-001～002 | CHK-HOT-001、CHK-MERCH-FND-002、CHK-REL-002 |
| AC-MERCH-003～008 | CHK-HOT-002～012、CHK-PERF-001～003 |
| AC-MERCH-009～015、027 | CHK-PROMO-001～013、CHK-QA-003～004 |
| AC-MERCH-016～017 | CHK-PUBLIC-001～004、CHK-UI-001～003 |
| AC-MERCH-018～024 | CHK-EDIT-001～002、CHK-ID-001～006、CHK-UI-006 |
| AC-MERCH-025～026 | CHK-ASSET-001～006、CHK-QA-006 |
| AC-MERCH-028 | CHK-MERCH-PAR-001、CHK-QA-008 |
| AC-MERCH-029 | CHK-QA-001～008、CHK-PERF-001～004、CHK-REL-001～004 |

---

## 10. Final Gate

- [ ] **CHK-MERCH-FINAL-001** — 所有P0 checkbox有当前HEAD证据。
- [ ] **CHK-MERCH-FINAL-002** — G-MERCH-PR-001~010全Passed。
- [ ] **CHK-MERCH-FINAL-003** — P0 Tasks全Done，无Blocked/InProgress。
- [ ] **CHK-MERCH-FINAL-004** — migration/drift/git diff/secret/points/disclosure/asset审计通过。
- [ ] **CHK-MERCH-FINAL-005** — Owner审阅points、用户文案、视觉、发布/回滚后明确批准合并。
