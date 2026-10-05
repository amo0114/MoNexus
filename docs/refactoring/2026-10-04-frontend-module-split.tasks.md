# 前端大文件拆分任务书与 Review 交付约定

日期：2026-10-04。对象：负责后续实施的 agent。本文只授权下述前端结构重构，不是视觉改版或业务规则调整任务。

## 1. 目标与完成标准

把混在页面中的表单、列表、弹窗、展示区块移到明确的组件边界，使后续修改可以局部理解、局部验证。每个任务独立提交，保留拆分前的行为、外观和接口契约。

完成标准：任务指定的职责已分离；剩余编排有清晰理由；相关验证有可复核结果；提交可以独立 review。**没有文件行数达标要求，也不以减少 useState 数量作为验收。**

执行顺序：R00 → R01 → R02 → R03 → R04 → R05 → R06 → R07 → R08 → R09a–d → R10 → R11 → R12。R01–R04 优先，R11–R12 最后。每项验收通过后可继续下一项，无须逐项请求批准；实际无法验证的项目必须标记未完成，不能用继续做其他项代替验收。

本清单属于“结构拆分”工作流。此前讨论的预算测量、路由懒加载及 CI 是另一条工作流，不对应本文任务编号，也不在本次范围内。

## 2. 现状、输入与基线

### 2.1 已完成的工作，禁止重复实施

参考提交：`20f493a88ce817af1a01ae89f89ad1394ae01f1a`，标题为 `refactor(catalog): share product delivery editors and draft logic`。

已经提取：

- `src/components/catalog/wizard/FieldLabel.tsx`。
- `src/components/catalog/wizard/DeliveryFieldsEditor.tsx`、`StructuredContentEditor.tsx`。
- `src/components/catalog/wizard/deliveryFields.ts`：序列化函数及结构化内容校验。
- `src/components/catalog/wizard/fulfillment.ts`：当前 7 种配置的显式映射。
- `src/pages/merchant/productEditor/offerDrafts.ts`：编辑页草稿转换、协调、三方合并。
- `src/utils/pickFileFromInput.ts`。

必须保留的第一批决定：

- 两页 `validateDeliveryFieldRows` 各自保留，错误提示的冒号差异不统一。
- `validateStructuredRows` 接收调用页的校验回调，不改掉两页文案差异。
- 未知履约枚举：创建页忽略未映射值；编辑页保留 `manual_service` 回退。本文不重新决策。
- 两类交付编辑器的 `create` / `edit` 差异保留，包括敏感字段控件、占位文案、类名和 test ID。
- `FieldLabel` 的 `children` / 可选 `required` 契约保持。

### 2.2 本任务书依据的是当前工作区，不只是 HEAD

当前仓库：`/root/projects/MoNexus-new`。编写任务书时 HEAD 为上述提交，分支为 `feat/nav-brand-kinetic-mx`。

工作区存在大量其他工作的未提交修改；`ProductDetailDesktop.tsx`、`ProductDetailMobile.tsx` 及配套 CSS 等文件目前还是未跟踪文件。`ProfilePage.tsx`、`ProductDetailPage.tsx`、`StorePage.tsx`、`index.css` 等也有未提交改动。

**直接从这个 HEAD 创建 worktree，并不自动得到本任务书描述的全部现状。** 不得把这些现有功能的缺失当成可删除内容，也不得在结构重构提交里重新实现它们。

文中行号和行数用于定位，实施前以实际基线的符号为准：

| 对象 | 编写时行数 | 任务 |
| --- | ---: | --- |
| `src/components/catalog/AdminCategoryManager.tsx` | 1319 | R01 |
| `src/pages/merchant/ProductCreateWizard.tsx` | 1477 | R02 |
| `src/pages/MerchantDashboardPage.tsx` | 1151 | R03 |
| `src/pages/merchant/ProductEditPage.tsx` | 1076 | R04 |
| `src/pages/ProductDetailPage.tsx` | 1303 | R05 |
| `src/components/catalog/ProductDetailDesktop.tsx` | 1150 | R06 |
| `src/components/catalog/ProductDetailMobile.tsx` | 1138 | R07 |
| `src/pages/ProfilePage.tsx` | 1012 | R08 |
| `AdminPromotionCampaignManager.tsx` / `AdminPromotionPackageManager.tsx` | 992 / 945 | R09a / R09b |
| `AdminEditorialManager.tsx` / `AdminProductPanel.tsx` | 910 / 919 | R09c / R09d |
| `src/pages/StorePage.tsx` | 1008 | R10 |
| `src/index.css` / 详情 Desktop CSS / Mobile CSS | 1599 / 1590 / 1670 | R11 |
| `AdminPromotionCampaignManager.test.tsx` | 2559 | R12 |

