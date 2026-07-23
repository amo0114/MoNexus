# Task Breakdown: M3 订单履约生命周期闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `TASK-M3-OLC-001` |
| 版本 | `1.0.0` |
| 日期 | `2026-07-23` |
| 规格 | [`spec.md`](./spec.md) |
| 计划 | [`plan.md`](./plan.md) |
| 清单 | [`checklist.md`](./checklist.md) |

---

## 1. 使用说明

### 1.1 工作分解结构（WBS）约定

| 字段 | 含义 |
| --- | --- |
| **ID** | 稳定任务编号，用于 PR/commit 引用 |
| **标题** | 祈使句，可交付 |
| **优先级** | P0 阻断合并 / P1 本波应做 / P2 可顺延 |
| **估算** | S ≤2h · M 2–6h · L 6–12h（单人） |
| **依赖** | 前置任务 ID |
| **需求** | 追溯 `REQ-*` |
| **DoD** | 任务完成定义（最小） |

### 1.2 执行规则

1. 一次只做一个 **In Progress** 任务（或明确并行且无文件冲突的一对）。  
2. 完成 DoD 后将状态改为 `Done`，并更新 [`checklist.md`](./checklist.md) 对应项。  
3. **禁止** 把范围外任务（MFA、订阅、公告）混入本表实施。  
4. 发现阻断 bug 于状态机：新建 hotfix 任务，标注 `type=bug`，不扩大本波范围。  
5. Commit 粒度：一任务一 commit 为佳；关联 `T-xxx`。  

### 1.3 状态看板（实施时维护）

| ID | 状态 | 负责人 | 备注 |
| --- | --- | --- | --- |
| T-00 | Done | amo0114 | 基线核对完成，master 73bac9c |
| T-BE-01 | Done | amo0114 | PR #20 合入（含 PR #22 前端补齐） |
| T-BE-02 | Done | amo0114 | PR #20 合入 |
| T-BE-03 | Done | amo0114 | PR #20 合入 |
| T-FE-U01 | Done | amo0114 | PR #22 合入 |
| T-FE-M01 | Done | amo0114 | PR #22 合入 |
| T-FE-M02 | Done | amo0114 | PR #22 合入 |
| T-FE-A01 | Done | amo0114 | PR #22 合入 |
| T-FE-A02 | Done | amo0114 | PR #22 合入 |
| T-QA-01 | Done | amo0114 | vitest 5 文件 65 测试全 PASS 2026-07-23 |
| T-QA-02 | Done | amo0114 | e2e/order-lifecycle.spec.ts 已存在（本地未跑，CI 已绿） |
| T-DOC-01 | Done | amo0114 | PRD §0.1 同步至 master@73bac9c，v1.2 |

状态枚举：`Todo` | `In Progress` | `Blocked` | `Done` | `Cancelled`

---

## 2. 任务总表

| ID | 标题 | Pri | 估算 | 依赖 | Phase | 需求 |
| --- | --- | --- | --- | --- | --- | --- |
| T-00 | 基线验证与语义确认 | P0 | S | — | 0 | A-01–04 |
| T-BE-01 | 扩展结算 status 查询枚举 | P0 | S | T-00 | A | REQ-F-040, F-033 |
| T-BE-02 | 用户订单 DTO 输出 holdingPoints | P0 | S | T-00 | A | REQ-F-041, F-011 |
| T-BE-03 | 商家 todo 计数（stats 扩展） | P1 | M | T-00 | A | REQ-F-043, F-020 |
| T-FE-U01 | 用户订单详情/列表 UX 闭环 | P0 | M | T-BE-02 | B | REQ-F-010–015 |
| T-FE-M01 | 商家拒单 API 客户端 + UI | P0 | M | T-00 | C | REQ-F-023 |
| T-FE-M02 | 商家待办条 + 字段展示 | P0 | M | T-BE-03* | C | REQ-F-020–021,026–027 |
| T-FE-A01 | 管理端争议筛选 + 仲裁 UI | P0 | L | T-00 | D | REQ-F-030–031,034 |
| T-FE-A02 | 管理端结算四态与 batch 约束 | P0 | M | T-BE-01 | D | REQ-F-032–033 |
| T-QA-01 | Playwright 主路径 E2E | P0 | M | T-FE-M01, T-FE-U01 | E | REQ-F-051 |
| T-QA-02 | Playwright 拒单或仲裁路径 | P0 | M | T-FE-M01 或 T-FE-A01 | E | REQ-F-052 |
| T-DOC-01 | PRD 快照与 OpenAPI 可选同步 | P1 | S | T-QA-01 | E | Success#5 |

