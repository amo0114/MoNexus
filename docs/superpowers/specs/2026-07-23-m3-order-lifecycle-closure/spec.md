# Spec: M3 订单履约生命周期闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `SPEC-M3-OLC-001` |
| 版本 | `1.0.0` |
| 日期 | `2026-07-23` |
| 状态 | `Draft for Implementation` |
| 产品 | MoNexus |
| 关联 PRD | `docs/superpowers/specs/2026-04-30-monexus-product-prd.md` §4.3.1–4.3.2 |
| 关联实现（后端已有） | PR #20 订单状态机 + 积分冻结；`orders/cron.ts` 自动关单 |
| 配套文档 | [`plan.md`](./plan.md) · [`task.md`](./task.md) · [`checklist.md`](./checklist.md) |

---

## 1. 目的与问题陈述

### 1.1 目的（Why）

后端已具备 **手动履约订单** 的完整状态机、积分冻结/扣减/回滚、Settlement 四态、商家拒单、管理员仲裁与自动关单能力。  
前端与运营工作流 **未形成闭环**：管理员无法在 UI 仲裁争议，商家无法拒单，结算筛选不完整，用户对冻结积分与退款结果可见性不足，E2E 未覆盖全链路。

本规格定义 **「M3 订单履约生命周期闭环（Order Lifecycle Closure）」**：在 **不新增核心领域模型** 的前提下，把已有后端能力产品化，使三端可操作、可观测、可验收。

### 1.2 问题陈述

| 痛点 | 影响 | 根因 |
| --- | --- | --- |
| 争议订单无管理端操作入口 | 状态长期卡在 `disputed` | `POST /api/admin/orders/:id/resolve` 无 UI |
| 商家 pending 订单无法拒单 | 无法快速释放冻结积分 | `POST .../fulfillment/reject` 未接前端 |
| 结算列表无法按 `holding`/`voided` 过滤 | 批量结算易误选/难核对 | Admin 查询 schema 仅 `pending\|settled`；UI 未展示四态 |
| 用户侧对冻结积分/时间线理解不足 | 客诉与对账成本 | 详情字段未充分展示 `holdingPoints`、终态文案 |
| 缺少全链路 E2E | 回归风险 | e2e 未覆盖 manual_service 主路径 |

### 1.3 成功标准（Success Criteria）

1. **运营可不依赖 SQL** 完成：争议仲裁、仅 `pending` 结算批量确认。  
2. **商家可不依赖 SQL** 完成：接单 / 拒单 / 履约 / 争议响应，并看到 SLA 与冻结积分。  
3. **用户**可理解订单处于履约中/争议/已退款，并在退款后余额与流水一致。  
4. **自动化**：至少 1 条 Playwright 主路径 + 现有 vitest 状态机/cron 全绿。  
5. **文档**：PRD §0.1 进度与本规格对齐（可另开文档任务）。

---

## 2. 范围

### 2.1 范围内（In Scope）

| 域 | 内容 |
| --- | --- |
| 用户端 | 订单详情展示冻结积分、状态说明、时间线；争议/确认后刷新；`refunded` 终态文案 |
| 商家端 | 拒单操作；待办计数（pending/processing/SLA）；订单列表已有动作补齐 reject |
| 管理端 | 争议队列（status=disputed 筛选）；订单详情仲裁 resolve；结算四态展示与筛选；batch-settle 仅 pending |
| API 契约补强 | Admin 结算 query 扩展 `holding`/`voided`；必要时 serializer 补字段（见 §5） |
| 测试 | 单元/集成补缺 + E2E 全链路 |
| 文档 | 本目录四件套；可选 PRD 快照更新 |

### 2.2 范围外（Out of Scope）

| 项 | 理由 |
| --- | --- |
| 订阅/续费、营销券、邀请 v2 | M4，依赖本闭环稳定后 |
| MFA / 设备会话 / 风控引擎 | M3-S3 安全波次 |
| 系统公告、用户标签 | M3 运营增强下一波 |
| 商家自定义 SLA 配置页 | 可用默认 deadline；配置 UI 下波 |
| 邮件/站内信通知 | 独立通知子系统 |
| 真支付、法币退款 | 产品边界禁止 |
| 重写状态机后端 | 已实现，本波仅修补契约缺口 |
| monorepo 目录重构 / Docker 流程变更 | 与本波无关 |

### 2.3 假设与依赖

