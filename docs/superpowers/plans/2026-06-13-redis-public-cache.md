# Redis Public Cache Plan

## 1. 背景

当前 `master` 的公开商品读路径主要直接访问 PostgreSQL：

- `GET /api/products` -> `server/src/modules/products/service.ts:listProducts`
- `GET /api/products/:id` -> `server/src/modules/products/service.ts:getProductDetail`
- `GET /api/products/:id/reviews` -> `server/src/modules/reviews/service.ts:listProductReviews`

这些接口在普通流量下可用，但在首页、热门商品、商品详情被高频访问时，数据库会承受重复读压力。当前前端 `StorePage` 有 SPA 页面内缓存，但它只对单个浏览器会话有效，不能降低后端或数据库压力。

本方案在新分支 `feat/redis-public-cache` 上实施 Redis 缓存，目标是优先保护公开读接口，同时保持购买、库存、评价等强一致写路径仍以 PostgreSQL 为准。

## 2. 目标

1. 为公开商品读接口增加 Redis 缓存，降低 PostgreSQL 读 QPS。
2. Redis 不可用时自动降级为直查数据库，不影响核心交易。
3. 对商品、库存、购买、评价、上下架等写路径做精确或保守失效。
4. 暴露缓存命中率、错误数、Redis 健康状态，方便压测和线上观察。
5. 保持公开接口响应结构不变，前端无需改 API contract。

## 3. 非目标

1. 不缓存用户私有数据：
   - `/api/orders`
   - `/api/auth/me`
   - `/api/points/*`
   - 个人中心订单详情
2. 不把购买流程改成 Redis 扣库存。库存、余额、订单仍以 PostgreSQL 事务为最终事实源。
3. 不引入分布式锁作为第一阶段方案。当前目标是读缓存，不是重写交易一致性模型。
4. 不用缓存掩盖慢搜索问题。搜索性能后续应通过 PostgreSQL full-text/trigram index 解决。
5. 不在第一阶段把 `express-rate-limit` 切到 Redis 存储。当前限流仍使用内存存储；若后续引入 Redis rate limiter，必须单独设计其故障策略，不能和公开读缓存降级混为一谈。

## 4. 当前关键路径

### 4.1 商品列表

`listProducts` 当前逻辑：

- 条件：`status = active`
- 可选 `category`
- 可选 `q`，使用 `contains + insensitive`
- 排序：`isHot desc, sales desc, id desc`
- 支持 cursor 分页
- 返回 `ratingAvg` number 化后的列表

缓存适合度：

- 首页无搜索第一页非常适合缓存。当前前端 `StorePage` 实际使用 `PAGE_SIZE=60` 和 cursor 分页，不是默认 `pageSize=20`。
- 分类第一页适合缓存。
- 搜索请求可能很多且 key 分散，先设置更短 TTL，避免缓存污染。
- cursor 首屏 `cursor=null&pageSize=60` 是最高频 key；后续页 cursor 由 `{isHot,sales,id}` 生成，排序稳定时多个用户会共享同一 cursor，但 key 基数明显高于首屏。

### 4.2 商品详情

`getProductDetail` 当前逻辑：

- 按主键 `findUnique`
- 校验 `status === active`
- 当前实现使用 `include` 取出 Product 全字段，再去掉 `fixedContent`
- `ratingAvg` 转 number
- 当前错误语义：不存在商品抛 `notFound` 404；已下架商品抛 `badRequest` 400

缓存适合度：

- 热门商品详情非常适合缓存。
- 需要在购买、库存、商品编辑、评价聚合变化后失效。
- 只有“不存在商品”适合空值缓存；“已下架商品”不应空值缓存，因为商品可能重新上架。

缓存接入前必须把详情查询改为 `select` 白名单，避免把非展示字段、大字段或未来新增敏感字段放入缓存。白名单应与公开 API contract 对齐，至少包含：

```ts
const productDetailSelect = {
  id: true,
  name: true,
  description: true,
  richDescription: true,
  type: true,
  icon: true,
  imageUrl: true,
  images: true,
  price: true,
  originalPrice: true,
  stock: true,
  sales: true,
  isHot: true,
  status: true,
  deliveryMode: true,
  stockMode: true,
  ratingAvg: true,
  ratingCount: true,
  merchant: { select: { id: true, name: true } },
} satisfies Prisma.ProductSelect
```

禁止把 `fixedContent`、`fixedContentType`、`merchantId`、内部关系集合、未来新增运营字段默认带入详情缓存。`fixedContentType` 是否公开要由产品 contract 明确决定，不能因为 ORM 全字段返回而被动暴露。

### 4.3 商品评价

`listProductReviews` 当前逻辑：

- 条件：`productId + status = visible`
- `count + findMany`
- 公开字段白名单，不返回 email 原文、userId、orderId

缓存适合度：

- 商品详情页的第一页评价适合缓存。
- 后续分页可以缓存，但优先缓存 page=1。

### 4.4 写路径失效点

必须纳入失效：

- 用户购买：`orders/service.ts:createOrder`
  - 更新 `Product.stock`
  - 更新 `Product.sales`
- 用户评价：`reviews/service.ts:createOrderReview`
  - 新增 `Review`
  - 重算 `Product.ratingAvg/ratingCount`
- 用户修改评价：`reviews/service.ts:updateOrderReview`
  - 更新 `Review`
  - 重算评分
- 管理员移除评价：`reviews/service.ts:removeReviewByAdmin`
  - `Review.status = removed`
  - 重算评分
