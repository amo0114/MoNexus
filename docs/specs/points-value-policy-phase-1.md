# Spec：CNY 价值政策与订单定价快照（Phase 1）

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-VALUE-POLICY-P1-001 |
| 版本 | 1.0.0 |
| 日期 | 2026-08-18 |
| 状态 | Implemented — Production Activation Blocked by D-02/D-03 |
| 上位规格 | `SPEC-VALUE-LEDGER-001 v0.2.0` |
| 代码基线 | `origin/develop@c6d21bb`（PR #144 squash merge） |
| Closure 分支 | `feat/cny-value-policy-phase-1-closure` |
| 首个生产本位币 | `CNY`（D-01 已批准） |
| 生产积分面值 | 未批准（D-02 待真实数据回测） |
| 实施范围 | 后端价值政策、精确换算、checkout preview、订单定价快照及测试 |

> 本文是第一份可直接交给实施 Agent 的执行规格。Agent 不得自行决定生产积分面值、启用真实支付，或把 CNY、USD、USDT 视为等价资产。

## 0. 已冻结决策

### 0.1 已批准

| ID | 决策 | 结论 |
| --- | --- | --- |
| D-01 | 首个生产租户的价值本位币 | `CNY`，批准日期 2026-08-17 |
| P1-D01 | 首期产品边界 | 仅展示参考价值；积分仍不可购买、转让、提现或现金赎回 |
| P1-D02 | 数据表达 | 真实货币使用整数原子单位；API 金额使用十进制字符串 |
| P1-D03 | 历史一致性 | 订单确认时保存政策与参考价值快照；历史订单不得按新政策重算 |
| P1-D04 | 兼容策略 | 保留现有 `price: number` 与旧积分扣减链路；新增字段采用加法式兼容 |

### 0.2 仍待批准

| ID | 决策 | 当前候选 | 对实施的影响 |
| --- | --- | --- | --- |
| D-02 | 生产积分面值 | `100 PTS = 1 CNY` | 只可用于测试夹具和数据回测；不得创建生产 active policy |
| D-03 | 用户披露文案 | “参考价值，不代表现金赎回承诺” | API 可预留字段；生产展示前需批准 |

Phase 1 工程实现已完成，但生产激活必须等待 D-02 与 D-03。任何 Agent 都不得把候选比例写成代码常量、默认配置或不可撤销的生产 seed。

这不是 `SPEC-VALUE-LEDGER-001` 的大 Phase 1（ledger / lot / 双写）。账本规格后续阶段仍未实施。

## 1. 目标

本阶段建立一个最小、可审计且向后兼容的 CNY 价值政策基础，使系统能够：

1. 用不可变、版本化的 `ValuePolicy` 表达积分和 CNY 的固定关系；
2. 使用 BigInt 有理数完成积分到 CNY 原子单位的确定性换算；
3. 在 checkout preview 返回积分价格、CNY 参考价值和政策 ID；
4. 在订单确认事务内重新解析政策、校验客户端政策 ID，并保存定价快照；
5. 保证后续政策变化不会改变既有订单的参考价值；
6. 在功能关闭时保持当前积分、订单、Settlement 和前端契约不变。

## 2. 非目标

本阶段明确不实施：

- 新双重记账 ledger、lot、RP/VC/XP 拆分；
- CNY、USD 或 USDT 充值与真实付款；
- 实时 FX 服务或 `FxQuote` 数据表；
- 用户转账、提现、现金赎回；
- 商家法币或稳定币出款；
- 修改当前 `PointAccount`、`PointLog` 的权威写入语义；
- 修改会员成长、排行榜或商家 Settlement 计算；
- 多租户模型。README 已明确 multi-tenant white-label SaaS 不在当前产品边界内；本阶段按单一平台作用域实现。

## 3. 当前代码事实与修改边界

