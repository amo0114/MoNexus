# ValuePolicy 生产激活前工程与运维门禁审计

| 字段 | 值 |
| --- | --- |
| 文档 ID | OPS-VALUE-POLICY-ACTIVATION-READINESS-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-18 |
| 对应规格 | `docs/specs/points-value-policy-phase-1.md` §19、`docs/operations/value-policy-runbook.md` |
| 状态 | Evidence-only audit — 本轮不解除任何门禁 |
| 生产模式 | 必须保持 `POINT_VALUE_POLICY_MODE=off` |

本文是生产激活前的证据化审计与后续实施设计清单。它不创建、不调度、不激活、不退役任何生产 ValuePolicy，不修改生产门禁。后续激活必须拆成独立变更包，经单独授权后实施。

## 1. 当前真实状态

| Gate | 当前预期状态 | 本轮要求 | 实测证据 |
| --- | --- | --- | --- |
| D-02 面值 | 未批准 | 生成/准备决策支持包，不自动批准 | 决策包模板 `value-policy-d02-decision-packet.md`（READY FOR HUMAN REVIEW）；无真实输入，输出 `DATA_INPUT_REQUIRED` |
| D-03 文案 | 未批准 | 生成法务/产品审批材料，不接入生产 UI | 决策材料 `value-policy-d03-decision-packet.md`（READY FOR HUMAN REVIEW）；当前候选常量 `constants.ts:6-8`，未接入前端 |
| 双人审批 | schema 无 actor 字段、无后台入口 | 给出 additive schema/API/权限/审计设计；不要伪造 actor | `ValuePolicy` model 无 `createdBy`/`approvedBy`/`actorUserId`（`schema.prisma:1458-1479`）；governance 服务无调用方身份参数（`governance.ts:55-184`）。见 §2 设计 |
| 激活入口 | 仅内部 governance service，无公开 HTTP API | 设计受限后台/命令入口及幂等命令 ID，不开放公共接口 | `governance.ts` 内部函数；`routes.ts` 只有 `GET /current`。见 §3 设计 |
| 并发重试 | 已有 advisory lock 契约 | 设计 `40001`/`55P03` 重读后重试；`40P01` 必须 P0，不盲重试 | `VALUE_POLICY_GOVERNANCE_LOCK={classid:88170001,objid:1}`（`governance.ts:17,35`）；runbook §8 已冻结。见 §4 设计 |
| 外部告警 | 仓库有规则契约，但未证明生产告警已激活 | 列出部署、路由、接收人、演练和证据要求，不声称已部署 | `value-policy-alerts.md` + `value-policy-alerts.rules.yml` + `alertContract.ts`；静态测试 `value-policy-alerts.test.ts` 证明契约存在；文档明确“不创建或激活外部生产告警”。见 §5 |
| 生产运行时门禁 | 强制 production 只能 `off` | 保持原样；未来解除必须单独 PR 和批准记录 | `config/index.ts:530-537`（`MONEXUS_DEPLOY_ENV=production` 时 `POINT_VALUE_POLICY_MODE!=off` 拒启）；`check-prod-env.sh:347-352`；`docker-compose.prod.yml:41,96`（`MONEXUS_DEPLOY_ENV: production`、`POINT_VALUE_POLICY_MODE: ${...:-off}`） |
| 生产 policy | 不应存在 active policy | 不创建、不 seed、不 schedule | 本轮无数据库访问；未创建任何 policy。生产激活前须 `value-policy:audit` 证明 `activePolicyCount=0` |
| migration | 历史 migration 已合并 | 只允许未来 additive migration，禁止 `db push` | 4 个 migration 已合并（`20260817180000`、`20260818120000`、`20260818140000`、`20260818150000`）；runbook §1/§9 禁止 `db push` 与回滚历史 migration |
| 回滚 | 优先切回 `off` | 给出触发条件、负责人、观察窗口和审计命令 | 见 §6 |

## 2. 双人审批与操作者审计设计（未实施，仅设计）

当前 `ValuePolicy` schema 无 `actor` 字段。未来激活方案必须：

1. **Additive schema**：新增 `createdByUserId Int?`、`approvedByUserId Int?`、`actorRole String?`、`actorCommandId String?`（幂等命令 ID），均 nullable 以兼容历史行；不修改既有列语义。
2. **不变量**：`active`/`retired` 行的 `approvedByUserId` 不得为 null；`createdByUserId != approvedByUserId`（创建人 ≠ 审批人）由数据库 CHECK 或应用层强校验。
3. **审计**：每次状态推进写只追加审计记录（`fromStatus`/`toStatus`/`actorUserId`/`actorCommandId`/`occurredAt`/`reason`），禁止 UPDATE/DELETE。
4. **权限**：激活入口受限后台角色 + 显式权限位；不得开放公共 HTTP API。
5. **禁止**：不得伪造 actor、不得用单一管理员身份既创建又批准、不得绕过 `pg_advisory_xact_lock(88170001, 1)`。

属于独立工程 PR，需独立 Spec、迁移、定向测试与授权。本轮不实施。

## 3. 激活入口设计（未实施，仅设计）

当前仅有 `GET /api/value-policy/current`（`routes.ts:10`）与内部 `governance.ts` 函数。未来方案：

