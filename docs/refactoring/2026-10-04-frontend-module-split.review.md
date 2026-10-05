# 前端拆分实施结果与 Review 记录

> 历史记录：以下结果针对 2026-10-04 的输入快照与原重构分支。基于最新 develop 的迁入、冲突适配与本次验证见 [整合记录](2026-10-05-frontend-module-integration.md)。

对应任务书：[前端大文件拆分任务书](2026-10-04-frontend-module-split.tasks.md)。

当前状态（第二次交付，含 review 返工）：**R00 + R01–R12 代码已全部实施并本地提交；组件测试、类型检查、生产构建、空白检查全部通过。全栈 E2E 已在本机隔离环境补跑完毕（详见 §4.1 与 §5），与基线逐例对照后确认零新增回归。R03-2 按任务书 §7 条件判定为不实施（理由见 §2、§5）。**

Reviewer 复审意见（`original-agent-review/findings.md`）四项已在 §5.1 逐条回应；F03/F04 清理由提交 `831c663` 完成，F01/F02 的验证与证据补齐见 §4.1、§4.2。

## 1. 输入与比较范围

| 字段 | 实际值 |
| --- | --- |
| 实施者 / 日期 | refactor-agent / 2026-10-04 |
| 源仓库与工作分支 | `/root/projects/MoNexus-new`，分支 `feat/nav-brand-kinetic-mx` |
| 实施 worktree 与分支 | `/root/projects/MoNexus-frontend-module-split`，分支 `refactor/frontend-module-boundaries` |
| 源 HEAD | `20f493a88ce817af1a01ae89f89ad1394ae01f1a`（与任务书编写时一致，未漂移） |
| 输入快照基线 SHA | `a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a`（tag `refactor-snapshot-base`） |
| 最后一个改源码的提交 | `831c663`（此后仅 doc-only 提交，不改源码，不改变 review 范围） |
| 交付分支 tip | 见 §6（后续 doc-only 提交会前移 tip） |
| 原工作区状态清单 / diff 保存位置 | `/root/projects/monexus-refactor-artifacts/00-source-{status,diff.patch,diffstat,staged.patch,head,branch}.txt` |
| 继承的修改与未跟踪文件清单 / 哈希 | 同目录 `00-copylist.txt`(94)、`00-untracked-hashes.txt`(56)、`01-pre-copy-hash.txt`、`02-post-copy-hash.txt` |
| 基线测试 / 构建结果及日志 | `/root/projects/monexus-refactor-artifacts/logs/frontend/00-baseline-verify.log`、`00-baseline-dist-hashes.txt` |
| 原工作区未被本次实施改动的核对结果 | 见 §6 核对项，`git status --short` 与 `git diff` 与开工时归档逐字节一致 |

说明哪些文件属于输入功能，不能算作本次重构新增功能：

- **输入快照提交 `a1c27e0` 由 94 个文件组成**，不属于本次重构，review 范围必须从 `a1c27e0` 起算：
  - 43 个 `src/**` 已修改文件（`Layout.tsx`、`ProductDetailPage.tsx`、`ProfilePage.tsx`、`StorePage.tsx`、`index.css`、`appStore.ts`、recharge 系列等）。
  - 49 个 `src/**` 未跟踪新文件：`ProductDetailDesktop.tsx`/`.css`、`ProductDetailMobile.tsx`/`.css`、`ProductDetailPhase3.test.tsx`、`productDetailFaq.ts`、`productDetailMock.ts`、`FavoriteHeartButton.tsx`、`useProductFavorite.ts`、`MerchantHoverCard.tsx`/`.css`、`AnimatedCounter.tsx`、`FluidOrb.tsx`、`HeartBurst.tsx`、`BackToTop.tsx` 等。
  - `public/assets/mock/product-detail/*`（13 个 mock 资源，被 `productDetailMock.ts:4` 与 `ProductDetailPage.tsx:641` 真实引用）。
  - `docs/refactoring/` 内本任务书与 review 模板。
- **未纳入快照的源工作区改动**（属于其他工作流，与本任务无关）：`server/**` 的 12 个文件（fakaBridge、mailer templates、orders/accounting）、`scripts/preview-mail-templates.mjs`、`.gitignore`（追加 `outputs/`、`skills-ref/`）、`ops/notice-jpkr-interruption.json`、5 个一次性截图/通知脚本、`server/src/scripts/backfillFakaPayments.ts`、迁移计划文档 `docs/specs/order-notification-system/2026-10-02-notification-remediation-plan.md`。这些一律未复制、未修改。

Review 的真实命令（实际 SHA，无占位）：

```bash
# 快照 → 重构（本次 review 范围，20 个提交）
git log --oneline a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a..02ce14cf614ffce089ccb8f67e283128a5dcf729
git diff --stat a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a 02ce14cf614ffce089ccb8f67e283128a5dcf729
git diff a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a 02ce14cf614ffce089ccb8f67e283128a5dcf729

# 源 HEAD → 快照（输入功能，不属于重构）
git log --oneline 20f493a88ce817af1a01ae89f89ad1394ae01f1a..a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a
git diff --stat 20f493a88ce817af1a01ae89f89ad1394ae01f1a a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a
```

同一机器共享仓库，交付 `refactor/frontend-module-boundaries` 分支即可；`refactor-snapshot-base` tag 已打在同一仓库，可直接还原比较范围。

## 2. 任务与提交

状态允许：未开始、实施中、待验证、完成、有条件子项未实施（说明原因）。未执行的验证不写"通过"。