### 2.3 开工必读

- 仓库及目标子目录适用的 `AGENTS.md`。
- `docs/testing-policy.md`。
- `docs/branching-and-ci.md`。
- `docs/specs/product-commerce-v2/ui-redesign.plan.md`，理解交易控制器、预览白名单和发布门禁等既有约束。
- 每项即将修改的原代码，以及对应现有测试。

这次不借用旧 UI 计划实施新的视觉改动。旧文档与现有工作区存在差异时，先记录差异；结构任务保留输入基线，不顺手“纠正产品”。涉及明确契约冲突且无法等价拆分时，单列问题留给 review。

## 3. 所有任务共同遵守的边界

1. **保留外部行为**：请求路径、参数、时序、重复提交保护、权限、错误提示、空态、默认值、路由与 query string 不变。
2. **保留外观和可访问性**：DOM 层次、类名、id、test ID、ARIA 关联、表单提交关系和弹窗焦点行为不变；避免为了组件化新增布局 wrapper。
3. **状态有明确所有者**：跨步骤、跨标签共享或需要切换后保留的状态先留在原父层。只有局部状态的生命周期与原行为相同时才下沉；状态迁移单独提交。
4. 不通过新增全局 store、大 Context 或万能 `usePageState()` / `useWizardForm()` 转移复杂度。抽 hook 不等于减少重渲染；无测量证据不宣称性能提升。
5. 新组件在模块顶层定义。不要在父组件函数体内定义 React 组件；不要改变 `key` 导致输入、编辑器、弹窗反复 remount。
6. props 按职责传递数据和回调；避免 `props: any`、传入整个页面控制器对象、强行用布尔开关合并不等价表单。允许小型同领域类型文件，禁止为凑行数铺设大量转发文件。
7. 现有组件继续复用。无充分同构证据时，不跨创建/编辑、桌面/移动两套场景制造通用大组件。
8. 不修改 `server/**`、API DTO、履约规则、支付/积分规则、状态枚举、路由配置、依赖版本、锁文件、构建预算、CI 或 ESLint。R11 可调整必要 CSS 入口引用，但不改工具链。
9. 不批量格式化，不添加行数硬门槛，不降低 TypeScript 检查，不删断言、不加 skip/todo 掩盖失败。
10. 沿用现有测试优先。只针对新边界实际引入、现有测试未覆盖的风险补最少行为测试；不为每个拆出的展示组件机械新增测试或巨型快照。
11. 实施代码只在隔离工作区修改。你不是唯一修改仓库的人，不覆盖、清理、stash 或回退别人正在做的工作。

## 4. R00：建立可比较的输入基线

**交付物**：基线 commit、继承文件清单、基线验证记录。此项先于任何拆分。

步骤：

1. 记录开始时的 HEAD、分支、`git status --short`，保存已有 diff；保存未跟踪前端源文件的路径与内容哈希。不要记录凭据文件内容。
2. 建立独立分支和 worktree，分支名建议 `refactor/frontend-module-boundaries`。优先基于已经包含当前前端功能的提交。
3. 若这些功能仍未提交，从源工作区复制实际依赖的前端修改、新源文件与必要本地静态资源，在独立 worktree 创建一个**仅用于审计的输入快照提交**；该提交不算本次重构，不回写源工作区。复制前后比对哈希，防止并发修改造成混合快照。
4. 将本任务书、review 模板及适用的仓库规范一并带入实施工作区。不复制 `node_modules`、`dist`、运行数据、环境凭据、数据库备份或与此任务无关的服务器修改。对于预览所需 mock/preset 图片，只复制明确引用的文件并记录来源。
5. 记录：原 HEAD、快照基线 SHA、继承文件列表及哈希、快照与原 HEAD 的差异。后续 review 范围为“快照基线 → 重构 HEAD”，不能把输入快照算进重构 diff。
6. 在基线先运行相关组件测试及一次生产构建。已失败项记录命令、失败用例、原因和日志；不要把现存失败改名为本任务已通过。
7. 输入快照确定后，不边拆边自动同步另一个 agent 的 UI 修改；后续同步单独提交并重新确定比较范围。

Node/npm 以 `package.json` 为准：Node `>=20 <21`、npm `>=10 <11`。本机现有 Node 20 位于 `/root/.nvm/versions/node/v20.20.2/bin`；其他环境用自己的 Node 20 路径。

## 5. R01：分类管理的现有子组件外移

**拥有文件**：`src/components/catalog/AdminCategoryManager.tsx`，新增 `src/components/catalog/categoryManager/`，必要的对应测试。

