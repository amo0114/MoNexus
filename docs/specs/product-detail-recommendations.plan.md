# 商品详情页相关推荐：产品规则与实施交接方案

| 项目 | 内容 |
| --- | --- |
| 文档 ID | `PLAN-PDP-REC-001` |
| 版本 | `1.1.0`（方案版本） |
| 日期 | 2026-10-14 |
| 状态 | 交接方案；本轮只提交文档，功能尚未实施 |
| 代码审查基线 | `develop@7dc79aaf8c7417e5ec244cbdbe35950fecfde266` |
| 用户确定的方向 | 同商家的相关商品优先，不足时用其他商家的相关商品补充 |
| 实施方式 | 一个实施 agent，独立 worktree，顺序完成后端、前端与验证 |
| Git / 测试规范 | [分支与 CI](../branching-and-ci.md)、[测试政策](../testing-policy.md) |

## 1. 交付目标和决定

在真实商品详情内容下方展示最多 6 件相关商品。先展示当前经营者的相关商品，再用其他经营者的相关商品补足。相关性是进入候选的门槛，同店是通过门槛后的优先级。

例如查看商家 A 的某服务订阅：A 有 2 件相关订阅、B/C 有 5 件相关订阅，则展示 A 的 2 件和跨店排序靠前的 4 件。A 有账号商品或另一项明确不同的服务时，这些商品不能仅因同店进入推荐。

本方案采用以下第一版默认决定。这些是针对本项目的设计选择，不宣称已通过转化实验：

| 决定 | 第一版行为 |
| --- | --- |
| 推荐意图 | 同类、可比较的商品；搭配商品另行设计 |
| 数量 | 服务端固定最多 6 件，接口没有 query 参数 |
| 分类范围 | 必须同 `categoryId`，不跨分类、不用旧 `type` 字符串代替分类 |
| 商家优先 | 严格分组：同店合格候选在前，跨店候选在后；不保留固定跨店名额 |
| 平台自营 | `merchantId=null` 视为平台经营者，同属平台自营的候选优先 |
| 不足 | 返回实际有效数量；不加无关热门商品，不无限补查 |
| 无结果 | 隐藏整个推荐模块 |
| 不可兑换候选 | 排除已知售罄或没有 active Offer 的商品；外部容量未知按既有未知语义处理 |
| 失败 | 推荐模块静默隐藏，主详情、套餐选择、分享和兑换仍正常 |
| 页面覆盖 | 手机、平板、桌面三种现有布局 |
| 数据与依赖 | 复用现有模型、库存与公开投影；不新增表、迁移或运行时依赖 |
| 运营机制 | 不注入首页推广/精选，不改变自然商品列表排名 |

同店可以占满全部 6 个位置，这符合本轮方向。跨店结果不增加按商家数量配额；需要商家多样性时再以实际数据调整。用户修改这些产品决定时同步修改规则和验收，不让实现与文档各自演进。

## 2. 已核验现状与代码锚点

以下行号属于上表基线；实施时优先按符号定位，并记录后续基线差异。

| 位置 | 现状 / 可复用内容 |
| --- | --- |
| `server/src/modules/products/routes.ts:11` | 列表、评价、详情接口均使用可选认证和有效用户检查；没有相关推荐接口 |
| `server/src/modules/products/controller.ts:5` | `noStore` 设置 `Cache-Control: private, no-store`；audience 由服务端身份派生 |
| `server/src/modules/products/visibility.ts:20` | `publicVisibilityWhere` 限制 active、未归档、有效商家及 guest 的 public 可见性 |
| `server/src/modules/products/visibility.ts:40` | `assertPublicProductAccess`；会员商品对游客返回通用 403，下架等返回 404 |
| `server/src/modules/products/service.ts:47` | `productListSelect` 和列表库存/商家/分类投影，可用于候选卡片 |
| `server/src/modules/products/service.ts:130` | `computePublicAvailability`；即时库存应取真实 InventoryItem 可用数量 |
| `server/src/modules/products/service.ts:216` | `serializePublicProductListItem`，列表不输出 offers、内部库存计数和商家状态 |
| `server/src/modules/products/service.ts:251` | `loadFakaCapacityBySku`，只读已有容量快照并触发已有后台刷新 |
| `server/src/modules/products/service.ts:483` | 列表排名来自 merchandising snapshot；不能改读 legacy `Product.isHot` |
| `server/src/modules/products/service.ts:660` | `getProductDetail`，缓存按 audience 隔离，响应前有当前可见性复查 |
| `server/src/lib/offers.ts:248` | `projectPublicTemplateAttributes` 只投影允许的属性键 |
| `server/src/modules/catalog/templates/registry.ts` | `getProductTemplate` 是模板定义来源 |
| `server/src/modules/catalog/templates/definitions.json` | 七套模板公开属性与展示顺序，无通用 tags 字段 |
| `server/prisma/schema.prisma:527` | Product 有 categoryId、nullable merchantId、模板属性、visibility；有分类索引 |
| `src/pages/ProductDetailPage.tsx:232` | 真实详情请求；目前 load effect 缺少路由切换的过期结果保护 |
| `src/pages/ProductDetailPage.tsx:585` | 桌面、手机、平板布局分支；推荐需由页面统一获取并传入各分支 |
| `src/components/catalog/productDetail/desktop/DesktopDetailContent.tsx:53` | 真实详情的 details 分支；现有 related tab 仅为 preview |
| `src/components/catalog/productDetail/mobile/MobileDetailContent.tsx:104` | 真实详情的 details 分支；现有推荐是 preview 静态内容 |
| `src/components/catalog/productDetail/ProductDetailTablet.tsx:410` | 平板参数和评价区域；需补推荐挂载点 |
| `src/components/store/StoreProductCard.tsx:17` | 可复用商品卡、积分、库存和经营者展示；当前根节点是可点击 div |
| `src/components/store/types.ts:10` | 商城卡片共享 Product 类型，避免从 StorePage 导入页面类型 |
| `src/api/client.ts` / `src/auth/sessionContext.ts` | 复用统一 axios 和会话上下文；不能自行改变刷新会话逻辑 |

