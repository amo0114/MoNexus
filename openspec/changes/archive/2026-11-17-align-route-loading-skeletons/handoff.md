# Handoff: align-route-loading-skeletons

- Spec / 契约: 本 change（proposal / design / specs / tasks）；基线 `openspec/changes/archive/2026-11-17-baseline-route-loading-states/`，主规格 `openspec/specs/web-route-loading/spec.md`；Owner 任务说明《MoNexus P1 — 首个 OpenSpec 驱动的业务开发试点》（2026-11-17）的范围与验收已落入 proposal（Out of scope）、spec、design（Verification plan）
- 审查记录: [R1](../../../docs/reviews/2026-11-17-align-route-loading-skeletons-review-r1.md) — Codex，R1 REQUEST_CHANGES（P2×3、P3×1）已在 `158aa99` 处置；R2 APPROVE（同一文件）
- 写入负责人: Claude Code（Opus 5.5）（更新时间 2026-11-17）；已完成（2026-11-17 合并并归档）
- 分支 / worktree: `fix/route-loading-skeletons`（无上游跟踪，未 push）/ `/root/projects/worktrees/monexus-route-skeletons`
- Base: `origin/chore/agent-sdd-p0@08a8118`（PR #359 尚未合并；前端代码与 `origin/develop@3b6f1e0` 相同）。#359 合并后需把 `origin/develop` 合入本分支（merge，不 rebase），再开 PR → `develop`
- 提交: `974049d` 实施；`158aa99` R1 修复（代码与证据脚本）；其后一个提交只加入证据结果、审查记录与本交接（无代码改动）
- 已验证 revision: 代码 = `158aa99`（浏览器证据、入口体积、全量单测与构建均在该提交的干净工作区上执行）
- 隔离资源: 本地 `vite preview` 端口 5299（已停止）；无数据库、Redis、容器

## 已完成（附证据）
- 规格与设计经 Owner 批准（2026-11-17）；基线已归档，`docs/specs/INDEX.md` 按章节登记
- 实施（`974049d`）：`RouteFallback.tsx`（类型选择 + 6 种骨架 + `StandaloneRouteFallback`）、`ProductDetailSkeleton.tsx`（新增，两阶段共用）、`App.tsx` 顶层 fallback 一处、`ProductDetailPage.tsx` 仅 `loading` 分支
- R1 修复（`158aa99`）：F-01 中屏 / 宽屏网格与画廊上限；F-02 `matchPath`；F-03 证据脚本；F-04 测试加强 — 处置表见 R1 记录

## 待完成
- 无。#360 已合并（`054a4d4`）；本 change 已归档（`openspec archive`），`docs/specs/INDEX.md` 已填生效提交。
- FOLLOW_UP（未立项）：详情页 CSS 迟到时 `.product-layout` 外壳跳变，见下方风险。

## 已批准的设计决策
- 按路径集中选择占位类型，默认中性 `page` — design Decision 1，Owner 2026-11-17 批准
- 商品详情两阶段共用只依赖 Tailwind 断点的骨架组件 — design Decision 3
- 访客与登录用户加载态一致；浏览器检查不加入 E2E 套件 — Owner 2026-11-17 决定（证据脚本作为 change 附件随归档保存）

## 风险与阻断
- 无阻断。
- 待 Owner 决定（既有问题，非本次引入）：详情页分包 CSS 晚于 JS 到达时，外壳在路由占位阶段按通用宽度渲染，CSS 到达后变宽（1920 下画廊 x 344→144）。修复需把 `.product-layout` 外壳规则移入主包 CSS，超出批准范围；R2 建议另开 FOLLOW_UP（覆盖冷缓存、迟到 CSS 与桌面断点）。CSS 与 JS 的到达顺序没有保证，不能据此视为稳定。
- 平板（768–1023）骨架画廊比真实画廊卡片高 7–10px（`results-158aa99.json` 中 768：294 vs 304；1023：294 vs 301），尺寸一致。
- `check:bundle-budget` 既有失败（全部资源 1236.52 KiB > 150 KiB；基线 1235.42 KiB 同样失败，见 R1 记录）
- 范围外：商品详情非 404 失败处理与 `product-commerce-v2` §10.2 不一致；路由模块加载失败 UI；`MerchantShell` 加载期间被整体替换

