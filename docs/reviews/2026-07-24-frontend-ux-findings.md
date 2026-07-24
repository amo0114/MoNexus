# MoNexus 前端调研记录：多端适配 + 设计系统化

> **日期**: 2026-07-24
> **性质**: 调研记录（不含代码改动）。改造实施需用户逐项批准后动工。
> **范围**: `src/`（React 18 + TS + Tailwind 3.4 + Radix + zustand），81 个源文件全量扫描。
> **证据格式**: `文件:行号`，均已复核。

---

## Part 1 — 已确认的 6 项问题（复核：全部属实）

| # | 问题 | 证据 | 复核补充 |
|---|------|------|---------|
| 1 | 移动端导航功能缺失：商家后台、管理后台、积分、申请商家入口全部 `hidden md:flex`，无汉堡菜单兜底 | `Layout.tsx:66,76,85,95,104,114,134` | 属实。共 7 处 `hidden md:flex`；移动端只剩 Logo、两个主题按钮、头像。商家/管理员在手机上**无任何路径**进入工作台，功能级缺陷 |
| 2 | 14 处表格只有横向滚动，无移动端卡片化降级 | AdminPage 5 张表（`:259,337,418,493,554`）、MerchantDashboardPage 3 张表等 | 属实。`.admin-table` 定义于 `index.css:320-325`，9 处使用，均无移动降级 |
| 3 | 触控目标过小：行内按钮 `!px-2 !py-1 !text-xs`（约 24px 高）、徽章 `text-[10px]` | `MerchantDashboardPage.tsx:565-584,812` 等 | 属实且面更大：`text-[10px]` 全仓 34 处/16 文件、`text-[11px]` 10 处/6 文件，多数是 `px-2 py-0.5` pill（触摸高度 ~16-20px，标准 ≥40px） |
| 4 | 弹窗两套实现并存：Radix Dialog 与手写 `fixed inset-0` 混用，手写版无焦点陷阱/ESC | `MerchantProductFormModal.tsx:273` vs `MerchantDeliverDialog.tsx:3` | 属实。手写弹窗 **9 个组件/10 处**（清单见 Part 3 §C4），Radix 已用 10 处；`OrderDetailModal` 甚至是混合实现（主弹窗手写、内嵌确认用 Radix，`:10,74-76,276-307`） |
| 5 | 图表 hover-only：TrendChart tooltip 只响应 mouse 事件，SVG 硬编码 1000×200 压扁 | `TrendChart.tsx:56,65-66` | 属实且**比原判断更严重**：`preserveAspectRatio="none"`（`:56`）使 r=4 圆点在非 5:1 容器中被压成椭圆，stroke 粗细不均；移动端既看不清点也点不出数值 |
| 6 | 样式系统不成熟：大量 `!important` 补丁；重复主题切换按钮并存 | `MerchantDashboardPage.tsx` 单文件 15+ 处 | 属实且量更大：`**!**` 补丁全仓 **250 处/25 文件**，MerchantDashboardPage 51 处居首。根因已定位：`.btn-*` 无 size 变体，靠 `!` 暴力覆盖 |

---

## Part 2 — 本轮新发现问题（按严重度排序）

### P0 功能/视觉 Bug

**B1. 主题系统双实现冲突，共用同一 localStorage key** 🔴
- 两套并存：`Layout.tsx:16-21` 内联 `toggleTheme()` 切 `.dark` class 写 `localStorage['theme']='dark'|'light'`；`ThemeProvider.tsx:43` + `ThemeToggle.tsx` 切 `data-theme` 写 `localStorage['theme']='default'|'soft'`。
- 两按钮并排渲染（`Layout.tsx:122` vs `:124-130`）。
- **冲突场景**：soft 主题下点 Layout 的 Moon → 写入 `'dark'`、加 `.dark` class，但 `data-theme="soft"` 属性仍在 `<html>` 上 → 两套变量同时生效，刷新前页面处于混合态（软萌色 + 深色阴影）。
- 初始化脚本也分叉：`index.html:16-18`（dark）与 `:24-29`（soft）各读各的。
- 附带：`ThemeProvider.tsx:34` 读到 `'dark'` 会得到非法 Theme 值，靠巧合不崩。

