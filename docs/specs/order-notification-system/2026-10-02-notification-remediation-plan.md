# MoNexus 通知体系修复方案

版本：1.0 / 日期：2026-10-02 / 状态：control-docs-created。

实施：未启动。通知修复集成分支：未创建。实施 agent：未派发。本文件只授权规划，不授权发布、数据库修改、群发、订单操作或生产连接。

**执行前须知：** 当前存在其他 agent 的前端和邮件改动，以及独立的 Xboard 支付修复；不得把它们隐式并入通知修复。任何生产发布及历史通知修正，须分别授权。以下接口、函数、指标及数据库字段均为拟议实现，不代表已经存在或已验证上线。

## 1. 状态、范围与证据

### 1.1 目标与非目标

修复身份错配、公告版本确认、消息刷新/分页/已读一致性、业务事件接入与提醒任务的具体缺陷。保留 PostgreSQL 事实源、事务内通知写入、LISTEN/NOTIFY 唤醒、SSE 提示、REST 权威同步。

不引入 WebSocket、消息中间件、IM、购物车、通知偏好、营销群发、商家子账号；不把所有邮件迁入站内；不追发历史订单事件；不改变订单、积分、退款及结算规则。

原冻结规则继续有效：即时订单不产生商家待处理提醒；自动开通成功只通知买家；平台自营人工单不猜测 admin 收件人；首次交付通知保持每单一次；消息不得带交付凭据、完整邮箱、token 或密钥。

### 1.2 证据边界

- 基线为当前工作区代码，而非生产镜像。生产上是否已发生每个问题，未在本轮确认。
- 前一轮在临时目录运行 3 个测试文件、14 项隔离复现，全部成立。HTTP、认证响应和持久化均被模拟，没有真实订单、数据库或邮件动作。
- N01/N02 身份错配，N04 角色变化后的公告缓存，N06 登出角标，N07/N08 定时器缺口，N09 预览漏刷新，N10 合并窗口，N11 请求/已读竞态，N12 按钮范围，N13 Tab 切换已有隔离复现。
- N03 公告版本错误通过服务层模拟持久化复现；N15 通过去重键及合法状态流确认。
- N05/N14/N16-N19 为静态调用链、并发或局部失败路径核实；不宣称已经做过真实数据库故障注入。
- 临时复现不能代替长期回归；实施时须转成项目测试，以修复后的正确结果断言，而非继续断言缺陷成立。

关联规格：[事务通知规则](./spec.md)、[原设计](./design.md)、[实时通知冻结决定](../../superpowers/specs/2026-08-09-order-notification-realtime/README.md)。此前审查面板的 N01-N19 为问题追溯编号，不是新的业务事件类型。

## 2. 修复原则与实施顺序

### 2.1 必须守住的约束

1. 前端 user、token、会话与异步响应必须属于同一身份；身份失效时不继续显示旧受保护内容。
2. 回执只能确认用户实际看到的公告版本；未知或陈旧版本不得自动升级确认。
3. SSE 是失效提示，不是未读计数或列表的最终事实；收件箱、已读和到期以 REST/数据库为准。
4. 任一有效登录状态都有明确的刷新生命周期；实时能力关闭或连接悬挂不能使收敛消失。
5. 相同业务发生实例只写一条；同一订单的不同争议周期必须分别通知。
6. 通知写入、去重和业务事务一致提交；继续遵守 pg_notify 失败使同一事务回滚的冻结规则，不以吞异常掩盖失败。
7. 邮件至少一次投递的重复窗口仍存在；本方案消除错误周期状态和过时行动，不承诺 SMTP exactly-once。

### 2.2 六个可独立验收的批次

- **R1 / P1：身份安全基础。** N01/N02/N06；建立 auth epoch、会话校验及退出清理，为其他前端修复提供公共边界。
- **R2 / P1：公告完整性。** N03/N04/N05；版本回执、身份缓存、刷新和跨窗口回执同步。依赖 R1。
- **R3 / P2：连接与降级。** N07/N08；polling-only、连接期间兜底、超时和恢复。依赖 R1，可与 R2 后端部分并行。
- **R4 / P2：消息中心一致性。** N09-N13；统一请求、读操作、完整显示窗口及异步导航。依赖 R1/R3 的信号契约。
- **R5 / P2：业务事件与跳转。** N14-N17；商家 deeplink、争议实例、充值共享写入与正确文案。可与 R4 并行，但共享 Dispatcher 由一个 owner 修改。
- **R6 / P2：邮件任务可靠性。** N18/N19；订阅周期 fencing、到期重置原子化、降级提醒资格。独立发布，包含最小 schema 扩展。