- 商家创建/修改商品：`merchant/service.ts:createMyProduct/updateMyProduct`
- 商家导入/作废库存：`merchant/service.ts:importMyInventory/voidMyInventory`
- 管理员创建/修改商品：`admin/service.ts:createProduct/updateProduct`
- 管理员导入库存：`admin/service.ts:importInventory`

## 5. 总体设计

### 5.1 Redis 客户端

新增 `server/src/lib/redis.ts`：

- 使用 `ioredis`
- lazy singleton 初始化
- 配置项来自 `config`
- Redis 未启用或连接失败时返回 `null`
- `error` 事件只记录日志，不让进程崩溃
- fail-fast：禁用 offline queue，限制重试次数，设置短连接超时
- 熔断器：连续错误后进入 open 状态，短时间内直接跳过 Redis
- 测试提供 `__setRedisForTests` / `__resetRedisForTests`

配置项：

```dotenv
REDIS_ENABLED=false
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=
REDIS_TLS=false
REDIS_REQUIRED=false
REDIS_CONNECT_TIMEOUT_MS=100
REDIS_COMMAND_TIMEOUT_MS=80
REDIS_CIRCUIT_ERROR_THRESHOLD=5
REDIS_CIRCUIT_OPEN_MS=30000
CACHE_KEY_PREFIX=monexus:local
```

生产建议：

```dotenv
REDIS_ENABLED=true
REDIS_URL=redis://redis:6379
CACHE_KEY_PREFIX=monexus:prod
```

`ioredis` 建议配置：

```ts
new Redis(config.redisUrl, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: config.redisConnectTimeoutMs,
  password: config.redisPassword || undefined,
  tls: config.redisTls ? {} : undefined,
  retryStrategy(times) {
    return Math.min(times * 50, 1000)
  },
})
```

缓存操作必须额外包一层 command timeout。Redis get/set/incr/del 超过 `REDIS_COMMAND_TIMEOUT_MS` 视为失败，记录指标并降级，不得拖慢主请求。

`server/src/main.ts` 当前只调用 `app.listen(...)`。引入 Redis 后必须补充 graceful shutdown：

- 保存 `server = app.listen(...)` 返回值。
- `SIGTERM` / `SIGINT` 时停止接收新连接。
- 等待已有 HTTP 请求短时间 drain。
- 调用 `quitRedis()`，内部优先 `redis.quit()`，超时后 `disconnect()`。
- 调用 `prisma.$disconnect()`。
- 清理 cache 层进程内状态：singleflight map、coalesced bump 时间戳。
- shutdown 超时后强制退出并记录日志。

### 5.2 通用缓存包装

新增 `server/src/lib/cache.ts`：

- `wrapCache(name, key, ttlSec, fallback, options?)`
- Redis disabled -> 直接执行 `fallback`
- Redis get miss -> 进入 singleflight，执行 `fallback`，写入 JSON
- Redis get/set/del 错误 -> 计数、日志、Sentry breadcrumb，然后降级
- Redis circuit open -> 跳过 Redis，直接执行 `fallback`
- JSON parse 失败 -> 删除坏 key，回源 DB
- 支持空值缓存，防止不存在商品、空评价、空搜索穿透 DB
- 支持 TTL jitter，避免批量同秒过期
- 支持最大 value 字节限制，避免大对象进入 Redis
- 所有缓存值必须是公开接口的最终响应对象，不缓存 Prisma 原始 Decimal/Date 未序列化对象

建议接口：

```ts
export type CacheName = 'product-list' | 'product-detail' | 'product-reviews'

export type CacheNegativeError = {
  status: number
  code?: string
  message: string
}

export type CacheEnvelope<T> = {
  schemaVersion: 1
  cachedAt: number
} & (
  | { negative?: false; data: T }
  | { negative: true; data?: T; error?: CacheNegativeError }
)

export async function wrapCache<T>(
  name: CacheName,
  key: string,
  ttlSec: number,
  fallback: () => Promise<T>,
  options?: {
    negativeTtlSec?: number
    maxBytes?: number
    cachePredicate?: (value: T) => boolean
    negativeErrorPredicate?: (err: unknown) => boolean
  }
): Promise<T>

export async function bumpCacheVersion(scope: CacheScope): Promise<void>
export async function getCacheVersion(scope: CacheScope): Promise<number>
```

进程内 singleflight 是 P0：同一 Node.js 进程内，同一 cache key 同时只能有一次 DB 回源。

```ts
const inflight = new Map<string, Promise<unknown>>()
```

分布式锁不是第一阶段 P0，但后续可对极端热点 key 增加 `SET lockKey NX PX` 作为“读缓存回填保护”。该锁不得用于订单、库存、余额正确性。

空值缓存必须区分错误语义：

- `HttpError.status === 404`：可按 `negativeTtlSec` 写空值缓存，例如不存在商品。
- `HttpError.status === 400`：默认不缓存，例如商品已下架，避免重新上架后继续返回旧错误。
- 其他 5xx / Redis / DB 错误：不得空值缓存。

`wrapCache` 需要在 fallback 抛错时调用 `negativeErrorPredicate(err)` 决定是否缓存该异常语义。缓存命中空值时应重新抛出等价的 `HttpError`，保持 API 行为不变。

404 类错误空值缓存必须只存最小错误信息：`status/code/message`。不得缓存 stack、request、user、headers 等上下文对象。空评价、空搜索这类“空结果”可以用 `negative: true + data` 表示；商品不存在这类“错误空值”必须用 `negative: true + error` 表示，命中后重建同语义 `HttpError`。

### 5.2.1 缓存值序列化

缓存值必须经过公开 DTO 序列化函数，不允许直接缓存 Prisma 返回对象。

统一序列化规则：

