# Handoff: stabilize-product-shell-geometry

- Spec / 契约: 本 change（proposal / design / specs / tasks）；Owner 2026-11-17 指示："为 CSS 迟到问题编写 P2 的 OpenSpec 提案，但只批准设计阶段，不授权立即修代码"
- 来源: #360 R1 复审（Codex）场景 B 发现；记录见 `docs/reviews/2026-11-17-align-route-loading-skeletons-review-r1.md`
- 审查记录: [设计 R1](../../../docs/reviews/2026-11-17-stabilize-product-shell-geometry-design-review-r1.md) — R1 CHANGES_REQUIRED（P2×2、P3×1）已处置；R2 APPROVE_DESIGN（R2-01 P3 列入 tasks §2.0）
- 写入负责人: Claude Code（Opus 5.5）（更新时间 2026-11-17）
- 分支 / worktree: `chore/product-shell-css-proposal`（无上游跟踪，未 push）/ `/root/projects/worktrees/monexus-product-shell-css`
- Base: `origin/develop@80a9e3b`
- 已验证 revision: `65e7a36`（`src/` 与 `80a9e3b` 相同；本分支只改 change 目录与审查记录）
- 隔离资源: 本地 `vite preview` 端口 5299（已停止）

## 已完成（附证据）
- 根因调查：外壳规则位于详情页分包 CSS；Vite 预加载等 CSS `load` 后才执行模块 — design Context
- 现状实测（R1 后重写的脚本）：`evidence/shell-check.mjs` 在 `65e7a36` 干净工作区构建上 exit 1，10 项预期失败（≥1024 的 t0≠t3，1920 的 t1≠t3），结果 `evidence/results-80a9e3b-before.json`
- 比较器自检：篡改基线 1 个 t3 宽度 → `final shell differs from baseline`、exit 1；以自身为基线 → 0 项基线差异
- 构建产物核对：只有详情页分包含外壳选择器
- proposal / design / spec（1 条 ADDED）/ tasks

## 待完成
- Owner 批准规格与设计（tasks §0.1）
- Owner 另行授权实施（tasks §0.2）；之前不得修改 `src/**`

## 已批准的设计决策
- 无（待批准）

## 风险与阻断
- 阻断：设计批准门与实施授权门。
- 范围外已记录：`Layout` 的商品详情判断区分大小写（`/PRODUCT/42` 不加 `.product-layout`）；`.product-layout.bg-grid-pattern` 背景规则不命中（`md:bg-grid-pattern`）。

## 验证记录
| 命令 | 结果（exit code） | revision |
|---|---|---|
| `npm ci && npm run build`（Node 22.23.1） | 0 | 80a9e3b |
| `node .../evidence/shell-check.mjs`（`vite preview` :5299，R1 后脚本） | 1，10 项预期失败（见上） | `65e7a36`，`dirtyFiles: []` |
| 同上 `--baseline <篡改 1px 的基线>` | 1，含 `guest@1280x900 final shell differs from baseline` | `65e7a36` |
| `openspec validate stabilize-product-shell-geometry --strict`；`openspec validate --all --strict` | 0；0 | 本分支提交前 |

## 未运行 / 无法验证
- 实施后的效果 — 未授权实施

## 复现
```bash
npm ci && npm run build      # Node 22
npx vite preview --port 5299 --strictPort --host 127.0.0.1 &
node openspec/changes/stabilize-product-shell-geometry/evidence/shell-check.mjs /tmp/shell-check \
  --baseline openspec/changes/stabilize-product-shell-geometry/evidence/results-80a9e3b-before.json
```
阶段、测量对象、固定状态与硬检查见脚本头部注释与 design「Verification plan」。

## 下一步
- Owner 正式批准设计（tasks §0.1）；之后另行决定是否授权实施（§0.2）。实施完成后与代码同一个 PR
