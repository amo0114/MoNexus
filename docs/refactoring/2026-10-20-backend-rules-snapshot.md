# 后端规则与架构约束的独立交付快照

## 后续发布进展

已从本快照建立独立分支 `refactor/backend-business-rules-20261020`，向 `develop`
发布[草稿 PR #260](https://github.com/amo0114/MoNexus/pull/260)。初始提交
`da2b2740922afef50e5ff95f7d868398e89781df` 的 tree 与下文验证快照完全一致。

[首轮 GitHub CI](https://github.com/amo0114/MoNexus/actions/runs/39433576422)
完成了完整套件和 E2E；唯一失败是 `security-gaps.test.ts` 的文档契约断言。
README 的接口表更新遗漏了旧 `/logs` 返回 `PointLog`、而非 `AdminLog` 的明确说明。
后续提交 `0bf847d9115a356b5f7e637b06245d2aad8745fa` 只补回这条文档契约，
对应现有 6 项安全证据测试已在本地通过；临时配置跳过数据库全局 hooks，因为这些
用例仅读取文件及调用纯审计函数。正常数据库 hooks 仍由 GitHub CI 验证。

[修正后的 GitHub CI](https://github.com/amo0114/MoNexus/actions/runs/39434784255)
已于 2026-10-20 22:04（Asia/Shanghai）确认整体成功，全部 15 个作业及
`CI OK` 通过。PR 保持草稿，未合并或部署。

| 正式 CI 检查 | 结果 |
| --- | --- |
| 后端构建与完整测试（6 个分片，PostgreSQL 16） | 270 个文件、2684 项通过 |
| 前端单元测试与构建 | 198 个文件、1691 项通过；构建通过 |
| 主 Playwright（2 个分片） | 116 项直接通过、1 项首次重试通过、6 项条件跳过 |
| 法律页面 Playwright | 10 项通过 |
| 移动端行为与无障碍检查 | 15 项通过 |
| 通知实时链路 E2E | 10 项通过 |
| 商品运营集成 E2E | 32 项通过 |
| 架构/API、部署契约与最终汇总 | 通过 |

主套件中 `product-gallery-interactions.spec.ts:163` 的移动端滑动切图用例首次
等待图片切换超时，重试一次通过，CI 标记为 flaky；本轮未修改相册生产代码或该用例。
6 项跳过均来自旧通知套件的环境条件；独立通知实时链路作业的 10 项测试已通过。
这些结果保留在最终日志及汇总 JSON 中，不将 flaky 或条件跳过计为首跑通过。

原始补丁与源码归档继续对应初始快照；文档修正另存为
`publication-followup.patch`，最新发布提交、tree 和运行状态见本地产物
`pr-publication.json`、`github-ci-status.json`。下文“未推送/未创建 PR”描述的是
快照制作当轮的历史状态。主工作区只同步了上述一行文档修正及交付记录，
生产源码和暂存区保持原状，另一功能 worktree 未参与。

## 交付内容

从基线提交 `56791c3b34feea7748c0a7fc21e020cc58bf0367` 出发，取
[`交付清单`](./2026-10-20-workspace-delivery-manifest.json) 中
`01-backend-rules` 的 135 个路径，再加入机器人路由的日期复用代码块，
得到 136 个新增、修改或删除的路径。Git 显示为重命名时，五对 Faka 路径会合并
展示；路径计数按关闭重命名检测的结果计算。

快照包含 admin/auth/merchant/recharge 服务拆分、公共业务规则、Faka 业务迁移、
AI 依赖循环解除及架构约束。机器人搜索的请求和响应保持基线契约；
`chatbot/routes.ts` 仅复用 `businessDateString`，游标转发代码块留在主工作区。
商城排行与留存、前端、运维记录、根目录临时脚本也保持独立。

本地保存了源码归档、补丁、快照元数据、测试文件列表和验证日志：

```text
outputs/delivery/2026-10-20-backend-rules/
  backend-rules.patch
  backend-rules-source.tar
  snapshot.json
  patch-replay.json
  backend-test-files.json
  backend-test-result.json
  backend-build.log
  architecture.log
  backend-tests.log
  database-setup.log
  database-migrations.log
  database-cleanup.log
  validation.json
  cleanup.json
  README.md
  PR.md
```

`outputs/` 已被仓库忽略，这些是本地交付产物。新克隆仓库不会自动获得它们；
需要保留补丁或源码归档，才能在别处重放。未创建分支提交、远程 PR、推送或部署。
主工作区暂存区保持为空，另一功能 worktree 未参与。

## 快照与重放证明

| 项目 | 值 |
| --- | --- |
| 基线提交 | `56791c3b34feea7748c0a7fc21e020cc58bf0367` |
| 快照 Git tree | `3ff490842b295728892b9bd717cd348a99f2c482` |
| 补丁 SHA-256 | `d998e0a265745cc4318569f5215fd2942b8b61ad1dda1b2c6abb63b5a74c01a2` |
| 变更路径 | 136 |

构造及重放均使用独立临时 Git index。将补丁应用到基线的临时 index 后，
重新生成的 tree 与上表完全一致。重放检查还对包含新文件的全部暂存差异执行了
空白检查。主工作区 index 没有被用来暂存此次快照。

源码归档只包含该 tree 的文件；验证时的 `node_modules` 使用本地依赖软链接，
这些软链接不在补丁或源码归档中。快照独立验证了源码范围，但没有执行全新依赖
安装，GitHub CI 仍需按 lockfile 执行 `npm ci`。

## 新文件空白修正

独立 index 检查覆盖了普通 `git diff --check` 不包含的未跟踪文件，发现以下
8 个文件末尾有多余空行。本轮只删除这些末尾空行，没有改动其业务逻辑：

```text
server/src/lib/ai/featurePolicy.ts
server/src/modules/announcements/adminController.ts
server/src/modules/announcements/adminSchema.ts
server/src/modules/announcements/adminService.ts
server/src/modules/catalog/productLock.ts
server/src/modules/fakaBridge/taskQueries.ts
server/src/modules/orders/provisioningConfig.ts
server/src/modules/orders/statusPolicy.ts
```

主工作区保留这 8 项空白修正；日期代码块的拆分只发生在交付快照中，
主工作区的机器人路由没有被回退或改写。

## 验证结果

以下检查针对独立快照执行，而非混合改动的主工作区：

| 检查 | 结果 |
| --- | --- |
| 后端 TypeScript 构建与模板注册表运行时导入 | 通过 |
| 架构规则自身测试 | 6 项通过 |
| 实际架构边界、静态循环及 OpenAPI 检查 | 通过 |
| 补丁重放 | tree 完全一致 |
| 包含未跟踪新文件的空白检查 | 通过 |
| 定向后端集成回归 | 46 个文件、548 项全部通过；UTC，约 350 秒 |

本地运行时为 Node.js 22.23.1；后端回归使用独立 PostgreSQL 14 临时实例，
数据库和 schema 来自本快照。保持 PostgreSQL 默认持久化设置，使用内存文件系统
保存可丢弃数据。CI 的 PostgreSQL 为 16，因此本地结果不能代替正式 CI。

测试覆盖公共规则、Faka 履约与竞争、管理员和商家服务，以及认证/MFA/会话、
密码重置邮件一致性、公告、充值报价/支付入账/退款与并发。所选测试的精确文件列表
保存在交付产物的 `backend-test-files.json`；本轮没有运行全量后端测试。

验证完成后已停止临时 PostgreSQL，确认端口关闭并删除其数据目录。准备过程中
产生的两份中间解压目录也已清理，仅保留最终已验证的解压快照与交付产物。
`cleanup.json` 记录了资源清理结果，并确认验证时 `fsync`、`synchronous_commit`、
`full_page_writes` 均为 `on`。

## E2E 执行位置

正式合并前的 E2E 放在 GitHub Actions 跑。本地负责构建、规则检查和定向后端回归；
出现只能在浏览器复现的问题时，再选择相应的本地 E2E 排查。

此快照包括 `.github/workflows/ci.yml`，该路径命中工作流中的 E2E 过滤器。
建立面向 `develop` 的 PR 后，会选择主 Playwright、通知实时链路和 catalog-ops
套件；主套件另含法律页面检查，frontend job 包含独立移动浏览器套件。
最终由 `CI OK` 汇总所有所选检查。参见
[`分支与 CI 规范`](../branching-and-ci.md) 和 [`测试策略`](../testing-policy.md)。

当前 CI 的触发事件是指向 `develop/master` 的 PR 及两个分支的 push，没有
`workflow_dispatch`。本地归档或普通功能分支 push 本身不会代替 PR 触发本套 CI。
如果以后把关键认证/下单改动拆到不包含工作流的 PR，按测试策略添加 `run-e2e`
标签，保证合并前执行关键旅程。

本轮没有上传快照或运行 GitHub Actions，也没有运行本地浏览器 E2E。
本快照的相关回归和资源清理已完成，PR 标题与说明保存在本地交付产物的 `PR.md`。
下一步将该快照整理为面向 `develop` 的独立 PR，由 GitHub CI 验证完整套件和 E2E；
其余前端和商城交付组继续按各自边界处理。
