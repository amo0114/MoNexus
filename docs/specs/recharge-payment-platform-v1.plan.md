# SPEC-RECHARGE-PAYMENT-V1.2 实施计划与 Agent 交接包

关联规格：`docs/specs/recharge-payment-platform-v1.md`

状态：Ready for implementation

日期：2026-08-19

版本：v1.2

修订记录：

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v1.0 | 2026-08-19 | 首版实施拆分 |
| v1.1 | 2026-08-19 | 增加 PR-A0，冻结共享文件和 provider dependency 收口规则 |
| v1.2 | 2026-08-19 | 统一 PaymentObservation、action 与取消竞态合同，扩大 PostgreSQL 门禁 |

## 1. 使用方式

将本文件和主 Spec 一并交给实施 Agent。实施 Agent 必须完整阅读主 Spec，本计划不能替代业务和安全合同。

建议按顺序合并基础 PR，再并行开发渠道适配器源码和界面。不要让多个 Agent 同时修改 `schema.prisma`、同一 migration、`server/package-lock.json` 或充值核心状态机。Provider Agent 可以并行开发源码和提出依赖 manifest 变更，但 dependency/lockfile finalization 必须串行。

所有工作从实施时最新 `origin/develop` 创建隔离 worktree。不要在历史 ValuePolicy 分支继续堆提交，不要改历史 migration，不要使用 `prisma db push`。

本 Spec baseline 必须先提交并合并到各 Agent 的共同基线；如果尚未合并，则必须将同一个只含两份 v1.2 文档的 baseline commit 明确 cherry-pick 到每个 Agent worktree。未跟踪文件不会出现在新 worktree，不得仅靠对话中转述合同。

## 2. 总体交付结构

```text
Wave 1 (sequential)
  PR-A0: 现有 PointAccount mutation hard-cap 加固
  PR-A: 数据模型、金额类型、配置门禁
  PR-B: 充值核心、报价、订单、Simulator、用户 API
  PR-C: 支付事件 worker、积分入账、退款、争议、对账核心

Wave 2
  PR-E: 用户端和管理端 UI（PR-B 后可开始，合并前 rebase PR-C）

Wave 2 provider adapters (parallel after PR-C)
  PR-D1: Stripe adapter
  PR-D2: PayPal adapter
  PR-D3: WeChat Pay adapter
  PR-D4: Alipay adapter

Wave 3 (integration)
  PR-F: 指标、告警、runbook、故障与并发集成测试
  PR-G: 全量回归、最终 review 修复和 staging rehearsal
```

上述结构正好是 11 个 PR：A0、A、B、C、D1、D2、D3、D4、E、F、G。

如果只使用一个 Agent，也必须保留上述提交边界，避免一个无法 review 的大提交。

## 3. PR-A0：现有积分 mutation hard-cap 加固

### 所有权

- `server/src/modules/orders/accounting.ts`
- `server/src/modules/points/service.ts`
- `server/src/modules/auth/growthRewards.ts`
- `server/src/modules/merchandising/promotions/points.ts`
- `server/src/modules/admin/service.ts` 中相关积分 mutation
- checkout/order 的其他积分增减路径
- 新增共享 checked credit/debit/hold helper 的最小模块
- 上述路径的边界与回归测试

### 工作内容

1. 枚举全仓所有 `PointAccount.balance`、`frozenBalance` 和对应 PointLog mutation，形成代码内可执行保护而非只写清单。
2. 引入共享 checked credit/debit/hold helper 或等价的条件更新机制，统一保证非负、Int 安全转换和 `balance + frozenBalance <= 2_000_000_000`。
3. 将签到、订单、checkout、推广奖励、成长奖励、退款和管理员调整迁移到受保护路径。
4. 为硬上限、余额不足和并发冲突返回稳定业务错误；不能让未来数据库 CHECK 只表现为未处理的 500。
5. 本 PR 不改 schema、不增加数据库 CHECK、不实现充值。

### 必测

- 每个既有 mutation 在 `1_999_999_999`、`2_000_000_000`、越界和负余额边界；
- 两个并发 credit/debit/hold 不突破 hard cap 或产生负余额；
- PointAccount 与 PointLog 同事务一致；
- 既有正常签到、订单、推广、退款和管理员调整行为不回归。

上述并发与事务测试必须运行于真实 PostgreSQL，不得只用 mock repository。

## 4. PR-A：数据模型、金额类型与配置

### 前置

PR-A0 已合并，所有既有积分 mutation 已具备业务级 hard-cap 错误处理。

