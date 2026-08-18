# Spec：积分真实价值锚定与价值账本升级

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-VALUE-LEDGER-001 |
| 版本 | 0.2.0 |
| 日期 | 2026-08-17 |
| 状态 | Draft — D-01 Approved |
| 产品 | MoNexus |
| 基线 | `origin/develop@46253bc`、`origin/master@5f3bb32` |
| 影响域 | 积分、商品定价、订单、退款、商家结算、支付、财务对账、会员成长、排行榜 |
| 决策人 | 产品负责人、财务负责人、合规/法务负责人、技术负责人 |

> 本文是产品与工程规格，不构成会计、税务或法律意见。启用用户充值、现金赎回、用户间转账、商家法币/稳定币出款前，必须由运营主体所在司法辖区的专业顾问书面确认。

## 0. 执行摘要

### 0.1 推荐结论

MoNexus 不应让积分余额随 CNY、USD 或 USDT 的市场汇率每日变化，也不应把 USDT 当作美元本身。推荐采用以下三层模型：

1. **价值本位币（valuation currency）**：全平台只选一个，作为商品参考价值、财务报表和商家应付的统一尺度。**首个生产租户已决定选择 `CNY`，决策日期为 2026-08-17。** USD 只作为未来可能的支付/展示报价币种或独立租户方案，不与 CNY 构成等价锚。
2. **固定积分面值（fixed face value）**：积分与本位币采用版本化、长期固定的比例。推荐候选为 `100 PTS = 1 CNY` 或 `100 PTS = 1 USD`，两者是互斥方案，绝不表示 `1 CNY = 1 USD`。一个租户在任一时期只能选择一种价值本位币：选择 CNY 时，积分面值只以 CNY 定义；选择 USD 时，积分面值只以 USD 定义。其他币种或资产必须通过订单级 FX 报价换算。该候选比例使 1 积分恰好对应所选本位币的最小单位，避免小数积分与循环舍入；最终比例应在上线前用真实商品价格分布、奖励成本与预算回测后批准。
3. **支付/结算资产（payment and settlement assets）**：CNY、USD、USDT 等只在充值、支付或商家出款边界使用；每次生成有时效的报价并在订单上快照。USDT 必须细分网络与合约，例如 `USDT-TRON`、`USDT-ETHEREUM`，不能只记录 `USDT`。

### 0.1a 两个“Phase 1”不要混用

| 文档 | 含义 | 2026-08-18 状态 |
| --- | --- | --- |
| `SPEC-VALUE-POLICY-P1-001` | 窄 Phase 1：CNY `ValuePolicy`、精确换算、checkout preview、订单定价快照 | 工程已实现；生产激活仍被 D-02/D-03 阻断 |
| 本文 `SPEC-VALUE-LEDGER-001` 的 P1 | 大 Phase 1：ledger、lot、双写迁移、RP/VC/XP 拆分 | **仍未实施** |

窄 Phase 1 完成不等于本规格完成。LedgerAccount / LedgerTransaction /
LedgerEntry / EntitlementLot / ConsumptionAllocation / FxQuote / 真实支付 /
充值转账提现 / SettlementV2 均不在窄 Phase 1 交付范围内。

### 0.2 立即实施范围

首期只做 **“参考价值锚定 + 账本基础改造”**：

- 保留积分不可转让、不可现金赎回、不可用户充值的现有闭环边界；
- 商品、结算预览、订单和流水增加参考价值与价值政策版本；
- 把“奖励积分”“可购买储值”“会员成长值”“商家应付”在领域模型上拆开；
- 引入不可变双重记账、明确舍入和幂等规则，为后续真实支付留接口；
- **不在首期接入银行卡、微信/支付宝、Stripe、银行出款或链上 USDT。**

用户充值、商家真实货币出款与 USDT 分别作为独立阶段，只有财务、合规、风控和对账门禁全部通过后才能启用。

### 0.3 为什么不是“1 积分永远等于 1 USDT”

- USDT 是由私人发行方发行、存在于多条链上的代币，不是 USD 法币或银行存款；网络选错可能导致资产损失。
- Tether 官方要求平台明确列出支持的协议，并会停止旧协议的发行或赎回义务。
- Tether 官方直接法币赎回要求验证账户，当前页面列出的最低赎回金额为 100,000 美元等值。
- 稳定币可能发生脱锚、冻结、链拥堵、合约与交易对手风险；因此 USDT 适合作为可选支付轨道，不适合作为平台唯一价值本位币。

## 1. 背景与现状

### 1.1 当前实现事实

当前 `develop` 与 `master` 的积分相关代码无差异。系统明确定位为纯内部积分平台，真实支付、用户充值和法币提现均在现有产品边界之外。

| 现状 | 代码/文档依据 | 影响 |
| --- | --- | --- |
| 用户账户只有 `balance Int` 与 `frozenBalance Int` | `server/prisma/schema.prisma` 的 `PointAccount` | 无币种、精度、资金来源或负债分类 |
| 流水只有 `in/out/hold/release/refund`、`amount Int`、`balanceAfter Int` | `PointLog` | 奖励、购买、退款、结算语义混在一个日志 |
| 商品、Offer、订单价格均为整数积分 | `Product.price`、`Offer.price`、`Order.price` | 无参考币种和下单汇率快照 |
| Settlement 金额仍是整数积分 | `Settlement.orderAmount/commissionAmount/settlementAmount` | 当前“商家结算”只是给商家积分账户入账，不是外部出款 |
| 佣金率是 `Decimal(5,4)`，金额用 `Math.floor` | `server/src/modules/orders/service.ts` | 有隐含舍入规则，未形成公开契约 |
| 即时商品扣余额，人工服务在 available/frozen 间冻结 | `server/src/modules/orders/accounting.ts` | 原子性正确，应保留 |
| 下单已支持 `expectedPrice` 与幂等键 | `server/src/modules/orders/service.ts` | 可扩展为“价格 + 价值政策 + 报价”三重校验 |
| 会员成长和排行榜只统计 `PointLog.type='in'` | `server/src/modules/points/service.ts`、`server/src/modules/leaderboard/service.ts` | 充值若也写 `in` 会污染等级与排行榜 |

### 1.2 核心问题

当前一个整数同时承担四种不同概念：

1. 用户通过签到/邀请获得的促销权益；
2. 购买商品时使用的支付单位；
3. 商家销售后收到的结算资产；
4. 用户等级和排行榜的成长度量。

