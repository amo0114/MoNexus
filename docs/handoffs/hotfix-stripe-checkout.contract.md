# Task Contract: hotfix-stripe-checkout

- 来源：Owner 于 2026-11-25 要求推进 MoNexus 的 Stripe 接入，并由 Agent 负责项目代码直至生产。
- 依据：[充值支付规格](../specs/recharge-payment-platform-v1.md) §5.5、§5.6、§6.2、§8、§9、§13，[Stripe 适配器计划](../specs/recharge-payment-platform-v1.plan.md) §7，[运行时支付配置](../specs/runtime-settings-phase2.md) §2C，以及 [Agent 工作流](../agent-workflow.md)。
- 授权边界：本地修复、测试和独立审查。当前任务的远程操作按 AGENTS.md §4 记录 Owner 明确授权，生产审批沿用 GitHub Environment。

## 范围

修复 Stripe 托管 Checkout 在用户确认前没有 PaymentIntent 导致的下单失败。范围包括 Stripe 适配器、支付观察绑定和回补、充值订单下单、退款所用交易 ID、充值结果页面、直接相关的测试和运维文档。复用既有支付商户配置和账户凭据版本绑定。

配置商户账户、启用真实扣款、调整定价和部署基础设施属于各自的运行时操作。其他渠道和历史订单继续使用各自的凭据绑定和现有验签路径。

## 验收

1. 下单返回 Checkout URL，且同一订单的创建参数和幂等键在重试时一致。
2. 已验签的付款确认或经认证的查询证据，才能将同一会话的 PaymentIntent 绑定到原订单。后台新旧凭据版本均保留自己的历史绑定。
3. 重放只产生一次积分入账，缺失回调可经查询补偿，取消及迟到支付沿用现有状态机，退款使用已绑定的 PaymentIntent。
4. 买家从 Checkout 返回仍可继续未过期付款。页面按服务端订单状态显示到账情况。
5. 独立审查、GitHub CI OK 和生产部署结果分别留证。真实 Stripe Sandbox 验收与生产配置启用记录实际状态。

## 待 Owner 确认的规格差异

- 充值规格 §2.2、§6.2 要求有效最低金额按 Stripe 商户账户及结算币种计算。生产基线的 Stripe 适配器使用 CNY 和 USD 固定值。首发渠道的最低金额应由账户条件约束，或者由 Owner 明确同意经验证的单一账户和币种使用后台价格政策作为部署约束。
- 充值规格 §5.6、§8.1 规定统一支付确认入口。现有人工解决待对账订单的服务直接写入成功状态。本次修复沿用了该服务，并在其内识别 Stripe Session 至 PaymentIntent 的转换。该路径的例外范围待确认。
