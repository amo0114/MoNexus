# 商品公开可售状态与推荐质量：下一阶段实施方案

| 项目 | 内容 |
| --- | --- |
| 文档 ID | `PLAN-PRODUCT-AVAILABILITY-001` |
| 版本 | `1.0.0`（方案版本，不是应用版本） |
| 日期 | 2026-10-14 |
| 状态 | 实施交接方案；本次只提交文档，未实施功能 |
| 核验基线 | `origin/develop@163673b01a88eabfe572a90281abf878b46c910c`，相关推荐已在 PR #250 合并 |
| 本次详细定义 | PR1：商品、套餐的公开可售状态统一 |
| 后续路线 | PR2 数据审计、PR3 名称建议、PR4 准入调整、PR5 效果统计；按依赖分期实施 |
| 流程规范 | [分支与 CI](../branching-and-ci.md)、[测试政策](../testing-policy.md) |
| 相关方案 | [相关推荐 V1](product-detail-recommendations.plan.md)、[商品模型与结算](product-model-and-checkout.md) |

## 1. 目标与范围

当前推荐后端只按公开 `stock/stockMode` 剔除售罄商品，卡片则还检查代表性 Faka 快照的 `sellable`。因此 `remaining=4、sellable=false` 的商品可以进入推荐，却显示售罄。多个 Plan、多个周期和本地/外部混合套餐，又使代表快照不能决定整件商品的可售性。

PR1 新增一个共享的公开状态契约，回答：一件当前允许浏览的商品，是否至少存在一个本站配置有效、根据本地数据和公开容量快照已知可售的套餐。列表、推荐和详情消费同一计算结果；实际下单继续执行现有权威校验。

状态不是用户购买资格：不包含余额、消费限制、登录资格、邮箱验证或购买资料是否填写，也不承诺库存被锁定。商品权限仍由现有 visibility 规则控制。

本轮保留创建流程、七套模板、发布状态机、订单事务和现有库存数量投影。明确不修改推荐相关度、排序、每组 64 个候选和最多 6 件；不新增候选补查、名称字典、历史迁移、埋点、数据库表或运行时依赖。

本文仅替代相关推荐 V1 中“补全后只按 stock/stockMode 准入”的规则，以及与之关联的 B10 旧断言。V1 的其他规则继续适用。不要将已合并代码或旧计划的“未实施”标注误作当前项目状态。

## 2. 实施规模约束

实施 agent 按以下约束控制复杂度：

- 新增一个后端纯状态模块；服务层负责取数、调用和公开序列化。无需策略插件、通用规则引擎或新缓存框架。
- 内部使用已知的 Prisma/快照类型，不对每层输入重复 Zod 校验，不新增无业务依据的默认状态或静默捕获。
- 不调用整个 `publicationReadiness`，不在公开请求里重新校验模板、封面、说明、发布条件或完整履约 Schema。
- 复用现有纯 `evaluateActiveOffer` 的本站套餐判断，再组合外部容量；不复制它的固定内容、文件、即时库存和 webhook 分支。
- 商品状态只算一次、各套餐状态只算一次；列表和推荐仍共用 `hydratePublicListItems`，不逐商品调用详情接口。
- 无发送前第二轮库存复查、内容版本 409、同步 Xboard 探测、自动重试或轮询。已有缓存命中后的可见性检查保留。
- 仅增加一处前端旧数据兼容入口；不在每个布局分别推断可售状态，不修补任意畸形响应。
- 用最便宜的有效证据验证行为；状态矩阵不在纯函数、API、页面和 E2E 各复制一遍。

## 3. 已核验代码锚点

行号来自核验基线，实施时以符号定位；开始前记录实际 base SHA。