| ID | 假设 |
| --- | --- |
| A-01 | PostgreSQL + 现有 migrations 已含 `holdingPoints`/`refunded`/`Settlement.holding\|voided` |
| A-02 | 后端 `legalTransitions`、`rejectOrder`、`resolveOrder`、auto-close cron 行为符合 PR #20 |
| A-03 | 即时模式（`instant_*`）创建后即为 `delivered`/`closed` 语义，不进入 pending 拒单路径 |
| A-04 | 积分整数、单事务不变量保持（PRD §1.4）；冻结模型已重新定义且实现存在 |
| A-05 | 部署形态不在本规格变更；仅功能与测试 |

---

## 3. 角色与用例

### 3.1 角色

| 角色 | 系统标识 | 本规格关注点 |
| --- | --- | --- |
| 用户 | `user` | 查看状态/冻结说明；争议；确认关闭 |
| 商家 | `merchant` + `Merchant.active` | 待办、接单、拒单、履约、争议响应 |
| 管理员 | `admin` | 仲裁 disputed；结算筛选与批量结算 |
| 系统 | `system` | auto-close cron（无 UI，需可观测日志/测试） |

### 3.2 用例图（逻辑）

```text
用户 ──UC-U1── 查看订单详情（状态/冻结/时间线）
    ──UC-U2── 发起争议 (delivered → disputed)
    ──UC-U3── 确认结束 (delivered|disputed → closed)

商家 ──UC-M1── 查看待办与 SLA
    ──UC-M2── 接单 (pending → processing)
    ──UC-M3── 拒单 (pending → refunded)
    ──UC-M4── 履约交付 (processing → delivered)
    ──UC-M5── 响应争议 (disputed → processing|delivered|closed)

管理 ──UC-A1── 筛选争议订单
    ──UC-A2── 仲裁 (disputed → refunded|closed)
    ──UC-A3── 按结算状态筛选并批量结算 (仅 pending)

系统 ──UC-S1── delivered 超时自动 closed
```

### 3.3 用例 → 需求追溯

| 用例 | 需求 ID |
| --- | --- |
| UC-U1 | REQ-F-010, REQ-F-011 |
| UC-U2 | REQ-F-012（已有 API/部分 UI，补齐反馈） |
| UC-U3 | REQ-F-013 |
| UC-M1 | REQ-F-020, REQ-F-021 |
| UC-M2 | REQ-F-022（已有） |
| UC-M3 | REQ-F-023 |
| UC-M4 | REQ-F-024（已有） |
| UC-M5 | REQ-F-025（已有） |
| UC-A1 | REQ-F-030 |
| UC-A2 | REQ-F-031 |
| UC-A3 | REQ-F-032, REQ-F-033 |
| UC-S1 | REQ-F-040（已有后端，补 E2E/可观测说明） |

---

## 4. 领域规则（Domain Rules）

### 4.1 状态机（不可变约束）

合法迁移以 `server/src/modules/orders/fulfillment.ts` 为准：

```text
pending    → processing | refunded
processing → delivered
delivered  → disputed | closed
disputed   → processing | delivered | closed | refunded
closed     → ∅
refunded   → ∅

legacy: completed ≡ delivered（normalizeOrderStatus）
```

| 规则 ID | 规则 |
| --- | --- |
| DR-01 | 禁止绕过 `assertLegalStatusTransition` 直接改 `Order.status` |
| DR-02 | 每次迁移必须写 `OrderStatusEvent`（含 actorRole/action） |
| DR-03 | 越权访问他方订单资源返回 **404**（非 403） |
| DR-04 | 积分金额恒为非负整数；禁止浮点 |

### 4.2 积分与 Settlement（manual_service）

| 规则 ID | 事件 | 积分 | Settlement |
| --- | --- | --- | --- |
| DR-10 | 创建 manual_service 订单 | 记 `holdingPoints`，**不**从 balance 扣减（以现实现为准） | `holding` |
| DR-11 | 关闭 closed（用户确认或 auto-close 或仲裁 close） | 扣减 balance，`PointLog out`，清空 holdingPoints | `holding` → `pending` |
| DR-12 | 退款 refunded（拒单或仲裁 refund） | 审计 `PointLog in`（余额不变或按现实现），清空 holdingPoints | `holding` → `voided` |
| DR-13 | batch-settle | 仅 `status=pending` 可变 `settled` | — |
| DR-14 | instant_* 模式 | 创建时即时交付语义；不走 pending 拒单 | 按既有订单逻辑 |

> **实现对齐说明：** 具体 PointLog 文案与 balance 是否在创建时已扣，以 `server/src/modules/orders/service.ts` 与 PR #20 单测为准。本规格要求 UI 文案与 **实际 API 响应** 一致，不得臆造「余额已扣/未扣」。

### 4.3 设计原则（本规格遵循）