只在 UI 上加一个 `≈ ¥x.xx` 或 `≈ $x.xx` 无法解决责任边界。若未来用户可用真钱购买积分，预收款通常会形成待履约义务；若又允许赎回、转让或跨商户使用，则可能进入预付价值、支付工具、反洗钱和资金存管范畴。设计必须先拆语义，再接支付。

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 |
| --- | --- |
| G-01 | 用户能理解积分的大致真实价值，商品之间可比较，价格不再是抽象数字。 |
| G-02 | 任一历史订单都能还原下单时的积分价格、本位币参考价值、支付报价和舍入结果。 |
| G-03 | 账本在并发、重试、退款、冻结、解冻、结算和外部回调下保持可审计、可对账。 |
| G-04 | 奖励积分、购买型储值、会员成长值与商家应付彻底分离，避免财务和运营口径互相污染。 |
| G-05 | 为未来 CNY 或 USD 法币支付及指定网络 USDT 的合规评估预留清晰接口；是否启用必须另立项目并通过门禁，本文不作能力承诺。 |
| G-06 | 迁移过程中不改写既有历史，不重复扣款，不制造负余额，支持灰度回滚。 |

### 2.2 非目标

- 本文不选择具体支付服务商、交易所、托管商或银行。
- 本文不提供任何司法辖区的牌照结论。
- 首期不支持用户间转账、积分交易、现金赎回、链上钱包托管或自动做市。
- 首期不承诺积分由现金、存款或 USDT 逐枚储备支持。
- 不用实时外汇价格重估用户已有积分余额。

## 3. 术语与资产分类

| 术语 | 代码示例 | 定义 |
| --- | --- | --- |
| 奖励积分 | `RP` | 签到、邀请、活动、管理员奖励产生；不可购买、转让或赎回。 |
| 购买型价值额度 | `VC` | 未来由真实付款获得的闭环储值；首期禁用。即使 UI 合并展示，账本必须独立。 |
| 成长值 | `XP` | 驱动会员等级/排行榜的非消费型指标；只由合格奖励行为产生。 |
| 价值本位币 | `CNY` 或 `USD` | 商品参考价值、财务汇总、商家应付的唯一统一尺度。 |
| 支付资产 | `CNY`、`USD`、`USDT-TRON` 等 | 用户实际付款所用资产。 |
| 结算资产 | `CNY`、`USD`、指定网络 USDT | 平台对商家实际出款所用资产。 |
| 原子单位 | minor/atomic unit | 数据库存储的最小整数单位，如分/美分或代币合约精度对应单位。 |
| 价值政策 | `ValuePolicy` | 积分面值、本位币、舍入规则及生效时间的不可变版本。 |
| 报价 | `FxQuote` | 特定资产对、金额、费率、来源和有效期的不可变快照。 |

## 4. 方案比较与决策

### 4.1 方案矩阵

| 方案 | 说明 | 优点 | 主要问题 | 结论 |
| --- | --- | --- | --- | --- |
| A. 仅展示动态等值 | 每次按实时 FX 分别显示积分的 CNY、USD 或 USDT 等值 | 实现快 | 同一积分每天价值不同；退款、商家结算和负债不可解释 | 拒绝 |
| B. 固定面值 + 单一本位币 | 积分面值长期固定，其他资产按订单报价 | 价格稳定、可审计、易迁移 | 改面值需治理；跨币种有 FX 风险 | **采用** |
| C. 多币种积分钱包 | 每种货币都有一种积分 | 可保留币种价值 | UX 复杂、流动性碎片化、结算与税务复杂 | 暂不采用 |
| D. 1 积分 = 1 USDT | USDT 同时做本位币与支付资产 | 链上结算直观 | USDT 非 USD、网络/发行方/脱锚/合规风险集中 | 拒绝 |
| E. 积分完全改成现金钱包 | 余额直接按法币/稳定币记账 | 资金语义直接 | 产品与监管属性发生根本变化 | 仅在独立持牌/合作方案中评估 |

### 4.2 本位币选择规则

| 条件 | 推荐本位币 |
| --- | --- |
| 运营主体、财务账簿、商品成本、商家合同和用户主要位于中国大陆 | `CNY` |
| 财务功能货币、商品采购、商家合同和主要市场以美元为主 | `USD` |
| 仅因“链上方便”想选择 USDT | 仍选 `USD`，USDT 只做支付/结算资产 |

本位币是租户级、长期决策，不是普通后台配置。任一时点只能存在一个本位币；更换本位币是需要重定价、余额与负债评估、历史连续性处理的迁移项目，不是一次普通汇率更新。生产环境变更必须新建政策版本、双人审批、设定未来生效时间并完成财务影响评估；禁止原地修改历史政策。

**生产决策 D-01（已批准，2026-08-17）**：MoNexus 首个生产租户的价值本位币为 `CNY`。通用数据模型可以保留未来支持 USD 的能力，但首期不得创建或激活以 USD、USDT 为本位币的生产价值政策。

### 4.3 面值候选

推荐候选如下，但每个租户只能选择其中一项：

```text
100 PTS = 1.00 CNY  （若本位币为 CNY）
100 PTS = 1.00 USD  （若本位币为 USD；仅可作为独立回测后的新方案）
```

这两个候选不具备相同经济价值。新租户必须根据自己的本位币与单位经济模型独立回测；既有积分计划更换本位币时，则必须按迁移基准汇率保持积分经济价值，不能直接沿用相同数字比例。换算公式为 `新每本位币积分数 = 旧每本位币积分数 × 新本位币兑旧本位币汇率`。例如旧政策为 `100 PTS = 1 CNY`，迁移基准汇率为 `1 USD = 7.20 CNY`，则价值保持的新政策约为 `720 PTS = 1 USD`，而不是 `100 PTS = 1 USD`；精确比例、舍入方式和生效时点必须写入迁移政策快照。

`100 PTS = 1` 个本位币主单位的工程优势是 `1 PTS = 1` 个本位币最小单位，积分价格转参考价值为精确整数乘法。当前演示商品价格约为 300–1,500 积分，对应 3.00–15.00 个本位币主单位，具备可读性；但生产比例必须通过以下数据回测后冻结：

- 商品 P10/P50/P90 价格；
- 用户月均获得、消费和结余积分；
- 平台奖励预算与预计核销率；
- 商家成本、佣金和最低结算额；
- 若启用购买型额度，预收资金与未履约余额峰值。

## 5. 领域不变量

| ID | 不变量 |
| --- | --- |
| INV-01 | 每种资产内，同一 `LedgerTransaction` 的借方总额必须等于贷方总额。 |
| INV-02 | 金额只用整数原子单位；API 用十进制字符串传输，禁止 JavaScript `number` 承载真实货币。 |
| INV-03 | `LedgerEntry` 只追加，不更新、不删除；纠错必须写反向交易。 |
| INV-04 | 每个外部事件、业务命令与账本交易均有唯一幂等键及请求指纹。 |
| INV-05 | `available >= 0`、`frozen >= 0`；所有用户分桶之和必须等于账本投影。 |
| INV-06 | 冻结只在 available 与 frozen 账户间转移，总权益不变。 |
| INV-07 | 退款按原消费分配逐笔原路恢复，不能把购买额度退款成奖励积分，反之亦然。 |
| INV-08 | 订单价格、价值政策、FX 报价、费用和舍入结果在确认时快照，历史不得重算。 |
| INV-09 | `RP/VC/XP/merchant payable` 不得共用账户或事件类型。 |
| INV-10 | USDT 资产标识必须包含网络、链 ID、合约地址与精度；symbol 不可作为唯一身份。 |
| INV-11 | 已成功入账的外部支付回调可重复接收，但账本效果只能发生一次。 |
| INV-12 | 商家出款必须以外部确认与日终对账为终态，不能以“请求已发送”视为成功。 |