- `ratingAvg` 必须 `Number(...)`。
- `price`、`originalPrice` 当前 Prisma schema 是 `Int`，保持 number。
- `Date` 字段若公开返回，缓存中存 ISO string，确保 cache hit 与 HTTP JSON 响应一致。
- `Decimal`、`BigInt`、`Date` 不得以 ORM 原始对象形式进入 Redis。
- `fixedContent` 永不进入公开 DTO。
- 日志不打印 DTO 内容，只记录 `name/key/size/ttl/schemaVersion`。

建议为公开商品响应建立显式函数：

```ts
serializePublicProductListItem(product)
serializePublicProductDetail(product)
serializePublicReviewItem(review)
```

`CacheEnvelope.schemaVersion` 表示缓存值结构版本。以下变更必须 bump schemaVersion 或 `CACHE_KEY_PREFIX` 中的业务版本：

- 公开响应字段新增/删除/类型变化。
- Prisma schema 改变影响公开 DTO。
- Prisma 字段类型或精度改变，例如 `Product.ratingAvg` 从 `Decimal(2,1)` 改为 `Decimal(3,2)`。
- Review status 语义变化，例如新增 `pending`、`hidden`。
- Product status / deliveryMode / stockMode 语义变化。

### 5.3 缓存 key 规范

统一加环境前缀和版本号，避免 staging/prod/preview 共用 Redis 时污染 key：

```text
{CACHE_KEY_PREFIX}:v1:ver:product-list
{CACHE_KEY_PREFIX}:v1:ver:product-detail:{productId}
{CACHE_KEY_PREFIX}:v1:ver:product-reviews:{productId}

{CACHE_KEY_PREFIX}:v1:product-list:{listVersion}:{hash(params)}
{CACHE_KEY_PREFIX}:v1:product-detail:{productId}:{detailVersion}
{CACHE_KEY_PREFIX}:v1:product-reviews:{productId}:{reviewsVersion}:p:{page}:s:{pageSize}
```

`product-list` 参数包含：

- `q`
- `category`
- `cursor`
- `page`
- `pageSize`

参数必须先规范化后稳定 stringify，再 hash：

- 未传字段不进入 key
- 空字符串按未传处理
- 数字转 number
- 对象 key 排序
- `status=active` 和固定排序作为隐式维度写入规范化对象
- `page` 与 `cursor` 互斥；有 cursor 时不写 page
- `pageSize` 使用 schema 限制后的最终值
- `q` 需要 `trim`、`toLowerCase`、Unicode normalize；过短或过长的 `q` 不缓存
- `category=全部` 与未传 `category` 等价，必须规范化为未传，避免同一结果缓存两份
- 其他 `category` 使用 `businessRegistry.productTypes[].value` 的规范值，不接受别名 key
- hash 使用 SHA-256，截断 16-24 字节 hex 或 base64url

缓存 key builder 必须放在 service 层，使用 `validate({ query: listProductsQuerySchema })` 之后已经被 Zod `coerce` 的值，不读取原始 `req.query` 字符串。

### 5.4 TTL 策略

第一阶段采用短 TTL + TTL jitter + 写后版本失效。所有 TTL 都使用 ±10%-20% 随机抖动，避免缓存雪崩。

```ts
effectiveTtl = baseTtl + randomInt(-baseTtl * 0.2, baseTtl * 0.2)
```

| 缓存对象 | TTL | 原因 |
|---|---:|---|
| 商品列表，无搜索第一页 | 30s | 首页高频，允许短暂延迟 |
| 商品列表，分类第一页 | 30s | 分类页高频 |
| 商品列表，cursor 后续页 | 20s | 访问频率较低 |
| 商品列表，搜索 page=1 | 5-10s | key 分散，避免缓存污染 |
| 商品详情 | 60s | 热门详情稳定，写后会失效 |
| 商品评价第一页 | 30s | 详情页高频 |
| 商品评价后续页 | 20s | 访问频率较低 |
| 商品详情 404 空值 | 10-30s | 防穿透 |
| 商品评价空列表 | 10-30s | 防穿透 |
| 搜索空结果 | 5-10s | 防穿透且避免污染 |

TTL 策略不能隐含 `pageSize=20`。当前前端首屏是 `cursor=null&pageSize=60`，schema 最大允许 `pageSize=100`。TTL 可以保持短 TTL，但写缓存前必须按序列化后的实际字节数执行 `CACHE_MAX_VALUE_BYTES` 检查；`pageSize=100` 或多图商品导致超限时应跳过写缓存并记录指标。上表中的“第一页”在 cursor 分页下表示 `cursor` 未传；存在 cursor 的后续页统一按“cursor 后续页”处理。

搜索缓存限制：

- `q` 为空：缓存首页/分类所有分页。
- `q` 非空：只缓存 page=1，且 `2 <= q.length <= 50`。
- 高频搜索后续可根据 metrics 决定是否扩大缓存范围。

### 5.5 失效策略

第一阶段禁止在请求主链路使用 `KEYS` 或大范围 `SCAN + DEL` 做 pattern 删除。公开缓存采用版本号失效：

```ts
type ProductPublicInvalidationScope = {
  detail?: boolean
  reviews?: boolean
  list?: boolean
}

invalidateProductPublicCache(productId, scopes)
```

失效动作：

```text
detail=true  -> INCR ver:product-detail:{productId}
reviews=true -> INCR ver:product-reviews:{productId}
list=true    -> INCR ver:product-list
```

旧缓存 key 不删除，依赖短 TTL 自动释放。这样可以避免 pattern delete 的阻塞、扫描成本和 Redis Cluster 多 slot 限制。

