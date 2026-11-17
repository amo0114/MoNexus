# AGENTS.md

本文件是 MoNexus 仓库内**所有 AI 编码 Agent 与人工协作者共享的工程规则入口**，不绑定任何模型或 Agent Harness。
任务流程（接手、规格、交接、审查、隔离、验证、人工控制）详见 [`docs/agent-workflow.md`](docs/agent-workflow.md)。

## 1. 权威与冲突处理

| 优先级 | 来源 | 作用 |
|---|---|---|
| 1 | 仓库 Owner 当次的明确指令 | 决定做什么；不能放宽第 4 节的安全与生产限制 |
| 2 | 本文件 | 不可违反的工程约束与 Agent 行为规则 |
| 3 | 已批准的任务规格：`openspec/changes/<id>/`，或仓库内的任务契约文件 | 本任务的需求、范围与验收 |
| 4 | 流程与契约文档：[`docs/testing-policy.md`](docs/testing-policy.md)、[`docs/branching-and-ci.md`](docs/branching-and-ci.md)、`server/src/modules/*/README.md`、`openspec/specs/`、[规格索引](docs/specs/INDEX.md) 中的 `CURRENT` 项 | 测试分层、CI、模块契约 |
| — | [规格索引](docs/specs/INDEX.md) 中的 `NEEDS_REVIEW` 存量规格 | **待核实，不是历史文档**：改动涉及该能力时必须阅读并对照代码核实；其中的要求不得忽略，与代码、新需求或其他文档冲突时报告 Owner 决定 |
| 5 | 历史材料：`docs/reviews/`、`docs/refactoring/`、`docs/archive/`、`docs/superpowers/archive/` | 仅作背景，不作实施依据 |

- 代码、测试与 CI 结果是"系统现在是什么"的事实来源；文档描述"应当是什么"。两者冲突时**停止相关修改并报告**，不得自行选择一方或顺手"修正"。
- Agent 专属文件（`CLAUDE.md`、`GEMINI.md`、`.cursor/`、个人或全局配置等）只能补充本 Harness 的操作细节，不得覆盖或放宽本文件。
- 同级文档互相矛盾时，以较新且经 Owner 批准的规格为准；无法判断时标记 `NEEDS_REVIEW` 并询问 Owner。

## 2. 项目与命令

MoNexus：内部积分制数字商品交易平台（用户 / 商家 / 管理员）。两个独立 npm 包：

- 仓库根目录 — 前端：React 18、Vite 6、Zustand、Tailwind、Axios（`src/`）；Playwright E2E（`e2e/`）
- `server/` — 后端：Express 4、Prisma 6 + PostgreSQL 16、Zod、可选 Redis、S3 兼容存储

Node `>=22 <23`、npm `>=10 <11`（`.nvmrc` = 22，`scripts/check-runtime.mjs` 强制）。不得为工具链需要擅自升级 Node、npm 或项目依赖。

```bash
bash scripts/dev-up.sh                 # Postgres+Redis、迁移、后端 :3000、前端 :5173
npm run build                          # 前端类型检查 + 构建
npm --prefix server run build          # 后端类型检查
npm --prefix server run db:generate    # schema 变更或 rebase 后
npm test                               # 前端单元/组件测试（vitest, jsdom）
npm run test:architecture && npm run check:architecture && npm run check:migrations  # 架构/契约/迁移检查

# 后端集成测试：TEST_DATABASE_URL 必须指向可丢弃测试库（见 README「测试」）
: "${TEST_DATABASE_URL:?Set a disposable test database URL first}"
DATABASE_URL="$TEST_DATABASE_URL" npm --prefix server run db:migrate:deploy
REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 \
  npm --prefix server test -- src/__tests__/business-time-boundaries.test.ts

npm run verify:quick                   # 仅受变更影响的测试；`-- e2e/x.spec.ts` 追加 E2E
DATABASE_URL="$TEST_DATABASE_URL" npm run e2e   # 主套件；需已迁移 + seed 的测试库
```

