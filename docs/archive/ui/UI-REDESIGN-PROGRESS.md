# UI Redesign Progress Memo

> **分支**: `feat/ui-redesign`
> **基准**: 从 `chore/p0-prod-ready` 分出，已合并 PR #1
> **目标**: 将全站 UI 从 "Warm Latte / Soft Cocoa"（米黄+棕色）迁移至 **Indigo + Slate** 科技感设计系统
> **设计纲领**: `design-system/monexus/MASTER.md`（色彩/字体/阴影/交互规范）
> **交接文档**: `docs/archive/design/HANDOFF-ui-redesign.md`（4 阶段迁移路线图）

---

## 总览

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 设计 Token + 字体 | **已完成** |
| Phase 2 | 底层组件原语 | **已完成** |
| Phase 3 | 页面迁移 | **进行中** (8/10) |
| Phase 4 | 清理与验收 | 未开始 |

---

## Phase 1 — 设计 Token 与字体

**状态: 已完成**

- [x] `src/index.css` — `:root` 调色板替换为 indigo + slate（light/dark 双模式）
- [x] `tailwind.config.js` — 扩展 `colors`（primary/secondary/cta）、`fontFamily`（heading/body）、`boxShadow`（sm/md/lg/xl/focus）
- [x] Google Fonts 引入（`index.html`）：**Orbitron**（标题）+ **Exo 2**（正文）
- [x] `--c-*` 旧变量别名层保留，指向新 token，确保未迁移页面不崩

### 设计 Token 速查

| Token | Light | Dark | 用途 |
|-------|-------|------|------|
| `--color-primary` | `#6366F1` | `#818CF8` | 主交互色（indigo） |
| `--color-primary-hover` | `#4F46E5` | `#A5B4FC` | 悬停态 |
| `--color-secondary` | `#818CF8` | `#A5B4FC` | 辅助强调 |
| `--color-cta` | `#22C55E` | `#4ADE80` | CTA / 积分高亮（绿） |
| `--color-background` | `#F8FAFC` | `#0A0A14` | 页面底色 |
| `--color-surface` | `#FFFFFF` | `#161629` | 卡片/面板 |
| `--color-text` | `#1E293B` | `#F1F5F9` | 正文 |
| `--color-text-muted` | `#64748B` | `#94A3B8` | 次要文字 |

---

## Phase 2 — 底层组件原语

**状态: 已完成**

### 新建组件（`src/components/ui/`）

| 组件 | 文件 | 基于 | 说明 |
|------|------|------|------|
| Dialog | `Dialog.tsx` | Radix Dialog | 模态框，含 Overlay blur + 关闭按钮 + focus ring |
| Tabs | `Tabs.tsx` | Radix Tabs | 选项卡，含 active 态阴影 + 禁用态 |

### 全局 CSS class（`src/index.css` 内）

| Class | 用途 |
|-------|------|
| `.card` | 替代 `.apple-card`，圆角 + 阴影 + surface 背景 |
| `.btn-primary` | Indigo 主按钮 + hover translateY + shadow |
| `.btn-cta` | 绿色 CTA 按钮 |
| `.btn-outline` | 描边变体按钮 |
| `.input` | 输入框，含 focus ring（`0 0 0 3px` indigo 透明度） |
| `.modal` / `.modal-overlay` | 模态框底板 + 背景模糊 |

### 预览页

- `src/pages/_design-tokens.tsx` — 临时展示所有 token + 组件，迁移完成后删除

---

## Phase 3 — 页面迁移

**状态: 进行中**

### 已迁移页面 (8/10)

| # | 页面 | 文件 | 提交 | 改动要点 |
|---|------|------|------|---------|
| 1 | ForgotPassword | `ForgotPasswordPage.tsx` | `5b088ed` | `--c-*` → `--color-*`，`apple-card` → `card`，加 `font-heading` |
| 2 | ResetPassword | `ResetPasswordPage.tsx` | `21c716d` | 同上模式 |
| 3 | VerifyEmail | `VerifyEmailPage.tsx` | `1d768e6` | 同上模式 |
| 4 | MerchantApply | `MerchantApplyPage.tsx` | `8d0fe06` | 表单页，Input/Button 迁移验证 |
| 5 | Login | `LoginPage.tsx` | `77323d2` | 含 logo + blob 装饰保留，色值全部切换 |
| 6 | Store | `StorePage.tsx` | `7cfe0c2` | 卡片列表 + 搜索 + 分类迁移到新 token |
| 7 | Profile | `ProfilePage.tsx` | `2861db1` | **引入 Tabs 组件**替换手写 tab，积分卡 + 签到 + 订单 |
| 8 | ProductDetail | `ProductDetailPage.tsx` | `c0c709b` | 产品详情 + 评价 + 购买流程，**当前分支最新提交** |