| 当前事实 | 位置 | 本阶段处理 |
| --- | --- | --- |
| 可用/冻结积分为 `PointAccount.balance/frozenBalance Int` | `server/prisma/schema.prisma` | 不修改其权威语义 |
| SKU 价格为 `Offer.price Int` | `server/prisma/schema.prisma` | 继续作为积分价格来源 |
| checkout preview 返回 `price: number` | `server/src/modules/checkout/service.ts` | 保留并新增 `pricing` 对象 |
| 创建订单校验 `expectedPrice` | `server/src/modules/orders/schema.ts`、`service.ts` | 新增 `expectedValuePolicyId` 校验 |
| 订单已保存商品、Offer 与履约快照 | `Order` | 新增一对一 `OrderPricingSnapshot` |
| 当前佣金使用 `Math.floor` | `server/src/modules/orders/service.ts` | 本阶段不改变 |
| 项目使用 Prisma 6、PostgreSQL、TypeScript、Vitest | `server/package.json` | 沿用现有技术栈 |

Agent 应先阅读上述文件及相邻测试，但不得借本任务进行无关重构。

## 4. 总体流程

```text
GET /api/checkout/preview
  -> 读取 Offer.price
  -> 解析当前 active CNY ValuePolicy
  -> BigInt 有理数换算
  -> 返回 legacy price + 新 pricing 对象

POST /api/orders
  -> 进入现有订单事务
  -> 重新解析 Offer 与 active CNY ValuePolicy
  -> 校验 expectedPrice 和 expectedValuePolicyId
  -> 使用同一换算函数计算参考价值
  -> 创建 Order
  -> 在同一事务创建 OrderPricingSnapshot
  -> 继续现有积分扣减、库存、Settlement 和 outbox 流程
```

preview 只是只读报价。订单事务中的重新解析和快照才是权威结果。

## 5. 功能模式与上线安全

新增服务端配置：

```text
POINT_VALUE_POLICY_MODE=off | shadow | enforce
```

| 模式 | 行为 |
| --- | --- |
| `off` | 默认值。完全保持旧行为；不要求 active policy，不返回新 pricing，不写 pricing snapshot。 |
| `shadow` | 要求 active CNY policy；返回并保存新定价数据，但 `expectedValuePolicyId` 暂为可选。若客户端传入则必须校验。 |
| `enforce` | 要求 active CNY policy；创建订单必须携带 `expectedValuePolicyId`，不一致或缺失均拒绝。 |

约束：

- 生产默认必须是 `off`；D-02 批准前不得切到 `shadow` 或 `enforce`。
- 配置值必须在进程启动时验证；非法值启动失败。
- `shadow/enforce` 下无唯一 active CNY policy 时 fail closed，返回 `503 VALUE_POLICY_UNAVAILABLE`。
- 不得在请求失败时回退到猜测比例或最新历史政策。

## 6. 数据模型

以下是语义契约。实施 Agent 可以按照现有 Prisma 命名惯例调整 relation 字段，但不得改变字段含义、约束或原子性要求。

### 6.1 AssetDefinition

```prisma
enum AssetKind {
  reward_point
  fiat
}

model AssetDefinition {
  code      String    @id
  kind      AssetKind
  scale     Int
  enabled   Boolean   @default(false)
  createdAt DateTime  @default(now())
  retiredAt DateTime?
}
```

本阶段只需要支持：

| code | kind | scale | 生产用途 |
| --- | --- | ---: | --- |
| `RP` | `reward_point` | 0 | 现有奖励积分的价值表达 |
| `CNY` | `fiat` | 2 | 首个生产本位币 |

不得在本阶段创建 `USDT` 伪法币资产。USD 可以由通用 schema 支持，但不得创建或激活首期生产 USD 价值政策。

### 6.2 ValuePolicy

```prisma
enum ValuePolicyStatus {
  draft
  approved
  scheduled
  active
  retired
}

enum MoneyRoundingMode {
  HALF_EVEN
}

model ValuePolicy {
  id                                      String             @id
  version                                 Int                @unique
  pointAssetCode                          String
  referenceAssetCode                      String
  referenceAtomicPerPointNumerator        BigInt
  referenceAtomicPerPointDenominator      BigInt
  roundingMode                            MoneyRoundingMode  @default(HALF_EVEN)
  status                                  ValuePolicyStatus  @default(draft)
  effectiveAt                             DateTime
  approvedAt                              DateTime?
  activatedAt                             DateTime?
  retiredAt                               DateTime?
  createdAt                               DateTime           @default(now())

  pointAsset     AssetDefinition @relation("PolicyPointAsset", fields: [pointAssetCode], references: [code])
  referenceAsset AssetDefinition @relation("PolicyReferenceAsset", fields: [referenceAssetCode], references: [code])
}
```