定位：`CategoryFormDialog` 约 230 行；`ReviewDialog` 约 458 行；`ReorderList` 约 1269 行。

实施：

- 建议新增 `CategoryFormDialog.tsx`、`ReviewDialog.tsx`、`ReorderList.tsx`。
- 表单独占的类型、初始值、校验函数及 slug 处理随所属组件迁移；多处真实使用的类型再放 `types.ts`，不让新模块反向 import 页面。
- 保留现有 props 语义和表单初始化 effect，不改变创建/编辑重开时的默认值、封面未触碰/清空/替换三态。
- 父组件继续管理分类库和申请列表、adapter、刷新、跨操作 `busy`、停用/删除确认及审核后联动。
- 本项不进一步拆分类库和审核列表控制器；完成现成子组件迁移即可。

验收：两组筛选仍独立；错误时弹窗保持及输入保留行为不变；重复操作仍被拦截；排序提交仍针对原有全局列表语义；审核 `map_existing` 等分支不变。

验证：`src/components/catalog/AdminCategoryManager.test.tsx`；已有分类治理 E2E 使用 catalog-ops 专用配置，见 §18。表单重新打开和失败保留若没有现有覆盖，只补受迁移影响的行为用例。

建议提交：`refactor(catalog): extract category management dialogs`。

## 6. R02：创建向导按职责拆面板

**拥有文件**：`src/pages/merchant/ProductCreateWizard.tsx`，新增 `src/components/catalog/wizard/steps/`，必要的向导本地类型文件和测试。

优先定位：定价 `step === 2` 约 862 行；交付 `step === 3` 约 1066 行；附加规格循环嵌在定价区域。

分两次提交：

1. 抽 `PricingStep.tsx`、`ExtraOfferEditor.tsx`、`DeliveryStep.tsx`，使用第一批共享编辑器。附加规格行通过字段值和更新/删除回调工作，不自行调用保存 API。
2. 抽 `PresentationStep.tsx`（展示信息，约 767 行）、`DraftReviewStep.tsx`（确认草稿及买家确认预览，约 1181 行）。模板选择、可售量、发布短区域可继续内联，不强制凑成 7 个文件。

父层保留：`form`、`step`、主/附加规格草稿、模板与属性选择、上传引用、草稿 ID、校验编排、保存、发布、readiness、预览白名单构造。

跨层约定：纯类型可外移；子组件只接收其区域用到的字段与回调。不要将完整 `WizardForm` 暴露给只需少量字段的所有面板；不要把履约判定或校验复制进步骤组件。

验收：步骤往返不丢输入；附加规格增删及交付字段编辑不变；分类选择不改变交付模式；草稿重复提交不生成第二个商品；保存失败保留输入；上传引用、富文本图片引用继续进入原 payload；公开预览不接收秘密交付内容；发布仍依赖服务端就绪度。

验证：创建向导测试、管理员创建页复用测试、`LivePreviewSandbox.test.tsx`；涉及共同类型或共享模块时一并跑编辑页测试。复用生命周期、购买资料、结构化交付现有 E2E，按实际路径选择，见 §18。

建议提交：`refactor(catalog): extract wizard pricing and delivery steps`；`refactor(catalog): extract wizard presentation and draft review`。

## 7. R03：商家后台商品与订单面板

**拥有文件**：`src/pages/MerchantDashboardPage.tsx`，新增 `src/components/merchant/dashboard/`，对应测试。

定位：商品分支约 487 行，订单分支约 688 行。

第一提交，完成展示边界：

- 新增 `MerchantProductsPanel.tsx`：筛选栏、列表、分页和商品操作入口。
- 新增 `MerchantOrdersPanel.tsx`：订单筛选、预约排序、列表、分页和履约操作入口。
- 保留并复用现有库存、可售量、容量、套餐、交付、争议、进度等弹窗。仅在所有者明确时把其挂载点一起移动。
- 初次迁移保留父层已有状态和 `loadData` / 请求协调器，保持标签切换、后台刷新及正在进行的操作行为。

第二提交，只在生命周期等价时下沉状态：

- 先提交状态归属表：状态、消费者、切换标签时是否保留、触发哪些请求/订阅。
- 可下沉仅服务单面板且不会因卸载丢失所需内容的控件状态。商品/订单分页筛选若原先跨标签保留，默认仍保留在共同父层。
- 不为减少父层行数让两个面板长期隐藏挂载并新增重复请求；不让局部 hook 在多个组件中各实例化一次。
- 若不存在可安全下沉的状态，不做第二提交，说明理由即可；展示拆分已经满足本项主体目标。

父层保留：标签/路由、商家身份、概览统计及跨标签刷新协调。经营数据和推广中心已有独立路由，分类申请已有组件，本项不重复拆它们。