- 后端测试在每个用例前 `TRUNCATE` 共享业务表：**同一测试库同一时刻只允许一个后端测试进程**；`verify:quick` 要求库名包含 `monexus_test`。
- `verify:local:no-e2e` = 两端构建 + 后端测试；`verify:local` 再加 reset/seed 与移动端/主套件/法律页面浏览器测试。两者均不含前端单测、架构检查及通知/catalog-ops E2E。最终门禁是 GitHub Actions 的 `CI OK`，本地局部通过不能替代。

## 3. 架构边界与业务硬约束

以下约束已与 `origin/develop` 代码核对（2026-11-17）。违反任一条视为 P0/P1 缺陷（分级见 workflow 文档）。

**模块边界**
- 后端模块 `server/src/modules/<name>/`：`routes.ts` → `controller.ts` → 具体用例服务；`service.ts` 可保留兼容导出，实现文件不得 import 自己模块的 service 门面。Zod DTO 在 `schema.ts`，经 `middlewares/validate.ts` 校验。错误抛 `HttpError` + `lib/httpError.ts` 的 `ErrorCode`。
- `server/src/app.ts` 路由**挂载顺序承重**：merchandising 公共路由在 `products/:id` 前；交付文件路由在贪婪的 `uploads/:key` 前；支付 webhook 在 `express.json()` 前（需原始 body）。
- 所有环境变量由 `server/src/config/index.ts` 的 Zod 解析；新增变量同时写入 `.env.example`。
- 前端只能通过 `src/api/client.ts` 调用 API（token 注入 + 刷新）；业务性 401（如二次密码校验）必须设 `skipAuthRefresh`。
- 在 `server/src/` 的非测试代码中，`server/src/modules/wallet/` 是积分余额、积分批次、分配与 `PointLog` 的**唯一写入者**；唯一例外是开发 seed `server/src/prisma/seed.ts`（`npm run check:architecture` 经 `scripts/architecture-rules.mjs` 强制）。测试文件不在扫描范围内，现有测试可直接构造余额夹具（如 `point-account-hard-cap.test.ts`），不要求整改。

**资金与交易**
- 积分、佣金、金额**只用整数**。
- 兑换/结账 = 扣款 + 库存锁定 + 订单 + 交付 + 积分流水 + 结算，**在同一事务内完成**。
- 订单/结账写操作遵守 `Idempotency-Key`，并校验 `expectedPrice` / 购买表单版本（`PRICE_CHANGED` / `CHECKOUT_CHANGED`）；条款变化时绝不静默扣款。
- 涉及订单、充值、退款、钱包、库存、结算的改动，必须覆盖拒绝 / 未知 / 重放分支（见 `.github/pull_request_template.md`）。

**授权**
- 调用者不拥有的资源返回 **404 而非 403**（防枚举）。

**并发与后台任务**
- 同时加锁时**先 Order 后 Offer**；履约任务同样先 Order 后 FulfillmentJob。
- 周期性批处理 cron 必须经 `server/src/lib/cronLease.ts`（多实例安全）。按行认领工作的 worker（履约任务、商家开通、支付事件入账、后台导出）不走 CronLease，而是在行锁或原子条件更新内检查租约并写入 `leaseToken`/`leaseUntil`，结果写回时以 `leaseToken` 校验。现有实现形态包括：`FOR UPDATE SKIP LOCKED`（`orders/provisionCron.ts`、`adminExports`）、带租约条件的 `UPDATE … RETURNING`（`payment/workers/lease.ts`）、先锁 Order 行再检查租约并更新 Job（`fulfillment/jobProvider.ts`）。本条描述现有模式，不要求改造现有 worker。新增后台任务必须采用 CronLease 或行级认领之一，不得只用裸 `setInterval`，并按 PR 模板提供指标、告警与人工处理出口。

