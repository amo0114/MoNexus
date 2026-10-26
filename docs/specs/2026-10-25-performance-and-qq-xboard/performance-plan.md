# 性能优化详细方案

## 1. 目标与基线

实施说明（2026-10-25）：下表保留原工作区的方案证据，不能作为当前 develop/worktree 的基线。新版已含路由拆包及候选 summaries 批读；本批实际变更、最新构建和剩余验证见 [实施记录](./implementation-log.md)。

让商城尽早显示可浏览商品，降低首次访问下载和执行成本，减少重复请求；保留现有权限、可售性、排序游标及推广披露规则。

本会话前序已使用 Node 22.23.1 / npm 10.9.8 完成生产构建。下表压缩数据统一为 gzip level 9，不与 Vite 默认 gzip 展示值混用。

| 指标 | 当前证据 | 说明 |
| --- | --- | --- |
| 初始 JS | 1,906,576 bytes 原始；509,416 bytes gzip，约 497.5 KiB | HTML 直接引用的入口 |
| 初始 CSS | 226,109 bytes 原始；39,890 bytes gzip，约 39.0 KiB | HTML 直接引用的样式 |
| 初始 JS + CSS | 536.43 KiB gzip | 不含图片、字体及 HTML |
| 全部 `dist/assets` | 713.88 KiB gzip，9 个文件 | 包含异步块和图片，不等于首屏传输 |
| 既有检查 | 150 KiB 总资源代理预算未通过 | 原指标与增量资产、首屏指标需分别表述 |
| LCP / INP / CLS / API P95 | 本次未测 | 不引用历史 staging 数据充当当前线上指标 |

目前已有首页虚拟网格、返回列表缓存、应用 Redis 缓存和请求合并、Nginx gzip、一年 immutable 哈希资源缓存。Xboard 公开名额查询使用 fresh/stale 快照和后台刷新，不等待远端响应。这些能力保留。

### 1.1 验收目标

下列数字为拟采用的工程目标，不是现状或效果承诺。P0 用同版、同数据复现基线，若目标不可达应说明剩余成本，不静默调高阈值。

| 项目 | 第一阶段目标 | 测量口径 |
| --- | --- | --- |
| 商城初始 JS | ≤ 300 KiB gzip level 9 | HTML 入口及其同步依赖闭包；含 modulepreload，不含纯异步路由 |
| 商城初始 CSS | ≤ 45 KiB gzip level 9 | 同上，包含首屏可达样式依赖 |
| 人为请求延迟 | 首次/分类切换无 300 ms 定时等待 | 组件调度与浏览器时间线 |
| 候选 HTTP | 非搜索首页最多 1 次聚合请求；无每商品详情请求 | 单次 query epoch，不计用户手动重试 |
| 候选故障隔离 | 永久 pending、500、超时均不阻止普通商品显示 | 受控测试桩 |
| 主列表 API | warm/cold 分测，P95 不比基线退化超过 10% | 相同数据、并发、缓存状态，每场景至少 100 次有效样本 |
| 候选聚合 API | 暖态 P95 ≤ 300 ms | 服务端处理时间，冷态单列 |
| 首批商品可见 | 相比相同环境基线，中位数至少降低 25% 为优化目标 | 同时报告原值和绝对变化；未达到需解释 |

