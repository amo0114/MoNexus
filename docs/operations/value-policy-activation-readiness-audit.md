# ValuePolicy 生产激活前工程与运维门禁审计

| 字段 | 值 |
| --- | --- |
| 文档 ID | OPS-VALUE-POLICY-ACTIVATION-READINESS-001 |
| 版本 | 0.2.0 |
| 日期 | 2026-08-18 |
| 对应规格 | `docs/specs/points-value-policy-phase-1.md` §19、`docs/operations/value-policy-runbook.md` |
| 状态 | D-02/D-03 owner directive recorded; staging release deployed; production gates remain |
| 生产模式 | 必须保持 `POINT_VALUE_POLICY_MODE=off` |

本文是生产激活前的证据化审计与后续实施设计清单。它不创建、不调度、不激活、不退役任何生产 ValuePolicy，不修改生产门禁。后续激活必须拆成独立变更包，经单独授权后实施。

## 1. 当前真实状态

| Gate | 当前预期状态 | 本轮要求 | 实测证据 |
| --- | --- | --- | --- |
| D-02 面值 | owner directive 批准 `100 PTS = 1 CNY` | 预上线无代表性数据例外；production enforce 前补真实回测 | `value-policy-decision-records.md`；D-02 SHA-256 `02a0d664...a998`；合成数据未作为证据 |
| D-03 文案 | owner directive 批准 `zh-CN-v1` | 固定精确原文；不虚构独立法务身份验证 | `value-policy-decision-records.md`；D-03 SHA-256 `72c148a6...2971` |
| 双人审批 | 工程已合并并部署 staging | additive actor/FK/CHECK、maker-checker、命令与事件审计 | PR #149；`develop@c52c4a8`；production 入口仍禁用 |
| 激活入口 | 受限 admin/MFA 入口已实现，production 硬拒绝 | 仅可用于未来 staging 演练；不得作为生产解锁 | `/api/admin/value-policies/**`；公共 `/api/value-policy` 仍无写入口。见 §3 |
| 并发重试 | 已有 advisory lock 契约 | 设计 `40001`/`55P03` 重读后重试；`40P01` 必须 P0，不盲重试 | `VALUE_POLICY_GOVERNANCE_LOCK={classid:88170001,objid:1}`（`governance.ts:17,35`）；runbook §8 已冻结。见 §4 设计 |
| 外部告警 | 仓库有规则契约，但未证明生产告警已激活 | 列出部署、路由、接收人、演练和证据要求，不声称已部署 | `value-policy-alerts.md` + `value-policy-alerts.rules.yml` + `alertContract.ts`；静态测试 `value-policy-alerts.test.ts` 证明契约存在；文档明确“不创建或激活外部生产告警”。见 §5 |
| 生产运行时门禁 | 强制 production 只能 `off` | 保持原样；未来解除必须单独 PR 和批准记录 | `config/index.ts:530-537`（`MONEXUS_DEPLOY_ENV=production` 时 `POINT_VALUE_POLICY_MODE!=off` 拒启）；`check-prod-env.sh:347-352`；`docker-compose.prod.yml:41,96`（`MONEXUS_DEPLOY_ENV: production`、`POINT_VALUE_POLICY_MODE: ${...:-off}`） |
| 生产 policy | 不应存在 active policy | 不创建、不 seed、不 schedule | 本轮无数据库访问；未创建任何 policy。生产激活前须 `value-policy:audit` 证明 `activePolicyCount=0` |
| migration | 67 个 migration 已在 staging release 启动路径成功应用 | 只允许 additive migration，禁止 `db push`；生产仍待备份/restore gate | `develop@c52c4a8` staging deployment run `32139048061` readiness 通过；生产未迁移 |
| 回滚 | 优先切回 `off` | 给出触发条件、负责人、观察窗口和审计命令 | 见 §6 |

## 2. 双人审批与操作者审计（工程已实现并部署 staging）

`SPEC-VALUE-POLICY-ACTIVATION-CONTROLS-001` 已实现：

1. 五阶段 actor FK、状态形状 CHECK 与 `createdByUserId != approvedByUserId`；
2. 创建时固定 D-02/D-03 记录引用、SHA-256 与 disclosure version；
3. `ValuePolicyGovernanceCommand` 保存幂等结果，`ValuePolicyGovernanceEvent` 由数据库 trigger 保护为只追加；
4. 每次命令与 `AdminLog` 在同一 advisory-lock transaction 中完成；
5. migration 遇到既有 policy 行时拒绝伪造 backfill。

该工程能力已进入 staging release，但尚无两个真实 staging admin + MFA actor 完成状态机演练。production 命令入口仍 fail closed。