## 6. 金额、汇率与舍入

### 6.1 统一 Money 类型

所有新 API 使用：

```ts
interface AtomicAmount {
  assetCode: string       // CNY, USD, RP, VC, USDT-TRON...
  amountAtomic: string    // 非负十进制整数字符串
  scale: number           // 展示精度；服务端资产表为权威
}
```

示例：`{ assetCode: 'CNY', amountAtomic: '1200', scale: 2 }` 表示 ¥12.00。ISO 4217 中不同币种的最小单位关系不同，不能假设所有法币都是两位小数；支付提供商还可能对付款和出款设置特殊规则。

### 6.2 固定积分换算

政策字段使用整数有理数。`RP` 与 `VC` 分别绑定自己的经济政策，不能只因显示比例相同就共用资产：

```ts
interface ValuePolicy {
  id: string
  version: number
  pointAssetCode: 'RP' | 'VC'
  referenceAssetCode: 'CNY' | 'USD'
  pointsNumerator: string       // 100
  referenceMajorDenominator: string // 1
  effectiveAt: string
  status: 'draft' | 'approved' | 'active' | 'retired'
}
```

为避免表意歧义，实现中另存规范化字段 `referenceAtomicPerPointNumerator/Denominator`。推荐比例下为 `1/1`，即一个积分对应一个本位币原子单位。

**经济面值不得通过普通 policy version 修改。** `RP` 或 `VC` 一旦启用，面值比例即成为该资产身份的一部分。若确需改变比例，必须创建新资产代码（例如 `RP2`），定义存量资产是否转换、转换窗口与用户披露，并走完整迁移；禁止让同一资产的旧余额在某天被静默重估。非经济字段（披露文案、显示格式等）可以新建 policy version。

### 6.3 FX 报价

```ts
interface FxQuote {
  id: string
  baseAssetCode: string
  quoteAssetCode: string
  baseAmountAtomic: string
  quoteAmountAtomic: string
  rateNumerator: string
  rateDenominator: string
  feeAmountAtomic: string
  spreadBps: number
  roundingMode: 'HALF_EVEN' | 'HALF_UP' | 'FLOOR' | 'CEILING'
  source: string
  observedAt: string
  expiresAt: string
  status: 'active' | 'consumed' | 'expired' | 'cancelled'
}
```

规则：

- 报价必须绑定用户、用途、订单/充值意图和金额范围，禁止跨用户复用。
- 确认时校验报价未过期、未消费、资产/金额/政策版本一致。
- 支付金额转换默认 `HALF_EVEN`；若业务需要向上取整，必须以显式费用/点差实现，不得隐藏在舍入里。
- 当前佣金 `Math.floor` 行为作为 legacy 兼容规则保留；新订单若改变规则，必须新建 `commissionPolicyVersion`。
- 任一舍入差额记入专用 rounding account，不能静默丢失。
- 不用浮点数存汇率；数据库用 `NUMERIC(38,18)` 或分子/分母，业务计算使用 decimal/bigint 库。

### 6.4 说明性示例

假设政策为 `100 PTS = 1 CNY`，商品价格 1,200 PTS：

```text
积分价格       1,200 PTS
参考价值       CNY 12.00（精确）
支付资产       USD 或 USDT-TRON
支付金额       由当次报价计算并锁定；不得用本示例中的假设汇率投入生产
```

退款必须读取订单快照和原始资金分配，不使用退款日汇率重算积分。

## 7. 目标账本架构

### 7.1 总体结构

```text
业务命令 / 外部回调
        │
        ▼
 Idempotency + Inbox
        │
        ▼
 LedgerTransaction ── LedgerEntry（不可变、双重记账）
        │                         │
        ├── Outbox               ├── BalanceProjection
        ├── PointLog 兼容投影     ├── OrderPricingSnapshot
        └── 财务/对账事件         └── Settlement/Payout
```

### 7.2 核心数据模型

#### AssetDefinition

```prisma
model AssetDefinition {
  code            String   @id
  kind            String   // reward_point | value_credit | fiat | stablecoin
  currencyCode    String?
  network         String?
  chainId         String?
  contractAddress String?
  scale           Int
  enabled         Boolean  @default(false)
  metadataVersion Int
  createdAt       DateTime @default(now())
  retiredAt       DateTime?

}
```

`code` 主键保证所有资产唯一。数据库 migration 另加仅针对 `kind='stablecoin'` 的 partial unique index `(network, chain_id, lower(contract_address))`，以及以下 CHECK：法币不得带 network/contract；稳定币必须同时带 network、chainId、contractAddress 且 `scale > 0`；`scale` 在允许范围内。稳定币资产必须由白名单配置创建。收到链上资产前同时校验网络、链 ID、合约地址、精度和确认数；任何一项不符都进入人工隔离，不自动入账。

#### LedgerAccount

```prisma
model LedgerAccount {
  id          BigInt   @id @default(autoincrement())
  ownerType   String   // user | merchant | platform | provider
  ownerId     String
  assetCode   String
  purpose     String   // available | frozen | issued | redeemed | clearing | payable...
  normalSide  String   // debit | credit
  status      String   // active | frozen | closed
  createdAt   DateTime @default(now())

  @@unique([ownerType, ownerId, assetCode, purpose])
}
```

`ownerType`、`purpose`、`normalSide`、`status` 和资产 kind 在 Prisma 使用 enum；数据库同时保留 CHECK/FK，避免绕过 ORM 时写入任意字符串。`assetCode` 外键指向 `AssetDefinition.code`。

#### LedgerTransaction / LedgerEntry

```prisma
model LedgerTransaction {
  id              String   @id // UUID/ULID
  code            String   // reward_grant | order_hold | order_capture | refund...
  status          String   // posted | reversed
  idempotencyKey  String
  requestHash     String
  sourceType      String
  sourceId        String
  sequence        Int      @default(0)
  reversalOfId    String?
  valuePolicyId   String?
  correlationId   String
  occurredAt      DateTime
  postedAt        DateTime @default(now())
  metadata        Json

  @@unique([sourceType, sourceId, code, sequence])
  @@unique([idempotencyKey])
}

model LedgerEntry {
  id            BigInt   @id @default(autoincrement())
  transactionId String
  accountId     BigInt
  assetCode     String
  side          String   // debit | credit
  amountAtomic  BigInt
  createdAt     DateTime @default(now())

  @@index([accountId, id])
  @@index([transactionId])
}
```