| 任务 | 内容 | 提交 SHA | 状态 | 验证记录 / 未完成原因 |
| --- | --- | --- | --- | --- |
| R00 | 隔离输入基线 | `a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a` | 完成 | 94 文件快照；拷贝前后 sha256 逐文件相同（`HASH-MATCH-OK`）；基线 136 文件 / 1176 用例全绿；基线构建 exit 0 |
| R01 | 分类表单、审核、排序子组件 | `0372ea6a690daeba41e59e91c6ff4218e4019b2c` | 完成 | 组件测试 3 文件 / 12 用例 exit 0；build exit 0。**全栈 E2E：`catalog-category-governance` 15/15 passed，gate PASS**（覆盖 create_new / map_existing / reject、编辑、停用、启用、排序、引用保护） |
| R02-1 | 向导定价、附加规格、交付面板 | `373b6a6c7f4dec05a77efe862010f3113ad0bb00` | 完成 | 四测试文件 39/39 exit 0；build exit 0。**全栈 E2E：`catalog-product-lifecycle` 9/9、`product-wizard-purchase-form`（含 320px 移动冒烟）与 `structured-delivery` 见 §4.1，与基线逐例一致** |
| R02-2 | 展示信息、确认草稿面板 | `5832a5bd0571ef298d9414aa6ac965df1fc5e2c3` | 完成 | 新增 27 用例全过；build exit 0；全量 138/1203 exit 0。**全栈 E2E 覆盖同 R02-1** |
| R03-1 | 商家商品、订单面板 | `e6c55284a58ea5af34cebcc8145536044694f759` | 完成 | MerchantDashboardPage 测试 exit 0；build exit 0。**全栈 E2E：`catalog-product-lifecycle` 的看板发布/下架/重新发布 9/9，`merchant-inventory` 与 `order-lifecycle` 见 §4.1** |
| R03-2 | 满足生命周期等价条件的局部状态下沉 | — | 有条件子项未实施 | 任务书 §7 允许。实证：商品/订单筛选与分页原先跨标签保留，且库存/可售量/容量/套餐/交付/争议/进度弹窗挂载点所有者均为父层；任何下沉都会让面板卸载后丢失所需内容或新增重复请求。展示拆分已满足本项主体目标 |
| R04 | 商品编辑页分区 | `2d83e72b76026bd51d84c28dabdfdec90c122393` | 完成 | ProductEditPage 19/19、LivePreviewSandbox 5/5 exit 0；build exit 0；`offerDrafts.ts` diff 为空。**全栈 E2E：`product-wizard-purchase-form` 的编辑页购买资料用例见 §4.1** |
| R05-1 | 图库、评价列表 | `c8193337864a3829be984b2fb0331835287a8a71` | 完成 | 3 文件 / 29 用例 exit 0；build exit 0。**全栈 E2E：`product-gallery-interactions`；评价链路经 `evidence/business-paths.mjs` 跑到终点（提交、展示、修改、再次修改限制），两侧 22/22。渲染等价性 43 identical / 0 different / 6 N/A / 0 failed（§4.2）** |
| R05-2 | 中屏详情布局 | `4f07df8eb182c544a86993ce4246a5f5bde2a0ab` | 完成 | 同上。**渲染对照覆盖 768/1023；中屏按真实契约核验为「粘性 CTA + 无移动底栏」，两侧一致（§4.2）** |
| R06 | 桌面详情内容、购买侧栏 | `99d7fbd7be25493277819dd342373704e63a61f7` | 完成 | 同上；`purchaseRef` 经显式 `sectionRef` prop 落到真实 `<section className="pd-purchase">`，实测 `parentElement === .pd-layout`。**非预览 SKU 切换读真实数值价格两侧一致；桌面 ArrowRight 不推进为既有实现缺失（§4.2）** |
| R07-1 | 移动详情内容区块 | `69fdc1ce88cd1d24d7b4ec8aa708d67f04f65736` | 完成 | 同上。**DOM 对照覆盖 320/390/767px；移动回归 E2E 见 §4.1** |
| R07-2 | 移动购买底栏、规格抽屉 | `24d2313bfd5ccf3b8143f1532adc70c8f0cb26d3` | 完成 | 同上；触摸监听与标签动画仅在父层注册一次。**非预览抽屉开合/抽屉内选择改价两侧一致；关闭后焦点未恢复为既有实现缺失（§4.2）** |
| R08-1 | 会员、邀请卡片 | `0dcbfe3e270e22df61d366037ea9e3a368918fa2` | 完成 | 3 文件 / 9 用例 exit 0；build exit 0。**全栈 E2E：`checkin`、`profile-avatar` 见 §4.1** |
| R08-2 | 个人中心订单面板 | `5f628e0847c9ca89fc6119c9ed5ad46bf1fd9830` | 完成 | 4 文件 / 11 用例 exit 0；全量 137/1178 exit 0。**全栈 E2E：订单详情链路见 `structured-delivery`；`checkin`/`profile-avatar` 见 §4.1** |
| R09a | 推广活动弹窗 | `3fc6be7a89d64b13ed5f8630509428b5601239d9` | 完成 | 35/35 exit 0；整目录 18 文件 259 用例；build exit 0。**全栈 E2E：`merchandising-smoke` 的活动面板用例 3/3** |
| R09b | 推广套餐表单 | `5d9052ab8ce27e95ba6d41df176ff338f9b89148` | 完成 | 对应测试 exit 0；build exit 0。**全栈 E2E：`merchandising-smoke` 的套餐创建/审批用例 3/3 passed，gate PASS** |
| R09c | 精选编辑、撤销弹窗 | `3824a509f6eaa00f7676b3d89b080d8e70761cd5` | 完成 | 24/24（基线 22，+2）exit 0；整目录 16 文件 242 用例；build exit 0。**现有 E2E 未单独覆盖精选编辑链路，属未覆盖项，见 §5** |
| R09d | 管理端商品表格、人数上限弹窗 | `302e71883226fe1f2e30105b4f7811f252401fc2` | 完成 | AdminProductPanel 9/9；admin 域 22 文件 132 用例；消费方 3 文件 19 用例；build exit 0。**全栈 E2E：`catalog-xboard-import` 4/4 passed（含竞态与幂等），gate PASS** |
| R10 | 商城商品卡片 | `0f146502408d90061e439a9ace8e00d8cb217fde` | 完成 | StorePage + cmi + useProductFavorite exit 0；build exit 0。**全栈 E2E：`merchandising-smoke` 的商城混排披露用例、`store-pagination` 见 §4.1** |
| R11-1 | 全局样式组织 | `f50099b341a4c05758694663dfd8999f798206e9` | 完成 | 构建产物 CSS 与基线 **逐字节一致**；全量 136/1176 exit 0 |
| R11-2 | 详情样式组织 | `e78b22d78c49f3d70d49cdb282abe6b7cb630f08` | 完成 | 同上，最终 bundle `cmp` 仍逐字节一致 |
| R12 | 推广活动测试按行为分组 | `02ce14cf614ffce089ccb8f67e283128a5dcf729` | 完成 | 用例名多重集合 35 → 35 守恒；断言 462 → 462 守恒；单跑 8/8/3/7/9 + 同目录 240 用例全过 |

> 上表 SHA 为整合后主分支（`refactor/frontend-module-boundaries`）线性历史中的提交。各任务原始独立分支提交见 §7。

**R12 拆分映射与守恒证据**：`query`(8)、`review`(8)、`pause-resume`(3)、`cancel`(7)、`refund`(9，含 `it.each` 展开 4 例)，共享 fixture/render 工具抽到 `campaignManagerTestUtils.tsx`。用例名称多重集合经 vitest JSON reporter `fullName` 双向比对：**原 35 / 新 35，缺失 0、新增 0**；断言总数 **462 → 462**。实测该文件零 `vi.mock`/`vi.doMock`/`vi.hoisted`、零 fake timers、零文件局部钩子，因此没有任何 setup 被挪进普通 helper，mock 提升顺序不可能被重排；环境清理仍由共享 `src/test/setup.ts` 提供。另用 `--sequence.shuffle` seed 1/7/42 与正反序额外验证无文件顺序依赖。

## 3. 职责与状态归属

