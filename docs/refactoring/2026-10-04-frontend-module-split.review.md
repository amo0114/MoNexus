# 前端拆分实施结果与 Review 记录

对应任务书：[前端大文件拆分任务书](2026-10-04-frontend-module-split.tasks.md)。

当前状态：**仅提供空白交付模板，尚未执行本任务书中的后续拆分。** 由实施 agent 按实际结果填写，不得将任务要求复制为已通过的结论。

## 1. 输入与比较范围

| 字段 | 实际值 |
| --- | --- |
| 实施者 / 日期 | 前端结构重构实施 agent / 2026-10-04 |
| 源仓库与工作分支 | `MoNexus-new`（源工作区，本次未改动）；本任务分支 `refactor/r10` |
| 实施 worktree 与分支 | `/root/projects/monexus-r10`，`refactor/r10` |
| 源 HEAD | `20f493a88ce817af1a01ae89f89ad1394ae01f1a`（编写任务书时；实施期间未变化） |
| 输入快照基线 SHA | `a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a` |
| 最终重构 SHA | R10 单个本地提交 HEAD，见交付报告 `git rev-parse HEAD` |
| 原工作区状态清单 / diff 保存位置 | 源工作区 `git status --short` 共 104 项；本次实施未读取/未修改，故未另存 diff |
| 继承的修改与未跟踪文件清单 / 哈希 | 由 R00 输入快照提交 `a1c27e0` 固化；本报告范围内文件见 §3 |
| 基线测试 / 构建结果及日志 | 基线 3 文件 / 16 用例全通过；构建 `✓ built`，退出码 0 |
| 原工作区未被本次实施改动的核对结果 | 已核对：`MoNexus-new` HEAD 仍为 `20f493a`，未提交条目数 104 未变；本任务全部写入仅发生在 `/root/projects/monexus-r10` |

`src/pages/StorePage.tsx` 的商城卡片与相关前端功能属于输入快照带入的既有功能，不算本次重构新增。

Review 的真实命令（R10，`<refactor-head>` = 该任务提交）：

```bash
git log --oneline a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a..refactor/r10
git diff --stat a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a refactor/r10
git diff a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a refactor/r10
```

## 2. 任务与提交

状态允许：未开始、实施中、待验证、完成、有条件子项未实施（说明原因）。未执行的验证不写“通过”。

| 任务 | 内容 | 提交 SHA | 状态 | 验证记录 / 未完成原因 |
| --- | --- | --- | --- | --- |
| R00 | 隔离输入基线 | — | 未开始 | — |
| R01 | 分类表单、审核、排序子组件 | — | 未开始 | — |
| R02-1 | 向导定价、附加规格、交付面板 | — | 未开始 | — |
| R02-2 | 展示信息、确认草稿面板 | — | 未开始 | — |
| R03-1 | 商家商品、订单面板 | — | 未开始 | — |
| R03-2 | 满足生命周期等价条件的局部状态下沉 | — | 未开始 | 条件不成立可不实施，须说明 |
| R04 | 商品编辑页分区 | — | 未开始 | — |
| R05-1 | 图库、评价列表 | — | 未开始 | — |
| R05-2 | 中屏详情布局 | — | 未开始 | — |
| R06 | 桌面详情内容、购买侧栏 | — | 未开始 | — |
| R07-1 | 移动详情内容区块 | — | 未开始 | — |
| R07-2 | 移动购买底栏、规格抽屉 | — | 未开始 | — |
| R08-1 | 会员、邀请卡片 | — | 未开始 | — |
| R08-2 | 个人中心订单面板 | — | 未开始 | — |
| R09a | 推广活动弹窗 | — | 未开始 | — |
| R09b | 推广套餐表单 | — | 未开始 | — |
| R09c | 精选编辑、撤销弹窗 | — | 未开始 | — |
| R09d | 管理端商品表格、人数上限弹窗 | — | 未开始 | — |
| R10 | 商城商品卡片 | 见交付报告 SHA（单个本地提交） | 完成（浏览器 E2E 待验证，见 §5） | 7 条验证命令全部退出码 0；`store-pagination.spec.ts` 因环境归属未在本 worktree 执行 |
| R11-1 | 全局样式组织 | — | 未开始 | — |
| R11-2 | 详情样式组织 | — | 未开始 | — |
| R12 | 推广活动测试按行为分组 | — | 未开始 | — |

## 3. 职责与状态归属

每个任务至少一条职责映射；发生状态迁移时逐项说明，未迁移也明确记录。