### 待迁移页面 (2/10)

| # | 页面 | 文件 | 行数 | 旧 token 数 | 复杂度 | 说明 |
|---|------|------|------|------------|--------|------|
| 9 | **Admin** | `AdminPage.tsx` | ~625 | 63 处 | **极高** | 7 个 tab + 数据表 + 多个模态框，项目最重页面 |
| 10 | **MerchantDashboard** | `MerchantDashboardPage.tsx` | ~419 | 52 处 | **高** | 5 个 tab + 商品管理 + 订单 + 结算 |

---

## 共享组件迁移

**未迁移的共享组件**（仍在使用旧 `--c-*` token 或 `.apple-card`）：

| 组件 | 文件 | 旧 token 数 | 说明 |
|------|------|------------|------|
| **Layout** | `Layout.tsx` | 36 | 导航栏 + 侧边栏 + 页脚，影响全局 |
| **OrderDetailModal** | `OrderDetailModal.tsx` | 27 | 订单详情弹窗 |
| **ProductDetailModal** | `ProductDetailModal.tsx` | 28 | 产品详情弹窗 |
| **PurchaseModal** | `PurchaseModal.tsx` | 9 | 购买确认弹窗 |
| **SuccessModal** | `SuccessModal.tsx` | 10 | 成功提示弹窗 |
| MerchantProductFormModal | `merchant/MerchantProductFormModal.tsx` | 35 | 商家商品表单 |
| MerchantInventoryImportModal | `merchant/MerchantInventoryImportModal.tsx` | 17 | 商家库存导入 |

**已兼容的共享组件**（使用新 token 或无 token 依赖）：

| 组件 | 文件 | 说明 |
|------|------|------|
| Toast | `Toast.tsx` | 无旧 token，已兼容 |
| RoleGuard | `RoleGuard.tsx` | 无旧 token，已兼容 |
| EmailVerificationBanner | `EmailVerificationBanner.tsx` | 无旧 token，已兼容 |
| ScrollToTop | `ScrollToTop.tsx` | 纯逻辑，无样式 |

> **注意**: 由于 `--c-*` 别名层存在，这些旧组件目前在新主题下**视觉上正常工作**（通过别名映射），只是代码层面还使用旧命名。它们不会造成 bug，但 Phase 4 清理时需要统一。

---

## Phase 4 — 清理与验收

**状态: 未开始**

- [ ] 删除所有不再使用的 `--c-*` 别名变量（grep 确认零引用）
- [ ] 删除 `.apple-card` class
- [ ] 删除 `src/pages/_design-tokens.tsx` 临时预览页
- [ ] 字体加载性能检查（CLS < 0.1）
- [ ] Lighthouse 跑一遍（accessibility / contrast / performance）
- [ ] 检查 `index.html` 的 `<meta name="description">` 和 `<title>` 品牌名（当前是 MoYuan，是否改回 MoNexus）
- [ ] 提交 + PR

---

## 关键约束备忘

- **Dark mode 必须保留** — `index.html` 里 inline script + `dark` class 切换机制不能动
- **`.fade-in` 动画保留** — 已有多个页面使用，不可删除
- **商家审批状态机** — `RoleGuard` / `MerchantApply` / `MerchantDashboardPage` 中的视觉逻辑必须保留
- **EmailVerificationBanner** — 位置在 `<main>` 之前，主题色用 amber
- **禁止 emoji 当 icon** — 用 Lucide（已引入）
- **禁止 scale hover 引起 layout shift**
- **文字对比度 >= 4.5:1**
- **状态过渡 150-300ms** — 不允许即时切换
- **focus state 必须可见** — a11y 要求

---

## 下一步建议

1. **先迁移共享组件**（特别是 Layout.tsx）— 因为 Layout 是全局框架，改完后所有页面立即受益
2. **再迁移 MerchantDashboardPage**（5 个 tab，中等复杂度）
3. **最后迁移 AdminPage**（7 个 tab + 大量模态框，最重的页面）
4. **全部迁移完成后进入 Phase 4** 清理旧 token + 删除预览页

---

*最后更新: 2026-05-11 | 分支最新提交: `c0c709b` feat(ui): migrate ProductDetailPage to new design system*