与现有 [商品模型与结算总纲](product-model-and-checkout.md)、[商品内容规格](product-commerce-v2/spec.md) 保持一致：分类、模板、履约是不同概念；Offer 是商业和库存真相源；商品公开接口不包含交付秘密。新推荐出口沿用商品内容规格 §6.2 的 audience 和 no-store。列表、详情的缓存读取继续保留原有实时可见性检查；本推荐接口不使用结果缓存，候选 SQL 和卡片补全查询直接应用当前权限谓词，不新增临发送前的第二轮复查。

## 3. 相关性规则

### 3.1 基础资格

基准商品先通过与详情相同的当前访问检查。不能基于游客无权查看的商品返回推荐列表。

候选必须同时满足：

1. `id != currentProductId`，且 `categoryId == current.categoryId`。
2. `publicVisibilityWhere(audience)`；游客仅 public，登录用户仍不能看到下架、归档或经营商家已停用的商品。
3. 至少一个 active Offer。旧数据没有 active Offer 时不作为主动推荐候选，不改变其原详情兼容行为。
4. 通过下面的模板与关键属性检查。
5. 补全后的公开卡片不满足 `stockMode !== 'unlimited' && stock <= 0`。

不额外要求分类为 active：分类停用不自动等于商品下架，遵守现有商品详情可见性契约，不在本功能新增生命周期规则。

### 3.2 模板与关键属性

模板是否已知以 registry 的精确 `templateKey + templateVersion` 可解析为准。不能仅凭非空 key 就视为合法模板，也不把分类映射成模板。

| 模板（两者为同一已知版本时） | 主匹配键 | 次匹配键 |
| --- | --- | --- |
| `redemption_code` | `serviceName` | `region` |
| `account` | `serviceName` | `accessModel` |
| `digital_file` | `contentCategory` | `formats`、`compatibility` |
| `fixed_content` | `contentCategory` | 无 |
| `subscription` | `serviceName` | 无 |
| `manual_service` | 无 | 无 |
| `appointment` | 无 | `deliveryChannel` |

这张表是推荐策略，不是另一份模板 schema。读取键必须同时在对应 registry 的公开 `ui.productOrder` 中。新增模板版本先补明确的策略；无对应策略的版本按未知模板处理，不自动沿用旧版本字段语义。Offer.attributes 不用于第一版匹配，避免把不同套餐当不同商品或由当前选中的套餐改变整个推荐。

具体规则：

- 双方都是已知模板，但 key/version 不同：排除。第一版保守限制同类形态，避免把替代与搭配意图混合；不据此修改商品发布或分类规则。
- 双方为相同已知模板，主匹配键都有效且不相等：排除。例如两个 serviceName 明确分别为服务 A、服务 B，即使同店同分类也不推荐。
- 双方为相同已知模板，主匹配键都有效且相等：`relevanceTier=3`。
- 双方为相同已知模板，但没有主匹配键或任一主匹配值缺失：`relevanceTier=2`。
- 至少一方模板为 legacy/null/未知，且分类相同：`relevanceTier=1`，不读取不受 registry 约束的 JSON 字段作匹配。
- 不同地区、共享/独享、文件格式差异只影响次排序，不作第一版硬排除；它们可能是用户正在比较的不同方案。

`manual_service` 和 `appointment` 的服务描述通常是自由文本，现有字段不足以可靠推断具体意图。因此这里只能保证同分类、同模板的粗粒度匹配。不要用全文相同、商品名包含词或 AI 猜测补造相关性。分类过宽或名称不一致造成的漏召回/误召回属于第一版已知限制。

### 3.3 值归一化与次匹配

相关性归一化、冲突排除与分数仅在候选 SQL 中计算，采用以下轻量规则：

- 标量仅比较字符串；去除首尾 ASCII 空格 U+0020，将 ASCII A–Z 转为 a–z。空字符串按缺失处理。
- 不改内部空格、不删标点、不展开缩写、不做拼音/同义词/Unicode NFKC 推断。
- JSON 的 number、boolean、object 不强转成字符串；字段类型不符按缺失处理。
- 次匹配键为字符串时比较归一化值；为字符串数组时去除无效/空项、归一化、去重，有交集即该键计 1 分。缺失或两边空数组不计分。
- `secondaryMatchCount` 是匹配的次键数量，不是共享数组项数量；不把长数组重复内容变成额外加分。
- 非策略键、未知 JSON 键、说明长文、固定交付内容、买家答案均不参与。

SQL 使用 `translate(btrim(value, ' '), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')` 并在取值前检查 JSON 类型。应用层只保留候选 SQL 返回的分数和顺序，不另写 JS 归一化、匹配、重新打分或重排实现。归一化例子：`' Service A '` 与 `'service a'` 相等；`'service  a'` 与 `'service a'` 不相等。规则用 PostgreSQL 集成测试验证，不要求两套实现相互核对。

### 3.4 排序与经营归属

在合格候选中使用确定性降序元组：

```text
(sameSeller, relevanceTier, secondaryMatchCount, productId)
```

