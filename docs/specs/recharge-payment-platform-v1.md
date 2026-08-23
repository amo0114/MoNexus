# SPEC-RECHARGE-PAYMENT-V1.2: 多渠道积分充值平台

状态：Ready for implementation

日期：2026-08-19

适用仓库：MoNexus

目标基线：实施时最新 `origin/develop`

版本：v1.2

修订记录：

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v1.0 | 2026-08-19 | 首版实施规格 |
| v1.1 | 2026-08-19 | 冻结部署环境判定、支付完成、并发限额、完整数据库合同和多 Agent 所有权 |
| v1.2 | 2026-08-19 | 统一支付观察入口，冻结 provider action、取消/过期竞态及剩余数据库与恢复合同 |

## 1. 摘要

MoNexus 将建设一套渠道无关、支持多币种、可审计且可恢复的积分充值平台。用户可以选择推荐金额或输入自定义金额，通过受支持的支付渠道购买 RP 积分。

本期先完整实现充值订单、定价、支付编排、回调幂等、积分入账、退款、争议、对账、用户界面、管理界面、指标、告警和运维工具。没有真实商户凭据时，系统可以在 local、CI 和 staging 使用 Simulator，并可以对 Stripe test mode、PayPal sandbox 及渠道协议 fixture 做验证；生产环境默认关闭充值，且永远禁止 Simulator。

支付渠道只是适配器：

```text
Recharge Domain
    -> Payment Orchestrator
        -> Simulator (local/CI/staging only)
        -> Stripe
        -> PayPal
        -> WeChat Pay API v3
        -> Alipay Open Platform
        -> future providers
```

## 2. 已冻结的产品决策

### 2.1 充值含义

充值是用户向平台支付法币并获得 RP 的交易。它不是积分提现、现金赎回、储备证明或用户间转账。

充值成功链路：

```text
用户输入金额
-> 服务端报价并冻结汇率版本
-> 创建充值订单和渠道支付
-> 渠道确认收款
-> 唯一业务事件执行一次积分入账
-> 用户余额与充值记录更新
```

浏览器跳转页、二维码页面或前端 SDK 的成功回调都不是到账依据。只有已验签的异步事件，或服务端主动查询渠道得到的终态，才能驱动支付成功。

### 2.2 自定义金额与推荐金额

用户界面同时提供：

- 推荐金额按钮，仅作为输入快捷方式；
- 自定义金额输入框；
- 服务端返回的最低、最高和步进金额；
- 输入金额对应的准确 RP 数量。

初始业务最低限额：

| 币种 | 最低金额 | 原子金额 |
| --- | ---: | ---: |
| CNY | `¥1.00` | `100` 分 |
| USD | `$1.00` | `100` cent |

不得接受 `¥0.01`、`¥0.10`、`$0.01` 或 `$0.10`。客户端校验只改善体验，服务端和数据库约束才是权威。

实际最低金额为：

```text
effectiveMinimum = max(platformMinimum, provider/account/methodMinimum)
effectiveMaximum = min(platformMaximum, provider/account/methodMaximum)
```

渠道未声明最高额时，`provider/account/methodMaximum` 视为平台最高额。最终报价必须绑定 provider、payment method 和服务端选择的 provider account；同一金额对不同支付组合可能得到不同的有效范围。

渠道或商户账户限制高于平台最低值时，API 必须返回更高的有效最低值，不能先收单再依赖渠道报错。例如 Stripe 的最低收款额受结算币种和支付方式影响，不能把某个全局数值硬编码为所有 Stripe 账户的能力。

每个启用币种还必须配置：

- `minAmountMinor`；
- `maxAmountMinor`；
- `amountStepMinor`；
- 单日和单月用户限额；
- 推荐金额数组；
- 生效的积分定价政策。

V1 初始安全上限：

| 币种 | 单笔上限 | 单日上限 | 单月上限 |
| --- | ---: | ---: | ---: |
| CNY | `¥1,000.00` | `¥2,000.00` | `¥10,000.00` |
| USD | `$500.00` | `$1,000.00` | `$5,000.00` |

这些上限是版本化运营配置，可以降低。提高超过上述值需要修改部署级 hard cap 并重新部署，不需要人工签署文件。

### 2.3 积分定价

CNY 的初始充值定价使用已批准政策：

```text
100 PTS = 1 CNY
1 CNY minor unit (¥0.01) = 1 PTS
```

因此：

```text
¥1.00 -> 100 PTS
¥10.00 -> 1,000 PTS
¥50.00 -> 5,000 PTS
```

USD、EUR 等币种不能直接套用 CNY ValuePolicy，也不得在支付创建时调用实时外汇接口。每个币种必须有独立、版本化的 `RechargePricePolicy`。未配置正式定价政策的币种保持 disabled；测试环境可以使用显式标记为 fixture 的测试政策。

定价采用有理数：

```text
points = HALF_EVEN(amountMinor * pointsNumerator / pointsDenominator)
```

计算必须复用或兼容 `server/src/modules/valuePolicy/money.ts` 的 `BigInt + HALF_EVEN` 语义。不得使用 JavaScript `number` 或浮点金额计算。

报价和订单必须冻结：

- 法币币种及原子金额；
- 基础积分、赠送积分和总积分；
- 定价政策 ID、版本、分子、分母和舍入模式；
- 推荐金额或自定义金额来源；
- 用户看到的披露文案版本。

以后修改政策不能重算历史充值订单。

V1 的 `bonusPoints` 固定为 `0`，但模型保留该字段。未来增加赠送活动时必须单独版本化，不能修改已创建订单。

## 3. 范围

### 3.1 V1 必须实现

- 多币种金额模型与版本化充值定价；
- 推荐金额和自定义金额报价；
- 充值订单、支付意图、支付尝试和支付事件；
- Provider 能力发现和统一适配器接口；
- Simulator、Stripe、PayPal、微信支付和支付宝适配器边界；
- 已验签回调的持久化、去重和异步处理；
- 主动支付查询和超时恢复；
- 一次且仅一次的积分入账凭证；
- 退款前积分冻结、退款成功冲正和退款失败释放；
- 支付争议/拒付记录与账户风险限制；
- 用户充值页、充值记录和详情；
- 管理端订单、事件、退款、争议和对账；
- 定向并发测试、故障恢复测试、指标、告警和 runbook；
- 生产环境 `disabled` 部署能力。

### 3.2 V1 不实现

- 保存银行卡号、CVV 或自行托管银行卡表单；
- 自动外汇交易或实时汇率定价；
- 积分提现、现金赎回、P2P 转账；
- 订阅、自动续费或离线扣款；
- 商户分账；
- 将充值订单混入当前积分消费 `Order`；
- 将渠道资金对账混入当前商家 `Settlement`；
- 在生产使用模拟支付；
- 在没有商户资质或真实凭据时声称渠道已生产可用。

## 4. 现有系统边界

现有 `PointAccount` 是用户积分余额投影，`PointLog` 是展示和历史兼容流水。现有 `Order` 是积分消费订单，`Settlement` 是商家积分结算；三者都不是支付账。

必须遵守：

- 不向现有 `Order` 增加现金支付状态；
- 不复用 `Settlement` 表示支付渠道结算；
- 不直接从 controller 调用 `creditAvailablePoints`；
- 充值入账必须经唯一 `RechargeCredit` 业务凭证；
- 成功事务可以同时更新 `PointAccount` 和写兼容 `PointLog(type='in')`；
- 现有 `IdempotencyRecord` 绑定商品与订单，不用于充值或支付回调。