### 所有权

- `server/prisma/schema.prisma`
- 一个新的 additive migration
- `server/src/__tests__/setup.ts` 的新表 TRUNCATE/隔离清单
- `server/src/modules/recharge/types.ts`
- `server/src/modules/recharge/money.ts`
- `server/src/modules/recharge/config.ts`
- 根/服务端配置校验和示例 env
- 本 PR 对应测试

### 工作内容

1. 按主 Spec 第 5 节创建模型、enum、关系、唯一约束、索引和 CHECK。
2. `PaymentEvent` 按统一 PaymentObservation 合同创建 source、verificationMethod、dedupe 和租约字段；同时冻结完整 PaymentDispute、幂等 scope 与 orphan takeover 合同。
3. 在 PR-A0 已完成既有 mutation 加固后，为 `balance + frozenBalance <= 2_000_000_000` 增加数据库 CHECK；migration 前只读扫描已有数据，异常时 fail closed。充值金额、快照和凭证使用 BigInt。不得在本 PR 擅自发起全仓积分 BigInt 重构。
4. 实现 ISO currency 元数据、minor-unit 十进制字符串解析和序列化。
5. 实现 `BigInt + HALF_EVEN` 充值定价，不复制浮点公式。
6. 添加 `RECHARGE_MODE`、`PAYMENT_REGISTERED_PROVIDERS`、`PAYMENT_ENABLED_PROVIDERS` 子集关系与 provider 环境隔离校验。
7. 按主 Spec 的 `isProductionDeploy = NODE_ENV === 'production' && (MONEXUS_DEPLOY_ENV ?? 'production') === 'production'` 实现充值环境隔离；不改变 Cookie/MFA 等按 NODE_ENV 的既有安全行为。
8. migration 不 seed active live provider，不创建真实支付或充值订单。

### 必测

- 金额 parser 拒绝 JSON number、负数、指数、空白、超长字符串；
- CNY/USD 99/100/101 minor 边界；
- 有理数 HALF_EVEN；
- 数据库唯一约束和 CHECK；
- PaymentObservation source/verification/dedupe、PaymentDispute 唯一约束和幂等 scope/orphan takeover schema；
- enabled provider 必须是 registered 子集，移除 enabled 不卸载历史处理 adapter；
- PR-A0 helper 与新增数据库 CHECK 的集成边界；
- 空库 migration 重放；
- 从最新 develop schema 的升级重放；
- production+production、production+staging、production+缺失 deploy env、development+production 的配置组合表。

### 完成证据

- migration 名称和 checksum；
- 空库/升级库命令及结果；
- schema diff；
- 定向测试计数；
- 明确未使用 `db push`。

## 5. PR-B：充值核心、Simulator 与用户 API

### 前置

PR-A 已合并并更新基线。

### 所有权

- `server/src/modules/recharge/**`，支付 worker/退款/对账除外
- `server/src/modules/payment/providers/simulator/**`
- `server/src/modules/payment/observations/record.ts` 或等价的纯持久化 helper
- 充值 routes/controller/schema/service
- 用户 API 合同测试

### 工作内容

1. 实现 active `RechargePricePolicy` 读取、有效最低额、限额与推荐金额。
2. 实现 quote 创建和 10 分钟过期。
3. 实现 quote CAS 消费、RechargeOrder 和 PaymentIntent 创建。
4. 使用 PR-A 已创建的 `RechargeIdempotencyRecord`；不得复用绑定商品的旧表，也不得在本 PR 临时新增 schema。
5. 定义 `PaymentProvider`、可选 `completePayment()`、规范化状态、`none|redirect|qr_code|client_secret|form_post` action union 和按 account/environment/currency/method 求值的能力对象；V1 不实现 provider_sdk。
6. 完整实现 Simulator 的成功、失败、pending、重复、乱序、退款和争议场景。
7. 注册用户 API；disabled 模式保持 fail closed。enabled 仅控制新 quote/attempt，registered provider 的历史 webhook/query/refund/reconciliation 必须保留。
8. 增加订单查询与列表权限边界。
9. 实现 provider-specific quote：请求包含 provider/paymentMethod，服务端选择 provider account，冻结 capability digest 和 effective min/max，创建订单时重新校验。
10. 创建订单事务原子预留 day/month RechargeLimitBucket；paid 转 consumed，退款不恢复。
11. 实现 `POST /api/recharge/orders/:id/complete` 的统一合同；返回 URL 只导航或触发服务端 complete，不能直接改变 paid/credited。authenticated provider 结果必须通过可复用的 `recordPaymentObservation` 纯持久化 helper 落库，不能在 controller 中标 paid。
12. 实现取消/过期 closure 状态机：无 attempt 可直接释放；non-terminal attempt 先 close/query；unknown 保持 closure_pending 且不释放；terminal 后迟到成功留给 PR-C 的 reconcile 路径。
13. 实现 idempotency processing orphan takeover；相同 digest 新 claimToken 接管，旧 token 不能提交。

