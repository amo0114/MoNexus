# 商家待办与经营建议 V1

| 项目 | 内容 |
| --- | --- |
| 文档 ID | SPEC-MERCHANT-WORKBENCH-001 |
| 版本 / 日期 | 0.2.1 / 2026-10-07 |
| 状态 | 已采纳实施依据；PR1 后端本地验证通过，前端与试点未完成 |
| 对象 | 已激活商家；平台自营和管理员工作台不在本期 |
| 核心目标 | 商家进入后台即可知道当前需要处理什么，并准确到达原操作位置 |
| 实施拆分 | [实施计划](./merchant-workbench-v1.plan.md) |

## 1. 产品决定

首期做规则驱动的商家待办工作台，包含草稿缺项、低库存/名额不足、人工履约临期/超时三类事项。规则负责发现、事实展示和优先级；点击卡片进入原编辑、库存或订单界面，由用户完成操作。

V1 不调用模型。V1.1 在试用证明解释确有价值后，增加按需 AI 解释；离线巡检另作为 V1.2。这是同一产品的分阶段交付，不把定时查询数据库包装成必须依赖模型的 Agent。

本期“主动”指用户进入后台后无需先提问即可看到事项；不承诺离线发现新事项、每日自动生成日报或主动向外发消息。现有低库存与超时邮件继续承担离线提醒。

### 1.1 首期交付

- `/merchant` 与 `/merchant/dashboard` 复用同一待办摘要组件。
- 新增 `/merchant/workbench` 完整待办列表。
- 三类规则、权威事实、明确下一步和各组更新时间；V1 不做暂缓。
- 紧急事项始终可见；普通建议首页最多展示 5 条，不要求凑满。
- 深链接只负责定位，不自动保存、发布、导入、改名额、发消息或处理争议。
- 新能力关闭或故障时，原后台、编辑器、邮件和订单操作仍能使用。

### 1.2 不包含

暂缓/忽略偏好、工作台新表和迁移、预测售罄、转化诊断、推广 ROI、评价摘要、风险评分、商品定价、AI 回复起草、管理员对话、自动写业务表、MCP、Jev、Agent SDK、多 Agent、向量检索。

商品草稿助手由现有 `feat/ai-product-content-copilot` 分支继续完成，本方案不复制该功能。

## 2. 已有基础与边界

以下为 2026-10-07 代码观察，不代表已查询生产数据或验证实际经营收益。

| 已有基础 | 代码 | 本方案如何使用 |
| --- | --- | --- |
| 商家权限链 | `server/src/modules/merchant/routes.ts`、`server/src/middlewares/auth.ts` | 复用 authenticate → requireActiveUser → requireMerchant；当前 requireMerchant 只允许 active 商家 |
| 商家待办数量 | `server/src/modules/merchant/service.ts::getMyStats` | 保留原计数，不另改订单状态语义 |
| 发布检查 | `server/src/modules/catalog/publicationReadiness.ts::checkProductReadiness` | 复用 details 的 code、field、offerId，禁止解析 reason 文案 |
| 规格库存与邮件 | `server/src/lib/lowStockNotify.ts` | 沿用即时库存数 available 条目、容量型看 stock、unlimited 排除的口径 |
| SLA 邮件 | `server/src/lib/slaRemind.ts` | 现有每小时巡检、每单成功发一封超时邮件；本期不改发送状态 |
| 订单入口 | `src/pages/MerchantDashboardPage.tsx` | 已支持 `/merchant/orders/:id` 聚焦订单 |
| 库存/名额界面 | `src/components/merchant/MerchantAvailabilityModal.tsx` | 复用对话框和原接口；精确规格深链接需新增 |
| 经营数据页 | `src/pages/merchant/Dashboard.tsx` | 在现有统计上方接入摘要，独立加载 |
| AI 运行时 | 另一个工作区的 `docs/specs/ai-foundation.md`、`server/src/lib/ai/` | 只作为 V1.1 依赖；V1 不等待 AI 分支合并 |

说明：部分旧 README 中暂停商家的可读权限描述与当前中间件不同。本方案以实际权限链为准，不顺带扩大权限。