| 文件 / 符号 | 事实与本轮接线 |
| --- | --- |
| `server/src/modules/products/service.ts:51` / `productListSelect` | 列表取 active offers；增选纯套餐评估所需的最小字段 |
| 同文件 `:132` / `computePublicAvailability` | 现有 stock 数量投影；无套餐时还有 Product 回退，本轮保留数量兼容，但新状态不继承该回退 |
| 同文件 `:171` / `countAvailableByOffer` | 一次 groupBy 统计真实可用 InventoryItem；继续复用 |
| 同文件 `:256` / `loadFakaCapacityBySku` | 只读 fresh/有界 stale 快照并触发后台刷新，同 Plan 周期共用读取 |
| 同文件 `:316` / `dedupeFakaCapsByPlan` | 按返回 planId 去重，缺失时按 SKU；用于既有数量投影，不能按周期累加 |
| 同文件 `:373` / `pickProductFakaCapacity` | 商品级代表快照；新状态不从这里推导 |
| 同文件 `:621` / `hydratePublicListItems` | 列表和推荐的共同补全入口 |
| 同文件 `:767` / 推荐过滤 | 改用新商品状态，保留候选顺序与截取位置 |
| `server/src/modules/catalog/readinessOffer.ts:28` / `evaluateActiveOffer` | 纯本站商业/履约判断，无模板校验或远端调用；可复用此底层函数 |
| `server/src/lib/fakaBridge/capacity.ts:195` / `getFakaCapacityForPublicRead` | 未配置、冷读或远端失败可返回 source=unavailable；不能信默认 sellable |
| `server/src/lib/fakaBridge/client.ts:60` / `isFakaBridgeConfigured` | 本站 provider 配置事实来源；不靠 reason 文本判断未配置 |
| `server/src/modules/products/cache.ts:95` / list、detail key | 增加局部公开投影版本，避开部署前旧 Redis 响应 |
| `src/components/store/StoreProductCard.tsx:34` | 当前自己判断 Faka 售罄，并显示代表 Plan 的 x/y |
| `src/components/catalog/ProductOfferSelector.tsx:19` / `isOfferSoldOut` | 多处共用，保留符号、改为消费统一状态 |
| `src/pages/ProductDetailPage.tsx:466` / activeOffer | 页面持有所选套餐；`:477` 的商品代表容量回退需要收窄 |
| `src/components/store/types.ts`、`src/types/merchant.ts` | 卡片 Product 与共享 Offer 类型；公开详情及预览另有接线 |
| `server/src/modules/checkout/service.ts:122`、`:144` | 本地有限销售名额与外部容量各自生效；公开状态不能让远端正库存绕过本站限制 |

## 4. PR1 状态契约

### 4.1 公开字段

```ts
type AvailabilityStatus = 'available' | 'unavailable' | 'unknown';
type PublicAvailability = { status: AvailabilityStatus };
```

在以下既有响应中增量添加 `availability`：

- `/api/products` 的每件商品。
- `/api/products/:id/recommendations` 的每件推荐商品。
- `/api/products/:id` 的商品，以及每个公开 active Offer。

不新增接口、query 参数、持久化状态列或可供客户端写入的字段。公开对象只含 status，不返回套餐配置失效原因、内部错误码、externalSku、Plan ID、库存内容或新增内部缓存标记。

已有 stock、stockMode、fakaCapacity、价格等字段保留。stock 是数量展示兼容字段；新消费者不能再把 unlimited 等同于整件商品必然可售。

| 状态 | 含义 | 推荐准入 | 卡片与详情 |
| --- | --- | --- | --- |
| available | 至少一个有效套餐已知可售 | 保留 | 正常展示 |
| unavailable | 没有 active Offer，或所有 active Offer 均因本站配置/库存或已知远端状态不可售 | 排除 | “暂不可售”；所选套餐购买入口禁用 |
| unknown | 没有已知可售套餐，但至少一个本站基础条件满足的套餐远端容量未知 | 保留 | “可售状态待确认”；可以查看、选择并尝试原购买流程 |

unknown 不伪装成有货或不限量，也不当售罄灰化。尝试购买仍可能被已有结算/下单校验拒绝；沿用其错误处理，不新增“保证购买成功”的文案。

### 4.2 套餐级计算

新增 `server/src/modules/products/publicAvailability.ts`，导出 `evaluatePublicOfferAvailability` 和 `aggregateOfferAvailability`。命名可在代码风格范围内微调，职责与输出固定。

`evaluatePublicOfferAvailability` 接收已取到的 Offer、真实即时库存数量、本站 provider/webhook 配置事实及该套餐容量快照。执行顺序固定：

1. 调用 `evaluateActiveOffer` 获得本站 `configValid/sellable`。active 集合由服务层提供；停用 Offer 不进入汇总。
2. 本站配置无效或本地名额不足时，直接 unavailable，不因远端正库存或未知而放行。
3. 非 Faka 且本站判断通过：available。
4. Faka 且本站判断通过：source=xboard 时以规范化快照 sellable 判 available/unavailable；source=unavailable 或无可用快照时为 unknown。

即时卡密使用真实 `InventoryItem.status=available` 数量，不能依据 Offer.stock。固定内容/文件及自动开通只复用底层已有的就绪事实判断，不跑整个商品发布检查。

Faka 的容量解析模块已经把显式 sellable=false 与 remaining 合成规范化 sellable；不要在新模块再次实现一套远端规则。特别是：xboard 的 remaining=null 表示不限量，unavailable 的 remaining=null 表示无法确认，两者由 source 区分。