失效范围：

| 写事件 | detail | reviews | list | 说明 |
|---|---:|---:|---:|---|
| 购买成功 | yes | no | coalesced | 影响 stock/sales，不影响评价列表 |
| 评价创建 | yes | yes | yes | 影响 ratingAvg/ratingCount 和评价列表 |
| 评价修改 | yes | yes | yes | 同上 |
| 管理员移除评价 | yes | yes | yes | 同上 |
| 商品创建 | no | no | yes | 新商品影响列表 |
| 商品编辑/上下架/价格/分类/图片 | yes | no | yes | 影响详情和列表 |
| 库存导入/作废 | yes | no | coalesced | 影响库存展示 |

`coalesced` 表示合并失效：同类列表版本 bump 在 5-10 秒内最多执行一次，避免高频购买导致列表缓存永久抖动。

P0 coalescing 实现采用进程内节流 + Redis `SET NX PX` 分布式节流：

```text
local lastProductListBumpAt: number
Redis key: {CACHE_KEY_PREFIX}:v1:coalesce:product-list
TTL: CACHE_PRODUCT_LIST_VERSION_COALESCE_MS
```

流程：

1. 如果本进程 `now - lastProductListBumpAt < coalesceMs`，直接跳过。
2. 否则尝试 `SET coalesce:product-list 1 NX PX coalesceMs`。
3. SET 成功才 `INCR ver:product-list`，并更新本进程 `lastProductListBumpAt`。
4. SET 失败表示其他实例刚执行过列表版本 bump，本次跳过。
5. Redis 不可用时退化为本进程节流并记录 fallback 指标。

这不是订单/库存正确性锁，只用于减少列表版本高频 bump。多实例部署下，该方案可把同一时间窗口内的全局列表 bump 合并到一次；Redis 故障时每个实例最多按本地节流执行。

所有写后失效必须发生在数据库事务成功提交之后。不得在 Prisma transaction callback 内直接失效缓存。

当前多条写路径是 `return prisma.$transaction(async tx => { ... })` 结构，没有 post-commit 钩子。接入缓存失效时必须统一重构为“先 await transaction，再失效，再 return”：

```ts
export async function createOrder(userId: number, productId: number) {
  const result = await prisma.$transaction(async tx => {
    // 原有事务逻辑保持在这里
    return { orderId, productId, ... }
  })

  await invalidateProductPublicCache(productId, {
    detail: true,
    list: 'coalesced',
  })

  return result
}
```

该模式适用于所有 `return prisma.$transaction(...)` 写函数：

- `orders/service.ts:createOrder`
- `reviews/service.ts:createOrderReview`
- `reviews/service.ts:updateOrderReview`
- `reviews/service.ts:removeReviewByAdmin`
- `merchant/service.ts:importMyInventory`
- `merchant/service.ts:voidMyInventory`
- `admin/service.ts:importInventory`

非事务单操作写路径同样遵循“await DB 成功后再失效”：

- `admin/service.ts:createProduct`
- `admin/service.ts:updateProduct`
- `merchant/service.ts:createMyProduct`
- `merchant/service.ts:updateMyProduct`

如果失效需要 `productId`，事务 callback 的返回值必须包含 `productId` 或在事务外可确定该 ID。失效失败不得回滚已经提交的业务数据，但必须记录指标和日志。

后续 P1 可引入轻量 outbox：

```text
cache_invalidation_events
- id
- product_id
- scopes
- status
- retry_count
- next_retry_at
- created_at
```

P0 阶段至少要求：

- 写路径 commit 后立即尝试 version bump。
- version bump 失败必须记录 `cache_invalidation_failed_total` 和 error log。
- P0 字段如上下架、价格、库存状态的失败要能被日志和告警发现。

### 5.6 高并发保护

P0 必须包含：

1. 进程内 singleflight，合并同 key DB 回源。
2. TTL jitter，避免同批 key 同时过期。
3. Redis fail-fast，避免 Redis 异常拖慢请求。
4. Redis 熔断，连续失败后短时间直接绕过 Redis。
5. 空值缓存，降低不存在 ID/空评价/空搜索穿透。
6. 参数规范化与 `q/pageSize` 限制，降低冷 key 污染。
7. 列表版本号失效，替代 pattern delete。

P1 可考虑：

- 热门商品预热。
- 本地 L1 cache，TTL 1-3 秒。
- 逻辑过期 + stale-while-revalidate。
- Redis 分布式 singleflight。
- outbox worker 重试失效。

## 6. 接入范围

### 6.1 第一阶段必须接入

1. `GET /api/products`
2. `GET /api/products/:id`
3. `GET /api/products/:id/reviews`

### 6.2 第一阶段必须失效

1. `createOrder`
2. `createOrderReview`
3. `updateOrderReview`
4. `removeReviewByAdmin`
5. `createMyProduct`
6. `updateMyProduct`
7. `importMyInventory`
8. `voidMyInventory`
9. `createProduct`
10. `updateProduct`
11. `importInventory`

### 6.3 暂不接入

1. 商家后台列表：包含权限和运营字段，不是公开高频入口。
2. 管理后台：低 QPS，保持直查更简单。
3. 订单详情：私有数据，不能和公开缓存混用。

## 7. 环境与部署

### 7.1 本地开发

`docker-compose.yml` 增加 Redis 服务：

```yaml
redis:
  image: redis:7-alpine
  container_name: monexus-redis
  restart: unless-stopped
  ports:
    - "6379:6379"
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 3s
    retries: 10
```

`server/.env.example` 增加：