\* T-FE-M02 若 T-BE-03 取消，可降级为前端列表聚合并文档化限制。

---

## 3. 详细任务卡

### T-00 — 基线验证与语义确认

**类型：** spike / setup  
**Files（只读为主）：**  
- `server/src/modules/orders/service.ts`  
- `server/src/modules/orders/fulfillment.ts`  
- `server/src/modules/admin/service.ts` (`resolveOrder`)  
- `server/src/modules/merchant/service.ts` (`rejectOrder`)  
- `server/src/__tests__/m3-order-state-machine.test.ts`  

**步骤：**

- [ ] 拉最新 `master`，创建分支 `feat/m3-order-lifecycle-closure`  
- [ ] 启动 Postgres：`docker compose up -d postgres`  
- [ ] 运行：  
  `cd server && TEST_DATABASE_URL='postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_test?schema=public' npx vitest run m3-order-state-machine orders-cron`  
- [ ] 记录：创建 manual_service 时 balance / holdingPoints / Settlement.status 的真实行为（5–10 行笔记，可贴 PR 描述）  
- [ ] 确认 `listSettlementsQuerySchema` 当前仅 `pending|settled`  

**DoD：** 基线测试绿；语义笔记完成；分支就绪。

---

### T-BE-01 — 扩展结算 status 查询枚举

**类型：** backend  
**需求：** REQ-F-040  
**Files：**  
- Modify: `server/src/modules/admin/schema.ts`  
- Modify: `server/src/modules/admin/service.ts`（确认 where）  
- Modify/Test: `server/src/__tests__/admin.test.ts` 或专用用例  

**步骤：**

- [ ] 将 `listSettlementsQuerySchema.status` 改为  
  `z.enum(['pending', 'settled', 'holding', 'voided']).optional()`  
- [ ] 确认 list 查询透传 filter  
- [ ] 增加测试：创建 holding/voided/pending 各至少一条，按 status 过滤只返回目标  
- [ ] `npx vitest run` 相关文件 PASS  
- [ ] Commit: `fix(server): allow holding/voided filters on admin settlements`

**DoD：** 四态可查；测试覆盖；无破坏 pending/settled 旧调用。

---

### T-BE-02 — 用户订单 DTO 输出 holdingPoints

**类型：** backend  
**需求：** REQ-F-041  
**Files：**  
- `server/src/modules/orders/service.ts`  
- `server/src/modules/orders/serializers.ts`（若存在）  
- 相关 test  

**步骤：**

- [ ] 读 `detail` / `list` 响应构造路径  
- [ ] 若缺少 `holdingPoints`，加入 number | null  
- [ ] 可选：`fulfillmentDeadline` 一并返回（利于用户展示 P1）  
- [ ] 单测或扩展现有 orders 测试断言字段  
- [ ] Commit: `fix(orders): expose holdingPoints on user order payloads`

**DoD：** GET 订单详情 JSON 含 `holdingPoints`；测试绿。

---

### T-BE-03 — 商家 todo 计数（stats 扩展）

**类型：** backend  
**优先级：** P1  
**需求：** REQ-F-043  
**Files：**  
- `server/src/modules/merchant/service.ts`（stats）  
- `server/src/modules/merchant/controller.ts` / routes（若已有 GET stats）  
- test  

**步骤：**

- [ ] 阅读现有 `stats` 实现  
- [ ] 扩展返回例如：  
  ```ts
  todo: {
    pending: number
    processing: number
    slaExceeded: number
  }
  ```  
- [ ] `slaExceeded` 定义与 `computeSlaExceeded` 一致（pending|processing 且 deadline < now）  
- [ ] 单测：构造超时 pending 订单，计数 ≥1  
- [ ] Commit: `feat(merchant): todo counts on merchant stats`

**DoD：** stats 响应含 todo；测试绿。  
**若取消：** 在 T-FE-M02 用筛选+提示「仅当前页」并在 PR 注明技术债。

