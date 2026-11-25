# Stripe 沙箱预发恢复交接

- 契约见 [staging-stripe-restore.contract.md](staging-stripe-restore.contract.md)。写入负责人为本线程主代理，记录日期 2026-11-25。
- 预发宿主机 `oracle-tokyo-free`，Compose 项目 `monexus-staging`。`/opt/monexus-staging/current` 指向 `releases/143d76b-staging-restore`。
- 基线是 `143d76b8c7f09ed098d2629910e0ef764eafa701`。恢复目录包含预发本地补丁，后端在宿主机重新构建，前端复用该发布的生产构建。
- Caddy 继续使用已有的 Let's Encrypt 证书，证书到期时间为 2026-12-28 19:27:51 UTC。为避开 Jellyfin 使用的 `18081`，预发 Caddy upstream 和 Compose web 端口绑定使用 `127.0.0.1:18181`。
- 旧后端把空的历史存储加密版本解析成 `0`，恢复构建把空值视为未设置。保留预发数据卷。验证 `/opt/monexus-staging/backups/pre-stripe-restore-20261125T093612Z.dump` 后，按治理规程执行 `backfill --maintenance`、`finalize --maintenance`、`verify`，均通过。

| 验证 | 结果 |
| --- | --- |
| `BASE_URL=http://127.0.0.1:18181 ENV_FILE=/etc/monexus/staging.env bash scripts/staging-compose.sh smoke` | 退出码 0 |
| `curl -fsS https://staging.monexus.oai-o.com/api/health/ready` 并检查 `status` | 退出码 0，`ready` |
| 公网首页及 TLS 主机名验证 | HTTP 200，证书验证通过 |
| 生产 readiness 只读检查 | 退出码 0，`ready` |
| 预发 Prisma 与运行配置只读检查 | 退出码 0，沙箱模式允许新单，CNY/USD 已列入允许范围，凭据加密根已加载，两种币种均缺少生效的普通充值价格政策，Stripe 商户未激活 |

预发恢复目录没有工作流发布标记。下次走 GitHub 预发部署前，需要带入空值修复并让标准发布路径使用 `18181`，保持与 Caddy 一致。

Owner 随后授权创建预发 Stripe 管理员。仅在 `monexus_staging` 内创建 `operator` 账号 ID `38`，授权 `payments.read`、`settings.manage` 和 `payments.refunds.review`。运行中的预发 API 登录检查退出码为 0，返回 `mfa_enrollment_required`。账号由 Owner 首次登录后绑定认证器。

Owner 在预发激活 Stripe Sandbox 后授权启用价格政策。现场确认商户收款币种为 CNY，商户配置最低 ¥1。使用 `adminCreatePricePolicy` 和 `adminActivatePricePolicy` 创建并激活 `rp-cny-stripe-staging-v1`。建议金额 ¥10、¥30、¥50，单笔 ¥1–¥100，每日 ¥300，每月 ¥1,000，1 分兑 1 积分。通过 `getRechargeConfig` 和 `priceAmount` 验证应用提供 Stripe Card 且 ¥10 计算为 1,000 积分，退出码 0。

Owner 完成 ¥10 Stripe Sandbox 付款。预发只读查询退出码 0，订单 `73b6a23c-f390-4a2c-b0bb-9be8c61d3cb0` 为 `credited`，关联 `checkout.session.completed` 验签通过并处理，充值任务成功，唯一的充值流水增加 1,000 积分，余额从 0 到 1,000。预发同期收到并处理了验签通过的 `payment_intent.succeeded`。

Owner 授权重放及退款验收。按 Stripe CLI 的事件重发机制请求 Stripe 将原 `checkout.session.completed` 投递到预发目的地，Stripe API 返回 200，应用重复投递计数从 0 到 1，原事件仅一条，积分流水及 1,050 余额保持不变。预发通过 `adminRequestRefund` 发起 ¥10 整单退款，正常 worker 处理，退款回调验签通过，退款 `succeeded`，订单 `refunded`，唯一冲回流水扣除 1,000 积分，可用余额从 1,050 到 50，冻结余额始终为 0。重发和退款核验命令均退出 0。

## Stripe 微信支付

- 2026-11-25，Owner 确认微信审核通过，授权从预发验收到正式发布。OpenSpec 与开发分支 `feat/stripe-wechat-pay`，提交 `0004d14`。生产基线 `143d76b` 的独立候选 `4618d1f` 已开 [PR #382](https://github.com/amo0114/MoNexus/pull/382)。只读审查范围 `143d76b..08c85a1` 无发现，`4618d1f` 只修正测试类型。定向后端 52 项和前端 41 项通过，两端 production build 及架构检查退出码 0。
- `oracle-tokyo-free` 当前指向 `releases/4618d1f-stripe-wechat`，独立 Compose 项目，前后端映像取自精确候选。仅预发 overlay 保留 `18181`、沙箱开关，并通过 Compose `!reset null` 移除未设置的上代存储密钥版本变量。预发 Postgres 备份已验证，公网 readiness 为 `ready`。
- 预发 Stripe 已激活 CNY 微信方式，最低额 ¥10。实际 Stripe Checkout 沙箱扫码授权完成。订单 `8e15fd25-4c01-4bb5-ab4e-9b9480da5866` 的签名回调通过，入账 1,000，余额从 3,050 到 4,050。原事件重发 HTTP 200，重复计数增加，积分和流水保持不变。
- 整单 ¥10 退款已由正常 worker 发往 Stripe。Stripe 异步退款最终成功，签名回调处理成功，订单为 `refunded`，唯一冲回为 1,000 积分，可用余额回到 3,050，冻结归零。查询退出码 0。
- [PR #382](https://github.com/amo0114/MoNexus/pull/382) 全部 16 项检查通过后合并为 `e6f38510`。master CI 首轮有一项订单详情前端测试失败，同 SHA 重跑通过。镜像成功，[受审批的正式部署](https://github.com/amo0114/MoNexus/actions/runs/45609492933) 通过。生产 API、worker 和 web 的 OCI revision 均为 `e6f38510`，容器及公网就绪检查退出 0。
- Owner 通过私密表单提供 Live 密钥和正式管理员身份。官方只读查询确认香港商户、HKD 默认结算、已开通 Stripe 微信。用正式站专用 HTTPS 回调注册了 Stripe Live Webhook，按后台草稿保存、校验及激活流程完成。生产 `getRechargeConfig` 确认 Stripe 微信和银行卡均可接新单，CNY 收款初始最低 ¥10，VMQFox 微信/支付宝仍可用。配置验收退出 0。首笔真实买家付款与退款尚未验收。
- [PR #383](https://github.com/amo0114/MoNexus/pull/383) 通过 16 项检查后随历史回并 develop，`b242205` 含生产 `e6f38510`。