### 必测

- 同一 Idempotency-Key 同请求重放；
- 同 key 不同请求 409；
- quote 过期、跨用户、重复消费；
- 自定义金额 min/max/step/日月限额；
- 两个并发订单合计超限时最多一个创建成功；
- provider/account/method capability 变化返回 RECHARGE_QUOTE_CHANGED；
- duplicate complete、capture unknown/query recovery、伪造浏览器 complete 不入账；
- form_post 结构化字段、HTTPS allowlist、大小上限和禁止 HTML；
- non-terminal attempt 未确认关闭时取消/过期不释放 reservation；
- processing 幂等记录超时接管与旧 claimToken 拒绝提交；
- 同一订单只能有一个 active attempt；
- `isProductionDeploy` 不注册 Simulator 控制端点；
- 用户不能读取他人充值订单。

限额 reservation、quote/order CAS、幂等 claim 和取消竞态测试必须运行于真实 PostgreSQL，不得只用 mock repository。PR-C 合并前，PR-B 产生的 successful observation 可以保持待处理，但充值功能必须继续 disabled；PR-B 只实现 observation 持久化，不得临时实现第二套 mark-paid 逻辑。

## 6. PR-C：事件处理、积分入账、退款、争议和对账核心

### 前置

PR-B 已合并并更新基线。

### 所有权

- `server/src/modules/payment/events/**`
- `server/src/modules/payment/workers/**`
- `server/src/modules/recharge/credit.ts`
- `server/src/modules/recharge/refund.ts`
- `server/src/modules/payment/disputes/**`
- `server/src/modules/payment/reconciliation/**`
- `server/src/app.ts` 的 webhook-before-body-parser/limiter 最小接线
- `server/src/main.ts` 的 worker start/stop 最小接线
- 本范围 admin 子路由及其既有 admin router 接线
- 为执行 AccountRestriction 所必需的现有订单/checkout value-bearing 路径
- 必要的 point/account helper 最小修改

### 工作内容

1. 复用 PR-B 的 `recordPaymentObservation`，实现 webhook event 的有界读取，以及 webhook/query/complete/reconciliation 共用的去重和租约 worker；不得另写 observation 插入逻辑。
2. 实现唯一 `applyConfirmedPayment(observationId)`，所有 observation source 通过它执行主 Spec 8.1 的“确认支付事务 + RechargeCreditTask + 可恢复积分入账事务”。
3. `RechargeCredit.businessEventKey` 和 order/payment 唯一约束必须是幂等最终防线。
4. 实现主动查询恢复：未知创建结果、回调缺失、paid-not-credited；query 结果先写 observation，不直接更新 paid。
5. 实现退款 PointHold、唯一 RechargeReversal、渠道退款状态机、成功消耗和失败释放。
6. 实现 PaymentRecoveryCase、争议 PointHold、消费/充值限制和显式结案。
7. 实现 reconciliation 核心与 provider 可选能力，不在本 PR 实现四家渠道细节。
8. 所有 worker 使用 lease token；过期 owner 不能提交。
9. 通知只通过事务 outbox 或等价提交后机制发送。
10. webhook 路由在全局 `express.json()` 和通用 `/api` limiter 前挂载，使用 provider 所需 raw/form parser 与独立限流。
11. 管理 API 复用现有 `authenticate -> requireActiveUser -> requireAdmin -> requireAdminMfa` 边界，不新建管理员认证体系。
12. 实现 terminal cancelled/expired/failed 后迟到 succeeded 的 reconcile 路径；保留支付事实，不自动 credit/refund 或改写 released quota。

### 必测