每批次只进入下一阶段的前提：针对性测试、类型检查、接口兼容验证及只读复审完成。不先改动画、布局、资金规则或全站配置。工作量以实际 diff 和测试证据估算，不给未经执行验证的工期保证。

## 3. 身份与会话隔离

### 3.1 auth epoch 与统一会话上下文（N01/N02）

主要文件：`src/stores/authStore.ts`、`src/api/authRefresh.ts`、`src/api/client.ts`、`src/components/NotificationRealtimeBridge.tsx`、`src/realtime/notificationStream.ts`；必要的服务端 guard 位于 `server/src/modules/auth/`。

拟议 auth 上下文包含 `userId`、服务器会话 `sid`、当前 Tab 的 `authEpoch`。现有 access JWT 已带 `userId` 和 `sid`，不需要为了这个问题新建会话表。

- login、logout、切换账号、会话被撤销时递增 authEpoch；同会话 token 轮换不递增。
- 一个 refresh promise 只能服务发起它的 `(userId, sid, authEpoch)`；不能用全局无归属 Promise 为新账号返回旧结果。
- 写入新 token 前、终态失败 logout 前、SSE 的刷新续接前，都检查捕获的上下文仍有效。
- 过时代际结果返回可识别的 session-changed 取消结果；不写 store、不登出新账号、不自动重试旧业务请求。
- 先校验并提交身份上下文，再重启 stream 和加载个人数据，不能先展示 B 的 user 再继续使用 A 的 token。

JWT 的客户端解码只用于识别/拒绝错配，不作为授权证明；身份与权限仍由服务端签名校验和当前账户/MFA状态决定。无法解析 sid 的旧 token 不允许跨 Tab 采用，应显式重新认证或走经过身份校验的 refresh。

### 3.2 跨 Tab 的 token 采用与 Cookie 竞态

- `getTokenRefreshedByAnotherTab()` 不能只比较 token 字符串；仅采用同 userId、同 sid、未过期且格式有效的 token，并再次检查当前 epoch。
- localStorage 指向另一个账号时，停止 A 的受保护流并清缓存，要求用户确认新的登录状态；不得偷偷把 B 的 token 安到 A 的 user 上。
- 此处是本 Tab 的本地失效，不自动调用携带共享Cookie的服务端logout，否则旧A页面可能撤销B的新会话。
- `navigator.locks` 的同源认证锁必须覆盖 refresh 和真正改变 Cookie 的 login/logout；Tab 内也需串行化。不是只给 refresh 加锁。
- 旧 refresh 的 Set-Cookie 可能覆盖新登录 Cookie，单纯忽略 JS 响应不能解决它。账号切换须等待或串行化先前的 Cookie 变更请求，再完成新登录。
- 若浏览器无 Web Locks，不编造不可靠的“localStorage互斥锁”。保守方案是禁止跨 Tab 静默 token 采用；检测到身份不一致时终止旧 Tab 自动 refresh，要求重新认证。正常单 Tab refresh 保留。
- 服务端 refresh 可增加 `expectedSessionId` 校验：在锁定 RefreshToken/session family 后、旋转前比较 sid；错配返回独立的会话变化错误且不旋转 Cookie。发布时先兼容接收该字段，客户端升级后再评估强制。它补充会话绑定，不替代客户端 epoch 和 Cookie 请求串行化。
- 同用户多设备不同 sid 也不得相互采用 token；不要以 userId 相同就放行。

验收：跨 Tab A/B、同用户不同 sid、迟到成功、迟到401、logout期间 refresh、旧SSE事件等场景均不会更新新身份；同会话正常并发401仍只有一次 refresh。

### 3.3 未读数及缓存退出清理（N06）

建立统一的身份变化清理入口，可采用 authStore 订阅/协调模块，避免 authStore 与 appStore 形成循环依赖。

必须清理：通知未读、订单注意数、通知列表、消息预览、公告内容/回执、必须确认提示集合、Toast待显示内容、LRU及请求/计时器。登录 B 时先清理 A 的既有值，再加载 B；不能只保护新响应。

计数状态明确区分“加载中/未知”与已知0。网络失败可保留**同身份**最后值，不能保留上一身份的值。主题、公开商品缓存等非敏感偏好不随意清除。

测试重点：真实 logout wiring，而不是测试里手工调用 refreshNotificationUnread 后宣称登出清零通过。

## 4. 公告版本、缓存与确认

