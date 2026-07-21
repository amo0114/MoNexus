## 评审结论

这套 Redis 引入方案**总体方向正确，适合第一阶段上线**：它把 Redis 定位为“公开读接口缓存”和“可降级性能组件”，没有把下单、库存、余额、订单等强一致核心链路迁移到 Redis；缓存范围也明确限定在商品列表、商品详情、商品评价这类公开读场景，并保留 PostgreSQL 作为最终事实源。这是生产系统里比较稳妥的 Cache-Aside 演进路线。方案中的短 TTL、写后失效、字段白名单、Redis 故障降级、metrics 暴露、默认关闭灰度开启等设计也都比较合理。

但如果按高并发电商生产级标准看，当前方案还不能直接视为“完整生产方案”。主要短板集中在六类问题：**热点 Key 回源风暴、缓存穿透与空值缓存不足、全量列表失效过于粗暴、pattern delete 风险、Redis 生产部署与安全配置不足、缓存失效可靠性不足**。这些问题不一定阻止第一阶段上线，但建议至少补齐 P0 项后再开生产流量。

------

## 1. 整体架构合理性评审

### 优点

方案选择 Cache-Aside 模式是合适的。公开商品读接口天然适合“先查缓存，未命中再查数据库并回填”，而下单、库存、余额、订单仍走 PostgreSQL 事务，避免了第一阶段引入 Redis 扣库存、Redis 事务、分布式锁、补偿任务等复杂一致性问题。

Redis 被设计成非核心依赖也正确：`REDIS_ENABLED=false` 默认关闭，Redis 初始化失败或 get/set/del 失败时降级直查 PostgreSQL，`/ready` 中 Redis 只报告 degraded 而不默认影响整体 readiness，这符合“缓存不可用不影响核心交易”的原则。

缓存对象选择也合理：商品列表、商品详情、评价第一页是典型读多写少、公开可复用、高频访问场景。没有缓存 `/api/orders`、`/api/auth/me`、`/api/points/*` 这类用户私有数据，是非常重要的边界。

### 主要问题

当前方案仍然偏“功能接入方案”，还缺少“高并发保护方案”。在高并发下，Redis 缓存不是只要加上 TTL 和失效就能稳住数据库，反而容易在以下场景放大风险：

第一，热门商品详情或首页列表过期时，多个应用实例可能同时 miss，然后同时回源 PostgreSQL，形成热点回源风暴。

第二，每次购买都全量失效所有商品列表，会导致在促销或秒杀类场景中列表缓存长期处于刚删除、刚回填、又删除的抖动状态，最终命中率很低，甚至比不加缓存更复杂。

