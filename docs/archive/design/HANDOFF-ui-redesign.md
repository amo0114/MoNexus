# UI Redesign — Handoff Document

> **此文档是新会话进入 UI 重设计工作的入口。**
> 设计纲领在同目录的 `MASTER.md`。本文档负责把"现状 → 目标 → 怎么走"讲清楚。

**生成时间**：2026-05-11
**前置工作**：P0 production-readiness sweep（已完成，PR #1 待合并到 `master`）

---

## 1. 起点（必读 5 分钟）

### 当前样式底座

- **`src/index.css`**：所有现有 CSS 变量。当前调色板叫 **"Warm Latte / Soft Cocoa"**（米黄+棕色），与目标完全不同。需要整体替换。
- **`tailwind.config.js`**：几乎空配置，只有 `darkMode: 'class'`。所有定制都依赖 CSS 变量。
- **`src/components/Layout.tsx`**：导航栏 + 内容区 + 页脚的总框架。Email 验证横幅已在这里挂上。
- **`src/components/`**：9 个业务组件（Layout / RoleGuard / Toast / OrderDetailModal / ProductDetailModal / PurchaseModal / SuccessModal / EmailVerificationBanner / merchant/MerchantInventoryImportModal / merchant/MerchantProductFormModal）。

### 需要迁移的 10 个页面

| 页面 | 路径 | 行数 | 风格密度 |
|------|------|------|---------|
| Login | `src/pages/LoginPage.tsx` | 168 | 高（含装饰 blob + 自定义 SVG logo） |
| Store | `src/pages/StorePage.tsx` | 194 | 中（卡片列表 + 搜索 + 分类） |
| ProductDetail | `src/pages/ProductDetailPage.tsx` | 362 | 高（产品详情 + 评价 + 购买流程） |
| Profile | `src/pages/ProfilePage.tsx` | 303 | 中（积分卡 + 签到 + 订单 + 邀请） |
| Admin | `src/pages/AdminPage.tsx` | 625 | **极高**（7 个 tab + 数据表 + 模态框） |
| MerchantApply | `src/pages/MerchantApplyPage.tsx` | 151 | 低（单表单） |
| MerchantDashboard | `src/pages/MerchantDashboardPage.tsx` | 419 | 高（5 个 tab） |
| ForgotPassword | `src/pages/ForgotPasswordPage.tsx` | ~85 | 低 |
| ResetPassword | `src/pages/ResetPasswordPage.tsx` | ~95 | 低 |
| VerifyEmail | `src/pages/VerifyEmailPage.tsx` | ~70 | 低 |

**总计 ≈ 2472 行 TSX**。每页平均 247 行。

### 关键约束

- 现有 dark mode 切换必须保留（`index.html` 里 inline script + `dark` class）
- 现有 fade-in 动画系统（`.fade-in` class）已有用户，不要随便删
- `RoleGuard` / `MerchantApply` / `MerchantDashboardPage` 里的"商家审批状态机"视觉逻辑必须保留
- 横幅（`EmailVerificationBanner`）位置在 `<main>` 之前，主题色用 amber

---

## 2. 目标（来自 `MASTER.md`）

### 色彩

| Token | 值 | 用途 |
|-------|-----|------|
| `--color-primary` | `#6366F1`（indigo） | 主交互色 |
| `--color-secondary` | `#818CF8`（浅 indigo） | 辅助强调 |
| `--color-cta` | `#22C55E`（绿） | CTA 按钮、积分高亮 |
| `--color-background` | `#EEF2FF`（极浅 indigo） | 页面底色 |
| `--color-text` | `#312E81`（深 indigo） | 正文 |

### 字体

- 标题：**Orbitron** (400/500/600/700)
- 正文：**Exo 2** (300/400/500/600/700)
- Google Fonts CSS import 已在 MASTER.md 提供

### 风格关键词

`crypto / web3 / futuristic / vibrant / block-based / 高对比`

### 反模式（**严禁**）

- ❌ emoji 当 icon → 用 Lucide（项目已经引入了）
- ❌ scale 类 hover 引起 layout shift
- ❌ 4.5:1 以下文字对比度
- ❌ 即时状态切换（必须有 150-300ms 过渡）
- ❌ 不可见 focus state（a11y）

---

## 3. 迁移路线图（建议 4 阶段，3-5 天）

### Phase 1：Tokens 与字体（~0.5 天）

- [ ] 在 `index.html` 加 Google Fonts preconnect + Orbitron/Exo 2 link
- [ ] 重写 `src/index.css`：
  - 替换 `:root` 调色板为 indigo+green
  - `.dark` 模式重新定义（不能照搬 cocoa，用 indigo 暗色变体）
  - 保留 `.fade-in` / `.glass` / `.bg-grid-pattern` 等通用 utility（可能需要调色）
- [ ] `tailwind.config.js` 增加：
  - `theme.extend.colors`：primary / secondary / cta（让 Tailwind 类用得上）
  - `theme.extend.fontFamily`：heading（Orbitron）/ body（Exo 2）
  - `theme.extend.boxShadow`：sm / md / lg / xl per MASTER spec
