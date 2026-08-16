# Spec: Catalog / Merch 用户心智与媒体工作流修订

| 字段 | 值 |
| --- | --- |
| 文档 ID | `SPEC-CMI-UX-001` |
| 版本 | `0.2.0` |
| 日期 | `2026-08-16` |
| 状态 | **Frozen for Implementation** |
| Owner | MoNexus Project Owner |
| 审查基线 | `develop@4554f96dd7780e83b80dc98ad4938bf5e181a275` |
| 配套文档 | [README.md](./README.md) · [plan.md](./plan.md) · [task.md](./task.md) · [implement.md](./implement.md) · [checklist.md](./checklist.md) |

---

## 1. 目的与问题

### 1.1 目的

把已经具备安全边界和业务状态机的 Catalog / Merch 功能，修订为管理员、商家和买家
能够直接理解并完成任务的产品体验。后端继续保留稳定码、对象登记、幂等和审计，
但这些实现细节必须由前端和 API projection 转译为用户动作与结果。

### 1.2 已核实问题

| ID | 当前事实 | 用户影响 |
| --- | --- | --- |
| `UX-GAP-01` | `SponsoredShelf` 在普通商品网格前独立渲染，无数据时显示“暂无推广内容” | 首页像未配置完成；推广被理解为额外内容区，而非商品曝光 |
| `UX-GAP-02` | `EditorialShelf` 固定显示“平台精选”，无数据时显示“暂无精选内容” | 消费者看到运营空状态，首屏空间被占用 |
| `UX-GAP-03` | Sponsored/Editorial 与 organic cursor 完全分离 | 购买推广未在统一商品浏览流中形成明确曝光优势 |
| `UX-GAP-04` | 分类封面是 `默认封面（平台资源路径）` 文本框 | 管理员必须理解 `/uploads/`、`/assets/` 和对象路径 |
| `UX-GAP-05` | 上传 API 返回 storage adapter URL；生产通常是绝对 CDN URL | 成功上传的图片不一定符合 XBoard 的相对路径校验 |
| `UX-GAP-06` | XBoard resolver 只接受 `imageUrl.startsWith('/uploads/')` | 生产上传结果可被错误拒绝为 `COVER_INVALID` |
| `UX-GAP-07` | XBoard 预览直接显示 `issue.code：issue.message` | 稳定错误码和后端约束成为主界面文案 |
| `UX-GAP-08` | 积分流水说明“分色展示”“不是扣了两笔” | 文案像测试注释，未优先解释资金结果 |
| `UX-GAP-09` | 后台出现 raw ID、`capacity_limit`、`null=不限`、SLA、raw `blockReason` | 用户被迫理解数据库、接口和运营内部术语 |
| `UX-GAP-10` | 推荐 ID hydrate 失败会被静默过滤并最终显示“暂无...” | 真空数据、失效数据与请求故障被混为一谈 |

### 1.3 成功标准

1. 消费者首页没有“暂无推广内容”或“暂无精选内容”区块。
2. 有效推广商品在统一商品流首屏获得确定的附加曝光，并始终披露“推广”。
3. 有效精选商品在同一商品流中展示，不产生独立空 shelf。
4. 推荐服务失败时，普通商品浏览、搜索和分页不受影响。
5. 管理员可以在分类表单直接上传、预览、替换或移除默认封面。
6. XBoard 本地上传在 production CDN 绝对 URL 配置下仍可 preview/confirm。
7. 用户界面不再要求手填平台路径，不直接显示 `COVER_INVALID` 等稳定码。
8. 冻结、支付、返还和结算文案在买家、商家、管理员界面保持同一含义。
9. 不削弱 StoredObject registry、公开 bucket、MIME、大小、鉴权或审计边界。
10. 不新增数据库迁移，不修改订单资金状态机和推广计费状态机。

---

## 2. 用户角色与心智模型

### 2.1 买家

- 浏览的是一个商品流，不需要理解 organic、sponsored、editorial placement。
- 推广仍是商品，只是付费获得了额外展示，卡片必须清晰标注“推广”。
- 平台精选仍是商品，只用简短“精选”标识表达运营选择。
- 没有推广或精选时不应看到平台运营状态。
- 人工服务支付时，应理解“暂时锁定、完成后支付、取消/退款后返还”。

