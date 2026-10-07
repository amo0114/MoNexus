# 商家工作台 PR3 本地验证记录

日期：2026-10-07。范围：[实施计划 PR3](./merchant-workbench-v1.plan.md) 第 1、2 项——本地真实前后端联调与 AC01–AC14 证据汇总。被测实现：`f7fcfb0`。第一版记录为 `90029a6`；评审要求补测 AC03、AC10 后，本版在 `server/src/modules/merchant/workbench/workbench.test.ts` 新增两个后端集成用例（只改测试，实现未改）。状态：本地检查通过；**未推送、未开 PR、未跑 CI、未部署、未启用试点**。本文不代表 V1 已验收。

## 证据类型

| 标记 | 含义 |
| --- | --- |
| mock | 前端单元/组件测试（Vitest + jsdom，API 被 mock）或 API 全拦截的浏览器测试 |
| 真实库 | 后端集成测试，连本地 PostgreSQL 14 的可丢弃库 |
| 联调 | 真实浏览器 → Vite → 本分支后端 → 可丢弃库，无 mock |

## 环境

- 数据库：仅 `monexus_workbench_test`（本人建立的可丢弃库）。每轮联调前只对该库执行 `DROP/CREATE`，再 `prisma migrate deploy`、`db:seed`。启动脚本先断言 `DATABASE_URL` 库名为 `monexus_workbench_test`，并用 `pg_stat_activity` 确认后端连接全部落在该库；没有连接开发库、其他 Agent 的测试库或生产库。
- 后端：Node 20.20.2，`npx tsx src/main.ts`，端口 3107；`NODE_ENV=development`、`REDIS_ENABLED=false`、`RECHARGE_MODE=disabled`、`NOTIFICATION_ENABLED=true`。工作区没有 `server/.env`，所有变量由一次性脚本显式传入，JWT 密钥每次随机生成、不落盘到仓库。`MERCHANT_WORKBENCH_ENABLED` 通过重启后端切换。
- 前端：Vite 5199，`VITE_API_PROXY_TARGET=http://127.0.0.1:3107`。
- 联调数据通过真实接口创建：商家建多规格人工服务商品（基础版 10、进阶版 2、尊享版 0），补封面后发布；买家下 2 个人工服务订单；商家建 22 个草稿。唯一直接写库的 fixture：把两单的 `fulfillmentDeadline` 改为“1 小时前”和“2 小时后”（UTC），因为默认履约时限会把截止时间放在 7 天后，不进入工作台窗口。
- 联调用 Playwright 脚本和启动脚本放在会话临时目录，未提交。中途宿主机重启过一次，临时脚本丢失；下文结果均为重启后重建环境的完整重跑。结束后已停止服务，删除仓库内的 `test-results/`。

## 实际执行

以下命令均在 worktree `/root/projects/worktrees/monexus-merchant-workbench` 下顺序执行，Node 20.20.2（`export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH`）。`$WB_DB` 表示可丢弃库连接串：与 CLAUDE.md 中的 `TEST_DATABASE_URL` 相同，只把库名换成 `monexus_workbench_test`。

**B — 后端集成（真实库）**，执行时已停止联调后端：

```bash
cd server && TEST_DATABASE_URL="$WB_DB" REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 npx vitest run \
  src/modules/merchant/workbench/workbench.test.ts \
  src/modules/catalog/publicationReadiness.test.ts \
  src/modules/catalog/publicationReadiness.v2.test.ts \
  src/modules/catalog/publicationRoutes.test.ts \
  src/__tests__/low-stock-notify.test.ts \
  src/__tests__/sla-remind.test.ts \
  src/modules/merchant/capacity-adjust.test.ts \
  src/modules/merchant/inventory.test.ts \
  src/__tests__/merchant.test.ts \
  src/__tests__/order-progress.test.ts
```

结果：10 个文件 106 个用例通过（5 分 33 秒）。这一轮在补测前执行，当时 `workbench.test.ts` 为 8 个用例。

**B2 — AC03/AC10 补测（真实库）**：

```bash
cd server && TEST_DATABASE_URL="$WB_DB" REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 npx vitest run src/modules/merchant/workbench/workbench.test.ts
npm --prefix server run build
```

结果：`workbench.test.ts` 共 10 个用例全部通过（原 8 个 + 新增 2 个）；后端构建通过，包含测试源码的 TypeScript 检查和 postbuild 导入检查。加上 B 中其余 9 个文件的 98 个用例，后端相关用例合计 108 个，均在可丢弃库上通过。