## 3. 受限激活入口（工程已实现，production 禁用）

当前写入口仅挂载于 `/api/admin/value-policies`，继承 admin + current MFA：

1. **受限后台/命令入口**：仅有效管理员和当前 MFA session 可调用；公共路由无写入口。
2. **幂等命令 ID**：每次命令携带 `Idempotency-Key`；同 actor/key 重放返回首次结果，不同请求指纹 409。
3. **状态机**：仅 `draft → approved → scheduled → active → retired`（`governance.ts` 已实现内部函数）。
4. **时间约束**：`createdAt <= approvedAt <= effectiveAt`；`scheduled → active` 仅在 `effectiveAt` 后；生效至少提前 7 天（紧急修复除外）。
5. **禁止**：不开放公共接口、不放宽 `expectedValuePolicyId` 校验、不绕过 `VALUE_POLICY_CHANGED`/`VALUE_POLICY_UNAVAILABLE` 错误码矩阵。

`NODE_ENV=production + MONEXUS_DEPLOY_ENV=production` 在数据库访问前固定 403。解除该守卫仍属于独立生产门禁 PR。

## 4. 并发重试设计

`VALUE_POLICY_GOVERNANCE_LOCK={classid:88170001,objid:1}`（`governance.ts:17,35`），事务级 advisory lock。激活/资产 disable/retire/订单政策确认共享该锁。

- **可重试**：`40001`（serialization_failure）与 `55P03`（lock_not_available）必须**先重读**当前 policy/asset 状态，再用新 `actorCommandId` 重试。
- **禁止盲重试**：连接断开后结果未知的激活，必须先检视行状态，再发新命令 ID。
- **禁止重试**：`23514` 业务拒绝（非法状态转移、资产在用、`effectiveAt` 未到）。
- **P0 事件**：`40P01`（deadlock_detected）不得进入自动重试循环。closure lock order 已设计为不产生 `40P01`；若出现，按 P0 并发事件处理。

## 5. 外部告警证据要求

仓库已有契约：`docs/operations/value-policy-alerts.md`、`value-policy-alerts.rules.yml`、`server/src/modules/valuePolicy/alertContract.ts`，静态测试 `value-policy-alerts.test.ts` 证明 7 条告警 ID 与 PromQL 存在。但文档明确声明“本仓库不创建或激活外部生产告警”。

外部告警仍须由 operator 配置真实接收端并保存证据：

1. **部署**：`value-policy-alerts.rules.yml` 加载进生产 Alertmanager，`promtool check rules` 通过。
2. **路由**：`value-policy-p0` → Slack incident channel（`ALERT_SLACK_WEBHOOK_URL`）+ 邮件（`ALERT_EMAIL_TO`）；`value-policy-p1` 同路由。见 `docs/operations/alert-routing.md`。
3. **接收人**：Backend on-call，具名轮值表。
4. **演练**：对每条 P0 规则触发一次（如制造 `value_policy_resolution_total{result="unavailable"}`），确认告警到达。
5. **指标暴露**：`value_policy_resolution_total{result,mode}`、`value_policy_changed_total`、`order_pricing_snapshot_created_total`、`order_pricing_snapshot_failure_total`、`order_value_policy_enabled_committed_total`、`value_policy_missing_snapshot_orders`。

`value-policy-p0` 路由 dry-run `32138076898` 已通过，但 dry-run 不是消息到达证据。GitHub staging/production environment 尚无 `ALERT_SLACK_WEBHOOK_URL`、邮件路由或 Sentry 凭据，因此不声称已部署。

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
| 1 | 双人审批与操作者审计的通用工程 PR | 工程 | **完成：PR #149 / `c52c4a8`** |
| 2 | 外部告警部署与演练证据 | 运维 | D-02/D-03 批准后 |
| 3 | D-02/D-03 决策记录 | owner directive | **完成（带 D-02 无数据例外及 production-enforce 限制）** |
| 4 | staging `shadow` 演练 | 运维 | #1 #2 #3 |
| 5 | staging `enforce` 演练 | 运维 | #4 |
| 6 | 生产门禁解除 PR | 工程 | #5 + 批准记录 |
| 7 | 生产 scheduled policy 变更单 | 运维 | #6 |
| 8 | production `shadow` 观察 | 运维 | #7 |
| 9 | 客户端兼容窗口 | 前端 | #8 |
| 10 | production `enforce` 独立批准 | 人工批准 | #9 |

不得把上述内容合成一次提交或一次部署。

```text
D-02 STATUS: APPROVED — PRELAUNCH NO-REPRESENTATIVE-DATA EXCEPTION
D-03 STATUS: APPROVED
POINT_VALUE_POLICY_MODE=off (production must remain)
```