- `sameSeller`：当前与候选 merchantId 相等，包括二者均为 null 的平台桶。
- 同店通过资格的弱匹配可排在跨店强匹配之前，这是本轮“同店优先”的明确语义。
- `productId DESC` 仅作为相似度相同后的稳定兜底，不声称是更受欢迎或质量更高。
- 第一版不用销量、评分、热门、价格距离打分；不复制或改写首页排名算法。
- 输出按 productId 去重后截取前 6 件，前端严格保留服务端顺序。

merchantId 不能由客户端参数传入。当前 merchantId 非空时，跨店谓词必须包含 null 平台商品，例如 `(merchantId IS NULL OR merchantId <> currentMerchantId)`；不能用只排除非空相等的 SQL 而漏掉 null。当前 merchantId 为 null 时，跨店谓词为 `merchantId IS NOT NULL`。

## 4. API 契约

新增只读接口：

```http
GET /api/products/:id/recommendations
Cache-Control: private, no-store
```

- params 使用现有 `idParamSchema`。
- 服务端常量固定返回最多 6 件，不定义或解析 query 参数，不新增 limit 的 Zod schema。传入额外 query 不改变数量、经营者、audience、分类或排序，保持无查询配置的接口。
- 中间件与详情相同：`authenticateIfPresent`、`requireActiveUserIfPresent`、validate。
- controller 使用 `resolveProductAudience(req.user)`；有无效凭证时保留原认证错误，不静默降级游客。
- 路由放在 `/:id` 详情路由之前，保持可读的子资源组织。

响应逻辑形状（下面名称用于契约，最终复用现有 TS 公开卡片类型）：

```ts
type RecommendationItem = PublicProductListItem & {
  recommendation: { sameSeller: boolean }
};
type RecommendationsResponse = {
  productId: number;
  items: RecommendationItem[]; // 0..6，已排序、去重
};
```

PublicProductListItem 表示当前 `/api/products` 单项的公开字段、商家/分类、可见性、真实库存摘要、Faka 容量摘要和权威 merchandising/assurance 投影；不是原始 Prisma Product。具体 nullable 字段继续遵循现有 wire contract，不填虚假图片、商家 ID、评分、销量或价格。客户端声明必须表达服务器真实的 nullable 形状，需要适配既有卡片类型时明确适配，禁止 `as any` 掩盖差异。

例：无候选返回 `200 {"productId":42,"items":[]}`。sameSeller 由服务端计算；不输出相似度分值、候选池、merchantId 原始内部字段、模板原始 attributes、offers、秘密库存、externalSku 或管理字段。

| 场景 | 行为 |
| --- | --- |
| 基准商品不存在、下架、归档、经营商家失效 | 404，沿用商品暂不可用错误 |
| 游客访问 members_only 基准商品 | 403 `PRODUCT_LOGIN_REQUIRED`；无基准或候选的商品片段 |
| 参数无效 | 400，既有验证错误 |
| 合法商品无推荐 | 200，items 为空 |
| 候选补全时不符合当前权限或投影后售罄 | 返回剩余候选，可少于 6 件 |
| 数据库或必要公开投影失败 | 原有 5xx；不能伪装成成功的空数组 |

no-store 要覆盖该路由的错误出口，可使用路由级响应头中间件；复用现有 auth/validate，不为此改写全局认证或错误处理。

## 5. 后端实现约束

### 5.1 模块边界

新增 `server/src/modules/products/recommendations.ts`，只组织有限策略表与候选 SQL 查询；在 service.ts 内编排推荐并导出 controller 所需入口，routes/controller 只做小型接线。不新增 query schema，也不新增 JS 相关性计算模块。

明确在 `service.ts` 内抽出 `hydratePublicListItems(orderedIds, audience)`，列表与推荐共用，职责固定为：

1. 将输入 ID 去重，空输入直接返回空数组；使用 `productListSelect` 和 `publicVisibilityWhere(audience)` 一次批量读取当前可见商品。
2. 按 orderedIds 恢复顺序，剔除缺失或不可见项，不能让 ORM 的 IN 查询结果顺序决定展示顺序。
3. 从 active offers 一次批量统计所需即时库存，调用原 `loadFakaCapacityBySku` 读取快照，使用原 `serializePublicProductListItem` 生成公开卡片。

列表的 `listProductsFromDb` 后半段改为调用该函数，nextCursor/hasMore 仍从原 ranked/pageRows 生成。`listProducts` 缓存之后的当前可见性过滤、`attachListMerchandising` 和保障装饰继续保留在缓存之外，不把时效性身份/保障写入缓存，也不改变 cursor 钉住的 run。

推荐在同一 service.ts 调用该函数后，使用现有 `attachListMerchandising` 和 `loadPublicAssuranceByProductIds` 补上商家展示信息与保障。推荐的 run 与详情相同，用 `resolveCursorForRequest(null)` 取当前 completed run，没有 run 时为 null；它仅影响卡片展示，不参与推荐相关度排序。不能逐候选调用详情接口，也不复制库存、Faka、merchant DTO 或身份装饰实现。不新建 projection 文件、不重构整个产品模块。

### 5.2 查询与候选上限

一次请求固定以下流程：