1. **受限后台/命令入口**：仅内部后台角色可调用，不挂公开 `/api/v1` 前缀。
2. **幂等命令 ID**：每次激活/调度/退役携带高熵 `actorCommandId`；同 ID 重放返回首次结果，不同请求指纹报冲突。
3. **状态机**：仅 `draft → approved → scheduled → active → retired`（`governance.ts` 已实现内部函数）。
4. **时间约束**：`createdAt <= approvedAt <= effectiveAt`；`scheduled → active` 仅在 `effectiveAt` 后；生效至少提前 7 天（紧急修复除外）。
5. **禁止**：不开放公共接口、不放宽 `expectedValuePolicyId` 校验、不绕过 `VALUE_POLICY_CHANGED`/`VALUE_POLICY_UNAVAILABLE` 错误码矩阵。

属于独立工程 PR。本轮不实施。

## 4. 并发重试设计

`VALUE_POLICY_GOVERNANCE_LOCK={classid:88170001,objid:1}`（`governance.ts:17,35`），事务级 advisory lock。激活/资产 disable/retire/订单政策确认共享该锁。

- **可重试**：`40001`（serialization_failure）与 `55P03`（lock_not_available）必须**先重读**当前 policy/asset 状态，再用新 `actorCommandId` 重试。
- **禁止盲重试**：连接断开后结果未知的激活，必须先检视行状态，再发新命令 ID。
- **禁止重试**：`23514` 业务拒绝（非法状态转移、资产在用、`effectiveAt` 未到）。
- **P0 事件**：`40P01`（deadlock_detected）不得进入自动重试循环。closure lock order 已设计为不产生 `40P01`；若出现，按 P0 并发事件处理。

## 5. 外部告警证据要求

仓库已有契约：`docs/operations/value-policy-alerts.md`、`value-policy-alerts.rules.yml`、`server/src/modules/valuePolicy/alertContract.ts`，静态测试 `value-policy-alerts.test.ts` 证明 7 条告警 ID 与 PromQL 存在。但文档明确声明“本仓库不创建或激活外部生产告警”。

未来部署必须由 operator 在 D-02/D-03 批准后完成，并保存证据：

1. **部署**：`value-policy-alerts.rules.yml` 加载进生产 Alertmanager，`promtool check rules` 通过。
2. **路由**：`value-policy-p0` → Slack incident channel（`ALERT_SLACK_WEBHOOK_URL`）+ 邮件（`ALERT_EMAIL_TO`）；`value-policy-p1` 同路由。见 `docs/operations/alert-routing.md`。
3. **接收人**：Backend on-call，具名轮值表。
4. **演练**：对每条 P0 规则触发一次（如制造 `value_policy_resolution_total{result="unavailable"}`），确认告警到达。
5. **指标暴露**：`value_policy_resolution_total{result,mode}`、`value_policy_changed_total`、`order_pricing_snapshot_created_total`、`order_pricing_snapshot_failure_total`、`order_value_policy_enabled_committed_total`、`value_policy_missing_snapshot_orders`。

本轮不部署、不声称已部署。

## 6. 回滚设计

- **首选**：`POINT_VALUE_POLICY_MODE` 切回 `off`（production 守卫已支持）。
- **触发条件**：P0 告警（多 active policy、active policy 内部数据损坏、enabled 模式订单缺 snapshot、snapshot 与 `Order.price` 不一致）、`40P01` 出现、对账差异。
- **负责人**：Backend on-call + 技术负责人批准。
- **观察窗口**：切回 `off` 后至少观察一个订单周期 + 一个结算周期，确认 snapshot 不再写入、`value-policy:audit` clean。
- **禁止**：不回滚/重写已部署 Prisma migration（forward-fix only）；不手工 UPDATE 生产 ValuePolicy 行；不关闭 trigger；不 `session_replication_role=replica`；不 `prisma db push`。
- **审计命令**：
  ```bash
  npm --prefix server run value-policy:audit -- --since=<enabled-mode-window-start>
  ```
  退出码 `2` 表示存在 findings。

## 7. 后续独立变更包（不得合并为“大爆炸”提交）

| # | 变更包 | 类型 | 依赖 |
| ---: | --- | --- | --- |
| 1 | 双人审批与操作者审计的通用工程 PR | 工程 | additive schema + API + 权限 + 审计 |
| 2 | 外部告警部署与演练证据 | 运维 | D-02/D-03 批准后 |
| 3 | D-02/D-03 决策记录 | 人工批准 | 真实数据回测 + 会签 |
| 4 | staging `shadow` 演练 | 运维 | #1 #2 #3 |
| 5 | staging `enforce` 演练 | 运维 | #4 |
| 6 | 生产门禁解除 PR | 工程 | #5 + 批准记录 |
| 7 | 生产 scheduled policy 变更单 | 运维 | #6 |
| 8 | production `shadow` 观察 | 运维 | #7 |
| 9 | 客户端兼容窗口 | 前端 | #8 |
| 10 | production `enforce` 独立批准 | 人工批准 | #9 |

不得把上述内容合成一次提交或一次部署。

```text
D-02 STATUS: NOT APPROVED
D-03 STATUS: NOT APPROVED
POINT_VALUE_POLICY_MODE=off (production must remain)
```
