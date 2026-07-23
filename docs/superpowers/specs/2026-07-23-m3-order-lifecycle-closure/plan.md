# Plan: M3 订单履约生命周期闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `PLAN-M3-OLC-001` |
| 版本 | `1.0.0` |
| 日期 | `2026-07-23` |
| 状态 | `Ready` |
| 规格 | [`spec.md`](./spec.md) (`SPEC-M3-OLC-001`) |
| 任务分解 | [`task.md`](./task.md) |
| 验收清单 | [`checklist.md`](./checklist.md) |

> **For implementers / agents:** 按 Phase 顺序执行；每 Phase 结束跑该 Phase 出口门禁。禁止 `git add -A`。不修改 Docker/GHCR workflow（与并行运维任务隔离）。  
> 详细勾选步骤见 `task.md`；本计划描述 **方法、架构、阶段、风险与发布**。

---

## 1. 目标与非目标

### 1.1 Goal

在 **尽量不改领域模型** 的前提下，完成订单履约生命周期的 **产品闭环**：

- 管理端可仲裁争议、安全批量结算  
- 商家端可拒单、看清待办/SLA/冻结积分  
- 用户端状态与退款结果可理解  
- 自动化测试锁住主路径  

### 1.2 Non-goals

见 `spec.md` §2.2。额外强调：

- 不重写 `fulfillment.ts` 状态机（除非发现阻断 bug）  
- 不做 M4 订阅/营销  
- 不改 monorepo 结构  

---

## 2. 现状基线（As-Is）

| 层 | 已有 | 缺口 |
| --- | --- | --- |
| Schema | Order 六态 + holdingPoints + Settlement 四态 | — |
| 后端 API | reject / resolve / dispute / close / cron | settlement query 缺 holding/voided |
| 商家 UI | start / deliver / respond_dispute / SLA 标记 | **reject** 按钮与确认流 |
| 用户 UI | dispute / close / timeline 类型 | holdingPoints 展示、refunded 文案、刷新体验 |
| 管理 UI | 订单/结算列表、batchSettle | **resolve**、disputed 队列、四态筛选 |
| 测试 | vitest 状态机/cron | E2E 全链路、拒单/仲裁 UI |

---

## 3. 目标架构（To-Be）

```text
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  User UI    │     │  Merchant UI     │     │  Admin UI          │
│  Profile +  │     │  Dashboard       │     │  Orders +          │
│  OrderModal │     │  + reject + todo │     │  Resolve + Settle  │
└──────┬──────┘     └────────┬─────────┘     └─────────┬──────────┘
       │                     │                         │
       ▼                     ▼                         ▼
  /api/orders/*        /api/merchant/orders/*    /api/admin/orders/*
                                                 /api/admin/settlements/*
       │                     │                         │
       └─────────────────────┴───────────┬─────────────┘
                                         ▼
                          orders/fulfillment.ts (SoT)
                          + PointLog / Settlement
                          + OrderStatusEvent
                                         │
                                         ▼
                              orders/cron.ts (system)
```

**设计原则落地：**

| 原则 | 做法 |
| --- | --- |
| SoT 在服务端 | 前端按钮 ← `availableActions` / 状态，不复制 legalTransitions |
| 薄 UI / 厚 API | 本波后端仅契约补丁 |
| 增量交付 | Phase A→E，每阶段可合并可回滚 |
| 可测 | data-testid + API 契约稳定 |

---

## 4. 技术方案

### 4.1 后端（Phase A）

1. **Admin settlements query**  
   - 修改 `listSettlementsQuerySchema`：`z.enum(['pending','settled','holding','voided'])`  
   - 确认 `listAllSettlements` where 透传 status  
   - 单测：按 status 过滤  

2. **用户订单 holdingPoints**  
   - 检查 `orders/service` detail/list serializer  
   - 若缺失则加入响应（integer | null）  
   - 单测断言字段存在  

3. **商家待办计数（二选一，计划默认 B）**  
   - **方案 A：** `GET /merchant/stats` 扩展 `todo: { pending, processing, slaExceeded }`  
   - **方案 B：** 前端在当前筛选下用现有 list + 额外 count 请求（若 API 无 count-by-status，则用 stats）  
   - **决策：** 实现前 15 分钟读 `merchant/service.ts` `stats`；若已有聚合则扩展（A），否则最小改动用 A 新增字段（推荐 A，避免 N+1 列表假计数）  

4. **禁止事项**  
   - 不改 legalTransitions 表（除非 bug）  
   - 不改 cron 间隔除非测试需要 env 注入（已有则复用）  

### 4.2 前端 API 客户端

| 新增/修改 | 路径 |
| --- | --- |
| `rejectOrder(id, body?)` | `src/api/merchant.ts` |
| `resolveOrder(id, { result, note? })` | `src/api/admin.ts` 或新文件 |
| settlements list query 类型 | 含四态 |
| UserOrderDetail.holdingPoints | `src/types/order.ts` |

### 4.3 用户 UI

- `OrderDetailModal`：展示 holdingPoints；refunded 隐藏 dispute/close；操作成功后回调 `onActionSuccess` 强制父级 reload（改 props，避免僵状态）  
- `ProfilePage`：列表刷新  

### 4.4 商家 UI

- `MerchantDashboardPage`：  
  - `availableActions.includes('reject')` → 拒单按钮 + 确认 Dialog  
  - 顶部 Todo strip：pending / processing / SLA  
  - 可选：点击 strip 设置 status 筛选  