---

### T-FE-U01 — 用户订单详情/列表 UX 闭环

**类型：** frontend  
**需求：** REQ-F-010–015  
**依赖：** T-BE-02  
**Files：**  
- `src/types/order.ts`  
- `src/components/OrderDetailModal.tsx`  
- `src/pages/ProfilePage.tsx`  
- 可选 `src/api/orders.ts`  

**步骤：**

- [ ] 类型增加 `holdingPoints?: number | null`  
- [ ] 详情展示冻结积分与简短说明（文案对齐 T-00 笔记）  
- [ ] `refunded`：隐藏 dispute/close；展示终态说明  
- [ ] 操作成功后：调用父组件刷新列表（新增 `onUpdated?: () => void` prop，ProfilePage 传入 reload）  
- [ ] 确认 `data-testid` 保留（dispute/close）  
- [ ] 手动验证 seed 用户订单  
- [ ] Commit: `feat(ui): user order holding points and refunded state UX`

**DoD：** AC 用户侧字段与刷新满足；无 console 错误。

---

### T-FE-M01 — 商家拒单 API + UI

**类型：** frontend  
**需求：** REQ-F-023  
**Files：**  
- `src/api/merchant.ts`  
- `src/pages/MerchantDashboardPage.tsx`  
- 可选抽 `MerchantRejectDialog.tsx`  

**步骤：**

- [ ] 新增 `rejectOrder(id, { publicNote?, internalNote? })` →  
  `POST /merchant/orders/:id/fulfillment/reject`  
- [ ] 当 `availableActions` 含 `reject` 时渲染按钮  
- [ ] 二次确认 Dialog；可选备注  
- [ ] 成功 Toast + 刷新订单列表  
- [ ] `data-testid="merchant-reject-order"` / confirm  
- [ ] 手动：manual_service pending → reject → refunded  
- [ ] Commit: `feat(ui): merchant order reject flow`

**DoD：** AC-01 手动通过。

---

### T-FE-M02 — 商家待办条 + 字段展示

**类型：** frontend  
**需求：** REQ-F-020–021, 026–027  
**依赖：** T-BE-03（推荐）  
**Files：**  
- `src/pages/MerchantDashboardPage.tsx`  
- `src/api/merchant.ts` / dashboard API  
- `src/types/merchant.ts`  

**步骤：**

- [ ] 拉取 stats.todo 或等价数据  
- [ ] 渲染 Todo strip（pending / processing / SLA）  
- [ ] 点击可设置 status 筛选（若现有 query 支持）  
- [ ] 列表/详情展示 holdingPoints、fulfillmentDeadline（格式本地化时间）  
- [ ] 结算 tab 四态 pill（若 registry 缺则补）  
- [ ] Commit: `feat(ui): merchant todo strip and fulfillment fields`

**DoD：** 待办数字与真实订单一致（或文档说明聚合方式）。

---

### T-FE-A01 — 管理端争议筛选 + 仲裁 UI

**类型：** frontend  
**需求：** REQ-F-030–031, 034  
**Files：**  
- `src/api/admin.ts`（或新 `adminOrders.ts`）  
- `src/pages/AdminPage.tsx`  
- 建议新建 `src/components/admin/AdminOrderResolveDialog.tsx`  

**步骤：**

- [ ] API：`resolveOrder(id, { result: 'refund' | 'close', note?: string })`  
- [ ] 订单列表 status 筛选含 `disputed`（及全 ORDER_STATUSES）  
- [ ] disputed 行显示「仲裁」；打开 Dialog  
- [ ] 提交后刷新列表；错误展示后端 message  
- [ ] 详情区（若有）展示 timeline / holdingPoints  
- [ ] `data-testid="admin-resolve-order"`  
- [ ] 手动：制造 disputed（用户争议）→ refund 与 close 各验一次  
- [ ] Commit: `feat(ui): admin order dispute resolve flow`

**DoD：** AC-02、AC-03 手动通过。

---

### T-FE-A02 — 管理端结算四态与 batch 约束

**类型：** frontend  
**需求：** REQ-F-032–033  
**依赖：** T-BE-01  
**Files：**  
- `src/pages/AdminPage.tsx`  
- admin settlements API client  
- businessRegistry / RegistryPill 类别 `settlementStatuses`  

