# Handoff: align-route-loading-skeletons

- Spec / 契约: 本 change（proposal / design / specs / tasks）；基线 `openspec/changes/archive/2026-11-17-baseline-route-loading-states/`，主规格 `openspec/specs/web-route-loading/spec.md`；Owner 任务说明《MoNexus P1 — 首个 OpenSpec 驱动的业务开发试点》（2026-11-17）的范围与验收已落入 proposal（Out of scope）、spec、design（Verification plan）
- 审查记录: 无（待 Codex 独立审查）
- 写入负责人: Claude Code（Opus 5.5）（更新时间 2026-11-17）；实施完成，进入审查后停止写入
- 分支 / worktree: `fix/route-loading-skeletons`（无上游跟踪，未 push）/ `/root/projects/worktrees/monexus-route-skeletons`
- Base: `origin/chore/agent-sdd-p0@08a8118`（PR #359 尚未合并；前端代码与 `origin/develop@3b6f1e0` 相同）。#359 合并后需把 `origin/develop` 合入本分支（merge，不 rebase），再开 PR → `develop`
- 已验证 revision: `08a8118` + 本分支实施提交的内容（提交 SHA 见 `git log -1 fix/route-loading-skeletons`；验证均在提交前的同一工作区执行，提交未再改动文件）
- 隔离资源: 本地 `vite preview` 端口 5299（已停止）；无数据库、Redis、容器

## 已完成（附证据）
- Owner 批准规格与设计（2026-11-17）：访客与登录用户加载态一致；浏览器检查用一次性脚本、不提交 E2E — tasks.md §0.1
- 基线归档 `openspec archive baseline-route-loading-states` exit 0；`docs/specs/INDEX.md` 按章节登记被取代范围
- tasks.md §1–§4.4 全部完成：
  - `src/components/ui/RouteFallback.tsx`：`routeFallbackKind()` + 6 种类型骨架 + `StandaloneRouteFallback`
  - `src/components/catalog/ProductDetailSkeleton.tsx`（新增），被路由占位与详情页 `loading` 分支共用
  - `src/App.tsx`：仅顶层 fallback 一处
  - `src/pages/ProductDetailPage.tsx`：仅 `loading` 分支（去掉访客/登录二分），`loginRequired`、错误处理、请求逻辑未动
  - 测试：`src/components/ui/RouteFallback.test.tsx`（新增）、`src/pages/ProductDetailPage.test.tsx`（新增 2 个用例）

## 待完成
- 独立审查（Codex），基于本分支实施提交的固定 SHA
- 审查通过后：等待 #359 合并 → merge `origin/develop` → Owner 授权 push / 开 PR → 合并后 `openspec archive align-route-loading-skeletons`（tasks.md §4.5 余项）

## 已批准的设计决策
- 按路径集中选择占位类型，默认中性 `page`；不给每个路由单独包 `Suspense` — design Decision 1，Owner 2026-11-17 批准
- 商品详情两阶段共用一个只依赖 Tailwind 断点的骨架组件 — design Decision 3
- 访客与登录用户加载态一致 — Owner 2026-11-17 决定
- 浏览器检查使用一次性脚本，不新增提交的 E2E — Owner 2026-11-17 决定

## 风险与阻断
- 无阻断。
- `npm run check:bundle-budget` 退出 1：基线 `08a8118` 同样退出 1（1235.42 KiB > 150 KiB，统计口径为全部资源），属既有问题；本次总量 1236.30 KiB（+0.88 KiB），入口 chunk gzip 171,514 → 172,538 字节（+1,024 B）
- `MerchantShell` 在模块加载期间仍被整体替换（现状，非本次范围）
- 范围外已知问题：商品详情非 404 失败时"提示 + 返回商城"与 `product-commerce-v2` §10.2 不一致；路由模块加载失败 UI（`performance-plan.md` §2.2）

## 验证记录
| 命令 | 结果（exit code） | revision |
|---|---|---|
| `npm test`（根目录，233 文件 / 1896 用例） | 0 | 08a8118 + 工作区（骨架微调前） |
| `npx vitest run RouteFallback.test.tsx ProductDetailPage*.test.tsx`（5 文件 / 78 用例） | 0 | 同上 |
| 骨架微调后 `npx vitest run src/components/ui/RouteFallback.test.tsx src/pages/ProductDetailPage.test.tsx`（54 用例） | 0 | 最终工作区 |
| 新用例在旧 `ProductDetailPage.tsx` 上运行（`git stash` 该文件后） | 2 个用例失败，符合预期 | 08a8118 版本的该文件 |
| `npm run build`（含 `tsc -b`） | 0 | 最终工作区 |
| `npm run check:bundle-budget` | 1（既有，见上；1236.30 KiB） | 最终工作区；基线 08a8118 同样 1（1235.42 KiB） |
| Playwright 一次性脚本（`vite preview` + API stub；慢分包 / 慢商品接口；390 / 768 / 1280） | 0，ALL CHECKS PASSED | 最终工作区构建产物 |
| `openspec validate --all --strict` | 0（change + `web-route-loading` 主规格） | 最终工作区 |

浏览器检查要点（最终构建）：
- 商品详情：每个宽度只有 1 个加载 `status`、无嵌套 status、无网格、无可聚焦元素、数据阶段无商品名、无页面错误；横向溢出 0px（路由阶段 / 数据阶段 / 加载完成）
- 两阶段画廊位置完全相同（无跳变）：390 `y65 h336`、768 `y294 h434`、1280 `y113 h604`；对应真实页面 390 `y65 h336`、768 卡片 `y301 h434`、1280 `y113 h605`
- 390 宽度开启减少动效：骨架 `animation-duration 1e-05s`、`iteration-count 1`
- `/terms`（外壳外）与 `/shops/7`（网格）占位：可见形状 4 / 11 个，横向溢出 0px
- 脚本未入库；测试数据仅为 stub

## 未运行 / 无法验证
- 后端测试、E2E 主套件 — 无后端改动；按 Owner 决定不新增 E2E
- 已登录状态下 `/orders`、`/admin`、`/merchant/*` 的真实浏览器占位截图 — 由单测覆盖类型映射与无网格；浏览器检查只覆盖访客可达路由
- 真实读屏软件播报 — 仅以 DOM 结构（单一 `status`、骨架 `aria-hidden`）验证
- GitHub CI — 未 push

## 下一步
- 审查者：`git -C /root/projects/worktrees/monexus-route-skeletons log --oneline -3`，审查 `08a8118..HEAD`

## 独立审查重点
- `routeFallbackKind` 是否覆盖 `App.tsx` 全部外壳内懒加载路由；正则边界（如 `/administrator`、`/product/1/extra` → `page`）
- 商品详情两阶段同构、三个视口与真实布局对应；访客 / 登录一致；加载期间无任何商品数据
- `loginRequired`、错误处理、`RoleGuard` / `requireAuth`、懒加载分包是否未变；`RouteFallback` 进入主包但未把页面模块拉进主包
- 可访问性：外壳内加载状态与外壳自带两个空 `sr-only` 播报区的关系；路由阶段"正在加载页面"→ 数据阶段"正在加载商品"两次播报是否可接受
- 测试质量：`route-fallback-grid` 断言依赖本次新增的 testid（结构性断言），是否需要更强的反例