| 任务 | 原文件 / 符号 | 新文件 / 符号 | 留在父层的职责 | 行数前后（辅助） |
| --- | --- | --- | --- | --- |
| R01 | `AdminCategoryManager` 内 `CategoryFormDialog` / `ReviewDialog` / `ReorderList` / `CategoryStatusBadge` | `catalog/categoryManager/{CategoryFormDialog,ReviewDialog,ReorderList,CategoryStatusBadge}.tsx` + `types.ts` | 分类库与申请列表控制器、adapter、刷新、跨操作 `busy`、停用/删除确认、审核后联动 | 1319 → 758 |
| R02-1 | `ProductCreateWizard` `step===2` 定价区、附加规格循环、`step===3` 交付区 | `wizard/steps/{PricingStep,ExtraOfferEditor,DeliveryStep}.tsx` + `wizardStepTypes.ts` | `form`、`step`、主/附加规格草稿、模板与属性、上传引用、校验编排、保存、发布 | 1477 → 1268 |
| R02-2 | 展示信息区、确认草稿与买家确认预览 | `wizard/steps/{PresentationStep,DraftReviewStep}.tsx` | 同上 + `previewData`/`previewOffers` 白名单构造、DOMPurify | → 1155 |
| R03-1 | 商品分支、订单分支 | `merchant/dashboard/{MerchantProductsPanel,MerchantOrdersPanel,MerchantPanelPrimitives}.tsx` | 标签/路由、商家身份、概览统计、跨标签刷新协调、全部弹窗挂载点 | 1151 → 751 |
| R04 | 商品信息、套餐列表、套餐行、购买资料 | `productEditor/{ProductInformationSection,OfferEditingSection,OfferEditingRow,PurchaseFormSection}.tsx` + `offerRequirements.ts` | editor DTO、版本、草稿、图片引用与上传协调、保存顺序、CAS 冲突、CHECKOUT_CHANGED 重试、三方合并入口 | 1076 → 824 |
| R05-1 | `gallery` 区、`reviewsContent` | `productDetail/{ProductDetailGallery,ProductReviewList}.tsx` | 商品/模板/套餐与评价数据编排、`selectedOfferId`、`handleRedeemClick`、`shortfall`、唯一 `PurchaseModal` | 1303 →（R05-2 后）778 |
| R05-2 | 768–1023px 中屏内联布局 | `productDetail/ProductDetailTablet.tsx` | 同上 | 见上 |
| R06 | 内容标签面板、FAQ、购买侧栏 | `productDetail/desktop/{DesktopDetailContent,DesktopFaqSection,DesktopPurchasePanel}.tsx` | 双栏布局、标签导航与指示器测量、`scrollToSection`、`contentRef`/`tabNavRef`/`tabIndicatorRef`、offer 折叠、购物车/对比/店铺弹窗 | 1150 → 578 |
| R07-1 | 套餐购买块、商家信息、内容标签 | `productDetail/mobile/{MobileOfferPanel,MobileMerchantSection,MobileDetailContent}.tsx` | 标签选择、`slideDirection`、`pm-tab-panels` 动画包装、触摸监听、`rootRef` | 1138 →（R07-2 后）598 |
| R07-2 | 底栏、SKU 抽屉 | `productDetail/mobile/{MobilePurchaseBar,MobileSkuSheet}.tsx` | `skuDrawerOpen`、`changeOfferBtnRef`、`previewOrderReady`、交易路径 | 见上 |
| R08-1 | `MemberTierCard`、`InviteCard` | `profile/{MemberTierCard,InviteCard}.tsx` | 父层仅渲染（InviteCard 局部 state/effect 随组件迁移） | 1012 → 720 |
| R08-2 | 订单标签区 | `profile/ProfileOrdersPanel.tsx` | `orderFilter`、`orders`、`listsLoading`、`loadingOrderId`、`selectedOrder`、`openOrderDetail`、`OrderDetailModal` 协调 | → 512 |
| R09a | 操作弹窗、详情弹窗 | `campaignManager/{CampaignActionDialog,CampaignDetailDialog}.tsx` + `types.ts` + `dateFormat.ts` | 筛选分页、`requestId` 陈旧守卫、`ACTIONS_BY_STATUS`/未知状态 no-op、adapter 编排、退款校验、幂等 fingerprint、busy 守卫 | 992 → 722 |
| R09b | 新建、编辑弹窗 | `packageManager/{CreatePackageDialog,EditPackageDialog}.tsx` | 套餐列表、状态操作、adapter、刷新、筛选分页 | 945 → 295 |
| R09c | 编辑、撤销弹窗 | `editorialManager/{EditorialFormDialog,RevokeEditorialDialog}.tsx` + `types.ts` | 精选筛选分页、请求与刷新、adapter、`canMutate` 权限、状态/展位标签 | 910 → 435 |
| R09d | 人数上限弹窗、表格 | `admin/productPanel/{ProductCapacityDialog,AdminProductTable}.tsx` + `types.ts` | 查询草稿/生效筛选、`reloadProducts` 竞态 guard、末页回退、`unpublishingRef`、新建商品路由 | 919 → 553 |
| R10 | 主页面前 `ProductCard` | `store/StoreProductCard.tsx` | 列表请求、分类与 URL、推荐混排、audience 缓存、分页、滚动恢复 | 1008 → 818 |
| R11-1 | `index.css` 连续区段 | `styles/{00-tailwind-layers,10-tokens,20-base,30-dock,40-toast,50-island-reveal,60-motion-system,70-support-utilities,80-themes,90-leaderboard-transitions}.css` | `index.css` 保留为 28 行入口（顶部 `@import`） | 1599 → 28 + 1591 |
| R11-2 | 详情 CSS 连续区段 | `catalog/product-detail/{desktop-*,mobile-*}.css`（15 文件） | 原 `.css` 保留为 9 / 8 行入口，组件 import 语句原样不动 | 1590/1670 → 9/8 + 3270 |
| R12 | 五个顶层 describe | `AdminPromotionCampaignManager.{query,review,pause-resume,cancel,refund}.test.tsx` + `campaignManagerTestUtils.tsx` | — | 2559 → 五文件 |

| 状态 / effect / ref | 原所有者 | 新所有者 | 切换 / 卸载 / 重开时的原行为 | 保持方式与证据 |
| --- | --- | --- | --- | --- |
| `catItems`/`catPage`/`catStatus`/`appItems`/`appPage`/`appStatus`/`busy`/`confirmTarget`/`reorder*` | `AdminCategoryManager` | 未迁移 | 跨操作保留；`busy` 拦截重复提交 | 全部留在父层，R01 测试 12/12 绿 |
| `CategoryFormState`/`errors`/`codeTouchedRef` | `CategoryFormDialog`（原在文件内定义） | 同组件新文件 | `open`/`category` 变化时重置；编辑态封面未触碰 | 初始化 effect 逐行迁移；`types.ts` 只放父层也消费的 `CategoryFormState`/`ReviewMode` |
| 向导 `form`/`step`/`extraOffers`/`draft`/`readiness` | `ProductCreateWizard` | 未迁移（**全部留父层**） | 步骤往返保留输入；草稿 ID 幂等 | 新步骤组件零 state/effect；`savingRef`、`draft ||`、`createProductV2` 在 diff 中零改动行 |
| 附加规格 `key={index}` | `ProductCreateWizard` | 未迁移 | 增删不引发错误的 remount | key 表达式未改 |
| `MerchantDashboardPage` 全部状态与弹窗挂载点 | 父层 | 未迁移（R03-2 判定不下沉） | 标签切换保留筛选/分页 | 探针实测弹窗挂载点在父层且跨标签保留，故不可下沉 |
| `offerFileById`/`bindingOfferId`/`handleBindOfferFile` | `ProductEditPage` | 未迁移 | 上传协调与 `bindingOfferId` 生命周期不变 | 留在父层，`OfferEditingRow` 只收回调 |
| `activeImage`/`lightboxOpen`/`reviewPage` | `ProductDetailPage` | 未迁移 | 灯箱与评价分页不重复 | 评价加载由父页面管理；20 项交互比对全部 `identical=true` |
| 图库指针起始与滑动标记 ref | `ProductDetailPage` | `ProductDetailGallery` | 单实例，语义等价 | 组件内仅一个实例，`openLightbox`/`moveGallery`/`showGalleryImage` 仍由父层传入 |
| 触摸监听、`key={section}` 动画 | `ProductDetailMobile` | 未迁移（仅父层注册一次） | 单次滑动恰好前进一节 | 新组件内零 `addEventListener`；实测 details→usage→faq 无跳级 |
| `sectionRef`（DOM 测量） | `ProductDetailDesktop` `purchaseRef` | 经显式 prop 传给 `DesktopPurchasePanel` | 测量目标不变 | 直落真实 `<section className="pd-purchase">`，无新增包裹 div；实测 `parentElement === .pd-layout` |
| `inviteData`/`loading`/`creating` | `ProfilePage` | `InviteCard` | 切走卸载、切回重新拉取 | 挂载时机仍由 `activeTab === 'assets'` 决定，与基线一致 |
| `orderCounts`/`filteredOrders` `useMemo` | `ProfilePage` | `ProfileOrdersPanel` | 过滤结果不变 | 依赖数组与计算逻辑逐行相同 |
| R09a `dialog`/`detail` state | 父层 | 未迁移 | 打开/取消/失败/成功生命周期不变 | 弹窗组件无状态 |
| R09c 弹窗表单状态 | 父层 | 弹窗内部 | 重开同一目标也须重置 | 状态身份键含 `open` 标志 + `(open, feature/target)` 双元组；未加 `key`、未 remount；新增 2 用例锁定「切换目标重置」「不可解析日期报错」 |
| R09d 弹窗草稿/`saving` | 父层 | 弹窗内部 | 每次打开按当前商品 `capacityLimit` 重新播种；保存中不可关闭 | 内容层仅在 `DialogContent` 打开时挂载；实测 Radix 关闭时同步卸载（`PROBE_STILL_MOUNTED_SYNC=false`）；`saving` 以 ref 上抛给关闭守卫 |

