# 移动端体验重构总纲（Spec）

> 状态：**已确认方向（2026-07-31，三大举措全票通过），T1–T7 已实施并验收**。
> 分支：`feat/mobile-ui-polish`（基于 `origin/develop`，独立 worktree）
> 创建：2026-07-31

## 1. 背景与问题

全站桌面端体验已成型（Indigo/Slate 设计系统、`.table-cards` 响应式表格、`MobileNavDrawer` 抽屉、40px 触控契约），但移动端（<768px）仍是「桌面缩小版」，核心购物流程效率低。经全量代码审计（27 个弹窗、11 个页面、全部共享组件），确认以下事实性问题：

### 1.1 导航架构（最重）

- **无底部主导航**：移动端切换「商城 / 公告 / 我的」必须 汉堡 → 抽屉 → 找入口，3 步起步；电商行业标准为核心目的地 ≤1 步（底部 Tab Bar）。
- **公告 FAB 遮挡内容**：`MobileAnnouncementFab` fixed 右下角（`AnnouncementCenter.tsx:69`），无 safe-area 偏移，`<main>` 无底部留白补偿 → 遮挡页面底部按钮/内容；且与 Toast（`fixed bottom-10`，z-80）垂直重叠，Toast 直接盖住 FAB。

### 1.2 商城浏览效率（最重）

- 商品网格 <768px 单列、卡片固定高 356px（`StorePage.tsx:53,64-68`）→ 一屏仅 ~1.5 个商品，浏览效率远低于双列网格（淘宝/京东/拼多多标准形态）。

### 1.3 弹窗体系

- 全部 27 个弹窗均为居中卡片，无一有移动端形态；其中 **5 个在内容超高时产生不可滚动的裁切**（P1）：`PurchaseModal`（兑换确认，主转化路径！）、`AnnouncementsAdmin` 编辑器、`MerchantInventoryImportModal`、`MerchantOfferManagerModal`、`MerchantDeliverDialog`。
- `.modal` 基类无 `max-height`/`overflow`（`index.css:369-378`）；6 处 `vh` 高度（非 `dvh`）在移动 Safari 可超出可见视口。
- `AnnouncementCenter` 滚动子容器缺 `flex-1 min-h-0`（`AnnouncementCenter.tsx:123`），公告多时可溢出 85vh 盒外。

### 1.4 后台导航

- AdminPage 13 个导航项在移动端全宽纵向平铺（`AdminPage.tsx:280-295`），内容区被推至 ~600px 之下；MerchantDashboardPage 6 个 Tab 同病（`MerchantDashboardPage.tsx:301-320`）。
- `MerchantDashboardPage.tsx:535` 订单待办 `grid-cols-3` 无响应式变体，320px 下每卡 ~90px。

### 1.5 系统级适配

- `index.html` viewport 缺 `viewport-fit=cover`；全仓 `env(safe-area-inset-*)` **零使用** → 刘海屏/Home 指示条区域无适配；无 `theme-color` meta。
- **iOS 输入自动缩放**（<16px 输入框聚焦触发）：`AdminPage.tsx:1079/1094/1107`（12px！）、`AdminConfigPanel.tsx:127`、`MerchantOfferManagerModal.tsx:510/522`、`TrendChart.tsx:81`（select 14px）、`AdminFakaTasksPanel.tsx:99/114/127`（且引用未定义的 `admin-input`/`admin-btn-secondary` 类，无样式渲染）。
- 触控目标 <40px（项目 e2e 契约线）：`StarRating` 星标 ~28px、`AdminPage.tsx:806/813` 分页 ~26px、`FileDeliveryCard.tsx:59` ~36px、`ReviewDialog.tsx:58,63` ~36px、`PurchaseModal.tsx:342/366/444/468` ~30px。

### 1.6 页面级布局

