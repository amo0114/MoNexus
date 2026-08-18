# D-03 CNY 参考价值文案决策材料（READY FOR HUMAN REVIEW）

| 字段 | 值 |
| --- | --- |
| 文档 ID | OPS-VALUE-POLICY-D03-DECISION-001 |
| 版本 | 0.1.0（草案） |
| 日期 | 2026-08-18 |
| 对应规格 | `docs/specs/points-value-policy-phase-1.md` §8.1、`docs/specs/points-real-value-alignment.md` §11 |
| 状态 | `READY FOR HUMAN REVIEW` |
| D-03 | `NOT APPROVED` |

本文件是供产品/法务审阅的 D-03 决策材料，不是已批准文案。所有候选文案均标记 `DRAFT — NOT APPROVED`。即使 current-policy API 已有候选常量，也不等于 D-03 已批准。本阶段不得把草案接入前端，不得因常量存在而把 D-03 标成完成。

## 1. 当前候选原文与代码位置

| 项 | 值 |
| --- | --- |
| 常量 | `VALUE_POLICY_DISCLOSURE` |
| 代码位置 | `server/src/modules/valuePolicy/constants.ts:6-8` |
| 原文 | `积分为平台内部权益，所示金额仅为参考价值，不代表现金赎回承诺。` |
| 暴露方式 | `GET /api/value-policy/current` 的 `disclosure` 字段（`server/src/modules/valuePolicy/service.ts:248`） |
| 适用模式 | 仅 `shadow` / `enforce` 返回；`off` 模式返回 `404 VALUE_POLICY_DISABLED` |
| 前端生产展示 | **尚未实施**（不属于 Phase 1 已完成范围） |

当前候选不等于已批准文案。任何生产展示前必须先完成 D-03 批准。

## 2. 展示面清单（未来可能出现的位置）

1. 政策 API 响应（`GET /api/value-policy/current` → `disclosure`）
2. checkout preview（积分价格 + 参考价值 + 政策 ID）
3. 订单确认页（创建订单响应 + `pricing`）
4. 订单历史 / 订单详情（必须来自 `OrderPricingSnapshot`，不得按当前政策重算）
5. 帮助 / 条款页面
6. 错误 / 空状态（`VALUE_POLICY_DISABLED` / `VALUE_POLICY_CHANGED` / `VALUE_POLICY_UNAVAILABLE` / `VALUE_POLICY_DATA_INVALID` / `VALUE_POLICY_REQUIRED`）

## 3. 文案候选（均标记 `DRAFT — NOT APPROVED`）

### 3.1 长版

> DRAFT — NOT APPROVED
> 积分为平台内部权益，所示金额仅为参考价值，不代表现金赎回承诺。积分不可购买、转让、提现或兑换法币。

### 3.2 短版

> DRAFT — NOT APPROVED
> 所示金额为参考价值，非现金赎回承诺。

### 3.3 紧凑版

> DRAFT — NOT APPROVED
> 参考价值，非现金。

## 4. 必须表达的含义

每条最终文案必须表达：

1. 积分是平台内部权益；
2. 所示 CNY 仅为参考价值；
3. 不代表现金赎回承诺。

## 5. 禁用语清单

下列词汇不得出现在生产展示文案中：

- 现金余额
- 可提现 / 提现
- 保本
- 储备
- 兑付 / 兑换承诺
- 平台负债
- 固定兑换承诺

## 6. 历史订单展示原则

当 D-02 比例发生版本变化时：

1. 历史订单只能显示订单确认时的 `OrderPricingSnapshot`；
2. 不得按当前政策重算历史参考价值；
3. 无可靠政策的历史订单标记 `LEGACY_UNVALUED`，UI 显示“历史订单无参考价值”，禁止回填假汇率；
4. 政策变化不影响已确认订单的积分扣减、退款、结算语义。

## 7. 本地化

- 中文为当前首发范围；
- 如提出其他语言，只能列为后续本地化需求；
- 不得自行翻译后宣称法律等价；任何多语言文案必须单独经法务审阅批准。

## 8. 会签栏

本材料只能标记 `READY FOR HUMAN REVIEW`。未填写不可变批准记录前不得标 approved。不得预填批准日期或替审批人签名。

| 角色 | 姓名 | 日期 | 签名 | 意见 |
| --- | --- | --- | --- | --- |
| 产品负责人 | | | | 仅复核 / 不批准 / 另立决策 |
| 法务负责人 | | | | 仅复核 / 不批准 / 另立决策 |

## 9. 未来批准时必须填写（现在留空）

- 文案版本：__________
- 适用展示面：__________
- 批准原文（长/短/紧凑或组合）：__________
- 产品负责人：__________
- 法务负责人：__________
- 批准日期：__________

```text
D-03 STATUS: NOT APPROVED
```