## 3. 页面与交互

### 3.1 首页摘要

顺序：需要尽快处理 → 经营待办 → 查看全部。每张卡片只呈现一个资源及一个主要动作。

示例（均为合成数据，不是生产统计）：

| 卡片 | 依据 | 主要操作 |
| --- | --- | --- |
| 人工服务订单即将超时 | 订单 #481，当前处理中，履约截止 10 月 7 日 18:00 | 查看订单 |
| 某规格库存不足 | 标准版当前可售 3 份，提醒阈值 5 份 | 管理该规格库存 |
| 草稿有待补充项目 | 缺商品封面、购买须知；其他发布条件仍须提交时检查 | 完善商品 |

卡片的时间、库存、阈值、状态由服务端结构化字段渲染。时间显示 Asia/Shanghai；所有比较使用绝对时间。

- 紧急区显示完整总数，摘要最多列 3 条，另有“查看全部紧急事项”。超过 3 条不表示已隐藏或已处理。
- 普通区最多 5 条。不要每天制造 3～5 条，不因无事项而发通知。
- 点击主要操作不标记完成；返回时重新取数据，由真实业务条件决定是否消失。
- V1 不提供暂缓、忽略或“标记完成”；业务条件解除后，刷新移除卡片。
- 无事项且检查完整时显示“当前没有需要处理的事项”；失败显示“部分事项暂未检查”，不能伪装成空列表。
- 不在 UI 展示规则版本、数据库名、Projection 等实现细节。

### 3.2 刷新与加载

刷新分为紧急事实与草稿检查两条路径，禁止定时轮询调用 readiness。

| 触发 | 紧急事项（SLA + 售罄） | 普通低库存 | 草稿 |
| --- | --- | --- | --- |
| 首次进入 | 加载 | 加载 | 检查第一批 20 个 |
| 页面可见，每 60 秒 | 刷新 | 保留上次结果 | 不执行 |
| 重新获得焦点，距上次该组请求 >30 秒 | 刷新 | 刷新 | 重置批次，检查第一批 |
| 手动刷新 | 刷新 | 刷新 | 重置批次，检查第一批 |
| 点击继续检查草稿 | 不执行 | 不执行 | 只检查下一批 |
| 原操作成功后返回 | 刷新 | 若涉及库存则刷新 | 只重验刚编辑的产品，不重扫整批 |

当紧急轮询发现已加载普通库存卡片的规格售罄，按 key 移出普通区并纳入紧急区。普通库存/草稿各自显示更新时间，不把紧急轮询时间冒充整页更新时间。移出紧急区的资源不自动变成普通卡片，等待普通组下次刷新确认。只有该组查询成功且未截断时，才可用“新结果中不存在”移除旧卡片；failed/truncated 时保留旧卡片并标记待刷新，或通过单事项查询确认，不误判已解决。

V1 不使用 SSE、不建立跨用户共享响应缓存、不在浏览器持久化卡片。同一页面共享请求和结果，组件去重并发请求，丢弃旧会话/旧批次返回；失焦停止计时。多标签页不做跨标签协调，但它们的定时刷新均不得触发草稿检查。

### 3.3 完整列表

按规则分组展示，支持“全部 / 紧急”。SLA 和低库存分别一次返回最多 200 条，按规则顺序取最需要处理的记录；不做 keyset 分页。命中超过上限时显示完整匹配数量、已显示数量和“请到订单/商品管理查看其余事项”，不能称已完整展示。

只有草稿按批推进：每批检查 20 个，用简单的产品 ID 游标继续；显示已检查数量和是否还有下一批，不要求全店扫描水位、扫描运行记录或精确剩余缺项总数。对同一轮结果按 productId 去重，刷新第一批时清空该轮累积结果。

首页与完整列表共用判定器和 DTO；已返回的数据可在当前会话内复用，不同时重复拉两套摘要和明细。

## 4. 三类确定性规则