**F — 前端相关（mock）**：

```bash
npx vitest run --maxWorkers=2 \
  src/stores/merchantWorkbench.test.ts \
  src/components/merchant/workbench \
  src/pages/merchant/WorkbenchPage.test.tsx \
  src/pages/merchant/productEditor/editorFocus.test.ts \
  src/components/merchant/MerchantAvailabilityModal.test.tsx \
  src/pages/MerchantDashboardPage.test.tsx \
  src/pages/merchant/ProductEditPage.test.tsx
```

结果：9 个文件 163 个用例通过。

**I1–I3 — 真实前后端联调**：后端用 `npx tsx src/main.ts` 起在 3107，前端用 `VITE_API_PROXY_TARGET=http://127.0.0.1:3107 npx vite --host 127.0.0.1 --port 5199 --strictPort` 起在 5199；Playwright 脚本放在会话临时目录（未提交），用 `npx playwright test -c <临时目录>/playwright.config.ts` 运行，单 worker。结果：3 条全部通过——390px 摘要/完整列表/深链；1280px 计数、分组、续查、精确规格写操作、无效目标、订单、编辑器；开关切换。明细见下节。

**E1 — 相关的现有 E2E（联调）**，开关关、开各一轮，每轮前重建库：

```bash
CI=1 E2E_BASE_URL=http://127.0.0.1:5199 E2E_API_URL=http://127.0.0.1:3107 npx playwright test \
  e2e/merchant-inventory.spec.ts e2e/product-wizard-purchase-form.spec.ts \
  e2e/product-exchange.spec.ts e2e/order-lifecycle.spec.ts --reporter=list
```

结果：两轮均 11/11 通过（每轮约 58 秒）。

**E2 — mock lane**：`npx playwright test -c playwright.mobile-island.config.ts --reporter=list`，15/15 通过（1.8 分钟）。

**C — 真实接口检查（联调）**：用 curl 读取 `urgent`、`availability`、`drafts`、`items/fulfillment_due/1`、`items/draft_incomplete/<id>`，响应字段只有封闭集合，不含 `@`，也没有 `userId`；匿名请求 401；三类跨商家单事项请求均 404。

**R — 代码审查**：`git diff ffc7546..f7fcfb0 -- server/prisma` 为空；工作台路由只有 GET；工作台前后端模块里没有 provider、Notification 或业务写调用。

评审方另在 `f7fcfb0` 上单 worker 复跑了工作台相关 6 个文件 88 个用例，全部通过（见 PR2 验证记录的评审修复一节）。前端全量单测和构建最近一次在 `f7fcfb0` 执行（187 个文件 1578 个用例，`npm run build` 通过）。之后前端代码没有改动，所以没有重复全量执行。

### 联调明细（I2、I3）

- 摘要显示“3 项”紧急（超时单、临期单、尊享版售罄）。售罄规格只出现在紧急区，不在普通区重复；普通区有进阶版与种子商品的低库存卡片和草稿卡片。
- 完整列表 4 组都显示各自的更新时间。草稿首批“本轮已检查 20 个草稿（成功 20 个），发现 20 个有待补充”；“继续检查”只发出 `GET /drafts?beforeProductId=<第 20 个>`，累计 22 个后按钮消失。
- 进阶版卡片 → `/merchant?availabilityProductId=&offerId=`，原对话框选中该规格；打开期间没有写请求。经原对话框补名额 +5 后，只出现一个写请求 `POST …/offers/<id>/capacity/adjust`；随后刷新了 urgent 与 availability，没有请求 drafts，卡片消失，查询参数被清除。
- 售罄卡片同样精确选中规格，补 1 后紧急数变为“2 项”，该规格转入普通区。
- 本商品配外来 offerId：显示“目标规格不可用”，不回退默认规格。其他商家的商品 ID：提示“商品不存在或无权管理”，不打开对话框。
- 订单卡片进入 `/merchant/orders/1`，没有自动操作；原“开始履约”只产生 `POST /merchant/orders/1/fulfillment/start`。
- 真实多缺项草稿（缺封面 + 规格无可售量）：主动作进入 `focus=publication`；逐项“定位”分别进入 `focus=images`（键盘焦点落入封面区域）和该草稿默认规格的精确深链。编辑器原保存只产生 `PATCH /merchant/products/<id>/content`；后退返回工作台时只请求该商品的单事项复查，没有批量 drafts 请求，卡片名称更新。
- 开关（使用 `page.clock`）：在浏览器端挂起一个 urgent 请求，期间以关闭开关重启后端，再放行，页面显示“商家待办暂不可用”。关闭状态下 `/merchant` 概览、商品管理和“管理可售资源”对话框正常；摘要不显示，快进 125 秒没有任何工作台请求。重新开启后快进 31 秒并触发 focus，摘要自动重新出现。再次关闭后快进 61 秒，下一次 tick 只请求 urgent 得到 404，摘要隐藏，没有请求 drafts，概览统计仍在。