- [ ] body 默认字体改为 Exo 2，所有 h1-h4 默认 Orbitron

**验收**：`npm run build` 通过，浏览器打开任意页能看到新字体加载，但旧 `--c-*` 变量还能 fallback（保留兼容）。

### Phase 2：底层组件（~0.5 天）

把 `MASTER.md` 里的 Button / Card / Input / Modal 落地成 React 组件 或 全局 CSS class。

- [ ] `src/components/ui/Button.tsx` — primary / secondary 双变体 + size + loading 态
- [ ] `src/components/ui/Card.tsx` — 替代 `apple-card` 用法
- [ ] `src/components/ui/Input.tsx` — 含 focus ring（`0 0 0 3px #6366F120`）
- [ ] `src/components/ui/Modal.tsx` — overlay blur + 16px radius

或者全用全局 CSS class（`.btn-primary` / `.card` / `.input` / `.modal`）让现有页面零侵入升级。**推荐：先 CSS class，迁移完最后再考虑抽 React 组件**。

**验收**：写一个 `src/pages/_design-tokens.tsx` 临时 demo 页，把每种 token + 组件展示一遍，眼睛过一遍后删掉。

### Phase 3：页面迁移（~2-3 天）

**建议顺序**（从轻到重，先磨刀后砍柴）：

1. ForgotPassword / ResetPassword / VerifyEmail（小，相似，热身）
2. MerchantApply（单表单，验证 Input/Button 落地）
3. Login（特别的，含 logo 与 blobs 装饰 —— 这里要决定保留还是重做）
4. Store（卡片列表 —— 验证 Card 组件）
5. Profile（多 tab —— 验证 tab 切换在新风格下的体感）
6. ProductDetail（最复杂的单页面）
7. MerchantDashboard（5 tab）
8. **Admin（625 行 7 tab，最后做，因为最大且最不面向终端用户）**

每个页面迁移的标准化步骤：
1. 全文搜索 `--c-` 变量替换为新 token
2. `apple-card` → 新 Card class
3. 按钮检查（primary / secondary）
4. 检查所有 hover/focus 过渡有 200-300ms transition
5. 检查 dark 模式对应色
6. 浏览器开一遍，桌面+移动断点
7. commit（一个页面一个 commit，commit message 说明视觉变化点）

### Phase 4：清理与验收（~0.5 天）

- [ ] 删除所有不再使用的旧 `--c-*` 变量（grep 确认零引用）
- [ ] 删除 `.apple-card` class
- [ ] 字体加载性能检查（CLS 应该 < 0.1）
- [ ] Lighthouse 跑一遍（accessibility / contrast）
- [ ] 改 `index.html` 的 `<meta name="description">` 与 `<title>` 如果品牌名需要同步（当前是 MoYuan，注意是否要改回 MoNexus）
- [ ] commit + PR

---

## 4. 决策待定（开工前需要拍板）

1. **品牌名**：`index.html` 写的是 "MoYuan"，但项目目录是 MoNexus、design-system 文件夹也是 monexus。这是 PoC 痕迹还是双品牌？
2. **Login 装饰元素**：当前有自定义 SVG logo + decorative blobs。新风格是 web3 调性 —— 保留 logo 但重新着色？换掉 blob 变成几何 grid？还是用 MASTER.md 的"Marketplace / Directory" 模式直接换布局？
3. **Dark mode 调色**：MASTER.md 只给了 light mode 规范。dark mode 需要自己设计 indigo 的暗版本（建议 `#1E1B4B` 底 + `#A5B4FC` 主色）。
4. **是否引入 React 组件库**：当前用 Tailwind + 自定义 CSS。要不要引入 Radix / shadcn 做 Modal / Dropdown / Tab 这种"有 a11y 复杂度"的组件？短期可以不引入，但 Admin 页 7 个 tab 自己写麻烦。
5. **Tab 实现**：现有 Admin / MerchantDashboard 都是自己 useState 切 tab，没有 a11y。借这次重设计抽 Tab 组件？还是保持现状？

---

## 5. 启动新会话的推荐 Prompt

```
我要开始 UI 重设计工作。请读：
1. /mnt/e/workspacePulic/MoNexus-new/design-system/monexus/HANDOFF-ui-redesign.md
2. /mnt/e/workspacePulic/MoNexus-new/design-system/monexus/MASTER.md

读完后告诉我 §4 的 5 个待定决策你的建议，等我拍板后再开始 Phase 1。
不要预先扫整个代码库 —— HANDOFF 里已经标出关键文件，按需读取就好。
```

---

## 6. 上下文连接

- **前一会话留下的 PR**：#1 `P0 production-readiness sweep`（chore/p0-prod-ready → master）
- **Auto-memory 在**：`/root/.claude/projects/-mnt-e-workspacePulic-MoNexus-new/memory/`
- **设计源文件**：`design-system/monexus/MASTER.md`（你正在读的姊妹文档）

如果你（CC 新实例）发现这份 handoff 与代码实际状态不符，**信任代码**，然后回过来更新本文档。