### 4.1 所见版本回执（N03）

涉及：`server/src/modules/announcements/{schema,routes,controller,service}.ts`、`src/api/announcements.ts`、`src/hooks/useAnnouncements.ts`。

拟议契约示例，不是现有接口：

```http
POST /api/announcements/101/acknowledge
Content-Type: application/json

{"version": 2}
```

- `version` 为正整数，read与acknowledge都必须携带；请求路径仍沿用现有ID。
- 同事务锁公告行，重新核对当前角色可见性、published、开始/结束时间、presentation和version，再写 `(announcementId,userId,version)` 回执。
- 版本不一致返回 `409 ANNOUNCEMENT_VERSION_CHANGED`，绝不自动确认当前版；不可见或撤回继续返回404；不需要确认的presentation继续400。
- 首次 readAt/acknowledgedAt 保留，不用重试时间覆盖最初回执时间。
- 返回的版本必须与请求版本一致；客户端同身份/请求代际下才应用。
- 收到409后重载、展示“公告已更新，请阅读后重新确认”，不能自动补发确认。

不能用“先读version、事务外比较、再upsert”解决；管理员更新与回执提交要按公告行串行化。管理员公告写路径需维持同一锁边界。

兼容发布：新后端先上线。对缺version的旧客户端明确拒绝并提示刷新，不能以兼容为由继续盲确认最新版；业务交易不应被这条公告UI变化意外阻断。旧客户端需要刷新，而不是静默记录错误回执。

数据库已有 version 和复合唯一键，本项无需新增表/字段。已有错误确认不能仅凭当前代码推断哪些用户没看过；不得批量删除回执。若确需用户重读，运营按实际内容发布新版本并留审计。

### 4.2 按身份重载及常驻收敛（N04/N05）

- 公告hook继承R1上下文；身份变更立即清空，重新拉取，旧响应及旧receipt拒绝应用。
- `surfacedRequiredAnnouncements` 按用户/会话＋公告id＋version隔离；身份变化复位。
- 登录/身份变化、回前台、打开通知中心、健康校准、降级轮询均可触发重载；请求single-flight＋dirty-rerun合并，避免每个事件重复GET。
- 只有公告可见/启用才启用定时任务；无SSE的游客公告也不能永久停在首次快照，采用低频可见态校准。
- 根据startsAt/endsAt设置最近边界计时器并进行权威重拉；本地时间只用于安排重拉，不用于绕过服务端可见性。
- 首次失败返回可恢复状态，不把失败当“无公告”后永远不重试。
- 普通notice保留既有“单设备展示次数”语义，不擅自改成每用户展示次数；服务端read/ack回执与设备展示次数分开。

跨窗口公告回执使用独立的失效信号或扩展现有通道类型，消息只含版本/种类，不传正文；接收端按当前身份REST重拉。普通运营公告发布实时事件属于扩展，可后置，不能以缺它为理由取消polling/foreground收敛。

验收：v1→v2确认竞态、修订后强制重读、退出后定向公告清除、商家角色变化、另Tab确认、定时开始/结束、撤回、失败后恢复。

## 5. 实时连接与轮询兜底

### 5.1 连接状态与周期保障（N07/N08）

涉及：`NotificationRealtimeBridge.tsx`、`notificationStream.ts`、runtime、visibility hook及现有server stream协议。维持一个Tab、一个用户、最多一个活跃fetch。

- capability未加载：等待配置请求；配置失败可见态重试，不能永久等待。区分“尚未知道”和明确false。
- 已登录、通知开启、realtime=false：进入polling_only，每30秒发布权威同步；不探测404。
- connecting和degraded：均保留30秒fallback，直到有效stream.ready才转healthy。token轮换不能清掉唯一兜底。
- healthy：沿用5分钟校准；回前台立即校准。
- logged_out：停止受保护定时器并清理；403 auth_blocked避免无限重试，按身份/权限变化再启动。
- 通知功能关闭：不轮询返回404的收件箱，但公开公告可继续独立刷新。

建议起始值：连接/ready超时10秒；收到ready后无任何合法帧超过 `max(3×heartbeatMs,45秒)` 转degraded；heartbeatMs需做上下限校验。最终值必须结合现有代理超时与真实网络测量确认，不作为已经验收的性能结果。

ready前后的deadline由同一generation管理；EOF、abort、超时只清理所属连接。服务器heartbeat注释也计入活跃时间；坏帧不能无限延长连接健康判定。