```dotenv
REDIS_ENABLED=false
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=
REDIS_TLS=false
REDIS_REQUIRED=false
REDIS_CONNECT_TIMEOUT_MS=100
REDIS_COMMAND_TIMEOUT_MS=80
REDIS_CIRCUIT_ERROR_THRESHOLD=5
REDIS_CIRCUIT_OPEN_MS=30000
CACHE_KEY_PREFIX=monexus:local

CACHE_PRODUCT_LIST=true
CACHE_PRODUCT_DETAIL=true
CACHE_PRODUCT_REVIEWS=true
CACHE_PRODUCT_LIST_VERSION_COALESCE_MS=10000
CACHE_MAX_VALUE_BYTES=524288
```

本地默认可以保持 `REDIS_ENABLED=false`，需要压测时开启。

### 7.2 生产 compose

`docker-compose.prod.yml` 增加 Redis 服务或允许外部 Redis：

- 自托管 compose：`redis:7-alpine`
- 云 Redis：只配置 `REDIS_URL`

server environment 增加：

```yaml
REDIS_ENABLED: ${REDIS_ENABLED:-false}
REDIS_URL: ${REDIS_URL:-}
REDIS_PASSWORD: ${REDIS_PASSWORD:-}
REDIS_TLS: ${REDIS_TLS:-false}
REDIS_REQUIRED: ${REDIS_REQUIRED:-false}
CACHE_KEY_PREFIX: ${CACHE_KEY_PREFIX:-monexus:prod}
CACHE_PRODUCT_LIST: ${CACHE_PRODUCT_LIST:-true}
CACHE_PRODUCT_DETAIL: ${CACHE_PRODUCT_DETAIL:-true}
CACHE_PRODUCT_REVIEWS: ${CACHE_PRODUCT_REVIEWS:-true}
```

生产安全要求：

- Redis 必须部署在私有网络，生产 compose 不映射 `6379:6379` 到公网。
- 安全组只允许 server 访问 Redis。
- 使用强随机密码；跨网络访问使用 TLS 或托管 Redis 的加密连接。
- 优先使用 Redis ACL 专用用户，限制 key pattern 到 `${CACHE_KEY_PREFIX}:v1:*`。
- 禁止或限制危险命令：`FLUSHALL`、`FLUSHDB`、`CONFIG`、`KEYS` 等。
- 日志必须脱敏 Redis URL 中的密码。
- 配置 `maxmemory` 和 `maxmemory-policy`；纯缓存实例建议 `allkeys-lru` 或 `allkeys-lfu`。

生产 Redis 仅作为可重建缓存。第一阶段不要求 AOF every-write；可选 RDB 快照用于降低重启冷缓存成本。

### 7.3 Readiness

Redis 是性能组件，不是核心可用性组件：

- `/api/health/live` 不检查 Redis
- `/api/health/ready` 可以报告 Redis 状态，但 Redis fail 不应导致整体 unready，除非 `REDIS_REQUIRED=true`
- `REDIS_REQUIRED=false` 是默认生产建议，表示 Redis 故障时服务仍接流量并回源 DB。
- `REDIS_REQUIRED=true` 仅用于明确知道没有 Redis 就无法承受流量的环境，例如大促期间、只允许在 Redis 集群健康时接入公网流量的生产部署。

建议 readiness checks：

```json
{
  "database": "ok",
  "config": "ok",
  "redis": "ok|disabled|degraded"
}
```

## 8. 指标与日志

在 `server/src/lib/metrics.ts` 增加：

```text
monexus_cache_hits_total{name}
monexus_cache_misses_total{name}
monexus_cache_errors_total{name,op}
monexus_cache_invalidations_total{name,scope}
monexus_cache_invalidation_failed_total{scope}
monexus_cache_fallback_db_total{name,reason}
monexus_cache_negative_hits_total{name}
monexus_cache_inflight_requests{name}
monexus_cache_value_bytes{name}
monexus_cache_fill_duration_seconds{name}
monexus_redis_command_duration_seconds{op}
monexus_redis_circuit_state{state}
monexus_redis_status{status}
```

日志要求：

- Redis init failed：error 级别，但不退出
- cache get/set/incr failed：warn 或 error，带 `name/key/op`
- circuit open/half-open/closed 状态变化要记录
- cache parse failed 要记录并删除坏 key
- Redis URL 记录前必须剥离密码。`redis://:password@host:6379` 不得原样进入日志。
- `server/src/lib/logger.ts` redact paths 增加 `*.redisUrl` / `*.REDIS_URL` 或避免把原始 URL 放进日志对象。
- 避免记录缓存 value，防止泄露数据
- cache 层错误只加 Sentry breadcrumb；缓存降级不是致命错误，不应对每次 cache miss/error 调用 `captureException`。

告警建议：

- `cache_invalidation_failed_total` 持续增长
- `cache_errors_total / cache_hits_total` 异常升高
- Redis circuit 长时间 open
- Redis used memory 接近 `maxmemory`
- Redis evicted keys 持续增长
- PostgreSQL QPS 在 Redis 故障时超过保护阈值

## 9. 一致性策略

### 9.1 商品详情

商品详情可以允许最多 60 秒自然过期，但关键写路径仍主动版本失效：

- 商品编辑后详情必须失效
- 购买后详情必须失效，因为 `stock/sales` 变化
- 评价后详情必须失效，因为 `ratingAvg/ratingCount` 变化

缓存中的库存只是展示值，不是可购买承诺；下单必须重新读取数据库并在事务内校验库存。

### 9.2 商品列表

商品列表展示库存、销量、评分，写路径变化多。第一阶段使用全局列表版本号失效，不做 pattern 删除。