**步骤：**

- [ ] 状态下拉：pending / settled / holding / voided / 全部  
- [ ] 列表 pill 映射四态  
- [ ] 勾选：仅 `status === 'pending'`；全选只选 pending  
- [ ] 提交 batch-settle 前前端再过滤  
- [ ] Commit: `feat(ui): admin settlement four-state filter and safe batch`

**DoD：** AC-04 手动通过。

---

### T-QA-01 — Playwright 主路径 E2E

**类型：** test  
**需求：** REQ-F-051  
**依赖：** T-FE-M01, T-FE-U01（履约按钮已存在）  
**Files：**  
- 新建 `e2e/order-lifecycle.spec.ts`  
- 复用 `e2e/helpers.ts`  

**步骤：**

- [ ] 准备/登录用户与商家（seed 或注册）  
- [ ] 确保存在 manual_service 可购商品（seed 或商家创建+库存策略）  
- [ ] 用户下单 → 商家 start → deliver → 用户 close  
- [ ] 断言关键 status 文案或 testid  
- [ ] CI 可运行（注意 rate limit env）  
- [ ] Commit: `test(e2e): manual service order lifecycle happy path`

**DoD：** 本地 `npx playwright test e2e/order-lifecycle.spec.ts` 绿；AC-05。

---

### T-QA-02 — Playwright 拒单或仲裁

**类型：** test  
**需求：** REQ-F-052  
**依赖：** T-FE-M01 **或** T-FE-A01  

**步骤：**

- [ ] **路径 R：** pending → 商家 reject → 用户侧见 refunded  
  **或路径 A：** delivered → 用户 dispute → admin resolve refund  
- [ ] 至少实现一条；另一条可 P1 追加  
- [ ] Commit: `test(e2e): order reject or admin resolve path`

**DoD：** 规格 AC-01 或 AC-02 被自动化锁住。

---

### T-DOC-01 — 文档收口

**类型：** docs  
**优先级：** P1  
**Files：**  
- `docs/superpowers/specs/2026-04-30-monexus-product-prd.md` §0.1  
- 可选 OpenAPI  
- 本目录 checklist 勾选结果  

**步骤：**

- [ ] 更新 PRD：M3-S1/S2 后端已交付；本波为 UI 闭环  
- [ ] 勾选 checklist 并在 PR 贴摘要  
- [ ] Commit: `docs(prd): refresh M3 progress after lifecycle closure`

**DoD：** 文档与代码一致；无过时「积分未冻结」表述。

---

## 4. 依赖图

```text
T-00
 ├─ T-BE-01 ── T-FE-A02
 ├─ T-BE-02 ── T-FE-U01 ──┐
 ├─ T-BE-03 ── T-FE-M02   │
 ├─ T-FE-M01 ─────────────┼── T-QA-01
 │         └──────────────┼── T-QA-02
 └─ T-FE-A01 ─────────────┘
                              └── T-DOC-01
```

**关键路径（P0 最短）：**  
`T-00 → T-BE-01 + T-BE-02 → T-FE-U01 + T-FE-M01 + T-FE-A01 + T-FE-A02 → T-QA-01 + T-QA-02`

---

## 5. 并行建议

| 轨道 | 任务 | 冲突文件 |
| --- | --- | --- |
| BE | T-BE-01, T-BE-02, T-BE-03 | 低（不同模块） |
| FE-User | T-FE-U01 | OrderDetailModal / ProfilePage |
| FE-Merchant | T-FE-M01, T-FE-M02 | MerchantDashboardPage — **串行** |
| FE-Admin | T-FE-A01, T-FE-A02 | AdminPage — **串行或先抽组件** |
| QA | T-QA-* | 等 FE 合并后 |

---

## 6. 估时汇总

| 优先级 | 任务 | 合计 |
| --- | --- | --- |
| P0 | T-00, BE-01/02, FE-U/M/A, QA-01/02 | 约 4–6 人日 |
| P1 | T-BE-03, T-DOC-01, T-FE-M02 增强 | 约 1 人日 |

---

## 7. 完成定义（工作流级 DoD）

全部 P0 任务 `Done` 且 [`checklist.md`](./checklist.md) §P0 全勾，方可请求合并 `master`。

---

## 8. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-07-23 | 初版 WBS |
