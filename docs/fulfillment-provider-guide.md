# 履约供应商接入指南

> 适用于要把一个新的外部系统接入 MoNexus 自动开通的开发者：授权码签发、账号开通、会员充值等。
> 契约源码：`server/src/extension-contracts/fulfillment.ts`；模块边界：`server/src/modules/fulfillment/README.md`。
> 完整可运行示例：`server/src/plugins/demoLicense/adapter.ts`（不访问网络，非生产环境自动注册）。

## 1. 先弄清楚分工

| 归属 | 负责的事 |
|---|---|
| **订单核心**（不需要你改） | 价格、积分冻结/扣款/退款、库存、结算、订单状态、幂等、并发锁、取消判断、结果入账 |
| **任务引擎**（不需要你改） | 每单一条 `FulfillmentJob`：派发、租约、重试退避、对账、退款协调、交付 |
| **你的 adapter** | 调用远端执行一次操作，并把远端的回应如实翻译成 `RemoteObservation` |

你**不能**自己写积分、结算或订单状态，也**不能**自己建任务表。所有结果都通过 adapter 的返回值交给引擎，由引擎在订单锁内统一入账。

## 2. 最小实现：一个 adapter

```ts
// server/src/plugins/<yourProvider>/adapter.ts
import type { ExternalFulfillmentAdapter } from '../../extension-contracts/fulfillment.js'

export const myAdapter: ExternalFulfillmentAdapter = {
  id: 'my_provider',            // 写进 Offer.externalIntegration；一旦有订单就不能再改
  label: '我的供应商',            // 后台商品表单里显示的名字
  isConfigured: () => Boolean(config.myProvider.apiKey),  // false 时停止新购买，已有任务继续收敛
  async prepare({ userId, offer, extensionInput }) { /* 可选：校验买家输入，返回要冻结到任务上的数据 */ return {} },
  async execute(command) { /* 执行一次 */ },
  async query(command) { /* 查询这次操作的权威状态 */ },
  async cancel(command) { /* 可选：仅当远端能持久阻止迟到执行时实现 */ },
}
```

### 2.1 `command`：每次调用都完全一样

`FulfillmentCommand` 在下单时冻结，重试不会改变其中任何字段：

| 字段 | 含义 |
|---|---|
| `operationKey` | 稳定幂等键，形如 `MN-my_provider-<orderId>`。**远端必须保证同一个键只执行一次**，这是重试安全的前提 |
| `sku` | 商品规格上配置的 `externalSku` |
| `input` | `prepare` 的返回值 |
| `orderId` / `providerId` | 仅供日志使用 |

`execute` 可能因为超时被重试，所以它和 `query` 都必须以 `operationKey` 幂等。

### 2.2 `RemoteObservation`：如实回答，不要猜

| kind | 什么时候返回 | 引擎怎么处理 |
|---|---|---|
| `succeeded` | 远端确认已执行，带上交付内容 | 交付订单并正式扣款。`delivery.expiresAt` 不传时按规格有效期计算，`null` 表示永久 |
| `processing` | 远端已受理，仍在进行 | 积分保持冻结，稍后再查（可通过 `retryAfterMs` 指定间隔） |
| `unknown` | 超时、网络错误、无法解析的响应 | 积分保持冻结，重试；次数用完后转 `needs_reconcile` |
| `not_found` | 远端查不到这次操作 | **不会退款**：查不到不代表迟到的请求不会落地 |
| `failed_without_effect` | 远端**保证**没有执行、以后也不会执行 | 退款并解冻 |
| `cancelled_before_effect` | 远端已持久取消，后续执行会被拒绝 | 退款并解冻 |

只有最后两种会触发退款。**拿不准的时候就返回 `unknown`**。错误地返回 `failed_without_effect`，会造成「已开通、又退款」的资损。

### 2.3 `cancel`：可选，但语义很严格

只有当远端能**持久**地阻止该 `operationKey` 之后再执行（例如写一条撤销墓碑）时才实现 `cancel`。不实现时，买家取消或管理员退款后，引擎会通过 `query` 收敛：远端确实成功了就照常交付（取消没赶上，之后走售后）；远端证明没有执行才退款。

## 3. 注册与配置

1. **注册**：只在组合根 `server/src/bootstrap/extensions.ts` 里注册，核心代码通过注册表找到你：
   ```ts
   registerFulfillmentProvider(createJobFulfillmentProvider(myAdapter))
   ```
2. **配置**：密钥、地址等所有环境变量都要在 `server/src/config/index.ts` 里用 Zod 解析，并同步写进 `.env.example`。不要在 adapter 里直接读 `process.env`。
3. **架构检查**：`npm run check:architecture` 会拒绝订单核心、结账和 `modules/fulfillment/` 直接 import `server/src/plugins/` 下的实现。你的代码只能被 `bootstrap/extensions.ts` 引用。

## 4. 让商品走你的供应商