## AC01–AC14

| AC | 证据 | 类型 | 结论 / 未覆盖 |
| --- | --- | --- | --- |
| AC01 非 active 不可访问、无跨商家读取 | `workbench.test.ts`“enforces auth, active merchant ownership…”（401、关闭 404、暂停 403、跨商家 404、身份参数 400）；C：匿名 401，三类跨商家单事项均 404；I2：外商品深链提示无权 | 真实库 + 联调 | 覆盖 |
| AC02 库存按 available 条目、限量按 stock，排除无限量/外部 | `workbench.test.ts`“counts available inventory rather than stock…”；I2：种子即时库存规格按 3 个可用条目显示，限量规格按 stock 显示 | 真实库 + 联调 | 覆盖 |
| AC03 状态切换后卡片出现/消失 | `workbench.test.ts`“AC03: cards follow unpublish, archive/restore and offer disable/enable…”：全部通过真实 HTTP 业务接口切换——商家 `PUT …/offers/:id {status}` 停用/启用规格；商家 `POST …/unpublish`、`…/publish` 下架/重新上架；管理员 `POST /api/admin/products/:id/archive`、`…/restore` 归档/恢复在售商品和草稿。每一步之后读取工作台 urgent、availability、drafts 和单事项，卡片按规则消失或出现，单事项返回 `ineligible`。另有 PR1 的静态状态排除用例。I2：补名额后卡片消失，售罄规格转入普通区 | 真实库 + 联调 | 覆盖。实测既有语义：归档会同时停用规格，恢复后商品为 inactive（从未发布的草稿恢复为 draft），商家须重新启用规格并发布，卡片才会回来 |
| AC04 SLA 边界与时区一致 | `workbench.test.ts` SLA 等号/前后 1ms/24h/空值/终态，UTC 与 Asia/Shanghai 会话一致；I2：超时、临期卡片按上海时间显示 | 真实库 + 联调 | 本地覆盖；CI（UTC、PG16）未跑 |
| AC05 总数不截断、>200 提示与原页入口 | `workbench.test.ts` 201+201 → 各 200 项、总数 402；`WorkbenchPage.test.tsx` 截断提示与链接 | 真实库 + mock | 覆盖；联调数据未超过 200 |
| AC06 readiness 默认参数与缺项映射、失败 unknown | `workbench.test.ts` 全部 code 映射、OFFER_NOT_SELLABLE 多来源、unknown；`publicationReadiness*.test.ts`；`WorkbenchCard.test.tsx` 标签与三种 action；I2 真实多缺项草稿 | 真实库 + mock + 联调 | 覆盖 |
| AC07 >20 草稿覆盖与续查不遗漏 | `workbench.test.ts` 25 → 20+5 不重复；store/页面测试累计与重试；I2：22 → 20+2 | 真实库 + mock + 联调 | 覆盖 |
| AC08 定时只请求 urgent；首次/焦点/继续/单项符合 §3.2 | store 与 `WorkbenchSummary.test.tsx` 假定时器：多次 tick 只请求 urgent，焦点 30 秒门限，失焦/卸载停止；`workbench.test.ts` urgent 不调用 readiness；I2/I3：续查只取下一批、写操作后只刷新 urgent+availability、编辑器返回只复查单项、关闭后 tick 只请求 urgent | mock + 真实库 + 联调 | 覆盖；“开启状态下多次 tick 的请求计数”只在组件测试里量化 |
| AC09 深链精确资源与规格、无效不回退、打开不写 | Modal/Dashboard/Editor 测试；I1/I2：三个真实规格精确选中、外来规格不回退、外商品提示、编辑器焦点，请求日志无写入 | mock + 联调 | 覆盖 |
| AC10 DTO 不外泄卡密/购买资料/邮箱/内部备注 | `workbench.test.ts` PR1 哨兵：卡密、固定内容、外部 SKU、购买资料。新增“AC10: buyer email and order internal notes never reach workbench responses”：买家邮箱 `secret-buyer-sentinel@test.local`、昵称 `SECRET_BUYER_NICKNAME`、订单事件 `internalNote=SECRET_INTERNAL_NOTE` 和 `publicNote`、购买资料 `SECRET_ANSWER`、商家邮箱。对 urgent、availability、drafts、单事项四个 HTTP 响应逐一断言不含这些值，且整棵 JSON 中不存在 `email`、`nickname`、`userId`、`internalNote`、`publicNote`、`purchaseFormAnswers`、`content`、`fixedContent` 字段（同时断言该订单确实以卡片形式返回）。C：真实响应字段集合 | 真实库 + 联调 | 覆盖 |
| AC11 旧响应丢弃、注销/切账号清空、局部失败与空状态可区分 | store、`WorkbenchSummary.test.tsx`、`WorkbenchPage.test.tsx`（含评审修复的 7 个回归） | mock | 覆盖（AC 要求组件层）；联调未切账号 |
| AC12 原库存邮件、SLA 邮件、订单操作、编辑保存回归 | B：low-stock-notify、sla-remind、capacity-adjust、inventory、merchant、order-progress、publicationRoutes；E1：merchant-inventory、order-lifecycle、product-wizard-purchase-form（编辑页保存）、product-exchange，开关开/关各一轮；E2；I2：真实补名额、开始履约、编辑保存 | 真实库 + 联调 + mock | 本地覆盖；E2E 主套件全量和 CI 未跑 |
| AC13 集合 404 隐藏、200 展示、5xx/网络显示未检查、单事项 404 不关闭 | `workbench.test.ts` 404/503/200；store/Summary/Page 测试覆盖 404/200/5xx/网络/403/单事项 404；I3：开关切换及请求在途时关闭；C：真实单事项 404 | 真实库 + mock + 联调 | 覆盖；5xx/网络失败只在 mock 中制造 |
| AC14 无 provider、工作台迁移/写接口、Notification 写入或执行工具 | R；`workbench.test.ts` 连续 urgent 不新增订单事件/库存日志/通知；I1/I2 请求日志里只有用户显式操作产生的写入 | 审查 + 真实库 + 联调 | 覆盖 |