### 4.5 管理 UI

- `AdminPage` orders tab：  
  - status 下拉含 disputed（及全枚举）  
  - 行内或详情「仲裁」→ Dialog：radio refund/close + note → resolve  
- settlements tab：  
  - 状态下拉四态  
  - 勾选逻辑：`status === 'pending'` only  
  - 展示 holding/voided pill  

### 4.6 测试策略

| 层级 | 范围 | 工具 |
| --- | --- | --- |
| 单元/集成 | schema、resolve、reject、settlement filter | vitest + TEST_DATABASE_URL |
| E2E | 主路径 + 拒单或仲裁 | Playwright |
| 回归 | `npm run verify:local:no-e2e` 再 e2e | 合并前 |

E2E 账号：优先 seed（merchant@ / test@ / admin@）；隔离数据用唯一商品名后缀 timestamp。

### 4.7 分支与提交策略

```text
master
  └── feat/m3-order-lifecycle-closure
        ├── feat(server): settlement status filter + order DTO fields
        ├── feat(ui): merchant reject + todo strip
        ├── feat(ui): admin resolve + settlement filters
        ├── feat(ui): user order holding/refunded UX
        └── test(e2e): manual service lifecycle
```

- 每个 Phase 1–2 个 commit，message 遵循 Conventional Commits  
- PR 描述链接 `spec.md` AC 列表  

---

## 5. 阶段划分（Phased Delivery）

### Phase 0 — 对齐（0.5d）

| 活动 | 出口 |
| --- | --- |
| 通读 spec；跑绿现有 m3 相关 vitest | 基线绿 |
| 确认 holding 积分真实语义（读 service + 单测） | 文案笔记 10 行内 |
| 建分支 | 可开发 |

### Phase A — 后端契约（0.5–1d）

| 交付 | 对应需求 |
| --- | --- |
| settlement status enum 扩展 + 测试 | REQ-F-040 |
| 用户订单 holdingPoints 输出（若缺） | REQ-F-041 |
| merchant todo counts（若选 A） | REQ-F-043 |

**出口门禁：** 相关 vitest PASS；无迁移或仅无 schema 变更。

### Phase B — 用户端 UI（0.5–1d）

| 交付 | 需求 |
| --- | --- |
| holding/refunded UX + 刷新 | REQ-F-010–015 |

**出口：** 手动点通 dispute/close；字段展示正确。

### Phase C — 商家端 UI（1d）

| 交付 | 需求 |
| --- | --- |
| reject 流 + todo + 字段展示 | REQ-F-020–027 |

**出口：** 手动拒单一单；seed 商家账号。

### Phase D — 管理端 UI（1d）

| 交付 | 需求 |
| --- | --- |
| disputed 筛选 + resolve + 结算四态 | REQ-F-030–034 |

**出口：** 仲裁 refund/close 各一次；batch 仅 pending。

### Phase E — QA 与收口（1d）

| 交付 | 需求 |
| --- | --- |
| E2E + 全量回归 + checklist 勾选 | REQ-F-050–053 |
| PRD §0.1 可选更新 | 文档 |

**出口：** `checklist.md` 全部 P0 项勾选；PR Ready for Review。

### 建议日程（单人全职）

| 日 | 内容 |
| --- | --- |
| D1 | Phase 0 + A + B 启动 |
| D2 | C 完成 |
| D3 | D 完成 |
| D4 | E + PR |

双人时可 B∥C 与 A 后并行。

---

## 6. 依赖与并行约束

```text
Phase 0
   │
   ▼
Phase A ──────────────┐
   │                  │
   ▼                  ▼
Phase B            Phase C ──► 均可依赖 A 的 DTO/stats
   │                  │
   └────────┬─────────┘
            ▼
         Phase D（依赖 A 的 settlement filter）
            │
            ▼
         Phase E
```

- **不依赖** Docker publish / compose 变更  
- **不依赖** M4 任何设计  

---

## 7. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| AdminPage 巨型文件合并冲突 | 中 | 中 | 抽取 `AdminOrderResolveDialog.tsx` 等小组件 |
| 积分文案与实现不符 | 中 | 高 | Phase 0 对照单测写死文案表 |
| E2E 不稳定 / 限流 | 中 | 中 | 复用 helpers；注意 rate limit env |
| 范围蔓延（通知/MFA） | 高 | 高 | checklist 拒收范围外 |

---

## 8. 回滚策略

| 层级 | 策略 |
| --- | --- |
| 功能开关 | 本波可不加 flag；UI 缺陷可先隐藏按钮热修 |
| Git | 按 commit revert；后端 enum 放宽无破坏性 |
| 数据 | 无迁移则无数据回滚问题 |

---

## 9. 发布与沟通

1. PR 标题：`feat(m3): order lifecycle closure (UI + settlement filters)`  
2. PR 正文：链接 spec AC-01–06  
3. 合并后：灰度环境用 manual_service 商品走通 AC-01–04  
4. 通知运营：仲裁入口位置、结算四态含义  

---

## 10. 度量（可选）

| 指标 | 目标 |
| --- | --- |
| disputed 平均停留时间 | 上线后下降（人工） |
| 因结算误操作的工单 | 0（batch 仅 pending） |
| E2E 主路径 | 稳定绿 |

---

## 11. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-07-23 | 初版，对齐 Wave 1 闭环 |