规格（Offer）上需要满足三个条件：

| 字段 | 值 |
|---|---|
| `externalIntegration` | 你的 `adapter.id` |
| `externalSku` | 小写字母、数字、`-`、`_`，最长 64 位 |
| `deliveryMode` | `manual_service`（下单冻结积分，开通成功后扣款） |

后台「平台商品向导」在选择 **订阅与开通** 模板（`subscription`）时，可以从已注册的供应商里选择并填写 SKU（接口：`GET /api/admin/fulfillment/providers`）。商家商品不能绑定外部供应商。

## 5. 可选：购买弹窗里的自定义步骤

如果买家下单前需要额外输入（例如选择要充值的账号），在前端加一个 hook：

1. 按 `src/extensions/purchase.ts` 的 `PurchaseExtensionHook` 实现，返回 `ready`、`panel`、`orderInput` 等字段。
2. 在 `src/extensions/registry.ts` 里按供应商 id 注册。
3. `orderInput` 会作为 `extensionInput` 随 `POST /api/orders` 提交，由服务端你的 `prepare` 校验。**浏览器传来的任何字段都不能信任**，执行方由服务端 Offer 决定，客户端无法指定。

`orderInput` 是平铺的供应商字段，例如 `{ account: 'target', quantity: 2 }`，请求体会封装为 `extensionInput`。最多 16 个键（每键最长 64 字符），值限字符串（最长 512 字符）、有限数字或布尔值。非空输入参与幂等指纹：相同键重试时改变供应商参数返回 409，键的排列顺序不影响重放。

需要根据选择重新预检时，通过 `setPreviewQuery({ account: 'target' })` 更新；前端把这些字符串字段 JSON 编码为预览接口的 `extensionInput` 查询参数，服务端校验后原样交给 `checkout.preview`。直接调用 HTTP 的客户端也使用此 JSON 查询参数。Xboard 既有顶层账号选择/目标版本字段继续兼容。

没有额外输入的供应商不需要这一步，通用购买弹窗就够用。参考实现：`src/extensions/xboard/useXboardPurchaseExtension.tsx`。

## 6. 订单生命周期里你需要知道的

- **下单**：任务与订单在同一个事务里创建，远端调用发生在提交之后。
- **人工操作**：有外部供应商绑定或持久任务的订单不能走平台人工接单、拒单或替代交付；解除规格绑定也不会改变已创建任务的执行者。
- **取消/超时**：买家取消、管理员退款之前，核心会在订单锁内做取消判断。未派发的任务直接作废；可能已派发的任务被标记为 `cancelRequested`，之后通过 `cancel` 或 `query` 收敛。你不需要处理这些，只要 `query` 如实回答。
  外部订单与普通人工单一样有开始处理期限（`acceptTimeoutHours`），买家可在待处理时取消，超时自动取消。期限过后远端迟到的成功仍会交付；收敛成退款的取消记为 `resolutionReason=cancel_requested`，开通失败退款记为 `provider_failed`。商家 Webhook 自动开通没有查询/取消协议，不设期限，也不支持买家直接取消。
- **迟到的结果**：订单已退款或已关闭后才收到 `succeeded` 时，引擎不会再交付，会在任务上记下「需要人工撤销」并打错误日志，由运营在远端撤销。
- **对账**：重试次数（默认 3 次）用完后，任务转为 `needs_reconcile`，引擎会继续低频查询。目前还没有后台页面展示这类任务，请通过日志和数据库（`FulfillmentJob.status`、`lastError`、`evidence`）排查。

## 7. 测试

参照 `server/src/__tests__/fulfillment-job-engine.test.ts` 和 `order-cancellation-bridge.test.ts`。用 `processFulfillmentJob(jobId)` 同步驱动一步，断言订单状态和积分（`balance` / `frozenBalance`）。至少覆盖：

1. 成功 → 交付并只扣款一次（重复处理返回 `skipped`）；
2. `unknown` / `processing` → 积分保持冻结；
3. `failed_without_effect` → 退款；
4. 派发后取消 → 通过 `cancel` 或 `query` 收敛，不会重复退款。

运行方式见仓库根目录 README 的 Testing 一节（需要独立的测试数据库）。

## 8. 另一种接入方式：自带任务模型

内置的 Xboard（`faka_bridge`）没有使用任务引擎，而是直接实现 `FulfillmentProvider`：它有自己的任务表、协议版本、撤销墓碑和付费重置。只有当远端协议无法用 execute / query / cancel 表达时，才考虑这种方式，而且必须同样遵守：

- 实现 `onOrderRefundedInTx`、`assessCancellationInTx`，锁顺序为先订单、后任务；
- 结果只通过 `modules/fulfillment/apply.ts` 的 `deliverExternalResultInTx` / `refundUndeliveredExternalOrderInTx` 入账；
- 超时、404、「查不到」都不能当作没有执行的证据。

新供应商请优先使用 adapter 方式。