统一返回 `match | clear | unknown | ineligible`：match 才显示卡片，clear 表示该条件已解除，unknown 表示本次读取/检查失败，ineligible 表示不属于规则范围。失败不得当作已解决。

### MW-R01：草稿缺项

- 范围：当前商家的 `Product.status=draft` 且 `archivedAt=null`。
- 与发布接口使用同一检查调用及默认选项：`checkProductReadiness(productId, db)`，`requireCurrentlySellable=true`；禁止套用已上架商品内容保存路径的 false。实际发布仍在原事务中再次检查，工作台结果不是发布凭证。只输出安全检查结果，不把内部商品实体返回给客户端或 AI。
- 缺项按 `(code, field, offerId)` 去重；一个商品一张卡片，展示最多 3 条，其余以数量提示。
- 所有缺项都归为待办；缺项少只是排序信号，不能写“补完这两项一定能发布”。
- `EXTERNAL_IDENTITY_INVALID` 等商家未必能自行修复的项，显示“检查配置”；不给修复成功承诺，不显示内部凭据。
- 没有缺项的草稿不生成“缺项”卡片，也不自动发布；主动引导发布可另行评审。
- 普通排序：去重缺项数升序，产品 ID 降序。候选分页按产品 ID 降序；排序只对已检查集合生效，UI 标注覆盖范围。
- 失效：不再是草稿、已归档、归属变化或本次完整 readiness 无缺项。

### MW-R02：低库存与名额不足

- 范围：当前商家、未归档且 active 商品、active 规格；`instant_inventory` 或 `stockMode=limited`。
- `instant_inventory`：按 `InventoryItem.offerId`、`status=available` 聚合计数，不能读 Product.stock 替代。
- 非即时库存且限量：读 `Offer.stock`；无限量规格排除。
- `externalIntegration!=null` 的外部集成规格首期排除，不用本地 stock 推断 Xboard 上游容量。这是本工作台的范围收缩，不改变既有邮件规则。
- 阈值复用 `lowStockThreshold`。`available <= threshold` 命中；0 为紧急，正数为普通。阈值为 0 时只匹配售罄。
- 同一规格只一张卡片，类型字段区分库存条目与名额；文案分别为“补充库存”和“调整名额”。
- 不建议补多少，不预测何时卖空，不预填 delta。
- 失效：数量高于阈值、规格停用、商品下架/归档、归属变化或变为不适用模式。
- 排序：售罄在前，available 升序，offerId 升序。

### MW-R03：人工履约临期 / 超时

- 订单归属使用 `Order.merchantId`；不能因当前商品归属变化把历史订单转给另一商家。
- 候选与 SLA 提醒语义一致：`status in [pending, processing]`、`deliveryModeSnapshot=manual_service`、`fulfillmentDeadline!=null`。
- 初始临期窗口固定 24 小时：`now <= deadline <= now + 24h` 为临期，`deadline < now` 为超时，与邮件的 `lt: now` 一致；恰好等于 now 时标记“已到截止时刻”，仍属于临期档。每次判定用同一个 now。
- 临期及超时均为紧急事项，不受普通卡片上限影响；数据保护上限不截断总数，见 §7。
- 同订单只一张卡片，从临期更新为超时，不新增第二张。
- 状态为 disputed、delivered、closed、refunded 等即退出此规则；本期不额外建立争议规则。
- `autoProvision` / 外部开通但仍符合原 SLA 候选的订单可以出现，仅提供“查看订单”，不诱导手动再次开通、重复发货或修改自动流程。
- 缺失 deadline 表示不参与，不默认立即超时或永不过期。
- 排序：超时在前，deadline 升序，orderId 升序。

### 4.1 跨规则优先级

履约超时 → 履约临期 → 售罄 → 低库存 → 草稿缺项。排序由代码完成，不交给模型。

## 5. V1 无新增持久化

卡片由当前数据计算，不保存卡片、事实快照、用户偏好、模型文本或“已完成”状态。V1 不新增工作台表、数据库迁移、证据指纹、暂缓写接口、409 冲突协议或行锁。