- `ProductDetailPage.tsx:274-287` 标题块 absolute 覆盖在移动端仅 256px 高的主图上，Orbitron `text-3xl` 无 line-clamp → 长商品名溢出/遮挡图片；`prose` 类为空操作（未装 typography 插件），富文本内表格/长 URL 可横向溢出。
- `ProfilePage.tsx:531-553` 订单卡头部无 `flex-wrap`/`min-w-0`，≤360px 挤压溢出；`621-639` 积分流水同病。
- `ProductCreateWizard.tsx:462-475` 图片操作纯 hover 揭示（触屏不可发现）；`710` 名额 `grid-cols-2` 无响应式。
- `TrendChart.tsx:114-121` tooltip 无边界处理，窄屏溢出被裁。

## 2. 设计方向：Mobile-Native Commerce

移动端不是桌面的缩小版，而是独立的信息架构。五大举措：

### M1. 移动端骨架：底部 Tab Bar + 安全区体系

- 新增 **`BottomTabBar`**（仅 <md 渲染，fixed 底部，z-30）：
  - `首页`（/）、`公告`（带未读 badge，点击打开公告中心而非跳转）、`商家/管理`（按 role×status 条件出现）、`我的`（/profile）
  - 高度 56px + `env(safe-area-inset-bottom)`；激活态 indigo 图标+文字，非激活 muted
- **移除右下角公告 FAB**（入口并入 Tab Bar），同时解决 FAB 遮内容与 Toast 盖 FAB 两个 P1
- Toast 移动端位置抬升至 Tab Bar 之上：`bottom = 56px + safe-area + 12px`（桌面不变）
- `<main>` 移动端 `padding-bottom: 56px + safe-area + 16px` 补偿，任何内容不被 Tab Bar 遮挡
- `index.html`：`viewport-fit=cover` + `theme-color`（light/dark 双 meta）
- CSS 新增 safe-area 工具类（`.pb-safe` 等）与 `--tabbar-h` 变量
- 汉堡抽屉保留（主题切换、积分、工作台次级入口），e2e 抽屉契约不变

### M2. 商城双列网格

- <768px：商品卡 **2 列紧凑形态**——图片区降低、隐藏描述行、名称 `text-sm` 两行钳制、价格/销量行紧凑；卡片高度按断点分桶（<768 紧凑高；≥768 保持 356px），虚拟滚动 `CARD_HEIGHT`/`GRID_GAP`/`getColumnCount` 同步参数化
- 骨架屏列数/高度同步

### M3. 弹窗移动化：底部动作面板（Bottom Sheet）

- `ui/Dialog` 的 `DialogContent` 增加移动端形态：<md 时贴底全宽、顶部圆角、上滑进入、`max-h-[92dvh]`、内部滚动、顶部 drag-handle 视觉条；≥md 保持居中卡片不变
- `.modal` 基类兜底：`max-h: calc(100dvh - 2rem)` + `overflow-y: auto` + `overscroll-behavior: contain`（立即修复全部裁切类 P1）
- 全仓弹窗 `vh` → `dvh`
- `AnnouncementCenter` 滚动区补 `flex-1 min-h-0`

### M4. 后台导航移动化：横向 Tab 条

- AdminPage / MerchantDashboardPage 侧栏在 <md 转为**横向可滚动 pill 条**（`overflow-x-auto hide-scrollbar`、`shrink-0`），激活态沿用现有 indigo 填充；≥md 保持侧栏不变
- MerchantDashboard 订单待办统计卡移动端紧凑排版

### M5. 页面级打磨清单

- ProductDetail：移动端标题移出图片覆盖层（<lg 进入文档流，图片区纯展示）；富文本自定义样式（表格包 overflow 容器）；价格块允许收缩
- Profile：订单卡头部/积分流水 `flex-wrap` + `min-w-0` 修复
- iOS 缩放：涉及输入全部 ≥16px；`AdminFakaTasksPanel` 未定义类替换为 `.input`/`.btn-secondary`
- 触控：StarRating 星标触控区扩至 40px（视觉尺寸不变，加透明 padding）；各处 `px-3 py-1` 按钮补 `btn-sm`
- Wizard：图片操作触屏常显（仅 ≥md hover 揭示）；名额区 `grid-cols-1 sm:grid-cols-2`
- TrendChart：select 16px；tooltip 近边缘时翻转对齐
- MerchantDisputeDialog 按钮行 `flex-wrap`

## 3. 已确认的取舍决定