## 4. 实际验证记录

按提交或相同 tree 记录。日志位于 `/root/projects/monexus-refactor-artifacts/logs/`（各任务子代理另有 worktree 内日志）。

| 任务 / SHA 或 tree | 命令 | 退出码 | 文件数 / 用例数或构建结果 | 日志位置 |
| --- | --- | --- | --- | --- |
| R00 `a1c27e0` | `npm run check:runtime` | 0 | Node 20.20.2 / npm 10.8.2 门通过 | `frontend/00-baseline-verify.log` |
| R00 `a1c27e0` | `npx tsc --noEmit` | 0 | 0 error | 同上 |
| R00 `a1c27e0` | `npx vitest run` | 0 | **136 文件 / 1176 用例** 全通过 | 同上 |
| R00 `a1c27e0` | `npm run build` | 0 | `✓ built in 7.96s`；`index-BnBNxjgA.css` 203.91 kB、`index-CQar3Tx6.js` 1690.24 kB | 同上 |
| R00 基线产物 | `sha256sum` | 0 | CSS `225c6932a743fe159dd66d735a4bac388f8b74d059c082a829c1e4804c796cf8`；JS `81a1e9685cd04594f3f015d9a0a068bb1ec8e7c5a5c5ba8f4b16ea753c082279` | `00-baseline-dist-hashes.txt` |
| R01 `0372ea6` | `npx vitest run`（AdminCategoryManager + CategoryCoverField + CategoryApplicationPanel） | 0 | 3 文件 / 12 用例 | `R01-verify.log` |
| R01 `0372ea6` | `npm run build` | 0 | `✓ built in 8.14s`；CSS 哈希与基线相同 | `R01-build.log` |
| R01 `0372ea6` | `npx vitest run`（全量） | 0 | 136 文件 / 1176 用例 | `R01-fulltest.log` |
| R02-1 `373b6a6` | `check:runtime` / `tsc --noEmit` / `vitest`(向导+admin+预览+新步骤) / `build` / `diff --check` | 0 / 0 / 0 / 0 | **47 用例通过**（在最终 tree `e650392` 上重跑） | `logs/per-task/R02.log` |
| R02-2 `5832a5b` | 同上 | 0 / 0 / 0 / 0 | 同 R02-1（含 27 个新增步骤用例） | `logs/per-task/R02.log` |
| R03-1 `e6c5528` | 同上 + `MerchantDashboardPage.test.tsx` + 面板目录 | 0 / 0 / 0 / 0 | **20 用例通过** | `logs/per-task/R03.log` |
| R04 `2d83e72` | 同上 + ProductEditPage + LivePreviewSandbox | 0 / 0 / 0 / 0 | **19 用例通过**；`offerDrafts.ts` 无改动 | `logs/per-task/R04.log` |
| R05-R07（5 提交） | 同上 + 3 详情测试文件 | 0 / 0 / 0 / 0 | **29 用例通过**（基线同为 29） | `logs/per-task/R05-R07.log` |
| R08-1 `0dcbfe3` | 同上 + 3 卡片测试 + 订单面板 | 0 / 0 / 0 / 0 | **11 用例通过**（含订单面板新增 2 例） | `logs/per-task/R08.log` |
| R08-2 `5f628e0` | 同上 + 4 测试 | 0 / 0 / 0 / 0 | 同 R08-1 | `logs/per-task/R08.log` |
| R09a `3fc6be7` | 同上 + 五个行为分组测试 | 0 / 0 / 0 / 0 | **35 用例通过**（拆分后守恒） | `logs/per-task/R09a.log` |
| R09b `5d9052a` | 同上 + 套餐弹窗测试 | 0 / 0 / 0 / 0 | **43 用例通过** | `logs/per-task/R09b.log` |
| R09c `3824a50` | 同上 + 精选管理测试 | 0 / 0 / 0 / 0 | **24 用例通过**（基线 22，+2） | `logs/per-task/R09c.log` |
| R09d `302e718` | 同上 + AdminProductPanel 测试 | 0 / 0 / 0 / 0 | **9 用例通过**（含新增弹窗测试） | `logs/per-task/R09d.log` |
| R10 `0f14650` | 同上 + StorePage 两测试 + useProductFavorite | 0 / 0 / 0 / 0 | **16 用例通过** | `logs/per-task/R10.log` |
| R11-1 `f50099b` | 同上 + 全量 + build + `cmp` | 0 / 0 / 0 / 0 | 构建产物与基线**逐字节一致**（203909 字节） | `logs/per-task/R11-css-equality.log`、`logs/per-task/R11-build.log` |
| R11-2 `e78b22d` | 同上 | 0 / 0 / 0 / 0 | 同上，最终 bundle 仍逐字节一致 | `logs/per-task/R11-css-equality.log` |
| R12 `02ce14c` | `check:runtime` / `tsc --noEmit` / 五个文件单跑 / 同目录一起跑 / `diff --check` | 全 0 | 五个文件单跑 8/8/3/7/9；同目录 **265 用例通过** | `logs/per-task/R12.log` |
| **最终整合 tree `02ce14c`** | `npm run check:runtime` | 0 | 门通过 | `logs/final-typecheck-build.log` |
| **最终整合 tree `02ce14c`** | `npx tsc --noEmit` | 0 | 0 error | 同上 |
| **最终整合 tree `02ce14c`** | `npm run build` | 0 | `✓ built in 8.16s`；`index-BnBNxjgA.css` 203.91 kB、`index-Dg-s-Ehs.js` 1703.58 kB | 同上 |
| **最终整合 tree `02ce14c`** | `git diff --check` | 0 | 无空白错误 | 同上 |
| **最终整合 tree `02ce14c`** | `npx vitest run` | 0 | **150 文件 / 1253 用例** 全通过 | `logs/final-fulltest.log` |
| **最终整合 tree `02ce14c`** | `cmp` 对比基线 CSS bundle | 0 | **逐字节一致**，哈希 `225c6932…` | 本记录 §5 |
| F03/F04 清理 `831c663` | `npm run check:runtime` / `npx tsc --noEmit` / `npx vitest run`(面板3文件) / `npm run build` | 0 / 0 / 0 / 0 | 3 文件 / 20 用例；`✓ built in 8.21s`；CSS 仍与基线逐字节一致 | `logs/fix-f03-f04.log` |
| F03/F04 清理 `831c663` | `git diff --check a1c27e0 HEAD` | **0** | 修复前为 2（8 处行尾空格 + 1 处 EOF 空行） | 本记录 §5.1 F03 |

