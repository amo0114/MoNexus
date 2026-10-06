# 前端模块边界重构整合记录（2026-10-05）

## 开发入口与范围

- 分支：`integration/frontend-module-boundaries-20261005`
- 工作区：`/root/projects/MoNexus-frontend-integration`
- 基线：最新 `origin/develop`，`a3552d3fa89d56933fefa80773c35a9fe3c58d16`；收尾时重新 fetch 确认未前移。
- 原重构分支：`refactor/frontend-module-boundaries`，`33630c053456b4b029d4bcba545cd1783dcb70b0`。
- 原重构输入快照：`a1c27e03d38ea476b3e459f1c3cd6a3b1f46ba1a`，只作为原始重构的比较起点。

从 develop 建立新分支，依序迁入快照之后的 21 个代码/测试提交，并用 `cherry-pick -x` 保留来源。整合包括分类管理、商品创建/编辑、商家面板、多端商品详情、个人中心、推广管理、商城卡片、样式分层和推广测试拆分。输入快照本身没有迁入；其中既有功能以 develop 当前实现为准。

[原重构审查记录](2026-10-04-frontend-module-split.review.md) 保留历史上下文；其中基线、测试数量、未覆盖项属于原交付。原交付最终审批见机器本地 `../original-agent-review/final-signoff.md`（相对于下文证据目录）。本次整合的验证以本文件为准。

## 与后续修复的适配

| 部位 | 整合后的行为 |
| --- | --- |
| 移动端规格抽屉 | `MobileSkuSheet` 接收 `onCloseAutoFocus`；普通关闭恢复规格按钮焦点，确认购买后保留结算弹窗焦点，沿用 develop 的 `skuConfirmingRef` 防护。 |
| 桌面端详情 | 保留方向键、Home/End 导航及单一 Tab 停靠点。 |
| 邀请卡片 | 剪贴板写入完成后才提示成功，写入失败显示“复制失败，请手动复制”；补充邀请码/邀请链接成功和失败共 4 项回归测试。 |
| 个人订单列表 | 保留真实订单卡片上的 `profile-order-card-${order.id}` 标识。 |
| 购买、签到与退出 | 保留 develop 的认证会话上下文检查和积分更新保护，以及个人中心移动端触控区域修复。 |
| 全局样式 | 保留 80px 底栏预留高度、通知岛胶囊圆角规则、点赞动画选择器修复；拆分后的 CSS 构建产物与 develop 逐字节一致。 |

与原重构源码相比，适配涉及 10 个文件；清单保存在 `preservation-check.json`。后端、API 客户端、认证、stores、realtime、通知桥、订单成功通知、AsyncButton、依赖锁文件、CI 和既有 E2E 文件均与 develop 一致。

## 验证

运行环境为 Node 20.20.2 / npm 10。依赖安装与 Prisma client 生成成功；构建包含 TypeScript 项目检查。

| 检查 | 结果 | 证据文件 |
| --- | --- | --- |
| 全量前端单元/组件测试 | 164 文件、1312 项通过 | `frontend-tests.log` |
| 邀请卡片回归测试 | 4 项通过；测试标题整理后单独复跑 | `invite-card-tests.log` |
| develop 与整合分支生产构建 | 均通过 | `baseline-build.log`、`integrated-build.log` |
| CSS 构建产物 | SHA256 相同，逐字节一致 | `css-comparison.json`、`baseline-css/` |
| 登录会话完成 E2E | 2 项通过 | `auth-session-completion.log` |
| 分类、商品生命周期、Xboard 导入、推广 E2E | 首轮 29 通过、1 失败、1 未运行；Xboard 单独复跑 4/4 通过，31 个场景均取得通过记录 | `catalog-ops-e2e.log`、`catalog-xboard-rerun.log` |
| 购买、交付、库存、个人中心等关键链路 E2E | 37 项通过 | `journeys-e2e.log` |
| 范围检查 | 21 个来源提交逐一对应；无冲突、无空白错误 | `preservation-check.json`、最终工作区检查 |

CSS SHA256：`7471884ce9415659c573dbd0c9cc13a59edc68ceaedab45e7d68bcb89d4b96ac`。