| 决定 | 理由 |
|---|---|
| Tab Bar 仅 3–4 个目的地，不做「分类」独立 Tab | 分类已是商城页内横滑 chips，双入口割裂；Tab Bar 只放跨页面主导航 |
| 公告 Tab 打开弹层而非独立路由页 | 公告中心已是成熟 Dialog，新增路由页 = 重复建设；badge 逻辑零改动 |
| 弹窗移动形态做在共享 `DialogContent` + `.modal` 基类，不逐个重写 27 个弹窗 | 一次改造全局受益；个别弹窗（max-w 等）通过 className 自然覆盖 |
| 保持 40px 触控契约，不升级 44px | `e2e/mobile-regression.spec.ts` 运行时断言 ≥39.5px；改标准 = 改测试契约，超出本分支范围 |
| 双列卡片用「断点分桶固定高」而非逐卡测量 | 虚拟滚动依赖均匀行高；分桶（<768 / ≥768）简单确定，无运行时测量成本 |
| 不引入手势库/新依赖 | Radix + CSS 足够；保持 bundle 与维护面最小 |
| FAB 移除而非移位 | Tab Bar 公告入口完全覆盖 FAB 职能；移位只是换个地方遮内容 |

## 4. 不变量（所有阶段必须保留）

1. **e2e 移动端契约全绿**：`e2e/mobile-regression.spec.ts`——汉堡 320px 可见可开抽屉、抽屉内主题三 radio ≥40px、商家后台入口、TrendChart 交互、关键页面全部可见按钮 ≥40px。
2. **桌面端（≥768px）视觉与布局零变化**：所有移动端形态用 `md:` 前缀隔离。
3. **设计 token 体系不变**：不改色板/字体/阴影；新样式一律消费既有 `--color-*`/`--space-*`/`--radius-*`/`--shadow-*`。
4. **Dark mode + soft 主题机制不动**：`index.html` boot script、`dark` class、`data-theme` 不触碰（仅追加 meta/attribute）。
5. **既有移动端好模式保留**：`.table-cards`、`btn-sm`/`icon-btn` 触摸放大、`MobileNavDrawer`、`.input` 16px 基准、`min-h-[100dvh]`、横幅文档流内、LoginShell `overflow-auto`、z-index 分层契约（footer 10 < FAB/tabbar 30 < navbar 40 < overlay 45 < modal 50 < toast 80/90 < 嵌套弹窗 120）。
6. **`.fade-in`/Reveal 动画与 `prefers-reduced-motion` 底线不动**。
7. **禁止 emoji 当 icon**（Lucide）、**禁止 layout-shifting hover**、**对比度 ≥4.5:1**、**过渡 150–300ms**、**focus 可见**。
8. **虚拟滚动行为不回归**：StorePage 滚动恢复、无限加载、`data-testid="store-load-more"`/`store-stock-*` 全部保留。

## 5. 阶段划分（Tasks）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **T1 基座** | viewport-fit + theme-color；safe-area 工具类与 `--tabbar-h`；`.modal` 基类 max-h/overflow/dvh 兜底；6 处 vh→dvh | ✅ 完成 |
| **T2 Tab Bar** | `BottomTabBar`（新组件）+ Layout 集成 + main 底部补偿 + 移除 FAB（testid 契约迁移到 Tab）+ Toast 抬升 + AnnouncementCenter `min-h-0` | ✅ 完成 |
| **T3 商城双列** | 列数/卡高(240px)/间距(12px)按断点参数化；紧凑卡片（隐藏描述、text-sm 双行、chips 缩小）；骨架同步 | ✅ 完成 |
| **T4 弹窗 Sheet 化** | `DialogContent` 移动形态（全宽贴底/顶部圆角/上滑/92dvh/拖拽条/safe-area）；`MerchantInventoryImportModal` 补 max-h；`MerchantDisputeDialog` flex-wrap | ✅ 完成 |
| **T5 后台 Tab 条** | Admin 13 项 / Merchant 6 项 → sticky 横向 pill 条；订单待办紧凑排版 | ✅ 完成 |
| **T6 页面打磨** | ProductDetail 标题入流/价格收缩/`.rich-text`；Profile 两处溢出；iOS 缩放 5 处 + 未定义类修复；触控 6 处（StarRating/分页×2/下载/评价/兑换验证码×4/导入）；Wizard 2 处；TrendChart select+tooltip 钳制 | ✅ 完成 |
| **T7 验收** | build 绿；全量 e2e 63+4 通过（4 例失败经单 worker 隔离复跑全绿，确认为共享库并行抖动）；新增 `e2e/mobile-ui-polish.spec.ts` 8 项几何契约全绿 | ✅ 完成 |

