# Proposal

## Why

Owner 已确认 Stripe 微信支付审核通过，要求完成从预发联调到正式收款的接入。正式站已有 Stripe 银行卡和 VMQFox 的现有接入能力，微信也需要能走已获批的 Stripe 商户。

## What Changes

- Stripe 商户配置可为 CNY 开启微信支付，使用单独核实的最低限额和只读渠道能力校验。
- 充值用户可单独选择 Stripe 微信支付，经 Stripe 托管 Checkout 扫码。沿用既有回调、入账和全额退款流程。
- 范围限 Stripe 微信支付。支付宝审核中的 Stripe 渠道、现有 VMQFox 设置、钱包记账规则均不在改动范围。

## Capabilities

### New Capabilities

- `stripe-wechat-pay` 提供 Stripe 商户级微信支付配置和人民币扫码充值。

### Modified Capabilities

无。

## Impact

涉及 Stripe 适配器、商户配置、报价、支付事实以及充值页标签。沿用 [充值规格](../../../docs/specs/recharge-payment-platform-v1.md) §6.2、§8 和 [运行时支付配置](../../../docs/specs/runtime-settings-phase2.md) §2C。触及整数金额、入账事务、幂等、授权与订单锁顺序。复用既有 worker 并保留现有租约边界。