实际 schema 必须给 `transactionId`、`accountId`、`assetCode` 加 FK/@relation，并增加 `CHECK(amount_atomic > 0)`；`side` 使用 enum。部分退款应优先以独立 `RefundIntent.id` 作为 `sourceId`，`sequence` 只用于同一业务源确有多笔同类合法交易的场景，不能由客户端任意指定。

数据库必须通过延迟约束、受控 posting 存储过程或事务末尾的强校验保证每个 `transactionId + assetCode` 借贷相等；只依赖应用层单元测试不够。应用角色不得直接 `INSERT LedgerEntry` 或把 transaction 改为 posted，只能调用 posting 接口。数据库触发器拒绝对 posted transaction/entry 的 `UPDATE/DELETE`；纠错只允许写 `reversalOfId` 反向交易。

#### EntitlementLot / ConsumptionAllocation

```prisma
model EntitlementLot {
  id                String   @id
  userId            Int
  assetCode         String   // RP or VC
  originType        String   // checkin | invite | admin | purchase | refund
  originId          String
  grantedAtomic     BigInt
  remainingAtomic   BigInt
  valuePolicyId     String
  expiresAt         DateTime?
  createdAt         DateTime @default(now())
}

model ConsumptionAllocation {
  id             String @id
  orderId        Int
  lotId          String
  amountAtomic   BigInt
  refundRemainingAtomic BigInt

  @@unique([orderId, lotId])
}
```

消费顺序：先用即将到期的 `RP`，再用无到期 `RP`，最后用 `VC`；同类按 `expiresAt NULLS LAST, createdAt, id`。退款严格按 `ConsumptionAllocation` 反向恢复原 lot。

#### OrderPricingSnapshot

```prisma
model OrderPricingSnapshot {
  orderId                  Int    @id
  pointsAssetCode          String
  pointsAmountAtomic       BigInt
  valuePolicyId            String
  referenceAssetCode       String
  referenceAmountAtomic    BigInt
  paymentAssetCode         String?
  paymentAmountAtomic      BigInt?
  fxQuoteId                String?
  feeAmountAtomic          BigInt?
  roundingAdjustmentAtomic BigInt @default(0)
  commissionPolicyVersion  Int
}
```

#### PaymentIntent / PaymentEvent / SettlementV2 / Payout

外部支付与出款必须独立于 `Order` 和 `Settlement`：

- `PaymentIntent`：请求支付、金额、资产、provider、状态、幂等键；
- `PaymentEvent`：保存 provider event ID、签名验证结果、原始 payload 哈希和处理状态；数据库唯一约束为 `@@unique([provider, providerEventId])`；
- `RefundIntent`：可部分退款，关联原 payment 与账本反向交易；
- `Payout`：商家、结算资产、网络/银行目标、费用、provider ID、confirmations；
- `ReconciliationRecord`：内部账本与 provider/银行/链上记录的逐笔差异。

`Settlement.status='settled'` 不能继续同时表示“商家积分已入账”和“外部资金已到账”。目标状态定义见第 9 节。

真实出款阶段至少新增以下字段/关系，不能把它们塞回现有积分 `Settlement`：

```prisma
model SettlementV2 {
  id                       String   @id
  orderId                  Int      @unique
  merchantId               Int
  status                   String
  referenceAssetCode       String
  grossAmountAtomic        BigInt
  commissionAmountAtomic   BigInt
  payableAmountAtomic      BigInt
  valuePolicyId            String
  commissionPolicyVersion  Int
  payableAt                DateTime?
  reversedAmountAtomic     BigInt  @default(0)
  createdAt                DateTime @default(now())
}

model Payout {
  id                     String   @id
  merchantId             Int
  settlementAssetCode    String
  amountAtomic           BigInt
  feeAmountAtomic        BigInt  @default(0)
  provider               String
  providerPayoutId       String?
  destinationFingerprint String
  status                 String
  confirmationRef        String?
  submittedAt            DateTime?
  confirmedAt            DateTime?
  failureCode            String?
  idempotencyKey         String   @unique
  createdAt              DateTime @default(now())

  @@unique([provider, providerPayoutId])
}

model PayoutAllocation {
  payoutId     String
  settlementId String
  amountAtomic BigInt

  @@id([payoutId, settlementId])
}
```

所有状态字段仍需 enum/CHECK；所有金额需 `> 0` 或按字段语义 `>= 0` 的 CHECK；外键、资产一致性和 allocation 合计由 migration 约束/事务校验补齐。

### 7.3 典型分录

| 场景 | 借方 | 贷方 | 说明 |
| --- | --- | --- | --- |
| 发放 500 RP | 平台 RP 已发行 500 | 用户 RP available 500 | 同时按规则增加 XP；XP 是独立交易 |
| 人工订单冻结 300 RP | 用户 RP available 300 | 用户 RP frozen 300 | 总权益不变 |
| 人工订单释放 | 用户 RP frozen 300 | 用户 RP available 300 | 原交易的业务反向，不增加 XP |
| 订单核销 | 用户 RP/VC 负债账户 | 平台已核销积分/额度账户 | 具体 lot 写 allocation |
| 退款 | 平台已核销账户 | 原用户 lot/账户 | 关联原订单与原分录 |
| 商家应付确认 | 订单结算清算账户 | 商家 payable（本位币） | 仅真实出款阶段启用；按订单 `valuePolicyId` 将积分参考值转成本位币分录 |

首期/P1 的现有 Settlement 仍以积分为单位，参考价值只用于展示与报表，不形成法币商家应付。进入真实出款阶段时，`SettlementV2` 使用订单快照中的 `referenceAmountAtomic` 计算 gross/commission/payable；跨资产实际出款另绑定 FX quote 和 Payout，不修改原应付金额。积分操作账与法定财务总账是两个层次。运营账本需产生可映射的会计事件，但最终 GL 科目、收入确认、税费和 breakage 处理由财务政策决定。

## 8. 积分、成长值与会员体系

### 8.1 必须拆分的计量口径

| 行为 | RP 余额 | VC 余额 | XP | 排行榜 | 财务义务 |
| --- | ---: | ---: | ---: | ---: | --- |
| 签到/邀请奖励 | 增 | 0 | 增 | 计入 | 促销权益/待履约分析 |
| 用户购买额度 | 0 | 增 | **0** | **不计入** | 预收/合同负债候选 |
| 管理员补偿 | 按原因 | 按原因 | 默认 0 | 默认不计 | 必须有审批与原因码 |
| 退款 | 恢复原桶 | 恢复原桶 | 0 | 不计 | 反向原交易 |
| 消费/冻结/释放 | 减/转移 | 减/转移 | 0 | 不计 | 按履约状态处理 |

现有 `PointLog.type='in'` 不能继续作为 XP 与排行榜的唯一判定。目标事件必须有：