- 100 个重复事件只入账一次；
- webhook/query/admin reconcile 三路并发只入账一次；
- webhook/query/complete/reconciliation 四类 observation 共享同一 apply 核心；
- 事务在每一个写入点失败时全部回滚；
- 两个 worker claim、lease 过期接管；
- paid 后 worker 崩溃恢复；
- 两个 provider 意外成功只 credit 一次；
- closure_pending 与 succeeded 并发时支付成功获胜并消费 quota；
- terminal cancelled/expired/failed 后迟到 succeeded 只进入 reconcile；
- 退款余额不足不调用 provider；
- refund success/failure 重复与乱序；
- refund webhook/query/reconcile 并发只创建一个 RechargeReversal；
- dispute 不制造负余额，胜诉/败诉/核销均可显式结案；
- 以上事务测试必须运行于真实 PostgreSQL，不得只用 mock repository。

## 7. PR-D1：Stripe adapter

### 前置

PR-C 已合并。Agent 只修改 `server/src/modules/payment/providers/stripe/**`、该 provider 的导出文件、Stripe 测试，并可提出/修改本 provider 所需的 `server/package.json` 依赖；不修改共享 provider registry，最终接线由 PR-F 负责。Provider 源码可并行开发，但本 PR 进入最终 CI 前必须 rebase 最新 develop，并按第 14 节规则串行完成 lockfile finalization。

### 工作内容

- 使用官方 Stripe Node SDK；
- 首选 hosted Checkout；
- stable idempotency key；
- raw body `Stripe-Signature` 验签；
- PaymentIntent/Checkout 状态规范化；
- query、close、full refund、refund query；
- dispute event；
- account/mode/currency/minimum capability；
- test/live endpoint 与 key 隔离。

### 必测

- Stripe 官方/SDK fixture 的验签成功与失败；
- `checkout.session.completed` 但未 paid 不 credit；
- `payment_intent.succeeded` 金额/币种/metadata 不匹配；
- 重复 event ID；
- idempotency key 稳定；
- test key 在 production live 配置中被拒绝。

没有 Stripe test credentials 时，contract tests 是合并条件；真实 test-mode E2E 记录为待运行项，不阻塞核心合并，也不得声称已运行。

## 8. PR-D2：PayPal adapter

### 前置与所有权

同 PR-D1，只修改 `providers/paypal/**`、该 provider 的导出文件、PayPal 测试并可提出/修改本 provider 的 `server/package.json` 依赖；不修改共享 provider registry。dependency/lockfile finalization 遵守第 14 节串行规则。

### 工作内容

- Orders v2 create/capture/query；
- V1 使用 Orders API `rel=approve` URL 的 redirect approval，不使用 PayPal JavaScript SDK/provider_sdk；
- 通过核心 `completePayment()` 合同承接买家批准后的服务端 capture；
- stable `PayPal-Request-Id`；
- webhook signature verification；
- `PAYMENT.CAPTURE.COMPLETED` 等状态规范化；
- full refund/query；
- sandbox/live credentials 与 endpoint 隔离。

### 必测

- capture 不是 COMPLETED 不 credit；
- duplicate complete 复用同一 `PayPal-Request-Id`；
- capture 超时/unknown 先 query，不盲目重发；
- 伪造 return URL 或直接请求 complete 不 credit；
- authenticated capture/query 先生成 PaymentObservation，再进入统一 apply 核心；
- amount/currency/payee/order mismatch；
- 重复/延迟 webhook；
- webhook 非法签名；
- API 超时后 query 收敛；
- sandbox credential 在 live 被拒绝。

## 9. PR-D3：微信支付 adapter

### 前置与所有权

同 PR-D1，只修改 `providers/wechatPay/**`、该 provider 的导出文件、微信支付测试并可提出/修改本 provider 的 `server/package.json` 依赖；不修改共享 provider registry。dependency/lockfile finalization 遵守第 14 节串行规则。

### 工作内容

- Native 下单和二维码 action；
- API v3 请求签名及响应验签，优先官方库；
- 支付回调验签、AES-GCM 解密和规范化；
- 查询订单、关闭订单；
- full refund、退款查询和退款通知；
- 商户号/appid/order/transaction/amount/currency 完整匹配；
- 无凭据时 disabled。

### 必测

- 官方示例/固定 fixture 的签名与解密；
- 回调重复与 15 次重试语义；
- `out_trade_no` 稳定且符合长度字符集；
- total 为分、CNY、必须大于零；
- refund retry 复用 `out_refund_no`；
- refund accepted 不等于 succeeded。

不要虚构通用 sandbox。没有商户测试环境时明确只完成协议 fixture 测试。

## 10. PR-D4：支付宝 adapter

### 前置与所有权

同 PR-D1，只修改 `providers/alipay/**`、该 provider 的导出文件、支付宝测试并可提出/修改本 provider 的 `server/package.json` 依赖；不修改共享 provider registry。dependency/lockfile finalization 遵守第 14 节串行规则。