### 2.2 商家

- 购买推广的结果是商品获得更多曝光，不是生成一段独立“推广内容”。
- 订单页需要看到可执行状态和资金结果，不需要理解内部 settlement/block reason。
- 统计口径需说明时间范围和是否为净收入，不直接用实现术语替代解释。

### 2.3 平台管理员

- 分类封面通过选择图片完成，不通过输入存储路径完成。
- XBoard 导入通过“选择本地图片 / 使用分类封面”完成，不理解 CDN 和 object key。
- 商品、分类、套餐和精选优先通过名称搜索选择；ID/code 只在高级详情中显示。
- 错误提示说明问题和下一步，稳定码仅进入日志、测试属性或可展开技术详情。

---

## 3. 冻结产品决策

| ID | 决策 |
| --- | --- |
| `D-UX-01` | 移除消费者页面独立 `SponsoredShelf` 和 `EditorialShelf` 固定区块；组件/API 可在兼容期保留，但 `StorePage` 不再直接渲染空 shelf |
| `D-UX-02` | 无搜索词时把推广/精选候选混入同一个商品卡列表；搜索结果永不注入，保证查询相关性 |
| `D-UX-03` | 初始 12 个展示槽位固定模板：`O,O,S,O,O,E,O,O,S,O,O,O`；O=普通商品、S=推广、E=精选 |
| `D-UX-04` | 缺少某类候选时由下一个普通商品补位；不得渲染空槽、空标题或消费者错误文案 |
| `D-UX-05` | 同一商品同时命中推广/精选时推广优先，只展示一次；已注入商品从本会话后续 organic 页面去重，所有已加载 organic 商品仍须恰好展示一次 |
| `D-UX-06` | 推广卡与普通卡使用同一视觉结构，只增加可感知且可访问的“推广”披露；不得伪装自然结果 |
| `D-UX-07` | 精选卡使用同一视觉结构，显示“精选”及可选短理由；不得显示“不代表背书”等内部免责声明 |
| `D-UX-08` | 推荐 API/Hydrate 失败 fail-open：记录可观测错误并回退普通商品流，不向消费者显示运营错误 |
| `D-UX-09` | 混排只改变展示组合，不改变 organic cursor、自然排名计算、Campaign 计费和 Editorial 数据状态机 |
| `D-UX-10` | 分类创建/编辑主流程不出现 URL/path 文本框；提供上传、预览、替换、移除动作 |
| `D-UX-11` | 新建 active 分类必须有可用默认封面；inactive 分类可暂时无封面；激活前必须补齐封面 |
| `D-UX-12` | XBoard 封面只允许“使用分类默认封面”或“上传本地图片”，不允许任意远程 URL |
| `D-UX-13` | 上传请求以 `objectKey` 作为本次写入/确认的信任锚；客户端展示 URL 不作为 StoredObject 身份依据，Category 不新增 objectKey 持久字段 |
| `D-UX-14` | 服务端集中解析 upload object/static asset，Category 和 XBoard 禁止各自复制路径判断 |
| `D-UX-15` | 现有 `defaultCoverUrl` 和 Product `imageUrl/images` 持久字段保持兼容；本规格不迁移存量行 |
| `D-UX-16` | 稳定码继续保留在 API details；默认 UI 只显示映射后的用户消息，未知码使用安全兜底并记录原码 |
| `D-UX-17` | raw ID/code/path 仅在可展开“技术详情”中出现；正常创建/编辑使用搜索选择器、名称和业务标签 |
| `D-UX-18` | 积分 UI 的用户词汇冻结为“入账、待支付、已支付、已返还”；底层 `in/out/hold/release` 不变 |
| `D-UX-19` | `SLA 超时` 改为“已超过处理时限”，并同时显示具体截止时间；raw `blockReason` 必须投影 |
| `D-UX-20` | 任何安全、权限、StoredObject registry、MIME、5MB、公开 bucket 和审计约束不得因 UX 简化而放宽 |

---

## 4. 统一商品流契约

### 4.1 输入

~~~ts
type StoreFeedInput = {
  organic: Product[]
  sponsored: SponsoredCandidate[]
  editorial: EditorialCandidate[]
  searchQuery: string
  seenProductIds: Set<number>
}
~~~