1. 读取基准商品最小字段：id、categoryId、merchantId、模板 key/version、公开属性所需 JSON、生命周期与商家状态、visibility。通过 `assertPublicProductAccess`，不调用完整详情缓存取得 stale 匹配信息。
2. 按“同经营者”和“其他经营者”分别查询候选 ID 与规则分数。两组独立，可并行；每组最多 64 行，总共最多 128 个 ID。将 64 定义为服务端常量，不由用户配置。
3. 候选 SQL 在 LIMIT 前完成同分类、当前权限、active Offer 存在、模板冲突/主值冲突排除，以及 `(relevanceTier, secondaryMatchCount, id) DESC` 排序。不能先取最新 64 个再内存猜相关性，否则旧的强匹配可能被近期不相关商品挤出。
4. 用 Prisma.sql / 参数化 `$queryRaw` 组织有限 CASE/条件片段；复用 `merchantVisibleSql`、`guestVisibilitySql` 或等效公共谓词。属性 key 只由服务端有限策略表选择并参数化，用户输入不能进入 SQL 标识符/片段；禁止 `$queryRawUnsafe` 拼接。
5. 按同经营者在前、其他经营者在后的顺序合并 ID，调用 `hydratePublicListItems(orderedIds, audience)`，按 §5.1 复用既有卡片和身份/保障投影。SQL 的相关性分数只算一次；补全保留候选顺序，不读取属性重新判定或打分。
6. 对补全后的卡片使用第 5.3 节唯一库存规则过滤，去重并截取前 6 件，返回干净 DTO 和 SQL 已确定的 sameSeller，不自动继续下一批。

以上是直接读库的只读推荐流程，不新增发送前第二轮商品/属性查询，不读取 contentVersion 作一致性比较，不返回写操作的 `PRODUCT_CONTENT_CHANGED`，不增加重打分或竞争重试。SQL 选候选和按 ID 补全卡片均应用权限条件；响应之后的库存或内容变化仍由原详情/结算链路处理，推荐不提供跨查询快照保证。

上限保证的是应用候选数与批量 hydrate 成本，不等于数据库只扫描 128 行。categoryId 有现成索引，但 merchantId/JSON 尚无专用索引；相似度排序仍可能扫描本分类候选。实施时在可丢弃测试库查看代表性类别的 `EXPLAIN (ANALYZE, BUFFERS)`，确认不是全平台无分类过滤的查询。不能仅凭 LIMIT 宣称性能已解决。

已知折中：前 64 件同组商品若大量已售罄或在补全查询时已不可见，结果可能不足，即使更后面的候选尚可兑换。第一版接受少展示，不做无限分页补查。记录此限制；若实际类别规模使查询不可接受，应提供执行计划和必要索引建议再修订方案，不偷偷新增 migration 或放宽相关性。

### 5.3 库存、价格与身份投影

库存筛选只有一条：对 `hydratePublicListItems` 补全后的卡片，满足 `stockMode !== 'unlimited' && stock <= 0` 时剔除，其他保留。所有套餐、即时库存、混合套餐和 Faka 容量语义由既有公开投影负责，推荐不额外判断 sellable、remaining 或原始 Offer.stock。容量未知沿用现有投影的回退结果，不因 unknown 标识单独剔除或强制保留；是否入选仍取决于同一 stock/stockMode 规则。

- 商品价格继续使用现有 Offer 写入维护的最低价公开投影，积分为整数；不新增价格计算源，不从推荐决定兑换价格。
- merchandising、平台自营、合作身份和 assurance 均通过现有公共 projection；不直接读 legacy isHot，不复制过期授权的徽标。

### 5.4 缓存与可观测性

第一版不为推荐增加 Redis、模块级结果缓存或浏览器持久缓存；请求直接读库并复用既有 Faka 容量快照。既有列表/详情缓存行为保持，响应 `private, no-store`。

页面身份变化即清除当前推荐。API 失败仍经过现有日志/错误观测；前端使用现有错误报告入口记录推荐请求失败，至少能区分失败与真正空结果。取消、过期会话和路由过期请求不报故障；日志不含属性全文、凭据、买家资料或交付内容。不为本轮新建 analytics 表、点击计费、曝光账单或一套监控框架。

## 6. 前端与用户体验

### 6.1 数据所有权与竞态

新增薄 API adapter，例如 `src/api/productRecommendations.ts`，调用统一 api client 的 `/products/:id/recommendations`，支持 AbortSignal。新增推荐类型在 `src/types/productRecommendations.ts` 或既有公共商品类型附近，不从 StorePage 导入类型。

由 ProductDetailPage 或其专用 hook 统一持有 `{requestKey, loading, items}`；三个布局只接收同一渲染节点/props，不分别请求。

requestKey 至少包含 route productId 和现有 auth session identity。不能只依赖 isLoggedIn boolean：同为登录状态的用户 A→B 换账号也必须清除旧结果。沿用 sessionContext 与共享 axios 的会话保护，不修改认证流程。

请求规则：

1. 推荐 effect 只按有效路由 id、会话身份和 preview 模式触发，不依赖 product 对象、searchParams 或已选套餐。真实模式下可与主详情独立启动请求；preview 不发。主详情加载中、锁定页或404时不渲染推荐，详情成功且 requestKey 对应后才展示当前推荐状态。
2. 请求独立于详情 loader，不用 Promise.all 等待推荐后才展示主详情，不把推荐 loading 写入页面级 loading。
3. 商品 ID、preview 状态或 auth session 变化时立即清空推荐并取消旧请求；渲染时也以 requestKey 判断结果归属，避免 effect 运行前一帧旧卡片泄漏。
4. 请求开始就保存 epoch/cancelled 标记；成功、失败、finally 均校验请求归属。AbortController 是取消机制，过期检查仍需保留。
5. 响应 productId 不等于请求 ID 时拒绝该结果并记录协议错误；不把结果显示到另一件商品下。
6. 当前套餐选择只改变本地 selectedOfferId，不写 URL；推荐请求不依赖它或 product 对象，因此不会因切套餐而重发。只改变 offerId query 也不改变推荐请求键；保留原主详情的 searchParams 依赖与 URL 套餐选择/失效提示行为，不拆分详情加载逻辑。
7. 本功能增加详情→详情导航，只给现有主详情 load effect 补过期结果/取消保护，不修改其现有依赖项；旧详情的 catch、finally 也不能 toast、导航首页或清除新详情 loading。保持原登录和套餐选择行为，避免无关重写。