- 商品编辑、上下架、价格、分类变化：立即 bump 列表版本。
- 评价变化：因为列表展示评分，bump 列表版本。
- 购买和库存导入/作废：合并 bump 列表版本，5-10 秒内最多一次。
- 未来若列表不再展示精确库存，可降低购买引发的列表失效强度。

### 9.3 评价列表

评价创建/修改/移除后失效对应商品的评价缓存。

购买不影响评价列表，购买后不得失效 `product-reviews` 缓存。

### 9.4 降级

任何 Redis 失败都不能影响：

- 下单
- 评价
- 商品详情读取
- 商品列表读取

失败时直查 PostgreSQL，但必须有 DB 保护：

- 同 key singleflight 合并回源。
- Redis circuit open 时直接跳过 Redis，避免每个请求都等待 timeout。
- 搜索请求限制 `q` 长度和缓存范围。
- Redis 故障压测时观察 PostgreSQL 连接池等待和慢查询。

### 9.5 写后失效时序

所有写路径必须遵循：

```text
DB transaction start
写商品/库存/订单/评价
DB transaction commit success
commit 后执行 cache version bump
version bump 失败 -> 记录指标/日志，P1 outbox 重试
```

不得在 Prisma transaction callback 内执行缓存失效。事务 rollback 不应影响缓存版本。

## 10. 任务拆分

### Task 1: Redis 配置与依赖

文件：

- `server/package.json`
- `server/package-lock.json`
- `server/src/config/index.ts`
- `server/.env.example`
- `.env.example`
- `docker-compose.yml`
- `docker-compose.prod.yml`

内容：

- 增加 `ioredis`
- 增加 Redis / cache env schema
- 增加本地 Redis compose 服务
- 生产 compose 支持 Redis env
- 增加 `CACHE_KEY_PREFIX`、timeout、circuit、cache feature flags
- 文档化生产 Redis 私网、ACL、TLS、`maxmemory-policy`

验收：

```bash
npm --prefix server run build
docker compose up -d redis
```

### Task 2: Redis 客户端与健康状态

文件：

- `server/src/lib/redis.ts`
- `server/src/main.ts`
- `server/src/lib/logger.ts`
- `server/src/modules/health/service.ts`
- `server/src/__tests__/health-endpoints.test.ts`

内容：

- lazy Redis client
- `isRedisConfigured`
- `getRedis`
- `pingRedis`
- `runRedisCommandWithTimeout`
- `quitRedis` / `disconnectRedis`
- fail-fast ioredis 配置
- Redis circuit breaker
- graceful shutdown：`SIGTERM/SIGINT` -> `server.close` + `quitRedis` + `prisma.$disconnect`
- logger Redis URL 脱敏
- readiness 中报告 Redis `ok|disabled|degraded`

验收：

```bash
npm --prefix server run build
npm --prefix server test -- src/__tests__/health-endpoints.test.ts
```

### Task 3: 通用缓存包装与指标

文件：

- `server/src/lib/cache.ts`
- `server/src/lib/metrics.ts`
- `server/src/__tests__/setup.ts`
- `server/src/__tests__/cache.test.ts`
- `server/src/__tests__/metrics.test.ts`

内容：

- `wrapCache`
- 进程内 singleflight
- TTL jitter
- 空值缓存
- JSON envelope 与 parse failure fallback
- 最大 value bytes 限制
- cache version get/bump
- list version coalescing
- cache hit/miss/error/fallback/invalidations metrics
- Redis 出错自动 fallback
- `__resetCacheForTests()`：清 Redis 测试 key、版本号、singleflight map、coalesced bump 状态
- 测试工具命名遵循 `userStatusCache.ts` 现有风格，例如 `_resetForTesting()`
- `setup.ts` 的 `beforeEach` 调用 `__resetCacheForTests()`，避免 Redis 和进程内状态污染测试

验收：

```bash
npm --prefix server run build
npm --prefix server test -- src/__tests__/cache.test.ts src/__tests__/metrics.test.ts
```

### Task 4: 商品公开读缓存

文件：

- `server/src/modules/products/service.ts`
- `server/src/modules/reviews/service.ts`
- `server/src/modules/products/cache.ts` 或 `server/src/lib/publicCacheKeys.ts`
- `server/src/modules/reviews/reviews.test.ts`
- `server/src/__tests__/products-cache.test.ts`

内容：

- `listProducts` 包装缓存
- `getProductDetail` 包装缓存
- `listProductReviews` 包装缓存
- `getProductDetail` 先改为 `select` 白名单，不再 `include` Product 全字段
- 新增公开 DTO 序列化层，统一 number/Date/Decimal 处理
- 统一 key builder
- key builder 放在 service 层，使用 Zod coerce 后的参数
- `category=全部` 规范化为未传 category
- 确保响应结构不变
- 用实际前端首屏 `pageSize=60` 测量常规响应大小
- 用 schema 上限 `pageSize=100` 且每个商品最多 6 张图片测量最大响应 body 大小，确认 `CACHE_MAX_VALUE_BYTES` 合理
- 商品详情 fallback 抛 404 时允许空值缓存；抛 400 已下架时不缓存

验收：

```bash
npm --prefix server run build
npm --prefix server test -- src/modules/reviews/reviews.test.ts
```

新增测试应覆盖：