数据库迁移必须补充 Prisma 无法完整表达的约束：

1. 分子和分母均 `> 0`；
2. `pointAssetCode` 必须指向 `reward_point`，`referenceAssetCode` 必须指向 `fiat`；
3. 同一平台、同一积分资产最多一个 `active` policy，使用 PostgreSQL partial unique index；
4. active policy 的 `referenceAssetCode` 在首期运行配置中必须是 `CNY`；
5. `active/retired` policy 的经济字段禁止更新；允许的状态与时间戳变化必须受控；
6. 生产应用角色不得直接把 draft policy 更新为 active；激活入口不属于本阶段公开 API。

候选 `100 PTS = 1 CNY` 的规范化表达是：

```text
referenceAtomicPerPointNumerator   = 1
referenceAtomicPerPointDenominator = 1
```

因为 CNY scale 为 2，所以一个积分对应一个“分”。这只是测试夹具，D-02 批准前不得作为生产 active policy seed。

### 6.3 OrderPricingSnapshot

```prisma
model OrderPricingSnapshot {
  orderId               Int      @id
  pointsAssetCode       String
  pointsAmountAtomic    BigInt
  valuePolicyId         String
  referenceAssetCode    String
  referenceAmountAtomic BigInt
  roundingMode          MoneyRoundingMode
  createdAt             DateTime @default(now())

  order       Order           @relation(fields: [orderId], references: [id], onDelete: Restrict)
  valuePolicy ValuePolicy     @relation(fields: [valuePolicyId], references: [id], onDelete: Restrict)
}
```

要求：

- 每个启用新政策后创建的订单恰好一个 snapshot；
- snapshot 与 Order 必须在同一数据库事务提交；
- snapshot 创建后禁止 UPDATE/DELETE；
- `pointsAmountAtomic` 必须等于确认时的 `Offer.price`；
- `referenceAssetCode` 必须等于政策的 reference asset；
- 历史订单暂不回填虚构参考价值；M3 迁移另立任务。

## 7. 精确换算契约

实现一个无数据库依赖的纯函数，建议位置：

```text
server/src/modules/valuePolicy/money.ts
```

输入和输出：

```ts
type RoundingMode = 'HALF_EVEN'

interface ConvertPointsInput {
  pointsAtomic: bigint
  referenceAtomicPerPointNumerator: bigint
  referenceAtomicPerPointDenominator: bigint
  roundingMode: RoundingMode
}

function convertPointsToReferenceAtomic(input: ConvertPointsInput): bigint
```

计算：

```text
raw = pointsAtomic × numerator / denominator
```

规则：

- 输入积分、分子和分母必须非负/正值并显式校验；
- 禁止使用 JavaScript `number`、浮点数或隐式字符串转 number；
- 中间计算全部使用 BigInt；
- 非整除时只允许 `HALF_EVEN`；
- 输出不得为负；
- API 序列化必须使用十进制字符串；
- 不得在调用方复制换算公式。

测试示例：

```text
policy: 1 CNY atomic / 1 point
1,200 RP -> 1,200 CNY atomic -> ¥12.00
```

## 8. API 契约

### 8.1 当前价值政策

新增：

```http
GET /api/value-policy/current
```

`shadow/enforce` 成功响应：

```json
{
  "id": "vp_cny_001",
  "version": 1,
  "pointAsset": { "code": "RP", "scale": 0 },
  "referenceAsset": { "code": "CNY", "scale": 2 },
  "ratio": {
    "referenceAtomicPerPointNumerator": "1",
    "referenceAtomicPerPointDenominator": "1"
  },
  "roundingMode": "HALF_EVEN",
  "effectiveAt": "2026-09-01T00:00:00.000Z",
  "disclosure": "积分为平台内部权益，所示金额仅为参考价值，不代表现金赎回承诺。"
}
```

所有 BigInt 字段必须是字符串。`off` 模式返回 `404 VALUE_POLICY_DISABLED`；不得泄露 draft、approved 或未来 scheduled policy。

### 8.2 Checkout preview

保留当前响应字段，并新增：

```json
{
  "price": 1200,
  "pricing": {
    "points": { "assetCode": "RP", "amountAtomic": "1200", "scale": 0 },
    "reference": { "assetCode": "CNY", "amountAtomic": "1200", "scale": 2 },
    "valuePolicyId": "vp_cny_001"
  }
}
```