从 A 点击 B，再快速点 C，最终只允许 C 的详情与推荐显示。退出登录后旧会员推荐不能在新请求完成前留在 DOM。

### 6.2 挂载位置与显示状态

新增共用 `RelatedProductsSection`，三种布局接收同一模块。标题统一“相关推荐”，不添加真实页的推荐独立 tab。

- 桌面：放在 DesktopDetailContent 的真实 `details` 内容末尾、商品参数/购买须知/FAQ 后。切换评价 tab 时沿用当前 tab 内容组织，不把推荐插进评价列表。
- 手机：放在 MobileDetailContent 的真实 `details` 分支末尾。不要沿用商家卡与详情 tabs 之间的 preview 推荐位置。
- 平板：放在 ProductDetailTablet 的 ProductSpecSections 后、reviews 前；不进入购买卡。
- 详情正文没有图文/可选参数时，推荐仍可作为详情区域末尾的有效内容出现。

| 状态 | 界面 |
| --- | --- |
| 推荐未开始 | 不渲染 |
| 推荐加载中 | 模块级紧凑骨架，尺寸不阻断详情；aria-busy，无虚假商品内容 |
| 有结果 | 标题 + 卡片网格，0..6 件按服务端顺序 |
| 空结果 | 标题、骨架、分隔线一起移除 |
| 推荐请求失败 | 模块隐藏，不 toast、不整页错误、不导航首页、不妨碍兑换 |
| 路由/会话切换 | 旧内容立即移除，仅渲染当前请求的状态 |

布局采用现有主题、间距和卡片，不新增轮播或无限加载：320–359px 一列，360–1023px 两列，≥1024px 三列；在实际详情内容宽度不足时允许降低列数，不压缩卡片造成溢出。移动端保持底部兑换栏安全区，长名、长价格、缺图与 200% 缩放不横向溢出。

### 6.3 卡片复用与交互

优先复用 StoreProductCard 的媒体、积分、库存、评分和身份投影。允许增加 optional props，如 `relationLabel` 与 `href`，保持原商城 onOpen/disclosure 默认行为；不要把“同店”伪装成 sponsored/editorial disclosure。

- 普通商家同店候选：文本标识“同店”。
- 当前与候选均为平台自营：标识“平台同类”，不构造不存在的商家 ID；平台自营身份仍来自现有 projection。
- 跨店：显示真实经营者，手机上也可读，不能只在 sm 以上显示经营者。
- 积分而非人民币；无评分沿用“暂无评分”；不使用 preview 的虚假评分和销量。
- 商品链接为 `/product/<真实数字 ID>`。不携带旧 offerId、preview 参数、价格或用户资料。
- 链接支持键盘、焦点、读屏名称和新标签打开。不能直接复用当前仅 div onClick 的根节点而遗漏键盘操作，也不能将含可点击按钮的整个卡片嵌在另一个 link 中。
- 最小修改方案为 optional href 分支使用 Router Link / 合法 anchor，并保留旧 onOpen 分支；若提取视觉 card body，保留原 Store 的点击和滚动恢复行为。回归 StoreProductCard 测试。
- PDP 的推荐导航不调用 StorePage 的滚动保存函数。进入新商品后按现有详情路由滚动策略回到顶部；验证浏览器返回仍能正常使用。

不借此重新设计首页商品卡或新增全局动效。若实施实际需要新增动效，先读取适用 skill；本方案本身不要求额外动效或素材。

### 6.4 Preview 兼容

`?preview=aster-link` 仅 DEV 参考页，继续使用原 fixture 和预览行为，不调用真实推荐 API。真实页不得兜底到 referenceRelated、人民币价格、字符串 mock ID 或预览店铺弹窗。真实推荐模块只接生产 DTO；若共用 preview UI，必须显式适配，不能让 mock 被当作生产结果。

## 7. 实施任务与提交边界

按以下顺序完成一个功能 PR；不拆成只能展示假卡片的前端 PR，也不让未接线的半成品宣称完成。

| 任务 | 工作与建议文件 | 完成条件 |
| --- | --- | --- |
| T1 基线确认 | 阅读本文、Git/测试政策，核对锚点与当前 API/模板/会话契约 | 记录实际 base SHA；无未说明的产品语义差异 |
| T2 规则和查询 | 新 recommendations SQL 模块；service.ts 抽 hydratePublicListItems 并编排；controller/routes | SQL 单处归一化与打分、资格、排序、null 平台桶、固定 6 件与候选上限清楚；接口可返回真实 DTO |
| T3 后端验证 | `recommendations.test.ts`，复用现有 products 集成夹具 | §8 后端断言通过，权限和秘密字段无回归 |
| T4 客户端数据 | API adapter/types、专用 hook 或页面 effect；主详情过期保护 | 单请求源、请求归属、会话清除与独立失败成立 |
| T5 页面接线 | RelatedProductsSection、三种详情布局、StoreProductCard 最小兼容扩展 | 真实 6 卡、同店标识、积分、合法导航，preview 不回退混用 |
| T6 前端与浏览器检查 | 新推荐组件/hook 单测 + 受影响既有 PDP/Card 测试 | 空/失败/竞态、三布局、键盘与手机安全区验收 |
| T7 交接 | 更新本文末尾实施记录、整理 diff、提交、准备 PR 说明与证据 | 按 Git 规范交回 Owner/主代理 review；不自行 merge/deploy |