后台页可暂停REST轮询以降载，但回前台立即同步。订阅者返回真实Promise，调度器才能single-flight；网络故障时35秒收敛指标不适用，恢复后首个成功权威刷新需满足指标。

### 5.2 不需要重写的服务端机制

保留静态PG频道、身份级hub路由、SSE字段白名单、速率与连接限制、硬token到期及代际保护。不要增加无界内存事件队列，不依靠Last-Event-ID替代REST。

listener连接/probe的应用超时属于加固项，前轮没有真实复现；实施前先核对pg连接参数，不能把它升格为已确认生产缺陷。若增加timeout，须覆盖旧generation关闭、查询取消及重连不泄漏连接。

## 6. 消息列表、分页与已读一致性

### 6.1 统一请求协调与生命周期（N09/N11/N13）

消息页和中心预览采用共同的请求协调机制，但保持独立展示范围。归属至少包含 `(authEpoch,userId,filter,requestGeneration,mutationEpoch)`。

- initial、background、pagination不再各自拥有能互相覆盖的独立序号；更早快照不能替换更新结果。
- 读操作开始时递增mutationEpoch，使操作前GET不再能回写；操作中失效信号标dirty，完成后统一重取。
- 无关背景计数请求不取消当前有效的分页操作；协调器按视图及请求意图定义顺序，不简单让每个无关事件都“最后请求获胜”。
- 通知中心订阅notifications和all.visible；回调返回Promise，初始和背景重载使用同一guard。
- 弹窗关闭、Tab切换、filter变化、身份变化后旧响应无权写状态。
- defaultTab仅用于closed→open；必须确认公告的强制展示使用单独的明确规则，普通未读数变化不抢用户Tab。
- read完成后的navigate先核对身份、路由和交互generation；用户已经关闭/跳转则只更新权威数据，不抢导航。
- 不忽略markAsRead返回的archived状态；逻辑过期结果不本地伪造read，可提示消息已过期并重新读取。

### 6.2 连续显示窗口，而非首屏补丁（N10）

**推荐方案：增加权威窗口读取接口，移除“缺席行永远保留”的背景合并。** 此接口是本轮拟议增加，原cursor接口仍保留供旧客户端兼容。

拟议 `GET /api/notifications/window`：

- 输入：已有category/status筛选、正整数limit、可选exclusive beforeId。
- 首次实现建议limit默认20、上限200；上限是请求预算，仍允许用户继续向历史翻页，不是把历史通知限制为200条。
- 返回：`notifications`、`nextCursor`、`hasMore`、`unreadCount`、`snapshotAt`。
- 行、cursor、hasMore、unreadCount在同一只读RepeatableRead事务内读取，同一now用于到期筛选；不将读事务跨HTTP请求保持打开。
- 所有查询继续约束recipientUserId=me；响应为REST安全投影，不包含跨用户数据。
- 路由/window必须在:id模式前注册。候选复合索引先EXPLAIN验证，不能凭猜测新建；必要时为`recipientUserId + id`添加索引。

客户端：

1. 当前显示不超过200条时，背景校准按已加载窗口大小读取**完整最新窗口**，整体替换所有行和cursor；新消息突发不再沿用旧cursor。
2. 用稳定ID恢复滚动锚点；锚点已到期/被移除时就近定位并提示，不重新插入已不存在的行。
3. 往历史浏览超过请求上限时，不无限扩大limit。不在每个失效信号里反复重拉所有历史；进入历史浏览模式，记录当前窗口上边界，用窗口API刷新这个边界下的显示范围。
   显示窗口最多保留200条，继续向旧页移动时淘汰窗口外的行并记录前后导航边界；重新校准使用获取该窗口时的exclusive beforeId，不把当前最高行id直接当排他边界而漏掉它。到期后窗口可补入更旧行，新的cursor来自该响应。
4. 历史浏览收到新消息时展示“有新消息，查看最新”，进入最新模式后重建窗口；不把少量新行强插到旧分页链前面。
5. load-more与后台窗口刷新不同时提交；刷新若先完成，分页响应按新的window generation丢弃/重新请求，cursor只随成功提交的同一窗口变化。
6. 断线恢复、read invalidation和expiry同步都用这条权威窗口路径，不只重新取最新20条。

该方案避免新增通知版本表，也避免用通知id作为“提交顺序水位”。数据库序列id不是提交顺序：较小id的事务可能晚提交。snapshotAt用于解释快照，不作为永久过滤条件或丢弃迟到提交的依据。