暂缓只有在试点反复出现“已知事项持续打扰”反馈后再评审。后续需另行定义到期、紧急升级、恢复后再触发、归属变更和重复请求语义；本期不预建字段或接口。

## 6. 服务与 API 契约

新增模块建议 `server/src/modules/merchant/workbench/`：schema、rules、repository、service、routes、dto。前端通过 `src/api/client.ts` 访问。

路由挂在原商家权限链之后；merchantId 只从已鉴权用户查得。查询参数 strict，拒绝传入 merchantId、userId、事实值或任意 URL。V1 所有接口均为只读 GET。

| 方法与路径（拟新增） | 输入与行为 |
| --- | --- |
| GET `/api/merchant/workbench/urgent` | SLA 临期/超时、售罄两个分组，每组最多 200 条及完整匹配数；60 秒轮询的唯一入口，也用于功能可用性探测；不调用 readiness |
| GET `/api/merchant/workbench/availability` | 全部低库存（含售罄）最多 200 条及匹配数；首次、焦点、手动或库存操作后调用 |
| GET `/api/merchant/workbench/drafts` | 可选 `beforeProductId` 正整数；固定每批 20 个草稿，返回扫描结果与下一批游标 |
| GET `/api/merchant/workbench/items/:rule/:targetId` | 重算单个归属资源，用于原操作后刷新及失败重试；不是定时轮询入口 |

单事项读取：他人/不存在资源统一 404；自有资源不再命中返回 `{state:'clear'|'ineligible'}`；数据库故障不得返回 clear。urgent 与 availability 中相同规格由前端按 key 去重，最新紧急结果优先决定是否放入紧急区；普通组保持自身更新时间。

```ts
type WorkbenchItem = {
  key: string; // rule:targetId；不是访问凭证
  rule: 'draft_incomplete' | 'low_availability' | 'fulfillment_due';
  targetId: number;
  productId: number | null;
  offerId: number | null;
  priority: 'urgent' | 'normal';
  evidence: DraftEvidence | AvailabilityEvidence | FulfillmentEvidence;
  action: WorkbenchAction; // 封闭枚举，不接受任意 URL
  evaluatedAt: string;
};
```

- DraftEvidence：商品显示名、contentVersion、去重 code/field/offerId 列表及 §8 封闭导航目标；不含完整编辑 DTO。
- AvailabilityEvidence：商品/规格显示名、available、threshold、kind=inventory|capacity；不含卡密、固定交付内容、外部 SKU。
- FulfillmentEvidence：商品/规格显示名（订单快照优先）、订单状态、deadline、band=due_soon|overdue；不含邮箱、购买资料、交付内容、内部备注。
- SLA/库存分组：`items, matchedTotal, truncated, evaluatedAt, status=complete|failed`。complete 指该组查询成功，是否超出显示上限由 truncated 表达。
- urgentTotal 为 SLA 与售罄完整计数之和；任一计数失败则为 null，另返回 urgentKnownCount。失败组不能被当成 0。
- 草稿响应：`results`（每个已扫描 ID 的 match/clear/unknown/ineligible 及安全结果）、`scannedCount`、`failedProductIds`、`nextBeforeProductId`、`hasMore`、`evaluatedAt`。失败重试走单事项接口，不重新扫描整批；unknown 不计入成功检查数量。
- 草稿只展示“本轮检查 X 个、发现 Y 项、有/无下一批”；不提供未经全量检查的全店缺项总数。不同请求不声称具有一致历史快照。
- 参数错误 400，权限错误沿原链；整个数据请求不可用返回 503；分组失败可带 failed 状态返回仍可用的分组。
- HTTP `Cache-Control: no-store`；服务端首期不做跨请求事实缓存。轮询沿现有限流体系约束。

## 7. 数据读取与数量上限

SLA 和库存按数据库条件过滤、排序、计数，一次最多返回 200 条匹配记录；分别处理，不对两组先混合 LIMIT。不能先取 200 个任意商品再在内存筛选，否则可能漏掉紧急事项。

数据与 matchedTotal 使用同一条件，需要一致时使用短只读事务。超过 200 条返回 truncated=true 并明确提示原管理页入口；V1 不实现后续分页。售罄单独查询，不会因普通低库存占满 availability 的返回空间而隐藏。