## 5. 领域模型

实现可以调整字段命名，但不得削弱唯一约束、金额快照或审计语义。

### 5.1 `RechargePricePolicy`

```text
id UUID
code String unique
version Int
currency Char(3)
currencyScale Int
pointsNumerator BigInt
pointsDenominator BigInt
roundingMode HALF_EVEN
minAmountMinor BigInt
maxAmountMinor BigInt
amountStepMinor BigInt
dailyLimitMinor BigInt
monthlyLimitMinor BigInt
limitTimeZone String
bonusRuleVersion nullable
status draft|active|retired
effectiveAt
createdAt
```

`code` 是可读稳定标识，例如 `rp-cny-recharge-v1`；API 和关系使用 UUID `id`。数据库设置 `@@unique([currency, version])`，版本号只在币种内递增。`limitTimeZone` 使用 IANA 时区；初始 CNY 与 USD 政策均为 `Asia/Shanghai`。

推荐金额使用规范化子表 `RechargeSuggestedAmount(policyId, amountMinor, sortOrder)`，并对 `(policyId, amountMinor)` 设置唯一约束，不使用 PostgreSQL 数组。

数据库 CHECK 负责：所有金额非负、分母大于零、`minAmountMinor <= maxAmountMinor`、限额顺序合理。业务 floor、部署级 hard cap、推荐金额范围和步进依赖配置或父行，必须在同一服务事务内验证；部署级 hard cap 是应用配置，不能伪装成数据库 CHECK。

同一币种最多一条 active 政策。激活和退役通过事务及数据库约束串行化。本 Spec 不要求双人签署流程。

### 5.2 `RechargeQuote`

```text
id UUID
userId
pricePolicyId
provider
paymentMethod
providerAccountKey
capabilityVersion
capabilityDigest
currency
amountMinor BigInt
effectiveMinAmountMinor BigInt
effectiveMaxAmountMinor BigInt
basePoints BigInt
bonusPoints BigInt
totalPoints BigInt
amountSource suggested|custom
expiresAt
consumedAt nullable
createdAt
```

报价默认 10 分钟过期。provider account 由服务端根据 provider、environment、currency 和 payment method 选择，不接受客户端指定。报价必须冻结该账户的内部 key、能力版本或摘要以及有效最低/最高值。创建订单时必须确认报价属于当前用户、未过期、未消费，并重新求值 account/capability/min/max；任一变化返回 `RECHARGE_QUOTE_CHANGED`。报价不预留或消耗日/月额度。相同幂等请求可重放同一结果。

### 5.3 `RechargeOrder`

```text
id UUID public identifier
userId
quoteId unique
pricePolicyId
currency
amountMinor BigInt
basePoints BigInt
bonusPoints BigInt
totalPoints BigInt
pricing snapshot fields
provider/paymentMethod/providerAccountKey snapshot
capabilityVersion/capabilityDigest snapshot
effectiveMin/effectiveMax snapshot
disclosureVersion
status
expiresAt
paidAt nullable
creditedAt nullable
cancelledAt nullable
createdAt updatedAt
```

状态：

```text
created -> pending_payment -> paid -> credited
created(no attempt) -> expired|cancelled
pending_payment -> closure_pending -> expired|cancelled|reconcile_required
pending_payment -> failed
closure_pending -> paid
paid|credited -> refund_pending -> refunded
任意支付异常 -> reconcile_required
```

状态流转必须使用条件更新/CAS，禁止无条件覆盖终态。`closure_pending` 表示已有非终态 provider attempt，系统正在 close/query，尚未释放限额。V1 只允许全额退款，因此 RechargeOrder 不进入 `partially_refunded`；渠道返回意外的部分退款时进入 `reconcile_required`。

### 5.4 `PaymentIntent`

平台级支付编排对象，不等同于 Stripe PaymentIntent：

```text
id UUID
rechargeOrderId unique
amountMinor BigInt
currency
status requires_method|processing|succeeded|failed|cancelled|reconcile_required
activeAttemptId nullable
expiresAt
createdAt updatedAt
```

### 5.5 `PaymentAttempt`

```text
id UUID
paymentIntentId
provider
providerAccountKey
method
status created|requires_action|processing|succeeded|failed|cancelled|unknown
providerPaymentId nullable
providerOrderId nullable
providerCaptureId nullable
requestIdempotencyKey
actionType none|redirect|qr_code|client_secret|form_post
actionPayload encrypted-or-expiring nullable
lastErrorCode nullable
lastErrorSafeMessage nullable
createdAt updatedAt completedAt
```

唯一约束至少包括：

- `(provider, providerAccountKey, providerPaymentId)`，允许 provider ID 为空；
- `(provider, providerAccountKey, requestIdempotencyKey)`；
- 每个 PaymentIntent 最多一个非终态 active attempt。

切换渠道前必须确定旧 attempt 已关闭或明确失败。状态未知时禁止自动创建另一个可能扣款的 attempt。

V1 action union 冻结如下：

- `redirect`：只包含 HTTPS approval/checkout URL 和过期时间；PayPal V1 使用此 action；
- `qr_code`：只包含二维码内容、显示类型和过期时间；
- `client_secret`：只包含明确允许暴露给订单所属用户的短期 provider token；
- `form_post`：结构化 `{ actionUrl, method: "POST", fields: Record<string,string> }`，用于支付宝等表单跳转；禁止返回完整 HTML 字符串，`actionUrl` 必须匹配 provider allowlist，字段数量、名称和总大小必须有界；
- `none`：无前端动作。

V1 不使用 `provider_sdk`，也不接入 PayPal JavaScript SDK/browser client token。未来若采用 SDK v6，必须单独增加 browser-safe token API、短期有效期、禁止持久化/日志记录和 CSP 合同，不能在 UI PR 中自行引入。

### 5.6 `PaymentObservation`（数据库模型 `PaymentEvent`）

`PaymentEvent` 是历史兼容表名，语义上是所有外部支付事实的统一持久化 observation，不仅代表 webhook。任何 webhook、provider query、provider complete/capture 或 reconciliation 成功信号都必须先写入该表，再调用唯一的 `applyConfirmedPayment(observationId)`；任何调用方不得直接把 attempt/intent/order 标记为 succeeded/paid。

```text
id UUID
provider
providerAccountKey
source webhook|provider_query|provider_complete|reconciliation
verificationMethod webhook_signature|authenticated_provider_api
paymentAttemptId nullable
providerPaymentId nullable
providerCaptureId nullable
providerEventId nullable
dedupeKey
eventType
payloadSha256
rawPayloadEncrypted nullable
normalizedPayload Json
signatureVerified Boolean nullable
status received|processing|processed|ignored|failed|reconcile_required
attempts
nextAttemptAt
leaseToken nullable
leaseUntil nullable
observedAt
createdAt
processedAt nullable
lastErrorCode nullable
```