验收：商品发布/下架 API 接线、同商品同步重复点击保护、不锁其他商品、失败可重试、标签切换保留、实时刷新和旧响应隔离全部不变。

验证：`MerchantDashboardPage.test.tsx`；下沉状态时补现有测试未覆盖的切换保留/过期响应用例。触及库存/交付挂载时复用 `merchant-inventory.spec.ts`、相关订单旅程。

建议提交：`refactor(merchant): extract product and order dashboard panels`；如有状态迁移，再单独提交并说明原因。

## 8. R04：商品编辑页表单区域

**拥有文件**：`src/pages/merchant/ProductEditPage.tsx`，`src/pages/merchant/productEditor/`，对应测试。

定位：商品信息约 619 行，套餐约 769 行，购买资料约 880 行。

实施：新增 `ProductInformationSection.tsx`、`OfferEditingSection.tsx`、`PurchaseFormSection.tsx`；薄包装如果没有独立职责则保留内联并说明。套餐行确实复杂时再抽 `OfferEditingRow.tsx`。

父层保留：editor DTO、版本、表单/套餐草稿、图片引用及上传协调、保存顺序、CAS 冲突、CHECKOUT_CHANGED 刷新重试、三方合并入口。继续调用第一批 `offerDrafts.ts`，不重写合并算法。

验收：商家/管理员 actor 的 adapter 不串用；文件形态可上传、其他形态不出现文件输入；未改字段和 descriptionImages 不丢；409 不抹掉已输入内容；checkoutVersion 更新与后续重试保持；多套餐部分成功后发生冲突的重试语义保持。

验证：`ProductEditPage.test.tsx` 全部运行；复用 `LivePreviewSandbox.test.tsx` 和文件/结构化交付相关现有 E2E。

建议提交：`refactor(catalog): extract product editor form sections`。

## 9. R05：商品详情父页面展示层

**拥有文件**：`src/pages/ProductDetailPage.tsx`，新增 `src/components/catalog/productDetail/`，对应测试。

定位：`gallery` 约 616 行，`reviewsContent` 约 746 行，中屏内联布局约 855 行起。

分两次提交：

1. 抽 `ProductDetailGallery.tsx`、`ProductReviewList.tsx`。图库的图片列表、索引、手势、灯箱回调先保持受控；评价加载仍由父页面管理。已有同名或同职责组件先查证复用。
2. 抽 `ProductDetailTablet.tsx`，接收公开展示数据和已有操作回调，容纳 768–1023px 的中屏布局。不要把 `ProductDetailPage` 整体复制一份成为新组件。

父层保留：商品/模板/套餐与评价数据编排、`selectedOfferId`、`handleRedeemClick`、`shortfall`、登录与充值跳转、购买结果、唯一 `PurchaseModal`。

验收：切套餐更新价格且不直接下单；登录返回保留 offerId；无可售套餐不崩溃；余额不足去向不变；图库点击/滑动/灯箱行为不变；评价分页不重复；中屏滚动和 resize 时 CTA 的互斥规则不变；只读预览无真实交易请求。

验证：详情页两个测试文件、`ProductDetailPhase3.test.tsx`，以及现有图库交互、购买确认、评价 E2E。中屏至少核验 768px 和 1023px 边界。

建议提交：`refactor(catalog): extract detail gallery and review list`；`refactor(catalog): extract tablet product detail view`。

## 10. R06：桌面详情组件内部拆分

**拥有文件**：`src/components/catalog/ProductDetailDesktop.tsx`，`src/components/catalog/productDetail/desktop/`，对应测试。本项不改 CSS 内容。

定位：内容标签面板约 420 行起；FAQ 约 534 行；购买侧栏约 720 行。

实施：

- 抽 `DesktopDetailContent.tsx`，容纳详情/使用说明/FAQ/评价/相关商品的内容分支。
- FAQ 只有在独立数据与交互足够复杂时再抽 `DesktopFaqSection.tsx`；已有 `ProductFaqAccordion`、`ProductFulfillmentTrack` 继续复用。
- 抽 `DesktopPurchasePanel.tsx`，保留套餐折叠、选中可见、价格/库存/披露及 CTA。
- 原桌面组件保留双栏布局、标签导航和相关滚动/测量协调。DOM 测量 ref 用明确 prop 或 `forwardRef` 传到同一个真实元素，不新包一层 div 改变测量目标。

验收：当前选中套餐在折叠时仍可见；展开收起不丢选择；sticky、短屏滚动、标签切换与焦点不变；交易动作仍回调父页面，子组件没有新交易控制器。

验证：R05 的组件测试；桌面 1024px、常用宽屏及短高度场景浏览器核验。涉及套餐选择和 CTA 时运行已有多规格/购买 E2E。