- 首次 miss 查 DB，二次 hit 不查 DB
- Redis disabled 时直查 DB
- Redis get 抛错时直查 DB
- Redis 慢请求 timeout 后直查 DB
- Redis circuit open 时跳过 Redis
- 100 个并发同 key miss 只执行一次 fallback
- TTL 带 jitter
- 空值缓存命中不查 DB
- 商品详情不泄露 `fixedContent`
- 商品详情缓存不包含 `fixedContent`、`merchantId`、内部关系集合等非公开字段
- 公开评价不泄露 email/userId/orderId
- `category=全部` 与未传 category 命中同一缓存 key
- `pageSize=60` 前端首屏响应可正常写缓存
- `pageSize=100` 大响应不会超过 maxBytes，或超过时不写缓存并记录指标
- 商品不存在 404 被短 TTL 空值缓存
- 商品已下架 400 不写空值缓存

### Task 5: 写路径缓存失效

文件：

- `server/src/modules/orders/service.ts`
- `server/src/modules/reviews/service.ts`
- `server/src/modules/merchant/service.ts`
- `server/src/modules/admin/service.ts`
- `server/src/__tests__/public-cache-invalidation.test.ts`

内容：

- 将 `return prisma.$transaction(...)` 写法重构为 `const result = await prisma.$transaction(...); await invalidate...; return result`
- 覆盖 `createOrder`、`createOrderReview`、`updateOrderReview`、`removeReviewByAdmin`、`importMyInventory`、`voidMyInventory`、`importInventory`
- 非事务写路径在 `await prisma.product.create/update` 成功后失效，失败不失效
- `admin.createProduct` / `admin.updateProduct` 失效时从 DB 返回值读取 `product.id`
- 建议同步收窄 `admin.createProduct` 入参类型，避免直接暴露完整 `Prisma.ProductCreateInput` 的嵌套写能力
- 购买后 bump 商品详情版本，合并 bump 商品列表版本，不 bump 评价版本
- 评价创建/修改/移除后 bump 商品详情、评价、商品列表版本
- 商品创建后 bump 商品列表版本
- 商品修改/上下架/价格/分类/图片后 bump 商品详情和商品列表版本
- 库存导入/作废后 bump 商品详情版本，合并 bump 商品列表版本
- 所有 version bump 必须发生在 DB commit 后
- 实现 product-list coalesced bump：进程内 lastBumpAt + Redis `SET coalesce:product-list NX PX`
- version bump 失败记录 `cache_invalidation_failed_total`

验收：

```bash
npm --prefix server run build
npm --prefix server test -- src/__tests__/public-cache-invalidation.test.ts
```

### Task 6: 本地验证与压测脚本

文件：

- `scripts/verify-local.sh`
- `scripts/load-products-smoke.sh` 或 `scripts/cache-smoke.sh`
- `docs/operations/runbook.md`
- `server/src/__tests__/setup.ts`

内容：

- 本地验证脚本可选启动 Redis
- 测试 setup 在每个用例前调用 cache reset，清理 Redis 测试 key、版本号和进程内状态
- 增加缓存 smoke：
  - 请求商品列表两次
  - 检查 metrics 中 hit/miss 增长
  - 执行一次购买或评价
  - 确认下一次详情请求使用新版本或内容更新
  - 确认购买不失效评价缓存
  - 模拟 Redis get/set/incr 失败时接口仍 200

验收：

```bash
REDIS_ENABLED=true docker compose up -d postgres redis
REDIS_ENABLED=true npm --prefix server run dev
bash scripts/cache-smoke.sh
```

## 11. 测试策略

### 11.1 单元/集成测试

必须覆盖：

- cache miss
- cache hit
- Redis disabled
- Redis get/set/incr error fallback
- Redis command timeout fallback
- Redis circuit open/half-open/closed
- 进程内 singleflight：100 个同 key 并发 miss 只执行一次 fallback
- 100 个并发同 key miss 时 `listProductReviews` 的 batch `$transaction` 不造成连接池耗尽
- TTL jitter 不产生固定过期时间
- 空值缓存：404 商品、空评价、空搜索结果
- 商品已下架 400 不写空值缓存
- key builder 稳定性
- `q` trim/lowercase/unicode normalize 与长度限制
- `pageSize` 上限与 `page/cursor` 互斥
- `category=全部` 与未传 category 规范化一致
- 前端实际 `pageSize=60` 的 cursor 首屏 key 稳定
- 商品详情安全字段
- 评价公开字段白名单
- 公开 DTO 序列化：`ratingAvg` 为 number，Date 为 ISO string
- `schemaVersion` 变化后旧缓存不被误用
- `CACHE_MAX_VALUE_BYTES` 超限时跳过写缓存并记录指标
- 写路径 commit 后版本失效
- transaction rollback 不 bump 版本
- 购买后不 bump 评价版本
- 版本 bump 失败记录指标

### 11.2 E2E 回归

重点跑：

```bash
npm run e2e -- e2e/product-reviews.spec.ts
npm run e2e -- e2e/instant-fixed.spec.ts
npm run e2e -- e2e/merchant-inventory.spec.ts
```

### 11.3 压测建议

纯读压测：

```bash
npx autocannon -c 100 -d 30 http://localhost:3000/api/products
npx autocannon -c 100 -d 30 http://localhost:3000/api/products/1
npx autocannon -c 100 -d 30 http://localhost:3000/api/products/1/reviews
```

混合流量压测：

```text
90% 商品详情读 + 10% 下单
80% 商品列表读 + 20% 库存变化
评价创建/修改与详情读并发
Redis 连接超时期间继续压测
Redis 重启冷缓存期间继续压测
Redis 恢复后的命中率恢复曲线
```

目标：

- 开启 Redis 后公开读接口 p95 明显下降
- PostgreSQL CPU 和 query count 明显下降
- Redis 出错时接口仍 200
- Redis 出错时 HTTP p95 不因 Redis timeout 被拖高
- 同 key miss 回源数量被 singleflight 合并
- 高频购买不会导致评价缓存持续失效
- 列表 version bump 在订单高峰下被合并