本地 provider 未配置、缺 SKU 或错误履约配置会在第 1 步成为 unavailable；暂时拿不到远端容量才进入 unknown。因此无需增加一整套快照错误码，也不得匹配 reason 文本来猜原因。继续使用现有配置检查和类型化 source 即可。

### 4.3 商品级汇总与 Plan 边界

```ts
function aggregateOfferAvailability(states: AvailabilityStatus[]): AvailabilityStatus {
  if (states.includes('available')) return 'available';
  if (states.includes('unknown')) return 'unknown';
  return 'unavailable';
}
```

空 active Offer 集合为 unavailable，即使旧 Product.stock>0。商品仍可按现有权限浏览，不改成 404，不自动下架，不制造虚拟默认套餐。

同 Plan 的多个周期共享远端容量；各 Offer 仍有各自本站启用状态、配置和销售名额。复用现有 Plan 缓存/同页批量读取，测试不要为同 Plan 凭空设置相反的远端可售状态。两个不同 Plan 才能有独立的远端状态。

商品三态是存在性汇总，不计算“可售 Offer 数量之和”。原库存数量继续使用 `dedupeFakaCapsByPlan`，不改同 Plan 去重、不增加跨快照仲裁或 SKU 名称猜测。Plan ID 缺失时保留既有 SKU 边界，不推断两个具名 SKU 共用容量。

例如：Plan A 不可售、Plan B 可售，且 B 至少一个 active Offer 本站名额充足，则商品 available。Plan A 不可售、Plan B 未知，且 B 本站条件满足，则 unknown。若 B 本站名额也为零，则 unavailable。

## 5. PR1 后端接线

### 5.1 取数与共享投影

在 `service.ts` 现有批量补全流程中完成以下工作：

1. 列表 active Offer select 补齐 `evaluateActiveOffer` 所需字段：fixedContentType、fixedContent、fixedFileId、fixedFile.status、autoProvision；商品取 merchantId 用于 webhook 归属。详情已有多数标量，只为 fixedFile 关联补 status，原 size 仍保留。
2. 保留一次 `countAvailableByOffer`；需要自动开通的商家集合一次批量查询 active webhook 配置。没有 autoProvision 时不查 webhook；不逐 Offer 查询。
3. provider 配置每次取数批次读取一次；继续 `loadFakaCapacityBySku`，不等待外部 HTTP。按同一批次的事实计算各 Offer 状态，再汇总商品状态。
4. `serializePublicProductListItem` 和 `serializePublicProductDetail` 使用该计算；详情把各 Offer 的状态与现有 `serializePublicOffer` 输出合并。
5. 固定交付内容只作为内部纯函数输入；列表仍不输出 offers，详情仍经公开白名单剥离内容。不得把新选取字段 spread 到公开响应。

不用为了“配置有效”额外查询秘密 InventoryItem.content、重验文件内容或执行 webhook 网络调用。已有真实库存数量、文件 active 状态及本地配置事实足够表达本轮契约。

### 5.2 推荐、列表与详情

推荐过滤改为 `item.availability.status !== 'unavailable'`，然后沿原逻辑取前 6 件。unknown 保留原排序位置，不新增状态加权；推荐不走结果缓存、不增补候选。

商城列表继续展示当前允许浏览的 active 商品，包含 unavailable 商品；不因新状态改变分页数量、排序或搜索资格。推荐主动排除 unavailable，而列表允许浏览，这一区别是产品规则。

详情继续返回商品及 active Offers。商品 available 不代表当前选中 Offer available，不能把商品状态复制给所有套餐。底层取数失败仍沿原错误出口处理，不伪装成 unknown；unknown 专指已明确无法确认的外部容量。

### 5.3 缓存处理

保留 Faka fresh/有界 stale/后台刷新，以及列表、详情现有 Redis TTL、audience 隔离和缓存外可见性检查；不增加轮询、跨进程容量缓存或新一致性保证。

采取两项局部修改：

- 在 `products/cache.ts` 的 list/detail key 加同一个固定公开投影版本，例如 `public-availability-v1`。reviews 和 cursor 协议不改。旧 key 自然过期，不做全库清缓存，也不检查旧对象后逐字段补救。
- 缓存条件依据参与计算的套餐快照，不依据代表性商品 fakaCapacity 或仅商品汇总状态。存在需要远端容量、但容量未知的有效套餐时，本次结果不写列表/详情 Redis。