即时库存只聚合 available 数量，不读取内容，避免每规格一个 count 的 N+1。按优先级只展示首页前 3 条紧急卡片时，紧急总数仍使用完整计数，不使用数组长度。

草稿：按 merchantId、draft、archivedAt=null、id < beforeProductId 查询，id 降序；最多读 21 个候选判断 hasMore，只对前 20 个执行 readiness，并发上限 4。nextBeforeProductId 使用本批最后一个被扫描的 ID，包括检查失败的候选；失败 ID 显式返回以便独立重试。新草稿在下次刷新第一批时纳入。

草稿可能在分页期间被删除、发布或修改，因此结果是逐次观察，不是全量扫描快照。单个失败保留旧卡片并标记待刷新，其他产品继续；没有匹配但 hasMore 或 failedProductIds 非空时不能显示“全店没有事项”。

### 7.1 时间戳注意事项

`Order.fulfillmentDeadline` 是 UTC 约定存储的 `timestamp without time zone`，不是 timestamptz。优先使用 Prisma 查询构造器；原始 SQL 中若将 JavaScript Date 作为参数，必须显式归一到 UTC 无时区时间戳再比较，例如：

```sql
"fulfillmentDeadline" < (${now}::timestamptz AT TIME ZONE 'UTC')
```

这是 Prisma 参数化模板示意，不是字符串拼接。参考 `server/src/modules/merchandising/ranking/compute.ts` 对 createdAt 的处理，临期上下界同样转换。不得依赖连接会话 TimeZone，也不得把 UTC 存储值再次误当上海本地时间。

## 8. 深链接与现有动作

以下新增查询参数是本期实现任务，并非已经存在：

| 动作 | 路径 / 约定 |
| --- | --- |
| 完善草稿 | `/merchant/products/:id/edit?focus=:target&offerId=:offerId`；target 取下表封闭枚举，offerId 仅规格目标需要；默认 publication |
| 查看订单 | 现有 `/merchant/orders/:id`；显示现有 allowedActions，不自动点击 |
| 管理规格可售量 | `/merchant?availabilityProductId=:productId&offerId=:offerId`；按 ID 加载自有商品并打开原可售量对话框 |

### 8.1 缺项代码 → 导航位置

| code | 导航目标 / 用户提示 |
| --- | --- |
| COVER_REQUIRED | 编辑页 `focus=images`，商品封面区 |
| PURCHASE_NOTES_REQUIRED | 编辑页 `focus=purchase-notes`，购买须知 |
| AFTER_SALES_REQUIRED | 编辑页 `focus=after-sales`，售后说明 |
| TEMPLATE_FIELDS_REQUIRED | offerId=null → `focus=attributes` 商品参数；offerId 非空 → `focus=offers&offerId=...` 对应规格参数 |
| OFFER_NOT_SELLABLE | 经当前配置确认属于本地库存/名额不足且有适用操作时 → 可售量对话框并定位 offerId；无启用规格（offerId=null）、规格配置无效或无适用可售量操作 → 编辑页 `focus=offers`，定位对应规格（若有） |
| FULFILLMENT_CONFIG_INVALID | 编辑页 `focus=offers`，定位 offerId 对应规格的交付配置；同时显示只读缺项提示 |
| CATEGORY_INACTIVE | 编辑页 `focus=category`；“更换分类或联系平台”，不提供激活平台分类的动作 |
| EXTERNAL_IDENTITY_INVALID | 编辑页 `focus=offers` 定位对应规格；“检查配置，必要时联系平台”，不提供修改外部身份/平台凭据的快捷动作 |
| 未知 code 或目标无法解析 | 编辑页 `focus=publication`，显示发布检查列表，不猜测路径 |

`OFFER_NOT_SELLABLE` 在现有检查器中包含“无启用规格”“配置无效”“配置有效但无可售量”三种来源，不能只凭代码一律跳库存。实施时复用/提取检查器现有的规格评估逻辑，返回封闭导航提示；不复制一套发布判定、不修改发布错误语义、不解析 reason 文案。如果无法可靠区分，安全回退规格编辑区。