## run-e2e 标签结论

按 `docs/testing-policy.md` §5 第 1 条，**PR 应打 `run-e2e`**：

- `MerchantAvailabilityModal` 是商家库存导入、作废和名额调整的入口，支撑即时交付库存（§3“交付：即时交付”，并与“库存导入”同一路径）。本 PR 修改了它的规格选择和关闭行为。
- `ProductAvailabilityStep` 同时被 `ProductCreateWizard` 使用（商家建品 → 交付配置）；`ProductEditPage` 的保存路径参与交付配置编辑。
- 不涉及 §5 第 2、3 条（未改鉴权/会话/中间件/限流，无依赖大版本升级）。

本地已用真实栈跑过直接相关的 4 个 E2E spec 和 mock lane（E1、E2）；E2E 主套件全量依赖 `monexus_test` 与管理员 MFA 种子，按本轮授权没有使用该库，留给打标签后的 CI 执行。

是否新增工作台 E2E：工作台满足 testing-policy §2 第 1 条（新的跨端旅程），最多允许 1 条 happy-path 冒烟。但 CI 的 E2E 后端默认关闭 `MERCHANT_WORKBENCH_ENABLED`，新增 spec 需要同时调整 E2E 环境变量。本轮未改动，留到开 PR 时评审决定；I1–I3 可作为该 spec 的草稿。

## 未执行 / 遗留

- 未推送、未开 PR、未修改 CI 环境、未跑 CI（含 PostgreSQL 16 与 UTC 时钟）、未部署、未启用商家试点；试点商家与周期待本地验证和 CI 通过后再定。
- E2E 主套件全量没有执行：它需要 `monexus_test` 和管理员 MFA 种子，不在本轮授权范围内，留给打 `run-e2e` 标签后的 CI。
- 联调未覆盖：真实 5xx 或网络失败（只在 mock 中制造）、超过 200 条的真实数据（后端集成已覆盖）、切换账号（组件层已覆盖）。
- AC08“开启状态下多次 tick 的请求计数”只在组件测试中量化；联调只验证了关闭状态和再次关闭时的 tick。
- 弹窗焦点问题单独记录，不在本 PR 修复：从商品列表打开“管理可售资源”后按 Esc，焦点回到 `<body>` 而非触发按钮。PR1 基线 `f63f096` 上同样复现。
- 计划 PR3 第 3–5 项（发布说明、试点观察、后续评审）未开始。