建议提交粒度（每个提交包含相应实现和有效测试）：

1. `feat(products): add same-seller-first related recommendations`
2. `feat(catalog): show related products across detail layouts`
3. 必要修复使用 `fix(products): ...` / `fix(catalog): ...`，最终证据使用 `docs: record product recommendation verification`。

service.ts 中公共补全函数的行为等价提取若明显独立，可先做 `refactor(products): share public list item hydration` 并跑原投影测试；保留列表缓存外的当前可见性/身份/保障处理，避免纯粹为分提交把功能切成不安全中间状态。

## 8. 验收与测试矩阵

### 8.1 后端

后端采用真实 PostgreSQL 集成测试，直接验证 SQL 的归一化、资格和排序。优先把场景放进一个 recommendations.test.ts，复用 fixture，不另写应用侧匹配算法用于对照、不逐 AC 新增文件。

| AC | 输入 / 操作 | 必须观察到 |
| --- | --- | --- |
| B01 | 同店有 2 件合格商品，跨店至少 4 件 | 返回 6 件，前 2 件同店，后 4 件跨店 |
| B02 | 同店超过 6 件 | 返回前 6 件且全部为同店，内部符合相关性与 ID 兜底顺序 |
| B03 | 同店无合格商品 / 所有候选都不足 | 跨店补足或少返回；无关分类不入列 |
| B04 | 同分类同店，但模板或有效主值冲突 | 排除；相同 primary、缺失 primary、legacy 的 tier 正确 |
| B05 | 空值、不同类型、首尾空格、ASCII 大小写、数组重复/交集 | PostgreSQL 查询结果和排序符合 §3.3；没有应用侧第二套归一化 |
| B06 | base 和候选 merchantId 为 null / 非空 | 平台桶优先；跨店补充包含平台商品；sameSeller 正确 |
| B07 | 游客/登录用户，public 与 members_only 混合 | 游客无会员候选；登录可见会员候选；游客会员基准仅通用 403 |
| B08 | 候选或基准下架、归档、商家失效 | 候选剔除；基准 404，不透露推荐片段 |
| B09 | 没有 active Offer，已停用默认套餐，混合库存/不限量 | 正确判断可兑换；库存取真实可用条目，已知售罄不推荐 |
| B10 | Faka 已知无名额 / 正库存但 sellable=false / 容量未知 | 只按补全后的 stock/stockMode 筛选，与原公开投影一致；sellable=false 不额外排除；未知不走独立特例；请求链不等待外部 HTTP |
| B11 | 给 fixedContent/结构化账号/外部 SKU/库存秘密设置哨兵 | 整个响应中没有哨兵或禁止字段；商家状态与原始 attributes 不输出 |
| B12 | 装饰身份、合作权益、保障授权过期/撤销 | 沿用现有当前公共 projection，无伪造或过期徽标 |
| B13 | 无 query 的请求及额外 query | 始终最多 6 件，query 不能改变服务端数量/商家/audience；ID 参数仍按既有 schema 验证；成功与错误均 no-store |
| B15 | 超过 64 个同组候选，强匹配 ID 较旧 | LIMIT 前资格与相关排序成立；强匹配不被新不相关记录挤出，查询不无界 hydrate |
| B16 | 全部候选为空 / DB 查询失败 / 相同 ID 重复 | 分别 200 空数组 / 正常错误 / 每商品只一次；稳定数据重复调用顺序相同 |

原 B14（请求期间内容变化、重新打分及只读 409）随发送前第二轮复查删除，其编号不复用。测试不增加竞争阻塞、随机 sleep 或推荐持锁要求；交易时的库存与内容重验继续由原结算测试负责。

### 8.2 前端与浏览器

| AC | 必须观察到 | 证据层 |
| --- | --- | --- |
| F01 | 主详情完成即能浏览/选套餐，推荐仍 pending 不阻断 | PDP 组件测试，推荐延迟响应 |
| F02 | 卡片保留 API 顺序、最多6件、真实积分/名称/经营者、正确同店或平台标识 | 推荐组件测试 |
| F03 | items=[] 与请求 500 均没有推荐标题/空态/toast；兑换仍可用 | PDP + 推荐组件测试 |
| F04 | 路由 A→B→C、请求乱序、旧失败/旧 finally | 只显示 C，旧请求不导航或覆盖 loading；PDP deferred promises 测试 |
| F05 | 退出/切换账号立即移除旧会员推荐，后续按新会话加载 | 会话与 hook/PDP 组件测试 |
| F06 | preview 不请求真实接口，真实失败不显示 mock | PDP/preview 回归测试 |
| F07 | 三种布局推荐位于指定正文位置，不重复请求或重复渲染 | 布局组件测试，显式控制媒体查询 |
| F08 | 链接目标只有真实 product ID；键盘/焦点/新标签可用，跨商品后回顶部 | 组件断言 + 实际浏览器手工操作 |
| F09 | 320/390/768/1024/1440、长名、缺图、200%缩放、现有明暗主题 | 人工浏览器检查，必要截图 |
| F10 | 商城卡片旧 onOpen/disclosure 与 Store 滚动恢复、主详情登录/套餐/评价行为 | 受影响既有测试回归 |
| F11 | 本地切套餐、仅 offerId query 改变和同 ID 详情重新加载均不重发推荐；路由 ID 或会话身份改变才重新获取 | PDP/hook 组件测试，断言推荐请求次数 |