建议使用服务层内部缓存包装 `{ data, hasUnknownFakaCapacity }`：计算状态时顺便收集一个布尔值，`wrapCache` 的 predicate 消费它；返回前只取 data。`hydratePublicListItems` 的两个内部调用方随之适配，推荐只使用 items。不要把标记放进公开 DTO，也不为判断可缓存再查询一轮。

本站已知无效的 Faka 套餐不需要未知容量来确定不可售，可正常按现有 TTL 缓存。商品 available 但另一个有效套餐 unknown 时，仍不缓存该批投影；避免代表快照掩盖部分未知。保留数据写入的原 `invalidateProductPublicCache`。

缓存中的状态依然是有时效的展示结果，不是实时交易承诺。本轮不为快照刷新新增全平台商品索引或广播失效机制。容量过期到 unknown、恢复到已知的行为沿原有时间窗口验证。

## 6. PR1 前端接线与展示

### 6.1 类型与唯一兼容入口

在 `src/types/productAvailability.ts` 放共享状态类型。在卡片 Product、公开详情 Product、公开 Offer 类型接上字段；`src/types/merchant.ts` 同时供管理端使用，因此不要求所有管理响应都新增 availability。

新后端的上述公开响应必须带字段。前端类型允许 availability 缺省，仅用于现有预览、测试夹具以及新前端遇到旧后端的发布窗口。

新增一个小型状态读取 helper，例如 `src/utils/publicAvailability.ts`：有 availability 时直接使用；缺省时按现有 stock/Faka 售罄规则回退。此处是唯一旧协议兼容分支，不根据商品标题、未知 reason 或别的套餐猜状态，不逐组件重写兜底。

保留 `isOfferSoldOut` 名称和调用面，内部仅判断统一状态是否 unavailable。unknown 返回 false，让套餐仍可选择。必要时直接读取 status 展示提示，避免把所有状态挤成售罄布尔值。

Store 列表和推荐原样保存完整卡片 DTO，不新增接口 adapter；精选/推广详情水合也应保留 availability。StorePage 缓存是页面模块内存，正常刷新随新 bundle 重建，完整对象可以保留新字段；不为本轮增设缓存版本框架。

### 6.2 商品卡片

`StoreProductCard` 三态展示固定为：

- available：正常卡片。普通本地商品保留现有数量标签。
- unavailable：使用现有不可售视觉，库存位置显示“暂不可售”；允许打开商品详情。
- unknown：正常可点击，库存位置显示“可售状态待确认”，不显示“0”“不限”或售罄灰化。

对于带 Faka 容量摘要且 available 的卡片，库存位置显示“查看套餐”，停止显示代表 Plan 的 x/y。这一决定覆盖单 Plan、多 Plan 和混合套餐，省去新增容量展示模式字段和商品总容量算法；所选套餐的准确名额仍在详情展示。保持原卡片尺寸、导航、同店标识和主题，不做紧凑卡片重设计。

卡片的新状态来自后端；不再独立用代表性 `fakaCapacity.sellable` 决定整件商品售罄。旧字段回退只留在统一 helper。

### 6.3 详情与套餐

由 ProductDetailPage 派生当前所选 Offer 状态，并传给现有布局/购买区域；不增加新的商品请求，不拆 loader、不改推荐请求依赖。

- 套餐选项：unavailable 不可选择，unknown 可选择并显示简短待确认提示。
- 初始套餐：保留有效的 URL offerId 选择；未指定有效选择时，优先首个 available，再选首个 unknown。全部 unavailable 时保留现有展示方式，购买禁用；不擅自切换用户已选套餐。
- 当前选中 unavailable：提示“该套餐暂不可售”，购买入口禁用，即使整件商品 available。
- 当前选中 unknown：提示“可售状态待确认”，仍进入原购买流程；余额、登录等按钮条件继续生效。
- 当前选中本地套餐：不回退商品的代表 Faka 容量。外部套餐的名额只从该 Offer 的快照取；unknown 不显示本地库存为远端名额，也不显示无限。

桌面购买栏、手机底栏/套餐抽屉和平板复用同一判断。PurchaseModal、CheckoutPreview、订单事务及最终 Faka 校验不改；不要借本轮迁移其他交易代码。

开发预览显式补齐符合演示内容的商品/Offer 状态，不调用真实接口；不通过所有 fixture 批量重写来制造必需字段。旧协议回退已有合理行为的测试数据可以保留。

## 7. PR1 验收与适量测试

### 7.1 测试分工

仅对独立风险增加证据。优先调整已有测试，新增纯计算测试放在 `products/publicAvailability.test.ts`；不为每个表格行建新文件。