若暂不接受新接口，可先采用安全简化方案：任何背景失效重新建立首屏＋cursor并明确提示列表更新，绝不保留旧cursor和缺席历史。此方案正确但会影响历史阅读位置，仅适合作为先行止血；不能宣称保留现有滚动体验。

### 6.3 已读和全部已读（N11/N12）

- 单条读成功可应用服务器返回的实际状态，但仍在当前身份和mutation epoch下操作。
- 全部已读成功后**不对当前列表无差别map成read**，而是权威重取当前窗口＋全局unreadCount；服务端完成后新到消息保持未读。
- 接口继续处理全收件箱，按钮依据全局未读数；筛选视图提供清楚说明“将标记所有分类消息”，不把局部列表状态当全局。
- 不用最大ID或readAt本地推断哪些消息被批量处理；并发提交/后到消息可能破坏这类推断。
- 已读信号影响角标与当前可见列表，BroadcastChannel与SSE read控制帧都接入同一REST同步，不只刷铃铛。
- 读操作HTTP失败不导航、不本地清红点；成功但随后的列表请求失败保留已确认的单条结果和待重试状态，不用操作前快照覆盖。

验收：旧GET覆盖、新消息跨一页、40条历史已读、归档移除、read-all后新到消息、加载首屏全读但历史未读、filter变化、窗口关闭、快速双击和下一页cursor。

## 7. 业务事件、路由与充值通知

### 7.1 商家deeplink（N14）

规范链接继续使用已有冻结格式 `/merchant/orders/:id`，不要未经批准改模板为另一条路径。

- 在App增加明确的商家订单详情路由，或让现有工作台解析该路径，切到orders并按id获取详情。
- 若复用工作台，抽出详情加载/展示逻辑，不能为了跳转强行打开“交付”“退款”等操作弹窗。
- 详情请求必须检查商家归属及当前角色；无权限/下架/不存在返回可理解的错误，不回退到错误订单。
- 兼容数据库既存deeplink，不批量重写历史通知。买家 `/orders?focus=` 保持。
- 新路由验证使用真实组件或明确路由测试，不能只断言模板字符串。

### 7.2 每次争议发生实例去重（N15）

主要文件：orders/fulfillment.ts、notifications/dispatcher.ts及其测试。

- `createOrderStatusEvent()` 已返回持久化状态事件行；在同一事务里保留该id并传给通知事件。
- disputed及dispute_resolved的dedupeKey包含 `OrderStatusEvent.id`；相同状态迁移的两次emit仍使用同id，保证幂等。
- 第二轮争议用新的事件id，不能用Date.now/随机UUID生成所谓去重键。
- resolved按对应真实处理状态事件区分；必要时payload只增加非敏感状态事件引用，不引入争议正文或交付信息。
- 首次delivered、created及终态refund/closed继续原每单一次规则，不因为修争议就全部改成每次状态变化发信。
- 不追发之前被吞掉的争议通知，也不删除旧通知的unique key。新旧键并存，首次新规则只用于部署后事件。

本项不需要新争议表或schema迁移，但属于对原争议去重粒度的修正，必须把规格增量写进本次验收记录。

### 7.3 充值共享写入（N16）

抽出共享的 `persistInAppNotification(input, transaction)` 负责：

- notification.enabled守卫；关闭时零Notification行和零pg_notify。
- 收件人角色、纯文本长度、category/level、deeplink白名单验证。
- 通用TTL生成、复合去重createMany skipDuplicates、解析插入id及同事务pg_notify。
- 指标仅记录有限域标签，不记录userId/token/正文等敏感或高基数字段。

订单Dispatcher继续负责模板、收件人和发生实例；充值credit/refund负责准确事件及金额方向，再委托共享写入。不要强迫UUID充值订单伪装成整数Order.id；充值relatedOrderId保持null，rechargeOrderId为独立安全payload。

SSE外壳保持v1，现有事件类型格式支持recharge.*。客户端先沿未知事件静默刷新notifications；随后明确增加充值事件的通知/余额/充值页失效矩阵。是否弹Toast是产品策略，不因为统一实时写入就自动新增强提醒。

充值通知TTL规则同一般站内消息。历史expiresAt=null记录的处理为**单独授权的数据维护**：按明确recharge事件类型、createdAt+配置天数补expiresAt；不删除记录，不重新投递。如果准备上线此维护，先只读统计、预览影响、备份，老记录归档会改变未读数，需告知用户。

邮件、安全事件、积分流水等仍有独立开关；NOTIFICATION_ENABLED=false不代表禁用整个支付业务或所有邮件。