候选必须已经满足现有 active Campaign/Product/Merchant、placement、分类和时间窗口条件。
前端 hydrate 只负责取得卡片数据，不重新解释 eligibility。

### 4.2 初始 12 槽混排

槽位按 1-based 位置定义：

| 位置 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 首选 | O | O | S1 | O | O | E1 | O | O | S2 | O | O | O |

规则：

1. S1/S2 最多各取一个稳定排序后的推广候选，E1 最多取一个精选候选。
2. 同一 productId 只能出现一次；优先级 `sponsored > editorial > organic`。
3. 候选缺失、失效或 hydrate 失败时立即用下一个 organic 补位。
4. 首屏最多 2 个推广和 1 个精选，至少 9 个普通商品。
5. 首 12 个输出槽仅消费实际放入这些槽位的 organic；当前 cursor 页中尚未消费的 organic 必须按原顺序紧接在第 12 槽之后追加，再请求下一 cursor 页。
6. 每个已加载且未被 sponsored/editorial 同 productId 替代的 organic 必须恰好输出一次；不得因预先拉取一页、槽位注入或 seen set 而丢弃。
7. 后续加载追加下一页 organic，并过滤本会话已经展示或被注入替代的 productId；服务端 cursor 原样前进，不倒退、不重写。
8. 分类页只接收该分类 eligible 候选；首页使用 home placement。
9. `searchQuery.trim() !== ''` 时只返回 organic，不请求或不使用推荐候选。
10. 响应式列数只改变换行，不改变逻辑顺序和披露。

两页边界示例：若第一页 cursor 已加载 `O1...O12` 且 3 个注入候选有效，前 12 槽使用
`O1,O2,S1,O3,O4,E1,O5,O6,S2,O7,O8,O9`，随后必须立即输出 `O10,O11,O12`；第二页从
服务端返回的下一 cursor 开始。无候选时 `O1...O12` 进入前 12 槽；organic 不足时只输出实际
可用项。三种情况均不得丢项或重复。

### 4.3 卡片语义

- Sponsored：同一 `ShelfProductCard`/Product card 主体，顶部小标签“推广”。
- Editorial：同一卡片主体，标签“精选”；有 `publicReason` 时最多显示 40 个 Unicode 字符。
- 普通商品：保留现有平台自营、热卖、合作权益 badge 规则。
- 不允许为推广卡使用虚假评分、价格、销量或“平台推荐”文案。
- 读屏顺序必须包含“推广，商品名...”或“精选，商品名...”。

### 4.4 空态与错误

- 无推广：不显示任何推广标题、提示或占位。
- 无精选：不显示任何精选标题、提示或占位。
- 推荐失败：消费者无错误提示；普通商品流照常展示。
- organic 为空：沿用真正的商品空态，但搜索为空与分类无商品应使用不同文案。
- 管理后台仍可使用 EmptyState，因为管理员需要知道配置列表为空。

---

## 5. 平台媒体契约

### 5.1 目标类型

~~~ts
type PlatformMediaRef =
  | { kind: 'upload'; objectKey: string }
  | { kind: 'static'; path: `/assets/${string}` }
~~~

`objectKey` 来自认证上传 API 返回值。`url` 可用于即时预览，但不能作为服务端信任锚。
`objectKey` 只存在于未保存的客户端状态和写请求中；当前 Category 表只存
`defaultCoverUrl`，本规格禁止为 Category 新增 objectKey 字段。

### 5.2 服务端解析器

必须新增单一 domain helper，例如：

~~~ts
resolvePlatformPublicImage(ref: PlatformMediaRef): Promise<{
  canonicalUrl: string
  objectKey: string | null
  source: 'upload_image' | 'static_asset'
}>
~~~

上传对象验证：

1. `objectKey` 格式安全，无 traversal/control/query/hash；
2. StoredObject 存在；
3. `bucketRole=public`；
4. `status=active`；
5. `source=upload_image`；
6. provider 配置可生成 canonical public URL；
7. 不信任客户端提交的 CDN origin、URL 或 path。

静态资产验证继续限制 `/assets/` allowlist。不得允许任意远程 URL。

兼容读取/写入必须经过同一 helper 的 legacy 入口，不得沿用分散的“旧规则”：