## 6. 验收标准

1. `npm run build`（tsc + vite）零错误。
2. `e2e/mobile-regression.spec.ts` 全绿；`store-pagination` / `product-exchange` / `checkout-*` / `announcements` / `merchant-inventory` / `product-wizard-purchase-form` / `order-lifecycle` 不回归。
3. 320px/375px/414px 视口：无横向滚动；无任何内容被 fixed 元素（navbar/Tab Bar/Toast）遮挡；三大目的地 ≤1 步可达。
4. 全部弹窗在 320×568 视口内完整展示且可滚动到底部按钮。
5. 全部输入框字体 ≥16px（iOS 聚焦不缩放）；全部可见按钮触控 ≥40px。
6. 桌面端 1440px 视觉走查零差异。

## 7. 非目标（Non-goals）

- 不改桌面端任何布局/视觉；不改设计 token 色板；不改后端/API；不引入新依赖。
- 不做 PWA/离线/原生手势（下拉刷新、滑动返回）——后续独立评估。
- 不做商家/管理后台的信息架构重组（仅导航呈现移动化）。
- 不迁移仍在旧 `--c-*` token 的组件（属 `feat/ui-redesign` Phase 4 范畴）。

---

# V2：Apple 式丝滑动效与信息密度重构（2026-07-31 追加）

> 用户反馈：动画不够丝滑；内容多的页面（典型：商品详情）移动端滚动过长；三角色页面布局需精修至「Apple 简约高级」水准。**仍仅限 <768px**，桌面端逐像素不动。

## 8. 问题诊断（V2）

1. **动效偏「钝」**：页面入场 `fade-in` 0.5s/15px 拖沓；卡片无按压反馈（iOS 核心手感缺失）；弹层遮罩瞬时出现无过渡；骨架屏为静态灰块；Tab 切换无过渡。
2. **商品详情滚动过长**：移动端依次为 主图→标题→SKU→交付说明→价格卡（p-6 大留白）→余额行→巨大的兑换按钮→图文介绍→评价，购买 CTA 在滚动中迅速离场，用户买完要来回翻。
3. **密度失衡**：后台主卡片 `min-h-[600px]`/`p-6 sm:p-8` 在移动端制造大片空白；商城页头标题块占首屏；筛选/统计卡留白按桌面标准。
4. **商城长列表无锚点**：搜索+分类滑走后无法触达，长列表浏览效率低。

## 9. 设计方案（V2）

### V2-M1 动效系统（Apple Motion）

- 新增运动 token：`--ease-standard: cubic-bezier(0.32,0.72,0,1)`（iOS 标准 ease-out）、`--ease-spring: cubic-bezier(0.34,1.3,0.64,1)`（轻回弹）、`--dur-fast/med/slow: 150/250/380ms`
- 页面入场（仅 <md 覆盖）：0.38s / 8px / ease-standard —— 快而稳，不拖沓
- **按压反馈**（iOS 核心手感）：商品卡、列表行、Tab、关键按钮 `active:scale-[0.97~0.98]` + 150ms，全部 `max-md:` 隔离
- 弹层遮罩淡入 250ms（仅 <md）；Sheet 上滑换用 ease-standard 0.34s
- 骨架屏：静态灰块 → **微光扫过（shimmer）** 动画
- Tab Bar 激活：图标 105% 微缩放 + 颜色 150ms 过渡
- `prefers-reduced-motion` 全局底线不变

### V2-M2 商城（买家）：粘性搜索 + 紧凑页头

- 搜索框 + 分类 chips 在 <md **sticky 吸附**于导航栏下（blur 背景，与后台 pill 条同套机制），长列表随时可搜可切
- 页头「发现实用好物」块移动端紧凑化（字号/间距下调，省 ~40px）
- 商品卡：`max-md:active:scale-[0.98]` 按压反馈