```ts
origin: 'earned_reward' | 'purchased_value' | 'refund' | 'compensation' | 'migration'
xpEligible: boolean
leaderboardEligible: boolean
```

资格由服务端原因码策略决定，管理员不能在普通发放表单中任意勾选。

### 8.2 到期与 breakage

- 首期所有既有积分继续不设到期日，避免迁移时削减用户权益。
- 新奖励积分如需到期，必须在发放前展示条款并保存 lot 到期日。
- 购买型 VC 默认不得到期；任何到期策略必须先过法律与财务审查。
- 过期不是删除余额，而是写 `expiration` 账本交易。
- 对预计不核销余额的收入确认不得在收款时直接完成；应由财务依据适用会计准则和可靠历史数据制定 breakage 政策。

## 9. 订单、退款与结算状态机

### 9.1 结算预览与确认

```text
GET /checkout/preview
  └─ 返回 points price + reference value + policy version
     └─ 若选择外部支付：返回 fxQuote + expiresAt + fees

POST /orders
  ├─ Idempotency-Key
  ├─ expectedPointsPrice
  ├─ expectedValuePolicyId
  └─ fxQuoteId? / paymentIntentId?
```

确认时任一字段变化均返回 409，禁止静默使用新价格、新面值或新汇率。

### 9.2 资金动作矩阵

| 订单/动作 | RP/VC | Ledger code | Settlement | 外部支付 |
| --- | --- | --- | --- | --- |
| instant 创建 | 立即核销 | `order_capture` | `accruing` | 若有则须先确认已入账 |
| manual_service 创建 | available→frozen | `order_hold` | `holding` | 资金可先授权/收取，策略需固定 |
| manual_service 完成 | frozen→核销 | `order_capture_held` | `accruing` | 不重复扣款 |
| 拒单/取消 | frozen→available | `order_release` | `voided` | 未捕获则取消；已收取则退款 |
| 全额退款 | 恢复原 lot | `order_refund_full` | `voided/reversing` | 建 RefundIntent 并对账 |
| 部分退款 | 按 allocation 恢复 | `order_refund_partial` | `partially_reversed` | 每次退款有独立幂等键 |

### 9.3 Settlement 与 Payout 分离

目标 Settlement 状态：

```text
holding -> accruing -> payable -> payout_pending -> paid
              └────> voided
payable/payout_pending -> reversing -> reversed
payout_pending -> payout_failed -> payable
```

- `payable`：业务履约完成、退款窗口/争议策略满足，可进入出款；
- `payout_pending`：已向 provider 提交但尚未确认；
- `paid`：provider/链上确认且已通过对账；
- `voided`：从未形成应付；
- `reversed`：已形成应付后因退款/拒付完成反向处理。

批量出款不沿用“任一失败则所有外部转账回滚”的假设，因为外部系统无法参加数据库事务。正确做法是：批次在本地原子冻结候选项，每笔独立提交并记录结果，批次汇总允许 `partial_failure`，失败项可安全重试。

## 10. API 契约

### 10.1 价值政策

新增 API：`GET /api/value-policy/current`

```json
{
  "id": "vp_2026_01",
  "version": 1,
  "referenceAsset": { "code": "CNY", "scale": 2 },
  "points": { "code": "RP", "perMajorUnit": "100" },
  "effectiveAt": "2026-09-01T00:00:00+08:00",
  "disclosure": "积分为平台内部权益，所示金额仅为参考价值，不代表现金赎回承诺。"
}
```

### 10.2 结算预览

扩展现有 API：`GET /api/checkout/preview?productId=...&offerId=...&paymentAsset=...`

```json
{
  "price": {
    "points": { "assetCode": "RP", "amountAtomic": "1200", "scale": 0 },
    "reference": { "assetCode": "CNY", "amountAtomic": "1200", "scale": 2 },
    "valuePolicyId": "vp_2026_01"
  },
  "balance": {
    "rewardPoints": "800",
    "valueCredits": "500",
    "spendableTotal": "1300",
    "after": "100"
  },
  "allocationPreview": [
    { "assetCode": "RP", "amountAtomic": "800" },
    { "assetCode": "VC", "amountAtomic": "400" }
  ],
  "paymentQuote": null,
  "chargeType": "debit",
  "sufficient": true
}
```

金额字段禁止返回 JSON number。旧版 `price: number` 在兼容期保留，但服务端同时返回 `Deprecation`/`Sunset` 头和新结构。

### 10.3 历史流水

新增 API：`GET /api/wallet/transactions` 返回交易而不是裸 entry：

```json
{
  "id": "ltx_...",
  "code": "order_refund_full",
  "status": "posted",
  "occurredAt": "2026-08-17T08:00:00Z",
  "changes": [
    { "bucket": "reward_points", "amountAtomic": "200", "direction": "credit" },
    { "bucket": "value_credits", "amountAtomic": "100", "direction": "credit" }
  ],
  "referenceValue": { "assetCode": "CNY", "amountAtomic": "300", "scale": 2 },
  "orderId": 123
}
```

### 10.4 新错误码

| HTTP | code | 含义 |
| ---: | --- | --- |
| 409 | `VALUE_POLICY_CHANGED` | 积分面值政策变化，需重新确认 |
| 409 | `QUOTE_EXPIRED` | 报价过期 |
| 409 | `QUOTE_ALREADY_CONSUMED` | 报价已用于其他确认 |
| 409 | `IDEMPOTENCY_CONFLICT` | 相同键对应不同请求指纹 |
| 400 | `ASSET_NETWORK_MISMATCH` | 稳定币网络/合约不匹配 |
| 422 | `INSUFFICIENT_SPENDABLE_BALANCE` | 分桶后总可用余额不足 |
| 503 | `PAYMENT_PROVIDER_UNAVAILABLE` | 支付服务不可用，未入账 |
| 503 | `FX_QUOTE_UNAVAILABLE` | 无可靠报价，禁止猜测成交 |

## 11. 前端体验

### 11.1 首期展示

- 商品卡：`1,200 积分`，副文案 `参考价值 ¥12.00`。
- 结算确认：同时显示积分、参考价值、扣前/扣后余额和“积分为平台内部权益，不可提现”。
- 个人中心：主余额仍显示积分；增加“参考价值”但不使用“现金余额”“资产”“可提现”等词。
- 流水：明确区分“奖励获得、购买额度、冻结、支付、释放、退款、过期、迁移”。
- 商家后台：首期仍以积分结算，但同时展示订单参考价值；未启用真实出款前不得显示“已到账 CNY”或“已到账 USDT”。

### 11.2 未来购买型额度

余额卡拆为：

```text
可消费合计  1,300
├─ 奖励积分    800  （不可提现）
└─ 价值额度    500  （由充值获得）
```