1. `/assets/...` 仅在现有静态 allowlist 中才可解析；
2. `/uploads/<key>` 必须提取 key 并验证对应 StoredObject；
3. 绝对 CDN URL 仅在其 origin/path 可无歧义映射到当前已配置 public provider base 和 active
   StoredObject 时才可解析；
4. 任意外部 URL、private/delivery bucket、provider mismatch 和无法反解的 URL 一律拒绝；
5. 已有 active Category 的 legacy URL 可继续只读展示，但再次激活、替换封面或被 XBoard
   采用时必须重新解析；provider 切换后无法解析的封面必须由管理员替换。

### 5.3 API 兼容

- `/api/uploads/image` 保留精确响应 `{ key: string, url: string }`；请求层把 `key` 作为
  `objectKey`，必须满足 `key === objectKey`，不得从 `url` 反推 key。
- Category create/update 新增首选字段 `defaultCover: PlatformMediaRef | null`；服务端解析后只把
  `canonicalUrl` 写入既有 `defaultCoverUrl` 列。
- Category read DTO 继续只返回 `defaultCoverUrl: string | null`，不得返回 objectKey、provider、
  bucket 或内部 StoredObject 信息；重开表单直接预览该 canonical URL。
- 兼容期可继续接收旧写字段 `defaultCoverUrl`，但它也必须经过 §5.2 的集中 legacy resolver；
  新 UI 不再提交该字段。
- XBoard cover 改为：

~~~ts
type XboardCover =
  | { mode: 'category_default' }
  | { mode: 'uploaded'; objectKey: string }
~~~

- XBoard preview/confirm 响应只返回 canonical display URL 和既有业务字段/issue，不返回
  objectKey 或 provider 配置。
- 服务端解析后继续填充 Product `imageUrl/images`，保持公开 DTO 和存量客户端兼容。
- legacy `imageUrl/images` confirm 请求若仍支持，必须标记 deprecated，并使用同一 resolver；不得保留仅 `startsWith('/uploads/')` 的独立判断。

### 5.4 分类封面交互

- 表单显示当前图片预览、来源（上传/内置）、“上传图片”“替换”“移除”。
- 接受 PNG/JPEG/WebP/GIF、最大 5MB；沿用服务端 magic-byte 校验。
- 上传中阻止重复提交；失败保留表单其他输入。
- 新建 active 分类无封面时在提交前显示“请上传分类默认封面”。
- 编辑已有 legacy URL 时可以继续预览和原样保留；一旦激活、替换或供 XBoard 使用，服务端
  必须按 §5.2 重新解析，无法解析时提示替换。
- 路径、CDN URL、objectKey 不进入普通表单。

服务端必须在与 Category 写入相同的事务/原子操作中执行状态门禁：

- create active：必须提供可解析封面；
- create inactive：允许无封面；
- inactive -> active：现有或新封面必须可解析；
- active replace：新封面先解析成功，再替换 URL；失败保持旧值；
- active remove：拒绝且不改变原值；inactive remove 允许；
- legacy 无法解析：不得用于激活或 XBoard，必须先替换。

### 5.5 XBoard 封面交互

- 默认选择“使用分类默认封面”，并在选择分类后立即显示实际预览。
- 分类无封面时显示操作提示和“去设置分类封面”入口，不等 preview 后返回稳定码。
- 选择“上传本地图片”后立即预览；重新选择文件替换先前 objectKey。
- Preview/Confirm 都必须服务端重新解析 objectKey，防止对象失效或 provider 切换。
- Confirm 失败保留套餐、分类、规格和图片选择，不清空整张表单。
- Dialog 仅临时关闭再重开时保留已成功上传但尚未 confirm 的选择和预览；只有显式“取消导入”
  或 confirm 成功才清空该 draft。上传失败不覆盖上一次成功选择。

---

## 6. 用户文案与错误投影

### 6.1 冻结词汇

| 内部类型/旧文案 | 用户文案 |
| --- | --- |
| `in` / 收入 | 入账 |
| `hold` / 冻结 | 待支付 |
| `out` / 扣除 | 已支付 |
| `release` / 解冻 | 已返还 |
| SLA 超时 | 已超过处理时限 |
| `capacity_limit` | 套餐容量上限 |
| `null=不限` | 不限数量（toggle） |
| 平台抽 | 平台服务费 |
| 单总额 | 订单金额 |
| settlement ID | 结算记录（业务编号可复制，默认不展示数据库 ID） |

