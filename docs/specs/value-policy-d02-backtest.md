# Spec：D-02 CNY 积分面值回测工具

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-VALUE-POLICY-D02-BT-001 |
| 版本 | 1.1.0 |
| 日期 | 2026-08-18 |
| 状态 | Decision support only — D-02 remains NOT APPROVED |
| 上位规格 | `SPEC-VALUE-LEDGER-001`（`docs/specs/points-real-value-alignment.md`）、`SPEC-VALUE-POLICY-P1-001`（`docs/specs/points-value-policy-phase-1.md`） |
| 首个生产本位币 | `CNY`（D-01 已批准） |
| 生产积分面值 | 未批准（D-02 不得由本工具批准） |

> 本文定义只读、确定性、可复现的 D-02 回测契约。工具只生成决策支持材料，不得创建、审批、scheduled 或 active 任何 `ValuePolicy`。

## 1. 目标

1. 在脱敏输入上，对候选面值 `N PTS = 1 CNY` 做可重复的聚合回测。
2. 用与 Phase 1 相同的 BigInt + `HALF_EVEN` 契约换算参考价值。
3. 输出 JSON 报告与 Markdown 摘要，记录输入 SHA-256、代码 commit、git tree 状态、执行时间、候选参数、阈值和 `schemaVersion`。
   **确定性**指：相同输入、参数和可验证代码版本生成相同**业务内容**。业务内容排除 `executedAt` 等运行元数据。
4. 为产品、财务、法务提供决策门禁状态，但不选择“最佳候选”。

## 2. 非目标

- 不连接任何数据库，尤其不得读取 `monexus`、`monexus_dev`、`monexus_test` 或生产库。
- 不创建、修改、审批或激活 `ValuePolicy`。
- 不读取邮箱、姓名、电话、地址、订单交付内容或 token。
- 不发起网络请求。
- 不把参考价值称为现金价值、储备、负债或赎回承诺。
- 不生成收入、breakage 或负债会计结论。
- 不批准 D-02，不把 `100 PTS = 1 CNY` 写成生产默认值。

## 3. 与既有规格的关系

| 规格 | 关系 |
| --- | --- |
| `SPEC-VALUE-LEDGER-001` | 提供 D-01/D-02 决策框架、CNY scale=2、整数原子金额和“参考价值不是赎回承诺”的语言。 |
| `SPEC-VALUE-POLICY-P1-001` | 提供 `referenceAtomicPerPointNumerator/Denominator` 与 `HALF_EVEN` 纯函数契约。本工具复用 `server/src/modules/valuePolicy/money.ts`，不复制另一套浮点公式。 |
| 本规格 | 只增加离线回测输入/输出与门禁。Phase 1 运行时模式必须保持 `POINT_VALUE_POLICY_MODE=off`，直到另立不可变决策记录批准 D-02。 |

`100 PTS = 1 CNY` 只是文档化分析候选之一，规范化后为 `1/1` CNY atomic per point。它不是默认生产承诺。

## 4. 候选换算

对候选 `N PTS = 1 CNY`，CNY `scale = 2`：

```text
referenceAtomicPerPointNumerator   = 100 / gcd(100, N)
referenceAtomicPerPointDenominator = N   / gcd(100, N)
roundingMode                       = HALF_EVEN
```

| N | 分子 | 分母 | 含义 |
| ---: | ---: | ---: | --- |
| 50 | 2 | 1 | 2 CNY atomic / point |
| 100 | 1 | 1 | 1 CNY atomic / point |
| 200 | 1 | 2 | 1/2 CNY atomic / point |
| 500 | 1 | 5 | 1/5 CNY atomic / point |

换算调用现有 `convertPointsToReferenceAtomic`。金额中间过程只允许 `bigint`。

输出每个候选必须包含：

- `pointsPerCnyMajor`
- `numerator`
- `denominator`
- `roundingMode=HALF_EVEN`

未传 `--candidates` 时使用文档化分析集 `50,100,200,500`，并在报告中标记 `candidatesSource=documented_default_analysis_set`。这不构成批准。

## 5. 输入 schema（version 1）