**时间**
- 日历日使用 `server/src/lib/businessTime.ts`（Asia/Shanghai），禁止宿主机本地日期计算。仅日期值用 `calendarDayToUtc` 存为 UTC 零点；时间戳过滤用 `businessDayRange` / `businessMonthRange` 取真实上海边界，二者不可互换。CI 运行在 UTC。

**数据库迁移**
- 不修改已应用的迁移文件；生产使用 `npm run db:migrate:deploy` 的锁超时入口；大表索引用独立的单语句 `CREATE INDEX CONCURRENTLY` 迁移。

**前端**
- Tailwind 透明度后缀作用于 `var()` 颜色（`bg-[var(--x)]/8`）不生成任何样式；改用 `--color-primary-tint(-strong)` 或 `bg-[color-mix(in_srgb,var(--x)_8%,transparent)]`（`src/styles/tailwindVarOpacity.test.ts` 守卫）。

## 4. 生产、凭据与人工授权

- 生产绝不使用模拟器/沙箱充值；默认 `RECHARGE_MODE=disabled`。
- 不读取、输出、提交 `.env*`（`.env.example` 除外）、API Key、Token、密码、私钥、Cookie、凭据或原始敏感日志；不把 secret 写进代码、测试、文档、交接或提交。
- 以下操作**必须获得 Owner 针对本次的明确授权**，授权不跨任务延续：push、创建/合并 PR、操作 `master`、修改受保护分支、改写历史、部署、修改生产环境或生产数据、破坏性迁移、删除云资源、修改权限、发布包。
- 禁止 `git reset --hard`、`git clean -fd`、`git push --force` 等可能覆盖他人工作的操作；不得覆盖、撤销或清理不属于本任务的未提交修改。

## 5. 分支、测试与 CI 纪律

- 从 `develop` 切出并 PR 回 `develop`（`feat/` `fix/` `chore/`）；`master` 为生产分支，仅接受 release PR 与 `hotfix/*`。提交使用 Conventional Commits。
- 在最便宜的层测试：后端行为 → `server` 集成测试；前端 → 根目录单元测试。新增 E2E 仅限新的跨端旅程、关键旅程（认证/MFA、下单与结算、交付、高危管理操作、法务页、SSE）或只能在浏览器复现的行为（[`docs/testing-policy.md`](docs/testing-policy.md)）。
- 触及关键旅程、认证/会话/中间件/限流或运行时依赖大版本升级的 PR，在创建 PR 时即带 `run-e2e` 标签（`ci.yml` 的 `pull_request` 不监听 `labeled`，事后加标签要等下一次 push 或 close/reopen 才生效）。禁止 `[skip ci]`（required 的 `CI OK` 会永远挂起）。
- 不得为规范化自行修改 CI 工作流、Docker 或部署配置；此类需求作为建议提交 Owner。

## 6. Agent 工作规则

- **接手**：先读本文件、任务规格与交接文件；独立核对 Git 状态、实际代码和测试结果。上一位 Agent 的完成声明不是已验证事实。
- **范围**：只做规格内的事；修根因、最小 diff，不顺手重构、格式化或修无关问题。超出范围的发现记录为建议。
- **单写者**：一个任务同一时刻只有一个写入负责人；只读调研与审查可并行。并行写入使用独立 worktree，测试库、端口等共享资源另行隔离（见 workflow 第 3 节）。
- **验证**：报告实际执行的命令、退出码、对应提交 SHA，以及未执行的检查和原因。没有运行过的检查不得声称通过。
- **交接**：在有意义的检查点、设计变更、切换 Agent/会话、出现阻断、进入审查前更新交接文件（模板见 workflow 第 4 节）。
- **审查**：实现者不能自我批准合并；合并前需要独立审查（规程见 workflow 第 5 节）。
- **停止**：遇到无法从代码、规格、测试判断的重大产品/架构决策，或文档与代码冲突时，停止相关修改并询问 Owner。