| 层 | 覆盖内容 | 最小有效证据 |
| --- | --- | --- |
| 纯状态计算 | 套餐分类、本站限制、三态汇总、空集合 | 一份表驱动测试；本站基础规则已在现有 publicationReadiness 测试中覆盖 |
| 商品 API 集成 | 真实库存计数、列表/详情同状态、推荐准入与脱敏 | 复用 products 的 public-fields、recommendations；组合 fixture，避免每场景分别请求三遍 |
| 快照/缓存 | 非阻塞读取、同 Plan 共享、部分未知不缓存与状态恢复 | 复用 faka-capacity-public-read、cache 测试；探针替身及虚拟时间，不 sleep 或制造线程竞争 |
| 组件 | 卡片三态、所选套餐独立状态、unknown 选择与入口 | 复用 Card、Selector、PDP 现有测试；页面只测两条接线，不再重跑全部状态组合 |

纯状态测试包含下列具有不同决策分支的输入：

| 输入 | 结果 |
| --- | --- |
| 本地即时库存 Offer.stock 有值，真实可用数量为零 | unavailable |
| 本地 limited 数量为零，或本站配置失效 | unavailable |
| 有效本地套餐不限量 | available |
| 本站名额足够，Faka xboard remaining>0 但 sellable=false | unavailable |
| Faka xboard 已知可售，但本站 limited stock=0 | unavailable |
| Faka 本站通过，source=unavailable，即使 sellable=true | unknown |
| Faka provider 未配置或缺 SKU，即使默认快照 sellable=true | unavailable |
| 所有套餐 unavailable，或空 active 集合 | unavailable |
| unavailable 与 unknown，或全部 unknown | unknown |
| available 与 unavailable/unknown 混合 | available |

固定内容/文件/webhook 有效性复用 `evaluateActiveOffer`，其基础行为已有 `publicationReadiness.test.ts` / `publicationReadiness.v2.test.ts` 覆盖；新增公开投影接线证据即可，不复制完整发布规则矩阵。若确实修改了这个共享函数，再运行对应已有回归。

### 7.2 关键集成与页面证据

后端重点保留以下四组，允许一个测试表达多个相关断言：

1. 真实卡密数量决定状态；本地混合套餐商品 list/detail 同为 available，无 active Offer 的商品为 unavailable。推荐只剔除 unavailable。
2. 两个不同 Plan：一个不可售，另一个可售；本站有效 Offer 下商品 available。再用不可售+未知验证 unknown 保留。修改现有 `rec-flag` 旧断言，正库存但不可售不再入选。
3. 同 Plan 多周期数量不翻倍；先已知、过期变未知、再恢复，用可控时钟和探针顺序完成。另有商品汇总 available 但部分套餐未知时，验证不被代表快照写进缓存。沿用已有非阻塞测试证明请求不等待慢探针，不设新的毫秒性能门槛。
4. 扩展现有秘密哨兵断言，公开 list/detail/recommendations 不含新选入的固定内容、SKU、Plan ID 或内部缓存包装。

前端只新增/调整三组：

1. Card 表驱动检查 available/unavailable/unknown 的文字、可打开行为和 Faka “查看套餐”；保留旧 href/onOpen 回归。
2. Selector 检查 unavailable 禁用、unknown 可选；state helper 用一条旧字段回退用例，内部新状态无需重复整个后端矩阵。
3. PDP 用两条集成接线：商品 available 但所选套餐 unavailable 时不能放行；切到本地或 unknown 套餐时，不继承代表容量且 unknown 保留原购买入口。复用已有首个可售套餐测试检查初始选择，不重测路由/会话竞态。

### 7.3 检查入口与停止条件

实施使用项目 Node 22 / npm 10。依赖按锁文件安装；不为验证升级运行时依赖或修改锁文件。后端集成测试会清表，必须使用实施 agent 独占的可丢弃测试库；不要连接开发/生产库，不在交接贴凭据。

定向检查以实际修改为准，可从以下集合裁剪：

```bash
npm run check:runtime
npm --prefix server test -- src/modules/products/publicAvailability.test.ts src/modules/products/public-fields.test.ts src/modules/products/recommendations.test.ts src/__tests__/faka-capacity-public-read.test.ts src/__tests__/cache.test.ts
npm test -- src/components/store/StoreProductCard.test.tsx src/components/catalog/ProductOfferSelector.test.tsx src/pages/ProductDetailPage.test.tsx src/pages/ProductDetailPage.readonly-audit.test.tsx
npm --prefix server run build
npm run build
git diff --check
```