“余额不足”提供“赚积分”和“充值额度”两条路径，但充值入口受 feature flag、地区、KYC/风控和支付渠道可用性控制。

### 11.3 格式化

建立统一函数：

- `formatPoints(amountAtomic)`；
- `formatMoney(assetCode, amountAtomic, locale)`，基于 `Intl.NumberFormat`；
- `formatCrypto(assetCode, amountAtomic, scale, network)`；
- `formatRate(quote)`。

禁止组件自行拼接 `+${amount}`、货币符号或固定两位小数。无论 UI 还是导出，都以服务端资产定义为权威。

## 12. 安全、风控、合规与会计门禁

### 12.1 首期保持的产品边界

- 闭环使用，仅购买 MoNexus 内商品/服务；
- 不允许 P2P 转账、交易或场外兑换；
- 不承诺现金赎回；
- 不允许商家自行发行积分；
- 管理员调账必须双人审批、原因码、附件和审计日志；
- 限制单次、单日、单月发放与消费，异常速度触发冻结/复核。

### 12.2 启用真实充值前的硬门禁

| 门禁 | 最低要求 |
| --- | --- |
| 法务 | 确认闭环储值/预付卡/支付工具分类、消费者条款、退款、有效期、地域限制。 |
| 财务 | 确认预收款、履约、退款、breakage、税费、商家应付和 FX 损益政策。 |
| 资金 | 独立清算/存管方案、每日余额证明、provider 结算周期和资金缺口上限。 |
| KYC/AML | 根据产品属性和额度确定身份、制裁、交易监控、可疑活动与记录保存要求。 |
| 安全 | PSP 托管支付页/令牌化，最小化卡数据范围；webhook 签名、重放保护、密钥轮换。 |
| 运营 | 退款、拒付、误充、未到账、对账差异和 provider 故障 SOP。 |

中国大陆的单用途商业预付卡规则包含备案、购卡/充值条款、实名与资金管理要求；美国 FinCEN 对部分 prepaid access provider/seller 规定注册、AML、客户与交易信息义务，同时存在特定闭环和低风险豁免。是否适用取决于运营主体、行业、额度、可充值/转让/跨境等具体特征，不能仅凭“积分”命名规避。

### 12.3 USDT 专项门禁

- 只支持一个经过批准的首发网络；新增网络视同新增支付渠道，单独评审。
- 配置链 ID、官方合约地址、精度、最小确认数、最小充值/出款额和网络费策略。
- 使用合格托管/支付合作方优先于平台自管私钥；若自管，必须 HSM/MPC、冷热分离、限额与多人审批。
- 充值地址、memo/tag、链重组、错链转入、合约冻结、制裁地址、dust 与网络拥堵均需 SOP。
- 计价本位仍为已选定的单一法币（USD 或 CNY）；每笔 USDT 交易保存市场报价和脱锚保护阈值。
- 若 USDT/USD 偏离阈值、报价源分歧或流动性不足，自动暂停而非按 1:1 硬成交。

### 12.4 会计原则

IFRS 15/ASC 606 对礼品卡、未行使权利和忠诚计划的核心思路是：收款时尚未履约，通常先体现合同负债；预计 breakage 需要按权利行使模式或在极不可能要求履约时确认，而不是收到现金就立即确认为收入。MoNexus 必须把 operational ledger 事件映射给适用会计政策，不在业务代码里硬编码收入确认。

## 13. 外部支付可靠性

### 13.1 幂等与事件收件箱

- 客户端 mutation 必须携带高熵 `Idempotency-Key`；同键同指纹返回首次结果，同键不同指纹报冲突。
- provider event ID 唯一；webhook 原始 body 验签后先写 `PaymentEvent`，再异步处理。
- 任一 handler 可安全重放；账本唯一约束是最终防线。
- 处理状态为 `received -> verified -> processing -> applied/ignored/failed`，失败保留原因与重试次数。

### 13.2 Outbox

订单/账本事务内只写 outbox，不直接依赖外部网络。worker 用 lease/claim 原子领取，发送后保存 provider request/response 哈希。超时状态未知时先查询 provider，不盲目重发出款。

### 13.3 对账

至少每日执行：

```text
provider/银行/链上明细
        ↕ 逐笔匹配（provider ID、金额、资产、时间窗）
内部 Payment/Payout/Ledger
        ↓
matched / missing_external / missing_internal / amount_mismatch / asset_mismatch
```

任何差异不得自动用管理员加减积分“抹平”；必须创建对账 case、分配责任人、记录修复分录和审批链。

## 14. 配置与治理

### 14.1 不可变配置

以下配置必须版本化：

- 本位币、积分面值；
- 资产精度、网络与合约地址；
- 佣金与舍入政策；
- 消费分配顺序；
- 退款原路规则；
- FX 来源、点差、TTL、脱锚阈值；
- 充值/出款限额和风控门槛。

### 14.2 审批

价值政策状态只能：

```text
draft -> approved -> scheduled -> active -> retired
```

- 创建人与审批人不得相同；
- `active` 后不可编辑；
- 同一时刻同一积分资产只能有一个 active policy；
- 生效至少提前 7 天（紧急修复除外），并生成影响报告；
- 禁止让后台管理员直接修改“100积分=1元”并立即影响存量订单。

## 15. 迁移方案

### 15.1 原则

- 先加表与双写，再切读，最后下线旧模型；
- 不把未知历史价值伪造为某个法币金额；
- 所有迁移可重复、可校验、可中断续跑；
- 迁移前后用户 `balance/frozenBalance` 与订单资金状态完全一致。

### 15.2 阶段

#### M0：数据审计与政策冻结

1. 导出账户总余额、冻结总额、PointLog 总额、订单/Settlement 状态分布；
2. 查找负余额、孤儿日志、重复订单资金动作、已 settled 又 refunded 等异常；
3. 用生产价格与奖励数据模拟候选面值；
4. 决策委员会批准本位币、面值、披露文案和首期边界。

#### M1：影子账本

1. 新增资产、价值政策、ledger、lot、pricing snapshot 表；
2. 为每个用户创建 `RP available/frozen` 账户；
3. 以一个 `migration_opening_balance` 交易导入当前余额，并保存源快照哈希；
4. 历史 PointLog 保留只读，不逐条改写；新账本 transaction 可链接旧日志 ID；
5. 每个用户创建一个 `MIGRATION_UNKNOWN` RP available lot；由于旧系统没有资金来源分桶，所有存量统一按 RP 处理；
6. 对 `fundsHeld=true` 的 holding 订单，按 `Order.holdingPoints` 创建独立 synthetic frozen lot 与 allocation；无法对应订单的剩余 frozen 进入 `LEGACY_FROZEN_UNALLOCATED` 隔离账户，禁止自动核销/退款，必须在切流前人工处置；
7. 平台对手账户写与 opening balance 等额的分录，保证每种资产每笔交易平衡。

#### M2：双写与比对

