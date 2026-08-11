# 订单通知实时化 — Spec Coding 工程文档包

本目录是 SPEC-NOTIFY-RT-001 的唯一实施入口。当前只完成规格设计，不包含业务代码、依赖、配置或数据库变更。

| 文档 | 角色 | 交付内容 |
| --- | --- | --- |
| [spec.md](./spec.md) | Specify / 规格与需求 | 问题、范围、冻结决策、协议、不变量、需求、验收与追溯 |
| [plan.md](./plan.md) | Plan / 技术规划 | 目标架构、阶段、部署顺序、测试策略、回滚与风险 |
| [task.md](./task.md) | Tasks / 工作分解 | 原子任务、依赖、文件所有权、禁止项、DoD 与证据 |
| [implement.md](./implement.md) | Implement / 执行协议 | 工作树、运行时、数据库、端口、三色权限与实施卡 |
| [checklist.md](./checklist.md) | Implement Gate / 完成定义 | P0/P1 检查项、验收证据与 PR / 发布闸门 |

执行顺序固定为：Specify → Plan → Tasks → Implement → Checklist。实施 Agent 不得跳过前一阶段，也不得以代码现状反向改写已冻结需求。

| 字段 | 值 |
| --- | --- |
| 规格 ID | SPEC-NOTIFY-RT-001 |
| Plan ID | PLAN-NOTIFY-RT-001 |
| Tasks ID | TASK-NOTIFY-RT-001 |
| Implement ID | IMPL-NOTIFY-RT-001 |
| Checklist ID | CHK-NOTIFY-RT-001 |
| 版本 | 0.2.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 建议分支 | `feat/order-notification-realtime`，PR → `develop` |
| 独立 Worktree | `/root/projects/worktrees/monexus-order-notification-realtime` |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| 当前 WIP | `wip/root-mixed-20260808@af36c164`；已分叉，仅可参考，不得作为实现基线 |
| 前置规格 | SPEC-NOTIFY-001 / DESIGN-NOTIFY-001（站内通知 Phase 1） |
| 方法依据 | [JavaGuide：Spec Coding 实践](https://javaguide.cn/ai-coding/practices/spec-coding.html)；仓库既有六件套规范作为本地格式基线 |

## 本波一句话结论

在现有持久化 `Notification` 与 REST 收件箱之上，增加“同事务 `pg_notify` 提交后唤醒 → 每实例 PostgreSQL `LISTEN` → 鉴权 SSE → 前端 REST 权威重同步”，保留 30 秒轮询作为降级路径；不以 WebSocket、Redis Pub/Sub 或内存 EventEmitter 替代数据库事实源。

## Owner 审核时必须明确批准的决定

1. `O-RT-01`：SSE + PostgreSQL LISTEN/NOTIFY + REST 收敛，不采用 WebSocket / Redis。
2. `O-RT-02`：健康态 P95 ≤ 2 秒、P99 / 硬上限 ≤ 5 秒，降级收敛 ≤ 35 秒。
3. `O-RT-03`：P0 每 Tab 一条连接、每用户最多 5 条，跨 Tab leader 后置。
4. `O-RT-04`：P0 不实现 Last-Event-ID 回放，断线由 REST 权威同步恢复。
5. `O-RT-05`：只新增 `pg` / `@types/pg`，零 Prisma migration，前端使用自有受控 SSE parser。
6. `O-RT-06`：realtime 默认关闭，严格执行后端 / 代理 / 前端 / flag 发布顺序。
7. `O-RT-07`：只改变通知抵达方式，不新增、删除或改变通知事件语义。
8. `O-RT-08`：realtime=true 时，`pg_notify` SQL 失败必须使业务事务与 Notification 一起回滚；禁止吞错或移到 commit 后，启用前必须以实际数据库角色和真实 PostgreSQL 验证。

Owner 已于 2026-08-09 明确批准 O-RT-01~08，六份规格文件现已统一为 **Frozen for Implementation**。实施仍须从 I-RT-001 / T-DOC-001 的基线 delta audit 开始，不得跳过任务依赖或自行改写冻结决策。

0.2.0 审核增量索引：事务失败语义 `O-RT-08 / AC-RT-028 / CHK-BE-003 / CHK-QA-003`；生产 LISTEN session gate `AC-RT-029 / CHK-INF-007`；未来广播放大评估线 `D-RT-25 / CHK-P1-005`（P1，不阻断首次发布）。

## 规格覆盖关系

SPEC-NOTIFY-RT-001 只覆盖并替代 SPEC-NOTIFY-001 中以下旧决定：

- “SSE / WebSocket 延后到 Phase 3+”；
- NTF-08 把 30–60 秒短轮询作为正常主路径；
- 与“10 秒内可见”相关的轮询型验收方式。

本规格不改变原通知事件矩阵、收件人规则、`Notification` 数据语义、三元组幂等约束、公告与事务消息分离、纯文本展示规则及敏感交付内容禁入边界。

## 审核与实施边界

- `checklist.md` 的 P0 / P1 实施与发布项仍全部未勾选；Owner 冻结只授权进入实施，不构成代码、测试或发布证据。
- Owner 修改冻结决策时，必须同步更新 spec、plan、task、implement、checklist 和追溯矩阵。
- 实施 Agent 若发现基线代码已变化，应先提交差异说明；不得自行扩大范围或用 Redis / WebSocket 替换本方案。
- 本包没有授权触碰生产数据库、生产密钥、真实订单、他人 worktree 或当前 WIP 分支。
