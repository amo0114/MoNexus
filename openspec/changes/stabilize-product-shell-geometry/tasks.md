## 0. Gate

- [ ] 0.1 Owner 批准本提案的规格与设计（2026-11-17 仅授权设计阶段，实施须另行授权）
- [ ] 0.2 Owner 授权实施

## 1. Implementation（0.2 之前不得开始）

- [ ] 1.1 新增 `src/styles/85-product-shell.css`，按 `desktop-layout` → `desktop-content` → `desktop-bp-mid` 顺序原样迁入 design Context 表中 7 组规则（普通 CSS，不用 `@layer`），并在 `src/index.css` 中 `80-themes.css` 之后引入
- [ ] 1.2 从 `desktop-layout.css`、`desktop-bp-mid.css`、`desktop-content.css` 只删除这些规则，保留同一媒体查询中的其他规则

## 2. Verification

- [ ] 2.1 `shell-check.mjs <out> --baseline evidence/results-80a9e3b-before.json` exit 0（8 个视口 × 访客 / 登录：t0 = t1 = t2 = t3、t3 与基线相同、资源拦截与节点硬检查、`/orders` 恢复）；结果以实施提交 SHA 命名保存
- [ ] 2.2 `loading-check.mjs` 回归通过（骨架两阶段一致、与真实页面对齐不变）
- [ ] 2.3 ≥1024 时深色与浅色主题下 `main`、页头、横幅、页脚的计算样式与基线相同
- [ ] 2.4 `npm test`、`npm run build`；记录主包 CSS gzip 变化
- [ ] 2.5 `openspec validate stabilize-product-shell-geometry --strict`
- [ ] 2.6 更新 `handoff.md`，提交固定快照，交独立审查