唯一约束：`(provider, providerAccountKey, dedupeKey)`。Webhook 有稳定事件 ID 时使用 `dedupeKey=webhook:{providerEventId}`；没有稳定 event ID 时由 adapter 使用渠道交易 ID、事件类型和不可变状态版本生成确定性 SHA-256。query/complete/reconciliation 使用 `source + providerPaymentId/providerCaptureId + 规范化终态 + 金额 + 币种 + 渠道不可变状态版本` 的确定性 SHA-256；同一外部支付事实跨 source 可以形成多条 observation，但只能汇聚到同一个 `applyConfirmedPayment` 幂等核心。没有足够稳定字段或无法验证 authenticated provider response 时只能进入 `reconcile_required`，不得驱动入账。不得使用接收时间生成 dedupe key。

原始 payload 如保存，必须使用独立 `PAYMENT_EVENT_ENCRYPTION_KEY` 加密并设置保留任务；默认 30 天后清理，存在 open dispute、open refund 或 open reconciliation 时延长至结案后 180 天。永久保留 SHA-256、签名验证元数据、规范化必要字段、加密归档引用和处理结果。不得将完整 payload 或付款人 PII 写入日志。

### 5.7 `RechargeCredit`

充值积分入账的不可变业务凭证：

```text
id UUID
rechargeOrderId unique
paymentIntentId unique
userId
points BigInt
balanceBefore Int
balanceAfter Int
businessEventKey unique
pointLogId unique
createdAt
reversedAt nullable
```

`businessEventKey` 固定为稳定格式，例如 `recharge:{orderId}:credit:v1`。任何回调重放、主动查询、worker 重试或进程崩溃恢复都只能得到同一凭证。

V1 冻结为保留现有 `PointAccount.balance`、`frozenBalance`、`PointLog.amount` 和 `balanceAfter` 的 `Int` 类型，避免把充值项目扩展为全仓积分类型重构。新增支付金额、定价快照和 `RechargeCredit.points` 使用 `BigInt`；实际入账前必须证明积分值可安全转换为整数，并在同一事务内执行以下硬限制：

```text
0 <= balance
0 <= frozenBalance
balance + frozenBalance <= 2_000_000_000 PTS
```

报价时可以提前拒绝明显超限，但入账事务必须基于最新余额重新判断。超过硬限制进入 `reconcile_required`，不得截断、环绕或部分入账。未来如需超过该上限，应通过独立 Spec 将全部积分字段和调用方统一迁移为 BigInt。

该限制通过数据库 CHECK 保护整个 `PointAccount`，不是只保护充值路径。数据库 CHECK 落地前，PR-A0 必须先枚举并加固签到、订单、checkout、推广、退款和管理员调整等全部 `PointAccount` mutation，使其使用 checked helper/条件更新并把边界拒绝映射为业务错误。migration 前必须扫描现有数据；发现超限历史数据时 migration fail closed 并输出只读诊断，不自动截断或修改余额。

### 5.8 `RechargeRefund`、`PointHold` 与 `RechargeReversal`

```text
RechargeRefund:
id UUID
rechargeOrderId unique
paymentAttemptId
providerRefundId nullable
requestIdempotencyKey
amountMinor BigInt
pointsToReverse BigInt
status requested|points_held|processing|succeeded|failed|cancelled|manual_review
reasonCode
createdByUserId
createdAt updatedAt completedAt

PointHold:
id UUID
userId
sourceType recharge_refund|payment_dispute
sourceId
points BigInt
status active|consumed|released
createdAt updatedAt

RechargeReversal:
id UUID
rechargeRefundId unique
rechargeCreditId unique
userId
points BigInt
balanceBefore Int
balanceAfter Int
businessEventKey unique
pointLogId unique
createdAt
```

`PointHold` 必须设置 `@@unique([sourceType, sourceId])`，退款与 dispute 共用同一 hold 状态机但使用不同 sourceType。

`RechargeRefund` 还必须设置 `@@unique([rechargeOrderId, requestIdempotencyKey])`；V1 的 `rechargeOrderId unique` 保证每个订单最多一个退款聚合，失败重试更新同一退款记录，而不是创建第二笔退款。

已入账订单退款顺序：

```text
条件扣减可用余额并增加 frozenBalance
-> 创建 PointHold
-> 调用渠道退款
-> 渠道确认退款成功：CAS 消耗 hold，创建唯一 RechargeReversal，写冲正流水
-> 渠道确认失败：释放 hold 回可用余额
```

`RechargeReversal.businessEventKey` 固定为 `recharge:{orderId}:refund:v1`。退款通知、退款查询、worker 重试和管理员 reconcile 竞争时，唯一凭证和 hold CAS 必须保证只冲正一次。

对 `paid` 但尚未 `credited` 的订单，退款事务先锁定订单并 CAS 到 `refund_pending`，禁止之后创建 RechargeCredit；这种路径不创建 PointHold。对 `credited` 订单必须先创建 PointHold。credit 与 refund 竞争时使用同一订单锁定顺序，最终只能形成“credited + points held”或“未 credited + refund pending”之一。

余额不足时进入 `manual_review`，不得先向渠道退款再尝试扣积分。V1 默认只允许全额退款；部分退款能力保留在 provider capabilities 中，但 API 未显式启用时返回 409。

### 5.9 `PaymentDispute`、恢复案件与账户限制

```text
PaymentDispute:
id UUID
provider
providerAccountKey
providerDisputeId
rechargeOrderId
paymentAttemptId nullable
amountMinor BigInt
currency Char(3)
status open|won|lost|closed
reasonCode nullable
evidenceDueAt nullable
openedAt
closedAt nullable
createdAt updatedAt
```

`PaymentDispute` 设置 `@@unique([provider, providerAccountKey, providerDisputeId])`，并索引 `(status, evidenceDueAt)` 和 `rechargeOrderId`。

每个 dispute 创建一个恢复案件和账户限制，数据库合同冻结如下：

```text
PaymentRecoveryCase:
id UUID
paymentDisputeId unique
rechargeCreditId
userId
pointsToRecover BigInt
pointsHeld BigInt
outstandingPoints BigInt
lossAmountMinor BigInt
currency Char(3)
status open|held|recovered|written_off|restored
resolutionReason nullable
resolvedByUserId nullable
resolvedAt nullable
createdAt updatedAt

AccountRestriction:
id UUID
userId
sourceType payment_dispute
sourceId
blocksPointSpending Boolean
blocksRecharge Boolean
status active|released
releasedByUserId nullable
releasedAt nullable
createdAt updatedAt
```

`AccountRestriction` 设置 `@@unique([sourceType, sourceId])` 与 `@@index([userId, status])`。争议打开时事务锁定账户，冻结 `min(availableBalance, pointsToRecover)`，创建 `sourceType=payment_dispute` 的 PointHold，并创建 active AccountRestriction；限制必须在所有现有积分消费/checkout value-bearing 路径和充值订单创建路径执行，不能只在新充值 controller 检查。限制不影响登录、查看记录、申诉或合法退款。

争议胜诉时释放 hold 并解除限制。争议败诉时消耗已冻结积分；不足部分保留为 `outstandingPoints`，必须由管理员以 `recovered|written_off|restored` 之一显式结案并写审计，不能通过制造负余额隐式处理。限制是否解除由结案结果决定。

### 5.10 `ReconciliationRun` 与 `ReconciliationItem`