| 原则 | 在本波中的体现 |
| --- | --- |
| **单一事实来源** | 状态机只认后端 `fulfillment.ts`；前端用 `availableActions`/状态字段驱动按钮，不本地硬编码平行规则 |
| **渐进增强** | 优先接线已有 API；仅在契约缺口处改后端（如 settlement query enum） |
| **最小惊讶** | 用户/商家/管理看到同一状态中文标签（`RegistryPill` / businessRegistry） |
| **失败可解释** | 错误展示后端 `error.message`；结算不可选原因可见 |
| **可测试性** | 关键按钮保留/新增 `data-testid`；E2E 不依赖脆弱 CSS |
| **安全默认** | 仲裁与结算仅 admin；拒单仅本人商家；无跨商户数据 |
| **不破坏边界** | 非法币、不新支付通道 |

---

## 5. 功能需求

### 5.1 用户端

| ID | 优先级 | 需求 | 验收要点 |
| --- | --- | --- | --- |
| REQ-F-010 | P0 | 订单详情展示：`status`、`deliveryMode`、时间线 `timeline`、交付内容（若有） | 与 `GET /api/orders/:id` 字段一致 |
| REQ-F-011 | P0 | 当存在冻结语义时，展示 `holdingPoints`（若 API 返回）及简短说明文案 | `holdingPoints>0` 或状态 pending/processing/disputed 时可见；refunded/closed 后不误导 |
| REQ-F-012 | P0 | 保持/强化争议：`delivered` 可争议；成功后列表/详情刷新为 `disputed` | 已有 `OrderDetailModal`；修复仅 close 不刷新父列表的体验 |
| REQ-F-013 | P0 | 确认结束：`delivered` 或 `disputed` 可 close；成功后状态 `closed` | 同刷新要求 |
| REQ-F-014 | P1 | `refunded` 状态展示「已退款/积分已处理」类文案，隐藏争议/确认按钮 | 无非法操作入口 |
| REQ-F-015 | P1 | 列表项状态 pill 覆盖全枚举含 refunded | Registry 配置完整 |

### 5.2 商家端

| ID | 优先级 | 需求 | 验收要点 |
| --- | --- | --- | --- |
| REQ-F-020 | P0 | 订单 tab 顶部待办摘要：pending 数、processing 数、`slaExceeded` 数（可客户端基于列表聚合或新增 stats 字段） | 数字与筛选一致 |
| REQ-F-021 | P0 | SLA 超时行持续高亮（已有部分实现则补齐列表+详情） | `slaExceeded===true` 可见 |
| REQ-F-022 | P0 | 接单：`availableActions` 含 `start_fulfillment` 时显示并调用现 API | 成功后状态 processing |
| REQ-F-023 | P0 | **拒单**：`availableActions` 含 `reject` 时显示；确认对话框 + optional publicNote；调用 `POST /merchant/orders/:id/fulfillment/reject` | 成功后 refunded；用户侧可见退款态 |
| REQ-F-024 | P0 | 履约 deliver（已有）保持可用 | 无回归 |
| REQ-F-025 | P0 | 争议响应（已有）保持可用 | 无回归 |
| REQ-F-026 | P1 | 订单详情/列表展示 holdingPoints、fulfillmentDeadline | 字段来自 API |
| REQ-F-027 | P1 | 结算 tab 展示 settlement.status 含 holding/voided | 文案正确 |

### 5.3 管理端

| ID | 优先级 | 需求 | 验收要点 |
| --- | --- | --- | --- |
| REQ-F-030 | P0 | 订单列表支持 `status=disputed` 筛选（后端已有 enum 则接 UI） | 仅显示争议单 |
| REQ-F-031 | P0 | 对 disputed 订单提供仲裁：`result=refund\|close` + optional note → `POST /admin/orders/:id/resolve` | 成功后状态与积分/结算符合 DR-11/12 |
| REQ-F-032 | P0 | 结算列表展示四态：pending/settled/holding/voided | pill 映射完整 |
| REQ-F-033 | P0 | 结算筛选支持 holding/voided/pending/settled；**批量结算仅可选 pending** | 非 pending 不可勾选或提交 400 |
| REQ-F-034 | P1 | 订单详情（admin）展示 timeline + holdingPoints | 仲裁前可审阅 |

### 5.4 后端契约补强（仅缺口）

