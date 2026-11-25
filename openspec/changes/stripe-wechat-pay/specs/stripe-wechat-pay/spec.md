## ADDED Requirements

### Requirement: Stripe CNY 微信商户配置

系统 SHALL 仅为已激活且已配置独立最低金额的 CNY Stripe 商户提供微信支付，并在校验草稿时只读核对 Stripe 支付方式状态。

#### Scenario: 旧商户未配置微信

- **WHEN** 当前 Stripe 商户的版本未设置微信最低金额
- **THEN** 充值配置保留原银行卡方式，微信报价被拒绝，已有凭据版本仍可解密

#### Scenario: 已开通微信的人民币商户

- **WHEN** 管理员配置微信最低金额，Stripe 可用性校验通过并激活草稿
- **THEN** CNY 充值页提供独立的 Stripe 微信入口，报价绑定该方式、最低额和商户版本

### Requirement: 微信支付的付款确认与退款

系统 SHALL 使用指定微信方式的 Stripe 托管 Checkout 为报价单收款，仅凭已验证且与订单匹配的支付成功事实入账，并沿用历史版本执行整单退款。

#### Scenario: 支付中、成功回调及重放

- **WHEN** 买家扫码，Stripe 先返回未付款状态，之后发来已验证的成功事件，随后重发同一事件
- **THEN** 未付款前不增加积分，收到匹配的成功事实后只增加一次积分

#### Scenario: 已入账订单全额退款

- **WHEN** 已入账 Stripe 微信充值使用已绑定凭据版本退款，Stripe 确认整单退款成功
- **THEN** 仅冲回该充值的积分一次