## 验证记录
| 命令 | 结果（exit code） | revision |
|---|---|---|
| `npm test`（根目录，233 文件 / 1909 用例） | 0 | `158aa99` 工作区（提交前，内容与提交相同） |
| `npm run build`（含 `tsc -b`） | 0 | 同上 |
| F-04 变异验证：列表分支换回旧六卡片网格后运行 `RouteFallback.test.tsx` | 6 失败 / 45 通过，符合预期；文件已还原（`cmp` 一致） | 同上 |
| 商品加载用例在 `08a8118` 版 `ProductDetailPage.tsx` 上运行 | 2 失败，符合预期 | `974049d` 时执行 |
| `node evidence/loading-check.mjs`（见下） | 0，ALL HARD CHECKS PASSED；`dirty: false` | `158aa99` |
| `node evidence/entry-gzip.mjs`，两个 SHA 各自 `npm run build` 后 | 08a8118：171,878 B；158aa99：173,000 B（+1,122 B）；R2 独立复测 head 为 173,000 B，base 未独立复算 | Node 22.23.1 / npm 10.9.8 |
| `node scripts/check-frontend-bundle-budget.mjs` | 1（既有，1236.52 KiB） | `158aa99` 构建产物 |
| `openspec validate --all --strict` | 0 | `158aa99` |

## 复现步骤（浏览器证据）
```bash
git checkout 158aa99            # 或在本 worktree
npm ci && npm run build          # Node 22
npx vite preview --port 5299 --strictPort --host 127.0.0.1 &
node openspec/changes/align-route-loading-skeletons/evidence/loading-check.mjs /tmp/loading-check
# 输出 /tmp/loading-check/results.json 与每个视口的截图（A1/A2/A3/B 不截图/C）
```
- 视口：390、767、768、1023、1024、1279、1280（高 900），1280×720，1920×1000；390 开启减少动效
- 场景 A：拦截 `**/assets/ProductDetailPage-*.js` → 测量（阶段 1）→ 放行 JS，`GET /api/products/42` 仍挂起 → 测量（阶段 2）→ 放行 API → 测量真实页面
- 场景 B：同时拦截详情页 JS 与 CSS → 测量 → 一起放行 → 测量
- 测量选择器：骨架画廊 `[data-skeleton-part="gallery"] > *`、骨架摘要 `[data-skeleton-part="summary"]`；真实画廊 ≥1024 `.pd-gallery-slot [data-testid='product-gallery'] > div > div:last-child`、768–1023 `[data-testid='product-gallery']`、<768 `.pm-gallery`；真实购买栏 `.pd-purchase`
- 硬检查：单一加载 status、无嵌套 status、无可聚焦元素、加载期间无商品名、无页面错误、三阶段无横向溢出、阶段 1 与阶段 2 位置完全相同、减少动效下动画 1 次且时长 < 0.01s；`/terms` 与 `/shops/7` 占位可见且无溢出
- 本次结果：`evidence/results-158aa99.json`。骨架与真实页面画廊位置：390 / 767 / 1024 / 1279 / 1280×900 / 1280×720 / 1920 取整后坐标一致（fixture 为单张空图，不含多图或视频，不代表所有媒体布局）；购买栏起点在桌面各宽度一致（高度不同：骨架 540，真实 612–871）

## 未运行 / 无法验证
- 已登录状态下 `/orders`、`/admin`、`/merchant/*` 的真实浏览器占位 — 由单测覆盖类型映射、结构与无网格
- 真实读屏软件播报 — 仅以 DOM 结构验证
- 后端测试、E2E 主套件、GitHub CI — 无后端改动；未 push

## 下一步
- #359 合并后：merge `origin/develop` 进本分支，对新的固定 SHA 做差异核对，经 Owner 授权 push / 开 PR，等待 `CI OK`

## 独立审查重点（复审）
- F-01：`lg` / `xl` 网格与 `desktop-bp-mid.css`、`desktop-layout.css` 是否一致；画廊上限表达式
- F-02：`matchPath` 模式与 `App.tsx` 路由声明是否一一对应，顺序是否保证具体路由先于 `/admin/*`、`/merchant/*`
- F-04：通用网格反例是否足够；是否仍有自证断言
- 场景 B 既有问题的处理方式（记录待决，不在本次修改）