### V2-M3 商品详情（买家）：固定购买条 + 密度重构

- <md 新增**固定底部购买条**（价格 + 立即兑换 CTA，64px + safe-area，z-30，复用现有售罄/余额不足逻辑），CTA 永不离场；原页内大按钮 `max-md:hidden`（桌面保留）
- **BottomTabBar 在 `/product/:id` 隐藏**（任务沉浸页，行业标准：详情页让位于行动条）
- 页密度：各 section 间距 mb-8→`max-md:mb-6`、卡 padding `max-md:p-4`、价格卡/图文/评价全面收紧

### V2-M4 商家/管理：密度与首屏

- Admin 主卡片 `min-h-[600px]`→`max-md:min-h-0`、`p-6 sm:p-8`→`max-md:p-4`；Merchant 主卡片 `min-h-[500px]` 同处理
- 商家统计卡/数据页卡片移动端 padding 收紧

### V2-M5 个人中心/登录：轻量密度

- Profile 各 section 间距收紧（轻触，不动结构）

## 10. 不变量（V2 追加）

9. 一切 V2 变更以 `max-md:`/`md:` 或 `<md` 媒体查询隔离，桌面端零视觉/动效差异（fade-in 桌面参数不变）。
10. 购买条复用现有 CTA 状态机（售罄/余额不足/正常），不新增业务逻辑；`data-testid` 契约保留（页内 CTA 桌面可见，购买条 CTA 新增独立 testid）。
11. V1 全部契约（Tab Bar 贴底/抽屉/触控 40px/双列网格/Sheet 形态）不得回退。

## 11. 阶段（V2 Tasks）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **V1 动效基座** | 运动 token；fade-in 移动版；pressable；遮罩淡入；sheet 曲线；shimmer；Tab 过渡 | ✅ 完成 |
| **V2 商城** | 粘性搜索 chips；页头紧凑；卡片按压 | ✅ 完成 |
| **V3 商品详情** | 固定购买条 + Tab Bar 隐藏 + 密度重构 | ✅ 完成 |
| **V4 后台密度** | Admin/Merchant 主卡 min-h/padding 移动化 | ✅ 完成 |
| **V5 验收** | build + e2e（含契约 spec 更新） | ✅ 完成 |

---

# V3：灵动岛交互与 chrome 重构（2026-07-31 第三轮用户反馈）

> 反馈：① Profile 流水明细藏在页面底部 Tab，切了也看不见 → 要弹窗化；② 底部 Tab Bar 磨砂透明 + 常驻观感差；③ navbar 能否像灵动岛——下滑收缩悬浮；④（追加）搜索/分类全部收纳进灵动岛，「一切交互放在上面」；⑤ sticky 搜索色带样式怪异（被④取代）。

## 12. 设计方案（V3）

### V3-T1 流水明细 Sheet 化
- 新组件 `PointsHistorySheet`（共享 Dialog → 移动端自动 bottom sheet）：积分卡「查流水明细」按钮直达，免滚动；客户端分页 30 条/页「加载更多」；**每次打开重新拉取**（覆盖签到/退款全部变动，首屏少一个请求）
- Profile 移除 Tabs 结构：单栏「我兑换的商品」section（加标题），`activeTab` 状态机删除

### V3-T2 Tab Bar 实心化 + 滚动自动隐藏
- 背景：`surface/95 + blur` → **不透明实心 surface**（用户反馈去磨砂）
- 自动隐藏：下滑 >6px 收起（translateY 100%）、上滑即现、近顶恒现；300ms ease-standard；阅读时释放 56px+safe 视高