### 7.4 充值退款文案（N17）

- 已入账再退款：文案描述“支付渠道退款已完成，对应充值积分已回收”。
- 支付成功但尚未入账就退款：描述“支付渠道退款已完成，该充值未发放积分”。
- 退款失败并释放hold：描述“退款未成功，冻结的退款积分已恢复为可用余额”，仅在实际release成功的事务结果下使用。
- 金额来自退款事实的amountMinor/currency，经现有整数金额格式化；不把积分数当货币，不从跳转参数推断退款成功。
- 对历史错误body是否定向改写另作决策，默认不改历史通知/流水，修复新事件模板。

## 8. 订阅与自动开通提醒

### 8.1 订阅周期版本及状态写入（N18）

订阅提醒可靠性有两个独立修复，不能只删除expired行：

1. **原子重置：**Xboard `tryAlignDeliveredExpiresAt()` 在锁订单/交付行的同一事务中更新expiresAt并重置提醒；处理期间重新核对status和Xboard结果归属，不能先读状态、事务外改时间。
2. **旧任务fencing：**提醒任务捕获expiresAt及周期版本，SMTP完成后的状态写入必须再次核对周期，旧周期不得写新周期的pre/expired。

推荐最小schema扩展：`DeliveryRecord.reminderRevision Int @default(0)`；`SubscriptionReminder.deliveryRevision Int?`。后者保持nullable以兼容老代码。任何改变expiresAt或重新打开提醒周期的入口，在同一事务中递增revision并删除/失效旧提醒。原订单创建及首次交付从revision=0开始。

周期入口清单：人工补救重交付、Xboard首次权威到期补齐、Xboard对账/管理员对齐、其他明确修改expiresAt的入口。续费新订单按新orderId独立管理，不错误重置已完成旧订单的提醒。

提醒处理：

- 查询时选出orderId、expiresAt、revision及已保存reminder revision。
- 发送前短事务检查订单仍符合资格、周期一致；SMTP始终在事务外。
- 发送后短事务按全局 Order→DeliveryRecord→Reminder 锁序复核：订单未退款、expiry和revision仍匹配，再保存阶段。
- 旧任务完成只记脱敏stale指标，不写新阶段；新周期之后仍可提醒。
- 七天历史积压静默expired标记也必须按版本CAS，不留绕过fencing的后台路径。
- 不承诺彻底撤回已经发出的旧邮件；减少发送前竞态，但“发送中更新”仍可能收到一封旧周期邮件。保证它不永久污染新周期状态。

上线前冻结候选batch、变更revision后重新检查；schema只做加法，不物理删除旧列。

历史reminder `deliveryRevision=null` 不可一律当“未发过”而群发。两类处理：能根据当前delivery/reminder时间关系安全对应则映射当前周期；无法判定的隔离为maintenance-review，不发送，先只读统计后单独维护。历史修正默认不发信。

### 8.2 降级提醒资格（N19）

`notifyDegradedTasks()` 候选和认领均加 order.status∈pending/processing；发送前重新读取订单可行动状态。

- 已交付/关闭/退款等不再发送“请人工交付”。
- 不把未发送跳过记作merchantNotifiedAt成功。若要停止反复扫描，建议增加nullable `merchantNotificationSkippedAt`，只在确认提醒已无意义时写入；保留原task降级事实与诊断码。
- task重新成为有效行动是否允许重新提醒须显式判定，不凭旧skip时间永久压制；当前没有这样的重开业务入口时不擅自新增。
- CAS带leaseToken/status/未通知/未skip，不能释放其他worker租约。
- 邮件模板注明“请先查看订单当前状态，避免重复履约”；SMTP已开始后的并发交付无法完全消除，要如实保留这一边界。

此项可能新增一个可空字段；若不接受schema扩展，先资格过滤防错误发信，后续再解决旧候选扫描成本，不伪造发送成功记录。

## 9. 测试、可观测性与验收

### 9.1 分层测试

前端：authRefresh真实模块、authStore/appStore边界、bridge挂载生命周期、fake timers、真实notification page/center、路由和deferred Promise竞态。修正AnnouncementCenter测试里的旧类型引用、旧mock导出和过时fixture，加入点击已读场景。

后端：严格version schema、receipt并发、状态事件实例去重、共享writer开关/TTL/rollback、窗口读取snapshot、提醒revision并发与故障。DB测试必须使用新建的专用测试库，绝不把开发或生产DATABASE_URL注入会TRUNCATE的setup。