测试 setup 默认 matchMedia 为 false，会走平板分支；不能只跑默认分支就声称手机和桌面通过。补测应覆盖显式三断点或直接渲染三布局。

按测试政策，本轮默认后端集成 + 前端单测，不逐验收新增 E2E。这是新的相关推荐接口与详情→详情导航旅程，若现有浏览器回归不能覆盖，可增加至多 1 条 happy-path 冒烟；纯文案/排序/空态留在组件或服务测试。修改认证/session 中间件、结算、全局路由等关键路径时才按政策加 `run-e2e`；仅复用既有 audience 和 session context 不等于修改这些横切面。

### 8.3 验证入口

使用仓库 Node 22 / npm 10，先 `npm run check:runtime`。新 worktree 按锁文件 `npm ci`、`npm --prefix server ci`；不要为此升级依赖或改锁文件。

后端测试 setup 每次测试会 TRUNCATE 多张业务表。先创建本 agent 独占、可丢弃且已迁移的测试库；数据库环境值从安全配置注入，不贴到方案、日志或 PR。不要对开发/生产库执行这些测试，也不要与别的 agent 共用清表测试库。

推荐定向命令（新测试路径以最终实现为准）：

```bash
npm run check:runtime
npm --prefix server run db:generate
# TEST_DATABASE_URL 已设置为专用可丢弃测试库；迁移只作用于此库。
DATABASE_URL="$TEST_DATABASE_URL" npm --prefix server run db:migrate:deploy
npm --prefix server test -- src/modules/products/recommendations.test.ts src/modules/products/visibility.test.ts src/modules/products/public-fields.test.ts src/modules/products/catalog-merch-integration.test.ts
npm test -- src/pages/ProductDetailPage.test.tsx src/pages/ProductDetailPage.readonly-audit.test.tsx src/components/catalog/ProductDetailPhase3.test.tsx src/components/catalog/RelatedProductsSection.test.tsx src/components/store/StoreProductCard.test.tsx
npm --prefix server run build
npm run build
git diff --check
```

若调整 StoreProductCard 或共享投影影响更多调用方，再按影响加入 StorePage.test.tsx、StorePage.cmi.test.tsx 或相应受影响测试。不能因为本文列出的测试通过就忽略新实现实际涉及的文件。

可以用 `npm run verify:quick` 辅助，但先读 `scripts/verify-quick.sh`：它默认使用 monexus_test 并启动/复用数据库容器；独占测试库需要正确设置 TEST_DATABASE_URL，避免与其他 worktree 并发清表。定向通过且没有新风险后不机械重复全量，后续依赖 PR `CI OK` 与合入 develop 的集成门。

没有测试库或浏览器时，继续完成能执行的检查，交接中明确写“未执行”及原因；不能把 mock 单测冒充真实 PG 集成或把构建成功冒充浏览器验收。

## 9. Git、PR 与交接规范

### 9.1 本次方案文档

文档从上述 develop 基线创建 `chore/product-detail-recommendation-plan`，位于独立 worktree，提交信息为 `docs: plan product detail related recommendations`。纯文档无需发行版本、tag、业务测试或部署；检查链接、规则一致性和 `git diff --check` 即可。

原工作区 `/root/projects/MoNexus-new` 当时在 develop，存在 CLAUDE.md 与多个检查脚本等未跟踪文件。本次未接管这些文件，不删除、不 reset、不 add；此清单只是工作区状态记录，不是项目源文件。文档交付为本地分支/提交，由 Owner 交给实施 agent；本轮不自行推送、创建 PR、合并或部署。

### 9.2 实施分支与 worktree

先读最新 docs/branching-and-ci.md 和 docs/testing-policy.md；它们对流程的更新优先于本文命令示例。实施基线用最新 origin/develop，记录实际 SHA，并检查上述事实是否变化。

```bash
git status --short --branch
git worktree list
git fetch origin develop
git worktree add -b feat/product-detail-recommendations /root/projects/worktrees/monexus-product-detail-recommendations origin/develop
```

不在现有 develop/master 或他人的 worktree 直接修改。分支已存在时先检查归属与状态，不用 `-B` 强制覆盖；路径已占用时换一个清晰的独立路径。主工作区有变更时不擅自 stash、reset、clean 或移动他人文件。

若本文尚未合入 develop，使用文档提交 SHA 将**仅本文**引入功能 worktree。先将 `PDP_PLAN_DOC_COMMIT` 设置为交接提供的文档提交 SHA，再执行：

```bash
git restore --source="${PDP_PLAN_DOC_COMMIT:?请先设置文档提交SHA}" -- docs/specs/product-detail-recommendations.plan.md
```

此命令仅适用于该路径在功能 worktree 没有独立修改的情况；有既存版本时先比较，保留更新内容。未跟踪的新文件需按精确路径暂存。无需把功能基线切换到旧文档分支，也无需把他人代码一起 cherry-pick。

### 9.3 提交与 PR

