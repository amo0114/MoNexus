# Operations：D-02 CNY 积分面值回测

| 字段 | 值 |
| --- | --- |
| 文档 ID | OPS-VALUE-POLICY-D02-BT-001 |
| 版本 | 1.1.0 |
| 日期 | 2026-08-18 |
| 对应规格 | `docs/specs/value-policy-d02-backtest.md` |
| 生产政策模式 | 必须保持 `POINT_VALUE_POLICY_MODE=off` |

本 runbook 只描述如何准备脱敏输入、运行只读回测、保存报告并组织人工复核。它不能批准 D-02，也不能创建或激活 ValuePolicy。

## 1. 禁止事项

- 禁止把 CLI 指向生产数据库或任何名为 `monexus`、`monexus_dev`、`monexus_test` 的库。
- 禁止在输入中放入邮箱、姓名、电话、地址、交付内容、token 或真实自增 ID。
- 禁止把真实生产导出提交进 git。
- 禁止把报告中的参考价值写成现金价值、储备、负债或赎回承诺。
- 禁止因为某候选门禁较多 `pass` 就宣布 D-02 已批准。

## 2. 准备脱敏输入

1. 在隔离环境导出聚合所需字段，并立即假名化：
   - `offerRef` / `accountRef` / `orderRef` 使用 SHA-256 或等价假名，长度至少 16，禁止纯数字。
   - 金额转成非负十进制字符串。
   - 删除所有 PII 与 token 字段。
2. `merchantCostCnyAtomic` 没有真实成本时保持缺失，不要填 `0`。
3. 将 `schemaVersion` 设为 `1`，并给出闭区间 `period.from` / `period.to`。
4. 把文件放到仓库外或 `artifacts/value-policy-d02-backtest/`（该目录已被 gitignore）。
5. 只把合成 fixture 提交进仓库。当前合成样本：
   `server/src/modules/valuePolicyBacktest/__fixtures__/synthetic-small.json`

## 3. 验证输入 SHA-256

```bash
sha256sum /path/to/anonymized-input.json
```

运行后打开 `d02-backtest-report.json`，确认 `metadata.inputSha256` 与上一步一致。不一致则报告作废，重新导出。

## 4. 运行

在仓库根目录。`--input` 与 `--output` 使用绝对路径，或相对于 `npm --prefix server` 的进程工作目录（`server/`）：

```bash
npm --prefix server run value-policy:backtest -- \
  --input /absolute/path/to/anonymized-input.json \
  --candidates 50,100,200,500 \
  --reference-asset CNY \
  --output /absolute/path/to/artifacts/value-policy-d02-backtest/$(date -u +%Y%m%dT%H%M%SZ)
```

仓库内合成样本可用：

```bash
npm --prefix server run value-policy:backtest -- \
  --input src/modules/valuePolicyBacktest/__fixtures__/synthetic-small.json \
  --candidates 50,100,200,500 \
  --reference-asset CNY \
  --output /tmp/d02-backtest-out
```

常用选项：

| 选项 | 含义 |
| --- | --- |
| `--candidates 50,100,200,500` | 显式候选。省略时使用文档化分析集，仍不批准任何候选 |
| `--reference-asset CNY` | 仅接受 CNY |
| `--gates-config /path/to/gates.json` | 覆盖默认阈值；覆盖值会写入报告 |
| `--legacy-commission-bps 1000` | 显式传入 10.00% 时才计算 legacy FLOOR 佣金 |
| `--overwrite` | 只覆盖目标目录中的两份报告文件 |
| `--allow-unverifiable-source` | 仅当 git dirty 或无法取得 commit 时使用；报告标记 `sourceVerifiable=false` |

工具必须：

- 只读显式输入文件；
- 不修改输入；
- 不连接数据库；
- 不发起网络请求。

成功时 stdout 含 `D-02 STATUS: NOT APPROVED` 和 `inputSha256`。失败时只输出稳定错误码，不含原始输入行。

## 5. 保存报告

输出目录会写入：

- `d02-backtest-report.json`
- `d02-backtest-report.md`

公开报告字段只包括：

- `metadata.inputSha256`
- `metadata.gitCommit` 与 `metadata.gitTreeState`
- 候选列表与 gates 配置来源

下列内容是**受控归档记录**，不要写入公开 JSON/Markdown，以免泄露本机绝对路径或运行人身份：

- 输入文件绝对路径
- 输出目录绝对路径
- 运行人、主机名、工作目录和环境变量

把这些信息写在权限受限的归档清单里，与报告 SHA-256 一起保存。不要把含真实业务聚合的报告提交进默认分支。

默认要求干净 git 树。dirty 或无法取得 commit 时工具 fail closed。只有复核人明确接受不可验证来源时才使用 `--allow-unverifiable-source`。

## 6. 报告复核清单

- [ ] 精确文本 `D-02 STATUS: NOT APPROVED` 出现在 JSON（`d02StatusText`）与 Markdown
- [ ] `metadata.inputSha256` 与输入文件一致
- [ ] `metadata.gitCommit` / `gitTreeState` 与当时代码版本一致；`sourceVerifiable=true` 除非已批准 unverifiable 运行
- [ ] 阈值完整出现，覆盖值（如有）也被记录
- [ ] 没有 `accountRef` / `orderRef` / 邮箱 / 电话
- [ ] 小样本分组被抑制，且被抑制字段为 null 而不是精确单体数字
- [ ] 成本缺失时没有伪造 margin
- [ ] 没有 `Infinity` / `NaN`
- [ ] 奖励预算带有 `reference-value estimate, not accounting liability`
- [ ] 余额使用 `reference-value exposure`，没有写成现金负债
- [ ] JSON 与 Markdown 的 P50/P90、奖励参考价值和敞口数字一致
- [ ] 没有创建或激活 ValuePolicy
- [ ] 生产仍为 `POINT_VALUE_POLICY_MODE=off`

## 7. 会签栏

任何 D-02 批准都必须另立不可变决策记录。本报告本身不是批准。

| 角色 | 姓名 | 日期 | 签名 | 意见 |
| --- | --- | --- | --- | --- |
| 产品负责人 |  |  |  | 仅复核 / 不批准 / 另立决策 |
| 财务负责人 |  |  |  | 仅复核 / 不批准 / 另立决策 |
| 法务负责人 |  |  |  | 仅复核 / 不批准 / 另立决策 |
| 技术负责人 |  |  |  | 仅复核 / 不批准 / 另立决策 |

批准记录至少包含：选定 `N`、规范化分子分母、生效时间、披露文案、本回测报告 SHA-256、反对意见（如有）。未完成该记录前，禁止生产 `scheduled` 或 `active` CNY ValuePolicy。
