# 签名 v2 与 AstrBot 接入契约

日期：2026-10-25。状态：B0 已有两端签名、插件只读接口和 MoNexus 桥接客户端，隔离定向验证通过，未部署。B1 已挂载 MoNexus QQ v2 查询、默认选择路由及账号回填，查询默认关闭；第五批 B2 已挂载免费确认/进度路由并实现独立 outbox；插件 1.7.0 提供原生重置/状态/取消，两端默认关闭、未部署。插件接口的本地契约见 [v2 只读协议](https://github.com/amo0114/Mo-lab/blob/feat/qq-xboard-v2-read-20261025/docs/fakabridge-v2-read-contract.md)。

## 1. 请求签名

实现：`server/src/lib/signedProtocolV2.ts`。`prepareSignedJsonV2()` 只序列化一次，请求方必须原样发送返回的 `body`。接收方使用实际收到的原始 UTF-8 字节验签，不从解析对象重新构造 body。

| HTTP 头 | 约定 |
| --- | --- |
| `content-type` | `application/json` |
| `x-monexus-signature-version` | 字符串 `2` |
| `x-monexus-timestamp` | 非负安全整数毫秒时间戳的十进制表示 |
| `x-monexus-nonce` | 16 字节随机数，32 位小写十六进制 |
| `x-monexus-signature` | 64 位小写十六进制 HMAC-SHA256 |

```text
bodyHash = lowercase_hex(SHA256(raw_body_bytes))
payload = compact_JSON_UTF8([
  "monexus-hmac-v2", audience, "POST", fullPath,
  timestampMs_as_number, nonce, bodyHash
])
signature = lowercase_hex(HMAC_SHA256(link_secret, payload))
```

`audience=bot` 对应 `/api/bot/v2/xboard/<action>`，`audience=xboard` 对应 `/plugin/faka-bridge/v2/<action>`。路径为网关对外完整路径，不能使用 Express 剥离 mount 后的 `req.path`。只允许由小写 ASCII 字母、数字、连字符组成的非空路径段，总长最多 200 字符；拒绝 query、百分号编码、双斜杠、尾斜杠及非 POST 请求。HTTP 接入层还须校验方法、版本头、唯一头值与时间戳格式，不能只传入硬编码的预期值。

验签时间窗为前后各 300000ms，边界包含在内；签名比较使用常量时间函数。两条链路分别使用 bot secret 与 bridge secret，Xboard 密钥不进入 AstrBot。helper 不读取环境、不产生网络请求、不处理 keyId 轮换。

跨语言注意：签名 envelope 使用无空白 JSON；上述 envelope 字符串全部为 ASCII。body 可以使用 Python/PHP 各自的合法 JSON 编码，只要最终发送的原始字节与计算 bodyHash 的字节完全相同。不要要求 body 的键排序或中文转义方式相同。时间戳必须为数字，而不是 envelope 内的字符串。

测试向量：`server/src/__tests__/fixtures/signed-protocol-v2.json`，包括中文 UTF-8 bot body 与空对象 Xboard body，记录原文、hash、payload、signature。向量由独立 Python hashlib/hmac 计算，并由 TypeScript 测试逐项校验；其中密钥仅供测试。后续 PHP/Python 适配必须复用同一向量。

## 2. 接入层尚需完成的保护

`verifyProtocolV2()` 只验证签名、envelope 和时间窗，**不能单独用作执行授权**。后续接入依次需要：

以下是接入要求。B1 bot 查询接收端已落实 1–4 项（选择默认账号的 requestId 幂等）；插件只读端使用数据库 nonce，bot 接收端使用 Redis。详情见第 5、6 节。B2 已实现免费执行业务幂等及数据库持久化，见第 7 节。

1. 在保持支付 webhook 原始 body 解析顺序的前提下，限定 v2 原始 body 大小并捕获 bytes；严格解析版本/时间戳/nonce/signature。
2. 验签成功后，以链路、密钥身份和 nonce 原子去重；去重保留时间须覆盖从最早可接受时间到最晚可接受时间（至少两倍时间窗并留裕量）。存储不可用时拒绝受保护请求，不跳过防重放。
3. 严格 DTO 校验，解析实际 QQ 绑定，检查当前用户状态与资源归属。机器人不能传任意站内 userId、邮箱或远端 URL 查号。
4. 同一业务重试使用新 nonce，保留签名 body 内的 requestId/operationId。数据库唯一约束与语义 hash 提供业务幂等；不能使用 nonce 代替。
5. 只有插件能力、稳定账号关联、权益及远端幂等都通过验证后才挂载免费执行接口。当前 helper 不会发放或消费机会。

## 3. AstrBot + NapCat 接法

用户已确认运行栈。新增 AstrBot 业务插件负责命令、可信身份及调用 MoNexus；NapCat 负责 QQ 连接，不持有 Xboard 密钥。AstrBot 插件的支持平台声明使用 `aiocqhttp`，业务 API 中则统一发送 `platform: "qq"`。这两个字符串含义不同。

QQ 身份从平台事件 `event.get_sender_id()` 获取。`get_group_id()` 是群号，`get_session_id()` 是会话标识，均不能作为 platformId；禁止从“查流量 123456”之类命令文本接受任意 QQ 身份。使用异步 HTTP 客户端并设置超时。后台重试保留原 requestId，显式新命令生成新的业务 requestId。

命令按主方案注册：查询、选择账号、次数、发起确认、确认、进度、购买链接。群聊只返回脱敏摘要，详细账号和确认提示优先由用户发起私聊；用户没有完成既有 QQ 绑定时，引导站内绑定，不要求重新绑定 Xboard 邮箱。初期插件保持查询/执行分别关闭，不能在后端路由尚未交付时给出虚假的查询或成功回复。

依据（2026-10-25 查阅）：[AstrBot 插件开发文档](https://docs.astrbot.app/dev/star/plugin-new.html)、[AstrMessageEvent 官方源码](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/platform/astr_message_event.py)。这些是接入 API 的依据，不是现用插件版本证明。

## 4. 首次 Xboard 本地核验结果

本地只读核验 `Mo-lab main@167e7f7fe8cad51c0b1580e4869a66d9284a5950`：

- `faka_orders.external_order_no → xboard_trade_no` 已存在，可进一步通过核心订单的 user_id 解析稳定用户；现有公开状态接口仍按邮箱查询，不能当作稳定 ID 查询接口。
- `snapshotUserSubscription(User)` 已读取 transfer_enable/u/d/plan_id/expired_at，可复用快照逻辑。
- 插件 config 标记 1.5.0、类常量标记 1.3.1，尚未修改；本地 Provider 不足以证明新 migration 的实际加载方式。
- 文档只有浮动镜像 tag `ghcr.io/cedar2025/xboard:new`。用户补充“最新版”，仍未拿到实际部署 digest/commit；不能把当前上游 master 或本地插件视为线上版本。

上述是原插件基线。后续一批已创建独立插件 worktree，完成以下只读代码；仍未访问生产、回填账号、发放权益或执行流量重置。

## 5. 第三批已实现的只读桥接

- 插件 worktree：`/root/.codex/worktrees/19af/Mo-lab`，分支 `feat/qq-xboard-v2-read-20261025`，基线 `167e7f7`；原 Mo-lab 保持干净。插件配置/类常量统一为 1.6.0。
- 三个 POST 路由 `capabilities/user-resolve/user-subscription`，原始 bytes 验签、严格字段/头/路径、数据库共享 nonce 原子占用及过期清理。表或存储缺失拒绝请求，签名时间窗完整覆盖。v2 每次从数据库读取一次配置快照，关闭查询/换密钥可绕过常驻 worker 的旧缓存。
- 默认 `v2_read_enabled=false`。能力只宣告实际只读分支，所有重置/取消/付费 v2 能力均为 false。能力响应包含插件版本、构建摘要和核心适配名称。
- 解析历史 `external_order_no → trade_no → Order.user_id → User.id`；无订单/成功证据/原用户时返回未决，不使用邮箱回退。已成功后撤销的历史可以提供关联事实，不能据此发放赠送。
- 当前订阅仅按稳定 ID 读，返回有限字段；字节和 ID 使用十进制字符串，字符串算术避免 PHP64溢出，MoNexus 用 BigInt 复核。保留 expires_at 的 0/null 区别；核心 reset_count 不是赠送次数。
- MoNexus 新 `lib/fakaBridge/accountV2.ts` 复用既有 URL/密钥/transport/timeout，只派生固定 v2 路径。严格解析成功/错误响应并核对 request ID、订单号、用户 ID；失败只返回有限错误码，拒绝输出远端原文/PII。未把这些 transport 函数挂到用户路由。

本地固定测试镜像为 `ghcr.io/cedar2025/xboard@sha256:2633d6085768c57b5234b165a57569502728a795888602a7c233ccd3d4eb47b8`，revision `935522d28bbeb666824facd8bdd674db8ab37df1`（PHP 8.2.35 / Laravel 12.54.1）。这是本次从 `:new` 拉取的隔离测试基线，仍不是线上 digest 证明。

验证使用镜像真实 Laravel/Eloquent/路由器/PluginManager、SQLite 内存夹具，覆盖插件迁移/安装/升级及关键查询边界；未启动完整 Kernel/Octane/Horizon，未验证 MySQL 并发或线上部署。剩余工作是 B1 本地关联模型/可信来源回填/QQ 授权查询，以及部署一致联调；B2 还须验证原生重置事务及并发契约。

## 6. B1 QQ 只读接收端

新增三个固定 POST 路径：

| 路径 | 严格 JSON body | 已绑定成功响应 |
| --- | --- | --- |
| `/api/bot/v2/xboard/accounts` | `{platform:"qq",platformId}` | 本人脱敏账号列表、默认引用、truncated、associationStatus |
| `/api/bot/v2/xboard/profile` | 上述字段 + 可选 `accountLinkId` UUID | 当前套餐/精确流量/原生次数/快照时间与故障标记 |
| `/api/bot/v2/xboard/select-default` | 上述身份 + `accountLinkId`、`requestId` UUID | selectedAccountLinkId、appliedAt、replayed |

无绑定统一 `{bound:false}`，有绑定 `bound:true`。platformId 仅允许 5–20 位非零开头数字，由可信 sender 取得。拒绝附加 userId、邮箱、URL；全量 DTO 见 OpenAPI。群聊/私聊来源不在此 DTO 中，持有 bot 密钥的适配器须执行群聊脱敏边界，不能仅凭后端脱敏邮箱就把全部套餐详情发到群里。

HTTP raw parser <=8KiB、禁止压缩，验签后才使用 fatal UTF-8 解码和 JSON 解析。四个签名头必须各出现一次；真实方法与 originalUrl 参与签名，query/尾斜杠不被规范化接受。Redis 原子 `SET NX PX 601000`，nonce key 使用密钥 HMAC，不含明文 QQ；Redis 不可用返回 503，重放 409。共享主机 600/分钟和绑定用户 10/分钟，所有响应 no-store。

查询复核当前 ChatBinding ID、QQ、买家、站内状态及 link 归属，返回前重验；远端等待期间解绑或发生归属冲突将拒绝旧结果。跨用户/实例 link 404，多账号未选默认 409。选择按 `(userId,instanceId,requestId)` 记录，异参/换绑重用 409，旧选择重试不会把后来选的默认改回去。

能力与当前流量各缓存 15 秒，瞬时故障仅可返回收到不超过 60 秒的旧流量并标记 stale/unavailable；明确能力关闭/鉴权失败不使用旧快照。没有有效流量返回 subscription=null，未知不显示 0。所有数字字节为十进制字符串，到期 0/null 保留；原生 reset_count 在 resetHistory.xboardAllSources 下返回，不能显示成赠送次数。B1 的 freeReset 与本平台成功次数为 null，canFreeReset=false。

新增配置 `XBOARD_ACCOUNT_QUERY_ENABLED=false` 与稳定 `XBOARD_INSTANCE_ID`；启用查询需同时存在桥接 URL/密钥、bot 密钥和 Redis。独立批处理可在开关关闭时先恢复账号。实现与操作说明见 [xboardAccounts README](../../../server/src/modules/xboardAccounts/README.md)。当前未部署 AstrBot 业务插件，也未完成真实 QQ 会话验收。

## 7. B2 已交付的本地契约

新增 `/api/bot/v2/xboard/reset-intents`（accountLinkId?、requestId）、`resets`（intentId、confirmationCode、requestId）、`reset-status`（operationId），均携带原 QQ 身份字段并沿用相同原始字节签名/nonce/授权。未绑定返回 200 bound=false，已绑定确认返回 202 operationId/status/replayed。202 表示接受，查询 status 才能判断成功。具体 schema/错误见 OpenAPI。

意图 120 秒、6 位 Base32、最多 5 次错误，冻结原绑定/账号；业务重试换 nonce 不换 requestId。同意图确认始终回同一操作，重放时新增 requestId 也被记录，禁止后来挪给别的意图。插件 payload_hash 及订阅 fingerprint 的独立 Python 固定向量在两仓库 fixtures/traffic-reset-v2.json，逐字一致。

远端新增 traffic-reset-preview/traffic-reset/traffic-reset-status/traffic-reset-cancel；固定 operation/actor/user/benefit/plan/fingerprint，request_id 仅关联本次 HTTP 响应。unknown/not_found 不释放预占；取消 tombstone 与执行通过同一行锁裁决。新请求、发放及派发分开关闭，已有操作仍须继续对账。

实际原生写能力需要固定摘要核心补丁及受支持事务存储，不能只升级插件就打开。第十三批已针对实证的生产SQLite/WAL增加同文件、先写锁后快照的适配；MySQL继续要求InnoDB。文件型SQLite多进程/真实SIGKILL与MySQL定向验证见 [插件免费重置契约](https://github.com/amo0114/Mo-lab/blob/feat/qq-xboard-v2-read-20261025/docs/fakabridge-v2-reset-contract.md) 和 [B2模块说明](../../../server/src/modules/trafficReset/README.md)。生产基础digest已核对，B3各本地阶段已完成；新补丁/迁移未部署，真实Kernel/Octane/Horizon/QQ验收仍待完成，所有执行开关默认关闭。

## 8. B3a AstrBot 可安装适配器

代码位于 Mo-lab worktree 的 astrbot-plugins/astrbot_plugin_monexus_xboard，独立分发，未安装或发送真实消息。只支持 aiocqhttp，通过真实 event.get_sender_id() 取 QQ；所有命令群聊统一提示主动私聊，群聊不查后端，不自动私信。注册查询、账号/序号选择、免费次数、发起/确认、进度；购买命令当前明确未开放，等待 B3b。

新增 POST `/api/bot/v2/xboard/reset-intent-status`，严格 body 为 platform/platformId/intentId，响应 `{bound:true,intentId,operation:<现有 reset-status DTO 去掉 bound>|null}`。只限本人、当前原 QQ binding 和实例；过期后及关闭新请求/派发后仍可读。只查询本地，不发远端请求、不改变余额。null 仅是尚未观察到已提交 operation，不能据此释放、重建或判断失败。未绑定仍 bound=false，其他用户/实例/旧绑定统一 404。

该接口解决“确认已接受但响应丢失、机器人不知道 operationId”的恢复窗口；无需拿旧码做新的确认也能只读找回，停止新免费重置后仍能使用。机器人 SQLite 上下文置于 AstrBot data/plugin_data，按站点/QQ 分开，保存目标、意图、业务请求和 operation ID，不保存明文确认码。网络重试原 body/requestId、每次 fresh nonce；同用户本机串行，结果不确定阻止新意图。

配置与测试/安装包见 [适配器 README](https://github.com/amo0114/Mo-lab/blob/feat/qq-xboard-v2-read-20261025/astrbot-plugins/astrbot_plugin_monexus_xboard/README.md)。查询/免费执行默认 false；本机 API doubles、受控 HTTP transport 不能冒充真实 AstrBot/NapCat 验收。已确认商业 reset 的稳定 ID 结账/履约、满额门槛及核心 native false 检查仍需 B3b，本轮没有打开错误邮箱购买路径。

## 9. B3b1 稳定账号付费商业协议

插件当前版本 1.8.0；新增 `paid-reset-preview`、`paid-reset`、`paid-reset-status`、`paid-reset-revoke`，均使用既有 v2 签名。MoNexus `lib/fakaBridge/paidResetV2.ts` 提供严格 transport，还未挂到网站或机器人路由。完整 DTO、语义 hash、状态和取消/退款约束见 [付费契约](https://github.com/amo0114/Mo-lab/blob/feat/qq-xboard-v2-read-20261025/docs/fakabridge-v2-paid-reset-contract.md)。这是 B3b 的第一步，不表示已完成付费闭环。

2026-10-25 第八批 B3b2 已将该 transport 接入商业 outbox、worker、退款和对账。任务显式选择 protocol 2，数据库冻结账号/实例/来源/plan/client/SKU 等身份，`paidResetResult` 保存原始十进制执行证据，`resultVersion` 纳入租约及对账快照 CAS。新执行前检查归属和用户状态，核对/撤销不依赖 link 仍然 active。重试先 status，unknown/404/not_found 保留冻结积分；耗尽后必须取得 revoke tombstone 才自动退款，明确 failed 可终结退款。已观察的执行证据不允许被后续空 tombstone 或不同快照抹除。详情见 [商业模块说明](../../../server/src/modules/fakaBridge/README.md#stable-account-paid-resets-b3b2)。该批结束时下单调用尚未传入 paidReset；第九批 B3b3 已接入以下网站分支。旧任务仍为 v1，QQ 购买命令仍未开放。

新执行仅作用于稳定 user_id 对应的当前有效套餐；SKU 必须映射到相同 plan 的 reset_traffic，正常新购容量不参与该分支。沿用核心正常商业订单生命周期，外层同事务校验原生实际清零、次数 +1、日志 +1、套餐与到期不变，拒绝核心忽略 native false 的假完成。默认 `v2_paid_reset_enabled=false`；paid_reset_by_user_id 仅在开关、事务表及精确原生/商业核心摘要均符合时为 true，线上版本仍待核对。

order_no/client/user/SKU/plan/period 的语义 hash 冻结，HTTP request_id 只关联本次响应。执行和撤销锁同一唯一行；未知撤销写 tombstone，迟到执行不得越过；执行后退款保留成功证据但不使原套餐过期。status 不按邮箱或最新流量重建历史，not_found 不是可退款的证明。v1 拒绝读取/支付/撤销 v2 订单。两端 fixture `paid-reset-v2.json` 逐字一致。

## 10. B3b3 网站稳定账号结账

独立开关 `XBOARD_PAID_RESET_TARGET_V2_ENABLED=false`；开启需固定实例和桥接 URL/密钥，不依赖 QQ、查询、免费重置开关或 Redis。只有 Faka 自动履约、受支持的 `plan-<正 SQL INT>-reset_traffic/reset_price` SKU 进入新分支。其他 SKU/开关关闭保持旧路径；不把已有 v1 任务切换成 v2。

JWT `GET /api/checkout/preview?productId=…&offerId=…&xboardAccountLinkId=<UUID>` 返回可选 `xboardPaidReset`：本人脱敏账号选择、选定 UUID、不透明 `targetVersion`、eligible/blockReason。单账号可自动选中，多账号必须显式选，不读取他人账号、不按邮箱回退。选择和预览均 no-store，不向浏览器暴露远端 user_id/完整邮箱。目标在最多 100 个可见选择内；显式选择的本人账号即使超出列表上限也纳入返回。

`POST /api/orders` 新增成对字段 `xboardAccountLinkId` / `expectedXboardTargetVersion`，新分支必须同时带幂等键。版本是站内用户、offer、link、实例、origin、remote user、plan、client 与 SKU 的语义 HMAC；它不代替归属授权。新鲜 capability/远端 preview 在事务外查询，返回后重验目标；订单事务内以 link 共享锁再验所有语义并保持至 v2 task 插入。相同 key 的已成功原请求优先回放，目标改变导致指纹冲突，未带新字段的旧请求保留原指纹字节。

仅此分支移除 Xboard 邮箱表单/OTP 和新增订阅人数限制；保留原始表单版本校验、非邮箱字段、正常用户、本站已验证邮箱、权限、报价、库存/限购与付款验证。公共投影仅表达本地可售性，不泄露私人资格；启用开关使用独立投影缓存命名空间。新建任务固定 canonical reset_traffic，付费不消耗或补发赠送权益。

网站切换账号重取报价、更新幂等意图并取消旧确认，失败重试保留原意图。URL 保留 offer/account 至登录、充值与重新报价；过期关联可主动“重新选择账号”，不默默改投其他账号。仍需 QQ 正确 Offer 购买链接、有覆盖范围的付费次数、部署版本一致及真实会话验收。未知 v2 结果不得降级邮箱或按 404 自动退款。关闭新结账开关不会停止原任务 status/revoke；旧受信来源、client、密钥和存储须保持至对账完成。


## 11. B3b4 QQ 购买引用与执行次数

新增签名 POST `/api/bot/v2/xboard/purchase-reset`，严格 body `{platform:"qq",platformId,accountLinkId?:UUID}`；复用 nonce/限流/当前绑定/no-store，无绑定仍 bound=false。需要查询和稳定账号付费结账开关；不依赖免费发放/请求开关。多账号按现有本人默认选择规则，无有效选择时409。直接新鲜读取稳定 ID 当前 plan，精确匹配规范化 reset_traffic/reset_price，不拿缓存 plan、注册邮箱、默认月付规格替代。

先过滤 active 商品/规格、未归档、active 商家、本地库存和 manual_service/Faka 配置；按规范化 SKU 最多取两种候选，另一规格不可售时继续尝试。对候选调用新鲜付费能力/预览，远端返回后重验绑定、稳定目标与商品状态。返回 `{bound:true,accountLinkId,purchase:{productId,offerId,accountLinkId,price}|null,blockReason:null|"NO_OFFER"|"SUBSCRIPTION_INELIGIBLE"}`，不返回任意 URL、SKU、邮箱或远端 ID，不创建订单或扣款。网站结账仍负责全部正式验证和报价。

AstrBot 0.2.0 的 `paid_reset_purchase_enabled=false` 与免费执行独立。私聊“购买重置”先解析当前账号，再用该明确 UUID 请求引用；严格校验 ID/价格/账号一致，在本地已配置 HTTPS origin 下构造 `/product/<id>?offerId=<id>&xboardAccountLinkId=<UUID>`。拒绝任意 URL 字段、非整数 ID 和串号；群聊零后端调用，账号切换未确认时先恢复选择。

profile.resetHistory 更新：`freeSuccessfulForAccount` 是本地当前账号免费 v2 succeeded 数，`paidSuccessfulForAccount` 是当前实例/origin/稳定远端账号/买家下的付费 v2 已核实执行数，`platformSuccessfulForAccount` 为其和，`coverageScope="verified_v2_only"`，新增 `truncated:boolean`。不依赖付费新请求开关；状态为 completed 或保留完整执行证据的 revoked 才能计入。读取时复验 frozen order/user/SKU/plan/client 的语义 hash、完整快照、清零及次数+1；未知、脏响应、无执行 tombstone、不匹配证据排除，外部单号去重，执行后退款不减。

付费仅读最近1000条任务，多于1000时数量是已核实下限，机器人明确显示“至少”；旧 v1/站外/原生全来源不混入。coverageFrom 只表示本地所见记录/权益时间，不承诺此前全部统计完整。赠送余额另验终身一次守恒，原生 reset_count 仍单列。当前未做真实 QQ 联调或部署，不能把受控 HTTP/API doubles 结果当作平台验收。
