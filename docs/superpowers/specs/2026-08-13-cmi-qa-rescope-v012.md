# CMI QA 收口修订(Docs-only Amendment)

| 字段 | 值 |
| --- | --- |
| 文档 ID | AMD-CMI-012 |
| 版本 | 0.1.2 |
| 日期 | 2026-08-13 |
| 状态 | **Frozen for Implementation** |
| 适用 | SPEC-CATALOG-OPS-001 · SPEC-MERCH-001 · PAR-CMI-001(Catalog/Merch 六件套同步升 v0.1.2;Identity 不受影响,保持 v0.1.0) |
| 批准人 | MoNexus Project Owner |
| 批准日期 | 2026-08-13 |
| 依据 | develop `docs/testing-policy.md`(2026-08-12 生效,PR #134;本分支 merge develop 后并入) |

## 0. 优先级与冲突裁决

本修订生效后,凡 v0.1.1 文本(含 spec/plan/task/implement/checklist)与本文件冲突处,**以本文件为准**;测试分层与证据规则以 develop 的 `docs/testing-policy.md` 为唯一权威(其操作性规则已在 §2 内联,本分支在并入 develop 前以 §2 为准)。除本文件明确修订的条目外,v0.1.1 的业务语义、并发/安全 DoD、文件所有权矩阵、`S→A_CMI→F0→B_CAT→F→lane→M_CMI` 证据链、Worktree/DB/端口隔离与合并顺序**全部不变**。

## 1. 背景

三套规格于 2026-08-09 冻结,验收方式要求逐 AC 挂 browser E2E 证据。`docs/testing-policy.md` 于 2026-08-12 在 develop 生效,明文停用逐 AC 浏览器证据(§4),E2E 只保留关键旅程回归与至多 1 条功能冒烟(§2)。本分支实施至 QA 阶段时已出现测试规模失衡(三个 catalog e2e spec 合计 5536 行,近 25 个提交中 22 个为测试提交)。Owner 于 2026-08-13 批准:剩余 QA 全面对齐新政策;T-MERCH-ASSET-001 拆出本次交付。

## 2. 证据规则(替换两套 checklist 的证据规则)

1. AC/CHK 证据**默认引用单元/集成/组件测试**(测试文件 + 用例名/断言点),记入 checklist 与 implement Evidence Ledger;"代码存在、mock 通过、手工改数据库伪造状态、feature-off skip 不构成证据"的底线不变。
2. 浏览器证据仅限关键旅程相关断言。本波涉及的关键旅程:管理端库存导入(Xboard import,已有专用 spec)与下单支付既有回归;其余功能至多 1 条 happy-path 冒烟。
3. 纯 UI 断言(文案、样式、开关显隐)一律下沉组件测试,禁止新增 e2e 场景。
4. 发布/回滚演练类条目(CHK-REL-*)改为 runbook 文档确认(引用 plan.md 发布节 / `docs/ops-runbook.md`),不做浏览器演练。
5. 性能数值门槛(P95、production-like 规模基准)不在本 PR 以专用 harness 证明:既有测试中的有界查询 / 无 N+1 断言即为证据,数值型基准列为 P1 跟进项。
6. "当前 HEAD 证据"统一在 **merge origin/develop 之后的最终 HEAD** 上按 verify 命令序列一次采集,不要求逐提交重采。

## 3. 任务卡修订

### 3.1 T-CAT-QA-002(v0.1.2)

安全/并发语义全部保留,证据改为逐项引用既有集成测试;缺口以定向集成测试补齐;性能数值(CHK-PERF-001~003 catalog 侧)移入 P1。新卡文本见 TASK-CATALOG-OPS-001 v0.1.2。

### 3.2 T-CAT-QA-003(v0.1.2)

浏览器范围 = 已完成的三个 spec 收口(`catalog-product-lifecycle` / `catalog-category-governance` / `catalog-xboard-import`),**不再新增场景**;Store filter / 新旧兼容 / 回滚不写专用 e2e,分别由 `src/pages/StorePage.cmi.test.tsx` + 组件测试、public contract 集成测试、runbook 文档确认承接。全量回归与 PAR Gate 证据在最终 HEAD 一次采集。

### 3.3 T-MERCH-QA-001(v0.1.2)

既有 `server/src/modules/merchandising/__tests__/ranking-lifecycle.test.ts`(REAL-PG advisory 双进程单 run、三阶段故障注入、stale running 回收、无孤儿锁)与 `ranking-compute-projection.test.ts` 即本卡证据;逐条对照 CHK-HOT-001~012 引用文件 + 用例,缺口以定向集成测试补齐。10 万 Order 基准与查询计划采样列 P1。

### 3.4 T-MERCH-QA-002(v0.1.2)

既有 `promotions-billing.test.ts`(100 并发 approve 恰扣一次、placement 约束回滚、并发 cancel/adjustment)、`promotions-campaign.test.ts` / `promotions-idempotency.test.ts`(key/hash、并发首创唯一、同 key 异 payload 409)、`promotions-dto-state.test.ts`、`editorial-entitlements.test.ts`(100 并发 grant 幂等)即本卡证据;按 CHK-PROMO-001~013、CHK-ID-001~006、CHK-SEC-001~004 审计缺口,以 ≤3 个定向集成用例补齐。

### 3.5 T-MERCH-QA-003(v0.1.2)

浏览器层收敛为 **1 条冒烟 spec** `e2e/merchandising-smoke.spec.ts`(≤400 行,确定性,无 sleep):admin 创建 package → merchant 为自己的 active 商品申请 → admin approve(积分扣款)→ campaign 达 active → Store 单次加载断言 organic/sponsored 区隔、条目级"推广"文字 disclosure、badge 顺序、editorial/partner mark(以确定性种子为限)→ merchant timeline 可见 active。a11y/禁词/视觉细节引用既有组件测试;visual/assets/bundle Gate 随 §3.6 Deferred。

### 3.6 T-MERCH-ASSET-001 → Deferred(拆出本次交付)

Owner 批准移出本分支交付范围,后续独立 spec/PR 交付。badge/shelf 以现有 CSS token 上线。连带 Deferred(不阻塞本次合并):REQ-MERCH-F-013、AC-MERCH-025~026、CHK-ASSET-001~006、CHK-PERF-004、CHK-QA-006 的 visual/assets/bundle 部分、D-MERCH-21、SPEC-MERCH-001 §10。

## 4. Checklist 重映射

未列出的 CHK 条目证据来源不变(既有单元/集成/组件测试按 §2.1 引用)。

### 4.1 CHK-CATALOG-OPS-001

| 条目 | v0.1.2 证据来源 |
| --- | --- |
| CHK-QA-003 | draft→publish / 分类申请审核 / 平台商品 / Xboard → 三个既有 catalog spec;Store → `StorePage.cmi.test.tsx` + merch 冒烟 spec 的 Store 断言 |
| CHK-UI-007 | `StorePage.cmi.test.tsx` 组件测试(缺口则补组件用例,不上 e2e) |
| CHK-UI-008 | public products contract 集成测试引用 |
| CHK-REL-001~003 | runbook 文档确认,不做浏览器演练 |
| CHK-REL-004 | 保持(文档条目) |
| CHK-PERF-001~003 | P1 跟进;既有有界查询断言作过程证据 |

### 4.2 CHK-MERCH-001

| 条目 | v0.1.2 证据来源 |
| --- | --- |
| CHK-HOT-006~007 | `ranking-lifecycle.test.ts`(REAL-PG describe、并发双 run、故障注入用例) |
| CHK-PROMO-011 | `promotions-billing.test.ts` "100 concurrent approvals charge exactly once…" |
| CHK-PROMO-013 | `promotions-campaign.test.ts` 并发首创/409 用例 + `promotions-idempotency.test.ts` |
| CHK-ID-002 | `editorial-entitlements.test.ts` 100 并发 grant 幂等 |
| CHK-QA-005 | `e2e/merchandising-smoke.spec.ts`(唯一浏览器证据) |
| CHK-QA-006 | disclosure/a11y → 组件测试;visual/assets/bundle → Deferred(§3.6) |
| CHK-ASSET-001~006 | Deferred(§3.6) |
| CHK-PERF-001 | Deferred → P1(production-like 基准) |
| CHK-PERF-002~003 | 既有有界查询/无 N+1 断言 + P1 数值跟进 |
| CHK-PERF-004 | Deferred(§3.6) |
| CHK-REL-001~003 | runbook 文档确认 |
| CHK-REL-004 | 保持(文档条目) |
| CHK-UI-001~006 | 组件测试 + 冒烟 spec 相应断言 |

## 5. 不变项与纪律

- 分支**只能 merge `origin/develop`,禁止 rebase / force push**:Evidence Ledger 记录的 `S/A_CMI/F0/B_CAT/F/H/M_CMI` SHA 祖先证明依赖现有提交对象。
- 文件所有权矩阵、通知隔离(§7 of PAR)、DB/端口隔离规则不变。
- 冒烟 spec 若发现产品缺陷,修复走原 Owner 卡语义,不得在 QA 卡顺手修改生产代码。

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.1.2 | 2026-08-13 | Frozen for Implementation | Owner 批准:剩余 QA 对齐 testing-policy(证据下沉集成/组件测试、浏览器仅关键旅程+1 条冒烟、演练类改 runbook 确认、性能数值列 P1);T-MERCH-ASSET-001 拆出本次交付 |
