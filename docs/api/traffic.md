# 访问统计

第一版使用 PostgreSQL 事件记录、后台聚合和 Redis 查询缓存，不增加消息队列依赖。

## 口径

- 只统计商城首页 `/` 和成功加载的 `/product/:id` 商品详情。管理、账户、登录及开发预览页面不采集；前端仅 production build 上报。
- 首页渲染计一次访问；商品详情在成功取得可见商品后计一次。刷新或重新进入页面新增 PV，筛选、搜索、规格切换不新增 PV。
- `eventId` 是单次访问的 UUID；网络失败最多重试一次并复用该 ID。服务端提交后才返回 204，相同 ID 不重复入库。
- UV 使用浏览器随机 UUID，不存账号、IP、完整 URL、搜索词或 referrer。跨页面、跨日按所选期间重新去重；清除浏览器存储或换设备会产生新的访客。存储受限时退化为当前页面会话标识。
- 日界固定 Asia/Shanghai；客户端不能指定时间或商家，接收时间和商品经营归属由服务端确定。
- 商家看自己商品的访问；平台看首页和所有商品，另有商品和商家 TOP 10。平台自营单列，商家排行不含商城首页。没有独立店铺路由，因此不提供虚构的店铺访问指标。
- 历史归属按访问时快照保存，商品删除不级联删除统计。只返回汇总，不提供访客明细接口。
- 这些是客户端上报的运营数据，不是反作弊、广告结算或实际人数依据；浏览器拦截、离线和上报失败可能漏计。

## 接口

`POST /api/traffic/events`：游客可调用；存在登录凭据则沿用身份验证。受现有 API 限流约束。

```json
{"eventId":"随机 UUID","visitorId":"浏览器 UUID","page":"/product/42"}
```

成功为 204；不接受额外字段。商品必须当前可见，会员商品需要有效登录身份。不可见/下架商品返回 404，不写事件。

- `GET /api/merchant/dashboard/traffic?range=7d|30d|90d`：正常商家；商家 ID 只来自登录态，忽略请求中的商家 ID。
- `GET /api/admin/reports/traffic?range=7d|30d|90d`：管理员且通过现有 MFA。默认 30d。

返回 `scope/range/timeZone/startDate/endDate/startedAt/updatedAt/pendingEvents/totals/points/topProducts/topMerchants`。`totals` 和每日点包含 `pv/uv`；日期补零。商家响应的 `topMerchants` 为空。`updatedAt=null` 表示尚未首次汇总，不应显示成零访问。更新时间是最近聚合任务成功时间，`pendingEvents` 表示仍待处理的记录，不能把更新时间误作全部事件已处理完毕的水位。

## 运行与恢复

- 先运行 `server` 的 `npm run db:migrate:deploy`，再发布 API 和前端；无需新环境变量。
- API 启动时首跑，随后每 60 秒执行一次，复用 CronLease；每批最多 5,000 条。认领事件使用 `FOR UPDATE SKIP LOCKED`，汇总累加与 processedAt 标记在同一事务中。失败整批回滚，下轮重试；不使用会跳过晚提交事件的自增 ID 水位。
- Redis 报表缓存 TTL 约 30 秒，键包含平台/商家范围和日期窗口。缓存失败回数据库的日/页面/访客汇总，不扫描原始事件。缓存不可用不影响事件入库和聚合。
- 通常 1–2 分钟可见。后台显示更新时间和待汇总条数；超过 5 分钟未更新会显示延迟提示。聚合失败和每批处理量使用现有结构化日志，缓存使用现有 Prometheus 指标。
- 明细及访客汇总保留最近 90 个北京时间自然日。只清理已处理的过期事件，未处理事件保留到成功处理。当前仅提供 7/30/90 天报表；更长历史与漏斗分析不在第一版范围。
- 当前全站 Redis 还是安全限流/防重放和 readiness 的必需依赖。统计模块的降级不代表全站 Redis 故障时所有接口都继续服务，不修改原安全策略。
- PostgreSQL 不可用时采集不返回成功，浏览器有限重试；不宣称浏览器到服务端绝不漏数。

若确实需要从保留的原始事件重建：停止 API/聚合任务，在数据库事务中清空 `TrafficDailyVisitor`、将 `TrafficEvent.processedAt` 置空并清空 `TrafficAggregationState.updatedAt`，再启动 API。下一轮开始分批重放，缓存约 30 秒自然过期；期间看板为准备中/待汇总状态。此操作只用于受控修复，不在日常请求里自动触发。

## 验证

后端 `traffic.test.ts` 覆盖并发重试、重复聚合、事务失败后的恢复、北京时间跨日 UV、跨商家隔离、平台鉴权、采集可见性与 Redis 故障降级；前端 `usePageView.test.tsx` 覆盖页面就绪、StrictMode、重试 ID 和开发环境排除。使用独立可清空的测试数据库，不针对生产库跑测试。
