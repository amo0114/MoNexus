# 商家商品创建与编辑的独立本地快照

## 范围和提交方式

本轮提取交付清单 `03-merchant-product-flows` 的全部 10 个路径，作为完整的
创建、编辑、履约规则交付单元。源码内容沿用主工作区现有改动，本轮没有修改
生产实现或新增测试。

用户要求不要每轮少量改动就提交推送。后续以完整业务单元和验证结果组织集中
提交，轮次只用于汇报进度。本轮创建 detached HEAD 的独立本地 worktree，
仅使用该 worktree 的 index 构造快照，没有创建 commit、推送或远程 PR。
主工作区 index 保持为空，其他既有 worktree 未参与。

## 已核对的规则边界

- 创建流程：`productCreation/draft.ts` 负责步骤校验、履约选择和草稿载荷；
  `useProductCreation.ts` 负责草稿身份、可售规格、发布检查和发布请求。
  成功保存保留 productId，重复进入保存步骤不创建第二份草稿；失败保留输入。
- 编辑流程：`editorForm.ts` 负责 DTO 和图片引用解析，`saveProductEdits.ts`
  负责校验、内容保存、规格保存与版本冲突恢复，页面继续持有表单状态和反馈。
- 创建商品与规格仍使用一次草稿请求；编辑仍先保存商品内容、再逐个保存规格。
  每次成功写入立即回调更新 contentVersion、checkoutVersion 和对应基线，
  后续失败不会撤销已成功写入，也不把多个 HTTP 请求描述成原子事务。
- 规格冲突恢复使用已经成功保存后的 workingOffers 做三方合并，保留本地可恢复
  修改并显示冲突字段；文件绑定流程及其独立版本更新仍留在页面中。
- 创建和编辑共用交付字段校验、序列化及履约规则匹配；编辑保留已有字段和未知
  履约配置回退为 manual_service 的兼容策略，创建继续只接受已知配置。

这些调用方和四个新增实现文件一并纳入，没有漏掉未跟踪源码。
快照直接基于 `56791c3b34feea7748c0a7fc21e020cc58bf0367` 构建，不依赖尚未
合并的 PR #260、#261；商城排行/游标、机器人迁移和功能 worktree 不在范围。

## 独立验证

工作目录：`/root/projects/worktrees/monexus-merchant-product-flows`。
运行时：Node.js 22.23.1 / npm 10.9.8。

| 检查 | 结果 |
| --- | --- |
| 前端 TypeScript 与生产构建 | 通过 |
| 创建、编辑、编辑器焦点与向导步骤回归 | 5 个文件、92 项通过 |
| 全部暂存路径空白检查，包含新增源码 | 通过 |
| 补丁在基线上的重放 | 与快照 Git tree 完全一致 |

现有回归涵盖创建草稿载荷、幂等保存、保存失败保留输入、图片引用、结构化交付、
分类与交付方式独立、发布防重复与会话归属；编辑涵盖内容版本、规格版本、
版本冲突后的输入合并、字段增删冲突和同批后续规格冲突后再保存。

精确测试文件列表：

```text
src/pages/merchant/ProductCreateWizard.test.tsx
src/pages/merchant/ProductEditPage.test.tsx
src/pages/merchant/productEditor/editorFocus.test.ts
src/components/catalog/wizard/steps/WizardSteps.test.tsx
src/components/catalog/wizard/steps/PresentationReviewSteps.test.tsx
```

测试复用本地依赖软链接，没有执行全新 npm ci；构建仍有大于 500 kB 的 chunk
提示与 Browserslist 数据过期提示，测试有 jsdom 请求连接失败的 stderr，断言全部
通过。本轮未调整打包、测试公共环境，也没有启动数据库或浏览器 E2E。
正式 GitHub CI 与真实浏览器回归仍待后续集中交付时执行，不能用本轮结果代替。

## 本地产物

`outputs/delivery/2026-10-20-merchant-product-flows/` 被 Git 忽略，包含补丁、
完整源码归档、精确文件列表、验证日志、重放证明及主工作区保留记录。

| 项目 | 值 |
| --- | --- |
| 基线 | `56791c3b34feea7748c0a7fc21e020cc58bf0367` |
| 快照 Git tree | `7c74df535972a26163c1f52d650666cd9d96909a` |
| 路径数 | 10 |
| 补丁 SHA-256 | `798772c684a958280fde31e13e62a0ffa507c62ce84248bfe43e0a93ab75435b` |
| 归档 SHA-256 | `671b3ab8c36be99b3b377dcbacc943974c7584368252a8ac193fe861c89695ac` |

## 后续

继续整理组 04 的商城排行、留存清理和游标恢复，先完成剩余本地验证，再按完整
业务单元集中组织提交和推送。不把“进入下一轮”自动视为需要新建一个 commit。
已有草稿 PR 保持原状，本轮未合并、未部署。