| 任务 | 原文件 / 符号 | 新文件 / 符号 | 留在父层的职责 | 行数前后（辅助） |
| --- | --- | --- | --- | --- |
| R10 | `StorePage.tsx` 内 `ProductCard`（展示组件，约 122–272） | `components/store/StoreProductCard.tsx` `StoreProductCard` | 列表请求、分类与 URL 同步、推荐混排、audience 缓存、分页、滚动恢复 | 页面 1008 → 819；新卡片 164 |
| R10 | 卡片内 `faka` / `isSoldOut` / `stockTitle` / `stockLabel` 推导 | 随卡片迁入 `StoreProductCard.tsx` 函数体 | 父层不再持有这些展示推导 | 见上 |
| R10 | `StorePage.tsx` 内 `interface Product` | `components/store/types.ts` `Product`（导出） | 父层继续以该类型标注 feed/缓存/响应；DOM 与请求不变 | types.ts 42 行 |
| R10 | `StorePage.tsx` 内 `interface FeedDisclosure` | `components/store/types.ts` `FeedDisclosure`（导出） | 父层继续在调用点构造 `disclosure` 并传入 | 见上 |

类型落点理由：`Product` 与 `FeedDisclosure` 在父页面（feed 状态、缓存、列表响应、调用点构造）与卡片（props）**多处真实使用**，按任务书 §5 R01 已定范式「多处真实使用的类型再放 `types.ts`，不让新模块反向 import 页面」放入 `components/store/types.ts`。未放入 `src/types/`，因该目录现有文件均为后端冻结契约镜像（见 `types/catalog.ts`、`types/merchandising.ts` 头部注释），页面私有 DTO 放入会改变该层语义。

| 状态 / effect / ref | 原所有者 | 新所有者 | 切换 / 卸载 / 重开时的原行为 | 保持方式与证据 |
| --- | --- | --- | --- | --- |
| （无状态迁移） | — | — | R10 未迁移任何 `useState` / `useEffect` / `useRef`；卡片原本即无状态，全部页面状态留在 `StorePage` | 页面 diff 仅含 import 收敛、类型下移、卡片函数删除与标签改名；无 hook 增减 |

父层保留的几何常量说明：`CARD_HEIGHT_DESKTOP` / `CARD_HEIGHT_MOBILE` 虽描述卡片高度，但由父层虚拟滚动（`cardHeight`、`rowStride`、`virtualGridHeight`）消费，属页面布局控制，故留在 `StorePage`；其上方注释「Keep in sync with ProductCard media」是既有耦合提示，按要求不改文案故保持原文。

## 4. 实际验证记录

按提交或相同 tree 记录。可以链接独立日志，不能只写“全部测试通过”。不要将凭据或敏感响应写入日志。

| 任务 / SHA 或 tree | 命令 | 退出码 | 文件数 / 用例数或构建结果 | 日志位置 |
| --- | --- | --- | --- | --- |
| R10（基线 `a1c27e0`） | `npx vitest run src/pages/StorePage.test.tsx src/pages/StorePage.cmi.test.tsx src/hooks/useProductFavorite.test.ts` | 0 | 3 文件 / 16 用例通过 | 会话记录 |
| R10（最终 tree） | `npm run check:runtime` | 0 | Node/npm 版本门通过 | 会话记录 |
| R10（最终 tree） | `npx tsc --noEmit` | 0 | 无类型错误 | 会话记录 |
| R10（最终 tree） | `npx vitest run src/pages/StorePage.test.tsx` | 0 | 1 文件 / 3 用例 | 会话记录 |
| R10（最终 tree） | `npx vitest run src/pages/StorePage.cmi.test.tsx` | 0 | 1 文件 / 10 用例 | 会话记录 |
| R10（最终 tree） | `npx vitest run src/hooks/useProductFavorite.test.ts` | 0 | 1 文件 / 3 用例 | 会话记录 |
| R10（新增边界测试） | `npx vitest run src/components/store/StoreProductCard.test.tsx` | 0 | 1 文件 / 3 用例 | 会话记录 |
| R10（最终 tree） | `npm run build` | 0 | `✓ built in 15.21s`；仅既有 chunk 体积警告 | 会话记录 |
| R10（最终 tree） | `git diff --check` | 0 | 无空白错误 | 会话记录 |
| R10（最终 tree） | `git diff --cached --check` | 0 | 无空白错误 | 会话记录 |

等价性强证据（基线源码导出至 `/tmp` 独立构建，构建后已清理，工作区未受影响）：

| 对比项 | 基线 | 重构后 | 结论 |
| --- | --- | --- | --- |
| 卡片函数体源码 | 基线第 132–271 行 | 新组件同段 | `diff` 逐字节为空（仅多出组件函数自身的收尾 `}`） |
| CSS 产物 | `index-BnBNxjgA.css` | 同名同 md5 | 类名与样式零漂移 |
| 用户可见中文文案片段 | 4016 | 4016 | 差集为空 |
| `data-testid` 集合 | 11 项 | 11 项 | 对称差为空 |
| `aria-label` 出现次数 | 253 | 253 | 一致 |