真实用户指标按移动端/桌面端分别统计 P75，目标 LCP ≤ 2.5s、INP ≤ 200ms、CLS ≤ 0.1。实验室数据只能辅助验证，不能冒充线上 P75。[Web Vitals 官方说明](https://web.dev/articles/vitals)（本次核验 2026-10-25；页面更新日期 2024-10-31）。

## 2. 路由和入口代码

### 2.1 页面分组

`src/App.tsx` 中商城保留直接导入，后台、商家工作台、商品创建/编辑、个人中心、充值、榜单等改为模块顶层 `lazy(() => import(...))`。商品详情、店铺和登录页也单独分块，以首页初始闭包最小为目标；具体分组由构建依赖图确认。

- `BrowserRouter`、会话恢复、主题、错误边界、权限守卫保持稳定挂载，不因异步页面等待而卸载。
- 在页面内容处设置 `Suspense`，fallback 使用页面对应的稳定骨架；导航、公告和布局不整页闪烁。
- `RoleGuard` 外包受保护页面，未授权用户不应通过本应用主动加载后台页面模块。代码拆包不代替权限控制。
- `lazy` 定义在组件外，避免重新生成组件类型。按 React 的 Promise 加载与 `Suspense` 机制使用。[React lazy 文档](https://react.dev/reference/react/lazy)（核验 2026-10-25）。
- 所有路由支持刷新直达；共享组件如果反向静态引用后台/编辑器，也要调整边界，否则路由拆包名义上完成但代码仍进入首页。
- 富文本编辑器、裁剪器等按交互或页面加载，保留已经存在的有效异步拆分。`manualChunks` 只在依赖图显示必要时使用，不把代码换个文件名后当作少下载。

### 2.2 懒加载失败与部署兼容

增加路由模块加载错误 UI，允许明确重试或刷新，不无限刷新、不清空登录态。部署保留上一版哈希资源一段兼容期，HTML 不设一年缓存，降低旧页面请求已删除 chunk 的失败。若跨版本无法重试，提示刷新到新版本。

### 2.3 构建预算

新增首屏闭包统计脚本，使用 Vite manifest 的 `imports` 递归收集初始 JS/CSS，并核对生成 HTML 中 modulepreload。统计去重，不把 `dynamicImports` 默认算入初始闭包；若实际启动逻辑立即触发动态导入，浏览器实测仍需计入启动资源。

保留总资源报告和各 chunk 排名。现有 150 KiB 代理预算保持可追溯，另立首屏预算配置；不得为了“通过”直接改写旧指标含义。输出版本、文件、原始/gzip 字节和压缩级别，CI 同时检查首页不再静态依赖后台页面。

## 3. 请求调度与页面状态

### 3.1 首次与分类立即请求

当前 `StorePage.tsx` 在 effect 中统一 `setTimeout(..., 300)`。改为：

1. 首次进入无有效页面缓存：立即请求商品，候选并行启动。
2. 分类改变：立即清理旧游标并请求该分类；不得等待搜索防抖计时。
3. 搜索框区分 `draftQuery` 和已提交的 `query`，连续输入使用 250 ms 防抖；Enter 和清空立即提交。
4. 搜索词未提交时切换分类，取消旧定时器，以当前输入和新分类创建一次 query，避免旧分类响应落地。
5. URL 指定分类但 registry 尚未准备时，仅等待解析该分类所必需的数据；首页“全部”不受 registry 更新影响，不重复候选请求。

前端 query key 复用现有受众隔离规则，再加稳定分类码和规范化搜索词。登录、退出及切换账号必须改变请求上下文，不能只按字符串 `member` 复用浏览器缓存。

### 3.2 取消与去重

`listStoreProducts` 和候选客户端接受 `AbortSignal`；查询变化、卸载和受众变化时取消旧请求。同时保留 epoch/session guard，取消不能代替旧响应防护。

- 相同 query 的候选请求用在途 Promise 合并；短缓存建议 30 秒，按受众上下文、分类和协议版本隔离，登出清理。
- 页面恢复缓存时显示原 feed 及原滚动位置，本次不重新混排；可以后台更新候选缓存，供下次新浏览使用。
- 请求取消不提示“商品加载失败”；真实错误保留手动重试。失败不能触发无限加载循环。
- 推荐状态与商品状态分开，候选失败不清空已经显示的商品。

## 4. 普通商品先展示与推广规则的取舍

### 4.1 为什么不能简单“保留插槽再补”

既有 `SPEC-CMI-UX-001` 要求首 12 槽 `O,O,S,O,O,E,O,O,S,O,O,O`，缺候选以普通商品补位，不显示空运营位，且推广优先去重。

如果普通商品已经占据这些位置，后续补推广只能替换商品、移动商品或新增位置。固定卡高可以降低几何跳动，却不能消除“用户正在浏览的内容被替换”。严格模板、立即展示全部普通商品、无空位、迟到不替换四个要求不能全部满足。

### 4.2 主方案：首批提交时定版

定义 `queryEpoch` 内的状态：

```text
organic: idle | loading | ready | error
candidates: idle | loading | ready | error
firstBatch: uncommitted | committed_mixed | committed_organic
feedItems / seenIds / nextCursor / hasMore
```

处理规则：

1. 两路请求并行，不额外设置等候候选的计时窗口。
2. 普通商品首批成功时，候选若已 ready，立即使用现有模板与去重逻辑提交 mixed feed。
3. 候选还在 loading 或已失败，立即提交 organic feed，本次首批定版。
4. 后续候选结果仅更新短期候选缓存，不插入、不替换、不追加到本次 feed，也不改变已显示商品的标签。
5. 后续页只沿原 organic cursor 追加并去重；第一页未消费的普通商品仍全部保留。
6. 搜索不请求或注入候选；分类候选必须匹配分类；新 query epoch 才重新做首次提交决策。
7. 游标过期按现有规则重启第一页；该次恢复明确作为新提交，不与旧 feed 拼接。已保留候选可以使用，不再等待新候选。

优势是没有候选额外等待，没有迟到内容置换，且保留候选及时到达时的原混排。代价是冷缓存/慢候选时，本次不保证推广进入前 12 槽。必须把 `D-UX-03/05` 及相关 AC 明确修订为上述时序语义；推广披露、最多两推广一精选、搜索不注入及自然 cursor 均保留。

### 4.3 严格曝光规则的备选

若产品要求每次有效候选都必须按原模板进入首屏，则保留等待候选的提交条件，仅优化候选聚合、服务端批量卡片和缓存。候选超过受控截止时间后可按“候选不可用”回退普通流，但截止等待仍是性能成本。

本方案不采用“普通卡先显示后替换”为默认，也不引入空白广告框。实施 PR 应清楚记录采用主方案还是严格模板路径，不悄悄改变曝光承诺。

## 5. 候选聚合 API

### 5.1 对外契约

拟新增 `GET /api/storefront/candidates?categoryCode=<可选>`，搜索模式前端不调用。首页不传分类即使用 home placement；分类必须为有效稳定码。服务端自行推导 placement，客户端不能传任意 merchant 或受众身份。

```ts
type CandidateResponse = {
  version: 1
  generatedAt: string
  sponsored: Array<{
    productId: number
    product: PublicProductCard
    disclosure: { code: 'sponsored'; label: '推广' }
  }>
  editorial: Array<{
    productId: number
    product: PublicProductCard
    publicReason: string | null
    label: '精选'
  }>
}
```

每类最多返回 6 个候选作为现有选择规则兼容上限，页面仍只使用至多两推广、一精选。卡片字段按 `StoreProductCard` 实际依赖收敛，沿用当前价格、销量、可售性、商家、保障与 merchandising 投影；不返回 richDescription、购买表单、秘密库存、内部 campaign 审核及计费字段。

### 5.2 服务端执行

1. 获取一次受众、数据库时间及分类上下文。
2. 并发选取现有推广及精选候选，保留现有时间窗口、轮换与资格判断。
3. 合并去重 product ID，一次批量读取列表卡片；复用 products 的 `hydratePublicListItems` 及批量库存、webhook、容量事实读取。
4. 批量附加现有 merchandising 与 assurance 投影；从 ID map 恢复每类候选原顺序。
5. 不可见、下架、封禁、跨分类的项丢弃；单类失败可返回另一类结果。异常记录内部脱敏原因，不向消费者展示运营错误。
6. 返回窄 DTO；未知 Xboard 名额沿用现有 unknown 表达，不伪造有货、不把 unknown 固化进长缓存。

编排置于新的 `modules/storefront`，products 对外暴露 `getPublicProductCardsByIds` 用例；不能让 merchandising 反向依赖 products 大 service 再形成循环，也不能让控制器逐条调用完整详情服务。公开 API mount 顺序需与现有路由及鉴权保持一致。

### 5.3 缓存与实时规则

第一版优先复用候选选择缓存和批量读取，不急于缓存完整聚合响应。缓存键至少包含协议版本、guest/member、分类、轮换 bucket 以及相关版本戳。

- 活动暂停、商品下架、商家停用、精选撤销后，不允许因为新增缓存扩大既有撤销生效窗口。
- 初步可以缓存候选 ID，再批量验证实时可见性和权益；完整卡片缓存只在失效机制验证后开启。
- 浏览器受众缓存与服务端 guest/member 缓存是不同层次，不共用身份语义。
- 保留旧 sponsored/editorial API，供兼容客户端使用；首页改用新接口后不再额外发详情请求。

## 6. 后端查询成本

### 6.1 注册表 9 键批读

新增 `getSystemConfigValues(keys, tx?)`，一次 `findMany` 读取指定键，逐键回落 `systemConfigDefaults`，返回有类型的映射。`getConfigRegistry()` 使用该 helper；分类 registry 仍独立读取。

不直接调用返回所有配置及管理元数据的 `listSystemConfigs()` 来拼公开响应；不把缺失键变成 undefined；保留事务客户端支持。验证缺失、部分配置、全配置三种情况与原逻辑完全一致。

### 6.2 商品动态投影

现有基础缓存命中后仍有实时查询是有意的。先降低首页的请求放大，再记录排名上下文、Redis、批量可售性、merchandising、assurance 各阶段耗时和查询数。

优先合并同一请求内的数据库时间、run 上下文和批量读取；短 TTL 缓存仅用于有明确撤销/过期容忍度的派生数据。商品/商家可见性、购买权威预检不得为了测速跳过。

搜索 `ILIKE '%词%'` 和全站 snapshot 排序是否要增加 trigram/排序索引，必须在接近生产规模的隔离库看 `EXPLAIN (ANALYZE, BUFFERS)` 后决定。未得到执行计划前不把“可能扫描”当成已发生瓶颈，也不直接对生产跑 ANALYZE 压测。

## 7. 图片、字体与动画

### 7.1 先做无需媒体迁移的调整

- 按实际视口决定首行图片 `loading=eager`；仅最可能成为 LCP 的一张给 `fetchPriority=high`，不把所有首屏或 overscan 图片都设 high。
- 其余图片 lazy、async decode；宽高/比例和卡槽固定，错误 fallback 保持几何稳定。
- 首次可见行不使用 opacity=0 的 reveal 和 stagger。后续新进入视口的卡片可保留动画；滚动返回已看卡片不重复延迟。
- 图 URL 相同时避免不必要重新挂载；列表恢复不先清空卡片再加载。

### 7.2 真实缩略图与 srcSet

目前商品只有单 URL 或 URL 数组，没有商品图变体能力；`sizes` 不会自动生成缩略图。

建议以 `sharp` 作为服务端解码/缩放候选，锁定兼容版本并在当前 Node 22、Linux amd64/arm64 Docker 构建中验证。该库提供像素限制和多输出管线，限制应显式设置，而非只检查上传字节数。[sharp 官方 API](https://sharp.pixelplumbing.com/api-constructor/)（核验 2026-10-25）。

建议实施：

1. 保持现有上传响应 `{key,url}` 及原图可用，后台持久任务生成 320、640、960 px 宽度 WebP 变体，不放大小图。
2. 显式限制解码像素、帧数、执行时间及 worker 并发；处理 EXIF 方向；移除不必要元数据。GIF/动画 WebP 第一版保留原图，不静默改成静态图。
3. 新增原图与变体关系（例如 `StoredObjectImageVariant`）及持久生成任务；幂等键为源对象、变换版本、宽度、格式。每份变体均走现有存储登记和生命周期。
4. 卡片 DTO 增量提供 `coverMedia: {src,width,height,variants:[{url,width}]}`，保留原有 `imageUrl/images`；无变体则回退原图。
5. `SafeImage`/`ProductMediaFrame` 转发真实 `srcSet`，`sizes` 对应实际网格宽度；详情灯箱继续显示原图。
6. 历史图片只处理本平台可验证的 public StoredObject/允许的静态资源，不在任务中任意抓取外部 URL；无法处理的旧图继续回退。
7. 变体生成失败不让原上传失败；失败对象清理、重试及孤儿对象治理有记录。公开图片的删除/失效必须同时处理变体，不能从私有交付对象生成公开缩略图。

AVIF 可后续评估；首版控制编解码 CPU 与运维成本，不同时引入过多格式。

### 7.3 字体与持续绘制

默认主题只加载所需字体及实际使用字重，优先自托管 WOFF2，保留字体许可文件。非默认主题字体按主题加载，字体使用 swap 并检查 fallback 字宽变化；仅 preload 默认主题确实需要的一份关键字体。

`FluidOrb` 在离屏、页面隐藏或 prefers-reduced-motion 时停止 RAF，恢复时再启动；减少动态效果不是冻结时间后继续每帧绘制。该项主要改善低端设备、滚动及耗电，不能直接承诺降低网络首屏时间。

## 8. 测量与验证

### 8.1 固定场景

| 场景 | 必须记录 |
| --- | --- |
| 游客首次进入 | HTML/首资源、首次商品请求、首批商品可见、LCP、长任务、请求数及字节 |
| 登录用户首次进入 | 上述指标加 me/公告/通知并发；区分私有商品可见性 |
| 商品详情返回商城 | 列表/滚动恢复时间、重复请求、图片重载、首次 feed 是否稳定 |
| 连续滚动 | mounted 卡片数、长任务、INP交互采样、失败游标重试是否循环 |
| 分类切换与快速搜索 | 请求取消、旧响应丢弃、无跨分类/跨账号串数据 |
| 候选慢/失败 | 普通商品仍可见、坐标不受迟到候选改变、搜索无候选请求 |

浏览器实验室测量使用生产构建，通过实际代理压缩服务；Vite dev 不能作为结果。桌面正常网络和移动端受限网络分开，建议移动模拟固定为 RTT 150 ms、下行 1.6 Mbps、上行 750 Kbps、CPU 4x slowdown。每场景至少 10 个独立浏览上下文样本，报告中位数及范围；小样本不宣称线上 P95/P75。

网络冷/暖缓存、服务端 cold/warm Redis、字体是否缓存分别标注，不混合统计。返回导航与首次进入不是同一种 navigation，分别报告。

### 8.2 可观测性

新增 `store-organic-request-start/end`、`store-first-products-visible`、`store-candidate-ready`、`store-first-image-loaded` 等受控标记。真实可见标记在卡片非骨架、非透明且进入视口后记录，不能只用 setState 或骨架出现当完成。

当前 Web Vitals 仅在配置 DSN 时注册；breadcrumb/measurement 不足以证明事件已经送达。实施时验证独立采集出口或有效 transaction/span；如新增轻量采集端点，应采样、限流并限制 payload，只收有界指标、route 模板、release、设备与缓存场景，不收邮箱、QQ、商品名或完整 URL。Sentry 性能集成若启用，也计入首屏体积。

### 8.3 分层测试

- 单测/组件：请求调度、搜索提交、取消、query epoch、候选时序、去重、游标过期恢复、图片优先级、缓存恢复。
- 后端集成：候选 guest/member 边界、分类/时间窗/撤销、窄 DTO、批量读取、配置默认值；数据库查询数验证关注是否随候选数线性增加，不脆弱地锁死 ORM 内部固定 SQL 数。
- 浏览器：复用现有商城套件，新增确需浏览器验证的迟到候选坐标稳定和首屏资源测量；不为每个字段单独加 E2E。
- 回归：登录/MFA、后台直达、下单支付、交付、SSE 等沿用关键旅程；不因拆包导致守卫、会话恢复或全局通知重复挂载。
- 媒体阶段：大像素小文件、方向、透明图、动画、旧 URL、任务重试、登记失败、删除和私有对象拒绝。

## 9. 文件与交付清单

| 责任 | 主要文件 |
| --- | --- |
| 路由拆包 | `src/App.tsx`、页面 loading/error 边界、`vite.config.ts` |
| 查询与首批提交 | `src/pages/StorePage.tsx`、`src/api/storeFeed.ts`、`src/components/merchandising/storeFeed.ts`、页面缓存及已有测试 |
| 候选编排 | 新 `server/src/modules/storefront/`、`modules/products` 对外卡片用例、merchandising 选择器、`server/src/app.ts` |
| 配置批读 | `server/src/lib/systemConfig.ts`、`server/src/modules/config/service.ts` |
| 图片与动画 | `StoreProductCard`、`ProductMediaFrame`、`SafeImage`、`Reveal`、`FluidOrb`、图片上传/任务及存储模型 |
| 字体与观测 | `index.html`、字体 CSS、`src/lib/webVitals.ts`、采集出口 |
| 预算与规格 | `scripts/check-frontend-bundle-budget.mjs`、新首屏预算脚本/配置、相关 CI 与 CMI 规格修订 |

本方案保留性能相关迁移与机器人迁移的独立边界，便于分别验证、发布和回退。