| ID | 优先级 | 需求 | 说明 |
| --- | --- | --- | --- |
| REQ-F-040 | P0 | `listSettlementsQuerySchema.status` 扩展为 `pending\|settled\|holding\|voided` | 当前仅 pending/settled，阻塞 REQ-F-033 |
| REQ-F-041 | P1 | 用户订单 detail/list serializer 明确返回 `holdingPoints`（若尚未返回） | 支撑 REQ-F-011 |
| REQ-F-042 | P2 | 可选别名 `POST /orders/:id/confirm` → 与 close 同行为 | PRD 命名对齐；非必须 |
| REQ-F-043 | P1 | merchant stats 或专用 endpoint 返回 todoCounts（pending/processing/slaExceeded） | 若前端聚合成本过高则实现；否则允许前端聚合并文档化 |

### 5.5 测试与质量

| ID | 优先级 | 需求 |
| --- | --- | --- |
| REQ-F-050 | P0 | 现有 `m3-order-state-machine` / `orders-cron` / merchant reject / admin resolve 单测保持绿 |
| REQ-F-051 | P0 | 新增或扩展 Playwright：manual_service 从下单→接单→交付→用户确认 主路径 |
| REQ-F-052 | P0 | Playwright：商家拒单 或 管理员仲裁 至少一条 |
| REQ-F-053 | P1 | Admin 结算筛选与 batch-settle 的 API/组件级测试 |

---

## 6. 非功能需求

| ID | 类别 | 需求 |
| --- | --- | --- |
| REQ-NF-01 | 安全 | 不新增越权面；沿用 authenticate + role 中间件 |
| REQ-NF-02 | 安全 | 拒单/仲裁 publicNote 长度上限与后端 zod 一致；前端 trim |
| REQ-NF-03 | 性能 | 待办计数若用列表聚合，pageSize 不得为了计数拉全表；优先 stats 或 count 查询 |
| REQ-NF-04 | 可访问性 | 关键操作按钮具备可访问名称；对话框 focus 陷阱沿用 Dialog 组件 |
| REQ-NF-05 | 可观测 | 不改变 cron 行为；错误仍走既有 errorHandler/Sentry |
| REQ-NF-06 | 兼容 | Node 20；不引入新运行时依赖除非必要 |
| REQ-NF-07 | i18n | 本期中文文案即可；状态码走 registry |

---

## 7. API 契约（本波依赖）

### 7.1 已存在（接线）

| 方法 | 路径 | 角色 | 用途 |
| --- | --- | --- | --- |
| POST | `/api/orders/:id/dispute` | user | 争议 |
| POST | `/api/orders/:id/close` | user | 确认结束 |
| GET | `/api/orders/:id` | user | 详情+timeline |
| POST | `/api/merchant/orders/:id/fulfillment/start` | merchant | 接单 |
| POST | `/api/merchant/orders/:id/fulfillment/deliver` | merchant | 交付 |
| POST | `/api/merchant/orders/:id/fulfillment/respond-dispute` | merchant | 争议响应 |
| POST | `/api/merchant/orders/:id/fulfillment/reject` | merchant | **拒单（UI 缺失）** |
| POST | `/api/admin/orders/:id/resolve` | admin | **仲裁（UI 缺失）** body `{ result: 'refund'\|'close', note? }` |
| GET | `/api/admin/orders?status=` | admin | 筛选 |
| GET | `/api/admin/settlements?status=` | admin | 结算列表 |
| POST | `/api/admin/settlements/batch-settle` | admin | `{ settlementIds: number[] }` |

### 7.2 需修改

| 变更 | 文件提示 | 说明 |
| --- | --- | --- |
| settlement status query enum | `server/src/modules/admin/schema.ts` | 加入 holding, voided |
| 用户订单 DTO | `orders/serializers` 或 service | 确认 holdingPoints 输出 |
| OpenAPI（若维护） | `docs/superpowers/specs/monexus-api-openapi.json` | 同步枚举（P2） |

### 7.3 错误语义

| 场景 | 期望 |
| --- | --- |
| 非法状态迁移 | 400 + 明确 message |
| 非属主订单 | 404 |
| batch-settle 含非 pending | 400 或忽略并返回部分成功（**以现实现为准，UI 必须预先过滤**） |

---

## 8. UI / UX 需求

### 8.1 交互原则

1. 破坏性操作（拒单、仲裁退款、批量结算）必须 **二次确认**。  
2. 按钮可见性优先使用 **`availableActions`**（商家）或 **状态+角色**（用户/管理），避免前后端规则分叉。  
3. 操作成功后：**刷新当前列表/详情**，Toast 成功/失败。  
4. 加载中禁用重复提交（已有 Loader 模式）。

### 8.2 文案建议（可微调）

| 场景 | 文案方向 |
| --- | --- |
| 冻结中 | 「本单冻结积分：N（订单完成后正式扣除/退回规则以流水为准）」 |
| 拒单确认 | 「拒单后订单将退款结束，冻结积分退还用户，不可恢复」 |
| 仲裁 refund | 「支持用户：订单标记已退款，结算作废」 |
| 仲裁 close | 「支持商家：订单关闭，进入可结算」 |

