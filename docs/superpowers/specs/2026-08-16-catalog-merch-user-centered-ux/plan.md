# Plan: Catalog / Merch 用户心智与媒体工作流修订

| 字段 | 值 |
| --- | --- |
| 文档 ID | `PLAN-CMI-UX-001` |
| 版本 | `0.2.0` |
| 日期 | `2026-08-16` |
| 状态 | **Frozen for Implementation** |
| 输入 | [spec.md](./spec.md) |
| 审查基线 | `develop@4554f96dd7780e83b80dc98ad4938bf5e181a275` |

---

## 1. 工程目标与约束

### 1.1 目标

- 用纯函数生成统一商品流，替换消费者页面的两个固定 shelf。
- 让 Category/XBoard 共享上传对象解析，不再比较 URL 字符串前缀。
- 把分类默认封面变为完整上传交互，并保留 legacy 数据兼容。
- 建立稳定码到用户消息的 projection，清理已确认的开发者式文案。
- 以现有单元/集成/E2E 分层验证，不扩张数据库和部署范围。

### 1.2 硬约束

- 不编辑 `server/prisma/schema.prisma` 或任何 migration。
- 不放宽上传鉴权、5MB、MIME/magic bytes、public registry 或 bucket role。
- 不改变 Campaign、Editorial、Order、PointLog、Settlement 的持久状态机。
- 不删除 public Sponsored/Editorial API；先迁移消费者宿主，保留兼容。
- 不使用 `prisma db push`，不访问生产数据库、对象存储控制台或真实 XBoard 数据。
- 不直接推送 `develop`/`master`，不触发 production deployment。

---

## 2. 目标架构

~~~text
Sponsored API -----\
Editorial API ------> hydrate + eligibility ----> composeStoreFeed() ----> one ProductCard stream
Organic cursor ----/                                  |
                                                       +-- disclosure/badge metadata
                                                       +-- session dedupe
                                                       +-- fail-open organic fallback

POST /uploads/image -> { key, url }
                             |
                 PlatformMediaRef { objectKey }
                             |
         resolvePlatformPublicImage() [single trust boundary]
                    /                         \
          Category default cover         XBoard preview/confirm
                    \                         /
               canonical public Product/Category URL
~~~

正确性边界：

- 商品流组合是展示层，不写 Campaign/Editorial/Ranking 数据。
- eligibility 仍由后端现有服务决定；前端只组合已授权的候选。
- objectKey 是写入/确认时的媒体身份；URL 是服务端派生并写入既有 Category/Product 字段的
  展示值，Category 不持久化 objectKey。
- 稳定码是协议/可观测性边界；用户消息是 presentation projection。

---

## 3. 建议模块与文件影响面

### 3.1 统一商品流

建议新增：

~~~text
src/components/merchandising/storeFeed.ts
src/components/merchandising/storeFeed.test.ts
~~~

最小修改：

~~~text
src/pages/StorePage.tsx
src/pages/StorePage.cmi.test.tsx
src/components/merchandising/BadgeMark.tsx          # 仅当统一卡片元数据需要
src/components/merchandising/merchandising.css
~~~

兼容期默认不删除：

~~~text
src/components/merchandising/SponsoredShelf.tsx
src/components/merchandising/EditorialShelf.tsx
server/src/modules/merchandising/promotions/publicSponsored.ts
server/src/modules/merchandising/editorial/publicShelf.ts
~~~

### 3.2 媒体信任边界

建议新增：

~~~text
server/src/modules/catalog/platformMedia.ts
server/src/modules/catalog/platformMedia.test.ts
src/types/platformMedia.ts                         # 或并入 catalog.ts，二选一
src/components/catalog/CategoryCoverField.tsx
src/components/catalog/CategoryCoverField.test.tsx
~~~

修改：