建议提交：`refactor(catalog): split desktop detail content and purchase panel`。

## 11. R07：移动详情组件内部拆分

**拥有文件**：`src/components/catalog/ProductDetailMobile.tsx`，`src/components/catalog/productDetail/mobile/`，对应测试。本项不改 CSS 内容。

定位：套餐与购买约 356 行；商家信息约 499 行；内容标签约 633 行；底栏约 857 行；SKU 抽屉约 964 行。

分两次提交：

1. 抽 `MobileOfferPanel.tsx`、`MobileMerchantSection.tsx`、`MobileDetailContent.tsx`；服务保障/推荐区块可归入各自内容模块，不为每个静态小段单独建文件。
2. 抽 `MobilePurchaseBar.tsx`、`MobileSkuSheet.tsx`。保留现有底栏形态、抽屉开关及焦点归位逻辑；套餐抽屉只负责选择，不变成结算弹窗。

原移动组件保留标签选择、手势/动画切换和布局协调；交易与共享套餐状态继续来自父页面。不要因为抽组件重启标签动画、丢失 ref 或重复注册触摸监听器。

验收：切换规格、单规格隐藏切换入口、底栏价格/余额不足、关闭后焦点恢复、键盘标签导航、横向切换与纵向滚动协调、safe-area 均保持。

验证：`ProductDetailPhase3.test.tsx` 与 R05 测试；320px、390px、767px 核验；交互相关现有移动回归/多规格/购买 E2E；打开系统减少动态效果设置抽查一次。

建议提交：`refactor(catalog): extract mobile detail sections`；`refactor(catalog): extract mobile purchase bar and sku sheet`。

## 12. R08：个人中心卡片与订单面板

**拥有文件**：`src/pages/ProfilePage.tsx`，`src/components/profile/`，必要测试。

定位：`MemberTierCard` 约 56 行；`InviteCard` 约 168 行；订单标签约 613 行。

实施：

- 先原样移出 `MemberTierCard.tsx`、`InviteCard.tsx`，连同其原有局部状态/effect。
- 再抽 `ProfileOrdersPanel.tsx`：筛选、订单列表、操作入口。跨标签保留的筛选和订单选择先留父层。
- 页面保留身份/积分总览、签到、标签编排、退出、订单详情与积分流水协调。
- `ProfileIdentityCard`、`SessionManager`、消息通知绑定等已独立，不重新实现。资产页短组合可继续内联。

验收：邀请信息加载/复制反馈、会员等级展示、签到后的余额同步、订单切换筛选、打开详情、标签切换保留状态不变；设置区域不出现第二套账号逻辑。

验证：当前没有独立 `ProfilePage.test.tsx`。不能声称已有页面测试覆盖全部行为；复用相关卡片/头像/订单组件测试，若订单边界迁移缺覆盖，补一个聚焦筛选保留或详情回调的组件行为用例。浏览器用现有签到、头像和订单路径核验受影响部分。

建议提交：`refactor(profile): extract membership and invite cards`；`refactor(profile): extract profile orders panel`。

## 13. R09a–d：后台列表与弹窗分离

四项各自提交，不能做成一个“通用后台管理器”。原 adapter、业务权限、状态映射和失败处理均保留。

| 任务 | 拥有源文件 | 建议新目录与组件 | 原文件保留 |
| --- | --- | --- | --- |
| R09a | `src/components/merchandising/AdminPromotionCampaignManager.tsx` | `campaignManager/CampaignActionDialog.tsx`、`CampaignDetailDialog.tsx` | 活动筛选分页、操作调度、刷新及状态可用性判定 |
| R09b | `src/components/merchandising/AdminPromotionPackageManager.tsx` | `packageManager/CreatePackageDialog.tsx`、`EditPackageDialog.tsx` | 套餐列表、状态操作、adapter 和刷新 |
| R09c | `src/components/merchandising/AdminEditorialManager.tsx` | `editorialManager/EditorialFormDialog.tsx`、`RevokeEditorialDialog.tsx` | 精选筛选分页、请求及刷新 |
| R09d | `src/components/admin/AdminProductPanel.tsx` | `productPanel/ProductCapacityDialog.tsx`、`AdminProductTable.tsx` | 查询草稿/生效筛选、请求竞态保护、页码回退、状态操作 |

迁移定位：R09a 操作弹窗约 736 行，详情约 863 行；R09b 新建约 515 行，编辑约 722 行；R09c 编辑约 614 行，撤销约 830 行；R09d 人数上限弹窗约 764 行，表格约 463 行。

约束与验收：