### 4.1 全栈 E2E（review F01 返工补跑）

**环境**：本机隔离全栈，未经修改仓库配置。数据库 `monexus_test_catalog_merch_integration`（由仓库自带 `scripts/cmi/dbguard.sh` 管理，`db:seed:force` 每次重播种）；后端 `npm run dev`（3000，`NODE_ENV=test`）；前端 `npm run dev`（5173 = 重构后，5174 = 基线 `a1c27e0` worktree）。

**对照方法**：每次运行前重播种数据库，`--workers=1` 串行执行以消除并发资源竞争；同一后端服务两个前端，`E2E_BASE_URL` 切换目标。失败用例集按 `文件:行:列` 逐一比对。

| 批次 | 覆盖 | 重构后 (passed/failed/not-run) | 基线 a1c27e0 | 失败用例集 |
| --- | --- | --- | --- | --- |
| B1 交付链路 | `product-wizard-purchase-form` + `structured-delivery` + `file-delivery` | 10/1/0 | 10/1/0 | **完全相同** |
| B2 购买/结算 | `checkout-confirmation` + `multi-sku` + `product-exchange` + `product-reviews` | 6/5/7 | 6/5/7 | **完全相同** |
| B3 商家/订单/详情 | `merchant-inventory` + `order-lifecycle` + `product-gallery-interactions` + `checkin` + `profile-avatar` + `store-pagination` + `theme-default` | 6/3/0 | 6/3/0 | **完全相同** |
| B4 移动端 | `mobile-regression` + `mobile-ui-polish` + `mobile-chrome` | 11/7/0 | 11/7/0 | **完全相同** |

**四批全部逐例一致，零例仅重构失败的新增回归。** 原始输出：`logs/clean-{cur,base}-b{1..4}.log`。

**catalog-ops 专用 lane**（任务书 §18.2 要求的专用配置；每次重建隔离库；命令 `bash scripts/verify-catalog-ops-e2e.sh e2e/<spec>`）：

| spec | 结果 | 覆盖的结构改动 |
| --- | --- | --- |
| `catalog-product-lifecycle` | **9/9 passed，gate PASS** | R02 向导创建草稿→容量补充→发布→下架→重新发布；R03 看板操作；R04 编辑 |
| `catalog-category-governance` | **15/15 passed，gate PASS** | R01 表单/审核（create_new、map_existing、reject）/编辑/停用/启用/排序/引用保护 |
| `merchandising-smoke` | **3/3 passed，gate PASS** | R09b 套餐创建与审批；R10 商城混排披露；R09a 活动面板 |
| `catalog-xboard-import` | **4/4 passed，gate PASS** | R09d 表格与导入竞态/幂等 |

原始输出：`logs/e2e-catalog-ops-*.log`。

**未覆盖项**（如实标注，未计为通过）：精选编辑/撤销链路（R09c）与推广活动退款调整弹窗（R09a 部分分支）没有对应的既有 E2E 场景；这些由组件测试（24/24、35/35）覆盖，但没有浏览器级证据。

### 4.2 详情页证据与关键业务链路

**现状摘要（以最新一次执行结果为准）**

| 证据 | 结果 | 日志 |
| --- | --- | --- |
| 渲染等价性 `dom-parity.mjs` | **43 identical / 0 different / 6 真实 N/A / 0 failed**，退出码 0 | `evidence/dom-parity.log` |
| 关键业务链路 `business-paths.mjs` | **两侧 22/22，用例集合 22=22，divergent 0**，退出码 0 | `evidence/business-paths.log` |
| 非预览交互 `detail-interactions.mjs` | **两侧 16 项、14/16、divergent 0**；结果为 `BOTH-SIDES-EQUAL-BUT-FAILING` 并退出 1 | `evidence/detail-interactions.log` |

> 下文各段按复审轮次记录当时的数值（如 37/12、14/14、13/15、9/11），属于**历史轮次结果**，不代表现状；现状以上表与 §6 为准。

**第三轮复审指出：业务链路未跑到终点、动作结果断言缺失、规格选择未监听下单、双端退出码遗漏。以下为逐条修正后的结果。** 三个脚本均可独立重跑。

| 证据 | 脚本 | 原始输出 |
| --- | --- | --- |
| 关键业务链路 | `evidence/business-paths.mjs` | `evidence/business-paths.log` |
| 渲染等价性 | `evidence/dom-parity.mjs` | `evidence/dom-parity.log` |
| 非预览交互 | `evidence/detail-interactions.mjs` | `evidence/detail-interactions.log` |
| 结论与核验 | `evidence/INTERACTION-FINDINGS.md` | — |

**§1 业务链路跑到终点**（两侧均 **22/22**，失败 0、divergent 0、用例集合一致）：改价后报价刷新为新价并**再次确认真的交付成功**；新增必填字段后在**同一个弹窗内**完成阻断→字段出现→空值受拒→填写后交付（不 reload，避免刷新掩盖「原弹窗卡住」回归）；按**选中档**支付并**校验该档库存明文**与订单规格快照；**评价完整链路**（确定昵称、4 星提交、详情核对昵称+完整正文+评分、**修改为 5 星**、再次修改不可用）；**结构化交付**（购前模板不泄露值、成功弹窗账号明文+密码脱敏、眼睛可揭示、订单详情快照默认脱敏）。每一端使用全新 fixture。

**§2 动作结果断言已实现**：每场景显式声明已知前态 → 动作 → 目标后态（图库索引 1→2、选中 SKU 索引与价格改变、目标标签被选中、购买触点滚动后仍可达）。仅预先在能力表中声明的视口记 N/A；未声明缺控件即失败；一侧 N/A 一侧可执行判为能力不对称失败。`--selfcheck` 三项负向自检全部被拒绝，其中**「点击无效」正是复审独立复现的假通过场景**（现报 `expected index 2, got 1/5`）。实测 **43 identical / 0 different / 6 N/A / 0 failed / 0 divergent，退出码 0**（6 项 N/A 均为真实不适用，详见本节末）。

**§3 规格选择已监听下单请求**：桌面切档与移动抽屉选择均安装真实订单 POST 监听并断言请求数为 0；抽屉选项少于两项时明确失败，不再静默跳过。三个脚本另加**用例集合校验**，一端缺少原本通过的检查也判不一致。

**§4 退出码已修正**：三个脚本同时考虑重构端失败、基线失败、divergent。实测交互结果为 `BOTH-SIDES-EQUAL-BUT-FAILING (not a pass; pre-existing behaviour)` 并退出 1，不再输出 ALL-PASS。

**两项交互失败在两侧一致，已由源码确认为既有实现缺失，未计为通过**：`MobileSkuSheet` 关闭路径无焦点恢复（移动标签导航有，`ProductDetailMobile.tsx:197`）；`ProductDetailDesktop.tsx:372` 的 tablist 无 `onKeyDown`，键盘导航仅在移动分支实现。

12 项 N/A 均为能力表中预先声明的视口不适用：768/1023 无 tablist；1024/1440 无该滚动场景定义的购买触点（桌面另有 `desktop-buy-cta`，只是不属于该场景定义的元素）。