`price` 继续作为兼容字段。本阶段不得把它直接改为对象，以免破坏现有前端和客户端。

### 8.3 创建订单

请求新增：

```json
{
  "expectedValuePolicyId": "vp_cny_001"
}
```

行为：

- `off`：容忍并忽略格式合法的可选新字段，不写 snapshot，以便客户端可提前发布；
- `shadow`：字段可选；提供时必须等于事务内 active policy；
- `enforce`：字段必填；缺失返回 `400 VALUE_POLICY_REQUIRED`；
- ID 不一致、政策已 retired、尚未生效或基准币不是 CNY：返回 `409 VALUE_POLICY_CHANGED`；
- 所有拒绝路径不得创建 Order、PointLog、Settlement、InventoryLog 或 snapshot，也不得改变余额/库存。

### 8.4 Implementation clarification（错误码优先级，2026-08-18 冻结）

第 5 节“无 active 返回 503”与第 8.3 节“retired/future expected ID 返回 409”
同时成立时，按以下冻结解释执行，不得静默改契约：

1. 客户端提交了具体但失效的政策确认（unknown / draft / approved /
   scheduled / retired / future / 非 CNY / 与当前唯一 active CNY policy
   不一致）→ `409 VALUE_POLICY_CHANGED`。即使系统当前没有可用替换政策，
   也优先 409。
2. shadow 客户端没有提交政策 ID，且系统没有唯一可用 active CNY policy →
   `503 VALUE_POLICY_UNAVAILABLE`。
3. enforce 缺少 `expectedValuePolicyId` → `400 VALUE_POLICY_REQUIRED`，
   且必须发生在任何余额、库存、订单、PointLog、Settlement、InventoryLog、
   outbox、snapshot 副作用之前。
4. 数据库存在 active CNY policy，但其比例、kind、scale、enabled、
   retiredAt、rounding 等内部数据违反不变量 → `500 VALUE_POLICY_DATA_INVALID`。
   不得回退到历史比例或猜测值。
5. `off` 忽略格式合法的 `expectedValuePolicyId`，不查询 policy，不返回
   pricing，不写 snapshot。

订单成功响应和订单详情新增 `pricing`，其内容必须来自 `OrderPricingSnapshot`，不得使用当前政策重新计算。

## 9. 错误码

| HTTP | code | 含义 |
| ---: | --- | --- |
| 404 | `VALUE_POLICY_DISABLED` | 功能未启用 |
| 400 | `VALUE_POLICY_REQUIRED` | enforce 模式缺少政策确认 |
| 409 | `VALUE_POLICY_CHANGED` | preview 与确认使用的政策不一致 |
| 503 | `VALUE_POLICY_UNAVAILABLE` | 启用状态下不存在唯一有效的 CNY policy |
| 500 | `VALUE_POLICY_DATA_INVALID` | 数据库政策违反内部不变量；记录 P0 告警，不回退猜测 |

错误必须沿用项目现有 `HttpError` 与错误序列化约定。

## 10. 原子性与并发

1. 创建订单时，政策解析、价格校验、订单创建和 snapshot 创建必须位于现有订单事务内；
2. 政策从 preview 到 confirm 发生变化时必须 409，不得静默接受；
3. 相同 `Idempotency-Key` 重放返回同一订单与同一 snapshot；
4. 不得在事务外创建 snapshot 或异步补写；
5. 激活/退役政策必须串行化，确保不会短暂出现两个 active policy；
6. snapshot 的外键使用 `RESTRICT`，不得因删除政策或订单而丢失审计依据。

## 11. 迁移与 seed

数据库 migration 必须是加法式且可在现有数据上安全部署：

1. 新增 enum、表、FK、CHECK、partial unique index 和必要的不可变保护；
2. 不修改或回填现有 `PointAccount`、`PointLog`、`Order.price`；
3. 可插入 `RP` 与 `CNY` 资产定义；
4. 不得插入生产 active ValuePolicy；
5. 测试数据库可创建 `100 PTS = 1 CNY` 的 active fixture；
6. migration 必须同时通过全新数据库重放和已有数据库升级测试；
7. 禁止使用 `prisma db push` 代替 migration。