### V3-T3/T4 灵动岛 navbar + 搜索岛
- **药丸态**：移动端 scrollY>48 navbar 内层收缩为居中悬浮胶囊（w-fit、实心 surface、圆角、阴影），品牌文字宽度动画归零（防 320px 超宽），Logo/头像同步缩小（头像守住 40px 契约下限）；回顶 <32 恢复全宽（滞回）
- **搜索岛**（商城页·移动视口）：navbar 右侧搜索图标 → 点击后 navbar **morph 为搜索卡片**（实心 surface 圆角卡片 + input 自动聚焦 16px + 分类 chips 行 + 轻遮罩聚焦）；选分类/Enter/取消/点遮罩收起；`fade-in` 150ms 换血 + 容器 transition-all 300ms morph
- **状态共享**：`storeQuery/storeCategory` 上提 `appStore`——岛内交互与 StorePage 网格同源；StorePage 页内搜索区**条件渲染**（移动端不渲染，DOM 唯一，placeholder 契约无歧义）
- 页面主体全留给商品流：首屏 hero + 双列网格，滚动时 chrome 仅一药丸

## 13. 契约变更（V3）

| 变更 | 说明 |
|---|---|
| `mobile-regression.spec.ts` 商城 ready 断言 | 改为先点岛内「搜索」按钮展开搜索卡片，再断言 placeholder（交互重构的合理适配） |
| `BottomTabBar` 新增 `data-hidden` | 滚动隐藏态可观测 |
| 药丸/navbar 320px 防溢出 | nav `max-md:px-3`、品牌字 `max-md:text-base`、compact 文字归零 |

## 14. 不变量（V3 追加）

12. 岛交互仅 `<md` + 商城页；非商城页 navbar 仅药丸收缩，无搜索图标。
13. 桌面端搜索框/分类原样常驻页内（DOM 一致），所有桌面 e2e 套件（instant-fixed/product-reviews/wizard/auth-session 的 placeholder 引用）零适配通过。
14. V1/V2 全部契约不回退（Tab Bar 贴底/抽屉/触控 40px/双列/Sheet/购买条）。

## 15. 验收（V3）

- `npm run build` 零错误；移动端双套件 11/11；全量 CI 模式 74+1（1 例时序抖动，隔离复跑 3/3 绿）**全绿**
- 320px navbar 无横向溢出（搜索图标新增后重新收敛）
- 流水 Sheet 触控/骨架/空态/分页经 mobile-regression `/profile` 触控断言覆盖

---

# V3.1：chrome 权重再平衡与丝滑 morph（2026-07-31 第四轮反馈）

> 反馈：① 公告占底部 Tab 权重过大 → 上移 navbar；底部按角色安排；② 灵动岛要毛玻璃；③ 变形/搜索动画不丝滑。

## 16. 设计（V3.1）

### chrome 权重再平衡
- **公告**：Tab Bar 移除 → navbar 铃铛（未读角标），`announcement-center-mobile-trigger` testid 与 aria-label 契约原样迁移；ack-required 自动弹出逻辑不变
- **navbar 移动端去重**：头像按钮移除（入口与 Tab Bar「我的」重复），≥md 保留
- **Tab Bar 角色化**：买家/游客=首页/积分(直达流水 Sheet)/我的；商家=首页/商家/数据(经营图表页)/我的；管理员=首页/管理/我的。积分 Sheet 状态上提 `appStore.pointsHistoryOpen`（Tab Bar 与 Profile 按钮共用）
- **实心 vs 毛玻璃分工**：贴地 chrome（Tab Bar）= 实心 surface；悬浮物（灵动岛胶囊/搜索卡片）= 毛玻璃（`--color-glass-bg` + backdrop-blur + saturate）

### 丝滑 morph 的核心原则：**只动画可过渡属性，内容零重排零跳变**
- 胶囊形态重构：`w-fit` 居中小药丸（宽度不可动画）→ **全宽胶囊**（圆角/内外边距/背景/阴影/模糊全可过渡）；justify-between 布局不变、Logo/头像/按钮尺寸恒定
- 品牌文字仅字号/字距微调（font-size、letter-spacing 均可过渡），删除宽度归零/图标缩放等跳变逻辑
- 搜索展开：胶囊皮肤共享（compact 与搜索卡片仅圆角/内边距/阴影差异）+ `islandPanelIn` 淡入位移（**不含 scale**——入场缩放会误伤 40px 触控运行时量测）+ `islandRowsIn` chips 行真实高度展开 + 遮罩 `overlayIn` 淡入

## 17. 验收（V3.1）