## 5. 偏差、失败与未验证项

| 项目 | 基线是否已存在 | 当前影响 | 证据 / 复现方式 | 是否影响完成判定 |
| --- | --- | --- | --- | --- |
| 全栈 E2E 存在既有失败（交付/结算/商家/移动四批） | **是** | 重构后与基线**逐例一致**（10/1、6/5、6/3、11/7） | `logs/clean-{cur,base}-b{1..4}.log`；对照表见 §4.1 | 否（零新增回归） |
| 上表中 16 例失败使部分关键步骤从未执行 | **是** | 已用 `evidence/business-paths.mjs` 把被阻断链路跑到**业务终点**（交付成功、同一弹窗必填字段阻断与放行、按选中档成交与订单快照、评价提交/修改/再次修改限制、结构化交付快照与密码脱敏），两侧均 22/22、用例集合一致、divergent 0 | `evidence/business-paths.log` | 否（已到真实终点） |
| `structured-delivery.spec.ts:91` 定位器与实现不符（用例用 `div.shadow-sm`，订单行实为 `shadow-2xs`） | **是** | 该用例在重构后与基线**都失败**，与本次拆分无关 | 脚本见 §4.1 B1；`git diff --check` 证明 `e2e/` 未被本次改动 | 否 |
| 精选编辑/撤销、活动退款调整缺少既有 E2E 场景 | **是** | 无浏览器级证据，仅组件测试覆盖 | §4.1 未覆盖项 | 否（如实标注，未计为通过） |
| 详情交互两项断言在两侧均失败（抽屉关闭后焦点落 BODY、桌面 ArrowRight 不推进） | **是** | 基线与重构后表现相同；已由源码确认为既有实现缺失（`MobileSkuSheet` 无焦点恢复；`ProductDetailDesktop.tsx:372` tablist 无 `onKeyDown`） | `evidence/detail-interactions.log`、`evidence/INTERACTION-FINDINGS.md` | 否（既有行为，未计为通过） |
| `npx tsc --noEmit` 不覆盖测试文件 | 是（仓库既有配置） | `tsconfig.json` 的 `exclude` 含 `src/**/*.test.ts(x)`；测试文件类型错误不被该命令捕获 | `tsconfig.json` exclude 段；R12 已用等价严格参数单独跑过 | 否 |
| R03-2 未实施 | — | 商品/订单面板状态未下沉 | 任务书 §7 明确允许；探针实测筛选/分页跨标签保留、弹窗挂载点属父层 | 否（有条件子项） |
| `docs/specs/cmi-qa-evidence-map.md:177` 曾引用已删除的 `AdminPromotionCampaignManager.test.tsx` | 是（本次拆分产生） | 无功能影响 | 已更新为指向 `AdminPromotionCampaignManager.review.test.tsx` / `.refund.test.tsx` | 否（已修复）。任务书 `:62,:331` 的两处旧文件名**保留不动**——按 reviewer 意见，它们描述的是历史输入状态，无需替换 |

### 5.1 Reviewer 复审四项的回应

| 编号 | 结论 | 处理 |
| --- | --- | --- |
| **F01** 关键旅程未验证却被计为全部完成 | 接受 | 全栈 E2E 已在隔离环境补跑：四批逐例对照基线（§4.1），catalog-ops 四条 lane 共 31 例全 PASS。任务状态表已逐项补入对应的 E2E 证据与未覆盖项 |
| **F02** 等价性证据已清理、无法复核 | 接受 | 恢复为可独立重跑的脚本与原始输出（`evidence/dom-parity.mjs`、`evidence/detail-interactions.mjs` 及 `.log`），并在 §4.2 写明输入、归一化规则、失败判定与退出码。原先"子代理记录"的引用已替换为实际文件路径 |
| **F03** 空白检查验证了工作区而非交付 diff | 接受 | 清理 `src/styles/30-dock.css` 八处迁移行尾空格与 `90-leaderboard-transitions.css` 末尾空行；`git diff --check a1c27e0 HEAD` 现为 **0**；重建 CSS 仍与基线逐字节一致；未格式化其他文件。提交 `831c663` |
| **F04** 商家后台三段死辅助函数副本 | 接受 | 删除 `MerchantDashboardPage.tsx` 中已迁至 `MerchantProductsPanel` 的三个无消费者副本（`isInstantInventoryProduct` / `getAvailabilityLabel` / `getOfferAvailabilityLabel`），未新增共享模块。提交 `831c663` |

F03/F04 清理与验证记录/证据补齐按要求**分开提交**：清理为 `831c663`，文档与证据为后续 doc 提交。

### 5.2 第二轮复审的回应

| 编号 | 结论 | 处理 |
| --- | --- | --- |
| **§1 假通过**（静态页仍报 49/49 identical） | 接受 | 第二轮已改用真实选择器与前置断言；第三轮进一步实现**已知前态 → 目标后态**断言，并加入三项负向自检：非商品页 5/5 被拒、控件缺失被拒、**点击无效被拒**（复审独立复现的场景）。自检缺少 `--product-id` 时主动判失败 |
| **§2 断言不精确**（价格读动画字符、抽屉命中背景、键盘空断言、中屏判定错误、余额不足缺失） | 接受 | 六项逐条修正并逐条输出实测值；中屏一项原预期本身有误（该分支用粘性 CTA 而非底栏），已按真实契约重写。修正后 10/12，divergent = 0 |
| **§3 相同失败掩盖未执行步骤** | 接受（第二轮部分修复，第三、四轮补全） | 第二轮新增 `blocked-paths.mjs` 只到前置检查；第三轮换成 `evidence/business-paths.mjs` 并跑到业务终点；第四轮补齐评价修改/再次修改限制与结构化交付快照。**最终两侧均 22/22、用例集合一致、divergent 0**（本轮为 14/14，数值已随覆盖扩大更新）。未修复无关的历史 E2E |

### 5.3 第三轮复审的回应

| 编号 | 结论 | 处理 |
| --- | --- | --- |
| **§1 业务链路未跑到终点** | 接受 | 新增 `evidence/business-paths.mjs`：改价后验证新报价并**再次确认交付成功**；必填字段在**同一弹窗**内阻断 → 字段出现 → 空值受拒 → 填写后成功；按选中档支付并**校验该档库存明文**与订单规格快照；**评价提交/展示/修改/再次修改限制**；**结构化交付快照与密码脱敏**。**最终两侧均 22/22、divergent 0**（本轮为 14/14，第四轮已扩大到 22 项） |
| **§2 动作结果断言缺失**（控件存在但点击无效仍通过） | 接受 | 每场景改为已知前态 → 动作 → **目标后态**断言；N/A 仅限预先声明的视口不适用；新增三项负向自检，**「点击无效」现报 `expected index 2, got 1/5`**（正是复审复现场景）。缺少 `--product-id` 时自检主动失败 |
| **§3 规格选择未监听下单请求** | 接受 | 桌面切档与移动抽屉选择均安装真实订单 POST 监听并断言为 0，同时保留无结算弹窗断言；多规格 fixture 少于两项即失败 |
| **§4 退出码忽略基线与 divergent** | 接受 | 三个脚本退出码同时考虑重构端失败、基线失败、divergent；实测输出 `BOTH-SIDES-EQUAL-BUT-FAILING (not a pass; pre-existing behaviour)` 并退出 1 |
| 文档整理（旧终点、49/9-11 残留、`outputs` 归属） | 已处理 | §1 改为「最后一个改源码的提交 `831c663`」；§4.2 与 §5 的 49/9-11 表述统一替换为 37/14-14/13-15；`outputs/*.png` 更正为**已跟踪文件**，改动源自我的 E2E 运行，已还原至 HEAD |

