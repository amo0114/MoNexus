# 前端公共契约与订单续期的独立交付快照

## 后续发布进展

已向 `develop` 发布[草稿 PR #261](https://github.com/amo0114/MoNexus/pull/261)，
提交为 `cedc7408bd1c45ad7090f35d671857b25ff37425`，与下文已验证的 Git tree
完全一致。`run-e2e` 标签已生效，
[GitHub CI](https://github.com/amo0114/MoNexus/actions/runs/39438703089)
实际启动了通用 E2E 两个分片、通知实时链路、商品运营 E2E 及前端作业。
后端测试因本 PR 没有后端变更而按路径过滤跳过。

2026-10-20 22:30（Asia/Shanghai）确认 CI 整体成功，8 个作业成功、后端测试
按路径过滤跳过，最终 `CI OK` 通过。PR 保持草稿，未合并或部署。

| 正式 GitHub 检查 | 结果 |
| --- | --- |
| 前端单元测试 | 199 个文件、1694 项通过 |
| 前端 TypeScript 与生产构建 | 通过 |
| 移动端行为与无障碍 | 15 项通过 |
| 主 Playwright 两个分片 | 116 项直接通过、1 项重试一次通过、6 项条件跳过 |
| 法律页面 Playwright | 10 项通过 |
| 通知实时链路 | 10 项通过 |
| 商品运营集成 E2E | 32 项通过 |
| 部署契约与最终 `CI OK` | 通过 |

重试用例为 `e2e/product-gallery-interactions.spec.ts:163` 的移动端滑动切图，
首次等待图片切换超时，首次重试通过，标记为 flaky。此前后端 PR #260 的独立
CI 也记录了同一用例的重试；本 PR 没有修改相册实现或该用例，稳定性问题单独跟踪。
6 项跳过来自旧通知套件的环境条件；独立通知实时链路的 10 项测试全部通过。
不将 flaky 或跳过用例计为首跑通过。

发布提交、运行状态与后续日志见本地产物的 `pr-publication.json` 和
`github-ci-status.json`、`github-test-summaries.json`。发布过程中只更新主工作区
两份交付报告，其余原有改动内容均保留；主工作区 HEAD 和空 index 未改变。
下文“尚未提交/发布”描述的是独立快照制作当轮。

## 范围与依赖

从 `develop` 基线 `56791c3b34feea7748c0a7fc21e020cc58bf0367` 出发，提取
交付清单的 `02-frontend-contracts` 组 24 个路径，加入本轮新增的
`src/pages/ProductDetailPage.reviews.test.tsx`，共 25 个路径。

快照位于独立 worktree `/root/projects/worktrees/monexus-frontend-contracts`，
本地分支为 `chore/frontend-contracts-20261020`。文件只在该 worktree 的 index
暂存，尚未创建提交、推送或远程 PR；主工作区 index 保持为空。

内容包括：

- `src/types/product.ts` 集中商品摘要、详情与商家公开类型；卡片旧类型路径继续
  重导出摘要类型，详情布局、店铺与推荐 API 的调用方一并迁移。
- 订单、店铺商品、推荐响应和详情请求使用已有 DTO 的泛型声明，不改变请求路径
  或响应格式。
- `useOrderRenewal.ts` 从订单弹窗提取续费编排，保留报价/内容/表单/协议版本、
  幂等键和原订单关联；保留会话归属、余额更新、权威进行中计数与移动端结果导航。
- 评价加载失败显示错误与重试，分页重试请求失败的原页，保留已加载评价。
  商品模板加载异常进入现有错误上报。此组包含行为变化，不能描述为纯类型移动。
- 修正公告测试的公开 DTO 导入和夹具字段。

该组在原始 `develop` 上独立构建、运行，无需未合并的后端 PR #260；商城
排行/游标恢复、商家创建编辑、机器人接口迁移和另一功能 worktree 均未纳入。

## 独立验证

使用 Node.js 22.23.1 / npm 10.9.8，针对上述独立快照运行：

| 检查 | 结果 |
| --- | --- |
| 前端 TypeScript 与生产构建 | 通过 |
| 现有相关回归 | 11 个文件、99 项通过 |
| 本轮评价恢复回归 | 1 个文件、3 项通过 |
| 两次回归合计 | 12 个文件、102 项通过 |
| 包含全部新文件的暂存空白检查 | 通过 |
| 补丁在基线上的精确重放 | Git tree 完全一致 |

现有回归覆盖公告中心、订单弹窗、商品详情三组测试、详情布局、收藏、店铺、
订单 API 和商城两组测试。订单弹窗已有断言验证续期报价字段、移动端结果导航、
密码失败恢复及会话切换后丢弃过期结果。

新增评价测试通过真实页面及评价列表组件、模拟 API 验证：首次加载失败不显示为
“暂无评价”；分页失败保留已加载评价、重试同页再继续翻页；切换商品后忽略
旧请求的迟到错误。这些测试也保留在主工作区，未修改生产实现。

验证使用本地 `node_modules` 软链接，未执行全新 `npm ci`。生产构建仍有大于
500 kB 的 chunk 提示及 Browserslist 数据过期提示，本轮不调整打包策略。
没有启动数据库、后端服务或本地浏览器 E2E。

## 产物与重放

本地目录 `outputs/delivery/2026-10-20-frontend-contracts/` 被 Git 忽略，包含：

- `frontend-contracts.patch`、`frontend-contracts-source.tar`：补丁与完整源码 tree。
- `snapshot.json`：精确文件清单、基线、tree 与归档校验和。
- `validation.json`、`test-files.json` 及三个验证日志。
- `main-before.json`、`preservation.json`：主工作区原有改动与 index 的保留核对。
- `PR.md`：准备好的 PR 说明；`README.md`：重放与验证命令。

| 项目 | 值 |
| --- | --- |
| 快照 Git tree | `6594a5014f2a7a1d89ca90ae60eeef78bfa5ef34` |
| 补丁 SHA-256 | `f14c8e84f13f0ea1ce5973f4e9440fd2b353dff2f4126ad19125ff204685e77f` |
| 源码归档 SHA-256 | `42628b24c824a7caebe0ece883d1c587e6504794c3b3883b43278754427b62e0` |

补丁重放使用临时 index，没有操作主工作区 index。归档不包含本地依赖软链接、
构建结果或未跟踪的本地环境配置；以上报告本身不在源码快照中，避免 tree 自引用。

## 快照制作时的交付计划

把此快照提交为面向 `develop` 的独立草稿 PR。续费涉及订单结账关键旅程，
按测试策略使用 `run-e2e` 标签，并确认实际选中的 GitHub 作业包含关键 E2E。
既有 `p6a-subscription.spec.ts` 和 `product-reviews.spec.ts` 已有跨端流程，
本轮评价错误恢复留在组件回归层，不新增浏览器旅程。

正式 E2E 与干净依赖安装由 GitHub Actions 执行，最终以该 PR 的 `CI OK`
为准。本轮尚未运行这份快照的 GitHub CI，也未合并或部署。

## 发布完成后的下一步

本组独立 PR 和 GitHub 验证已完成，保持草稿待评审。接下来整理组 03 的商家
商品创建、编辑、分步保存和版本冲突恢复，先制作独立快照再验证。