```text
ReconciliationRun:
id UUID
provider
providerAccountKey
environment sandbox|live
scopeType statement|provider_query|manual
scopeKey
periodStart nullable
periodEnd nullable
status pending|running|completed|completed_with_mismatches|failed
sourceSha256 nullable
itemCount Int
mismatchCount Int
startedAt nullable
completedAt nullable
createdByUserId nullable
lastErrorCode nullable
createdAt updatedAt

ReconciliationItem:
id UUID
reconciliationRunId
providerEntryKey
rechargeOrderId nullable
paymentAttemptId nullable
paymentEventId nullable
mismatchType provider_paid_local_unpaid|local_paid_provider_not_paid|paid_not_credited|refund_mismatch|amount_mismatch|currency_mismatch|duplicate_provider_payment|unknown_provider_transaction
providerStatus nullable
localStatus nullable
providerAmountMinor BigInt nullable
localAmountMinor BigInt nullable
currency Char(3) nullable
status open|resolved|ignored
resolutionReason nullable
resolvedByUserId nullable
resolvedAt nullable
createdAt updatedAt
```

`ReconciliationRun` 设置 `@@unique([provider, providerAccountKey, environment, scopeType, scopeKey])`；`ReconciliationItem` 设置 `@@unique([reconciliationRunId, providerEntryKey, mismatchType])`，并索引 `(status, mismatchType)` 和 `rechargeOrderId`。它们保存渠道账单或查询批次、统计值和以下差异：

- provider paid / local unpaid；
- local paid / provider not paid；
- paid but not credited；
- refund mismatch；
- amount/currency mismatch；
- duplicate provider payment；
- unknown provider transaction。

### 5.11 `RechargeLimitBucket` 与 `RechargeLimitReservation`

```text
RechargeLimitBucket:
id UUID
userId
currency Char(3)
periodType day|month
periodStart DateTime
periodEnd DateTime
reservedMinor BigInt
consumedMinor BigInt
createdAt updatedAt

RechargeLimitReservation:
id UUID
rechargeOrderId
bucketId
periodType day|month
amountMinor BigInt
status reserved|consumed|released
expiresAt
createdAt updatedAt
```

Bucket 设置 `@@unique([userId, currency, periodType, periodStart])`；reservation 设置 `@@unique([rechargeOrderId, periodType])`。`periodStart/periodEnd` 根据订单所用 `RechargePricePolicy.limitTimeZone` 计算自然日/月边界，再以 UTC 时间戳保存。订单创建事务按 `(periodType, periodStart)` 的固定顺序锁定 day/month bucket，并原子检查 `reservedMinor + consumedMinor + requestedMinor <= configuredLimitMinor` 后同时占额。订单 `paid` 转为 consumed；退款和 dispute 均不恢复 consumed quota。`failed|cancelled|expired` 只能按 8.5 的 provider closure 规则释放，单次查询“当前未支付”不构成释放依据。

### 5.12 `RechargeCreditTask` 与 `RechargeIdempotencyRecord`

积分入账采用仓库已有 `FakaBridgeTask` 等 task-specific transactional outbox 风格，不引入含糊的通用消息 outbox：

```text
RechargeCreditTask:
id UUID
rechargeOrderId unique
status pending|processing|succeeded|failed|reconcile_required
attempts Int
maxAttempts Int
nextAttemptAt
leaseToken nullable
leaseUntil nullable
lastErrorCode nullable
createdAt
completedAt nullable

RechargeIdempotencyRecord:
id UUID
userId
scope create_order|complete_payment|cancel_order|request_refund
key UUID
requestDigest
status processing|completed
claimToken UUID
resultType
resultId nullable
expiresAt
createdAt
```

`RechargeIdempotencyRecord` 设置 `@@unique([userId, scope, key])`；相同 key 与相同 digest 返回原结果，不同 digest 返回 409。`processing` 超过 `expiresAt` 后，相同 key + 相同 digest 可以使用新的 `claimToken` 原子接管；旧 claimToken 不能提交。`completed` 在配置的保留期内始终重放已保存的 result，不重新执行副作用。PR-A 创建该 schema，PR-B 只消费它。`RechargeCreditTask` 与支付事实同事务创建，只有持有当前 lease token 的 worker 可以提交结果。

## 6. Provider 合同

```ts
interface PaymentProvider {
  readonly name: PaymentProviderName
  getCapabilities(context: ProviderContext): Promise<ProviderCapabilities>
  createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentAction>
  completePayment?(input: CompleteProviderPaymentInput): Promise<NormalizedPayment>
  queryPayment(input: QueryProviderPaymentInput): Promise<NormalizedPayment>
  closePayment(input: CloseProviderPaymentInput): Promise<CloseResult>
  verifyAndNormalizeWebhook(input: RawWebhookInput): Promise<NormalizedProviderEvent>
  createRefund(input: CreateProviderRefundInput): Promise<NormalizedRefund>
  queryRefund(input: QueryProviderRefundInput): Promise<NormalizedRefund>
  listReconciliationEntries?(input: ReconciliationInput): AsyncIterable<ProviderEntry>
}
```

能力对象至少包括：

```text
supportedCurrencies
paymentMethods
actionTypes
supportsPartialRefund
supportsDisputes
supportsReconciliation
minimumAmountMinor
maximumAmountMinor nullable
capabilityVersion
capabilityDigest
```

Capabilities 必须按 `providerAccount + environment + currency + paymentMethod` 求值，不是 provider 名称级常量；上述 minimum/maximum 是已求值组合的结果。报价和创建支付都要验证该组合；不支持的币种/方式返回 `PAYMENT_METHOD_UNAVAILABLE`，配置检查应拒绝将微信支付与 USD、或支付宝 V1 adapter 与非两位小数币种错误组合。

所有 provider adapter 必须：

- 使用官方 SDK 或标准密码库，不自行实现加密算法；
- 将渠道金额格式转换为平台 `BigInt amountMinor`；
- 将渠道专有状态映射到统一状态；
- 保留原始 provider ID，不把它当平台主键；
- 对所有创建、capture、退款请求使用稳定幂等标识；
- 对超时和未知结果先查询，禁止盲目重发可能扣款的请求；
- 校验 merchant/account/app ID、币种、订单号和金额完全匹配后才输出 `succeeded`；
- 返回稳定的内部错误码，不向客户端或日志暴露渠道密钥和原始错误正文。

### 6.1 Simulator

Simulator 必须覆盖：成功、失败、pending、超时、重复回调、乱序回调、金额不匹配、签名失败、退款成功、退款失败、拒付和 paid-but-credit-worker-crash。

充值的环境隔离统一使用以下谓词：

```ts
const deploymentEnv = process.env.MONEXUS_DEPLOY_ENV ?? 'production'
const isProductionDeploy =
  process.env.NODE_ENV === 'production' &&
  deploymentEnv === 'production'
```

当 `isProductionDeploy` 为 true 且 provider=simulator 或 `RECHARGE_MODE=sandbox` 时，进程启动失败。`NODE_ENV=production + MONEXUS_DEPLOY_ENV=staging` 允许 Simulator；`NODE_ENV=production` 下未设置 `MONEXUS_DEPLOY_ENV` 时按 production fail closed。该谓词仅用于充值 sandbox/Simulator/live 隔离；Cookie、MFA 和其他既有安全行为仍按 `NODE_ENV=production`，不得因此降级 staging 安全配置。

模拟状态变更端点只在 `!isProductionDeploy` 注册，并需要测试专用认证。生产构建中不得存在无需认证的“支付成功”入口。

