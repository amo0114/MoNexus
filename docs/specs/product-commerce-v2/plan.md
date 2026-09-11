# 商品改造实施计划：单 agent 顺序交付

| 项目 | 值 |
|---|---|
| 关联规格 | [SPEC-PRODUCT-COMMERCE-002 v1.0.0](spec.md) |
| 状态 | 待实施；本文任何检查项均未被预先标记通过 |
| 固定执行模式 | **一个实施 agent，一个实现 worktree，一个功能分支，顺序提交，一个实现 PR** |
| 交付审阅 | Owner 在实现完成后交主代理 review；实施 agent 不自行 merge/release/deploy |

## 1. 开工与 Git 规则

先读取本规格、模板 JSON、页面原型、仓库 AGENTS.md、`docs/testing-policy.md`、`docs/branching-and-ci.md`。旧六件套和 phase 文档只用来理解既有不变量，不继承其多人并行执行要求。不要自行重新规划成“前端 agent + 后端 agent”。

文档先经 Owner review 后进入 develop，随后只从包含已确认文档的 develop 创建实现分支：

```bash
git fetch origin
git worktree add -b feat/product-commerce-v2 ../MoNexus-product-commerce-v2 origin/develop
```

在新 worktree 核对 `git status --short --branch` 和 `git log -1 --oneline`，确认 `docs/specs/product-commerce-v2/spec.md` 存在且版本正确。缺少已确认规格时不得从旧代码猜做。不要修改原工作区、其他 worktree 或受保护分支。

- 下列 P1→P8 全由**同一个实施 agent**按序完成；阶段间是提交和检查点，不是需要 Owner 逐次批准的暂停点。
- 不为不同层分别建分支，不 cherry-pick 多条并行 lane；最终只提 `feat/product-commerce-v2 → develop` 一个 PR。
- 保留阶段提交便于 review；修复提交说明实际问题，禁空提交、`[skip ci]` 和重写他人提交。
- develop 前进时在工作区干净后合并最新 origin/develop，解决冲突后只重跑受影响检查。不能把共享文件冲突全选 ours/theirs。
- 本地环境用专用测试库；不连生产库，不复制真实密钥/买家数据，不提交 `.env` 或生成的数据库备份。
- 使用现有 Node20/npm10、npm ci、Prisma migrate 工作流；禁止 `prisma db push` 或修改已发布迁移。
- 实施过程中同一 agent 可以换会话，但必须先读上一阶段 commit diff 和本计划当前位置，不靠对话记忆改变契约。不新增交接册，直接在 PR 描述维护阶段进度与真实限制。

## 2. 顺序与阶段产物

```text
P1 模板与数据基础
 → P2 内容/套餐/平台经营 API 与订单快照
 → P3 可见性与登录回跳（前后端闭环）
 → P4 平台保障（前后端闭环）
 → P5 发布编辑器、七模板、Xboard 介绍（前后端闭环）
 → P6 详情页与复制短链（前后端闭环）
 → P7 履约策略整理与统一交付卡
 → P8 管理员版本、迁移收口与最终集成
 → Owner/主代理 review → 修复 → 合入 develop → 另行发布流程
```

P7 放在新行为基本就绪之后，避免同时重排订单核心和发明新契约。P1/P2 中必须为新字段补最小写/读与交易快照支持；P7 仅整理已存在的路径并接线交付 UI。

## 3. P1：模板、领域类型与迁移基础

**职责**：固定类型和持久化边界，让后续表单/API 使用同一份契约。

重点文件：

- `server/prisma/schema.prisma` 与新 migration；
- `server/src/modules/catalog/contracts.ts`、`constants.ts`；
- 新 `server/src/modules/catalog/templates/`；
- `src/types/catalog.ts` 与 `src/api/catalog.ts`；
- 两端 package/lock（仅必要依赖）。

步骤：