一张草稿卡片仍只有一个主要操作：有多个缺项时进入 publication 总览，各缺项旁提供对应定位链接；只有一个缺项时可直接使用其导航目标。返回目标页面后重新读取，不以旧检查结果跳过权限或发布检查。

库存深链接不能依赖商品恰好在当前分页中。对话框需增加初始 offerId 支持；规格不属于商品或不存在时提示不可用，禁止回退默认规格后让用户误操作。关闭后清除本功能参数，保留其他查询参数。

字段路径只映射到已登记的编辑区，不直接用于 CSS 选择器、HTML、URL 或脚本。未知 field 回退发布检查区。进入目的页面重新获取资源；现有 CAS、readiness、权限和各接口原有校验仍是权威，本方案不假定所有写接口都已有同一种幂等或版本机制。

商品 AI 助手已合并且可用时，用户在编辑页自行调用；卡片不自动启动模型、不携带模型生成结果、不重复预填交易字段。

## 9. 与现有提醒的关系

- `LowStockNotice` 和 `SlaReminder` 仍仅表达现有邮件发送事实；不拿它们当待办已完成记录。
- V1 不写 Notification、不发送新的邮件或站内信，不扩展 SSE。
- 提取共用库存纯判定逻辑可以作为后续重构；本期不为复用改动邮件发送、去重或冷却行为。
- 商家暂停/停用后，下次请求沿现有权限链拒绝并清空该会话卡片；页面中残留 URL 无法绕过原写接口。

## 10. 可选后续：V1.1 AI 解释

只有完成规则工作台试用、确认固定模板解释不足，才实现本节。需要单独 `merchant-workbench-explanation` Spec，依赖已合并 AI Foundation；本节是明确的接口方向，不是本期模型功能验收承诺。

### 10.1 产品边界

卡片按钮“解释这条待办”按需生成，失败保留规则卡片和主要操作。不是聊天窗口、不自动调用、不能替用户选择处理方案。

模型只解释“为什么这类事项值得处理、到哪个页面核查”。未知业务原因必须保持未知。对低库存不推断热销，对超时不编造处理进展，对草稿缺项不承诺发布成功。

### 10.2 最小模型输入与输出

- 服务端先重新鉴权及重算单事项，再 `buildWorkbenchExplanationAiContext`。
- 输入仅包含规则枚举、临期/超时/低位档位、缺项代码、封闭 action 枚举和平台编写的固定帮助文本。
- 不传商品名、描述、用户文本、订单/商家 ID、价格、库存数、期限具体时间、联系方式、付费交付内容、内部备注或上游错误原文。
- 数字、资源显示名和具体期限仍由服务端在卡片中渲染，模型文字不承载。
- 结构化输出建议 `{explanation: string, checks: string[]}`；explanation 最多 200 字、checks 最多 3 项且每项最多 80 字；无 URL、HTML、动作参数或任意工具。
- 后校验至少拒绝金额/数量/期限/退款承诺、新的业务事实、外链和可执行标记。校验不是语义正确证明，L3 必须核查无依据因果与误导性操作。
- 响应仅在组件内存保留；事项证据变化或关闭后丢弃，不入日志、数据库、浏览器持久存储。

### 10.3 基础设施改动必须显式列入独立 Spec

复用 `runAiGeneration`，但现有 feature/target/配额是商品 Copilot 专用，不能直接冒用。拟新增 feature=`merchant_workbench_explanation`、targetType=`merchant_workbench`，targetId 用当前 actor ID 限制同用户同时解释；独立 merchant 配额默认 0、独立 feature flag。须同步运行时类型、数据库 CHECK 迁移、配置界面和审计测试。

单次一个模型调用，不重试、不换模型；不引入 Agent SDK 或工具循环；失败消耗配额与否沿 Foundation 定义。不扩大 AI 输出保存规则，也不复用完整商品/订单 Projection。

### 10.4 是否启用的判断