### 6.2 Stripe

首选 Stripe-hosted Checkout，避免平台接触银行卡信息。一个充值订单对应一个 Stripe Checkout Session/PaymentIntent，平台订单 ID 放入非敏感 metadata。服务端使用稳定 idempotency key 创建。

入账以已验签的 `payment_intent.succeeded` 或等价的已确认支付终态为准；`checkout.session.completed` 只有在其支付状态也确认已付款时才能入账。Webhook 必须使用未经 JSON parser 修改的 raw body、`Stripe-Signature` 和 endpoint secret 验签。

Stripe API 金额是币种最小单位整数。Provider capability 必须根据账户结算币种和所选 payment method 给出有效最低额；平台 `$1.00` floor 高于 Stripe 官方 USD `$0.50` 基准，但其他币种和方式可能更高。

### 6.3 PayPal

V1 使用 Orders v2 的 redirect approval 流程，不使用 PayPal JavaScript SDK。创建 PayPal Order 后，adapter 从官方响应 links 中选择 `rel=approve` 的 HTTPS URL，返回统一 `redirect` action。买家批准并返回平台后，前端调用 `POST /api/recharge/orders/:id/complete`，服务端再通过可选 `completePayment()` 执行 capture。创建、capture 和退款使用稳定 `PayPal-Request-Id`；重复 complete 必须复用同一 provider idempotency key。capture 超时或结果未知时先 query，不得盲目再次 capture。

只有 authenticated PayPal API 返回 capture `COMPLETED`，且金额、币种、订单引用以及响应中可用的 payee/merchant identity 与当前 provider account context 匹配，才能写入 `source=provider_complete` 的 PaymentObservation；adapter 不得假设每种 PayPal payment source 都返回同一组 identity 字段。浏览器 return URL 或请求 `/complete` 的动作本身均不是支付证据，不能直接入账。后续 webhook、query 或 complete API 响应都先持久化 observation，再由 `applyConfirmedPayment` 收敛到 paid/credited。

Webhook 必须验证真实性。接收成功返回 2xx；处理逻辑异步执行。PayPal 会对非 2xx 通知重试，因此统一的 `(provider, providerAccountKey, dedupeKey)` 去重是必须条件。sandbox credentials 和 endpoint 与 live 完全隔离。

### 6.4 微信支付 API v3

Web 端首期采用 Native 支付返回 `code_url`；以后可按能力增加 JSAPI/H5。`out_trade_no` 在商户号下唯一；CNY `amount.total` 为分的整数且大于零。

回调必须先使用微信支付平台证书/公钥验证 HTTP 签名，再使用 API v3 key 解密 resource。校验 `mchid`、`appid`、`out_trade_no`、`transaction_id`、`trade_state`、`amount.total` 和 `currency` 后才能入账。

系统不能只依赖回调；未收到或状态不明时调用查询订单。重复通知返回成功但不重复处理。退款重试使用原 `out_refund_no`，申请接口成功只代表受理，最终状态来自退款通知或退款查询。

本 Spec 不假设微信支付提供可公开使用且等价于 live 的通用 sandbox。没有商户测试能力时，adapter 用官方示例 fixture 和协议测试验证，生产保持 disabled。

### 6.5 支付宝开放平台

Web 端支持手机网站支付和电脑网站支付，由适配器返回 redirect/form action。`out_trade_no` 在商户系统唯一。V1 支付宝 adapter 只接受 currency scale=2 的已配置币种，负责在支付宝“两位小数主单位字符串”与平台 `amountMinor` 之间精确转换，不得用浮点数；其他 scale 必须由 capabilities 拒绝。

异步通知必须使用支付宝公钥/证书验签，同时校验 `app_id`、`out_trade_no`、`trade_no`、交易状态、`total_amount`、seller/merchant identity。验签或任一业务字段不匹配时忽略并记录安全指标。

回调缺失时使用 `alipay.trade.query` 收敛状态。退款使用官方退款接口和唯一退款请求号；部分退款后不能仅凭交易主状态判断退款完成。sandbox 与 production app、gateway、密钥和回调地址完全隔离。

## 7. API 合同

所有 BigInt/金额字段在 JSON 中使用十进制字符串。

### 7.1 用户 API

```text
GET  /api/recharge/config?currency=CNY
POST /api/recharge/quotes
POST /api/recharge/orders                 Idempotency-Key required
POST /api/recharge/orders/:id/complete    Idempotency-Key required
GET  /api/recharge/orders
GET  /api/recharge/orders/:id
POST /api/recharge/orders/:id/cancel      Idempotency-Key required
POST /api/recharge/orders/:id/refunds     Idempotency-Key required
```

报价请求：

```json
{
  "currency": "CNY",
  "amountMinor": "1000",
  "amountSource": "custom",
  "provider": "stripe",
  "paymentMethod": "card"
}
```

报价响应：

```json
{
  "quoteId": "uuid",
  "currency": "CNY",
  "amountMinor": "1000",
  "basePoints": "1000",
  "bonusPoints": "0",
  "totalPoints": "1000",
  "pricePolicyId": "uuid",
  "pricePolicyCode": "rp-cny-recharge-v1",
  "provider": "stripe",
  "paymentMethod": "card",
  "effectiveMinAmountMinor": "100",
  "effectiveMaxAmountMinor": "100000",
  "expiresAt": "RFC3339"
}
```

`GET /api/recharge/config` 返回当前币种可用的 provider/paymentMethod 组合及显示元数据，不返回内部 provider account key。订单创建请求只引用已经绑定 provider/method 的 `quoteId`；服务端重新选择并校验 provider account 与 capability。响应只返回适合该 action 的结构化字段：redirect URL、二维码内容、受限 client secret 或 form-post action；不得返回 provider secret 或可执行 HTML。

`POST /api/recharge/orders/:id/complete` 仅用于需要“买家批准后服务端完成/capture”的 provider；其他 provider 返回 409。它校验订单所有权、当前 attempt、稳定 Idempotency-Key 和 provider 状态，只推进 provider capture/query，不从浏览器输入推导 paid 或 credited。authenticated provider API 结果先持久化为 `source=provider_complete` 的 PaymentObservation，再调用统一确认入口。重复调用返回同一已知结果；未知结果返回处理中状态并调度 query recovery。

主要错误码：

```text
RECHARGE_DISABLED                       404/503
RECHARGE_CURRENCY_DISABLED              409
RECHARGE_AMOUNT_BELOW_MINIMUM           400
RECHARGE_AMOUNT_ABOVE_MAXIMUM           400
RECHARGE_AMOUNT_STEP_INVALID            400
RECHARGE_LIMIT_EXCEEDED                 409
RECHARGE_QUOTE_EXPIRED                  409
RECHARGE_QUOTE_CHANGED                  409
PAYMENT_PROVIDER_UNAVAILABLE            503
PAYMENT_ALREADY_IN_PROGRESS             409
PAYMENT_STATE_UNKNOWN                   409
PAYMENT_COMPLETION_NOT_SUPPORTED        409
REFUND_BALANCE_INSUFFICIENT             409
REFUND_REQUIRES_REVIEW                  409
```

### 7.2 Provider webhook

```text
POST /api/payment/webhooks/stripe
POST /api/payment/webhooks/paypal
POST /api/payment/webhooks/wechat-pay
POST /api/payment/webhooks/alipay
```