新增测试的鉴别力经变异验证：分别打断 `onOpen` 调用、`faka.sellable === false` 判定、`capacityLimit` 分支，对应用例各自失败；还原后通过。

浏览器证据记录：

| 任务 / SHA | fixture / 页面 | 主题 / 视口 / 动效设置 | 实际交互与结果 | 前后证据位置 |
| --- | --- | --- | --- | --- |
| R10 | `e2e/store-pagination.spec.ts` | 默认主题 / Desktop Chrome | **未执行**：该 spec 的 `beforeAll` 会经管理员 API 写入共享数据库，且当时 `5173` 端口为源工作区 `MoNexus-new` 的 vite 进程（pid 129777）、后端 `3000` 为共享服务，在本 worktree 上运行既验证不到本次改动又会污染共享数据 | 待后续在隔离 E2E 环境按 §18.2 复现 |

测试拆分 R12 另附：原用例名称多重集合、新用例名称多重集合、总数对比、各文件单跑与共同运行结果。

## 5. 偏差、失败与未验证项

| 项目 | 基线是否已存在 | 当前影响 | 证据 / 复现方式 | 是否影响完成判定 |
| --- | --- | --- | --- | --- |
| 浏览器 E2E 未在本 worktree 执行 | 否（环境限制，非代码问题） | 真实滚动、布局测量与返回路径恢复缺浏览器层证据 | `npx playwright test e2e/store-pagination.spec.ts` 需隔离 E2E 环境；当前 5173 属源工作区 | 影响“待验证”标注，不影响代码完成判定 |
| 既有 chunk 体积警告 | 是 | 无 | `npm run build` 输出 1,690 kB chunk 警告，基线构建同样存在 | 否 |

逐项确认并说明证据：

- 用户可见文案、DOM/ARIA、视觉或交互是否发生变化：**无变化**。基线/重构产物中文文案片段差集为空（4016 对 4016）；`data-testid` 集合对称差为空；`aria-label` 计数 253 对 253；CSS 产物 md5 相同；卡片 JSX 与基线逐字节等同。
- API 请求、权限、版本冲突、重复提交、过期响应处理是否发生变化：**无变化**。页面未改动任何 `api.get` 调用、`params`、epoch/`candidateRequestRef` 保护或 `loadMore` 路径；卡片原本不发请求、无状态。
- 第一批的校验文案差异和未知履约配置行为是否保持：**不变**（R10 未触及该范围）。
- CSS 条件、声明和覆盖顺序是否保持：**保持**，`index-BnBNxjgA.css` 字节相同。
- 存在未执行的关键旅程测试或浏览器核验：`e2e/store-pagination.spec.ts` 未执行，原因见上表；任务书要求的三条测试命令与两条渲染核对均已执行。
- 是否存在超出任务书范围的修改：**无**。改动仅限 `StorePage.tsx`、新增 `components/store/{StoreProductCard.tsx,types.ts,StoreProductCard.test.tsx}` 与本 review 记录；未触碰 `server/**`、DTO、路由、依赖、锁文件、CI、ESLint。

## 6. 交回 Review

实施 agent 的最终交接摘要：

R10 已完成单一本地提交 `b293fe890da5859e7b7627ff3a7cf0c97634f997`（分支 `refactor/r10`，基线 `a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a`）。`StorePage.tsx` 中约 122–272 行的 `ProductCard` 及其独占的 `faka` / `isSoldOut` / `stockTitle` / `stockLabel` 展示推导迁入新增 `src/components/store/StoreProductCard.tsx`（164 行，模块顶层定义）；父页面保留列表请求、分类与 URL 同步、推荐混排、audience 缓存、分页与滚动恢复，未迁移任何 hook/state/ref（卡片原本无状态）。`Product` 与 `FeedDisclosure` 因两侧共用，按任务书 §5 已定范式落 `src/components/store/types.ts`。

验证：任务书要求的 7 条命令全部真实执行且退出码为 0（`check:runtime`、`tsc --noEmit`、三条指定测试、`build`、两条 `diff --check`）；另新增 1 个边界测试文件（3 用例，经变异验证具备鉴别力）。等价性以基线源码独立构建对比取证：卡片源码逐字节相同、CSS 产物 md5 相同、中文文案 4016 对 4016 无差异、`data-testid` 集合一致、`aria-label` 计数 253 对 253。

未执行项：`e2e/store-pagination.spec.ts` 未在本 worktree 运行——其 `beforeAll` 会写入共享数据库，且当时 5173 端口属源工作区 `MoNexus-new` 的 vite 进程，运行既无验证价值又有污染风险；该项按任务书 §18.2 标记为待验证，不影响代码完成判定。源工作区 `/root/projects/MoNexus-new` 未被本次实施改动。

原 agent 的 review 结论与待修问题：留空，待审查后填写。