先用规则模板完成试点。若商家反复需要解释相同术语，优先完善固定帮助。只有个性化组织说明明显减少理解成本时才开放 AI；调用次数不作为价值指标。

## 11. 可选后续：V1.2 离线巡检

触发条件：商家确实需要未登录时发现草稿问题/日报，或按需 readiness 检查成本影响页面体验。实施前另立 Spec，不能静默把 V1 GET 改为写快照接口。

可复用本期纯判定器，新增确定性 finding/scan 表；后台按 merchantId 分片、游标遍历，使用 `cronLease` 和心跳。须定义 runId、扫描完整性、部分失败保留旧结果、故障重试、归属变更、恢复后再次触发的 episode、保留期限和事实过期机制。

“本轮没扫描到”不能等于“问题已解决”。临期事项应采用短周期或事件加定时兜底，不能只每天一次。若新增通知渠道，先定义与原邮件的去重和订阅关系。仍不后台批量调用模型。

## 12. 开关、观测与回退

拟新增 `MERCHANT_WORKBENCH_ENABLED=false`，在服务端 config Zod 和 `.env.example` 登记。关闭时新端点 404；不改 `/me` 响应，不新增 capabilities 字段，也不配置独立 Vite 开关。

已激活商家首次进入相关页面先请求轻量 `/workbench/urgent`；200 时显示入口并继续加载普通库存和首批草稿，404 时隐藏入口并停止本轮加载/轮询。直接进入工作台遇到此 404，显示功能暂不可用与返回商家后台入口。

只有无资源 ID 的集合端点 404 才可用于判断模块不可用；单事项 404 只是资源不可用，不关闭整个功能。401/403 走原会话/权限处理；网络错误和 5xx 显示失败可重试，不当作开关关闭。关闭后只在下一次页面进入或有效焦点事件重新探测（至少间隔 30 秒），不在 60 秒定时器中持续探测；不永久缓存关闭状态。

新工作台不修改 `/stats` 字段及含义。可以和原统计请求并行，工作台失败不能阻塞统计与商品/订单页面。

最小指标：各规则读取次数/耗时/失败数、扫描草稿数、各组返回截断次数。指标标签只含规则与有限结果枚举，禁止 merchantId/productId/用户文本等高基数标签。日志只记 requestId、规则码、错误码及耗时，不记录 DTO 和模型文本。

V1 不为埋点新增事件明细表；效果评估以试点任务观察和聚合指标为主。不能把事项消失都归因于卡片，也不能把点击当作完成。

## 13. 验收标准

| 编号 | 必须验证的结果 | 主要证据层 |
| --- | --- | --- |
| AC01 | 非 active 商家不可访问；伪造目标 ID 无跨商家读取能力 | 后端集成 |
| AC02 | 即时库存按 available 条目、限量按 stock；无限量/外部集成规格不参与 | 判定单测 + 数据库集成 |
| AC03 | active/draft/归档/规格状态切换后卡片按规则出现或消失 | 后端集成 |
| AC04 | deadline=null、deadline=now 属临期、deadline<now 属超时、24h 边界和终态正确；数据库 UTC/Asia-Shanghai 会话查询一致 | 单测 + 集成 |
| AC05 | SLA 和售罄总数不被显示上限截断；每组超过 200 条明确提示，并能进入原管理页 | 后端 + 组件 |
| AC06 | readiness 使用与发布相同默认参数；缺项映射覆盖全部代码及 OFFER_NOT_SELLABLE 多来源，失败返回 unknown | 后端单测 |
| AC07 | 超过 20 个草稿时正确显示覆盖范围和继续扫描；后续页资源不被静默遗漏 | 后端 + 组件 |
| AC08 | 多次定时刷新仅请求 urgent；readiness 调用数为 0，首次/焦点/继续检查/单项重验符合 §3.2 | 组件 + 后端集成 |
| AC09 | 深链接加载精确资源与规格；无效 offer 不落回默认规格；打开不触发写入 | 组件 + 浏览器冒烟 |
| AC10 | 工作台 DTO 不传出卡密、购买资料、邮箱、内部备注；readiness 内部既有读取不得外泄，白名单哨兵断言 | 后端集成 |
| AC11 | 刷新丢弃旧响应；注销/切账号清空；局部失败与空状态可区分 | 组件 |
| AC12 | 原库存邮件、SLA 邮件、订单操作及编辑保存回归通过 | 现有针对性测试 |
| AC13 | 集合端点 404 隐藏入口；200 正常展示；5xx/网络失败显示部分事项暂未检查且不隐藏入口；单事项 404 不关闭模块 | 集成 + 组件 |
| AC14 | 本期不存在 provider 调用、工作台迁移/写接口、Notification 写入或业务执行工具 | 代码审查 + 集成 spy |