```json
{
  "schemaVersion": 1,
  "period": {
    "from": "2026-01-01T00:00:00.000Z",
    "to": "2026-06-30T23:59:59.999Z"
  },
  "offers": [
    {
      "offerRef": "64-hex-pseudonymous-id",
      "category": "subscription",
      "pricePoints": "1200",
      "merchantCostCnyAtomic": "500"
    }
  ],
  "accounts": [
    {
      "accountRef": "64-hex-pseudonymous-id",
      "balancePoints": "5000",
      "frozenPoints": "300"
    }
  ],
  "monthlyActivity": [
    {
      "month": "2026-01",
      "accountRef": "64-hex-pseudonymous-id",
      "earnedPoints": "800",
      "spentPoints": "500",
      "expiredPoints": "0",
      "refundedPoints": "0"
    }
  ],
  "orders": [
    {
      "orderRef": "64-hex-pseudonymous-id",
      "offerRef": "64-hex-pseudonymous-id",
      "points": "1200",
      "status": "completed"
    }
  ]
}
```

规则：

- 积分和 CNY 原子金额必须是非负十进制字符串；JSON number 一律拒绝。
- 标识必须是假名化引用（长度 16–128，`[A-Za-z0-9_-]`，禁止纯数字自增 ID）。
- `merchantCostCnyAtomic` 允许缺失；缺失不得当成 0。
- 未知 `schemaVersion`、重复引用、订单引用不存在的 offer、活动引用不存在的 account、非法时间范围：稳定错误码 fail closed。
- 时间戳必须是真实 UTC 日历瞬间。`2026-02-31T00:00:00.000Z` 这类不存在的日期必须拒绝，不得被 JavaScript `Date` 规范化后接受。
- 上限：文件 16 MiB；offers/accounts 各 50,000 行；monthlyActivity/orders 各 200,000 行。
- 输入必须通过同一文件描述符读取；最终实际读取字节不得超过 16 MiB。文件在读取过程中增长超过上限时 fail closed。

## 6. 指标定义

所有分位数使用 nearest-rank，不插值。空分母或空样本输出 `null` + `reason`，禁止 `Infinity`/`NaN`。

1. **商品价格分布**：offer 价格 P10/P25/P50/P75/P90（积分、CNY atomic、格式化 CNY）、最低/最高/中位、舍入发生率和累计舍入差额。按 `category` 分组；样本低于阈值则抑制。
2. **用户获得与消费**：先按用户对活动行求月均，再取 earned/spent/net 的 P10/P50/P90 及对应参考价值；月度 earn/spend ratio；零消费用户比例；活跃消费用户比例；覆盖率与缺失率。
3. **余额分布**：available=`balancePoints`，frozen=`frozenPoints`，total=二者之和。输出 P10/P50/P90 与参考价值。高余额集中度使用 top 1%/5% 占比，命名为 **reference-value exposure**，不得称为现金负债。
4. **商品可负担性**：中位用户月 earned 可购买多少个 P50 offer；P10/P50/P90 offer 需要多少个月中位 earned；余额不足以覆盖 P50 offer 的账户比例。
5. **奖励预算**（冻结公式）：

```text
netAvailablePoints = earned - spent - expired + refunded
netAvailableReferenceAtomic =
  HALF_EVEN(earned) - HALF_EVEN(spent) - HALF_EVEN(expired) + HALF_EVEN(refunded)
```

每个非负分量单独走共享 `HALF_EVEN` 契约，再组合。净变化可以为负。门禁使用 `netAvailable*`，不得再使用含糊的 `unspent`。固定标记为 `reference-value estimate, not accounting liability`。
6. **商家单位经济**：仅当 `merchantCostCnyAtomic` 覆盖率 **且** 有成本 offer 数同时达到阈值时输出。差额 = 商品参考价值 − 成本。低于成本比例只在有真实成本的样本上计算。legacy commission 仅在显式传入 `--legacy-commission-bps` 时，按生产惯例对积分 `FLOOR` 后再 `HALF_EVEN` 换成参考价值。
7. **敏感性比较**：候选横向矩阵。`periodEarnedReference*` 是**整个回测期间** earned 参考价值，不是月均，不得标注为 Monthly reward。相对 `100 PTS = 1 CNY` 的倍率 `100/N` 只是分析对照。被抑制的分区必须在矩阵中为 `null`，不得重新暴露。