这些路由不使用用户认证，但必须使用 provider 验签。必须在 `server/src/app.ts` 的通用 `express.json()` 和通用 `/api` limiter 之前挂载并捕获所需 raw body 或原始 form body。端点有独立 body size、速率、超时和日志脱敏策略。

Webhook 请求流程：

```text
读取有界 raw body
-> 验证签名/解密
-> 校验 provider account identity
-> 事务插入 source=webhook 的 PaymentObservation/PaymentEvent（重复则读取原记录）
-> 快速返回渠道要求的成功响应
-> worker 按租约调用 applyConfirmedPayment(observationId)
```

### 7.3 管理 API

```text
GET  /api/admin/recharge/orders
GET  /api/admin/recharge/orders/:id
GET  /api/admin/payments/events
POST /api/admin/payments/events/:id/retry
POST /api/admin/recharge/orders/:id/reconcile
POST /api/admin/recharge/orders/:id/refunds
GET  /api/admin/payments/reconciliation-runs
POST /api/admin/payments/reconciliation-runs
GET  /api/admin/payments/disputes
PATCH /api/admin/recharge/price-policies/:id
POST /api/admin/recharge/price-policies/:id/activate
```

管理变更复用现有 admin、active user 和 MFA 中间件。V1 不要求额外的人工会签或双人审批。

## 8. 核心事务与并发不变量

### 8.1 支付成功与积分入账

渠道支付事实和积分入账使用两个可恢复事务，避免余额不变量失败时丢失“渠道已经收款”的事实。

所有 adapter 和恢复路径共享两步入口：

```text
recordPaymentObservation(normalizedObservation)
-> applyConfirmedPayment(observationId)
```

Webhook、provider query、provider complete/capture 和 reconciliation 只能通过这条入口确认支付。`recordPaymentObservation` 先按 `(provider, providerAccountKey, dedupeKey)` 持久化并返回 observation ID；`applyConfirmedPayment` 是唯一允许把 PaymentAttempt、PaymentIntent 和 RechargeOrder 推进为支付成功的服务。controller、adapter、query worker 和 reconciliation handler 均不得复制成功事务。

事务 A（确认支付）：

1. 按 ID 锁定/claim PaymentObservation/PaymentEvent，验证 source 对应的 verificationMethod 已通过；
2. 按固定顺序锁定 PaymentAttempt、PaymentIntent、RechargeOrder 和限额 reservation；
3. 比较 provider account、provider payment/capture ID、订单引用、币种、金额和规范化成功终态；
4. 若 order 为 `pending_payment|closure_pending`，CAS 将 attempt/intent 标记 succeeded、order 标记 paid，并把两条 reservation 从 reserved 转 consumed；
5. 若 order 已为 `paid|credited` 且是同一 provider payment，视为幂等成功；若是第二笔支付，按 8.2 进入 reconcile；
6. 若 order 已为 `cancelled|expired|failed`，保留 observation 和 provider succeeded 事实，CAS 将 attempt/intent 标记 succeeded、order 标记 `reconcile_required`，写高优先级告警/对账项；不创建 RechargeCreditTask、不自动入账或退款，也不自动改写已释放 quota；
7. 对正常 paid 路径创建或读取唯一 `RechargeCreditTask(rechargeOrderId)`；
8. 标记 observation processed 并提交。

事务 B（积分入账 worker）：

1. 按固定顺序锁定 RechargeOrder 和 PointAccount；
2. 只接受 `status=paid` 且不存在 RechargeCredit；
3. 将 `totalPoints BigInt` 做正数和安全 Int 转换；
4. 基于最新余额检查 `balance + frozenBalance + points <= 2_000_000_000`；
5. 创建唯一 RechargeCredit；
6. 条件增加 PointAccount.balance；
7. 创建唯一关联 PointLog(type='in')；
8. CAS 将 order 标记 credited；
9. 写通知 outbox 并提交；
10. 提交后才递增 credited 指标。

事务 B 任一步失败全部回滚。可重试失败保留 order=paid 并由同一 RechargeCreditTask/扫描器重试；非重试错误（溢出、数据不变量损坏）在独立错误事务中将订单和 task 标记 `reconcile_required`，保留 attempt=succeeded 和支付证据，绝不截断或部分入账。来自任何 observation source 的重复事实最终都调度同一个 credit operation，命中唯一 RechargeCredit 后视为幂等成功。

数据库必须提供 `(status, creditedAt, updatedAt)` 或等价索引。恢复 worker 周期扫描超过 30 秒仍为 paid 且无 RechargeCredit 的订单，使用租约 claim；成功、已存在 Credit 或显式 `reconcile_required` 是终止条件。超过 2 分钟仍未 credited 触发告警。

### 8.2 双重支付

同一充值订单原则上只能有一个 active attempt。如果渠道切换或竞态导致两个 provider payment 均成功：

- 只允许第一个成功事务创建 `RechargeCredit`；
- 第二笔标记 `reconcile_required`；
- 不再次增加积分；
- 触发高优先级告警；
- 不在状态不清楚时自动退款。

### 8.3 Worker 租约

PaymentObservation/PaymentEvent、查询恢复、退款和对账 worker 使用数据库租约：`leaseToken + leaseUntil + attempts + nextAttemptAt`。完成操作必须匹配当前 token，过期 worker 不能提交结果。可重试错误使用有上限的指数退避；金额不匹配、验签失败、约束失败不自动重试。

### 8.4 日/月限额的原子占额

quote 只展示限额结果，不占额。创建 RechargeOrder 的数据库事务必须：消费 quote、按固定顺序锁定或 upsert day/month RechargeLimitBucket、对两者执行 `reserved + consumed + requested <= configured limit`、创建两条 reservation，然后才提交订单。任一 bucket 超限时整个事务回滚并返回 `RECHARGE_LIMIT_EXCEEDED`。

订单转 `paid` 的同一事务把两条 reservation 从 reserved 转 consumed。没有 provider attempt 的订单可在转 `cancelled|expired` 时释放；已有 attempt 的释放必须满足 8.5。退款不恢复已消费额度。并发测试必须证明两个各自低于限额、合计超限的订单最多一个成功创建。

### 8.5 取消、过期与迟到支付

取消/过期和 provider 成功必须遵守以下顺序：

```text
没有 provider attempt
  -> 本地 cancelled|expired
  -> release reservation

已有 terminal failed|cancelled|closed attempt
  -> provider query 再确认 terminal non-payable
  -> 本地 cancelled|expired|failed
  -> release reservation

已有 non-terminal attempt
  -> CAS order=closure_pending（reservation 保持 reserved）
  -> 使用稳定幂等键 closePayment
  -> query 确认 terminal failed|cancelled|closed
  -> 本地 cancelled|expired
  -> release reservation

close/query unknown 或仍可付款
  -> 保持 closure_pending，重试 query
  -> 超过恢复上限进入 reconcile_required
  -> 不释放 reservation
```

