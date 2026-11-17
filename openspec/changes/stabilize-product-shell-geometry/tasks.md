## 0. Gate

- [ ] 0.1 Owner 批准本提案的规格与设计（2026-11-17 仅授权设计阶段，实施须另行授权）
- [ ] 0.2 Owner 授权实施

## 1. Implementation（0.2 之前不得开始）

- [ ] 1.1 新增 `src/styles/85-product-shell.css`，原样迁入 design Decision 1 列出的外壳规则，并在 `src/index.css` 中引入
- [ ] 1.2 从 `desktop-layout.css`、`desktop-bp-mid.css`、`desktop-content.css` 删除对应规则

## 2. Verification

- [ ] 2.1 `shell-check.mjs`：所有视口 t0 = t1 = t2，且 t2 与 `results-80a9e3b-before.json` 的 t2 相同；保存结果
- [ ] 2.2 `loading-check.mjs` 回归通过（骨架两阶段一致、与真实页面对齐不变）
- [ ] 2.3 从商品详情导航到 `/orders` 时外壳恢复普通尺寸（浏览器检查）
- [ ] 2.4 `npm test`、`npm run build`；记录主包 CSS gzip 变化
- [ ] 2.5 `openspec validate stabilize-product-shell-geometry --strict`
- [ ] 2.6 更新 `handoff.md`，提交固定快照，交独立审查
