# ValuePolicy 双人治理与受限入口规格

| 字段 | 值 |
| --- | --- |
| 文档 ID | `SPEC-VALUE-POLICY-ACTIVATION-CONTROLS-001` |
| 版本 | 1.0.0 |
| 日期 | 2026-08-18 |
| 状态 | Implemented — production command entry remains disabled |
| 上位规格 | `points-value-policy-phase-1.md` §19 |

## 1. 目标与边界

本规格实现政策生命周期的双人控制、操作者归属、受限管理入口、幂等命令和只追加审计。它不批准 D-02/D-03，不创建任何生产政策，不解除 production `off` 守卫，也不部署外部告警或 staging。

## 2. 权限和环境边界

- HTTP 路径仅位于 `/api/admin/value-policies`，继承 `authenticate → requireActiveUser → requireAdmin → requireAdminMfa`。
- `/api/value-policy` 仍只有只读 `GET /current`，不得新增公共治理入口。
- `NODE_ENV=production` 且 `MONEXUS_DEPLOY_ENV=production` 时，治理命令在任何数据库读取或写入前返回 `403 VALUE_POLICY_GOVERNANCE_DISABLED`。
- staging 可使用该入口做演练；生产解除必须另立 PR，引用已批准的 D-02/D-03 和运维证据。

## 3. 数据契约

每条 `ValuePolicy` 固定记录五个生命周期 actor：created / approved / scheduled / activated / retired。创建人必填，后续 actor 随合法状态推进填写。数据库同时保证：

1. 创建人和审批人不得相同；
2. actor 必须引用真实且操作时为有效状态的管理员；数据库 trigger 与应用服务双重校验，删除受 `RESTRICT` 保护；
3. actor、时间、经济字段和决策证据在状态推进后不可改；
4. 只允许 `draft → approved → scheduled → active → retired`；
5. D-02/D-03 记录引用、各自 64 位小写 SHA-256 和 disclosure version 在创建时必填。
6. 受限入口创建的 `effectiveAt` 必须至少晚于服务器当前时间 7 天。

升级 migration 若发现既有 `ValuePolicy` 行会以 `value_policy_activation_controls_require_empty_policy_table` 失败。不得为历史行猜测或伪造 actor/批准证据。

## 4. 命令和幂等

支持 `create / approve / schedule / activate / retire`。所有请求必须携带经 OWS trim 后匹配 `[A-Za-z0-9._:-]{1,128}` 的 `Idempotency-Key`。

- 唯一域为 `(actorUserId, idempotencyKey)`；
- payload 使用固定版本 canonical 内容计算 SHA-256；
- 同 key、同 payload 返回首次 allowlisted policy 结果并标记 `replayed=true`；
- 同 key、不同 payload 返回 `409 VALUE_POLICY_IDEMPOTENCY_CONFLICT`；
- 政策变更、命令、事件和 `AdminLog` 位于同一数据库事务，并持有既有 advisory lock `(88170001, 1)`。

## 5. 审计

`ValuePolicyGovernanceEvent` 保存 policy、command、actor、action、from/to status、reason 和时间。命令与事件表均由数据库 trigger 拒绝 UPDATE/DELETE。`AdminLog` 仅保存结构化 policy/command/status 信息，不复制理由、决策正文或秘密。

## 6. 稳定错误

| HTTP | code | 含义 |
| ---: | --- | --- |
| 400 | `VALUE_POLICY_IDEMPOTENCY_KEY_REQUIRED` | 缺少幂等键 |
| 400 | `VALUE_POLICY_IDEMPOTENCY_KEY_INVALID` | 幂等键格式错误 |
| 403 | `VALUE_POLICY_GOVERNANCE_DISABLED` | production 命令入口未解锁 |
| 404 | `VALUE_POLICY_GOVERNANCE_NOT_FOUND` | 政策不存在 |
| 409 | `VALUE_POLICY_GOVERNANCE_CONFLICT` | 当前状态不允许命令 |
| 409 | `VALUE_POLICY_MAKER_CHECKER_REQUIRED` | 创建人与审批人相同 |
| 409 | `VALUE_POLICY_IDEMPOTENCY_CONFLICT` | 同 key 请求指纹变化 |
| 400 | `VALUE_POLICY_EFFECTIVE_AT_INVALID` | 生效时间未至少提前 7 天 |

## 7. 明确未完成

- D-02 仍须代表性数据和产品/财务/法务/技术会签；
- D-03 仍须产品/法务批准最终原文及展示面；
- production 入口仍硬拒绝；
- Prometheus/Alertmanager、staging shadow/enforce 和 production rollout 不在本工程 PR 内。