积分流水说明冻结为：

> 人工服务下单后，积分会暂时锁定；订单完成后才正式支付，取消或退款后会自动返还。

禁止出现“分色展示”“不是扣了两笔”等实现/测试导向句式。

### 6.2 COVER 错误映射

| 稳定码/服务端原因 | 默认用户消息 | 建议动作 |
| --- | --- | --- |
| `COVER_REQUIRED` | 请上传一张封面，或使用分类默认封面 | 聚焦封面控件 |
| `COVER_INVALID` + object missing/expired | 这张封面已失效，请重新上传 | “重新上传” |
| `COVER_INVALID` + category default missing | 所选分类还没有默认封面 | “设置分类封面” |
| unsupported type | 请选择 PNG、JPEG、WebP 或 GIF 图片 | 重新选择文件 |
| too large | 图片不能超过 5MB | 重新选择文件 |
| unknown cover error | 封面暂时无法使用，请重新上传后再试 | 保留原始稳定码到日志 |

默认 DOM 不显示稳定码。管理员可在折叠的“技术详情”中复制 request ID 和稳定码；
技术详情不得包含 token、object storage credential、providerRef 或秘密库存。

### 6.3 后台字段投影

- Editorial 创建使用可搜索商品选择器，不要求输入 Product ID。
- Category code 默认从名称生成，放在“高级设置”中，创建后说明不可修改。
- iconKey 使用图标选择器；无选择时不显示 raw key 输入。
- raw `blockReason` 必须映射为有限用户原因；未知值显示“暂时无法结算，请联系平台处理”。
- ID/code 可在详情中复制，但不作为标题、按钮或主要表格列。

---

## 7. 安全、隐私与可访问性

1. 上传仍要求 authenticate、active user、verified email 和现有 admin route 权限。
2. 不能通过传 objectKey 读取 private/delivery bucket 对象。
3. 服务端必须防 traversal、重复/过期对象、provider mismatch 和伪造 URL。
4. 图片预览必须使用既有 `SafeImage` 和 CSP 允许的 platform origins。
5. 推荐失败日志只记录 product/campaign/feature ID 与稳定原因，不记录 token 或用户敏感信息。
6. “推广”“精选”标签同时具有文本和视觉信息，不能只靠颜色。
7. 上传控件可键盘操作，有 label、busy 状态、错误关联和替代文本。
8. Dialog 关闭/重开不得丢失已成功上传但尚未保存的预览，除非用户明确取消。

---

## 8. 需求与验收标准

### 8.1 商品流

- `REQ-UX-FEED-001`：StorePage 使用统一 feed composer，不直接渲染两个 shelf。
- `REQ-UX-FEED-002`：首 12 槽严格执行 §4.2 模板和缺失补位。
- `REQ-UX-FEED-003`：同 productId session 内不重复。
- `REQ-UX-FEED-004`：搜索无注入，分类 eligibility 不跨分类。
- `REQ-UX-FEED-005`：推荐错误 fail-open，不影响 organic pagination。
- `REQ-UX-FEED-006`：所有已加载 organic 跨首屏和下一 cursor 页不丢失、不重复。

验收：

- `AC-UX-001`：无推荐数据时首页只显示普通商品，无“暂无推广/精选内容”。
- `AC-UX-002`：2 个推广 + 1 个精选时前 12 卡顺序符合模板。
- `AC-UX-003`：候选不足、重复或 hydrate 失败时由 organic 无缝补位。
- `AC-UX-004`：推广卡读屏和视觉均披露“推广”。
- `AC-UX-005`：精选卡读屏和视觉均披露“精选”，可选理由不破坏卡片可访问名称。
- `AC-UX-006`：搜索请求/结果不包含注入卡。
- `AC-UX-007`：推荐 API 500 时商品页仍可浏览和继续分页。
- `AC-UX-008`：两页测试覆盖 3 候选、无候选、organic 不足三种情形；每个已加载 organic
  恰好显示一次，cursor 不改写，productId 全局不重复。

### 8.2 媒体

