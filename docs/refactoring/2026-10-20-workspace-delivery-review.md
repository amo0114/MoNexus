# 主工作区交付整理

2026-10-21 集中交付进展：按用户授权，依赖 PR #260、#261 已 Squash 合入 develop，
#260 合并后 CI 与 #261 同步后的 PR CI 已通过；其余检查状态见交付报告。
剩余 37 个路径从实际 develop 重放，集中为一个提交、
一个 PR。源码与已验证组合候选一致，精确基线、依赖 CI 和最终验收方式见
[交付准备](./2026-10-20-delivery-readiness.md#集中交付2026-10-21)。下文各轮记录保留
当时状态，不代表这些依赖目前仍是草稿或未合并。

后续进展：组 01 已制作独立补丁及源码快照，并发布
[草稿 PR #260](https://github.com/amo0114/MoNexus/pull/260)。机器人路由只取日期复用代码块。
GitHub 完整 CI 与 `CI OK` 已通过，详情及 E2E 的重试/跳过记录见快照说明。
快照范围和验证证据见
[`后端规则独立交付记录`](./2026-10-20-backend-rules-snapshot.md)。
组 02 也已完成独立快照验证：25 个路径、12 个测试文件/102 项通过，前端构建通过，
并发布[草稿 PR #261](https://github.com/amo0114/MoNexus/pull/261)，GitHub CI 与
E2E 已通过，前端 199 个文件/1694 项通过，重试与条件跳过记录见
[`前端契约独立交付记录`](./2026-10-20-frontend-contracts-snapshot.md)。
组 03 已完成独立本地快照：10 个路径，构建及 5 个文件/92 项回归通过；没有创建
commit 或推送。见
[`商家商品流程快照`](./2026-10-20-merchant-product-flows-snapshot.md)。
组 04 已完成依赖组 02 的本地增量快照：13 个路径，前后端构建通过，前端 64 项、
后端 85 项回归通过。补齐留存调度统一停止和真实清理后游标过期的回归，修复独立
启动留存时统一停止遗漏 timer 的问题；没有新增 commit 或推送。见
[`商城排行与恢复快照`](./2026-10-20-storefront-ranking-snapshot.md)。
组 06、07 已完成文档核对，并组成未提交的本地候选版本；当前路径清单与集中交付
方式见[交付准备](./2026-10-20-delivery-readiness.md)及
[当前清单](./2026-10-20-delivery-current-manifest.json)。组合本地验证已通过：前端全量 201 个文件/1700 项，后端相关 53 个文件/639 项，
前后端构建、6 项架构测试及架构/运行时/包版本检查均通过；最终 CI/E2E 仍待最终 PR。
按用户最新要求，后续先完成本地整理与验证，按完整业务单元集中提交，不按每轮
或每个小改动分别提交推送。
下面的前端测试结果及“本轮”描述保留交付整理当轮的范围。

## 本轮结果与范围

本轮只整理 `/root/projects/MoNexus-new` 的未提交改动，修正文档指引并补充
前端验证。功能 worktree 不在范围。未执行暂存、提交、删除、远程推送或部署。

完整的逐文件清单、Git 状态、历史脏文件标记及未跟踪源码的引用位置保存在
[`2026-10-20-workspace-delivery-manifest.json`](./2026-10-20-workspace-delivery-manifest.json)。
该清单是本轮快照；继续修改后应重新核对，不能直接当作暂存命令输入。

原始脏文件列表来自规范化前保留的本地快照。本轮只能确认某个路径此前是否已脏，
无法仅凭状态列表还原旧的未提交内容。因此，原有拆分与规范化在同一个文件中发生
的修改合在第一组交付；不伪造“之前修改/此次修改”的逐行归属。

## 建议交付分组

下表保留最初的交付分组，组 01–04 后续的独立验证见开头各份报告。组合候选的本地
跨组验证已完成，结果见开头的交付准备报告；最初主工作区及单组结果仍按原范围保留。

| 组 | 内容 | 依赖与交付要求 |
| --- | --- | --- |
| 01 `backend-rules` | 原有 admin/auth/merchant/recharge 服务拆分，公共时间/文件/消费/分页/状态规则，Faka 业务迁移，AI 循环解除，架构检查及相关 CI、测试、模块文档 | 拆出的实现与调用方必须一起纳入；CI、package 脚本和三个架构检查文件一起交付。OpenAPI 包含既有模板注册表补齐与此次管理员分页契约，两者均保留。 |
| 02 `frontend-contracts` | 公共商品类型、API 响应类型、订单续期 hook、商品详情评价错误与重试，及本轮公告测试夹具修正 | `src/types/product.ts` 与所有迁入该类型的调用方一起交付；`useOrderRenewal.ts` 与订单详情弹窗一起交付。评价错误处理是已有的行为变化，评审说明不能称整组为“纯文件移动”。 |
| 03 `merchant-product-flows` | 商品创建草稿/发布流程、编辑保存/冲突恢复、共用履约和交付字段规则 | 创建、编辑页面与四个新实现文件及共享校验一起交付；保留编辑的分步保存结果和版本冲突恢复，不改成跨接口伪原子提交。 |
| 04 `storefront-ranking` | 热卖标识按 `isHot` 投影、排行留存任务、商城 API 提取、游标过期恢复及请求循环修复 | 前端 `storeFeed.ts` 依赖组 02 的公共商品类型。后端排行与前端恢复可各自形成提交，但放在同一修复评审中说明：留存清理会触发旧游标过期。`appStore.ts` 的注册表失败处理属于本组。 |
| 05 `bot-pagination` | 机器人商品搜索从 page 改为 cursor，响应移除 page，新增迁移文档和测试 | **暂缓发布此接口变更**，适配器位置、升级与真实机器人会话验收仍未落实。见后文的共享文件拆分要求；不能把此项算作公共规则规范化已完成的发布验收。 |
| 06 `operations-notes` | 原有 1Panel/OpenResty 静态资源缓存与源站证书记录 | 独立运维文档提交。文档包含历史现场结果，本轮没有访问服务器或重新验证线上状态。 |
| 07 `delivery-docs` | 本交付说明、清单、中英文 README 运行时标识与本地开发指引 | 修正 Node.js 20 → 22、npm 10，并区分日历日期存储值和上海统计时间边界。`CLAUDE.md` 原本未跟踪；纳入指引提交时显式列出。 |
| `local-only` | 根目录 `mx_*`、`inspect_*`、`view_*`、`check_prisma_product.py`、`preview.py`、`run_tests.py`、`p` | 保留原位，不随业务变更提交。这些文件包含特定路径、浏览器调试或现场测量逻辑；未逐个执行，也没有批量删除或用通配符隐藏。 |

推荐顺序：01、02、03、04；06、07 可独立整理。05 等适配器具备发布条件后单独交付。
原始路径见历史清单 `groups[].files`；后续新增路径及当前来源以开头的当前清单为准。
不能仅按表格中的目录批量暂存。

## 必须按代码块拆分的共享文件

`server/src/modules/chatbot/routes.ts` 同时包含：

- 组 01：导入 `businessDateString as shanghaiToday`，删除重复的日期实现。
- 组 05：`/products/search` 从请求读取并传递 `cursor`。

因此该文件在清单中以组 05 为主归属，额外标记组 01。先交付组 01 时只取日期
相关代码块；不能因为日期规范化需要这个文件，就把尚未验收的分页切换一起发布。
`chatbot/catalog.ts`、`bot-pagination.test.ts` 和分页迁移文档均属于组 05。

`docs/superpowers/specs/monexus-api-openapi.json` 的改动是模板注册表与管理员分页，
没有机器人搜索契约的新增描述。不要把它误归为机器人分页升级的证据。

## 新文件、迁移与遗漏核对

- 逐文件清单使用 `git ls-files --others --exclude-standard` 展开未跟踪目录，
  包含创建流程目录中的两个实现；不能只记录 `productCreation/` 目录本身。
- 静态核对记录被引用的未跟踪源码及调用位置，涵盖类型导入、重导出、字面量动态
  导入和 `require`。它用于发现提交漏文件；计算生成的导入路径和远端适配器不在
  该核对范围内。它不能代替构建、运行时或端到端验证。
- Faka 的五个旧文件删除与 `modules/fakaBridge/` 中五个新文件是成对迁移。
  只提交旧目录删除会破坏启动、订单、CLI 与回归测试。
- 第一组保留此前已经未跟踪的服务实现和本轮新增规则文件；“此前已经存在于本地”
  不代表它们已经纳入 Git。不要只暂存已跟踪文件。
- 本次工作区没有数据库 schema、迁移文件或 lockfile 的未提交改动。
- 根目录临时脚本已单独分类并保留，其他功能 worktree 未修改。

引用核对发现并修复了 `AnnouncementCenter.test.tsx` 的旧类型导入：原来的
`../types/announcement` 文件不存在，改为现有的 `../types/admin`，并补齐公开
DTO 所需的 `maxImpressions`、移除管理端字段。因为类型导入运行时会被擦除、
生产构建排除了测试文件，这处问题此前没有被运行时测试或生产构建发现。
这是本轮唯一的测试源码修改；生产代码保持原样。

## 本轮验证

使用 Node.js 22.23.1，未启动或修改数据库。

| 检查 | 结果 |
| --- | --- |
| 商城、商品详情、订单弹窗、商家创建/编辑、店铺、API 与状态仓库的相关前端回归 | 18 个文件、207 项通过 |
| 公告中心测试夹具修复后的定向回归 | 另跑 1 个文件、3 项通过；两次共 19 个文件、210 项 |
| 前端 TypeScript 与生产构建 | 通过 |
| 逐文件分类覆盖、未跟踪源码引用与迁移文件完整性核对 | 结果见 JSON 的 `checks` |
| 本轮源码保留与暂存区核对 | 结果见 JSON 的 `checks` |
| 文档差异空白检查 | `git diff --check` 通过 |

测试输出仍有 jsdom 请求连接失败的 stderr，未导致断言失败；构建输出有大于
500 kB 的 chunk 提示。本轮未修复测试噪声或调整打包策略。

本轮前端测试文件为：

```text
src/pages/StorePage.test.tsx
src/pages/StorePage.cmi.test.tsx
src/pages/StorePage.cursor-expired.test.tsx
src/pages/StorePage.request-loop.test.tsx
src/pages/ProductDetailPage.test.tsx
src/pages/ProductDetailPage.recommendations.test.tsx
src/pages/ProductDetailPage.readonly-audit.test.tsx
src/components/catalog/ProductDetailPhase3.test.tsx
src/components/OrderDetailModal.test.tsx
src/pages/merchant/ProductCreateWizard.test.tsx
src/pages/merchant/ProductEditPage.test.tsx
src/pages/merchant/productEditor/editorFocus.test.ts
src/components/catalog/wizard/steps/WizardSteps.test.tsx
src/components/catalog/wizard/steps/PresentationReviewSteps.test.tsx
src/hooks/useProductFavorite.test.ts
src/pages/ShopPage.test.tsx
src/stores/appStore.test.ts
src/api/orders.test.ts
```

公告夹具修改后另跑：`npm test -- src/components/AnnouncementCenter.test.tsx --maxWorkers=2`。

运行方式：`nvm use` 后将上述文件传给 `npm test -- <文件...> --maxWorkers=2`，
前端构建执行 `npm run build`。后端已有 264 项相关回归、架构检查和构建结果见
[`公共规则规范化记录`](./2026-10-20-business-rule-normalization.md)，本轮没有
修改生产代码，因此不重复运行这些后端检查。

## 集中交付与最终验收

组 01、02 已完成评审并按用户授权合入 develop。#260 合并后 CI 与 #261 同步后的
PR CI 已通过，合并后的 develop 与最终 PR 检查状态以对应链接为准。
组 03、04、06、07 集中为剩余 37 路径交付单元；本地组合验证和精确重放均已完成。
最终 PR 通过 `run-e2e` 标签运行完整 GitHub CI/E2E，结果以 PR 当前检查为准。
本地报告不替代正式 CI，也不将历史重试或条件跳过计为首跑通过。
机器人分页迁移继续单独暂缓。

触及登录/MFA、订单、交付的交付单元合并前需要真实 CI 和既有关键 E2E。
交付整理当轮没有创建远程 PR 或运行 GitHub Actions，也没有执行浏览器 E2E，不能把当时
工作区的局部测试结果表述为整套 CI 已通过。CI 工作流的改动会自动触发 E2E；
后续若将关键链路变更拆成不含工作流的 PR，按测试策略加 `run-e2e` 标签。