**B2. `--color-info` 悬空变量：5 文件使用，三套主题均未定义** 🔴
- 使用点：`AdminConfigPanel.tsx:112`、`MemberTierConfigPanel.tsx:159`、`CommissionDialog.tsx:94`、`MemberTierBadge.tsx:19`、`RegistryPill.tsx:32`。
- `index.css` 的 `:root` / `.dark` / `[data-theme="soft"]` 均**无定义** → `var(--color-info)` 解析失败，声明被静默丢弃。
- 影响面：`MemberTierBadge`、`RegistryPill` 是 ProfilePage 生产组件 → 会员等级徽章/info 提示框**当前就是无色状态**（文字继承默认色、背景边框消失）。线上视觉 bug。

### P1 体验缺口

**B3. 加载态覆盖不均，两后台整页裸奔**
- 无加载态：`AdminPage`（11 个 tab 全无，`loadTabData` 无 loading 标志，`:121-148`）、`MerchantDashboardPage`（统计卡 `?? '--'` 占位 `:297-300`）、`ProfilePage` 主列表（`:331-334` 静默拉取）。
- 后果：请求期间先闪现「暂无数据」空态文案，造成"数据丢失"错觉。
- 已有标杆可复用：`merchant/Dashboard.tsx` 4 子组件全套骨架屏、`ProductDetailPage.tsx:120-138` 页面级骨架。
- `StorePage.tsx:437-438` 首屏仅纯文本「加载中...」。

**B4. 空态 18 处仅 1 处设计化**
- 唯一带图标+引导的空态：StorePage 商品网格（`:439-446`，SearchX 图标）。
- Admin 商家/结算/商品/流水 4 张表**连空态都没有**（空 tbody，`AdminPage.tsx:270-302,362-399,429-479,503-513`）；其余 13 处为裸文本或虚线框。

**B5. 错误通道单一 + 两处 unhandled rejection**
- ~90% API 错误仅 toast（固定 2800ms、不可手动关、无退场动画、无类型区分，见 `Toast.tsx` 全文 28 行 + `appStore.ts:30-39`）。
- `ProfilePage.tsx:332-333`：history/checkin 两请求**连 catch 都没有** → unhandled rejection。
- `ProductDetailPage.tsx:69` 评价加载 `.catch(() => {})` 静默吞错。

**B6. 四处提交按钮无 busy 态，可双击重复提交**
- `PurchaseModal.tsx:38-43`「确认支付」——**涉及积分扣减，无 disabled 无 spinner**，全文 0 个 `disabled=`。
- `AdminUserTable.tsx:248,323`（封禁/调分确认）、`AdminPage.tsx:670`（卡密导入）、`MerchantDashboardPage.tsx:696`（资料保存）。
- 正面标杆：12 处对话框按钮已内嵌 spinner（ReviewDialog、MerchantDeliverDialog 等）。

**B7. 可访问性底线缺失**
- `prefers-reduced-motion` / `useReducedMotion` / `matchMedia`：**全仓 0 匹配**，所有上浮/缩放动画无降级。
- 无 skip-link；无全局 `:focus-visible` 样式（`.input:focus` 未区分鼠标/键盘，`index.css:274-278`）。
- 图标按钮 aria-label 缺失：商家分页 chevron（`MerchantDashboardPage.tsx:843-856`）、TrendChart 指标 select（`TrendChart.tsx:45-49`）、StorePage 搜索框（`:410-416`）、AdminPage 审计筛选 4 输入框（`:524-549`）。

**B8. 危险操作确认样式不统一**
- `window.confirm` 3 处（`AdminUserTable.tsx:77` 解封、`PortableBackupPanel.tsx:84` 恢复导入、`AnnouncementsAdmin.tsx:193` 删公告）与 Radix 设计化确认（`OrderDetailModal.tsx:276-307`）并存。

### P2 打磨缺口

**B9. 动效体系单薄**
- 自定义 keyframes 仅 2 个（`fadeIn`、`slideUp`，`index.css:154-171`）；无列表 stagger、无 scroll-reveal（唯一 IntersectionObserver 用于无限滚动，`StorePage.tsx:253-259`）；无 `active:scale` pressed 反馈（全仓 0 匹配，仅有 hover 上浮回落）。
- `MerchantApplyPage` 是全仓唯一 0 过渡页面。
- 对比：商品卡 hover 已做到六重反馈（位移+阴影+边框+图片缩放+遮罩+标题变色，`StorePage.tsx:71-86,120`），是全仓峰值，但仅限此一处。