1. 点验 schema 当前 Product、Offer、Order、DeliveryFile、ExternalCatalogLink；把相对基线变化记入 PR，不改既有关系语义。
2. 按 spec §3/7/8 增量建列/表/索引。保障、短链、版本都不得混入 SystemConfig 通用 JSON 桶。
3. 迁移存量全为 members_only；不按分类自动推断账号独享/共享；Xboard 只根据明确关联识别。保持历史订单快照为 null。
4. 平台文件归属扩展时旧记录未知 actor 保持 null，新上传记录真实操作者；不把商家所有者冒充历史上传者。检查文件/订单/库存计数、外键与平台 actor CHECK 一致。
5. 复制冻结 templates.json 到运行时 registry，Ajv 编译两类属性 schema；草稿校验与发布校验从同一份定义派生。
6. 增加公开 registry endpoint；前端 adapter 返回明确类型，不引入 any。控件类型采用有限映射，不允许远程 schema 或表达式执行。
7. 落实 spec §4.2 的 fulfillmentRules 与纯 resolveFulfillmentStrategy，覆盖合法组合及冲突；只定义选择与发布校验，不移动订单执行分支。P2 写入和 P5 表单直接复用，P7 不再发明第二套判定。

检查点：

- 七个实例例子通过对应 schema；未知字段/错误枚举拒绝；草稿允许缺必填但拒绝错误类型。
- PostgreSQL 空库和基线升级 fixture 的 migrate deploy；最终 schema无漂移。
- 文件、订单、库存原数据与关联未减少；模板空值/保障未授权/旧快照均保持诚实。

提交建议：`feat(catalog): add versioned product templates and content schema`。

## 4. P2：商品写入、套餐、平台文件与交易条款

**职责**：实现统一的内容保存和完整平台经营能力，为后续页面提供真实 API。

重点文件：

- `server/src/modules/merchant/{schema,service,routes,controller}.ts`；
- `server/src/modules/admin/{schema,service,routes,controller,offerAdmin}.ts`；
- `server/src/modules/catalog/{contentSanitizer,publicationReadiness,productPublication}.ts`；
- `server/src/modules/uploads/deliveryFileRoutes.ts`；
- `server/src/lib/{offers,deliveryFields}.ts`；
- `server/src/modules/{orders,checkout}/` 与原订单幂等 helper。

步骤：

1. 升级原 create endpoints：识别 editorVersion=2 严格 DTO；旧 DTO 在边界有限适配。内部只用 CreateProductCommand，不能 `prisma.product.create({data:req.body})`。
2. 创建原子写 Product+全部 Offer，不导入秘密库存/名额；返回真实 ID 供后续可售资源步骤使用。
3. 内容 PATCH 使用 product lock + contentVersion CAS；省略/清空/整体替换语义严格按 spec，旧 PUT 同样净化并增版本。
4. 对 active 保存执行完整参数校验；对 draft 仅检查已填字段合法性；发布仍执行权威 readiness。
5. 增加 editor DTO，分别剥离无权限字段；商家读不到平台文件、他人秘密或管理员审核备注。
6. 普通平台 Offer create/edit 补齐；继续限制 Xboard 身份编辑到既有专用工作流。
7. 扩展文件上传角色与资源归属；复用原流式处理、注册、provider绑定、锁和GC。不要把已有商家文件的 null判断改成通配授权。
8. 完成平台人工订单 start/progress/deliver/reject；复用原交易和状态函数，actor必须为admin；不伪造商家账号。
9. 共享固定结构化交付在边界生成唯一 canonical fixedContent，随订单冻结；清洗/授权不能依赖前端。
10. 结算预览和确认加内容/保障版本；固定内容、文件、attributes、表单与授权变化必须触发重确认。按 spec §3.3 统一 Product/Offer 锁顺序和条款判断时间；新字段显式传入才扩展请求指纹，旧请求摘要字节保持不变，复用 completed 重放。

检查点：

- 复用 `catalog/publicationRoutes.test.ts`、`catalog/adminPublicationRoutes.test.ts`、原 merchant/offers/orders 集成覆盖。
- content CAS 同版本两次写最多一次成功；订单与内容修改竞争不产生错误快照。此阶段保障只验证空值/已有 fixture 投影，保障真实写路径的竞争在 P4 完成后验证。
- 访问他人文件/修改受保护字段失败，数据库没有部分写入。
- 原即时扣积分/人工冻结/退款回补/文件历史快照/外部任务行为未退化。

提交分两次：`feat(catalog): unify product editing and platform offer management`；`feat(orders): snapshot product terms and support platform fulfillment`。不要为了切两次提交让中间提交无法编译。