必要时加实际受影响的 Store/PDP 布局既有测试；不要求对不涉及的全部模块运行本地全量。新测试文件尚未实现，上述命令不是本文已经执行过的证据。

浏览器只做代表性手机和桌面状态检查：unknown 提示、套餐切换、不可售按钮、名额标签；顺手检查暗色与 200% 缩放不遮挡。不要求为每个状态、宽度和主题生成截图，也不新增纯 UI E2E。

PR1 改到详情购买入口和可交付状态判断，按 [测试政策 §3/§5](../testing-policy.md) 的关键购买旅程要求，实施 PR 打 `run-e2e`，运行现有 E2E 覆盖；不为此新增全套可售状态 browser spec。当前文档 PR 不打该标签。

定向检查与必要构建通过、无新失败或未解风险后停止重复测试，依赖 CI OK。若确实发现新的分支风险再补相应证据；不要求凑固定测试数量、全排列、随机测试、变异测试或压力基准。

## 8. PR1 任务与交接

| 顺序 | 实施内容 | 完成条件 |
| --- | --- | --- |
| T1 | 更新基线、核对上述符号及规则 | 记录 base SHA；只记录影响本方案的差异 |
| T2 | 纯状态模块、批量取数、列表/详情序列化 | 本地条件与 source 优先级正确；商品和 Offer 均带状态 |
| T3 | 推荐准入及 list/detail 缓存版本、部分未知缓存条件 | 顺序不变；unknown 保留；缓存包装不公开 |
| T4 | 共享类型/helper、卡片、Selector、详情派生和布局接线 | 无代表快照误判；unknown 可选择；旧数据仅一处回退 |
| T5 | 按 §7 定向验证与少量浏览器检查 | 提供真实结果、未执行项和原因 |
| T6 | 精确暂存、提交、PR/交接说明 | 文件范围清楚；不包含 PR2–PR5 实现 |

建议后端实现与测试一个提交，前端实现与测试一个提交，最终验证记录一个文档提交；不要求为了数量拆提交。PR 标题建议 `fix: unify public product and offer availability`。

交接报告必须包含实际 base/HEAD、分支/worktree、主要行为、测试通过与未执行项、对旧计划的库存准入变更、缓存版本及已知快照时效限制。准确说明是否推送/创建 PR；不自行合并或部署。

## 9. 后续路线与进入条件

以下工作项可以设计或准备，但不是 PR1 实施任务。每轮开始再对照最新 develop 写相应细节，避免提前冻结审计未知的业务决定。

### PR2：推荐数据质量只读审计

交付一份报告，必要时附最小只读查询脚本；不更新商品、不自动清洗、不导出库存或买家资料。生产数据查询使用既有授权与连接方式，不能把测试数据库的统计当线上结论。

检查对象为当前上架、未归档且经营者有效的商品及其结构化推荐字段；可售状态单独标注，不只审计已经进入推荐的商品：

- 按模板/分类统计 serviceName、contentCategory、关键字段缺失和不同写法。
- 单列 templateKey/version 为空或未知的商品，以及可能占用同店推荐位的弱匹配商品。
- 对确切来源可识别的 Xboard 商品，检查导入名称是否混入周期、套餐或版本；不要从营销文案推断上游服务实体。
- 给出疑似同义名称与误分类的样例，并标注“待确认”，不自动把 Steam Wallet 与 Steam 等名称合并。
- 使用现有 SQL 规则抽样比较推荐结果，报告疑似漏召回/弱相关占位和范围；不宣称样例比例等于全平台效果。

AI 创建目前未确认有持久化、可靠的来源标记。没有可靠记录时报告“历史 AI 来源无法准确区分”，不得用文案风格猜测。人工/AI 入口是否产生规范差异，可用本地演示样例或现有明确来源记录核查；本轮不为验证而往线上创建商品，不伪造历史归因。

退出条件：报告有真实数据范围、取样方式、数量与典型案例，能为 PR3 建议清单及 PR4 政策提供依据。没有足够证据时也可以输出“暂不调整”，不为推进路线硬造问题。

### PR3：创建字段规范建议

保留四个主阶段/七个底层步骤、原模板 Schema、草稿宽松/发布必填及保存绑定后的形态锁定。

先用平台审核、版本化的小规模配置给 serviceName/contentCategory 提供名称建议；两类字段分别维护语义，不共用一个“服务”字典。覆盖商家、平台共用字段组件，AI 摘录结果填入后走同一确认流程。商家可以保留原值，不新增推荐专用必填项。