- build 零错误；移动端双套件 11/11（含 320px 触控/溢出）；announcements 移动契约 2/2（bell testid/角标/开闭）；隔离复跑全部疑似抖动项均绿

---

# R1：合并前审查修复（2026-07-31）

> 外部审查发现 6 项问题（P1×1 / P2×4 / P3×1），全部修复并以 3 项新 e2e 契约锁定。

| # | 问题 | 修复 | 锁定 |
|---|---|---|---|
| P1 | `viewport-fit=cover` 后 safe-top/left/right 声明未消费，刘海/横屏遮挡 chrome | 新增 `.nav-safe-x`（精确复刻原断点 padding + safe  inset）；nav `paddingTop: calc(var(--safe-top) + …)`；Tab Bar 左右 `safe-left/right`。safe=0 时与原值恒等，桌面零差异 | 走查 |
| P2-1 | Tab Bar 自动隐藏只识别单帧 >6px，慢速滚动永不触发 | 改为**累计同向位移**驱动：隐藏阈值 48px、唤回 24px（收保守、唤灵敏），换向清零，近顶恒现 | `review fixes/P2-1`（30×3px 慢滑必隐藏、慢上滑必唤回） |
| P2-2 | 详情页底部双重预留（main 预留 Tab Bar + 页根预留购买条，safe 双算，实测 ~196px 空白） | main 在 `/product/*` 豁免 Tab Bar 预留（`max-md:pb-6`），购买条空间仅由页根预留 | `review fixes/P2-2`（main pb ≤26px、页根 72–96px） |
| P2-3 | 骨架与最终网格几何不一致（206px/24px gap vs 240px/12px gap）→ 加载跳动 | 骨架列数/`gap: gridGap`/卡高 `cardHeight` 全部与真实网格同源 | 走查 |
| P2-4 | 商品标题切换点误用 `lg`，泄漏到 768–1023px（违反「≥768 桌面不变」） | 切换点 lg→md：≥768 恢复 overlay 标题（原桌面布局），<md 内容流标题 | `P2-4 tablet 800px`（overlay 可见、可见 h1 唯一） |
| P3 | `.sheet-enter` 新曲线未生效——同特异性下后写的旧定义覆盖 media query 内新定义（media query 不加特异性） | 删除 media query 内冗余定义，唯一定义改为 `0.34s var(--ease-standard)`，并注释「勿在前文重复定义」 | 代码评审 |
| 附 | SessionManager 错误态「重试」按钮 32px（既有违约，审查期间被环境性 API 失败触发暴露） | 补 `btn-sm`（移动端 40px） | mobile-regression `/profile` 触控断言 |

**验收**：build 零错误；移动端 14/14；全量 CI（retries=1）76 例 0 硬失败（4 例时序抖动重试即过，复跑全绿）。

---

# R2：第二轮审查修复（2026-07-31）

| # | 问题 | 修复 | 锁定 |
|---|---|---|---|
| R2-P1 | Admin/Merchant sticky Tab 条 `max-md:top-20` 固定 80px，navbar 消费 safe-top 后（模拟 44px 刘海）导航底 119px 与条顶 80px 重叠 | 新增共享变量 `--navbar-h: 77px`（navbar 内容高度口径，不含 safe）；两处 sticky 偏移统一为 `calc(var(--navbar-h) + var(--safe-top))` | `R2-P1`（注入 `--safe-top:44px` 断言 computed top = 121px） |
| R2-P2-3 | 骨架网格缺最终网格的 `pt-2` 起点容器，加载仍有 ~8px 跳动 | 骨架外包一层 `pt-2`，与最终网格同起点 | `R2-P2-3`（延迟 API 实测骨架首卡 y 与最终首卡 y 差 ≤2px） |
| 附 | m3 套件经 navbar 头像进 Profile，与「移动端头像去重」冲突 | `goToProfile` 按可见性选 Tab Bar「我的」/navbar「个人中心」（交互重构的合理契约适配，桌面路径不变） | m3 套件 6/6 |

**验收**：build 零错误；移动端 16/16；**全量 CI JSON 报告：expected 80 / unexpected 0 / flaky 0 / skipped 0——全绿。**