~~~text
server/src/modules/catalog/categorySchema.ts
server/src/modules/catalog/categoryService.ts
server/src/modules/catalog/categoryController.ts
server/src/modules/admin/schema.ts
server/src/modules/admin/service.ts
server/src/lib/storage/**                          # 只允许增加 canonical URL 解析 helper
src/api/catalog.ts
src/api/uploads.ts                                # 类型可扩展，不能破坏现有响应
src/components/catalog/AdminCategoryManager.tsx
src/components/catalog/AdminFakaImportPreview.tsx
src/types/catalog.ts
~~~

### 3.3 用户文案 projection

建议新增：

~~~text
src/components/catalog/catalogIssueMessages.ts
src/components/catalog/catalogIssueMessages.test.ts
src/utils/settlementCopy.ts
src/utils/settlementCopy.test.ts
~~~

修改限定为：

~~~text
src/components/PointsHistorySheet.tsx
src/components/PurchaseModal.tsx
src/pages/merchant/ProductCreateWizard.tsx
src/pages/MerchantDashboardPage.tsx
src/pages/AdminPage.tsx
src/components/merchandising/AdminEditorialManager.tsx
src/components/catalog/AdminFakaImportPreview.tsx
~~~

不要趁机重构整个 `AdminPage.tsx`、`MerchantDashboardPage.tsx` 或设计系统。

---

## 4. API 与兼容方案

### 4.1 Category

首选新请求：

~~~json
{
  "code": "software",
  "label": "软件工具",
  "status": "active",
  "defaultCover": { "kind": "upload", "objectKey": "abc.webp" }
}
~~~

或：

~~~json
{
  "defaultCover": { "kind": "static", "path": "/assets/category/software.webp" }
}
~~~

兼容要求：

- 旧响应 `defaultCoverUrl` 继续返回。
- `/api/uploads/image` 保持 `{ key, url }`，新 UI 令 `objectKey = key`，不从 url 反解。
- 服务端从 `defaultCover.objectKey` 校验 StoredObject 并派生 canonical URL，只写既有
  `defaultCoverUrl`；Category read DTO 不返回 objectKey/provider/bucket。
- 旧 create/update client 的 `defaultCoverUrl` 在兼容期继续接收，但必须进入集中 legacy
  resolver：校验 allowlisted `/assets/`、已登记 `/uploads/<key>` 或可映射到配置 public
  provider + active StoredObject 的绝对 URL；不得保留独立旧规则。
- 新 UI 只提交 `defaultCover`。
- 若同时提交两者，服务端返回稳定 400，不猜优先级。
- `defaultCover: null` 仅允许 inactive 分类或显式移除动作；active 分类拒绝且保留旧值。
- create active、inactive -> active、active replace 必须在写入前原子校验可解析封面；无法解析
  的 legacy 封面不得激活或供 XBoard 使用，provider 切换后须替换。

### 4.2 XBoard

新请求 uploaded cover：

~~~json
{
  "cover": { "mode": "uploaded", "objectKey": "abc.webp" }
}
~~~

兼容要求：

- `category_default` 不变。
- 旧 `imageUrl/images` 允许短期读取，但必须进入集中 resolver。
- Preview/Confirm response 只返回 canonical display URL、业务字段和 issue，不返回 objectKey 或
  provider 配置。
- Preview response 保留稳定 issue code，另提供可选 `action`：

~~~json
{
  "code": "COVER_INVALID",
  "field": "cover",
  "message": "封面已失效",
  "action": "reupload_cover"
}
~~~

- 前端按 `code/action` 投影，不按中文 message substring 分支。

### 4.3 Storage helper

允许给 storage runtime 增加“由 active StoredObject/provider config 生成 canonical public URL”的
只读 helper。禁止客户端提供 provider ID、bucket、endpoint 或 public URL base。

---

## 5. 分阶段实施

### Phase A - 契约与纯逻辑

1. 增加 `PlatformMediaRef` 类型和服务端 resolver 测试。
2. 增加 store feed composer 与槽位/去重/fallback/两页不丢项单元测试。
3. 增加 catalog issue 和 settlement copy projection 测试。

出口：纯逻辑先红后绿，尚未改宿主 UI。

### Phase B - 服务端媒体闭环

1. Category schema/service/controller 接入 resolver。
2. XBoard preview/confirm 接入同一 resolver。
3. 删除业务路径中单独的 `startsWith('/uploads/')` 决策。
4. 覆盖 absolute CDN、static asset、expired/forged/private/delivery/provider-mismatch object。
5. 固化 Category active 状态转换和只持久化 canonical URL 的原子门禁。

出口：现有和新媒体契约均 fail-closed；数据库零迁移。

### Phase C - 分类与 XBoard 用户交互

1. CategoryCoverField 上传、预览、替换、移除。
2. AdminCategoryManager 移除 path 输入并接入媒体引用。
3. XBoard 选择分类后预览默认封面；上传本地图片提交 objectKey。
4. 稳定码映射为用户消息，错误保留输入状态。
5. Dialog 临时关闭/重开保留 upload draft；显式取消或 confirm 成功才清空。

出口：管理员不接触 path/objectKey，组件测试覆盖成功与失败恢复。

### Phase D - 统一商品流

1. StorePage 收集三类候选并交给 composer。
2. 移除两个 shelf 的消费者宿主渲染。
3. 统一 ProductCard 元数据和无障碍披露。
4. 推荐失败只记录并 organic fallback。
5. 首 12 槽之后立即追加当前页未消费 organic，再加载下一 cursor 页。

出口：首页/分类/搜索/分页组件测试通过，无空 shelf。

### Phase E - 文案与后台 projection

1. 更新积分流水、购买确认、商家订单和管理员结算文案。
2. 映射 `blockReason`，替换 SLA/capacity/null 等内部术语。
3. Editorial 使用商品选择器；分类 code/icon 放高级设置。
4. 对目标目录执行用户文案静态扫描。

出口：§6 冻结词汇和 AC 全部有测试证据。

### Phase F - 跨端验证与 PR

1. 更新 XBoard E2E happy path，真实走本地图片上传 -> preview -> confirm。
2. 运行 catalog-ops 独立 E2E；不得并入共享默认 DB。
3. 运行 quick/full targeted gates，保存测试计数与命令。
4. PR -> develop，标签 `run-e2e`，等待 `CI OK`。

---

## 6. 测试计划

### 6.1 前端单元/组件

- feed 12 槽、缺失补位、三类重复、seen 去重、搜索 bypass。
- 两页分别覆盖 3 候选、无候选、organic 不足，断言全部已加载 organic 恰好出现一次且 cursor
  原样前进。
- 推荐请求失败、hydrate 部分失败、organic 不足 12 项。
- Sponsored/Editorial disclosure 的文本、读屏和同卡结构。
- Category cover 上传、preview、replace/remove、busy/error、dialog close/reopen state。
- Category/XBoard preview 使用 SafeImage 且 URL 落在 CSP 已配置 platform origin。
- XBoard 上传后提交 objectKey，不提交绝对 CDN URL。
- 稳定码 projection、未知码兜底、技术详情折叠。
- 积分词汇和 raw internal-term absence。

### 6.2 后端集成

- active public `upload_image` object resolves canonical URL。
- absolute `publicUrlBase` 场景通过。
- private/delivery bucket、inactive、missing、wrong source、provider mismatch、traversal object fail。
- upload authenticate/active/verified/admin 与 MIME/magic-byte/5MB 回归。
- Category create active、inactive -> active、active replace/remove、legacy unresolved 原子门禁；
  读 DTO 仅返回 canonical `defaultCoverUrl`。
- XBoard preview/confirm 对同一 objectKey 一致，失效后 confirm fail 且零写入。
- legacy category/default cover 和旧 XBoard request 全部通过集中 resolver 的兼容测试。

### 6.3 E2E

只增加/修改 1 条关键旅程：管理员 XBoard 本地上传封面 -> preview -> confirm -> 商品预览有图。
这是管理端高危外部导入，满足 `docs/testing-policy.md` §2/§3。首页纯展示和文案不新增
E2E，使用组件测试。

建议复用：

~~~text
e2e/catalog-xboard-import.spec.ts
playwright.catalog-ops.config.ts
scripts/verify-catalog-ops-e2e.sh
~~~

### 6.4 静态 Gate

目标生产 JSX/TSX 不应继续出现：

~~~text
暂无推广内容
暂无精选内容
收入 / 扣除 / 冻结 / 解冻分色展示
不是扣了两笔
默认封面（平台资源路径）
capacity_limit
null=不限
{issue.code}：{issue.message}
~~~

测试 fixture/历史 spec 文档允许保留；扫描需限定生产 UI 路径。

---

## 7. 发布、观测与回滚

### 7.1 发布

- 实现 PR 仅合入 `develop`，不直接发布 master。
- push -> develop 全量 CI/E2E 是集成门。
- 生产发布必须另走 release PR、multi-arch images、production Environment 审批。

### 7.2 观测

- 推荐 API/hydrate fallback 记录结构化 count，不向消费者报错。
- 媒体 resolver 记录 stable reason 和 request ID，不记录 URL credential。
- 上线后观察 StorePage error rate、XBoard preview/confirm `COVER_INVALID` 比例和上传 4xx。

### 7.3 回滚

- UI/feed 回滚：恢复旧 StorePage 宿主即可，Sponsored/Editorial API 未删除。
- 媒体契约回滚：保留 legacy request 兼容，不回滚 StoredObject 或删除上传对象。
- 无 migration，无数据库 down migration。
- 发现上传信任边界回归时先关闭新 UI 写入并恢复旧 fail-closed，不放宽远程 URL。

---

## 8. 风险

| 风险 | 缓解 |
| --- | --- |
| 混排导致分页重复/漏项 | 首 12 槽只消费实际使用项，当前页余项紧随其后；两页测试 + session seen set + organic cursor 不改 |
| 推荐失败影响主商品流 | fail-open，推荐状态不得控制 organic loading/error |
| CDN URL/provider 配置差异 | objectKey + server canonical resolver，不比较客户端 URL |
| 新旧请求并存产生歧义 | 同时提交新旧字段直接 400；契约测试 |
| raw 稳定码完全丢失可观测性 | DOM 默认隐藏，日志/技术详情/data attribute 保留 |
| 大宿主文件并发冲突 | 单实现 Agent 持有 StorePage/AdminPage/MerchantDashboardPage 文件锁 |