## 5. P3：商品可见性与会话回跳

**职责**：在开放游客页面之前，先封住所有读出口，再形成真实浏览旅程。

重点文件：

- `server/src/middlewares/auth.ts`、`server/src/app.ts`；
- `server/src/modules/products/{routes,controller,service,cache}.ts`；
- `server/src/modules/reviews/service.ts`；
- `server/src/modules/merchandising/promotions/publicSponsored.ts`、`editorial/publicShelf.ts`；
- `src/{App,pages/StorePage,pages/LoginPage,pages/ProductDetailPage}.tsx`；
- `src/components/Layout.tsx`、相关 auth/store 缓存。

步骤：

1. 复用 optional auth 并解析当前有效 audience；过期/禁用凭据不要转成会员或悄悄匿名。
2. 把访问谓词用于 SQL排名/筛选、ORM详情、评论、推荐候选和缓存发送前检查；不要只在 DTO 最后删字段。
3. 缓存 key/cursor 加 audience，响应 no-store；退出/身份失效清理前端会员缓存。
4. 公开 Layout 去掉对未登录用户的余额/通知请求；只有商城/详情可匿名，其它受保护页面保持角色边界。
5. 添加安全 returnTo；登录/注册/中间身份步骤完成后重读商品与套餐。无效目标回首页；禁止外站跳转。
6. 锁定详情页面无标题/图片/评论闪现；接口403由商品页处理为登录状态，不触发无意义循环刷新。

检查点：

- 先用登录响应暖缓存，再游客读所有出口；反向暖缓存；public→members_only、下架、商家封禁后重新读取。
- reviews 必须受商品权限限制；仅清详情缓存不算通过。
- 退出后 back/列表缓存不恢复会员数据；导航回跳不接受外站/协议相对路径。
- 在既有 catalog/checkout E2E 中补一条游客浏览→登录回跳→兑换旅程，其余矩阵下沉集成/组件。

提交：`feat(catalog): enforce product audience visibility and login return`。

## 6. P4：商品保障申请与管理员授权

**职责**：实现真实授权状态、审核和页面投影。

重点文件：保障领域放在 `server/src/modules/catalog/assurance/`，与现有 merchandising entitlement 区分；复用 AdminLog/权限/商品锁。前端位于现有 merchant/admin 商品管理区域，公共投影在 products/merchandising 接线。

步骤：

1. 实现申请/撤回/审核/直接授权/撤销，使用 partial unique 与 Product行锁，过期读取按数据库当前时间判断。
2. 申请批准必须同事务改状态、建grant、写审计；expiry关闭不伪装成管理员撤销。
3. 商品编辑页提供申请状态与动作；管理员提供申请列表及商品级授权；不提供自选认证checkbox。
4. 消费者展示经营身份、合作伙伴和保障，三个来源不能互相推导；清理详情静态认证/直营保障文案。
5. checkout读取实时有效grant并快照policyText；撤销影响新成交，旧单继续显示历史条款。

检查点：重复申请、双管理员批准、授予与撤销/下架竞争、过期不展示、越权请求、历史订单不变；在本阶段补齐订单创建与保障授予/撤销的真实并发检查，复用 P2 快照覆盖。使用真实PG集成证明审计与状态原子性，UI只做状态/可操作性组件检查。

提交：`feat(catalog): add product assurance applications and grants`。

## 7. P5：七模板发布编辑器与 Xboard 内容

**职责**：把后台 API 变成商家/管理员可以完整操作的页面。

重点文件：现有 ProductCreateWizard、MerchantProductFormModal、AdminPlatformProductWizard、AdminProductEditDialog、AdminOfferManagerModal、PurchaseFormFieldsEditor、ProductImageUploader、FakaImportPreview、FakaSyncDialog；新增共用内容编辑组件时按职责命名，不再叠一套同义modal。

步骤：

