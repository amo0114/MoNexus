# 商家工作台 PR3 本地验证记录

日期：2026-10-07。范围：[实施计划 PR3](./merchant-workbench-v1.plan.md) 第 1、2 项——本地真实前后端联调与 AC01–AC14 证据汇总。被测代码：`f7fcfb0`（本记录只新增文档，未改实现）。状态：本地检查通过；**未推送、未开 PR、未跑 CI、未部署、未启用试点**。本文不代表 V1 已验收。

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

| # | 命令 / 内容 | 类型 | 结果 |
| --- | --- | --- | --- |
| B | `cd server && TEST_DATABASE_URL=…/monexus_workbench_test REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 npx vitest run` 以下 10 个文件：`modules/merchant/workbench/workbench.test.ts`、`modules/catalog/publicationReadiness.test.ts`、`publicationReadiness.v2.test.ts`、`publicationRoutes.test.ts`、`__tests__/low-stock-notify.test.ts`、`sla-remind.test.ts`、`modules/merchant/capacity-adjust.test.ts`、`inventory.test.ts`、`__tests__/merchant.test.ts`、`order-progress.test.ts` | 真实库 | 10 个文件 106 个用例通过（5 分 33 秒，顺序执行，执行时已停止联调后端） |
| F | `npx vitest run --maxWorkers=2` 以下 7 个目标：`src/stores/merchantWorkbench.test.ts`、`src/components/merchant/workbench`、`src/pages/merchant/WorkbenchPage.test.tsx`、`src/pages/merchant/productEditor/editorFocus.test.ts`、`src/components/merchant/MerchantAvailabilityModal.test.tsx`、`src/pages/MerchantDashboardPage.test.tsx`、`src/pages/merchant/ProductEditPage.test.tsx` | mock | 9 个文件 163 个用例通过 |
| I1 | 联调 390px：首页摘要 → 查看全部 → 低库存卡片深链 | 联调 | 通过；无横向滚动；全程无非 GET 业务请求 |
| I2 | 联调 1280px：摘要计数、分组、草稿续查、精确规格写操作、无效目标、订单、编辑器 | 联调 | 通过（明细见下节） |
| I3 | 联调开关：开 → 页面打开且请求在途时关 → 关闭状态原页面 → 开 → 再关 | 联调 | 通过 |
| E1 | `CI=1 E2E_BASE_URL=http://127.0.0.1:5199 E2E_API_URL=http://127.0.0.1:3107 npx playwright test e2e/merchant-inventory.spec.ts e2e/product-wizard-purchase-form.spec.ts e2e/product-exchange.spec.ts e2e/order-lifecycle.spec.ts --reporter=list`，开关关、开各一轮，每轮前重建库 | 联调 | 两轮均 11/11 通过 |
| E2 | `npx playwright test -c playwright.mobile-island.config.ts`（含商家下架、编辑页、移动端） | mock | 15/15 通过 |
| C | curl 真实接口：各集合与单事项响应的字段集合；匿名、跨商家目标状态码 | 联调 | 见 AC01、AC10、AC13 |
| R | 代码审查：`git diff ffc7546..f7fcfb0 -- server/prisma` 为空；工作台路由只有 GET；工作台前后端模块没有 provider、Notification 或业务写调用 | 审查 | 符合 |

另外，评审方已在 `f7fcfb0` 上单 worker 复跑工作台相关 6 个文件 88 个用例，全部通过（见 PR2 验证记录的评审修复一节）。前端全量单测和构建最近一次在 `f7fcfb0` 执行（187 个文件 1578 个用例，`npm run build` 通过），本轮没有改代码，未重复全量执行。

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
| AC03 状态切换后卡片出现/消失 | `workbench.test.ts` 停用/归档/无限量/外部排除，草稿转 active 后变 ineligible；I2：补名额后卡片消失，售罄转普通 | 真实库 + 联调 | **部分**：商品下架/归档、规格停用这类“切换序列”只有静态状态断言，联调未操作 |
| AC04 SLA 边界与时区一致 | `workbench.test.ts` SLA 等号/前后 1ms/24h/空值/终态，UTC 与 Asia/Shanghai 会话一致；I2：超时、临期卡片按上海时间显示 | 真实库 + 联调 | 本地覆盖；CI（UTC、PG16）未跑 |
| AC05 总数不截断、>200 提示与原页入口 | `workbench.test.ts` 201+201 → 各 200 项、总数 402；`WorkbenchPage.test.tsx` 截断提示与链接 | 真实库 + mock | 覆盖；联调数据未超过 200 |
| AC06 readiness 默认参数与缺项映射、失败 unknown | `workbench.test.ts` 全部 code 映射、OFFER_NOT_SELLABLE 多来源、unknown；`publicationReadiness*.test.ts`；`WorkbenchCard.test.tsx` 标签与三种 action；I2 真实多缺项草稿 | 真实库 + mock + 联调 | 覆盖 |
| AC07 >20 草稿覆盖与续查不遗漏 | `workbench.test.ts` 25 → 20+5 不重复；store/页面测试累计与重试；I2：22 → 20+2 | 真实库 + mock + 联调 | 覆盖 |
| AC08 定时只请求 urgent；首次/焦点/继续/单项符合 §3.2 | store 与 `WorkbenchSummary.test.tsx` 假定时器：多次 tick 只请求 urgent，焦点 30 秒门限，失焦/卸载停止；`workbench.test.ts` urgent 不调用 readiness；I2/I3：续查只取下一批、写操作后只刷新 urgent+availability、编辑器返回只复查单项、关闭后 tick 只请求 urgent | mock + 真实库 + 联调 | 覆盖；“开启状态下多次 tick 的请求计数”只在组件测试里量化 |
| AC09 深链精确资源与规格、无效不回退、打开不写 | Modal/Dashboard/Editor 测试；I1/I2：三个真实规格精确选中、外来规格不回退、外商品提示、编辑器焦点，请求日志无写入 | mock + 联调 | 覆盖 |
| AC10 DTO 不外泄卡密/购买资料/邮箱/内部备注 | `workbench.test.ts` 哨兵：卡密、固定内容、外部 SKU、购买资料；C：5 类真实响应字段集合封闭，无 `@`、无 `userId`、无内容/备注字段 | 真实库 + 联调 | **部分**：买家邮箱、订单内部备注没有专门的哨兵断言（白名单 select 在结构上排除，联调只检查了字段集合） |
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

- 未推送、未开 PR、未跑 CI（含 PostgreSQL 16 与 UTC 时钟）、未部署、未启用商家试点；试点商家与周期待本地验证和 CI 通过后再定。
- AC03、AC10 为部分覆盖，原因见上表；如评审要求补齐，最小做法是在 `workbench.test.ts` 增加商品下架/规格停用的状态切换断言，以及买家邮箱、订单内部备注的哨兵断言。
- 联调未覆盖：真实 5xx/网络失败、超过 200 条的真实数据、切换账号。
- 既有问题（PR1 基线即存在，未修改）：从商品列表打开“管理可售资源”后按 Esc，焦点回到 `<body>` 而非触发按钮。
- 计划 PR3 第 3–5 项（发布说明、试点观察、后续评审）未开始。