本轮没有改动任何生产源码：`831c663` 仍是最后一个改源码的提交，其后全部为 `docs/**` 变更。

### 5.4 第四轮复审的回应

| 编号 | 结论 | 处理 |
| --- | --- | --- |
| **§1 六个移动标签场景被错误标为 N/A** | 接受 | 能力表原先把 mobile-320/390/767 设为 `tabs: false`，使 6 个移动标签场景被跳过、适用数从 43 降到 37。源码 `ProductDetailMobile.tsx:384–403` 确实渲染 `role=tablist`/`role=tab`，故改为 `tabs: true`，6 项恢复执行并通过。适用数回到 **43**，N/A 回到 **6**（均为真实不适用） |
| **§2 业务清单未全部覆盖** | 接受 | 补齐评价昵称/评分核对（读 `StarRating` 的 aria-label「评分 4 / 5」而非文本）、修改为 5 星并验证更新、再次修改入口不可用；新增结构化交付场景：购前模板不泄露值、成功弹窗账号明文+密码脱敏、眼睛可揭示、**订单详情字段快照默认脱敏**。脚本顶部注释所列目标现均已实现。两侧 **22/22**、用例集合一致 |
| **§3 必填字段绕过原弹窗** | 接受 | 移除 `gotoProduct` 整页刷新，改为在**同一个弹窗**内：确认被拒 → 断言**原弹窗仍打开** → 断言**原弹窗内出现新字段** → 空值不可提交 → 原弹窗内填写后交付成功。全程不 reload，避免掩盖「服务端拒绝后原弹窗卡住」这类回归 |
| 判定稳健性收尾 | 已处理 | 三个脚本加入**用例集合校验**（一端缺少原本通过的检查即判不一致并计入退出码）；抽屉选项少于两项**明确失败**，不再静默跳过 |
| `evidence/README.md` 旧命令 | 已处理 | 移除已删除的 `blocked-paths.mjs` 命令，改为 `business-paths.mjs`；`--selfcheck` 命令补上必需的 `--product-id`（缺省会判失败） |

本轮同样没有改动任何生产源码。
| **交付记录整理** | 已处理 | 旧源码终点与 doc-only 提交的表述已在 §6 修正；失效证据路径已替换为现存文件；`docs/specs/cmi-qa-evidence-map.md` 的测试引用已更正 |
| `outputs/*.png` 三个工作区改动 | **不属于既有状态** | 这三张 PNG 是**已跟踪文件**（`.gitignore` 只忽略 `outputs/mail-previews/`，我上一轮称其被忽略是错的）；改动由我的 catalog-ops E2E 运行（`e2e/merchandising-smoke.spec.ts` 会重写它们）产生。已 `git checkout` 还原到 HEAD，工作区现为干净 |

逐项确认并说明证据：

- **用户可见文案、DOM/ARIA、视觉或交互是否发生变化：无。** 证据分层：`evidence/dom-parity.mjs` 在 7 视口 × 7 场景上做已知前态→目标后态断言并比对整页 DOM，**43 identical / 0 different / 6 真实 N/A / 0 failed，退出码 0**；`evidence/business-paths.mjs` 把关键业务链路跑到终点，**两侧均 22/22、用例集合一致、divergent 0**；`evidence/detail-interactions.mjs` 断言 **16 项**非预览交互，**两侧 14/16、divergent 0**，两项失败由源码确认为既有实现缺失；各任务另有各自的归一化 DOM 对照（R04 merchant+admin 两态字节相同；R09a 列表/详情/7 种操作弹窗 byte-identical；R09c 23 个状态 byte-diff 一致；R02 className 与 `data-testid` 集合机械比对）。CSS 层由最终 bundle `cmp` 逐字节一致背书。
- **API 请求、权限、版本冲突、重复提交、过期响应处理是否发生变化：无。** R09d 的 `productsReloadGuard`/`StaleProductsReloadError` 全路径留父层，草稿与生效筛选分离、末页回退逐字未动；R09a 的 `requestId` 陈旧守卫、`ACTIONS_BY_STATUS` 未知状态 no-op、退款数值校验、幂等 fingerprint ref 留父层；R04 的 CAS 409、`checkoutVersion` 更新与重试、`handleSave` 仅 2 处等价 helper 替换；R02 的 `draft ||`/`savingRef`/`createProductV2` 零改动行；R08 的 10 条 API 调用点表达式完全一致。
- **第一批的校验文案差异和未知履约配置行为是否保持：是。** 两页 `validateDeliveryFieldRows` 冒号差异仍在；两类交付编辑器 `create`/`edit` 差异保留；`FieldLabel` 的 `children`/可选 `required` 契约未改；创建页忽略未映射枚举值、编辑页保留 `manual_service` 回退，`git diff` 对相关行零改动。
- **CSS 条件、声明和覆盖顺序是否保持：是，且为最强证据。** 最终整合 tree 与 F03 清理后的 `dist/assets/index-BnBNxjgA.css` 均与基线**逐字节一致**（sha256 `225c6932a743fe159dd66d735a4bac388f8b74d059c082a829c1e4804c796cf8`）。实测四条关键事实：`@import` 置于 `@tailwind` 之后会被 PostCSS 静默丢弃整个文件且 exit 0（故一律置顶）；`@layer components` 放进无 `@tailwind components` 的新文件会 exit 1（故三个 `@layer` 块与 `@tailwind` 同留 `00-tailwind-layers.css`）；`@layer` 在文件内物理位置不影响产物；相邻同条件 `@media` 会被合并（这是能切进巨型媒体块内部的前提）。
- **存在未执行的关键旅程测试或浏览器核验：是**，即 §4.1 列出的"未覆盖项"（精选编辑/撤销、活动退款调整），以及 §4.2 两项两侧均失败的交互断言。均已如实标注，未用新增 mock 绕过，未计为通过。
- **是否存在超出任务书范围的修改：无。** 未改 `server/**`、API DTO、履约规则、支付/积分规则、状态枚举、路由配置、依赖版本、锁文件、构建预算、CI、ESLint（仓库本无 ESLint 配置与 lint 脚本）。未批量格式化，未加 skip/todo，未删断言，未降低 TypeScript 检查。R11 只改了必要 CSS 入口引用，未改工具链。各任务清理了全部临时探针/基线副本/对照脚本（`__probe.test.tsx`、`__BaselineProductEditPage.tsx`、`__domParity.test.tsx`、`__actorRouting.test.tsx`、`r09cDomSnapshot.test.tsx`、`verify-*-parity.mjs`）。

## 6. 交回 Review

实施 agent 的最终交接摘要（第三次交付，含三轮复审返工）：