### 工作内容

- WAP 和 PC Web 的结构化 form_post action；
- 官方 SDK 请求签名和异步通知验签；
- `amountMinor` 与元字符串双向精确转换；
- `alipay.trade.query`、close、refund 和 refund query；
- app/seller/order/trade/amount/status 完整匹配；
- sandbox/live app、gateway、证书隔离。

### 必测

- 1/10/100/101 分格式转换无浮点；
- form body 验签成功/失败；
- actionUrl HTTPS allowlist、字段大小上限和禁止完整 HTML；
- 同一 `notify_id` 重放；
- callback 丢失后 query 收敛；
- 部分退款不误判整单退款；
- sandbox 配置在 live 被拒绝。

## 11. PR-E：用户与管理端界面

### 前置

PR-B API 已稳定后即可开始，并可与 PR-C/渠道 PR 并行。管理端退款、争议和对账部分合并前必须 rebase PR-C 的最终 API，不得在前端自行发明状态。

### 所有权

- `src/pages/RechargePage.tsx` 及充值子组件
- `src/api/recharge.ts`
- `src/App.tsx` 的 `/recharge` 路由接线
- Profile/Layout 的最小入口文件
- Admin recharge/payment 子页面
- 既有 Admin tab 接线文件
- 前端 unit/Playwright 测试

### 工作内容

1. `/recharge` 页面包含推荐金额、自定义金额、币种、报价和支付方式。
2. 输入框按币种格式化，但提交服务端的是十进制 `amountMinor` 字符串。
3. 服务端 min/max/step 是权威，前端不硬编码。
4. 支付 action 支持 redirect、QR、client secret 和结构化 form_post；V1 不加载 PayPal JS SDK，不接收可执行 HTML。
5. 结果页轮询本地订单；不能信任 URL success 参数。
6. Profile 添加入口，成功后刷新现有 auth points。
7. 管理端实现订单、事件、退款、争议、对账视图。
8. 不显示原始 webhook、密钥或完整付款人标识。

### 必测

- mobile/desktop 自定义金额；
- CNY 0.01/0.10 被拒、1.00 可提交；USD 同理；
- quote loading/expired/changed；
- redirect return 仍显示确认中直到服务端 credited；
- PayPal approval redirect 返回后调用 complete，但不把 return URL 当支付证据；
- 支付宝 form_post 使用结构化 actionUrl/method/fields 安全构造表单；
- disabled/无 provider/失败/退款状态；
- 无按钮溢出、遮挡和金额截断。

## 12. PR-F：Provider 收口、运维、告警与集成测试

### 工作内容

- 实现主 Spec 第 11 节 bounded metrics，包括按 source 聚合的 payment observation 和迟到支付告警；
- 由唯一 integration Agent 完成四个 provider 的共享 registry 接线、manifest/lockfile 一致性检查和遗留 dependency 冲突收口；
- Prometheus rules 和 alert contract 静态测试；
- provider 熔断、paid-not-credited、observation 重放、迟到支付、退款和对账 runbook；
- raw payload 默认 30 天清理 job，并为 open dispute/refund/reconciliation 实现结案后 180 天的延长保留；
- 管理修复审计；
- provider contract test harness；
- Simulator 全链路 Playwright；
- 并发和故障注入测试；
- 备份/恢复覆盖新增表；
- OpenAPI 或现有 API 文档更新。

本 PR 不部署真实告警接收人、不启用 live 充值、不写生产数据库。

## 13. PR-G：最终集成与 staging rehearsal

### 工作内容

1. 从最新 develop 合并所有已完成 PR。
2. 检查 migration 顺序和 provider registry 冲突。
3. 运行完整 backend、frontend 和 Playwright CI。
4. 在 staging 使用 Simulator 完成：quote -> pay -> duplicate webhook -> credit -> refund -> dispute -> reconciliation。
5. 如提供 Stripe test/PayPal sandbox credentials，再运行其官方测试环境 E2E；未提供则明确跳过。
6. 验证 production 配置只能 `RECHARGE_MODE=disabled`，Simulator 启动失败。
7. 更新 `README.md` 和 `README.zh-CN.md`：不再声称充值永久 out of scope，准确说明充值模块存在，但 live provider 在缺少凭据/商户资质时保持 disabled。
8. 输出最终 evidence，不部署或启用 live provider。

## 14. 多 Agent 协作规则

