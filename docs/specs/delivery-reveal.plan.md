# 交付揭示动效实施方案（RFC #278 · 1a 收窄版）

| 项目 | 内容 |
| --- | --- |
| 文档 ID | `PLAN-DELIVERY-REVEAL-001` |
| 版本 | `0.1.0` |
| 日期 | 2026-10-22 |
| 状态 | 已在 `feat/delivery-reveal` 实施并完成定向验证（§7）；待 review |
| 核验基线 | `origin/develop@911c0ad`；实施基线 `origin/develop@bc54d2f`（#284 只改 CI） |
| 分支 | 实施：`feat/delivery-reveal`（`--no-track` 从最新 `origin/develop` 创建），PR base：`develop` |
| 关联 | [#278](https://github.com/amo0114/MoNexus/issues/278)、[测试政策](../testing-policy.md) |

## 1. 目标与范围

买家兑换成功后，成功弹窗里的**文本卡密**先盖一层可刮开的涂层，刮开或点“直接揭示”后显示；卡片有轻微 3D 入场与指针倾斜光泽。纯前端，零后端、零迁移。

| 纳入 | 不纳入（明确砍掉） |
| --- | --- |
| `SuccessModal` 内 `contentType=text` 的交付内容（经典卡密） | 订单详情、管理端、商家端的交付展示（保持直接显示 + 复制） |
| 刮涂层（鼠标 / 触控）、常驻“直接揭示”按钮、刮开约一半自动揭示 | URL、结构化字段、文件交付（结构化已有敏感字段眼睛遮蔽；URL 被多条 E2E 点击断言） |
| 入场翻转 + 指针倾斜光泽（仅精细指针、非减少动效） | 按面额/品类的“稀有度”光效（无真实数据支撑） |
| 触控设备轻微震动（`navigator.vibrate`，不支持即静默） | 资产库 Vault、卡密 PDF / 离线导出（会把明文带出服务端遮蔽边界） |
| `prefers-reduced-motion` 下无动画，涂层仍在，按钮一键揭示 | 1b “待激活 / 已使用”状态（需迁移，另立项） |

“首次”天然成立：`SuccessModal` 只在下单 / 续费成功后出现，不需要持久化“是否揭示过”。

## 2. 现状与锚点

| 代码 | 现状与本轮用法 |
| --- | --- |
| `src/components/SuccessModal.tsx` | 两处调用：`ProductDetailPage.tsx:755`（购买）与 `OrderDetailModal.tsx:634`（续费）。内部渲染 `DeliveryContent`，并有底部 `success-copy-content`“复制发货信息”按钮 |
| `src/components/DeliveryContent.tsx` | 共用的交付卡片（订单详情也用）。`showText` 分支渲染 `delivery-text-content`；新增可选 prop 仅由 `SuccessModal` 传入，默认行为不变 |
| `src/components/StructuredDeliveryView.tsx` | 已有敏感字段遮蔽，不动 |
| `src/hooks/useMediaQuery.ts` | 复用读取 `(prefers-reduced-motion: reduce)` 与 `(pointer: fine)` |
| `src/components/OrderSuccessIsland.tsx` | 灵动岛只显示“内容已保存至订单”，不含卡密，不动 |
| E2E | `success-delivery-link`（URL）在 7 个 spec 中断言可见 / 属性；本方案不覆盖 URL，因此无 E2E 改动 |
| 单测 | `src/test/setup.ts` 未模拟 canvas；jsdom 中 `getContext('2d')` 返回 `null`，组件必须在无 canvas 时仍可用 |

## 3. 设计

### 3.1 组件

新增 `src/components/ScratchReveal.tsx`（+ 同名 `.css`，沿用 `OrderSuccessIsland.css` 的组件级 CSS 习惯）：

- `props`: `children`（被遮内容）、`onReveal?`、`label`（无障碍名称，如“揭示卡密”）。
- 结构：内容正常渲染在下层；上层是 CSS 金属渐变涂层 `div` + 覆盖其上的 `<canvas>`。canvas 用 `destination-out` 画笔擦除；`getContext` 为 `null` 时不渲染 canvas，涂层 `div` 仍在，只能按钮揭示。
- 揭示条件：点“直接揭示”；或擦除像素比例 ≥ 50%（在 `pointerup` 时对 alpha 通道抽样计算，不在每次 move 计算）。揭示后淡出涂层并卸载 canvas。
- 指针：`pointerdown/move/up` + `setPointerCapture`；涂层区域 `touch-action: none` 防止刮的时候页面滚动（仅涂层区域，弹窗其余部分照常滚动）。
- 尺寸：`ResizeObserver` 跟随内容高度重设 canvas（DPR 缩放）；长卡密（`max-h-48` 滚动区）时涂层覆盖可视区。
- 无障碍：涂层 `aria-hidden`；“直接揭示”是真实 `button`，可 Tab 聚焦并有可见焦点；揭示前被遮内容加 `aria-hidden` + `inert`，避免读屏和 Tab 进入；揭示后移除。
- 震动：首次 `pointerdown` 为触控时调用一次 `navigator.vibrate?.(10)`，揭示时一次；不循环震动。

### 3.2 视觉

- 涂层用现有主题 token（`--color-surface` / `--color-border` / `--color-text-muted`）配出银灰金属渐变与细噪点，亮暗主题各自可读；涂层上居中提示“刮开查看卡密”。
- 入场：卡片 `rotateY` 从约 -12° 回到 0°、300ms，减少动效时关闭。
- 倾斜光泽：仅 `(pointer: fine)` 且非减少动效时，指针移动驱动 `rotateX/Y` ≤ 4° 与一条高光渐变位移；`pointerleave` 复位。不做 3D 翻到背面。
- 遵守 CLAUDE.md：不在 `var()` 颜色上用 Tailwind 透明度后缀；需要浅色叠层用 `--color-primary-tint(-strong)`。

### 3.3 与现有交互的关系

- `DeliveryContent` 新增 `scratchReveal?: boolean`（默认 `false`）。为 `true` 且 `showText` 时用 `ScratchReveal` 包住文本区；**复制文本按钮在涂层外**（标题行），保持可用。
- 任一复制动作（`delivery-copy-text` 或 `SuccessModal` 的 `success-copy-content`）先触发揭示再复制——用户已主动要内容，不再要求刮。实现：`SuccessModal` 持有 `revealed` 状态并下传受控 `revealed` / `onReveal`，`ScratchReveal` 支持受控模式。
- 异步开通轮询（`awaitingProvision`）结束后才出现文本，届时涂层随内容一起出现。
- 续费成功（`headline="续费成功"`）同样适用；订阅续费多为结构化内容，自然不触发。

## 4. 任务

- [x] 1.1 从最新 `origin/develop` 建 `feat/delivery-reveal` worktree（`--no-track`），记录实际基线 SHA
- [x] 1.2 新增 `ScratchReveal.tsx/.css`：涂层、canvas 擦除、50% 自动揭示、按钮揭示、受控 / 非受控、无 canvas 降级、`inert` 与 `aria-hidden`
- [x] 1.3 `DeliveryContent` 增加 `scratchReveal` 及受控揭示 props，仅包裹 `showText` 分支；默认路径输出与现状一致
- [x] 1.4 `SuccessModal` 传 `scratchReveal`，复制按钮先揭示再复制；入场翻转与倾斜光泽（媒体查询门控）
- [x] 1.5 单测 `ScratchReveal.test.tsx`：初始遮蔽（内容 `aria-hidden`、按钮可见）、按钮揭示与 `onReveal`、受控模式、canvas 为 `null` 时仍可按钮揭示、键盘可达
- [x] 1.6 单测补充：`DeliveryContent` 不传 `scratchReveal` 时与现状一致（URL / 结构化 / 文件分支不包裹）；`SuccessModal` 点“复制发货信息”后内容已揭示且剪贴板收到全文
- [x] 1.7 浏览器人工检查（Playwright 截图）：320 / 390 / 1280 宽、亮暗主题、减少动效；手机仿真触控刮擦；长卡密（多行、无空格长串）；确认弹窗无横向溢出、刮的时候不滚动页面
- [x] 1.8 `npm test`（相关文件）+ `npm run build`；不新增 E2E（属纯前端视觉，按测试政策在单测层覆盖）
- [ ] 1.9 自审 diff → 推分支（显式 refspec）→ 开 PR 到 `develop`，不打 `run-e2e`（不触及关键旅程的契约）

## 5. 验收

| ID | 标准 |
| --- | --- |
| R01 | 购买 `instant_inventory` / `instant_fixed` 文本卡密后，成功弹窗中卡密被涂层遮住，刮开约一半或点“直接揭示”后完整显示 |
| R02 | 点“复制发货信息”或“复制文本”无需刮开即可复制全文，且弹窗同时揭示 |
| R03 | URL、结构化、文件交付及订单详情页展示与改动前一致；现有 E2E 无需修改 |
| R04 | 减少动效下无翻转 / 倾斜 / 淡出动画，按钮揭示立即生效 |
| R05 | 键盘可聚焦并触发揭示；揭示前读屏不朗读卡密 |
| R06 | 320px 窄屏、暗色主题下涂层与按钮可读，无溢出；触屏刮擦时页面不滚动 |

## 6. 风险

| 风险 | 处理 |
| --- | --- |
| 用户觉得“刮”是负担 | 按钮常驻、复制即揭示；仅出现在一次性成功弹窗 |
| 低端机 canvas 卡顿 | 只在 `pointerup` 计算覆盖率；画笔半径固定；canvas 揭示后立即卸载 |
| 后续有人把 `scratchReveal` 用到订单详情 | prop 注释写明仅用于一次性成功弹窗 |

## 7. 实施记录

- 新增 `ScratchReveal.tsx/.css`；`DeliveryContent` 增加可选 `reveal`，仅 `SuccessModal` 传入；两个复制按钮都会先揭示。
- canvas 尺寸用布局尺寸（`clientWidth/Height`）而非 `getBoundingClientRect`：入场翻转期间测量会得到变形后的窄宽度，涂层露边（浏览器检查中发现并修复）。
- 单测：`ScratchReveal.test.tsx`（遮蔽 / 按钮揭示 / 无 canvas 降级 / 刮开阈值）、`SuccessModal.test.tsx`（复制即揭示、URL 不加涂层）、`DeliveryContent.test.tsx` 补默认不加涂层断言；相关 5 个文件 46 条通过。`npm run build`、`check:architecture` 通过。
- 浏览器检查（临时预览页直接渲染 `SuccessModal`，Chromium）：320 / 390（多行长卡密）/ 1280、暗色、减少动效均无横向溢出且涂层完整覆盖；鼠标刮开、Pixel 7 触屏刮开（弹窗与页面滚动位置不变）、键盘 Tab 到“直接揭示”回车均能揭示；无控制台错误。
- 未做：真实下单链路的端到端运行（未起后端；按测试政策不新增 E2E）。
- 追加（Owner 评审后要求）：`PurchaseModal` 每次拿到新报价（首次加载、价格变化、重新报价）后 500ms 内“确认支付”不可点、表单提交也被忽略，防止手机上“立即兑换”的连点穿透成确认。延时常量在 `purchaseConfirmArm.ts`，直接点击确认的组件测试把它 mock 为 0；新增 `PurchaseModal.arm.test.tsx` 覆盖未到时间点击无效、到时可确认。前端全量单测 209 文件 / 1736 条通过，`npm run build` 通过。
- 高额密码验证不改代码：管理端配置 `checkoutVerifyAmountThreshold`（单笔）/ `checkoutVerifyDailyThreshold`（当日累计）。本地评审库已设单笔 1000 演示；生产阈值由 Owner 在管理端设置。
- 追加（Owner 要求）：刮擦碎屑。每段刮擦从笔触处崩出 2–4 片碎屑，先向两侧上抛、再受重力下落并旋转淡出（0.5–0.9s），画在涂层外独立的 `pointer-events: none` 画布上，可略微落出卡片边缘；颜色取自涂层主题色（含一档更深色，保证刮开后的底色上可见），同屏最多 160 片，揭示即停止并清空，减少动效下不产生。浏览器检查：亮 / 暗主题、Pixel 7 触屏均有碎屑，减少动效下为 0，揭示后碎屑层卸载，无控制台错误。
