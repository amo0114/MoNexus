# 商家工作台 PR2 验证记录

日期：2026-10-07。范围：[实施计划 PR2](./merchant-workbench-v1.plan.md)。状态：前端工作台与精确导航已实现，本地检查通过；仅本地提交，未推送、未创建远端 PR、未部署。PR3（CI、评审、试点）尚未执行，本文不代表 V1 已验收。

## 实现

- `src/api/merchant/workbench.ts`：经 `src/api/client.ts` 调用 PR1 的四个只读 GET，类型对齐服务端 DTO。
- `src/stores/merchantWorkbench.ts`：页面级共享状态。集合 404 → 关闭（隐藏入口、停止本轮与轮询）；403 → 无权限；5xx/网络 → “部分事项暂未检查”+重试，不视为关闭；401 交给既有会话刷新。单事项 404 只移除该卡片。不改 `/me`、不加前端开关；关闭状态不永久缓存，后续进入或超过 30 秒的焦点重新探测。
- 刷新路径：首次进入全量；60 秒定时器（可见且聚焦）只请求 urgent；焦点恢复按组 30 秒门限，草稿回到第一批；手动刷新全部且草稿重置；“继续检查”只取下一批；从编辑器返回只重验目标草稿，从库存返回刷新 urgent + availability。组内请求去重，切换账号/注销清空并丢弃旧响应，失焦/隐藏/卸载停止定时器。
- 合并：失败组保留旧卡片并标记“待刷新”；截断组保留未再次确认的旧卡片并标记；售罄规格进入紧急区且不在普通区重复。
- 页面：`/merchant`、`/merchant/dashboard` 共用 `WorkbenchSummary`（紧急总数、≤3 紧急、≤5 普通、不补位、查看全部）；`/merchant/workbench` 按规则分组，全部/紧急筛选，各组独立更新时间，>200 显示完整数量与原管理页入口；草稿覆盖说明、失败项重试、继续下一批；空状态只在检查范围完整且无失败时出现。
- 导航：订单 `/merchant/orders/:id`；编辑器封闭 focus 枚举（publication/images/purchase-notes/after-sales/attributes/offers/category），offerId 必须属于该商品，未知值或缺失锚点回退到发布检查并提示；CATEGORY_INACTIVE 只提示更换分类或联系平台。库存深链 `/merchant?availabilityProductId=&offerId=` 按 ID 读取规格、复用 `MerchantAvailabilityModal` 的 `initialOfferId`；目标规格不存在时提示不可用，不回退默认规格；关闭只清除这两个参数。OFFER_NOT_SELLABLE 直接使用服务端 action。多缺项草稿主动作进入发布检查，并给出逐项“定位”链接。
- 未触及后端代码、迁移、写接口、通知/SSE、AI 或 MCP。PR1 未发现阻断缺陷。

## 实际执行

运行时 Node 20.20.2，重型命令顺序执行。

| 检查 | 结果 |
| --- | --- |
| 工作台新增测试：`src/stores/merchantWorkbench.test.ts`、`src/components/merchant/workbench/{navigation,WorkbenchCard,WorkbenchSummary}.test.*`、`src/pages/merchant/WorkbenchPage.test.tsx`、`src/pages/merchant/productEditor/editorFocus.test.ts` | 6 个文件 81 个用例通过 |
| 扩展的既有测试：`MerchantAvailabilityModal.test.tsx`（+2）、`MerchantDashboardPage.test.tsx`（+4）、`ProductEditPage.test.tsx`（+11） | 分别 6 / 39 / 30 个用例通过 |
| 前端单测全量 `npx vitest run` | 187 个文件 1571 个用例通过 |
| `npm run build`（tsc + vite build） | 通过；仅既有的 chunk 体积警告 |
| 浏览器冒烟（临时 Playwright 脚本，全部 API 拦截 mock，未提交） | 390px、1280px 各 1 条通过 |
| `git diff --check` | 通过 |

### 测试覆盖的要求

- 集合 404 / 200 / 5xx / 网络失败 / 403 的不同状态；单事项 404 不关闭模块。
- 多次 60 秒 tick（store 与假定时器组件测试）只调用 urgent，availability/drafts 次数不变；失焦、隐藏、卸载后不再轮询；焦点 30 秒门限；继续、手动、编辑器返回、库存返回各自的请求集合。
- 切换账号清空旧事实并丢弃旧账号迟到响应；旧草稿批次响应不覆盖新一轮；注销清空。
- 紧急总数与“至少 N 项”、≤3/≤5、截断提示、失败组待刷新标记、草稿覆盖累计与重试、空状态条件。
- 每个已知 readiness code 的标签；OFFER_NOT_SELLABLE 无启用规格 / 配置无效 / 有效但无可售量三种 action；多缺项逐项链接。
- 编辑器每个 focus 实际移动键盘焦点到对应锚点；外来 offerId、格式错误 offerId、未知 focus 回退发布检查；全程无 PATCH/POST。
- 深链精确规格、无效规格不回退、格式错误 ID 不发请求、404 提示，关闭保留其他参数；卡片点击与深链接均无业务写请求（client 写方法与库存写接口均断言未调用）。

### 浏览器冒烟内容

Vite 开发服务器（独立端口）+ Playwright 拦截 `/api/**`，无后端、无数据库。路径：`/merchant` 摘要 →“查看全部”→ 键盘 Tab 到筛选、Enter 打开低库存卡片 → 深链对话框选中目标规格 → Esc 关闭且 URL 参数清除。两种宽度均无横向滚动、无页面错误、无非 GET 请求；截图人工检查卡片换行与对话框布局正常。

## 未执行 / 已知问题

- 未连接真实后端或数据库做端到端；未新增仓库 E2E 用例（本 PR 不触及结账、鉴权、库存写路径，按 testing-policy 由单测/组件测试覆盖）。CI 未运行。
- 对话框焦点恢复：从商品列表打开“管理可售资源”后按 Esc，焦点落在 `<body>` 而非触发按钮。在 PR1 基线 `f63f096` 上同样复现，属既有行为，本 PR 未修改；深链打开的对话框没有触发元素，关闭后焦点同样回到 `<body>`。
- 后端未改动，未运行后端构建/测试。
- PR3 的试点、真实数据误报观察和 14 项 AC 汇总仍待执行。