建议只在明确映射下出现：“建议使用平台常用名称 Steam”，由用户点选采用；不静默替换、不改变商品展示名称/套餐名称/履约配置。保存绑定前提示形态锁定；规范提示与阻断发布的错误分开展示，不表示采用名称就保证推荐曝光。

历史商品及外部导入仅输出建议，未经确认不改写。Xboard 周期/版本词不能简单用正则剥除来猜服务名称。独立标准标识、新表、在线字典管理后台等在证据支持时另开方案。

最低验证：建议出现与采用/保留、草稿保存和发布不被建议阻断；复用表单组件与现有写入测试，不重新跑七模板全部创建链路。

### PR4：弱匹配准入调整

进入条件是 PR2 已给出数据依据，且 PR3 的目标字段有可执行的命名建议或确认流程。具体准入在这一轮评审后冻结，PR1 不提前改 tier。

评审方向：当前商品有明确主匹配值时，是否只允许确认相同的候选入选；缺值/legacy 是否停止补位。合格同店仍优先、跨店补足，少于 6 件可以接受。

manual_service、appointment 没有主键，不能机械要求 serviceName；未知模板作为基准的情况也要单独约定。名称建议不等于放开不同已知模板或不同分类的交叉推荐。候选补查、行为排序、向量/LLM 推荐不顺带实施。

最低验证：审计中的典型误召回/漏召回案例加 SQL 集成断言；沿用既有同店/null 平台桶测试，不复制完整 V1 验收矩阵。

### PR5：基础推荐效果统计

事件契约可与 PR2 并行设计。若要比较 PR4 前后，基础采集应在 PR4 上线前形成一段有效基线；PR 编号不要求采集等到规则改变之后。

先约定实际可见曝光、点击、来源商品/目标商品、位置、同店/跨店、策略版本，以及事件去重和兑换归因时间窗口。客户端请求返回不等于曝光；普通目标详情 PV 也不等于推荐点击。

相关性等级的分析需要后端真实元数据，不能由前端猜；是否增加返回字段或服务端记录在事件方案中决定。事件传输、存储和订单关联方式先核对现有 traffic/订单能力，避免直接新建通用埋点平台。

点击不代表兑换，归因兑换也不自动证明增量收益。第一轮报告曝光、CTR、点击后兑换、推荐覆盖率/平均件数，并说明样本、时间窗口和漏计限制。暂不做个性化、学习排序或广告计费。

最低验证：曝光定义/去重、点击来源保存、归因窗口边界；单元或服务集成即可，不逐事件建浏览器 E2E。

## 10. Git 与执行边界

本次方案在独立 `chore/public-product-availability-plan` 分支/worktree 提交，仅包含本文。主工作区的 CLAUDE.md 和检查脚本等未跟踪文件不接管。纯文档只检查内容、链接和 diff，不安装依赖、运行应用业务测试或修改应用版本。

实施 agent 从最新 origin/develop 创建独立 `fix/public-product-availability` 分支；路径已占用时换新路径，不强制覆盖他人分支或 worktree。

```bash
git status --short --branch
git worktree list
git fetch origin develop
git worktree add -b fix/public-product-availability /root/projects/worktrees/monexus-public-product-availability origin/develop
```

若本文未合并，先在功能 worktree 比较同路径，再仅引入交接文档提交中的本文；不要把功能基线切回文档分支，也不 cherry-pick 无关改动。

逐文件 `git add <精确路径>`，提交前查看 staged diff 和 `git diff --check`。不使用 git add . / -A、不提交 .env/凭据/日志/构建物、不重写 migration、不 bump 发行版本、不 force push、不直推 develop/master、不加 skip ci。PR base 为 develop，Squash merge 和 CI OK 遵循仓库规范。

实施授权仅覆盖 PR1 时，就完成 PR1 的代码、测试和交接。PR2–PR5 不因出现在路线中自动视为已授权实现；推送、创建 PR 按当时用户交付范围执行。文档和实施均不自行 merge/release/deploy。

## 11. 可直接交给实施 agent 的任务