如果 order 处于 `closure_pending` 时先收到已验证 succeeded observation，支付成功获胜：事务 A 将订单转 paid、reservation 转 consumed，并按正常路径入账。如果 order 已经 terminal `cancelled|expired|failed` 后才出现 provider succeeded，事务 A 必须按迟到支付异常处理：不自动 credit、不自动 refund、不重开 quota，保留完整支付证据，标记 `reconcile_required` 并触发高优先级告警，由人工选择退款或恢复订单。单纯一次“当前未支付”的 query 不足以释放 reservation，必须确认 attempt 已关闭或处于不会再付款的 provider terminal 状态。

## 9. 配置与环境隔离

```text
RECHARGE_MODE=disabled|sandbox|live
RECHARGE_ACCEPT_NEW_ORDERS=true|false
RECHARGE_ENABLED_CURRENCIES=CNY,USD
PAYMENT_ENABLED_PROVIDERS=simulator,stripe,paypal,wechat_pay,alipay
PAYMENT_REGISTERED_PROVIDERS=simulator,stripe,paypal,wechat_pay,alipay
PAYMENT_EVENT_ENCRYPTION_KEY=...
PAYMENT_WEBHOOK_PUBLIC_BASE_URL=...
STRIPE_MODE=test|live
PAYPAL_MODE=sandbox|live
WECHAT_PAY_MODE=disabled|live
ALIPAY_MODE=sandbox|live
```

本节所有“production deploy”均指第 6.1 节的 `isProductionDeploy`，不等同于单独的 `NODE_ENV=production`。每个 provider 的凭据使用独立前缀，配置层必须拒绝：

- production 中 `RECHARGE_MODE=sandbox`；
- production 中启用 `simulator`；
- live provider 携带 test/sandbox endpoint 或凭据；
- sandbox provider 携带 live endpoint；
- 启用 provider 但缺少 webhook 验签密钥；
- live 充值启用但币种没有 active `RechargePricePolicy`；
- HTTP webhook public base URL；
- 生产 metrics endpoint 无鉴权。

没有真实凭据不阻塞核心代码合并：生产保持 `RECHARGE_MODE=disabled` 即为合法部署状态。

`PAYMENT_ENABLED_PROVIDERS` 只控制新 quote 和新 PaymentAttempt，必须是 `PAYMENT_REGISTERED_PROVIDERS` 的子集。`PAYMENT_REGISTERED_PROVIDERS` 控制 inbound webhook、query、refund、dispute 和 reconciliation adapter 的注册；曾经产生历史订单/支付事实的 provider 在所有未结事项与保留期结束前必须继续 registered 并保留恢复所需凭据，即使它已从 enabled 列表移除。不得用 `PAYMENT_ENABLED_PROVIDERS` 直接决定是否挂载历史 webhook 或启动恢复 worker。

`RECHARGE_ACCEPT_NEW_ORDERS` 只控制 quote 和新订单，不控制历史支付收敛。运行矩阵：

| 模式 | 新 quote/order | Webhook | 支付查询恢复 | credit/refund/dispute/对账 worker |
| --- | --- | --- | --- | --- |
| disabled | 拒绝 | 已配置过的 provider 路由保留 | 运行 | 运行 |
| sandbox | 允许 sandbox/Simulator | 运行 | 运行 | 运行 |
| live | 允许 live provider | 运行 | 运行 | 运行 |

紧急关闭时设置 `RECHARGE_ACCEPT_NEW_ORDERS=false`，不能停掉已收款订单的入账、退款、争议和对账。一个从未配置过任何 provider 的全新 disabled 部署可以不注册对应 webhook，但曾经启用过的 provider 必须保留历史事件处理凭据直至保留期和未结事项结束。

## 10. 前端

新增 `/recharge` 页面并复用现有认证、余额和视觉体系。页面包含：

- 当前余额；
- 币种选择，仅显示服务端启用币种；
- 推荐金额；
- 自定义金额输入；
- 最低/最高错误的内联反馈；
- 即时服务端报价；
- 支付方式选择；
- 明确的“支付金额”和“获得积分”；
- 创建支付按钮及处理中状态。

支付结果页必须轮询本地充值订单或使用现有实时通知能力，不能从 return URL 查询参数直接显示“已入账”。最终状态包括：等待支付、确认中、已到账、失败、已过期、退款处理中、已退款、需要处理。

Profile 增加“充值”入口和充值记录入口。余额变更后调用现有 auth store 刷新机制。充值记录使用独立 API，不把现金支付明细混入商品订单列表。

管理端新增“充值支付”区域，至少包含订单、支付事件、退款、争议、对账五个视图。危险操作使用现有 MFA 门禁；不提供数据库直改或绕过 provider 状态的“强制成功”。

## 11. 可观测性与运维

指标标签必须有界，不得使用 userId、orderId、provider transaction ID：

```text
recharge_quote_total{currency,result}
recharge_order_total{currency,provider,result}
payment_observation_total{provider,source,result}
payment_webhook_signature_failure_total{provider}
payment_amount_mismatch_total{provider,currency}
recharge_credit_total{currency,result}
recharge_credit_latency_seconds{provider}
recharge_paid_not_credited_total{provider}
payment_refund_total{provider,result}
payment_dispute_total{provider,status}
payment_reconciliation_mismatch_total{provider,type}
payment_worker_backlog{worker}
```

必须告警：

- paid 超过 2 分钟未 credited；
- 任一重复入账唯一约束冲突；
- 金额或币种不匹配；
- webhook 验签失败突增；
- worker backlog/oldest age 超阈值；
- provider 查询持续失败；
- terminal 本地订单出现迟到 provider succeeded；
- 退款长时间 processing；
- 对账不一致；
- 生产检测到 simulator 配置。

Runbook 必须说明 provider 熔断、充值总开关、paid-not-credited 修复、observation 重放、迟到支付人工处置、退款恢复、对账差异和凭据轮换。关闭充值不得影响已支付事件继续入账和退款处理。

## 12. 安全与隐私

- 前端使用 Stripe Checkout/官方 SDK、PayPal approval redirect、微信二维码或支付宝结构化 form-post/redirect；服务端不接触银行卡 PAN/CVV；
- provider secret、私钥、API v3 key、webhook secret 不入库、不入 Git、不进日志；
- client secret/action payload 只返回给订单所属用户，设置有效期并禁止记录；
- webhook 原始 body 有大小上限，验签前不信任任何字段；
- 支付接口使用独立速率限制、账户状态检查和邮箱验证；
- 用户只能读取自己的 RechargeOrder；
- 管理列表默认不显示付款人敏感标识或原始 payload；
- 所有管理员修复动作写现有审计日志；
- 日志只记录内部 ID、安全错误码、provider 和状态，不记录完整响应正文；
- 账户触发争议时可按 PaymentRecoveryCase 禁止新充值和积分消费；异常频率或限额至少禁止新充值。任何限制都不阻塞合法退款、申诉和历史记录读取。

## 13. 测试要求

### 13.1 金额与定价

- CNY/USD 最低值边界：99/100/101 minor；
- 自定义金额的 step、最大值、日/月限额；
- quote 的 provider/method/account capability 快照和 effective min/max；
- 两个并发订单合计超过日或月限额时最多一个占额成功；
- failed/cancelled/expired 释放 reservation，paid 转 consumed，退款不恢复额度；
- 超过 `Number.MAX_SAFE_INTEGER` 的输入；
- JSON number 金额拒绝，只接受十进制字符串；
- HALF_EVEN tie/non-tie；
- 历史订单不受新政策影响；
- 未配置 USD 正式政策时 fail closed。

