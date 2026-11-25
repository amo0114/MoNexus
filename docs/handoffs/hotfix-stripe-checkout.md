# Handoff: hotfix-stripe-checkout

- 契约：[hotfix-stripe-checkout.contract.md](hotfix-stripe-checkout.contract.md)
- 写入负责人：本线程主代理，2026-11-25。
- 分支：`hotfix/stripe-checkout`。生产基线 `4b098c8`，代码提交 `9e816cf8232592faae0aea19648473a3ae04af7c`。
- 审查记录：独立审查 `4b098c8ff415b53dabb32758730cfb792b60cc9c..e12ec4cd5e74899232cfef70b81f8978a8b122aa`，结论 `REQUEST_CHANGES`。
- 隔离资源：本地可丢弃 PostgreSQL 库 `monexus_stripe_release_test`，同一时间仅主代理运行集成测试。依赖在 `/root/projects/worktrees/monexus-stripe-production` 安装。

## 已完成

- Stripe 下单在延迟创建 PaymentIntent 时返回已保存的 Checkout Session，使用订单期限派生稳定的 Stripe 创建参数。
- 已付款证据可从 Checkout Session 绑定 PaymentIntent，现有 Observation、查询补偿和入账任务共用该证据。取消返回后的未过期订单提供继续付款入口。
- 保留生产基线已有的 Stripe 管理端账号与加密凭据功能。补充账号回调注册和验收说明。

## 验证

以下检查使用 Node 22 和 npm 10。检查时工作区有未提交的代码修改，随后提交为 `9e816cf`。运行时设置说明的最后两次改动只有文档。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix server run db:generate` 和 `npm --prefix server run db:migrate:deploy` | 退出码 0 |
| `npm --prefix server test -- src/modules/payment/providers/stripe/index.test.ts src/__tests__/payment-runtime-settings.test.ts src/__tests__/payment-simulator-integration.test.ts src/__tests__/recharge-reconcile-resolution.test.ts src/__tests__/recharge-events-credit.test.ts` | 退出码 0，47 项通过 |
| `npm test -- src/pages/RechargePage.test.tsx src/components/admin/AdminConfigPanel.test.tsx` | 首次退出码 1，发现 Stripe 返回仍走额外的支付确认请求。修复后退出码 0，33 项通过 |
| `npm --prefix server run build` 和 `npm run build` | 退出码 0 |
| `npm run check:architecture` 和 `git diff --check` | 退出码 0 |
| `npm run test:architecture` 和 `npm run check:migrations` | 在 `9e816cf` 上运行，退出码 0，分别 14 项与 2 项通过 |

## 独立审查

### [P1] 人工对账直接确认支付

- 位置：[resolveReconcileRequiredOrder](../../server/src/modules/payment/reconciliation/service.ts#L530)。
- 触发前提：管理员解决待人工对账的 Stripe 订单，已保存 Checkout Session，查询确认关联 PaymentIntent 已付款。
- 影响：补丁把 Session 至 PaymentIntent 转换加入原有的直接状态写入路径。该路径没有先记录支付观察事件、再经统一入口确认。
- 证据：静态推理，未复现。[充值规格 §8.1](../specs/recharge-payment-platform-v1.md#81-支付成功与积分入账) 与当前人工处理路径冲突，待 Owner 决定。

### [P2] 单独收到 PaymentIntent 回调时依赖查询恢复

- 位置：[paymentFromIntent](../../server/src/modules/payment/providers/stripe/normalize.ts#L127) 和 [findPaymentAttempt](../../server/src/modules/payment/events/findAttempt.ts#L3)。
- 触发前提：Checkout 创建时没有 PaymentIntent，且 `payment_intent.succeeded` 在 Session 回调前到达。
- 影响：第一次事件处理找不到仍以 Session ID 标识的支付尝试，需等 Session 回调或后台查询完成绑定。
- 证据：静态推理，未复现。本地集成测试已验证 Session 回调和缺失回调时的查询恢复，尚未覆盖上述事件顺序。

## 待完成与阻断

- Owner 决定契约所列两处规格与代码差异。修复后补充回归并重新独立审查。
- 必须使用 Owner 明确授权的分支和发布路径。候选基于生产以隔离 `develop` 尚未发布的无关提交，当前没有 push、PR 或部署。
- 本地测试使用 Stripe 签名夹具和模拟 API。真实 Stripe Sandbox 及真实收款待验证。预发公网探测返回 TLS unexpected EOF，生产公网基线 readiness 返回 ready。
- 远程 CI、生产部署和生产版本核验未执行。
