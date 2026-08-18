# D-02 CNY 积分面值决策包（OWNER DIRECTIVE APPROVED）

| 字段 | 值 |
| --- | --- |
| 文档 ID | OPS-VALUE-POLICY-D02-DECISION-001 |
| 版本 | 0.2.0 |
| 日期 | 2026-08-18 |
| 对应规格 | `docs/specs/value-policy-d02-backtest.md`、`docs/operations/value-policy-d02-backtest.md` |
| 状态 | `APPROVED — PRELAUNCH NO-REPRESENTATIVE-DATA EXCEPTION` |
| D-02 | `100 PTS = 1 CNY` |

本文件保留原始决策包与数据限制。2026-08-18 仓库所有者明确选择 `100 PTS = 1 CNY`，并批准无代表性数据的预上线例外。不可变记录引用、SHA-256、授权范围与身份限制见 `value-policy-decision-records.md`。本次批准不伪造四方独立签名，不授权 production enforce；production enforce 前仍必须用代表性真实数据形成替代记录。

## 1. 基线与可验证来源

| 项 | 值 |
| --- | --- |
| 仓库 | `amo0114/MoNexus` |
| 基线分支 | `origin/develop` |
| 基线 commit | `76476cf514221a8e9150a3818a8c24f33a5d49c4`（PR #147 squash merge） |
| 含 PR #146 | 是（`06498a5` 为基线祖先） |
| 含 PR #147 | 是（`76476cf` 即为基线 HEAD） |
| 工具 | `server/src/modules/valuePolicyBacktest/**` + `server/src/scripts/valuePolicyBacktest.ts` |
| 无数据库测试 | `npm --prefix server run test:value-policy-backtest`（10 文件 / 73 测试，隔离运行） |

每次真实运行前必须重新 `git fetch origin --prune`，以当时最新 `origin/develop` 为基线，并证明 `76476cf` 仍为其祖先。dirty 或无法取得 commit 时，回测工具 fail closed（除非复核人书面接受 `--allow-unverifiable-source`，报告标记 `sourceVerifiable=false`）。

## 2. 输入与隐私（运行时由受控归档清单填写，不进入公开报告）

| 项 | 要求 |
| --- | --- |
| `D02_INPUT_PATH` | 仓库外或 `artifacts/value-policy-d02-backtest/`（已 gitignore）的脱敏 JSON 绝对路径 |
| schemaVersion | `1` |
| 标识 | SHA-256 或等价假名，长度 16–128，`[A-Za-z0-9_-]`，禁止纯数字自增 ID |
| 金额 | 非负十进制字符串；JSON number 一律拒绝 |
| `merchantCostCnyAtomic` | 缺失保持缺失，不得填 `0` 猜测 |
| 文件大小 | ≤ 16 MiB |
| 禁止内容 | 邮箱、姓名、电话、地址、交付内容、token、数据库连接字符串、PII |
| 授权 | 必须有具名数据来源责任人与脱敏授权说明 |

公开报告只记录 `metadata.inputSha256`，不回显输入绝对路径、运行人、主机名或工作目录。输入 SHA-256 与报告记录不一致则报告作废。

### 2.1 DATA_INPUT_REQUIRED 清单

本轮 `D02_INPUT_PATH=NOT PROVIDED`。提供真实脱敏输入前，必须满足：

1. 数据来源责任人：__________（具名，含角色）
2. 脱敏授权说明：__________（覆盖 `offerRef`/`accountRef`/`orderRef` 假名化规则、PII 删除范围、授权范围）
3. 建议输入绝对路径：__________（仓库外或 `artifacts/value-policy-d02-backtest/`）
4. 数据期间 `period.from` / `period.to`：__________（真实 UTC 闭区间）
5. `offers` 行数 / `accounts` 行数 / `monthlyActivity` 行数 / `orders` 行数（确认未超 16 MiB 与各上限）
6. `merchantCostCnyAtomic` 覆盖率（有真实成本的 offer 占比）：__________
7. `LEGACY_COMMISSION_BPS`（仅在显式提供 legacy FLOOR 佣金时填写，不得猜测）：__________
8. `D02_GATES_CONFIG`（仅在显式覆盖默认阈值时提供，不得降低隐私 floor）：__________

真实输入仍未提供；该事实不因 owner directive 而改变。当前批准通过受控的预上线例外成立，必须在 production enforce 前补做真实数据回测。

## 3. 候选比例与规范化

候选集 `50,100,200,500` 只是文档化分析集，不是生产默认值，也不是推荐值。CNY `scale=2`，`HALF_EVEN`：

| N（PTS = 1 CNY） | 分子 | 分母 | 含义 |
| ---: | ---: | ---: | --- |
| 50 | 2 | 1 | 2 CNY atomic / point |
| 100 | 1 | 1 | 1 CNY atomic / point |
| 200 | 1 | 2 | 1/2 CNY atomic / point |
| 500 | 1 | 5 | 1/5 CNY atomic / point |

`100 PTS = 1 CNY` 已由 owner directive 批准为初始面值；它仍不是生产 seed，且合成 fixture 不是该决定的证据。

## 4. 门禁矩阵（每候选必填，禁止统计 pass 数选赢家）

每个候选输出 7 个门禁，状态只能是 `pass` / `warn` / `fail` / `insufficient_data`。门禁是数据信号，不是批准。