1. 现有 service 在同一数据库事务中写旧表与新 ledger/outbox；任一侧写入失败则整个业务事务回滚，禁止“先旧后新”异步补偿；
2. 旧 API 继续读 `PointAccount/PointLog`；新投影影子运行；
3. 每 5 分钟比较用户余额、冻结额、订单资金状态与 Settlement 聚合；
4. 任一差异自动停止**读流量切换**并告警；不自动中断已经过验证的旧链路写入。若 ledger posting 本身异常，则关闭 mutation feature flag、保留只读并按 runbook 恢复；
5. M0 发现的异常先写入 remediation case，经批准的修复分录/旧表修复完成且重跑审计通过后，才允许进入 M3。

#### M3：订单价值快照

- 新订单保存 active `valuePolicyId` 与精确 reference amount；
- 历史订单若能由明确生效政策推导则标记 `MIGRATED_POLICY`；
- 无可靠政策的历史订单标记 `LEGACY_UNVALUED`，UI 显示“历史订单无参考价值”，禁止回填假汇率。

#### M4：切读与兼容

1. 1% 内部用户 → 10% → 50% → 100% 读取新投影；
2. 每档至少覆盖一个退款、人工冻结/释放、cron close 和批量结算周期；
3. 旧 `PointLog` 变为兼容投影，停止作为权威账本；
4. 在 M5 之前可把**读取**切回旧投影；写入始终维持同事务双写，不回滚已 posted ledger entries；
5. M5 开始产生 VC/XP 或新状态后为不可逆语义切换：禁止恢复旧写模型。故障时关闭新 feature、保持只读或 forward-fix；不得把新账本强行压回 `PointLog` 五种旧类型。

#### M5：语义拆分

- 新奖励写 RP 与 XP 两笔关联交易；
- 购买型 VC feature flag 仍为 off；
- 排行榜改读 XP 或 `leaderboardEligible` 事件；
- 商家 PointAccount 不再作为未来真实出款账户。

### 15.3 迁移验算

```text
Σ legacy balance        = Σ new RP available
Σ legacy frozenBalance  = Σ new RP frozen
每个用户 legacy balance/frozen = 新投影对应余额
每个 holding 订单的 holdingPoints = 对应冻结 allocation
每个历史 settled/refunded 订单最多一个权威资金终态
每种资产每笔交易借方 = 贷方
```

验算报告保存到对象存储并记录 SHA-256、生成时间、代码版本、数据库快照 ID 和审批人。

## 16. 分阶段交付

| 阶段 | 内容 | 合规风险 | 出口条件 |
| --- | --- | --- | --- |
| P0 | 政策决策、数据审计、UI 参考价值 | 低 | 面值获批；披露文案获批 |
| P1 | 不可变 ledger、lot、pricing snapshot、双写迁移 | 低 | 30 天零未解释差异；并发/退款测试通过 |
| P2 | XP/排行榜拆分、商家应付模型 | 中 | 财务映射与 Settlement 状态获批 |
| P3 | 用户购买型 VC，单一法币支付渠道 | 高 | 法务/财务/资金/KYC/安全/运营六门禁通过 |
| P4 | 商家法币出款 | 高 | provider 对账与失败重试演练通过 |
| P5 | 单网络 USDT 可行性验证与独立上线决策；默认不启用 | 很高 | 稳定币专项法律意见、牌照/合作模式、托管和链上 SOP 通过后另批 |

任何后续阶段不得为了进度跳过前一阶段的对账与合规出口条件。

## 17. 测试与验收

### 17.1 单元/属性测试

- 任意合法交易生成的每种资产借贷和为零；
- 任意冻结后释放，用户总权益不变；
- 任意消费后全额退款，所有 lot 恢复到消费前状态；
- 随机金额/汇率/精度下只产生定义内舍入，且误差进入 rounding account；
- 超过 JS safe integer 的金额仍能精确往返 API/DB；
- policy/commission/fx quote 快照重放得到相同结果。

### 17.2 并发与故障注入

- 同余额 100 并发下单不能超支；
- 同幂等键 100 次只产生一笔订单、一笔 ledger transaction；
- 相同 provider event 并发投递 100 次只入账一次；
- DB commit 成功但 HTTP 超时后重试返回同一结果；
- provider 超时、500、乱序 webhook、重复 webhook、延迟退款均不重复记账；
- outbox worker 崩溃恢复后不重复出款；
- 链重组/确认数下降时不提前记为最终到账。

### 17.3 迁移验收

- 全量账户逐户相等，聚合相等；
- 不存在负 available/frozen；
- 所有新订单都有 pricing snapshot；
- 历史未知价值明确标记，不伪造；
- 双写 30 天差异为 0，或所有差异有已批准的解释与修复分录。

### 17.4 产品验收

| ID | 验收标准 |
| --- | --- |
| AC-01 | P0：同一 offer 的商品卡、详情、checkout preview、创建结果与订单详情断言相同 `points.amountAtomic`、`reference.amountAtomic`、`valuePolicyId`。 |
| AC-02 | P0：提交过期/非 active `valuePolicyId` 或 FX quote 时分别返回 `VALUE_POLICY_CHANGED`/`QUOTE_EXPIRED`，且订单数、ledger entry 数均不变。 |
| AC-03 | P3（VC feature flag）：充值只增加 VC，XP 与排行榜快照前后相等；API/UI 分别展示 RP、VC 和 spendable total。 |
| AC-04 | P1：混合 RP/VC 订单全额与部分退款后，逐个 `ConsumptionAllocation.refundRemainingAtomic` 和原 lot 余额精确匹配，XP 不变。 |
| AC-05 | P4：商家后台依据状态枚举展示 payable/payout_pending/paid/payout_failed/reversed；只有 provider 确认且对账 matched 才显示 paid。 |
| AC-06 | P5：所有 USDT 报价、地址、确认和历史记录均断言 asset code、network、contract fingerprint；缺任一字段拒绝提交。 |
| AC-07 | 兼容期：旧字段至少保留两个已发布客户端版本且不少于 90 天；Sunset 日期通过响应头公告，Sunset 后旧 mutation 返回 426 `CLIENT_UPGRADE_REQUIRED`。 |

## 18. 可观测性与告警

### 18.1 指标

- `ledger_unbalanced_transaction_total`（必须恒为 0）；
- `balance_projection_mismatch_total`；
- `payment_event_duplicate_total`；
- `payment_event_processing_lag_seconds`；
- `reconciliation_difference_total{type,asset}`；
- `fx_quote_expired_total`、`fx_source_divergence_bps`；
- `payout_pending_age_seconds`、`payout_failure_total`；
- `stablecoin_depeg_bps`、`chain_confirmation_lag`；
- 各资产用户负债、商家应付、provider clearing 与储备覆盖率。

### 18.2 P0 告警