- 创建和编辑的字段可写性、只读字段、默认值及校验不强制统一；相同输入片段确实逐项同构后，才能局部共享。
- 弹窗打开/取消/失败/成功时的输入生命周期保留；迁出状态时单独验证重新打开及切换目标。
- R09a 保留未知状态无操作、退款数值校验、审核/暂停/恢复/取消对应 API；R09c 保留本地日期与 ISO 转换及公开/内部原因区分。
- R09d 保留点击搜索才应用草稿筛选、reset、最后一页清空回退、乱序响应隔离和新建商品路由。
- 若列表单行太复杂，可以同域抽行组件；不要同时改成另一种分页/数据请求架构。

验证：四个对应 `*.test.tsx` 各自全跑；推广/精选的现有 `merchandising-smoke.spec.ts` 使用 catalog-ops lane；高风险商品操作按现有对应 E2E 核验。

建议提交标题分别为：`refactor(merchandising): extract campaign dialogs`、`extract package dialogs`、`extract editorial dialogs`、`refactor(admin): extract product table and capacity dialog`。

## 14. R10：商城商品卡片外移

**拥有文件**：`src/pages/StorePage.tsx`，建议新增 `src/components/store/StoreProductCard.tsx`，对应测试。

定位：已有 `ProductCard` 约 122 行至主页面之前。

实施：仅移出卡片和其独占的展示辅助逻辑，保持输入 props 与事件行为。商城页面继续管理列表请求、分类与 URL、推荐混排、audience 缓存、分页、滚动恢复。

本项不把约 1000 行页面拆成多个相互依赖的数据 hook；缓存与滚动控制器重构列为后续单独任务。

验收：商品链接和收藏交互互不误触；活动/会员信息不变；访客/会员切换不泄漏旧缓存；推荐接口失败仍有自然商品流；搜索抑制推广的现有规则不变；返回商城的位置恢复不变。

验证：`StorePage.test.tsx`、`StorePage.cmi.test.tsx`；实际使用的收藏 hook 测试；`store-pagination.spec.ts` 及相关浏览器滚动核验。

建议提交：`refactor(store): extract storefront product card`。

## 15. R11：CSS 按职责组织，保持级联

**拥有文件**：`src/index.css`、`src/components/catalog/ProductDetailDesktop.css`、`ProductDetailMobile.css` 及新样式文件和必要入口引用。

分两个独立提交：

1. 全局样式：按实际连续区段整理主题变量、基础规则、导航/底栏、Toast/浮岛、基础控件、榜单及通用动画。建议放 `src/styles/`，`index.css` 作为清晰入口。
2. 详情样式：分别在桌面/移动模块内部按布局、内容、购买区域等整理。跨断点及 reduced-motion 覆盖必须维持原有位置语义。

特别约束：

- CSS 移动可能改变行为。先记录原始顺序，不能把散落的主题/媒体查询按名字归组后假定等价。
- 保留 `@tailwind` / `@layer` 的有效处理、选择器优先级、同名 keyframes 覆盖次序、CSS 变量作用域和媒体查询顺序。
- 核查 Vite/PostCSS 的 import 展开结果，不能只靠“构建成功”确认样式等价。现有 PostCSS 配置只有 Tailwind 与 Autoprefixer，不为拆样式添加新依赖。
- 没有安全的抽取边界时允许保留原文件的一段。重复声明清理、主题调整、动画改速和选择器重命名不在范围内。
- 不把本应全局生效的样式改成某个页面加载后才生效。

验收：构建后的选择器/声明/条件/顺序对比，以及代表性页面前后截图或 computed style 对比。四主题各有覆盖；覆盖移动、中屏、桌面、短屏及 reduced-motion。动态内容固定数据或冻结动画再比较，不用随机截图作为证据。

验证：生产构建；已有主题与移动 UI 相关 E2E；按受影响区域补浏览器对比，不为每个 CSS 规则新增测试。

建议提交：`refactor(styles): organize global styles without cascade changes`；`refactor(styles): organize product detail styles`。

## 16. R12：推广活动巨型测试文件按行为分组

**拥有文件**：`src/components/merchandising/AdminPromotionCampaignManager.test.tsx` 及同目录拆出的测试文件/专用测试辅助模块。不改生产代码。

已有五个顶层 describe，定位约为 383、871、1425、1646、2139 行：

- 查询与筛选 → `AdminPromotionCampaignManager.query.test.tsx`。
- 操作可见性及审核 → `AdminPromotionCampaignManager.review.test.tsx`。
- 暂停/恢复 → `AdminPromotionCampaignManager.pause-resume.test.tsx`。
- 取消 → `AdminPromotionCampaignManager.cancel.test.tsx`。
- 退款调整 → `AdminPromotionCampaignManager.refund.test.tsx`。