- `REQ-UX-MEDIA-001`：Category/XBoard 共用 `PlatformMediaRef` resolver。
- `REQ-UX-MEDIA-002`：Category UI 不出现 path/URL 文本框。
- `REQ-UX-MEDIA-003`：production-style absolute CDN upload 可用于 XBoard confirm。
- `REQ-UX-MEDIA-004`：伪造、private、expired、inactive、非 upload_image object 被拒绝。
- `REQ-UX-MEDIA-005`：无 schema/migration 改动，持久 DTO 兼容。

验收：

- `AC-UX-009`：管理员上传分类封面、保存、重开后 canonical URL 预览一致；Category read
  DTO 不暴露 objectKey/provider。
- `AC-UX-010`：XBoard 本地上传 -> preview -> confirm 成功创建带封面商品，响应不暴露 objectKey。
- `AC-UX-011`：绝对 CDN URL 只有能映射到配置的 public provider 和 active StoredObject 时
  才通过，不再以 `/uploads/` 字符串前缀误判。
- `AC-UX-012`：分类默认封面缺失在客户端操作前提示，不直出 `COVER_INVALID`。
- `AC-UX-013`：伪造、missing/inactive、private/delivery、wrong-source、provider mismatch、
  traversal 媒体均服务端 4xx fail-closed，数据库零写入。
- `AC-UX-014`：替换/失败不清空分类、规格、价格等无关输入；Dialog 临时关闭/重开保留
  成功上传 draft，显式取消或 confirm 成功后才清空。
- `AC-UX-015`：create active、inactive -> active、active replace/remove 和 legacy 无法解析的
  状态转换严格执行 §5.4 原子门禁。
- `AC-UX-016`：upload/category/XBoard 写路径保持 authenticate、active、verified、admin 权限，
  并回归 PNG/JPEG/WebP/GIF、MIME/magic-byte 和 5MB 限制。
- `AC-UX-017`：Category/XBoard 预览使用 `SafeImage`，仅允许 CSP 已配置的平台 origin；键盘、
  label、busy、错误关联和替代文本均可访问。

### 8.3 文案

- `REQ-UX-COPY-001`：目标页面不直接显示稳定码、路径和数据库字段。
- `REQ-UX-COPY-002`：资金词汇按 §6.1 统一。
- `REQ-UX-COPY-003`：raw ID/code 进入技术详情或可复制次要信息。

验收：

- `AC-UX-018`：积分流水使用冻结文案，不出现“分色展示/扣了两笔”。
- `AC-UX-019`：买家支付预览说明待支付、完成支付和取消返还。
- `AC-UX-020`：商家订单/结算不直出 raw `blockReason` 或“SLA”。
- `AC-UX-021`：管理员不直接看到 `capacity_limit`、`null=不限` 或封面路径输入。
- `AC-UX-022`：XBoard 默认错误只显示用户消息，日志/测试仍可取得稳定码。

---

## 9. 非目标

- 不改变 Campaign 购买、计费、退款或审核状态机。
- 不实现 CPM/CPC、曝光计费或新的 analytics billing。
- 不改变自然排名 compute/snapshot 算法。
- 不允许 XBoard 抓取任意远程图片。
- 不建立通用 DAM/媒体库；P0 只做直接上传和已有静态资源兼容。
- 不修改 Prisma schema、既有 migration 或生产存量数据。
- 不重新设计全部 AdminPage/MerchantDashboard；只处理本规格列出的术语和控件。
- 不把 Deferred Image2/runtime asset 或 bundle budget 纳入本修订。
- 不自动发布 production；实现 PR 只进入 `develop`。

---

## 10. 变更控制

以下内容变更必须退回 Draft：混排槽位与上限、搜索注入规则、推广披露、对象信任锚、
允许的媒体来源、资金词汇、数据库/迁移范围、Campaign/订单状态机范围。

非语义性的组件拆分、CSS 实现、helper 命名和测试文件布局可由实施 Agent 在保持 AC 的
前提下决定，并在 PR 描述中记录。

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| `0.1.0` | 2026-08-16 | Draft | Owner 提出并批准：统一商品曝光流、隐藏消费者空运营位、分类/XBoard 上传闭环、用户文案与稳定码分层 |
| `0.2.0` | 2026-08-16 | Frozen for Implementation | 独立审阅后补全 organic 分页不丢项、Category URL-only 持久化、集中 legacy resolver、状态原子门禁、安全/无障碍和可执行 Gate |