## 7. 门禁

每个候选输出以下门禁，状态只能是 `pass` / `warn` / `fail` / `insufficient_data`：

- `DATA_COVERAGE`
- `PRICE_READABILITY`
- `REWARD_BUDGET`
- `USER_AFFORDABILITY`
- `MERCHANT_UNIT_ECONOMICS`
- `ROUNDING_STABILITY`
- `CONCENTRATION_RISK`

默认阈值集中定义于 `DEFAULT_GATE_THRESHOLDS`，完整写入每份报告，并可用 `--gates-config` 覆盖。覆盖值也必须写入报告。门禁只是数据信号，不是批准。

`--gates-config` 可以提高隐私样本阈值，但**不得降低**下列 floor。试图降低、传入负数、越界 rate 或矛盾的 warn/fail 对：稳定失败 `INVALID_GATES_CONFIG`。

报告固定结论：

- D-02 remains NOT APPROVED
- this report is decision support only
- finance/product/legal approval is still required
- no production ValuePolicy was created or activated
- CNY reference value is not a cash redemption promise

## 8. 隐私与小样本

- 只提交合成 fixture。
- 报告只输出聚合结果，禁止单用户或单商家明细。
- 不可降低的隐私 floor：
  - offers / accounts / monthlyActivity 行数 / category / 有成本 offer ≥ 10
  - 总体用户活动、奖励 totals 与 sensitivity 的期间 earned 还要求 **distinct active `accountRef` ≥ `minSampleAccounts`**。仅有 10 行但全部属于同一账户时必须抑制。
  - top 1% 集中度 ≥ 100
  - top 5% 集中度 ≥ 20
- 样本不足时，`suppressed=true` 且对应数字字段必须为 `null` + `reason`。禁止只打 boolean 后继续输出 P10/P50/P90、总 exposure、concentration `totalSum`、逐月 earned/spent 或商家差额。
- 总体 activity 足够但单月样本不足时，该月仍须抑制。
- CLI 日志不得输出单个 `accountRef`/`orderRef`。
- 错误不得回显整行原始输入。
- 已存在报告文件时默认拒绝覆盖；`--overwrite` 只替换 `d02-backtest-report.json` 与 `d02-backtest-report.md`。
- 两份报告先写入唯一临时文件，再发布。任一步失败必须回滚到发布前状态，不得留下半套、新旧混合或临时文件。overwrite 失败时保留原有两份报告。

## 9. 报告格式

输出目录写入：

- `d02-backtest-report.json`
- `d02-backtest-report.md`

JSON `schemaVersion` 为报告 schema 1。两份报告必须包含精确文本 `D-02 STATUS: NOT APPROVED`。JSON 使用：

```json
{
  "d02Status": "NOT APPROVED",
  "d02StatusText": "D-02 STATUS: NOT APPROVED"
}
```

JSON 与 Markdown 的关键数字必须一致。

代码身份：

- `metadata.gitCommit`：完整 commit hash
- `metadata.gitTreeState`：`clean` | `dirty` | `unavailable`
- `metadata.sourceVerifiable`：仅 `clean` 为 true

默认 fail closed：dirty 或无法取得 commit 时拒绝生成决策报告。只有显式 `--allow-unverifiable-source` 才可继续，且报告必须显著标记 `sourceVerifiable=false`。每次执行只解析一次 `GitIdentity`，校验与报告必须使用同一冻结值；不得在两次读取之间把 dirty 树写成未授权的 `sourceVerifiable=false` 报告。

运行人、机器环境和输入绝对路径**不是**公开报告字段。它们只属于受控归档记录，由运维在报告目录外单独保存。

## 10. 法律与会计边界

本工具和本规格：

- 不构成会计意见、法律意见或赎回承诺；
- 不把 CNY 参考价值解释为现金、储备或平台负债；
- 不能自动批准 D-02。任何批准必须另立不可变决策记录，并由产品、财务、法务会签。