**B10. 图片工程化未普及**
- `aspect-` 宽高比盒全仓 0 使用（固定 `h-40`/`h-64` 代替）；无 blur-up/LQIP；`onError` 兜底仅 1 处（`MerchantProductFormModal.tsx:566`）；详情页主图无 `loading="lazy"`（`ProductDetailPage.tsx:158-163`）。

**B11. 表单校验反馈不一致**
- 标杆：`AdminConfigPanel`（onChange 即时字段级校验+红框+禁用保存）、`CommissionDialog`、`MerchantCapacityAdjustModal`（实时计算+非法禁用）。
- 落后：`MerchantProductFormModal` 11 处校验全走 toast（`:182-221`）、`LoginPage` 仅 HTML5 required、`AnnouncementsAdmin` 6 处全 toast。

---

## Part 3 — 冗余 CSS / 死代码清单

### C1. 可直接删除（P0）

| 项 | 证据 | 连带收益 |
|---|---|---|
| `src/components/ProductDetailModal.tsx` 整个文件 | 全仓 0 import（e2e 也无） | 连带消灭 4 处 bang、1 处 `.glass-bottom` 使用、1 处 btn-cta、1 处 hide-scrollbar |
| `.glass-bottom`（`index.css:148-152`） | 仅被上述死文件使用 | 死 CSS 清除 |
| `.card-interactive`（`index.css:248-256`） | 仅被 dev-only 的 `_design-tokens.tsx:118,121` 使用 | 生产 0 引用 |
| `index.html` 重复 preconnect | `:9-10` 与 `:20-21` 完全重复 | 无害但冗余 |

### C2. `_design-tokens.tsx` 半死页（P0 处置）

- 路由仅 dev 注册（`App.tsx:62-64`），生产 JS 会被 DCE；**但它是 `App.tsx:20` 的静态顶层 import**，且 `tailwind.config.js:3` content glob 扫到它 → 其独占 utility **进入生产 CSS**。
- 处置选项：(a) 整页删除（UI-REDESIGN-PROGRESS.md Phase 4 本就计划删）；(b) 改 `lazy()` + 移出 Tailwind content。

### C3. 结构性冗余（P1）

- **250 处 `!important` 补丁**：根因是 `.btn-primary/.btn-secondary/.btn-cta` 固定 `px-6 py-3 text-sm` 无 sm 尺寸变体。Top3 文件：MerchantDashboardPage 51、OrderDetailModal 24、AdminPage 19。
- **弹窗双轨**（C4 清单）：手写 `fixed inset-0` 9 组件/10 处 → 迁移 Radix `ui/Dialog`：

| 文件：行 | 备注 |
|---|---|
| `SuccessModal.tsx:25-27` | |
| `PurchaseModal.tsx:13-15` | |
| `OrderDetailModal.tsx:74-76` | 混合实现，优先 |
| `MerchantProductFormModal.tsx:273-274` | |
| `MerchantInventoryImportModal.tsx:104-105` | |
| `AdminUserTable.tsx:215-217,258-260` | 一文件两个 |
| `AdminPage.tsx:647-649` | 已有迁移备忘注释 `:645` |
| `MerchantDashboardPage.tsx:742-744` | 拒单弹窗 |
| ~~`ProductDetailModal.tsx:36-37`~~ | 死文件，直接删 |

### C4. 已清零，无需处理 ✅

- `--c-*` 旧 token 别名：src 内 0 定义 0 引用（仅存于 docs 归档）。
- `.apple-card`：0 定义 0 引用。
- `.btn-outline`：不存在（index.css 只有 `.btn-secondary`，40 处活跃使用）。
- 注释掉的死代码块 / TODO / FIXME：0（唯一命中是卡密占位符字符串）。
- `design-system/` 目录：纯文档（3 个 md + 1 svg），构建配置无任何引用，无需联动。

### C5. 仍活跃的类（勿删）

`.btn-primary(37) .btn-secondary(40) .btn-cta(7) .card(40) .input(79) .modal(8) .modal-overlay(11) .glass(3) .bg-grid-pattern(2) .fade-in(28) .toast-enter(1) .hide-scrollbar(5) .star-filled/.star-empty .admin-table(9)` —— 括号内为 .tsx 引用行数。

---

## Part 4 — UI/UX「丝滑 · 美观 · 高级」提升机会

### 现状峰值（保留并发扬）
- 商品卡六重 hover 反馈 + 虚拟滚动 + 滚动位置缓存恢复（StorePage）
- 统一 `.fade-in` 页面入场、glass 粘性导航、三主题设计令牌（438 处 var 引用）
- merchant/Dashboard 骨架屏体系、AdminConfigPanel 即时校验