## 12. 测试要求

### 12.1 纯函数

- `1,200 RP -> 1,200 CNY atomic`；
- 零积分；
- 大于 `Number.MAX_SAFE_INTEGER` 的积分仍精确；
- 可整除与不可整除比例；
- HALF_EVEN 的偶数/奇数 tie；
- 零分母、负数和非法策略被拒绝；
- 输入对象不发生突变。

### 12.2 数据库约束

- 分子/分母不能为零或负数；
- 同一积分资产不能有两个 active policy；
- active policy 经济字段不可修改；
- snapshot 不可更新或删除；
- snapshot 必须关联存在的 Order 和 ValuePolicy；
- 生产保护拒绝 active USD/USDT 本位政策。

### 12.3 API 与事务

- `off` 模式下现有 checkout/order 测试完全不变；
- preview 的积分、CNY 原子金额和 policy ID 正确；
- shadow 模式兼容未发送 policy ID 的旧客户端；
- enforce 模式缺少 policy ID 返回 400；
- stale policy 返回 409 且余额、库存、订单、流水、Settlement 均无变化；
- 成功订单只有一个 immutable snapshot；
- policy 后续 retired/替换后，订单详情仍返回原 snapshot；
- 同一幂等键并发重试不产生重复 snapshot；
- BigInt API 字段为字符串，不触发 JSON 序列化异常。

建议新增或扩展：

```text
server/src/modules/valuePolicy/money.test.ts
server/src/__tests__/value-policy.test.ts
server/src/__tests__/checkout-idempotency.test.ts
server/src/__tests__/product-database-constraints.test.ts
```

## 13. 可观测性

至少增加：

```text
value_policy_resolution_total{result,mode}
value_policy_changed_total
order_pricing_snapshot_created_total
order_pricing_snapshot_failure_total
```

以下情况记录 error 并触发告警：

- shadow/enforce 模式不存在 active CNY policy；
- 检测到多个 active policy；
- policy asset kind/scale 不合法；
- 成功订单缺少应有 snapshot；
- snapshot 与 Order.price 不一致。

日志禁止记录密码、令牌或完整用户隐私数据；policy ID、order ID、correlation ID 可以记录。

## 14. 建议修改文件

实施 Agent 应以实际代码结构为准，但预计修改范围如下：

```text
server/prisma/schema.prisma
server/prisma/migrations/<timestamp>_add_value_policy_foundation/migration.sql
server/src/config.ts 或现有等价配置入口
server/src/modules/valuePolicy/money.ts
server/src/modules/valuePolicy/service.ts
server/src/modules/valuePolicy/controller.ts
server/src/modules/valuePolicy/routes.ts
server/src/modules/checkout/service.ts
server/src/modules/orders/schema.ts
server/src/modules/orders/controller.ts
server/src/modules/orders/service.ts
server/src/app.ts
server/src/__tests__/value-policy.test.ts
相关既有测试
```

不得为了本任务修改前端、会员、排行榜、支付、Payout、USDT 或商家 Settlement 语义。

## 15. 验证命令

实施 Agent 至少执行：

```bash
npm run check:runtime
npm --prefix server run db:generate
npm --prefix server run build
npm --prefix server test
npm run verify:quick
```

若完整测试受环境依赖阻塞，必须记录具体命令、错误和已完成的替代验证；不得只写“测试通过”而不提供结果。

## 16. 分阶段上线

| 步骤 | 模式 | 条件 |
| --- | --- | --- |
| 1. 合并代码与 migration | `off` | 所有旧测试通过 |
| 2. 非生产创建 CNY 测试 policy | `shadow` | D-02 可仍未批准，仅使用脱敏数据验证 |
| 3. 完成价格/奖励/预算回测 | `off` | 形成 D-02 决策材料 |
| 4. D-02 正式批准 | `off` | 记录比例、审批人、生效时间和披露文案 |
| 5. 生产创建 scheduled CNY policy | `off` | 双人审批、无 active USD/USDT policy |
| 6. 生产 shadow | `shadow` | preview/订单快照比对无差异 |
| 7. 客户端发布并回传 policy ID | `shadow` | 兼容窗口完成 |
| 8. 强制政策确认 | `enforce` | 指标、告警和回滚 runbook 就绪 |

## 17. 完成定义