- 一个 Agent 负责一个 PR 和明确文件所有权；
- Provider Agent 不修改充值核心状态机或共享 registry；发现接口缺口时先提出最小 contract change；
- D1-D4 可以并行修改各自 provider 源码、测试、导出，并提出/修改各自所需的 `server/package.json` 依赖；
- 任一时刻只允许一个 Provider PR rebase 最新 develop、重新生成并 finalize `server/package-lock.json`、运行最终 CI；前一个完成后下一个再进行；
- 每个 Provider PR 在最终 CI/合并前都必须基于最新 develop 重新生成 lockfile，不能保留并行开发时的陈旧 lock；
- 只有 PR-F integration Agent 修改共享 provider registry，并负责最终 manifest/lockfile/registry 一致性收口；
- 不回滚其他 Agent 的 migration、测试或文档；
- 每个 PR rebase/merge 最新 develop 后再做最终验证；
- 不让两个 Vitest 进程并行使用同一个 PostgreSQL 测试库；
- 外部凭据不得粘贴进 Agent 对话、日志、fixture 或 PR；
- 任何真实渠道调用必须由用户明确提供 sandbox/test 凭据与环境，默认只做本地 fixture。

## 15. 实施 Agent 通用 Prompt

```text
你负责实施 SPEC-RECHARGE-PAYMENT-V1.2 的 <PR-ID/范围>。

必须先完整阅读：
1. docs/specs/recharge-payment-platform-v1.md
2. docs/specs/recharge-payment-platform-v1.plan.md
3. 与你范围相关的现有 schema、模块和测试

从最新 origin/develop 创建隔离 worktree 和功能分支。你不是仓库中唯一工作的 Agent，不得覆盖或回滚其他人的改动。严格遵守本计划列出的文件所有权；需要修改共享合同但不在所有权内时，先记录阻断和最小变更建议。

实施要求：
- 完成代码、additive migration（若本范围需要）、测试和必要文档；
- 不修改历史 migration，不使用 prisma db push；
- 金额只使用 BigInt/十进制字符串，不使用浮点；
- 不接触生产数据库，不启用 live provider，不放入任何真实密钥；
- Simulator 在主 Spec 定义的 isProductionDeploy 必须 fail closed；NODE_ENV=production + MONEXUS_DEPLOY_ENV=staging 允许 Simulator，但不得降低既有 Cookie/MFA 安全；
- 不增加产品/法务签字、DOCX 或人工会签门禁；
- 不把未运行的 sandbox/live 测试写成通过；
- 遇到共享 monexus_test 时独占运行，不与其他 Agent 的 Vitest 并行。

完成后提交本地 commit，并报告：
1. 基线、分支、commit、worktree 和 clean 状态；
2. 修改文件与关键设计；
3. 状态机、唯一约束和幂等证明；
4. 运行的每条命令、退出码和测试数量；
5. 未运行项及原因；
6. 已知风险和后续依赖；
7. push/PR/merge/deploy/live activation 是否发生。

除非用户另行授权，不 push、不建 PR、不部署、不启用任何真实支付渠道。
```

## 16. Review 清单

实施结果回报后，review 优先检查：

- 是否出现 controller 直接加积分；
- 是否把前端 return URL 当支付成功；
- 是否缺少 PayPal buyer approval 后的服务端 complete/capture，或由浏览器 complete 直接入账；
- 是否 PayPal V1 擅自引入 JS SDK/provider_sdk，而不是冻结的 approval redirect；
- 是否 query/complete/reconciliation 绕过 PaymentObservation 和统一 apply 核心直接标 paid；
- 是否缺少 `(provider,eventId)`、provider payment ID 或 `RechargeCredit` 唯一约束；
- 是否金额使用 `number`/浮点；
- 是否渠道金额、币种、merchant/app ID 未完整核对；
- 是否 API 超时后盲重试创建/capture/refund；
- 是否先退款再扣/冻结积分；
- 是否 quote 占额，或订单创建未原子预留日/月额度；
- 是否 non-terminal provider attempt 未 close/query 就释放 reservation；
- 是否 terminal 订单迟到支付被自动 credit/refund；
- 是否 Simulator 能在 `isProductionDeploy` 启用；
- 是否日志、Sentry 或管理 UI 泄露 secret/raw payload/PII；
- 是否把 Stripe/PayPal/微信/支付宝专有状态泄漏进核心状态机；
- 是否没有 paid-not-credited 恢复和对账路径；
- 是否为了通过测试关闭 trigger、删除约束或修改历史 migration。