### D1. 丝滑（动效与反馈）
1. **动效原语层**：新增 reveal-on-scroll（IntersectionObserver + translate/opacity）与列表 stagger（`animation-delay` 递推），推广到商品网格/订单卡/表格行；全站补 `prefers-reduced-motion` 降级（一条 media query 关掉 transform 动画即可）。
2. **pressed 反馈**：可点元素补 `active:scale-[0.98]`（按钮/卡片/pill），弥补当前只有 hover 无按压的断档。
3. **骨架屏组件化**：抽 `<Skeleton>` 原语，落地 AdminPage、MerchantDashboardPage、ProfilePage、StorePage 首屏，消灭「暂无数据」闪现。
4. **Toast 2.0**：类型扩展（success/error/info/warning）、手动关闭、退场动画、堆叠上限；替代 3 处 `window.confirm` 为统一 ConfirmDialog（Radix）。
5. **页面转场**：tab 切换已有局部 fade-in；可给路由级内容区加 150ms 交叉淡入（无依赖，CSS 即可）。

### D2. 美观（视觉层级）
1. **空态组件化**：`<EmptyState icon title desc action?>` 统一 18 处，Admin 4 张裸表优先。
2. **触控与排版**：行内按钮/徽章纳入 `.btn-sm`（≥40px 高）与统一 pill 规范（≥12px 字号），同步消灭 250 处 bang 与 44 处 10/11px。
3. **表格移动卡片化**：`<table>` 数据在 <md 断点渲染为卡片列表（label-value 对），14 处表格统一方案。
4. **图表修正**：TrendChart 改 touch/click 锁定 tooltip + 修正 `preserveAspectRatio`（或 viewBox 按容器测量），点不再压扁。
5. **移动端导航**：汉堡抽屉（含商家/管理入口、积分、主题）或底部 tab bar，补齐 7 处 hidden 入口。

### D3. 高级感（精致度）
1. **主题系统收敛**：三主题状态机统一（light / dark / soft 单 source of truth + 单切换 UI，建议分段控件或循环按钮），修 B1 冲突；初始化脚本合并。
2. **设计令牌补全**：补 `--color-info`（修 B2）；把 `bg-[var(--color-x)]/N` 模式里高频透明度固化为语义 token（如 `--color-primary-soft`）。
3. **按钮体系**：`.btn-{primary,cta,secondary} × {sm,md}` 变体矩阵 + 统一 busy 态（spinner 内嵌），4 处防重提交优先（PurchaseModal 首位）。
4. **图片工程**：`aspect-[4/3]` 盒 + `loading="lazy"` 普及 + `onError` 兜底组件 `<SafeImage>`。
5. **表单一致性**：把 AdminConfigPanel 的即时校验模式沉淀为 `<Field error>` 约定，推广到 MerchantProductFormModal（11 处 toast 校验）与 LoginPage。
6. **焦点管理**：手写弹窗全部迁移 Radix（C4 清单）后，全站 focus trap/ESC 自动达标；补全局 `:focus-visible` 环与 skip-link。

---

## 建议改造批次（待批准，按依赖排序）

| 批次 | 内容 | 性质 |
|---|---|---|
| R0 | C1+C2 死代码清理 + B2 `--color-info` 补定义 + B5 ProfilePage 补 catch + B6 PurchaseModal 防重提交 | 低风险快赢，不改交互 |
| R1 | B1 主题系统收敛（状态机+单 UI+初始化脚本合并） | 涉及全局，需先定交互方案 |
| R2 | 按钮/触控体系（size 变体消灭 bang、pill 规范、busy 态） | 铺底，后续批次受益 |
| R3 | 移动端导航（抽屉/底部 tab）+ 表格移动卡片化 | 功能级缺陷修复，最大工作项 |
| R4 | 弹窗统一迁移 Radix（9 处）+ ConfirmDialog 替换 window.confirm | 随 R2 按钮体系推进 |
| R5 | 加载/空态/错误体系（Skeleton、EmptyState、Toast 2.0） | 全站体验一致性 |
| R6 | 动效层（reveal/stagger/pressed/reduced-motion）+ 图表触屏化 + 图片工程 | 打磨与高级感 |

> 每批次开工前单独确认范围；R0 可立即执行。