| 门禁 | 含义 | 阈值来源 |
| --- | --- | --- |
| `DATA_COVERAGE` | offer/account/活动行数与 distinct active account 是否达到 floor，活动覆盖率 | `DEFAULT_GATE_THRESHOLDS` 或显式 `--gates-config` |
| `PRICE_READABILITY` | offer P50 参考价值落点是否在可读区间 | 同上 |
| `REWARD_BUDGET` | 净可用奖励参考价值估算（`reference-value estimate, not accounting liability`） | 同上 |
| `USER_AFFORDABILITY` | 中位月 earned 能否购买 P50 offer | 同上 |
| `MERCHANT_UNIT_ECONOMICS` | 低于成本 offer 比例（仅有真实成本样本） | 同上 |
| `ROUNDING_STABILITY` | 舍入发生率与累计差额 | 同上 |
| `CONCENTRATION_RISK` | top 1% / 5% 余额集中度（`reference-value exposure`） | 同上 |

### 4.1 候选 N=____

| 门禁 | 状态 | reason | evidence 摘要 |
| --- | --- | --- | --- |
| DATA_COVERAGE | | | |
| PRICE_READABILITY | | | |
| REWARD_BUDGET | | | |
| USER_AFFORDABILITY | | | |
| MERCHANT_UNIT_ECONOMICS | | | |
| ROUNDING_STABILITY | | | |
| CONCENTRATION_RISK | | | |

（对 N=50/100/200/500 各复制一份本表。）

### 4.2 平行分析维度（每候选覆盖，不得只看 pass 数）

- 商品价格分布（P10/P25/P50/P75/P90，积分、CNY atomic、格式化 CNY）与舍入影响
- 用户 earned / spent / expired / refunded 与冻结净变化公式（`netAvailable = earned - spent - expired + refunded`，每分量单独 `HALF_EVEN` 后组合）
- 余额 `reference-value exposure`（不得称为现金负债）
- 商家成本覆盖率与不足数据（缺失不填 0，不伪造 margin）
- 相对 `100 PTS/CNY` 的敏感性对照（`periodEarnedReference*` 为整个回测期间 earned 参考价值，不是月均 reward）

## 5. 报告验证清单（运行时逐项确认）

- [ ] 输出只有 `d02-backtest-report.json` 与 `d02-backtest-report.md`
- [ ] JSON `schemaVersion=1`
- [ ] `d02StatusText` 精确等于 `D-02 STATUS: NOT APPROVED`
- [ ] `metadata.inputSha256` 等于输入 SHA-256
- [ ] `metadata.gitCommit` 等于本次干净 worktree HEAD
- [ ] `metadata.gitTreeState=clean`
- [ ] `metadata.sourceVerifiable=true`（除非已批准 unverifiable 运行）
- [ ] 候选与阈值来源完整写入报告
- [ ] JSON 与 Markdown 关键数字一致
- [ ] 被抑制的小样本字段是 `null + reason`，不是仅有 `suppressed=true`
- [ ] 总体活动、奖励 totals 与 sensitivity 满足 distinct active account floor
- [ ] 成本覆盖不足时不生成伪造 margin
- [ ] 不存在 `Infinity` / `NaN`
- [ ] 奖励预算标记 `reference-value estimate, not accounting liability`
- [ ] 余额标记 `reference-value exposure`
- [ ] 报告不含 `accountRef`/`orderRef`/邮箱/电话/输入绝对路径/运行人/主机名
- [ ] 运行前后 Git 树均干净
- [ ] 没有数据库访问或 ValuePolicy 写入

两份报告 SHA-256 写入受控归档清单（不进 Git）。

## 6. 已知限制与反对意见

| 项 | 说明 |
| --- | --- |
| 输入缺失 | 本轮无真实脱敏输入，仅完成合成 fixture 冒烟（`SYNTHETIC — NOT DECISION EVIDENCE`） |
| 合成样本 | 不得把合成结论推广到生产 |
| `insufficient_data` | 不得当成 `pass` |
| 财务结论 | 参考价值估算不是收入、负债或 breakage 会计结论 |
| period earned | 不得错写成 monthly reward |
| 历史订单 | 不得按当前政策重算，只能显示订单快照 |

## 7. 会签栏

原四方会签未完成，也未被伪造。当前批准的真实身份依据与限制记录在 `value-policy-decision-records.md`；后续四方复核可产生 superseding record。

| 角色 | 姓名 | 日期 | 签名 | 意见 |
| --- | --- | --- | --- | --- |
| 产品负责人 | | | | 仅复核 / 不批准 / 另立决策 |
| 财务负责人 | | | | 仅复核 / 不批准 / 另立决策 |
| 法务负责人 | | | | 仅复核 / 不批准 / 另立决策 |
| 技术负责人 | | | | 仅复核 / 不批准 / 另立决策 |

## 8. 已批准记录

- 选定 `N`：`100`
- 规范化分子 / 分母：`1 / 1`
- 决策 authority：`github:amo0114` owner directive；治理创建人仍不得等于审批人
- 批准日期：`2026-08-18T13:31:13Z`
- 生效不得早于：`2026-08-26T00:00:00Z`
- D-03 文案版本：`zh-CN-v1`
- 决策记录 SHA-256：`02a0d6642fec6cf542805d20970eb9d489dae8180775bc719349d1153867a998`
- 真实回测：无合格代表性数据，production enforce 前必须补齐 superseding record
- 反对意见：无；身份/四方独立会签限制已显式保留

```text
D-02 STATUS: APPROVED — PRELAUNCH NO-REPRESENTATIVE-DATA EXCEPTION
```