## 12. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 缓存未失效导致库存/评分短暂旧值 | 用户看到旧信息 | 短 TTL + commit 后版本失效 + 失败指标 |
| Redis 故障拖慢主请求 | p95/p99 升高 | fail-fast timeout + 熔断器 |
| Redis 故障导致 DB 回源激增 | PostgreSQL 被打满 | singleflight + 搜索限制 + 监控 DB QPS/连接池 |
| 热点 key 过期回源风暴 | DB 瞬时压力 | singleflight + TTL jitter，P1 热点预热/L1 |
| 缓存穿透 | 不存在 ID/空搜索打 DB | 空值缓存 + 参数校验 |
| 搜索 key 过多 | Redis 内存膨胀 | 只缓存 page=1，`2 <= q.length <= 50`，TTL 5-10s |
| pattern delete 大 keyspace 慢 | 删除阻塞 | P0 使用版本号失效，不使用 pattern delete |
| 列表版本高频 bump | 命中率下降 | 订单/库存类事件 coalesce |
| 缓存私有数据误泄露 | 严重安全问题 | 第一阶段只缓存公开接口，类型和测试约束字段白名单 |
| 本地 Docker 未启 Redis | 开发启动失败 | Redis 默认 disabled，不作为必需依赖 |
| Redis 暴露公网或权限过大 | 安全事故 | 私网、ACL、强密码、TLS、禁危险命令 |
| Redis 内存满发生淘汰 | 命中率下降 | `maxmemory` + `allkeys-lru/lfu` + eviction 告警 |
| Prisma schema 或公开 DTO 变更 | 旧缓存结构不兼容 | bump `schemaVersion` 或 `CACHE_KEY_PREFIX` 业务版本 |
| 详情 `richDescription` 或多图列表过大 | Redis value 过大或写入失败 | `select` 白名单 + maxBytes + pageSize=100 响应大小验证 |
| Decimal/Date 序列化不一致 | cache hit/miss 响应类型不同 | 统一公开 DTO serializer，API 层测试比较响应 shape |
| 不存在商品与已下架商品错误语义混淆 | 重新上架后仍命中空值缓存 | 只缓存 404，不缓存 400 已下架 |
| Redis 连接未清理 | 容器重启或测试退出残留连接 | graceful shutdown + `quitRedis` + test reset |
| 测试间 Redis 状态污染 | 用例依赖顺序或误命中旧缓存 | `__resetCacheForTests()` 接入 `setup.ts` |
| Redis URL 密码进入日志 | 凭证泄露 | logger redact + URL 脱敏 |

## 13. 发布策略

### 13.1 默认关闭

合并后默认：

```dotenv
REDIS_ENABLED=false
CACHE_PRODUCT_LIST=true
CACHE_PRODUCT_DETAIL=true
CACHE_PRODUCT_REVIEWS=true
```

### 13.2 灰度开启

1. staging 开启 Redis，先验证功能和 metrics。
2. production 只开启商品详情缓存，观察 5% 流量。
3. 开启商品列表首页/分类第一页缓存。
4. 开启评价第一页缓存。
5. 搜索缓存谨慎开启；如果 key 基数过高则保持关闭。
6. P1 可考虑对公开读响应增加 HTTP cache header，例如 `Cache-Control: public, max-age=5, stale-while-revalidate=30`，并评估基于响应版本或 `updatedAt` 的 `ETag`；私有接口必须保持 `private/no-store`。
7. 每阶段观察 `/api/metrics`：
   - cache hit rate
   - cache errors
   - cache fallback DB
   - cache invalidation failed
   - Redis circuit state
   - http p95
   - PostgreSQL QPS/CPU/慢查询/连接池等待
8. 跑商品、购买、评价 E2E 和混合压测。

### 13.3 回滚

整体回滚不需要代码回滚：

```dotenv
REDIS_ENABLED=false
```

然后重启 server。缓存逻辑会全部绕过 Redis。

也必须支持按对象回滚：

```dotenv
CACHE_PRODUCT_LIST=false
CACHE_PRODUCT_DETAIL=false
CACHE_PRODUCT_REVIEWS=false
```

这样可以只关闭问题缓存对象，而不是整体关闭 Redis。

## 14. 成功标准

功能标准：

- 公开商品接口响应结构不变。
- 商品购买后库存/销量最终正确。
- 评价后评分摘要和评价列表最终正确。
- Redis 不可用时所有公开读接口仍可用。
- 购买后不会失效评价列表缓存。
- 商品下架、价格变更、库存变化后公开读最终刷新。
- 缓存中的库存只作为展示，下单仍以 DB 事务为准。

性能标准：

- `/api/products` 在缓存命中时不访问 PostgreSQL。
- `/api/products/:id` 在缓存命中时不访问 PostgreSQL。
- `/api/products/:id/reviews` 在缓存命中时不访问 PostgreSQL。
- 压测下公开读接口 p95 相比直查 DB 明显下降。
- 热点 key miss 时 DB 回源被 singleflight 合并。
- Redis 慢或不可用时，请求不会等待长时间 Redis retry/queue。
- 高频购买下列表缓存仍有可观察命中率。

工程标准：

- `npm --prefix server run build` 通过。
- 相关 backend tests 通过。
- E2E product reviews / instant fixed / merchant inventory 通过。
- `/api/metrics` 可观察 hit/miss/error/fallback/invalidation/circuit。
- 生产文档包含 Redis 私网、ACL、TLS、`maxmemory-policy` 和回滚开关。