- 每次只暂存本任务精确文件，用 `git add <路径...>`；禁止 `git add .` / `git add -A` 混入其他工作。
- 提交前查看 `git diff`、`git diff --cached` 与 `git diff --check`；提交后检查分支只含本任务。
- 不提交 .env、数据库导出、日志、node_modules、构建物、截图临时文件、调研脚本、密钥、生产数据。
- 不改写旧 migration，不为纯文档或日常功能分支自行 bump 包版本或打发行 tag。
- 不对 develop/master 直推，不 force push，不在提交标题加 `[skip ci]`。
- 按用户授予的交付范围推送功能分支、准备或创建 PR；PR base 固定 develop，通常一个完整功能 PR。
- PR 说明先写行为：商品详情优先展示同店相关商品、跨店补足。列明规则、候选上限、公开权限/库存复用、三布局、测试结果和未执行项。
- 可以标记 Ready for review，但交回 Owner/主代理审查；不要自行 merge、release 或部署。
- 合并方式遵循仓库 Squash merge，必需检查 `CI OK`。纯文档 PR 由路径过滤减轻检查，不手动跳过 CI。

建议 PR 标题：`feat: add same-seller-first product detail recommendations`。修复冲突时保留最新上游实现，重新跑实际受影响的检查，不因更新基线而重写推荐业务规则。

### 9.4 实施完成的交接格式

实施 agent 必须提供：

1. 功能分支、worktree 路径、实际 base SHA、最终 HEAD SHA、PR 链接（若已创建）。
2. 主要改动与文件，确认真实接口接线、三布局和 preview 行为。
3. 测试命令与通过/失败/未执行状态；测试库和浏览器检查是否实际执行，不贴连接凭据。
4. 代表性类别查询计划摘要、候选数量上限及残余限制。
5. 与本文发生的任何语义差异及原因；无差异明确写无。
6. 工作区 clean 或剩余任务文件清单；说明功能未合并、未部署。

## 10. 外部调研依据与证据边界

核验日期 2026-10-14；以下官方页面未显示发布日期。既有调研使用 GrokSearch，搜索多轮返回空内容，关键官方 URL 直接抓取成功；不把有限检索当成全面行业调查。

- [Shopify：Customize product recommendations with Shopify Search & Discovery](https://help.shopify.com/en/manual/online-store/storefront-search/search-and-discovery-recommendations)：区分相似/可替代商品与搭配商品，支持自动和手动推荐。本文据此划分推荐意图，不照搬其库存例外。
- [Shopify：Adding a related products section](https://help.shopify.com/en/manual/online-store/themes/customizing-themes/common-customizations/add-product-recommendations)：相关商品可由共同购买、相似描述、相关集合等信号形成，外观由主题决定。本文第一版不具备完整行为数据，采用现有分类/模板属性规则。
- [AWS：SIMS recipe](https://docs.aws.amazon.com/personalize/latest/dg/native-recipe-sims.html)：商品相似推荐及属性过滤是可组合能力。
- [AWS：Filtering recommendations and user segments](https://docs.aws.amazon.com/personalize/latest/dg/filter.html)：推荐过滤和 promotion 业务规则可组合；不是同商家优先改善转化的直接证据。

同店优先、6 件、平台经营者桶、无结果隐藏、限定分类/模板和候选池上限均为本项目方案决定。第一版不接入上述供应商、不增加 AI 服务、向量索引或行为训练。后续用实际点击、兑换与商品覆盖情况评估相关性和商家优先程度；埋点/实验另行设计，不混入本轮。

## 11. 可直接交给实施 agent 的任务说明

> 在 MoNexus 仓库实施 `docs/specs/product-detail-recommendations.plan.md` v1.1.0。先读该方案及最新 Git/测试政策，以最新 origin/develop 在独立 worktree 创建 feat/product-detail-recommendations。一个实施 agent 顺序完成真实 GET /api/products/:id/recommendations（固定最多 6 件、无 query 配置）、SQL 单处计算同分类/模板与关键值相关度、同经营者优先/跨经营者补足、service.ts 内共用 hydratePublicListItems(orderedIds, audience)、现有商家展示与保障投影、手机/平板/桌面推荐区、主详情及推荐的会话/路由竞态保护、有效测试和交接。保留他人文件；不修改订单/付款/履约状态机，不增加 migration、依赖、首页推广注入或推荐模型。推荐不走结果缓存、不做第二轮发送前复查、不返回内容冲突 409、不在应用侧重复归一化/打分；补全后的卡片只按 stockMode !== 'unlimited' && stock <= 0 剔除。推荐 effect 按路由 ID 与会话身份触发并区分 preview，不依赖 product 或套餐；详情 load 只补取消/过期保护，不拆分也不改原依赖项。核验 null 平台桶、guest/member 隔离、公开字段无秘密、空/失败隐藏、preview 不发真实请求和可访问链接。提交采用精确文件暂存与本方案 Git 规范；按授权范围交付分支/PR，base=develop，等待 Owner/主代理 review，不自行合并或部署。遇到基线差异先定位并记录；涉及业务语义或迁移范围变化时提出具体修订，其他实现命名/组件拆分自主完成。最终报告真实测试证据、未执行项、查询成本限制及 HEAD SHA。

### 修订记录

| 版本 | 说明 |
| --- | --- |
| 1.0.0 | 初始交接方案 |
| 1.1.0 | 根据 Owner 代码核验删除发送前第二轮复查、只读 409 和应用侧重复归一化；明确 service.ts 共用补全函数及缓存外身份投影；库存统一使用公开卡片 stock/stockMode；保留详情加载依赖，只加取消保护；固定最多 6 件，删除 limit 扩展与 B14 并更新交接任务 |

## 12. 实施记录（由实施 agent 完成后填写）

- 实际基线 / 功能 HEAD：待实施。
- 功能分支 / PR：待实施。
- 后端集成 / 前端组件 / 构建：未执行，本轮仅文档。
- 浏览器与查询计划检查：未执行，本轮仅文档。
- 方案偏差与残余限制：待实施确认；已知规则与候选池限制见 §3、§5。
- 合并 / 部署：未执行。