- **交付分支**：`refactor/frontend-module-boundaries`（worktree `/root/projects/MoNexus-frontend-module-split`）。
- **输入快照基线 SHA**：`a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a`（同仓库 tag `refactor-snapshot-base`）。
- **最后一个改源码的提交**：`831c663`。**此后所有提交仅改 `docs/**`**，不改变 review 范围。
- **代码提交数**：21（R01 在主分支完成；R02–R12 的 19 个在隔离 worktree 完成后按序 cherry-pick 并保留 `-x` 溯源；返工清理 1 个）。
- **改动规模**：目标文件行数见 §3；行数仅作辅助数据，不作为正确性证据。
- **验证结论**：
  - 组件/单元测试：**150 文件 / 1253 用例全通过**（基线 136/1176）。
  - 生产构建 exit 0；`npx tsc --noEmit` exit 0；`git diff --check`（工作区与范围）均 0。
  - CSS bundle 与基线**逐字节一致**（F03 清理后仍一致，203909 字节）。
  - 全栈 E2E：四批与基线**逐例一致、零新增回归**；catalog-ops 四条专用 lane 共 **31 例全 PASS**。
  - **关键业务链路**（`evidence/business-paths.mjs`）：两侧均 **22/22**、用例集合一致、divergent 0；覆盖改价后重确认与交付、同一弹窗内必填字段阻断与放行、按选中档成交与订单快照、评价提交/修改/再次修改限制、结构化交付快照与密码脱敏。
  - **渲染等价性**（`evidence/dom-parity.mjs`）：**43 identical / 0 different / 6 真实 N/A / 0 failed**，退出码 0；三项负向自检全部被拒绝。
  - **非预览交互**（`evidence/detail-interactions.mjs`）：两侧 **16 项**、divergent 0；两项失败由源码确认为既有实现缺失，未计为通过。
- **未通过/未覆盖项**：精选编辑与撤销、活动退款调整缺少既有 E2E 场景；抽屉关闭后焦点恢复与桌面 ArrowRight 导航为既有实现缺失。均已在 §4.1、§4.2、§5 标注，未计为通过。
- **原工作区核对**：`/root/projects/MoNexus-new` 的 `git status --short` 与 `git diff` 与开工归档逐字节一致，HEAD 仍为 `20f493a`；他人改动未被触碰。未 push、未发布、未部署、未自动合并。
- **证据归档**：`/root/projects/monexus-refactor-artifacts/`（`COORDINATION.md`、`E2E-COMPARISON.md`、`evidence/`、`logs/`、`original-agent-review/`）。

原 agent 的 review 结论：第一轮 `findings.md`（F01–F04）、第二轮 `round2-findings.md`、第三轮 `round3-findings.md`，均已在 §5.1–§5.3 逐条回应。下一轮审查结论待填写。

## 7. 实施 worktree / 任务分支与原始提交

各任务在独立 worktree 与独立分支完成，随后按 R01→R12 顺序 cherry-pick 到交付分支（保留 `-x` 溯源）。全部 worktree 均已确认工作树干净，临时探针/基线副本/对照脚本已清理。

| 任务 | 实施 worktree | 任务分支 | 任务分支原始提交 | 交付分支提交 |
| --- | --- | --- | --- | --- |
| R01 | `/root/projects/MoNexus-frontend-module-split` | `refactor/frontend-module-boundaries` | 在主分支直接完成 | `0372ea6a690daeba41e59e91c6ff4218e4019b2c` |
| R02-1 | `/root/projects/monexus-r02` | `refactor/r02` | `4f2ddf21bb977d69c2c36a3c3fb1ec7767a7c9bc` | `373b6a6c7f4dec05a77efe862010f3113ad0bb00` |
| R02-2 | `/root/projects/monexus-r02` | `refactor/r02` | `442dfc84a610a32c5aa6b5f9a254d015f5b5f7a4` | `5832a5bd0571ef298d9414aa6ac965df1fc5e2c3` |
| R03-1 | `/root/projects/monexus-r03` | `refactor/r03` | `9d15956ab0f7a5df4748e7d3e5d083b31b0c3f54` | `e6c55284a58ea5af34cebcc8145536044694f759` |
| R04 | `/root/projects/monexus-r04` | `refactor/r04` | `9c7a681dd4bfa01d0e47ad3da681ae0f6fe09060` | `2d83e72b76026bd51d84c28dabdfdec90c122393` |
| R05-1 | `/root/projects/monexus-r05` | `refactor/r05` | `fa8d29910b363a566b3c328cd81969a8e2f0b81c` | `c8193337864a3829be984b2fb0331835287a8a71` |
| R05-2 | `/root/projects/monexus-r05` | `refactor/r05` | `48472e40c6f33ed9a9e4ca47d6b141e36b113c25` | `4f07df8eb182c544a86993ce4246a5f5bde2a0ab` |
| R06 | `/root/projects/monexus-r05` | `refactor/r05` | `b02c71e25706a73c82cc49ad6012f11087d6e245` | `99d7fbd7be25493277819dd342373704e63a61f7` |
| R07-1 | `/root/projects/monexus-r05` | `refactor/r05` | `4d1835597aaad44b47d768f0e8b778382b9b7503` | `69fdc1ce88cd1d24d7b4ec8aa708d67f04f65736` |
| R07-2 | `/root/projects/monexus-r05` | `refactor/r05` | `56242367ab86a42dd8bf057b43d5b06e9ec35470` | `24d2313bfd5ccf3b8143f1532adc70c8f0cb26d3` |
| R08-1 | `/root/projects/monexus-r08` | `refactor/r08` | `4e898aa9ab51a1daf0bf2366f96de55ed3fc547e` | `0dcbfe3e270e22df61d366037ea9e3a368918fa2` |
| R08-2 | `/root/projects/monexus-r08` | `refactor/r08` | `d0d8b0ecb18a25e5078fd3a0155314d59abd9465` | `5f628e0847c9ca89fc6119c9ed5ad46bf1fd9830` |
| R09a | `/root/projects/monexus-r09a` | `refactor/r09a` | `e51a36de918f47c779837f8cdfdda5d07fe99bfc` | `3fc6be7a89d64b13ed5f8630509428b5601239d9` |
| R09b | `/root/projects/monexus-r09b` | `refactor/r09b` | `7e897f6ad3c04c8072d39ac383c9386ac3869090` | `5d9052ab8ce27e95ba6d41df176ff338f9b89148` |
| R09c | `/root/projects/monexus-r09c` | `refactor/r09c` | `e0dacc0e5e8cc3fefb44690ab56759a74728a9ae` | `3824a509f6eaa00f7676b3d89b080d8e70761cd5` |
| R09d | `/root/projects/monexus-r09d` | `refactor/r09d` | `861ca9fe4ecab11c96f08a8741501a8736515a0e` | `302e71883226fe1f2e30105b4f7811f252401fc2` |
| R10 | `/root/projects/monexus-r10` | `refactor/r10` | `1c9b0c877cef4613200d70d3314f9e4d5e5932d4` | `0f146502408d90061e439a9ace8e00d8cb217fde` |
| R11-1 | `/root/projects/monexus-r11` | `refactor/r11` | `9958e7f829e2d81d7b5b66f2acd1d66fef6b6daa` | `f50099b341a4c05758694663dfd8999f798206e9` |
| R11-2 | `/root/projects/monexus-r11` | `refactor/r11` | `ec4d13cb56301ab6858ede8358ef35498909e3ac` | `e78b22d78c49f3d70d49cdb282abe6b7cb630f08` |
| R12 | `/root/projects/monexus-r12` | `refactor/r12` | `44145622f9f773df1b1c89937bfda21c42ee5bd5` | `02ce14cf614ffce089ccb8f67e283128a5dcf729` |

证据归档目录：`/root/projects/monexus-refactor-artifacts/`（`COORDINATION.md`、`00-source-*` 源工作区状态与 diff、`00-copylist.txt` 与拷贝前后哈希、`00-baseline-dist-hashes.txt` 基线产物哈希、`logs/` 验证日志）。