E2E：买家/商家/管理员分角色；两账号两Tab与同账号多Tab；断线/恢复/realtime=false；大于一页的新消息；40+历史已读与expiry；直接打开商家链接；公告v1展示/v2更新/确认。认证和业务写入在授权测试账号和商品中进行，支付渠道/Xboard/SMTP使用模拟，不实际充值、扣生产积分或群发。

### 9.2 必须通过的具体断言

- R1：A刷新迟到成功/失败不改变B；A/B不同sid不能采用；logout立即清零；旧GET/旧SSE事件不进入新会话。
- R2：看v1确认时服务器若已v2则409且无v2回执；原版本重试幂等；公告修订/撤回/到期/跨Tab确认最终收敛；定向公告退出即清。
- R3：能力false连续可见90秒至少发生预期轮询；pending fetch与ready缺失超时后恢复；token变更只有一个活跃连接；回前台立即同步。
- R4：125-106与100-81之间不出现不可达断层；read-all之后到达的新消息仍未读；旧GET不能回滚读结果；expiry归档从显示窗口消失；当前首屏全读但全局未读时按钮可用。
- R5：商家点击链接确实打开归属订单详情；两轮争议各通知一次，同一事件重试无重复；通知关闭时充值零行；TTL有效；支付退款资金方向与文案一致。
- R6：邮件发送中revision改变，旧阶段不落库；expiry更新与提醒重置故障时整体回滚；已交付任务不再发人工行动邮件；历史null-revision不会触发群发。

### 9.3 性能与可观测性

沿用原通知实时规范目标：健康可见P95≤2秒、P99/硬目标≤5秒；降级时在REST可用前提下≤35秒收敛。这是验收目标，不是本方案已实测的结果。

窗口API建议性能预算P95≤300ms、P99≤1秒（测试数据量和并发需记录）；不要简单给所有用户高频重拉200条。视图关闭只刷新计数，视图打开才拉窗口；topics和同Tab请求合并。

建议新增有限标签指标：auth_refresh_stale_result_total、announcement_receipt_version_conflict_total、notification_resync_total(reason)、notification_window_refresh_duration、notification_stale_response_drop_total、subscription_reminder_stale_cycle_total、provision_notice_skipped_total(reason)。具体命名与metrics.ts现有规范对齐，严禁用用户、token、订单号或正文作为指标标签。

追踪日志允许request correlation、事件实例、窗口请求归属；生产debug不记录token、公告私有正文或交付内容。上线观察重点：refresh错配、409公告冲突、SSE degraded比例、REST频率、窗口cursor、重复通知率及SMTP失败。

## 10. 文件所有权、发布与回滚

### 10.1 文件所有权与并行边界

- **身份owner：**authStore、authRefresh、api/client与session上下文；提供清理/epoch契约，不负责通知布局。
- **公告owner：**announcements后端与api/hooks；Layout中公告接入点由前端集成owner合并，禁止两人同时编辑Layout。
- **实时owner：**NotificationStream、bridge、runtime、invalidationScheduler；共享信号契约先冻结。
- **收件箱owner：**NotificationsPage、AnnouncementCenter、merge/协调hook、REST window接口；types/notification及路由适配一个owner负责。
- **业务owner：**Dispatcher共享writer、orders/fulfillment、recharge通知模板与商家deeplink；不要同时重构金融业务service主体。
- **提醒owner：**subscriptionRemind、provisionCron、Faka到期对齐及schema迁移。

同文件仅一个写入owner；必要时提交小diff由集成owner应用。推荐独立worktree而非多人直接共享dirty树；分支/worktree创建、派发、合并、提交与push需要另行授权。不能覆盖当前前端、邮件和Xboard支付修复。

### 10.2 API与数据库变化清单

无需schema：R1已有JWT sid；R2已有公告version/receipt键；R3计时器与信号；R4窗口REST与状态协调；R5事件实例id和共享writer。

可能schema：R4索引（仅EXPLAIN证明需要时）；R6 reminderRevision、deliveryRevision、merchantNotificationSkippedAt。必须先确认完整expiresAt写入入口，避免一个没接入的旧路径破坏版本fencing。

接口增量：announcement read/ack body version及409错误；可选refresh expectedSessionId；新增notifications/window。现有SSE v1保持，新增充值类型须先验证protocol投影支持UUID recharge payload的过滤；整数relatedOrderId契约不变。

### 10.3 发布顺序