本阶段只有同时满足以下条件才算完成：

1. migration 可在空库与现有库重放；
2. `off` 模式不改变任何当前用户行为或 API 兼容字段；
3. CNY policy 能精确计算并返回字符串原子金额；
4. stale policy 在任何资金/库存副作用前被拒绝；
5. 新订单 policy/snapshot 在同一事务完成；
6. 历史订单不被回填或重估；
7. 相关 build、测试和快速验证通过；
8. git diff 不包含真实支付、USDT、会员或无关重构；
9. Agent 输出修改文件、迁移、测试结果、风险和未决事项；
10. Agent 不自行 push、合并、创建 PR 或激活生产 policy。

## 18. Agent 执行指令

实施 Agent 必须：

1. 完整阅读本 Spec 与上位 Spec；
2. 先检查代码与测试，输出拟修改文件清单；
3. 严格在本文范围内实现，不自行扩大到 ledger/VC/支付；
4. 遇到 D-02、生产 seed 或业务语义不明确时停止相关部分并报告，不擅自决定；
5. 保留当前工作区中不属于自己的改动；
6. 实施后运行验证、检查 diff，并按完成定义逐项报告。

## 19. Implementation status（2026-08-18 closure）

状态：**Implemented — Production Activation Blocked by D-02/D-03**

### 19.1 实现证据

| 项 | 证据 |
| --- | --- |
| PR #144 已合并 | `origin/develop@c6d21bb` `feat(value-policy): add CNY value policy phase 1 foundation (#144)` |
| 合并前功能提交 | `b71abc0`、`915dc41` |
| Closure 分支 | `feat/cny-value-policy-phase-1-closure` |
| Foundation migration | `server/prisma/migrations/20260817180000_add_value_policy_foundation/`（已合并，禁止原地修改） |
| Closure migration | `server/prisma/migrations/20260818120000_value_policy_phase1_closure/` |
| 内部状态推进 | `server/src/modules/valuePolicy/governance.ts`（无公开 HTTP 激活 API） |
| 只读审计 | `npm --prefix server run value-policy:audit` |
| 告警契约 | `docs/operations/value-policy-alerts.md` + `server/src/modules/valuePolicy/alertContract.ts` |
| 运行手册 | `docs/operations/value-policy-runbook.md` |

### 19.2 已完成

- `off` / `shadow` / `enforce` 模式与错误码矩阵
- CNY `ValuePolicy` + `OrderPricingSnapshot` 同事务落库
- 状态机与时间戳由数据库 CHECK/trigger 保护
- Asset/policy 典型并发按同一 advisory lock 消除 40P01
- 指标语义与事务提交一致
- 只读审计命令
- 生产配置守卫：`MONEXUS_DEPLOY_ENV=production` 时强制 `off`

### 19.3 生产激活 gates（未完成，且不得由工程自行决定）

- D-02 生产积分面值未批准
- D-03 生产披露文案未批准
- 双人审批后台入口（创建人 ≠ 审批人）未开放；当前 schema 无 actor 字段
- 未创建生产 active ValuePolicy
- 生产 `POINT_VALUE_POLICY_MODE` 必须保持 `off`

### 19.4 明确不属于本 Phase 1 的后续范围

以下属于 `SPEC-VALUE-LEDGER-001` 后续阶段，不是本次 closure 的未完成代码：

- LedgerAccount / LedgerTransaction / LedgerEntry
- EntitlementLot / ConsumptionAllocation
- RP/VC/XP 拆分
- FxQuote
- 真实 CNY/USD/USDT 支付
- 用户充值、转账、提现或现金赎回
- 商家真实货币出款
- SettlementV2 / Payout / Reconciliation
- 前端生产参考价值展示
- 多租户
- 生产 active policy
- 自行决定 `100 PTS = 1 CNY`

### 19.5 Migration 政策

已合并的 `20260817180000_add_value_policy_foundation` 不得原地修改。
部署后只允许 forward-fix。禁止 `prisma db push`。禁止回滚历史 migration。

### 19.6 DOCX 同步

仓库没有可靠的 `.md` → `.docx` 生成流程。对应
`docs/specs/points-value-policy-phase-1.docx` 与
`docs/specs/points-real-value-alignment.docx` **未在本 closure 中手工伪造同步**。
需要独立的文档生成任务。