> 实施 `docs/specs/public-product-availability-and-recommendation-quality.plan.md` v1.0.0 的 PR1（§1–8），后续 §9 是路线而不是当前任务。阅读方案与最新 Git/测试政策，以最新 origin/develop 创建独立 fix/public-product-availability worktree。复用纯 evaluateActiveOffer 的本站套餐判断、真实 InventoryItem 数量及已有 Faka 非阻塞快照，新增纯公开 Offer 状态与商品三态汇总；list/detail/recommendations 输出 availability.status，推荐只剔除 unavailable，unknown 保留。Faka 远端正库存不能绕过本站名额，未配置根据本地事实判 unavailable，容量无法确认根据 source 判 unknown，不匹配 reason 文本、不新增错误体系。保留 Plan 去重、库存数量、相关性 SQL、64 候选和最多6件。接上共享前端 helper、Card、Selector 与所选套餐购买入口；商品汇总不覆盖套餐状态，所选本地套餐不继承代表 Faka 容量，Faka 卡片显示查看套餐，unknown 可选择并走原购买流程。局部升级 list/detail Redis key，参与计算的有效套餐有未知容量时不缓存，内部包装不公开。避免重复校验、发送前复查、同步外部探测、模板/交易重构、额外依赖或 migration。按 §7 做分层定向验证，不重复状态矩阵、不新增纯 UI E2E；本功能涉及购买入口，按测试政策为实施 PR 打 run-e2e 运行现有覆盖。精确暂存、报告实际 base/HEAD 与验证/未执行项，按授权范围交付，不自行合并或部署。

## 12. 实施记录（实施后填写）

- 实际 base：`origin/develop@163673b01a88eabfe572a90281abf878b46c910c`（与核验基线一致，锚点无漂移）；HEAD 见分支最新提交。
- 分支 / worktree：`fix/public-product-availability`（`--no-track` 创建，未跟踪 origin/develop），`/root/projects/worktrees/monexus-public-product-availability`；仅本地提交，未推送、未建 PR。PR 创建时按 §7.3 打 `run-e2e`。
- 主要行为：新增 `products/publicAvailability.ts`（复用 `evaluateActiveOffer` + 规范化快照 source/sellable）；list/detail/recommendations 输出 `availability.status`，详情每个 active Offer 另带状态；推荐只剔除 unavailable；list/detail Redis key 加 `public-availability-v1`；有效套餐存在未知容量时不写缓存（列表用内部 `{ data, hasUnknownFakaCapacity }` 包装，详情直接用各 Offer 公开状态判断，未另包一层）；前端唯一兼容入口 `src/utils/publicAvailability.ts`，卡片三态、套餐“待确认”提示、所选套餐决定购买入口、本地套餐不继承代表 Faka 容量。
- 规则差异（均为展示细节，不改契约）：
  - 卡片 unknown 文案为“状态待确认”而非“可售状态待确认”：手机卡片固定高度，长文案换行后被截断或挤压价格（浏览器 320/390 实测）。详情与套餐区仍用完整“可售状态待确认 / 可售状态：待确认”。
  - 所选套餐 unavailable 时购买按钮文案由“已被抢光”改为“该套餐暂不可售”；套餐选项内的“已售罄”标签保持原样。
  - 额外修复 `ProductExchangeSummary` 按 `offer.stockMode` 推断“库存不限”的问题（unknown 外部套餐会被显示为库存不限），以及 unknown 状态圆点显示为“有货”绿色的问题（改中性灰）。
- 定向测试（独占可丢弃测试库）：后端 `publicAvailability.test.ts`（表驱动 17 例）、`public-fields`、`recommendations`（改写 `rec-flag` 旧断言，新增两 Plan 可售/未知组合）、`cache.test.ts`（部分未知不缓存→全已知缓存→过期变未知→恢复，含同 Plan 两周期名额不翻倍）；扩大回归 products/merchandising/faka-capacity/cache/product-lifecycle/offers/reviews/publicationReadiness/chatbot 共 23 文件 265 例通过。变异检查：列表缓存条件改为只看商品汇总状态后缓存用例失败。前端 catalog/store/pages 60 文件 497 例、全量 components/pages/utils/hooks 160 文件通过；变异检查：恢复代表容量回退后 PDP 用例失败。
- 构建：`npm run build`、`npm --prefix server run build`、`git diff --check` 通过（Node 22.23.1）。
- 浏览器（headless，可丢弃开发库，Faka 指向不可达本地端口以产生 unknown，已清理）：商城 320/390 卡片四态文案与灰化正确且不挤压价格；手机/桌面详情初始选中首个 available、unknown 可选且显示待确认、unavailable 禁用；暗色主题 + 720px（≈1440 的 200% 缩放）无遮挡、无横向溢出。访客状态购买按钮仍为“登录后兑换”（原有优先级）。
- E2E / CI：本地未运行 Playwright；按测试政策依赖 PR 的 `run-e2e` 与 CI OK。
- 快照及缓存残余限制：使用既有有界快照与 Redis TTL，不提供实时锁库存承诺；缓存中的已知状态在 TTL 内可能滞后于远端变化。
- 推送 / 合并 / 部署：未执行。