浏览器只新增至多一条“工作台 → 精确规格 → 返回刷新”的冒烟，验证路由/对话框定位；真实库存写入和高危旅程仍由现有覆盖承担。遵守 `docs/testing-policy.md`，不为每项 AC 新增 E2E。

开发样本至少覆盖 2 个商家、25 个草稿、多规格商品、0/低/高库存、外部集成、pending/processing/终态订单、空 deadline、权限变化、201 条库存/SLA 匹配项以及多标签页轮询。性能用接近实际规模的合成数据测量后决定索引，不声明未经测量的响应时间保证。

## 14. 试点与后续决策

1. 开关关闭部署，完成开发/预发验收。
2. 先由内部测试商家验证三种真实操作；不因旧版 AI eval 通过跳过本功能验收。
3. 小范围试用至少一周，收集“这条是否需要处理、能否到达正确位置、是否重复/错误、完成耗时”的任务记录。
4. 硬门槛：跨商家泄露、错误规格操作、未经确认业务写入为 0；发现即关闭本功能并修复。
5. 业务判断：若多数卡片只是重复现有信息，应改入口/排序；若规则误报，先改口径；若规则有用但文字难懂，再评估 V1.1。

未取得生产基线前，不承诺成交提升或节省百分比；商家数量、访问量、订单量不从仓库代码推断。

## 15. 协作与后续路线

本方案由新工作台模块承担，不修改另一个 Agent 正在开发的草稿生成、文案校验和 provider 代码。接入 AI 功能前必须以其最终合并版本为准。

后续优先候选：履约进度起草、订单排障摘要。争议起草单独评审，因为 `respondToOrderDispute` 的 close 分支涉及状态与冻结积分结算，不能当普通消息提交。浏览/成交诊断需先补齐样本门槛与统计口径，售罄预测需区分库存和容量语义。

## 16. 外部参考

以下引用沿用 2026-10-07 已完成的网页核查，仅用于设计参考，不作为 MoNexus 收益或实现状态证据。

- [Shopify Sidekick Pulse](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/pulse)：最多 5 条主动建议、逐项批准、忽略与反馈。借鉴卡片和操作衔接，不照搬其数据规模或模型研究流程。
- [Amazon Alexa for Shopping](https://www.aboutamazon.com/news/retail/alexa-for-shopping-ai-assistant)（2026-05-13）：区分通知/加购物车/自动购买等不同授权形态；本项目不采用自动购买。
- [Walmart All in on Agents](https://tech.walmart.com/content/walmart-global-tech/en_us/blog/post/all-in-on-agents.html)（2025-07-24）：按消费者、员工、合作伙伴、开发者职责划分；本项目先明确单一商家工作流。

## 17. 修订记录

- 0.2.0（2026-10-07）：按实施前评审统一 SLA 严格小于边界；补齐发布参数及缺项导航；拆分紧急轮询和按需草稿检查；移除 V1 暂缓/持久化；用集合端点 404 探测能力；库存/SLA 改为每组 200 条上限；补充无时区时间戳 SQL 约定。文档迁入从本地 develop（ffc7546）建立的独立分支 `feat/merchant-workbench`。
- 0.2.1（2026-10-07）：AC13 显式区分集合 404/200/5xx 与单事项 404；PR1 实现完成，详见 [验证记录](./merchant-workbench-pr1-verification.md)。