1. 七模板由 registry 驱动参数控件；公共内容、套餐、购买资料、可售资源是固定工作流模块。
2. 创建与编辑共享字段组件；mapper明确分离属性/秘密交付/表单答案；一次发布前所见字段与server schema一致。
3. 引入按需加载的图文编辑器。工具栏与媒体操作按 spec §5，不宣称Markdown支持；预览与详情使用同一净化和展示组件。
4. 实现独立创建/编辑路由，现有入口全部接线。编辑dirty-state、上传保留、草稿成功与库存失败分开提示。
5. 可售资源只操作明确 Offer；新建商品保存后再导入库存/容量。平台文件、普通套餐、人工服务的入口必须真实可用。
6. Xboard导入默认subscription+members_only；现有发布结果态保留。技术ID与外部SKU进入折叠区域，不让商家手填内部标识。
7. 介绍preview/apply分离，双hash重验、Product CAS、fields选择覆盖；增量容量同步不能改文案或accepted hash。
8. 新模板发布与active编辑检查按 spec，legacy提示不自动清空旧字段。

检查点：

- 组件测试：模板必填与输入、按形态展示交付配置、旧数据载入、清空/省略语义、编辑冲突保留输入。
- 净化测试覆盖三种actor来源、粘贴脚本/外部图片、平台图失效、纯文本转义。
- Faka现有preview/confirm/sync测试扩展内容观察/手动采纳；保护sourceHash与SKU能力。
- 浏览器检查320/390与桌面下完整编辑路径；不为固定CSS class或文案每行写E2E。

提交：`feat(catalog): build schema-driven product editor`；`feat(xboard): add explicit source description adoption`。

## 8. P6：详情页、分享与短链

**职责**：交付真实的消费者详情和复制分享流程，连接指定短链服务。

重点文件：ProductDetailPage、现有图集/灯箱/购买组件、products公开DTO；新增 `server/src/modules/products/shareLinks.ts` 和一个 `server/src/lib/shortlinkClient.ts`（单一provider），新配置沿用 config 与环境模板。

步骤：

1. 按 spec §10 和原型调整首屏、购买卡、参数区、说明区和移动底栏，保留图集交互与购买确认。
2. 公共DTO只投影允许展示的属性，不包含固定内容/文件key/Xboard源快照。模板未知时保留基本内容。
3. 分享服务按product唯一行领取短租约，网络在事务外；ready复用，租约竞争/超时/迟到CAS行为固定。
4. 短链client严格使用已核实admin API：服务账号登录、内存token、401仅一次更新，业务code校验、返回origin/gid/短域名路径核验。
5. 剪贴板成功必须以真实writeText成功为准，拒绝则展示可手动选择文本。会员商品分享文案保持通用。
6. active售罄可分享，下架不可新分享；短链故障不影响结算；不回退复制长域名。

检查点：

- 单元/假服务：正确响应、HTTP200业务失败、401更新一次、超时、错域名/路径/origin/gid、缺配置。
- 真实PG：并发只发布一个canonical结果、过期claim接管、迟到结果不覆盖。
- 组件：复制链接/文字差异、所选套餐价格、锁定商品文本、剪贴板失败不报成功。
- 真实shortlink环境未准备时标注“未联调”，不删除该验收项。联调时只创建测试商品短链，不使用生产秘密。

提交：`feat(store): redesign product detail and add stable short-link sharing`。

## 9. P7：履约策略整理与交付 UI 收口

**职责**：用有限策略结构整理已有路径，不发明新交易引擎。

步骤：

1. 复用 P1 已完成的纯 resolver 与合法组合测试，核对当前执行分支可逐一映射；不重写规则或新增相同测试。
2. 小步提取现有库存、固定、人工、webhook、Faka分支；仍用原tx对象和原worker，禁止移动资金写入顺序来“美化架构”。
3. 新共享固定结构化内容只在原固定交付分支增加规范化快照，不改InventoryItem去重算法。
4. 共用DeliveryContent选择器接入购买结果和订单详情，复用已有文件卡/结构化卡/订阅结果/进度时间线；原始权限DTO仍为真相。
5. 日期预约页面显示“期望服务日期”，不渲染slot库存或生成假的核销功能；订阅没有上游到期信息时不凭本地文案生成到期事实。

检查点：原库存并发、checkout幂等、固定文件、结构化交付、人工进度/验收、续费、Faka任务与手工交付竞争的受影响测试。选定原测试通过后停止；不为每个handler写逐行镜像测试。

