# 商家自动开通 Webhook 接入文档

> 适用于在商家后台「商家资料 → 自动开通 Webhook」配置了回调地址的商家。
> 平台侧实现参考：`server/src/lib/outboundWebhook.ts`（签名与校验参考实现
> `verifyWebhookSignature`）、`server/src/modules/orders/provisionCron.ts`（重试与降级）。

## 1. 你需要提供什么

一个可公网访问的 **HTTPS(443)** 回调端点：

- 域名必须解析到公网可路由地址。指向内网 / 环回 / 保留网段的地址会在
  **保存配置时**被拒绝，且每次外呼建立连接时还会再次校验（DNS rebinding
  防护）。
- URL 不允许携带用户名密码（`https://user:pass@host/` 形态直接拒绝）。
- 平台**绝不跟随重定向**：3xx 响应按失败处理，请让端点直接应答。
- 响应需在 **10 秒**内完成，响应体不超过 **64KB**。

## 2. 请求格式

平台以 `POST` 发送 JSON（`content-type: application/json`）：

```json
{
  "taskId": 123,
  "attempt": 1,
  "timestamp": 1753600000,
  "orderId": 456,
  "productName": "示例商品",
  "offerName": "标准版",
  "price": 300,
  "purchaseFormAnswers": { "游戏账号": "player001" },
  "bookingDate": null
}
```

| 字段 | 说明 |
|------|------|
| `taskId` | 开通任务唯一 ID，**幂等去重键**（见 §4）。测试事件带 `test-` 前缀且附加 `"test": true` |
| `attempt` | 第几次尝试（1 起） |
| `timestamp` | 发送时刻的 Unix 秒 |
| `orderId` | 平台订单号 |
| `productName` / `offerName` | 商品 / 规格名快照（`offerName` 可为 `null`） |
| `price` | 成交积分价 |
| `purchaseFormAnswers` | 买家购买前表单答案（未配置表单时为 `null`）。买家在下单页已被明确告知这些信息会发送给你的开通服务 |
| `bookingDate` | 预约类订单的预约日（否则 `null`） |

载荷**不含**买家账号、邮箱等身份信息；如需联系买家请通过购买前表单收集。

## 3. 签名校验（必须实现)

每个请求带 `x-monexus-signature` 头，Stripe 风格：

```
x-monexus-signature: t=<unix秒>,v1=<hex(HMAC-SHA256)>
```

- 签名密钥：保存 / 轮换配置时**一次性**展示的 64 位 hex 字符串（平台侧加密
  存储，之后不可再查看，丢失只能轮换）。
- 签名内容：**原始请求体字节**，按 `"{t}.{rawBody}"` 拼接后取
  HMAC-SHA256 的 hex：

```
expected = hex( HMAC_SHA256( secret, `${t}.${rawBody}` ) )
```

校验步骤：

1. 解析头部取 `t` 与 `v1`；
2. `|now - t| > 300` 秒 → 拒绝（防重放窗口 **±300s**）；
3. 用**原始 body**（不要先 JSON.parse 再序列化——字段顺序变化会导致校验失败）
   计算 `expected`，与 `v1` 做**常数时间比较**；
4. 不匹配 → 返回 4xx 拒绝。

Node.js 参考实现即平台侧 `verifyWebhookSignature`（`server/src/lib/outboundWebhook.ts`）。

## 4. 幂等（必须实现）

投递语义是**至少一次**：HTTP 已成功但平台侧落库失败时会按原 `taskId` 重
发；重试也使用同一 `taskId`。你必须以 `taskId` 去重——同一 `taskId` 的重复
请求应直接返回上次的成功结果，**不得重复开通**。

## 5. 成功契约

开通成功时返回 **2xx** + JSON：

```json
{ "content": "开通结果文本，1–5000 字符" }
```

`content` 会作为交付内容原样展示给买家（账号信息、卡密、开通说明等）。
以下情况一律按失败处理并进入重试：非 2xx、响应非 JSON、`content` 缺失 /
非字符串 / 空白 / 超过 5000 字符。

## 6. 重试与人工降级

- 失败后按固定退避重试：**1 分钟 → 5 分钟 → 15 分钟 → 1 小时 → 6 小时**。
- 最大尝试次数由平台配置（`autoProvisionMaxAttempts`，0–5；0 = 暂停外呼）。
- 次数耗尽后任务**降级为人工履约**：平台给你发提醒邮件，订单停在「履约中」
  等你在商家后台手动交付——降级不会取消订单。
- 买家在下单时已被告知：自动开通失败会自动转人工交付。

## 7. 轮换与撤销语义

- **保存新地址 = 轮换**：旧配置立即撤销并生成**新密钥**；已创建但尚未发出
  的旧任务**不会**改用新配置/新密钥——它们直接降级为人工履约（收到降级
  邮件）。已用旧密钥签名发出的在途请求仍按旧密钥校验即可。
- **撤销配置**：同样降级全部未发出任务，并自动关闭你名下所有规格的
  「自动开通」开关（这些规格回到纯人工履约，商品可正常购买）。
- 撤销/轮换与外呼在平台侧严格串行化：撤销生效后，未发出的任务**不会**再
  向你的旧地址外呼。

## 8. 测试

商家后台的「发送测试」按钮会向当前配置地址发送一条测试事件：`taskId` 带
`test-` 前缀、`"test": true`、`orderId: 0`。测试事件走与真实外呼完全相同的
安全路径（SSRF 校验、签名），用于验证你的签名校验与幂等实现；对测试事件
返回 2xx 即可，无需返回 `content`。