第三，`invalidateByPattern(pattern)` 如果实现不当，容易在 Redis Key 数量增长后成为性能隐患。生产环境不建议用阻塞式全量遍历或粗暴 pattern 删除。Redis 的 SCAN 支持渐进式遍历；在 Cluster 下，只有能定位到单 slot 的 hash-tag pattern 才能优化到单 slot 扫描，否则仍可能涉及更大范围扫描。([Redis](https://redis.io/docs/latest/commands/scan/))

------

## 2. 缓存设计与策略评审

### 2.1 Key 设计

当前 Key 规范整体是好的：

```text
monexus:v1:product-list:{hash(params)}
monexus:v1:product-detail:{productId}
monexus:v1:product-reviews:{productId}:p:{page}:s:{pageSize}
```

版本号、业务前缀、参数规范化、稳定 stringify、hash 化查询参数，都是正确方向。

需要补充以下约束：

**第一，建议加环境或租户维度。**

例如：

```text
monexus:{env}:v1:product-detail:{productId}
monexus:{env}:v1:product-list:{hash(params)}
```

避免 staging、prod、preview 环境共用 Redis 时发生 Key 污染。如果未来支持多租户、不同站点、不同币种、不同语言，也要把 `tenantId`、`locale`、`currency`、`channel` 等影响响应内容的维度纳入 Key。

**第二，商品列表参数需要更严格规范化。**

当前列出了 `q/category/cursor/page/pageSize`，但还应明确：

```text
status=active 是否隐式固定
sort 是否固定
page 与 cursor 是否互斥
pageSize 最大值
q 的 trim/lowercase/unicode normalize
category 的大小写与 slug 规范
```

否则同义请求会产生不同 Key，降低命中率；恶意长 `q` 或极大 `pageSize` 也可能制造大量冷 Key，形成缓存污染。

**第三，hash 建议使用 SHA-256 截断，而不是非加密弱 hash。**

缓存 Key hash 的目的主要是缩短 Key 和避免特殊字符，不一定追求密码学安全，但生产上建议使用稳定、低碰撞概率的 SHA-256，并截断到 16～24 字节的 base64url/hex。

**第四，未来 Redis Cluster 下要提前考虑 hash tag。**

Redis Cluster 的多 Key 操作只在同一 hash slot 内有完整支持，hash tag 可把相关 Key 强制落到同一 slot；但这也可能造成热点 slot，因此不能滥用。Redis 官方 Cluster 规范明确说明多 Key 操作只有在相关 Key 位于同一 slot 时才支持，Cluster 通过 16384 个 hash slot 做分片。([Redis](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/))

如果只是单 Key get/set/delete，不需要 hash tag。如果要使用 Lua、多 Key 原子删除、registry set 与数据 Key 联动，就要重新设计 Key 分布。

------

### 2.2 缓存粒度

缓存“公开接口最终响应对象”是合理的。它避免了把 Prisma Decimal、Date、内部字段、权限字段直接放入 Redis，也降低了 DTO 转换不一致的风险。

但建议进一步拆分“稳定字段”和“高频变化字段”：

商品详情里如果包含 `stock`、`sales`、`ratingAvg`、`ratingCount`，这些字段变化频率明显高于标题、图片、描述、分类、价格等字段。尤其库存和销量在购买高峰期会频繁变化，每次购买都删除商品详情和所有列表，会造成缓存剧烈抖动。

更优设计是：

```text
商品基础信息缓存：TTL 5～10 min，商品编辑后失效
商品库存/销量摘要：TTL 3～10s，或直接 DB/专用读模型
评分摘要：TTL 30～60s，评价后失效或异步刷新
商品列表页：尽量不展示精确库存，或只展示“有货/售罄/库存紧张”
```

电商生产系统里通常不建议在列表缓存里承载强实时库存。用户看到“有货”，下单时仍必须以数据库事务校验库存为准。你们方案中“不把购买流程改成 Redis 扣库存”是正确的，但读侧也要避免让频繁库存变化击穿缓存收益。

------

### 2.3 序列化方式

JSON 序列化用于公开 API 响应是可以的，但建议加四个保护：

```ts
{
  schemaVersion: 1,
  cachedAt: 1710000000000,
  data: response
}
```

并补充：

1. `JSON.parse` 失败时删除坏 Key 并 fallback；
2. 单个缓存值设置最大字节数，例如 100KB 或 512KB，避免大对象进入 Redis；
3. 对 Date、Decimal、BigInt 统一转换，禁止直接缓存 ORM 原始对象；
4. 禁止日志打印 value，只记录 key、name、op、size、ttl、traceId。

当前方案已经强调“不缓存 Prisma 原始 Decimal/Date 未序列化对象”和“不记录缓存 value”，这点值得保留。

------

## 3. 读写缓存模式评审

### 3.1 Cache-Aside 是当前最合适模式

当前方案的 `wrapCache(name, key, ttlSec, fallback)` 本质是 Cache-Aside：

```text
读：先 Redis，miss 后 DB，回填 Redis
写：先 DB，提交后删除相关缓存
Redis 异常：降级 DB
```

这适合第一阶段的公开读缓存。

不建议第一阶段使用 Write-Through 或 Write-Behind。Write-Through 会把写路径和 Redis 耦合得更重；Write-Behind 更不适合订单、库存、余额这类强一致场景，因为异步落库失败、乱序、重复消费会引入更复杂的数据正确性问题。

Read-Through 需要统一缓存代理或框架层支持，你们现在是模块级服务代码，使用 Cache-Aside 更直接。

### 3.2 必须补充热点回源保护

当前 `wrapCache` 有 miss 后 fallback，但没有看到“单飞”或“互斥回源”机制。高并发下这是最大隐患之一。

建议至少实现**进程内 singleflight**：

```ts
const inflight = new Map<string, Promise<unknown>>();

export async function wrapCache<T>(name, key, ttlSec, fallback): Promise<T> {
  const cached = await redisGet(...)
  if (cached.hit) return cached.value

  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>

  const p = (async () => {
    const value = await fallback()
    await redisSet(...)
    return value
  })().finally(() => inflight.delete(key))

  inflight.set(key, p)
  return p
}
```

这能保证单个 Node.js 进程内同一 Key 同时只有一次 DB 回源。多实例场景下，如果热点特别高，可以再加 Redis `SET lockKey NX PX` 的轻量互斥回源，或者使用逻辑过期 + stale-while-revalidate。但分布式锁只应作为“读缓存回填保护”，不要用于订单库存正确性。Redis 官方也有分布式锁模式说明，并提醒不同实现保证程度不同。([Redis](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/))

------

## 4. 缓存穿透、击穿、雪崩防护评审

### 4.1 缓存穿透

当前方案对不存在商品、无评价、无搜索结果没有明确空值缓存策略。

风险场景：

```text
GET /api/products/999999999
GET /api/products/-1
GET /api/products?q=random_xxx
```

如果这些请求大量出现，Redis 每次 miss，DB 每次查不到，形成缓存穿透。

建议：

1. 商品详情 404/null 缓存短 TTL，例如 10～30 秒；
2. 评价空列表缓存短 TTL，例如 10～30 秒；
3. 搜索空结果可以缓存 5～10 秒，但要限制 `q` 长度、最小搜索词长度和 pageSize；
4. 对明显非法 productId 直接参数校验拦截，不进入 DB；
5. 如果未来存在大规模恶意探测，可引入布隆过滤器或本地产品 ID 集合，但第一阶段未必需要。

### 4.2 缓存击穿

热点商品详情 TTL 为 60 秒，如果热门商品同时过期，可能所有请求同时打到 DB。短 TTL 本身不是击穿保护，反而会增加过期频率。

建议组合：

```text
TTL jitter：基础 TTL ±10%～20%
singleflight：同 Key 同进程只回源一次
热点 Key 逻辑过期：先返回旧值，后台异步刷新
预热：活动商品、首页第一页、热门商品详情提前加载
```

对于商品详情这类高频 Key，建议从第一阶段就加 singleflight 和 TTL jitter。

### 4.3 缓存雪崩

当前 TTL 是固定值：

```text
商品列表 30s
商品详情 60s
评价第一页 30s
搜索 10s
```

如果服务重启、批量预热、批量失效导致一批 Key 同时创建，它们会在相近时间同时过期。建议所有 TTL 都加随机抖动：

```ts
effectiveTtl = baseTtl + randomInt(-baseTtl * 0.2, baseTtl * 0.2)
```

此外，Redis 故障时所有公开读都会降级 PostgreSQL。功能可用性没问题，但数据库可能被瞬间打爆。建议补充：

```text
Redis 熔断：连续失败后 10～30s 内直接跳过 Redis
DB 回源并发限制：限制同一接口/同一 Key 回源并发
降级策略：首页可返回更小 pageSize 或静态兜底
限流策略：按 IP、用户、接口、搜索 q 做限流
```

------

## 5. 数据一致性与可靠性评审

### 5.1 写后失效必须发生在数据库提交之后

所有写路径都应遵循：

```text
开启 DB 事务
更新商品/库存/订单/评价
提交事务成功
提交后删除缓存或发送失效事件
```

不要在事务提交前删除缓存。否则可能出现：

```text
T1 删除缓存
T2 读缓存 miss
T2 读到事务提交前的旧 DB 数据
T2 回填旧缓存
T1 提交新数据
缓存继续保留旧值直到 TTL
```

如果当前代码的 invalidation 是在 Prisma transaction 内部执行，需要调整到事务提交后。

### 5.2 删除缓存失败需要可靠补偿

当前方案中 Redis del 失败只计数、日志、降级。这对读接口没问题，但对“价格、上下架、库存、评分”这类展示字段，删除失败意味着用户可能在 TTL 内看到旧数据。

建议按字段重要性分级：

```text
P0：商品上下架、价格、库存状态
P1：评分、销量
P2：评价列表分页、搜索结果
```

对于 P0/P1 失效，建议引入轻量 outbox：

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

业务事务提交时写入 outbox，提交后立即尝试删除缓存；失败时由 worker 重试。这样即使应用进程在提交后崩溃，也不会永久漏失效。

### 5.3 购买后失效范围过大

方案中提到购买后失效商品详情、评价、所有商品列表。这里有明显可优化点。

购买会影响：

```text
Product.stock
Product.sales
商品详情中的 stock/sales
商品列表中的 stock/sales/sort
```

购买**不影响评价列表**，所以不应该删除：

```text
product-reviews:{productId}:*
```

否则热门商品每次购买都会清空评价缓存，评价第一页缓存命中率会被无意义拉低。

更大的问题是“每次购买全量删除所有 product-list”。如果促销商品持续下单，首页列表缓存会被不断删除，缓存基本无法稳定命中。建议改成：

第一阶段至少不要做同步 pattern 删除，改成**列表版本号失效**：

```text
monexus:v1:product-list-version = 123
monexus:v1:product-list:123:{hash(params)}
```

需要全量失效列表时只做：

```text
INCR monexus:v1:product-list-version
```

旧 Key 靠短 TTL 自然过期。这样避免遍历删除，也降低写路径耗时。

进一步优化是“合并失效”：

```text
同一 productId 的 stock/sales 变化，5～10 秒内最多触发一次列表版本变更
```

因为商品列表本来允许短暂延迟，没必要每笔订单都刷新全部列表缓存。

### 5.4 商品详情中的库存一致性要明确业务语义

你们方案中库存和订单以 PostgreSQL 为准，这是正确的。对于前端展示库存，需要明确：

```text
缓存中的库存只是展示值，不作为可购买承诺
下单时必须重新校验库存
库存不足时返回明确错误
```

核心扣库存建议使用数据库原子条件更新：

```sql
UPDATE products
SET stock = stock - :qty, sales = sales + :qty
WHERE id = :productId
  AND stock >= :qty
  AND status = 'active';
```

然后根据 affected rows 判断是否扣减成功。或者使用 PostgreSQL 事务 + 行锁。不要依赖 Redis 缓存库存判断是否可下单。

### 5.5 评价与评分一致性

评价创建、修改、管理员移除后，失效商品详情和评价列表是合理的，因为详情中有 `ratingAvg/ratingCount`，评价列表中有具体评价内容。

但商品列表是否必须立即失效，要看列表是否展示评分。如果展示评分，可以失效；如果只是排序不依赖评分，可以接受短 TTL 自然过期，减少全局列表缓存抖动。

------

## 6. 失效策略与 pattern delete 风险

当前最需要调整的是：

```ts
invalidateByPattern(pattern)
```

如果它内部使用类似 `KEYS monexus:v1:product-list:*`，生产上不建议使用。即使用 SCAN，也要注意扫描成本、重复返回、Cluster 多节点扫描、删除大 Key 的阻塞成本。

更推荐三种替代方案。

### 方案 A：版本号失效，推荐第一阶段使用

```text
product-list-version: global integer
product-detail-version:{productId}: integer
product-reviews-version:{productId}: integer
```

Key 变成：

```text
monexus:v1:product-list:{listVersion}:{hash(params)}
monexus:v1:product-detail:{productId}:{detailVersion}
monexus:v1:product-reviews:{productId}:{reviewsVersion}:p:{page}:s:{pageSize}
```

失效时：

```text
INCR product-list-version
INCR product-detail-version:{productId}
INCR product-reviews-version:{productId}
```

优点：

```text
不扫描
不批量删除
写路径快
天然幂等
旧缓存短 TTL 后自动释放
```

缺点是短时间内旧 Key 会占用一些内存，但你们 TTL 很短，这个代价可接受。

### 方案 B：Key registry

方案文档里提到后续维护：

```text
monexus:v1:index:product-list-keys
```

这是可行的，但要注意 registry 自身清理：

```text
SADD registry key
EXPIRE registry 1d
失效时 SMEMBERS + UNLINK pipeline
```

如果不清理，registry 会记录大量已经过期的 Key，长期膨胀。

### 方案 C：SCAN + UNLINK，作为兜底工具

如果必须 pattern 删除，建议：

```text
SCAN MATCH pattern COUNT 500
pipeline UNLINK key1 key2 ...
分批执行
限制单次最大删除数量
记录耗时和删除数量
禁止在请求主链路中做大范围扫描
```

`UNLINK` 比 `DEL` 更适合删除大 value，因为释放内存可以异步完成。

------

## 7. 性能收益与潜在瓶颈

### 7.1 预期收益

开启 Redis 后，以下接口会明显收益：

```text
GET /api/products 首页第一页
GET /api/products?category=xxx 分类第一页
GET /api/products/:id 热门商品详情
GET /api/products/:id/reviews?page=1 评价第一页
```

收益主要来自：

```text
减少 PostgreSQL 重复读
减少 count/findMany 高频查询
降低 ORM/序列化成本
降低数据库连接池压力
降低接口 p95/p99
```

### 7.2 主要瓶颈

**瓶颈 1：搜索缓存高基数。**

`q` 参数可能导致 Key 极度分散。建议第一阶段谨慎缓存搜索：

```text
q 为空：首页/分类缓存 30s
q 非空：只缓存 page=1，TTL 5～10s
q 长度 < 2 不缓存或直接拒绝
q 长度 > 50 截断或拒绝
高频 q 才缓存，低频 q 不缓存
```

你们方案里也提到“不用缓存掩盖慢搜索问题”，这是正确的。搜索长期应靠 PostgreSQL full-text/trigram index，流量更大时再考虑 OpenSearch/Elasticsearch。

**瓶颈 2：全量列表失效导致命中率下降。**

如果购买、评价、库存导入都触发全量列表失效，写流量上来后 Redis 命中率可能反而不理想。建议把“列表缓存收益”和“失效频率”纳入压测。

**瓶颈 3：Redis 单线程与热 Key。**

热门商品详情可能成为 Redis 热 Key。Redis 本身性能很高，但极端流量下单 Key 仍可能受限于单实例网络、CPU、客户端连接数。可以增加本地 L1 缓存：

```text
进程内 LRU：TTL 1～3s
Redis L2：TTL 30～60s
DB：最终事实源
```

大厂常见做法是多级缓存：CDN/边缘缓存、本地缓存、分布式缓存、数据库。对于公开商品详情，甚至可以结合 HTTP Cache/CDN 做 5～10 秒级缓存，先把流量挡在应用层外面。

------

## 8. Redis 部署模式评审

### 当前方案

本地和生产 compose 都支持 `redis:7-alpine`，也允许外部 Redis。作为开发和 staging 是可以的，但作为生产默认部署还不够。

Redis 官方文档明确列出持久化可选项，包括 RDB、AOF、无持久化、RDB+AOF；纯缓存场景可以关闭持久化，但这意味着 Redis 重启后冷缓存，需要防止 DB 被冷启动流量打爆。([Redis](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/))

### 推荐选择

按阶段建议：

```text
开发环境：单机 Redis，无持久化或默认 RDB 即可
staging：单机或托管基础版，开启 metrics
小规模生产：托管 Redis 主从 + 自动故障转移
中高规模生产：Redis Cluster，至少 3 master + replica
自建高可用但不分片：主从 + Sentinel
```

因为 Redis 在该方案里是可降级缓存，所以单机故障不会直接导致业务不可用；但 Redis 故障会把流量压回 PostgreSQL。因此即使业务功能可用，也必须评估数据库是否能承受 Redis 故障后的全量读流量。

Redis Cluster 能提供分片扩展和高可用，但它使用异步复制，存在 acknowledged writes 在故障窗口内丢失的可能；对于缓存可接受，但不能把它当成强一致存储。([Redis](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/))

### 持久化建议

由于当前 Redis 只存可从 PostgreSQL 重建的公开缓存，建议：

```text
第一阶段：可以关闭 AOF
可选：RDB 快照用于降低重启冷缓存成本
不建议：开启 every-write AOF，收益不大，增加 I/O
```

如果未来 Redis 存储分布式锁状态、限流状态、库存预扣、异步队列等，就必须重新评估持久化、复制、恢复和数据丢失风险。

------

## 9. 安全性、稳定性与运维评审

### 9.1 安全配置不足，需要补齐

当前配置有：

```dotenv
REDIS_PASSWORD=
REDIS_TLS=false
```

但生产安全建议还不够明确。

Redis 官方建议 Redis 端口只允许可信客户端访问，避免暴露到公网；未保护的 Redis 端口有严重安全影响，例如外部攻击者可能执行危险命令。([Redis](https://redis.io/docs/latest/operate/oss_and_stack/management/security/))

生产建议：

```text
Redis 部署在私有子网
安全组只允许 server 访问 6379
生产 compose 不映射 ports: "6379:6379" 到公网
启用 ACL 用户，而不是只用默认用户
禁用或限制 FLUSHALL、FLUSHDB、CONFIG、EVAL、KEYS 等危险命令
跨网络访问启用 TLS
密码使用强随机值并支持轮换
日志不打印 Redis URL 中的密码
```

Redis 6 以后支持 ACL，可以限制用户可执行命令和可访问 Key pattern，比单一 `requirepass` 更适合生产最小权限控制。([Redis](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/))

建议为应用创建专用用户，例如：

```text
user monexus_cache on >strong-password \
  ~monexus:prod:v1:* \
  +get +set +del +unlink +exists +expire +ttl +incr +mget +ping +scan \
  -@admin -flushall -flushdb -config -keys
```

实际命令集合要根据你们最终实现收敛，越小越好。

------

### 9.2 Redis 客户端必须 fail-fast

`ioredis` 默认行为如果不调整，网络异常时可能产生命令排队、重试放大、请求延迟上升。

建议配置：

```ts
new Redis(url, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 100,
  commandTimeout: 50, // 可用 wrapper 实现
  retryStrategy(times) {
    return Math.min(times * 50, 1000)
  }
})
```

缓存操作不应拖慢主请求。建议对 get/set/del 都加超时保护：

```text
Redis get 超过 30～80ms：直接 fallback
Redis set 超时：忽略并计数
Redis del 超时：写 outbox 或重试队列
```

### 9.3 熔断和降级

需要增加 Redis 熔断器：

```text
连续 N 次 Redis 错误
进入 open 状态 10～30 秒
open 期间直接跳过 Redis，避免每个请求都等待 Redis timeout
半开状态少量探测 ping/get
恢复后关闭熔断
```

同时要有 DB 保护：

```text
同一 Key 回源 singleflight
接口级限流
搜索限流
DB 查询并发限制
Redis 故障时首页 pageSize 降级
必要时返回静态/旧缓存兜底
```

### 9.4 监控指标需要扩充

方案中的指标是好的基础：

```text
cache_hits_total
cache_misses_total
cache_errors_total
cache_invalidations_total
redis_status
```

建议补充：

```text
cache_hit_rate{name}
cache_fill_duration_ms{name}
cache_value_bytes{name}
cache_inflight_requests{name}
cache_fallback_db_total{name,reason}
cache_stale_served_total{name}
cache_negative_hits_total{name}
cache_invalidation_failed_total{scope}
cache_invalidation_lag_seconds
redis_command_duration_ms{op}
redis_circuit_state
redis_evicted_keys
redis_expired_keys
redis_used_memory
redis_memory_fragmentation_ratio
redis_connected_clients
redis_blocked_clients
redis_ops_per_sec
redis_slowlog_len
```

Redis 的 `INFO stats` 中 `keyspace_hits`、`keyspace_misses`、`evicted_keys`、`expired_keys` 等指标可以帮助判断缓存命中率和淘汰策略是否合理。Redis 官方也建议根据访问模式选择 `maxmemory-policy`，热点明显时 `allkeys-lru` 通常是合理默认项。([Redis](https://redis.io/docs/latest/develop/reference/eviction/))

### 9.5 内存与淘汰策略

生产必须配置：

```text
maxmemory
maxmemory-policy
```

纯缓存实例建议：

```text
maxmemory-policy allkeys-lru 或 allkeys-lfu
```

如果 Redis 实例混用了缓存和不可丢数据，建议拆成两个 Redis 实例，而不是依赖 `volatile-lru` 保护部分 Key。Redis 官方也提到 `volatile-*` 策略更适合缓存和持久 Key 混用的场景，但如果可能，应考虑拆分实例。([Redis](https://redis.io/docs/latest/develop/reference/eviction/))

------

## 10. 明确的问题、反模式与优化建议

### 问题 1：`invalidateByPattern` 存在生产风险

**风险：** Key 数量增长后，pattern 删除容易造成 Redis 扫描压力、请求链路变慢、Cluster 下实现复杂。

**建议：** 第一阶段直接改成版本号失效，不要等“后续 key 数量明显变大”再改。

------

### 问题 2：购买后删除评价缓存是过度失效

**风险：** 热门商品购买频繁时，评价缓存持续失效，命中率下降。

**建议：**

```text
购买后：失效商品详情；谨慎处理商品列表；不失效评价列表
评价变更后：失效商品详情、评价列表；视列表是否展示评分决定是否失效列表
商品编辑/上下架/价格变更：失效详情和列表
库存导入/作废：失效详情；列表按业务展示决定
```

------

### 问题 3：全量商品列表失效会在写高峰破坏缓存收益

**风险：** 订单越多，列表缓存越不稳定。

**建议：**

```text
列表缓存使用 global version
购买导致的列表失效做 debounce/coalesce
列表不展示精确库存，或库存字段单独短 TTL
只对商品编辑、上下架、价格、分类变化做强列表失效
```

------

### 问题 4：没有热点 Key 回源保护

**风险：** 热门 Key 过期或失效时打爆 DB。

**建议：**

```text
P0：进程内 singleflight
P0：TTL jitter
P1：逻辑过期 + stale-while-revalidate
P1：热点商品预热
P2：本地 L1 cache
```

------

### 问题 5：空值缓存缺失

**风险：** 非法 productId、空搜索、无评价商品会穿透到 DB。

**建议：**

```text
404 商品详情：缓存 10～30s
空评价第一页：缓存 10～30s
空搜索结果：缓存 5～10s，但限制 q
非法参数：直接 400，不查 DB
```

------

### 问题 6：Redis 生产安全配置不足

**风险：** Redis 暴露、公网访问、默认用户权限过大、危险命令可执行。

**建议：**

```text
私有网络 + 安全组
生产不暴露 6379 host port
ACL 最小权限
TLS/rediss
强密码与轮换
危险命令限制
日志脱敏
```

------

### 问题 7：Redis 客户端缺少超时、熔断、离线队列限制

**风险：** Redis 异常时不只是降级 DB，还可能拖慢所有请求。

**建议：**

```text
enableOfflineQueue=false
maxRetriesPerRequest=1
短 connectTimeout / commandTimeout
熔断器
cache op timeout 后立即 fallback
```

------

## 11. 更优补充设计建议

### 11.1 推荐的第一阶段改造版架构

建议第一阶段调整为：

```text
读路径：
API -> 本地 singleflight -> Redis GET -> miss -> DB -> SET EX with jitter

写路径：
DB transaction commit -> cache invalidation event -> version INCR / UNLINK
失败 -> outbox retry

缓存失效：
商品详情：product-detail-version:{productId} INCR
评价列表：product-reviews-version:{productId} INCR
商品列表：product-list-version INCR，且对订单类事件做合并
```

### 11.2 建议的 Key 版本化设计

```text
monexus:prod:v1:ver:product-list
monexus:prod:v1:ver:product-detail:{productId}
monexus:prod:v1:ver:product-reviews:{productId}

monexus:prod:v1:product-list:{listVer}:{hash(params)}
monexus:prod:v1:product-detail:{productId}:{detailVer}
monexus:prod:v1:product-reviews:{productId}:{reviewsVer}:p:{page}:s:{pageSize}
```

失效函数：

```ts
async function invalidateProductPublicCache(productId, scopes) {
  if (scopes.detail) await redis.incr(`...:ver:product-detail:${productId}`)
  if (scopes.reviews) await redis.incr(`...:ver:product-reviews:${productId}`)
  if (scopes.list) await redis.incr(`...:ver:product-list`)
}
```

这比 pattern delete 更适合第一阶段，代码也不复杂。

### 11.3 HTTP/CDN 缓存可以作为补充

这几个接口是公开接口，如果响应不依赖登录态、Cookie、用户个性化，可以加：

```http
Cache-Control: public, max-age=5, stale-while-revalidate=30
```

首页、分类页、商品详情页可以让 CDN 或网关承担一部分高频读流量。Redis 是应用层缓存，CDN/HTTP cache 是更靠前的流量削峰手段。

### 11.4 搜索长期不要依赖 Redis

方案已经指出搜索性能后续应通过 PostgreSQL full-text/trigram index 解决。这个判断正确。Redis 不适合承载任意搜索查询结果的长期缓存，因为 `q` 的基数不可控，命中率不稳定，容易污染内存。

------

## 12. 实施优先级建议

### P0：生产开启前必须补齐

```text
1. TTL jitter
2. 进程内 singleflight
3. Redis get/set/del timeout + fail-fast 配置
4. Redis 熔断器
5. 空值缓存
6. 参数规范化与 pageSize/q 限制
7. 写后失效确保在 DB commit 之后
8. 移除“购买后失效评价缓存”
9. 商品列表失效改为版本号或 registry，避免 pattern delete
10. 生产 Redis 网络隔离、ACL、强密码、TLS 策略
11. maxmemory 和 maxmemory-policy
12. 关键 metrics 与告警
```

### P1：灰度期间建议完成

```text
1. outbox 异步重试缓存失效
2. 热点商品预热
3. 本地 L1 cache
4. 列表失效 debounce/coalesce
5. Redis 故障下 DB 回源并发限制
6. cache value size 监控
7. Redis 慢日志、eviction、memory fragmentation 告警
```

### P2：流量增长后演进

```text
1. 托管 Redis HA 或 Redis Cluster
2. CDN/边缘缓存
3. 搜索迁移到 full-text/trigram 或 OpenSearch
4. 商品基础信息、库存摘要、评分摘要拆分缓存
5. CDC/binlog 驱动缓存失效
6. 多级缓存治理平台化
```

------

## 13. 灰度与回滚建议

当前“默认关闭、staging 开启、production 设置 `REDIS_ENABLED=true`、回滚改回 false”是合理的。

建议灰度流程更细：

```text
阶段 1：staging 开启 Redis，仅验证功能和 metrics
阶段 2：production 开启 5% 流量，只缓存商品详情
阶段 3：开启商品列表首页/分类第一页
阶段 4：开启评价第一页
阶段 5：谨慎开启搜索缓存，或暂不开启
```

每个阶段观察：

```text
HTTP p50/p95/p99
PostgreSQL QPS/CPU/慢查询/连接池等待
Redis hit rate/miss rate/error rate
Redis used_memory/evicted_keys/latency
cache fallback DB 次数
缓存失效次数与失败次数
订单、评价、商品编辑后的数据新鲜度
```

回滚除了 `REDIS_ENABLED=false`，还应准备：

```text
CACHE_PRODUCT_LIST=false
CACHE_PRODUCT_DETAIL=false
CACHE_PRODUCT_REVIEWS=false
```

这样可以只关闭问题缓存对象，而不是整体关闭 Redis。

------

## 14. 重点测试场景

现有测试覆盖 miss/hit/disabled/error fallback/字段白名单/写路径失效，是必要的。建议新增以下测试。

### 并发测试

```text
100 个并发请求同一个商品详情，缓存 miss 时 fallback 只执行 1 次
100 个并发请求首页列表，缓存 miss 时 DB 查询被 singleflight 合并
```

### 一致性竞态测试

```text
读 miss 回源过程中发生商品更新
DB transaction rollback 时不得失效缓存
DB commit 后 Redis del 失败，outbox 能重试
评价修改后详情 ratingAvg 最终更新
商品下架后详情缓存不得长期返回 active
```

### 失效范围测试

```text
购买后不删除评价列表缓存
评价后删除评价列表和商品详情
商品编辑后删除详情和列表
库存导入后删除详情，列表按策略处理
```

### 容灾测试

```text
Redis 连接超时
Redis get 慢 1s
Redis set 抛错
Redis del 抛错
Redis 重启冷缓存
Redis 内存达到 maxmemory
Redis 发生 eviction
```

### 安全测试

```text
商品详情缓存不包含 fixedContent
评价缓存不包含 email/userId/orderId
日志不包含缓存 value
Redis ACL 用户不能执行 FLUSHALL/CONFIG/KEYS
```

### 压测建议

不仅要测纯读，还要测混合流量：

```text
90% 商品详情读 + 10% 下单
80% 商品列表读 + 20% 商品库存变化
评价创建/修改与详情读并发
Redis 故障期间继续压测
Redis 恢复后的命中率恢复曲线
```

只测：

```bash
autocannon -c 100 -d 30 /api/products
```

不足以暴露失效风暴和一致性问题。

------

## 15. 需要补充的关键信息

为了做最终生产准入评审，还需要补充：

```text
1. 商品详情响应是否包含价格、库存、销量、评分、上下架状态？
2. 商品列表是否展示精确库存？是否按销量/评分排序？
3. 当前 PostgreSQL 单接口 QPS、p95、慢查询、连接池大小是多少？
4. 预期峰值 QPS、热门商品 QPS、首页 QPS 是多少？
5. 商品、订单、评价的写 QPS 峰值是多少？
6. 是否有多实例 server？实例数多少？
7. Redis 计划自建还是云托管？是否支持主从/自动故障转移？
8. 是否有 CDN/API Gateway，可否做 HTTP 层缓存？
9. 商品价格和库存展示允许多长时间延迟？
10. 商品下架/价格变更是否要求秒级生效？
11. 搜索 q 的长度、频率、唯一值分布如何？
12. 是否有促销、秒杀、热门单品突发流量？
13. 是否已有 Prometheus/Grafana/Sentry/日志平台？
14. 是否接受引入 outbox worker？
```

------

## 最终建议

这套方案可以作为 Redis 公开读缓存的第一版基础，但建议不要按原样直接生产全量开启。最小生产可用版本应调整为：

```text
Cache-Aside + 短 TTL + TTL jitter
进程内 singleflight
空值缓存
Redis fail-fast + 熔断
写后 commit 再失效
版本号失效替代 pattern delete
购买不失效评价缓存
商品列表失效做合并或版本 bump
生产 Redis 私网 + ACL + maxmemory-policy
完善 metrics、告警、压测和回滚开关
```

其中最关键的三项是：**热点回源保护、失效策略去 pattern 化、Redis 故障下的 fail-fast 与 DB 保护**。补齐这些后，这个方案就比较接近可灰度上线的生产级缓存方案。