提交：`refactor(fulfillment): organize existing delivery strategies`；UI接线若较大另提交 `feat(orders): unify authorized delivery presentation`。

## 10. P8：管理员版本与集成收口

**职责**：补真实运行版本，完成权限/迁移/响应式与PR准备。

步骤：

1. 在现有构建流程生成API镜像内build-info，根package版本为唯一来源，两包发行版本同步校验；tag/package不符构建失败。
2. 新admin build-info接口严格MFA，no-store；无产物返回unavailable，不能从工作目录或远端GitHub凑信息。
3. 系统设置增加系统信息页；普通用户/商家不显示，不在公开健康接口、VITE变量或页脚泄漏。
4. 汇总迁移升级fixture，验证无历史数据丢失；新增字段和保障历史影响purge时回到归档路径。
5. 检查所有旧创建/编辑入口已接到新页面；标明一个发行窗口的旧create兼容退出条件。
6. 执行本阶段受影响检查与前后端build；已在同一代码状态通过的阶段测试可复用，不全量再跑一遍。
7. 开实现PR到develop，打run-e2e，等待CI OK与必要CI集成结果；不merge。Owner将PR交主代理review后再按发现修复。

提交：`feat(admin): expose authenticated build version information`；必要集成修复按实际问题命名。

## 11. 可执行验证入口

以下为选择方式，不要求每阶段全部运行。先确认现有测试文件名，若某场景已覆盖，只引用/调整既有测试。

```bash
# 后端：限定受影响文件（需要专用测试PostgreSQL）
cd server
npm test -- src/modules/catalog/publicationRoutes.test.ts src/modules/catalog/fakaPreviewConfirm.test.ts

# 前端：纯组件与逻辑，不启动数据库
cd ..
npm test -- src/pages/merchant/ProductCreateWizard.test.tsx

# 类型/生产构建（阶段写入层已变化时选择）
npm run build
npm --prefix server run build

# 复用受变更影响的快速检查入口
npm run verify:quick
```

新增行为测试归入对应模块，不按P1/P2命名不断追加 regression 文件。新增鉴权与交易竞争测试用真实PG；纯schema/文案投影/组件无需启动DB。E2E采用现有配置和fixture，新增浏览旅程优先合入 `e2e/catalog-product-lifecycle.spec.ts` / `e2e/checkout-confirmation.spec.ts`，不要另建suite配置。

本地浏览器视觉检查使用示例数据，不能靠修改生产fixture或者删断言让检查通过。320px、390px、768px、1024px、1440px与200%缩放，重点检查首屏、套餐切换、编辑器、软键盘、sticky购买栏和source对比。

## 12. 最终 review 抓手

在PR描述中提供简洁真实记录，不另写验收矩阵或重复报告：

- 对应spec版本与基线；实现了哪些最终行为。
- 阶段commit及关键入口，方便按数据/访问/保障/编辑/分享/交付/版本审阅。
- 实际执行的测试命令与结果；未执行项目及原因（尤其真实shortlink/TLS、生产镜像和真实移动浏览器）。
- 迁移影响与回退限制；是否已产生旧版本不能理解的新交付数据。
- 任何与spec不一致的地方写明，并先修订契约，不能在PR末尾称“全部完成”掩盖偏差。

主代理review至少点验：

1. JSON Schema没有被商家变成任意逻辑输入；没有双份默认值/必填规则漂移。
2. 后端所有商品读出口与缓存有可见性隔离；分享和登录没有泄漏名称或开放重定向。
3. 授权并发、订单条款快照和撤销语义一致。
4. Xboard手工正文不会被容量同步覆盖；远端I/O不进入订单或内容写事务。
5. 平台文件/人工订单确实能履约，商家资源隔离没有因nullable归属退化。
6. 短链不是每次新建，错误没有伪成功；provider协议与真实部署一致。
7. 策略整理没有拆坏积分/库存/outbox事务，交付卡不会读当前商品重解释历史。
8. 版本取自运行构建，tag与包版本规范，用户/商家不能读取管理员接口。

只有这些已完成、选定检查与CI通过、未解决问题如实记录后，才交Owner进入合并评审；**不得把“文档已写”或“mock测试通过”写成生产能力已验证。**