迁移纯 fixture builder 与渲染工具到专用辅助模块；`vi.mock` 提升语义、模块加载顺序、fake timers、环境清理按 Vitest 实际机制处理，不把所有 setup 粗暴挪进普通 helper import。

验收：迁移前后用例名称多重集合、总数、断言意图一致；没有新增 skip/todo；各文件单跑和一起跑都通过；每用例独立创建可变 adapter/mock 数据，不靠文件执行顺序。

验证：运行拆分后的五个文件；无需因为纯测试组织再重建生产 bundle。其他巨型测试留待后续，不把所有测试文件一口气重写。

建议提交：`test(merchandising): split campaign tests by behavior`。

## 17. 明确排除的后续候选

- `Layout.tsx`：导航形态、搜索、通知浮岛与滚动协调较多，另做状态归属审计后再拆。
- `PurchaseModal.tsx`：购买状态机与交易控制器保持集中。
- `StorePage` 数据缓存/滚动恢复控制器、分类管理两套列表控制器：本轮只做上述具体边界。
- 其他后台面板、API 客户端、登录/法律长文：没有明确职责收益时不按行数拆。
- 预算脚本递归统计、manifest、入口静态依赖指标、150 KiB 目标、防退化基线、懒加载及 CI：独立性能任务。

## 18. 验证执行规则与现有入口

### 18.1 每个生产代码提交

在实施 worktree 中执行并保存退出码和摘要：

```bash
npm run check:runtime
npx tsc --noEmit
npx vitest run <该任务对应的现有测试文件>
npm run build
git diff --check
git diff --cached --check
```

`<...>` 是待替换的路径占位，不可原样执行。构建内部已有 `tsc -b`；时间紧时可用构建中的类型检查替代独立 tsc，但交付记录中要写清。依赖变化影响多个任务时合并运行受影响测试，不反复全量扫描。

每次记录的是实际待交付 commit/tree 的结果。验证后又修改代码，就重跑受影响验证。R12 按其专用要求执行，不强制无意义构建。

关键测试路径：

| 任务 | 现有组件测试 |
| --- | --- |
| R01 | `src/components/catalog/AdminCategoryManager.test.tsx` |
| R02 | `src/pages/merchant/ProductCreateWizard.test.tsx`；`src/pages/admin/ProductCreatePage.test.tsx`；`src/components/merchant/LivePreviewSandbox.test.tsx` |
| R03 | `src/pages/MerchantDashboardPage.test.tsx` |
| R04 | `src/pages/merchant/ProductEditPage.test.tsx`；`src/components/merchant/LivePreviewSandbox.test.tsx` |
| R05–R07 | `src/pages/ProductDetailPage.test.tsx`；`src/pages/ProductDetailPage.readonly-audit.test.tsx`；`src/components/catalog/ProductDetailPhase3.test.tsx`；修改牵涉预览消费者时加 `LivePreviewSandbox.test.tsx` |
| R08 | 按实际迁移选择 `src/components/profile/ProfileIdentityCard.test.tsx`、`src/components/profile/ExperienceProgressBar.test.tsx`、`src/components/PointsHistorySheet.test.tsx`；页面订单边界的覆盖缺口按 R08 处理 |
| R09 | 四个管理组件各自的同名 `*.test.tsx` |
| R10 | `src/pages/StorePage.test.tsx`；`src/pages/StorePage.cmi.test.tsx`；`src/hooks/useProductFavorite.test.ts` |

部分测试同样属于当前未提交功能，R00 必须一起纳入输入基线；不是所有文件都能在原 HEAD 找到。

### 18.2 浏览器与现有 E2E

遵循 `docs/testing-policy.md`：结构抽取不为文案/样式批量新增 E2E；已有关键旅程继续执行。组件测试不替代真实滚动、布局测量、焦点和浏览器生命周期证据。

| 影响路径 | 优先复用的现有 E2E |
| --- | --- |
| 分类治理/商品发布 | `e2e/catalog-category-governance.spec.ts`、`e2e/catalog-product-lifecycle.spec.ts`（专用 lane） |
| 创建购买资料/结构化/文件交付 | `e2e/product-wizard-purchase-form.spec.ts`、`e2e/structured-delivery.spec.ts`、`e2e/file-delivery.spec.ts` |
| 商家库存/订单 | `e2e/merchant-inventory.spec.ts`、`e2e/order-lifecycle.spec.ts` |
| 商品详情 | `e2e/product-gallery-interactions.spec.ts`、`e2e/product-reviews.spec.ts`、`e2e/multi-sku.spec.ts`、`e2e/checkout-confirmation.spec.ts`、`e2e/product-exchange.spec.ts` |
| 个人中心 | `e2e/checkin.spec.ts`、`e2e/profile-avatar.spec.ts` 及受影响订单路径 |
| 推广/精选 | `e2e/merchandising-smoke.spec.ts`（专用 lane） |
| 商城/样式 | `e2e/store-pagination.spec.ts`、`e2e/theme-default.spec.ts`、受影响的 `mobile-regression.spec.ts` / `mobile-ui-polish.spec.ts` |