- 不平账或投影差异：立即 P0，暂停所有写入；
- 重复外部出款：立即 P0，暂停出款渠道；
- 储备/清算覆盖不足：立即 P0，暂停充值与出款；
- USDT 脱锚或报价源分歧超过政策阈值：立即暂停 USDT 报价；
- 对账差异超过 24 小时未解决：升级财务与技术负责人。

## 19. 风险登记

| 风险 | 概率/影响 | 缓解 |
| --- | --- | --- |
| 用户把参考价值理解为提现承诺 | 中/高 | 明确披露；不用“现金余额”；首期不可赎回 |
| 运营人员随意改面值 | 中/高 | 版本化政策、双人审批、未来生效、影响报告 |
| 充值污染等级/排行榜 | 高/中 | RP/VC/XP 分离；资格事件显式字段 |
| 退款进入错误分桶 | 中/高 | lot allocation；原交易反向；属性测试 |
| JavaScript number 精度丢失 | 中/高 | API string + DB BigInt/NUMERIC + decimal 库 |
| 外部回调重复或乱序 | 高/高 | inbox、唯一事件 ID、幂等 ledger、状态机 |
| Settlement 把“已请求”误当“到账” | 中/高 | Settlement/Payout 分离；provider 确认 + 对账 |
| USDT 错链、冻结或脱锚 | 中/很高 | 单网络白名单、托管优先、阈值暂停、人工隔离 |
| 预付价值监管属性变化 | 中/很高 | 分阶段 feature flag；上线前书面法律意见 |
| breakage 过早确认收入 | 中/高 | 财务政策与历史数据；operational ledger 不硬编码收入 |

## 20. 待决策事项

| ID | 决策 | 推荐 | 截止点 |
| --- | --- | --- | --- |
| D-01 | 价值本位币 | **已决定：首个生产租户选择 CNY（2026-08-17）**；USD/USDT 不得作为首期生产本位币 | 已关闭 |
| D-02 | 固定面值 | 100 PTS = 1 本位币主单位，待真实数据回测 | M1 schema 前 |
| D-03 | 参考价值文案 | “参考价值，不代表现金赎回承诺” | UI 开发前 |
| D-04 | RP 是否设置新发放到期 | 首期不设置 | P1 前 |
| D-05 | 新佣金舍入规则 | legacy 继续 FLOOR；新版本评估 HALF_EVEN | P2 前 |
| D-06 | VC 是否启用 | 首期禁用 | P3 合规门禁后 |
| D-07 | 首个真实支付资产/渠道 | 单一法币、单 provider | P3 设计前 |
| D-08 | 首个 USDT 网络 | 不预设；完成风险与成本评审后只选一个 | P5 前 |

D-01 已批准。D-02 未批准前，可以开发 CNY 价值政策、账本和订单快照的通用结构，并使用测试夹具验证候选比例；不得在生产环境激活具体积分面值，也不得向用户展示确定的 CNY 等值。

## 21. 外部依据与时效

以下页面均于 **2026-08-17** 抓取核验；法规与会计适用性仍需按上线时间和运营主体复核。

1. [ISO 4217 — Currency codes](https://www.iso.org/iso-4217-currency-codes.html)：ISO 4217 记录币种代码及主单位与最小单位关系；页面说明有的币种分为 100 或 1000 个最小单位。
2. [Stripe Supported currencies](https://docs.stripe.com/currencies)：支付 API 以币种最小单位接收整数金额，并列出零小数币种及付款/出款特殊情况。
3. [Stripe Idempotent requests](https://docs.stripe.com/api/idempotent_requests)：同幂等键保存首次结果，重试返回同一结果，并校验参数避免键被误用。
4. [Deloitte DART — Customers’ Unexercised Rights / Breakage](https://dart.deloitte.com/USDART/home/codification/revenue/asc606-10/roadmap-revenue-recognition/chapter-8-step-5-determine-when/8-8-customers-unexercised-rights-breakage)：汇总 ASC 606/IFRS 15 对未行使权利与 breakage 的实施指导。
5. [SEC filing — Gift cards and loyalty reward program](https://www.sec.gov/Archives/edgar/data/1132105/000155837018009494/R16.htm)：公开披露示例将礼品卡和忠诚计划余额列作合同负债，并按预期使用模式确认 breakage。
6. [商务部《单用途商业预付卡管理办法（试行）》](https://www.mofcom.gov.cn/zfxxgk/zc/gz/art/2021/art_82805c1937a64a4186ea15c23fc675c5.html)：2012 年公布、2016 年修订，包含备案、章程/协议、实名、限额与资金管理要求。
7. [FinCEN Issues Prepaid Access Final Rule](https://www.fincen.gov/news/news-releases/fincen-issues-prepaid-access-final-rule)：2011-07-26 发布；对特定 prepaid access provider/seller 建立注册、AML 及客户/交易信息要求，并说明部分闭环产品豁免条件。
8. [Tether Supported Protocols and Integration Guidelines](https://tether.to/en/supported-protocols/)：要求集成方明确支持哪些协议，并列出已停止发行或不再承担赎回义务的旧协议。
9. [Tether — How to redeem tokens to fiat](https://tether.to/ru/redeem-tethers-to-fiat-currency/)：直接赎回需要验证账户；抓取时页面列出的最低赎回额为 100,000 美元等值。
10. [CFTC Orders Tether and Bitfinex to Pay Fines](https://www.cftc.gov/PressRoom/PressReleases/8450-21)：2021-10-15，CFTC 就历史储备陈述问题对 Tether 处以 4,100 万美元罚款，说明稳定币仍有发行方与披露风险。

## 22. 仓库内依据

- [项目边界与整数积分](../../README.md)
- [商品模型与结算链路总纲](./product-model-and-checkout.md)
- [积分排行榜口径](./points-leaderboard.md)
- [商家与结算契约](../superpowers/specs/2026-04-29-monexus-merchant-settlement-contract.md)
- `server/prisma/schema.prisma`
- `server/src/modules/orders/accounting.ts`
- `server/src/modules/orders/service.ts`
- `server/src/modules/points/service.ts`
- `server/src/modules/admin/service.ts`
- `src/components/PurchaseModal.tsx`
- `src/components/PointsHistorySheet.tsx`

## 23. 完成定义

本 spec 进入 `Approved` 前必须满足：

1. D-01 的决定已记录；D-02 至 D-05 有具名决策人与日期；
2. 财务确认积分面值、商家结算和 breakage 的会计映射；
3. 法务确认首期“参考价值”文案不形成赎回或储备承诺；
4. 技术完成 schema spike，证明 BigInt/NUMERIC、延迟平衡校验和现有 Prisma 事务兼容；
5. 数据回测证明候选面值下商品价格、奖励预算和用户余额分布合理；
6. 迁移演练在生产快照的脱敏副本上通过全部验算；
7. P0/P1 的测试、指标、告警与回滚 runbook 已拆成实现计划。