### 13.2 支付与回调

- 每个 provider 的签名成功/失败 fixture；
- 重复事件、乱序事件、延迟事件；
- 金额、币种、merchant/app/account ID 不匹配；
- API 超时但渠道实际成功；
- webhook/query/complete/reconciliation 对同一支付事实均先持久化 observation，并调用同一 `applyConfirmedPayment`；
- PayPal duplicate complete 复用同一 capture 幂等键；
- capture timeout/unknown 先 query，不盲目重发；
- 伪造浏览器 complete/return URL 不入账；
- return URL 伪造不入账；
- 事件持久化后 worker 崩溃并恢复；
- 两个 worker 同时领取；
- 两个 provider 意外同时支付成功；
- webhook 快速 ACK 与后台失败重试。
- form-post action 只包含 allowlisted HTTPS actionUrl 和有界字段，不包含可执行 HTML；
- 无 attempt 取消直接释放；non-terminal attempt 先 close/query，unknown 不释放；
- closure_pending 与 succeeded 并发时支付成功获胜并消费 quota；
- terminal cancelled/expired/failed 后迟到 succeeded 进入 reconcile，不自动 credit/refund。

### 13.3 积分与退款

- 100 个相同成功回调只增加一次余额；
- 回调、主动查询和管理员 reconcile 并发只入账一次；
- 事务在 PointLog 前后失败均不产生半套数据；
- 余额溢出 fail closed；
- 退款先 hold、成功消耗、失败释放；
- 退款 webhook、query 和 reconcile 并发只创建一个 RechargeReversal；
- 余额不足不调用 provider refund；
- 拒付不制造负余额，胜诉、败诉和核销均可通过 PaymentRecoveryCase 显式结案。

### 13.4 环境

- `NODE_ENV=production + MONEXUS_DEPLOY_ENV=production + Simulator` 启动失败；
- `NODE_ENV=production + MONEXUS_DEPLOY_ENV=staging + Simulator` 允许；
- `NODE_ENV=production` 且缺失 `MONEXUS_DEPLOY_ENV` 时按 production 拒绝 Simulator；
- `NODE_ENV=development + MONEXUS_DEPLOY_ENV=production + Simulator` 允许，证明谓词使用 AND；
- production deploy + sandbox credential/endpoint 启动失败；
- disabled 模式不注册用户创建支付能力，但 webhook/退款恢复策略按部署设计保持可处理；
- enabled providers 不是 registered providers 子集时启动失败；从 enabled 移除历史 provider 不得卸载其 webhook/query/refund/reconciliation adapter；
- 密钥和 payload 不出现在日志快照；
- migration 可在空库和升级库重放，不使用 `prisma db push`。

## 14. 精简验收门禁

本项目不要求产品/法务/财务签字、DOCX 同步或额外会签记录。每个实施 PR 只需满足与其范围相称的工程门禁：

1. `npm run check:runtime`；
2. 受影响 workspace build/typecheck；
3. 新增定向测试通过；PR-A0、PR-A、PR-B、PR-C 中涉及约束、行锁、CAS、reservation、幂等或并发的测试必须使用真实 PostgreSQL；
4. migration 同时通过空库与升级库测试（有 schema 改动时）；
5. `git diff --check`；
6. PR CI 通过。

涉及入账、退款或 webhook 的 PR 还必须通过本 Spec 第 13 节对应的幂等与并发测试。没有 live 商户凭据时，不要求真实扣款证明；adapter 必须保持 disabled，并提供官方 fixture/contract tests。不得用模拟数据声称 live provider 已验收。

## 15. 官方文档核验记录

核验日期：2026-08-19。实施时如官方 SDK 或 API 版本变化，adapter PR 应更新本节链接和差异说明。

### Stripe

- [Payment Intents API](https://docs.stripe.com/payments/payment-intents)：一个购买会话对应一个 PaymentIntent、创建时使用 idempotency key、支付后由服务端监听 webhook。
- [Stripe Webhooks](https://docs.stripe.com/webhooks)：HTTPS endpoint、raw body 签名验证、快速返回 2xx、测试事件及异步事件处理。
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)：POST 请求的幂等键语义。
- [Refunds and cancellations](https://docs.stripe.com/refunds)：退款状态与退款事件。
- [Supported currencies](https://docs.stripe.com/currencies)：API 使用 minor unit；Stripe 最低收款额依结算币种和支付方式而定，USD 基准为 `$0.50`。

### PayPal

- [Orders v2 API](https://developer.paypal.com/docs/api/orders/v2/)：创建、授权、capture、订单金额和币种合同。
- [Capture payment for order](https://developer.paypal.com/api/orders/v2/orders-capture/)：买家批准订单后由服务端 capture；V1 采用 approval redirect，不采用 JavaScript SDK。
- [PayPal REST Webhooks](https://developer.paypal.com/api/rest/webhooks)：必须验证通知；非 2xx 会重试，官方当前说明最多 25 次、持续 3 天。
- [Payments v2](https://developer.paypal.com/docs/api/payments/v2/)：capture、refund 和 `PayPal-Request-Id` 幂等请求头。
- [PayPal Sandbox](https://developer.paypal.com/tools/sandbox/)：sandbox 与 live 隔离，用虚拟账户和 sandbox endpoints 验证流程。

### 微信支付

- [Native 下单](https://pay.weixin.qq.com/doc/v3/merchant/4012791877)：`out_trade_no` 唯一、`amount.total` 为分且大于零、固定 CNY、返回 `code_url`。
- [支付成功回调](https://pay.weixin.qq.com/doc/v3/merchant/4012791861)：回调验签、解密、重复通知和金额字段。
- [签名认证](https://pay.weixin.qq.com/doc/v3/merchant/4012365342)：请求签名与应答/回调验签。
- [退款申请](https://pay.weixin.qq.com/doc/v3/merchant/4012791883)：唯一 `out_refund_no`、重试复用原单号、受理不等于退款最终成功。
- [退款结果通知](https://pay.weixin.qq.com/doc/v3/merchant/4012791886)：退款回调验签、解密、重复通知和查询兜底。

### 支付宝

- [手机网站支付快速接入](https://opendocs.alipay.com/open/203/105285)：下单、`out_trade_no`、`total_amount`、notify URL、查询、退款和 sandbox 流程入口。
- [手机网站支付异步通知](https://opendocs.alipay.com/open/203/105286)：异步通知参数、验签和重试。
- [通用异步通知说明](https://opendocs.alipay.com/open/064jha)：回调缺失时必须结合 `alipay.trade.query`；同一通知可能重发。
- [电脑网站支付快速接入](https://opendocs.alipay.com/open/270/105899)：Web 桌面支付流程。

## 16. 完成定义

V1 完成不是“某个支付按钮能跳转”，而是以下整体成立：

- 任意重复、乱序或并发成功信号最多入账一次；
- 支付成功不会静默丢单，worker/查询/对账可以恢复；
- 金额、币种或商户身份不匹配永不入账；
- 每笔充值积分可追溯到唯一 RechargeOrder、PaymentAttempt 和 RechargeCredit；
- 退款不会在未冻结对应积分前发出；
- 生产无法启用 Simulator；
- 没有 live 凭据时系统可以安全地以 disabled 状态部署；
- 新 provider 可以通过实现同一合同接入，而无需修改充值核心状态机。