1. 在隔离环境验证所有P1和批次接口，生成精确提交清单；不要直接发布混有其他agent修改的整个工作区。
2. R1可先独立发布纯客户端guard；如增加server refresh guard，后端兼容接收先上线，前端后上线，不先强制要求旧客户端没有的字段。
3. R2后端版本校验先上线，旧无version请求fail-closed并提示刷新；紧接前端上线。已确认错误回执不自动清库。
4. R3/R4服务端window先上线，REST/SSE/代理开关组合冒烟后发布前端。实时功能关掉时必须保留轮询。
5. R5先上线商家路径，再验证历史链接；客户端兼容未知recharge事件后再接通后端共享writer。是否开充值Toast需批准。
6. R6先应用可空/默认值的加法迁移，暂停提醒cron（是停止调度，不是停止交易）；确认所有业务到期写路径与revision已上线后重新启用提醒。禁止新旧提醒worker长期混跑。
7. 每批灰度观察，达到验收后才扩量。没有仓库现成灰度能力时用staging＋小批发布，不虚构可以按百分比分流。

生产操作：先只读查部署版本、开关、样本数据及备份；owner批准后执行发布。当前专用SSH私钥已清理，不能复用或假设仍有生产授权。生产发送、历史通知修改、数据维护须单独预览确认。

### 10.4 回滚边界

- R1不得回滚到已知会话错配逻辑作为长期方案；如新refresh异常，关闭自动跨Tab采用并要求重新登录，保留身份guard。
- R2后端可回滚UI但不能恢复盲确认最新版；故障时禁用确认按钮并提示刷新/稍后处理，保留已正确写入回执。
- R3可关闭SSE，但轮询必须继续；不以关闭所有通知代替连接恢复。
- R4客户端可回退旧REST首屏安全重建，不回退到旧cursor拼接算法；新window端点保留向后兼容。
- R5保留数据库新增通知和去重键，不删已发送记录；旧争议代码回滚后存在重新压制事件的已知风险，需显式记录。
- R6schema不降级删除列。暂停提醒任务并保留新版到期revision写入；旧worker不理解新字段时可能破坏终态，不能直接启用旧cron。历史维护无自动逆操作，依据备份和审计逐笔处置。

## 11. 决策与完成标准

### 11.1 推荐默认与需要确认的取舍

推荐直接采用：身份fail-closed、确认所见版本、交易/通知同事务、SSE仍为提示、首次交付保持一次、争议按发生实例、商家既存deeplink兼容、不给用户群发补历史通知。

实施前明确确认：

- R4接受权威显示窗口和历史模式的新交互，还是先以首屏重建止血；绝不默认同时承诺“无限保留历史”和“每次只拉20条能完全收敛”。
- R5充值接入实时后保持静默刷新，还是新增Toast；默认静默，避免改变支付体验。
- R6接受最小schema扩展及暂停提醒worker的发布窗口；拒绝schema时需另选可证明的expiresAt版本CAS方案。
- 历史充值expiresAt维护、历史公告错误回执处理、历史提醒revision关联分别授权；默认只预览不修改。

这几项不阻塞R1身份修复方案成立，但阻塞对应功能的实施与发布。

### 11.2 证据到任务的追溯

- N01/N02/N06 → R1 → 正确身份的刷新与退出清理测试。
- N03/N04/N05 → R2 → version冲突、角色切换和公告边界刷新测试。
- N07/N08 → R3 → capability=false、悬挂连接、重连代际测试。
- N09/N10/N11/N12/N13 → R4 → 显示窗口、并发请求、read-all和Tab所有权测试。
- N14/N15/N16/N17 → R5 → 路由真正打开、争议实例、TTL/开关/实时及退款方向测试。
- N18/N19 → R6 → 提醒周期fencing、原子重置与行动资格测试。

已确认现象是Evidence，N编号是Finding，R批次与文件/测试是修复Path。未动态复现的故障路径必须在实施中增加受控测试，不靠评审措辞升级置信度。

### 11.3 完成与交付标准

每批报告必须含：精确diff/提交、实际命令与退出码、测试数量、未覆盖范围、迁移影响、开关组合、部署版本和回滚演练证据。不要只写“全量通过”或引用另一个agent的完成声明。

本方案正式验收条件：19个问题组都有修复或owner批准的明确延期；4个P1无未解决项；不存在错身份通知、盲确认新公告、掉兜底、不可达分页或伪已读；没有扩大订单/资金行为。邮件任务部分若分批上线，应单独说明仍未交付，不能把站内通过等同于全通知体系通过。

本次交付只创建本修复方案及执行面板；没有启动R1-R6实施，也没有声称生产已经修复。