### 8.3 组件落点（建议）

| 区域 | 建议文件 |
| --- | --- |
| 用户订单 | `src/components/OrderDetailModal.tsx`, `ProfilePage.tsx` |
| 商家 | `src/pages/MerchantDashboardPage.tsx`, `src/api/merchant.ts` |
| 管理 | `src/pages/AdminPage.tsx`, `src/api/admin.ts`（或新建 `adminOrders.ts`） |
| 类型 | `src/types/order.ts`, `src/types/merchant.ts` |

---

## 9. 数据与状态展示映射

| Order.status | 用户可见名（示例） | 主要动作 |
| --- | --- | --- |
| pending | 待商家处理 | （用户）等待 |
| processing | 履约中 | 等待 |
| delivered | 已交付 | 争议 / 确认结束 |
| disputed | 争议中 | 确认结束（若策略允许）/ 等待平台 |
| closed | 已完成 | 评价（若 canReview） |
| refunded | 已退款 | 无履约动作 |

| Settlement.status | 含义 |
| --- | --- |
| holding | 订单未完结，不可结算 |
| pending | 可批量结算 |
| settled | 已结算 |
| voided | 退款作废 |

---

## 10. 验收标准（Acceptance Criteria）

### AC-01 商家拒单闭环

**Given** active 商家存在 `manual_service` 且状态 `pending` 的订单  
**When** 商家在 UI 确认拒单  
**Then** 订单 `refunded`，Settlement `voided`，用户订单展示已退款，且无接单按钮  

### AC-02 管理员仲裁退款

**Given** 订单 `disputed`  
**When** 管理员 resolve `result=refund`  
**Then** 订单 `refunded`，Settlement `voided`，AdminLog/状态事件可追溯  

### AC-03 管理员仲裁关闭

**Given** 订单 `disputed`  
**When** 管理员 resolve `result=close`  
**Then** 订单 `closed`，Settlement 为 `pending`（或实现规定的可结算态），可被 batch-settle  

### AC-04 批量结算安全

**Given** 列表含 holding/voided/pending  
**When** 管理员打开结算页  
**Then** 仅 pending 可勾选；提交后仅这些记录变为 settled  

### AC-05 主路径 E2E

**Given** 测试商家与用户  
**When** 兑换 manual_service → 接单 → 交付 → 用户确认  
**Then** 终态 closed，关键 UI 无报错  

### AC-06 无回归

**Given** 全量 vitest + 既有 e2e  
**When** 本波合并前  
**Then** 全部通过（或已知豁免已文档化）  

---

## 11. 风险与开放问题

| ID | 风险/问题 | 缓解 |
| --- | --- | --- |
| R-01 | 积分冻结语义与产品文案不一致 | 实现前对照单测与 PointLog；文案跟事实 |
| R-02 | AdminPage 体量大，改动易冲突 | 局部组件抽取；小 PR |
| R-03 | settlement query 扩展影响旧客户端 | 仅放宽 enum，向后兼容 |
| R-04 | 待办计数性能 | 优先 count 查询或限制聚合页 |
| OQ-01 | disputed 时用户 close 是否保留 | 现 UI 允许；保持与后端一致，不本波收紧除非产品否决 |
| OQ-02 | 是否必须做 `/confirm` 别名 | 默认不做（P2） |

---

## 12. 需求追溯矩阵（摘要）

| 需求 | plan 阶段 | task 包 | checklist 章节 |
| --- | --- | --- | --- |
| REQ-F-010–015 | Phase B | T-FE-USER | §用户端 |
| REQ-F-020–027 | Phase C | T-FE-MERCHANT | §商家端 |
| REQ-F-030–034 | Phase D | T-FE-ADMIN | §管理端 |
| REQ-F-040–043 | Phase A | T-BE-CONTRACT | §后端 |
| REQ-F-050–053 | Phase E | T-QA | §测试 |
| REQ-NF-* | 全程 | 全部 | §非功能 |

---

## 13. 变更控制

1. 范围外功能不得塞入本规格实现 PR，应另开 SPEC。  
2. 修改 DR-* 领域规则需双人评审并更新 PRD。  
3. 本文件版本号：语义化，破坏性范围变更升 minor+。  

---

## 14. 批准

| 角色 | 姓名 | 日期 | 结论 |
| --- | --- | --- | --- |
| 产品 | | | |
| 技术负责人 | | | |
| 实现 Agent/开发 | | | |