上述浏览器验证覆盖 70 个不同场景。关键链路包括改价/新增必填字段后的重新确认、多规格价格与订单快照、结构化交付与密码脱敏、受控文件下载、商家库存与拒单、评价提交和修改、320px 商品向导、图库键盘/触摸交互、签到、头像持久化和商城分页。

Catalog 首轮失败位于 `catalog-xboard-import.spec.ts` 的移动端布局测量：分别读取的 name/status 边界出现约 0.29px 重叠；不改代码复跑该文件 4 项均通过。该项记录为一次偶发失败，未将首轮整套测试记为全绿。失败截图、trace 和页面上下文已保留在 `catalog-first-results/`。

浏览器测试使用独立 API 3105、前端 5180、fixture 3106，以及由 dbguard 管理的临时数据库 `monexus_test_catalog_merch_integration`；登录会话测试使用前端 5191 和浏览器 mock。原工作区 3000/5173 服务不参与测试。外部测试配置 `playwright.journeys.config.ts` 固定工作区、输出目录及所选 13 个 spec。

证据目录：`/root/projects/monexus-refactor-artifacts/integration-20261005/`。本地日志和 trace 不提交到 Git。

复核主要命令（在整合工作区、Node 20 下执行）：

```bash
npm test -- --maxWorkers=2
npm run build
bash scripts/verify-catalog-ops-e2e.sh
bash scripts/verify-catalog-ops-e2e.sh e2e/catalog-xboard-import.spec.ts
npx playwright test --config playwright.auth-session-completion.config.ts
CATALOG_OPS_PLAYWRIGHT_CONFIG=/root/projects/monexus-refactor-artifacts/integration-20261005/playwright.journeys.config.ts bash scripts/verify-catalog-ops-e2e.sh
git diff a3552d3..HEAD --check
```

## 提交对应

| 原重构提交 | 整合提交 | 内容 |
| --- | --- | --- |
| `0372ea6` | `ce3320b` | refactor(catalog): extract category management dialogs |
| `373b6a6` | `bdb11e2` | refactor(catalog): extract wizard pricing and delivery steps |
| `5832a5b` | `17e835e` | refactor(catalog): extract wizard presentation and draft review |
| `e6c5528` | `adb392d` | refactor(merchant): extract product and order dashboard panels |
| `2d83e72` | `49acadd` | refactor(catalog): extract product editor form sections |
| `c819333` | `f858533` | refactor(catalog): extract detail gallery and review list |
| `4f07df8` | `7632e84` | refactor(catalog): extract tablet product detail view |
| `99d7fbd` | `338fcf8` | refactor(catalog): split desktop detail content and purchase panel |
| `69fdc1c` | `a0de120` | refactor(catalog): extract mobile detail sections |
| `24d2313` | `c06bbd7` | refactor(catalog): extract mobile purchase bar and sku sheet |
| `0dcbfe3` | `fc5d20b` | refactor(profile): extract membership and invite cards |
| `5f628e0` | `8949a14` | refactor(profile): extract profile orders panel |
| `3fc6be7` | `2099bea` | refactor(merchandising): extract campaign dialogs |
| `5d9052a` | `14dbd25` | refactor(merchandising): extract package dialogs |
| `3824a50` | `1caef9a` | refactor(merchandising): extract editorial dialogs |
| `302e718` | `3af5d4d` | refactor(admin): extract product table and capacity dialog |
| `0f14650` | `7a0d4eb` | refactor(store): extract storefront product card |
| `f50099b` | `f534e12` | refactor(styles): organize global styles without cascade changes |
| `e78b22d` | `2b11a36` | refactor(styles): organize product detail styles |
| `02ce14c` | `909324a` | test(merchandising): split campaign tests by behavior |
| `831c663` | `e557bd0` | fix(refactor): drop migrated trailing whitespace and dead panel helpers |

## 工作区保护与交接

- 原工作区 `/root/projects/MoNexus-new` 的分支、HEAD、六个未提交邮件模板相关文件及文件哈希保持不变。
- 原重构工作区与分支保持不变；七份 stash 保持不变。
- 本次验证生成的已跟踪截图已另存到证据目录，提交前恢复，避免将机器截图混入整合内容。
- 新增测试与整合文档在整合分支本地提交。未推送远端、合并 develop 或部署。
- 后续开发直接从整合工作区继续；不在含有邮件模板未提交改动的原工作区切分支。
