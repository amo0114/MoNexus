# Stripe 微信充值报价重试交接

- 任务范围见 [契约](fix-stripe-recharge-quote-retry.contract.md)。本地基线为 `origin/develop@b242205`，写入负责人为主会话。
- 正式站只读检查确认微信最低额为 ¥1。该金额报价创建后约一秒就被消费，Stripe 拒绝创建 Checkout，订单失败且无渠道单号、无扣款或积分入账证据。旧部署只保存 `BAD_REQUEST`，没有保留 Stripe 原始拒绝码。
- Stripe 明确返回 `amount_too_small` 时将其映射为金额过低。客户端在过期或失效时提供同金额重新报价，保持用户再次确认支付。同一份报价在结果不确定后使用同一个订单幂等键。
- 前端充值页仓库测试 28 项，Stripe 后端测试 13 项，退出码均为 0。前后端构建、架构检查及 `git diff --check` 退出码 0。后端使用独立的 `monexus_test_stripe_wechat_20261125`。
- Owner 随后完成一笔 ¥5 正式 Stripe 微信付款。正式订单为 `credited`，签名回调已处理，积分实收 500。费用比较基于 Owner 提供的 HKD 收费明细。
- 修复保存在本地分支。正式配置维持只读，本轮没有推送、部署或变更商户最低额。
