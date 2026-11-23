# Handoff: stabilize-product-shell-geometry

- Spec / 契约: 本 change（proposal / design / specs / tasks）
- 来源: #360 R1 复审场景 B；设计审查 [R1/R2](../../../../docs/reviews/2026-11-17-stabilize-product-shell-geometry-design-review-r1.md)（R2 APPROVE_DESIGN）
- Owner 决定: 2026-11-17 批准设计并授权实施（tasks §0.1、§0.2）；其后授权 push / 开 PR；2026-11-18 Owner 合并 #363 并批准归档收尾
- 审查记录: 实施审查 APPROVE（`80a9e3b..d8d747b`），见 [审查记录](../../../../docs/reviews/2026-11-17-stabilize-product-shell-geometry-design-review-r1.md#实施审查)；设计与实施审查由 Codex 独立会话完成，但实施由 Claude Code 执行，不计为"跨 Agent 无上下文接手"实验
- 写入负责人: Claude Code（Opus 5.5）（更新时间 2026-11-17）；已完成（2026-11-18 合并并归档）
- 分支 / worktree: `chore/product-shell-css-proposal`（已 push，PR #363 合并）/ `/root/projects/worktrees/monexus-product-shell-css`
- Base: `origin/develop@80a9e3b`
- 合并: PR #363（Head `ad796f2`，`run-e2e`，`CI OK` 与 4 组 E2E 通过）→ `develop` merge commit `342b171`（2026-11-18）
- 提交: `b2dd703`–`5fecf89` 设计；`6934363`、`f52f683` 证据脚本加固（R2-01、主题快照）；`f1ea31a` 实施；`d8d747b` 实施后证据与本交接；`ad796f2` 实施审查记录
- 已验证 revision: 代码 = `f1ea31a`（浏览器证据、构建、单测均在该提交的干净工作区执行）
- 隔离资源: 本地 `vite preview` 端口 5299（已停止）；临时基线 worktree 已删除

## 已完成（附证据）
- §2.0 `shell-check.mjs` 加固：`/orders` 恢复断言 URL、`orders-page`、外壳节点与导航后页面错误；新增深浅主题计算样式快照。基线复跑（`f52f683`，`src/` = `80a9e3b`）exit 1，恰为 10 项预期移动，`/orders` 与主题快照检查通过 → `evidence/results-80a9e3b-before.json`
- §1 实施（`f1ea31a`）：新增 `src/styles/85-product-shell.css`（7 组规则原样迁入，顺序 layout → content → bp-mid，普通 CSS），`src/index.css` 在 `80-themes.css` 之后引入；从 `desktop-layout.css`、`desktop-content.css`、`desktop-bp-mid.css` 只删除这些规则
- 构建产物：`.product-layout` 选择器只出现在 `index-*.css`（9 处），详情分包 0 处；1024–1279 覆盖规则位于 ≥1024 规则之后

## 待完成
- 无。实施审查 APPROVE（无 Finding）；#363 已合并（`342b171`）；本 change 已归档，要求并入 `openspec/specs/web-route-loading/spec.md`。本 change 未取代存量文档章节，`docs/specs/INDEX.md` 无需登记。
- FOLLOW_UP（未立项）：`/PRODUCT/42` 不加 `.product-layout`；`.product-layout.bg-grid-pattern` 背景选择器不命中；soft / ink 主题计算样式未单独验证；商品详情非 404 失败处理与 `product-commerce-v2` §10.2 不一致；路由模块加载失败 UI

## 已批准的设计决策
- 外壳规则原样移入主包 CSS — design Decision 1，Owner 2026-11-17 批准
- 不修 `.product-layout` 大小写判断与背景选择器 — design Decision 2

## 风险与阻断
- 无阻断。
- 平板真实页面画廊 y 在不同运行间为 301 或 304（P1 证据 1023 为 301，本次与 `80a9e3b` 复跑均为 304），与本次改动无关（规则只作用于 ≥1024）；骨架本身两次一致。
- 范围外：`/PRODUCT/42` 不加 `.product-layout`；`.product-layout.bg-grid-pattern` 背景规则不命中（原样迁移）。

## 验证记录
| 命令 | 结果（exit code） | revision |
|---|---|---|
| `shell-check.mjs <out>`（基线） | 1，10 项预期移动；`/orders` 与样式检查通过 | `f52f683`（`src/` = `80a9e3b`），`dirtyFiles: []` |
| `shell-check.mjs <out> --baseline evidence/results-80a9e3b-before.json` | 0，ALL HARD CHECKS PASSED（16 组 t0=t1=t2=t3、t3 = 基线、6 组深浅主题计算样式 = 基线、`/orders` 恢复） | `f1ea31a`，`dirtyFiles: []` → `evidence/results-f1ea31a-after.json` |
| `loading-check.mjs`（P1 骨架回归） | 0，ALL HARD CHECKS PASSED；骨架两阶段与 P1 证据一致；场景 B（CSS 迟到）所有视口 noCss = withCss | `f1ea31a`，`dirty: false` |
| 同上，在 `80a9e3b` 重建对照 | 0；768 / 1023 真实画廊 y 均为 304 | `80a9e3b` |
| 主包 / 详情分包 CSS gzip（Node zlib 9） | `index-*.css` 31,638 → 31,757 B（+119）；`ProductDetailPage-*.css` 11,654 → 11,545 B（−109） | `80a9e3b` → `f1ea31a` |
| `npm run build` | 0 | `f1ea31a` |
| `npm test`（233 文件 / 1909 用例） | 0 | `f1ea31a` |
| `openspec validate --all --strict` | 0 | 本分支 |

## 复现
```bash
npm ci && npm run build      # Node 22
npx vite preview --port 5299 --strictPort --host 127.0.0.1 &
node openspec/changes/archive/2026-11-18-stabilize-product-shell-geometry/evidence/shell-check.mjs /tmp/shell-check \
  --baseline openspec/changes/archive/2026-11-18-stabilize-product-shell-geometry/evidence/results-80a9e3b-before.json
node openspec/changes/archive/2026-11-17-align-route-loading-skeletons/evidence/loading-check.mjs /tmp/loading-check
```

## 未运行 / 无法验证
- soft / ink 主题的计算样式快照（只覆盖 light / dark）
- 真实网络下的冷启动时序（证据为人为拦截资源的确定性时序）

## 独立审查重点（已完成，结论见审查记录）
- `85-product-shell.css` 与原三处规则逐字一致（选择器、媒体查询、声明、顺序）；原文件只删除了这些规则
- `index.css` 引入位置；构建产物中规则顺序
- 证据脚本加固（R2-01、主题快照）是否足以支撑"最终几何与样式不变"