只选择覆盖实际改动路径的现有场景，不默认每项都跑表中全部文件。记录选择理由与未覆盖部分。

**配置陷阱**：默认 `playwright.config.ts` 忽略 catalog lifecycle/category/xboard/merchandising 四个 spec。它们必须使用 `playwright.catalog-ops.config.ts` 和既有 `scripts/verify-catalog-ops-e2e.sh` 的隔离环境要求；默认命令报告“未找到测试”不算通过。

先确认测试使用的服务和可重置测试数据库。`verify:quick` 带 E2E 参数会重置/播种测试数据库，默认 Playwright 又可能复用已有服务；不能直接对正在使用的共享服务运行。复用现有隔离测试启动流程，不修改 CI 来迁就本地环境。

如果环境缺失，保留已完成代码、明确记录哪些浏览器/E2E 尚未验证及复现命令，状态标记“待验证”，不得报告整项完成或用新增 mock 绕过关键旅程。

### 18.3 终检

- 对最终累计变更运行一次相关测试集合与生产构建；如果最终 tree 与刚验证的一致，直接复用结果。
- 针对详情、导航相关浏览器交互和 CSS 使用同一输入 fixture 做前后对比。
- 不用旧 `dist` 证明当前代码，也不把普通 Vite chunk 警告描述为本次重构新引入的失败。
- 没有必要运行全套后端集成测试；若发现必须修改后端才能完成，应作为越界问题报告。

## 19. Review 交付包

在 `docs/refactoring/2026-10-04-frontend-module-split.review.md` 的现成模板中记录实际结果。不要预填成功；每任务完成后更新对应行，并随任务提交。文档中的“未开始”表示尚未实施，不是已有通过证据。

至少包含：

1. 实施 worktree/分支路径、原 HEAD、输入快照基线 SHA、最终 SHA；哪些输入改动属于其他工作。
2. 任务状态表：任务 ID、提交 SHA、范围、通过/待验证/未做、原因。第二提交等可选迁移未做时说明理由。
3. 每项“原职责 → 新文件 → 留在父层的状态/行为”映射；所有移动状态的原/新所有者和生命周期。
4. 实际验证命令、退出码、测试文件/用例数、构建结果、日志/浏览器证据位置；基线失败与新增失败区分。
5. 文件行数前后作为辅助数据；不把行数变少或 helper 数量变多当正确性证据。
6. 明确列出任何实际 DOM、props、状态生命周期、请求或文案变化；正常预期为没有用户可见变化。无法等价之处要单列，不能隐藏在“顺便优化”。
7. 继承改动与本次修改的区分方式，以及原工作区未被修改的核对结果。

Review 范围必须可直接获取：

```bash
git log --oneline <snapshot-base>..<refactor-head>
git diff --stat <snapshot-base> <refactor-head>
git diff <snapshot-base> <refactor-head>
```

这些同样是占位示例，交付时写成真实 SHA。同一机器共享仓库时交付分支即可；跨机器提供可还原的 bundle 或 patch，并包含输入快照信息及必要未跟踪资源，不能只给截图或最终文件压缩包。

Reviewer 将重点检查：边界是否减少职责混杂；状态是否因卸载丢失；effect/ref/事件是否重复；版本冲突和过期响应保护是否保持；交易与预览是否仍隔离；CSS 级联是否一致；测试是否真正覆盖提交内容。

不推送、不发布、不部署、不自动合并到其他分支。完成本地独立提交和交付记录后，将结果交回原 agent review。

## 20. 可直接转交给实施 agent 的指令

> 请在 MoNexus-new 仓库执行 `docs/refactoring/2026-10-04-frontend-module-split.tasks.md`。先读 R00 建立包含当前前端功能的隔离输入基线，再按 R01–R12 顺序完成结构拆分；R09 含四个独立任务。保持外观、业务规则、错误文案、请求时序与状态生命周期等价，不按行数强拆，不重新做已完成的第一批共享提取。每项独立验证、独立本地提交；相关验证通过后继续下一项。不要修改原工作区里他人的改动，不推送或部署。最后提供分支/worktree、输入基线 SHA、最终 SHA、每项提交与验证结果，并填写任务书规定的 review 交付记录，交回原 agent 审查。
