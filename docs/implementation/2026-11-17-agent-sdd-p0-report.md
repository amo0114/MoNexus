# Agent-Agnostic SDD 工程规范化试点 P0 报告

日期：2026-11-17｜分支：`chore/agent-sdd-p0`｜基线：`origin/develop@3b6f1e0`｜状态：R2 复审通过，已提交（未 push）｜任务契约：[`chore-agent-sdd-p0.contract.md`](../handoffs/chore-agent-sdd-p0.contract.md)｜审查：[R1](../reviews/2026-11-17-agent-sdd-p0-review-r1.md)

## 1. 基线调查结论

**Git**
- 主工作区 `/root/projects/MoNexus-new` 位于 `docs/system-review-standard-20261108`（领先 develop 2、落后 158），有未提交修改（`server/src/__tests__/metrics.test.ts`）与多份未跟踪文档，属其他任务，**未触碰**。
- 本轮在新 worktree `/root/projects/worktrees/monexus-agent-sdd-p0` 从 `origin/develop` 以 `--no-track` 切出 `chore/agent-sdd-p0`。其他 worktree（`feat/admin-runtime-settings`、两个 detached 审查目录）未改动。

**指令体系**
- 仓库内仅有根目录 `CLAUDE.md`（已跟踪）。`AGENTS.md` 从未进入 git 历史，但 `product-commerce-v2/plan.md`、`m3-identity-security-hardening/implement.md` 等存量文档引用过"仓库 AGENTS.md"，此前只存在于个别本地环境；本轮使其成为受版本控制的权威入口。
- 主工作区的 `.claude/`、`.cursor/`、`.gemini/`、`.geminiignore` 均**未被跟踪**，属个人本地配置，不纳入规范。无目录级指令文件。

**代码核对（与 CLAUDE.md 旧规则对照）**

| 规则 | 核对结果 |
|---|---|
| 挂载顺序 | `app.ts`：webhook 在 `express.json()` 前；merchandising 公共路由在 `productRoutes` 前；`deliveryFileRoutes` 在 `uploadsRoutes` 前 ✔ |
| businessTime / cronLease / httpError / validate / config / client.ts | 文件与 `calendarDayToUtc`、`businessDayRange`、`businessMonthRange`、`PRICE_CHANGED`、`CHECKOUT_CHANGED`、`skipAuthRefresh` 均存在 ✔ |
| "Cron 必须经 cronLease" | **不完全准确**：周期批处理（16 个中 12 个）使用 cronLease；`fulfillment/jobProvider`、`orders/provisionCron`、`payment/workers`、`adminExports` 采用行级认领 + `leaseToken` 校验（三种形态：SKIP LOCKED、带租约条件的 UPDATE…RETURNING、先锁 Order 行再检查租约），代码注释明确"不接 CronLease"。已在 AGENTS.md 按现有形态描述，不要求改造 |
| 锁顺序 | 先 Order 后 Offer；`jobProvider.ts` 另有 Order → FulfillmentJob ✔（补入） |
| wallet 唯一写入者 | `scripts/architecture-rules.mjs` 对 `server/src/` 非测试文件强制（seed 例外，测试文件不扫描），旧 CLAUDE.md 未记录（补入） |
| `run-e2e` 标签 | `ci.yml` 的 `pull_request` 未声明 `types`，不触发 `labeled` 事件（补入说明） |
| CI backend | 6 shard（`ci.yml`、`testing-policy.md` 一致） |

**验证体系**：仓库没有 lint 入口；真实入口为 `npm test`、`npm run build`、`npm --prefix server run build`、`npm --prefix server test`、`verify:quick`、`verify:local(:no-e2e)`、`test:architecture`、`check:architecture`、`check:migrations`、`e2e*`。CI 路径过滤不包含 `*.md`、`docs/**`、`openspec/**`、`.agents/**`，本轮改动只会触发恒定运行的 `deployment-contract`、`architecture` 与 `CI OK`，二者不读取本轮文件。

**OpenSpec**：npm 上 `@fission-ai/openspec` 最新为 `2.1.0`（2026-11-17T01:15Z 发布，当天新版，无观察期），`engines.node >=22.20.0`，无 install 生命周期脚本，内含匿名统计（`OPENSPEC_TELEMETRY=0` 可关）。本机默认 Node 为 24.22.1（不符合项目要求），使用已安装的 nvm Node 22.23.1 运行，未改项目 Node/npm/依赖。CLI 安装在会话临时目录，未写入 `package.json`。

## 2. 新增与修改文件

| 文件 | 说明 |
|---|---|
| `AGENTS.md`（新增） | 跨 Agent 权威规则：权威顺序、命令、硬约束、生产/凭据、分支/CI、Agent 行为 |
| `CLAUDE.md`（修改） | 收敛为 `@AGENTS.md` |
| `docs/agent-workflow.md`（新增） | 生命周期、OpenSpec 用法、Worktree/环境隔离、Handoff、独立审查、验证、成本与人工控制 |
| `docs/specs/INDEX.md`（新增） | 存量规格分类索引 |
| `openspec/config.yaml`、`openspec/specs/.gitkeep`、`openspec/changes/archive/.gitkeep`（新增） | `openspec init` 生成；config 补充项目上下文与产物规则 |
| `.agents/skills/openspec-*/SKILL.md`（6 个）、`.agents/skills/.openspec-target`（新增） | `openspec init --tools agents` 生成的通用 Skills，未手改 |
| `docs/handoffs/chore-agent-sdd-p0.md`、`.contract.md`（新增） | 本任务交接文件与任务契约（按新协议） |
| `docs/reviews/2026-11-17-agent-sdd-p0-review-r1.md`（新增） | R1 审查结论与处置 |
| 本报告（新增） | — |

未修改：`src/**`、`server/**`、`e2e/**`、存量规格正文、迁移、CI/CD、Docker/部署配置、`package.json`/lockfile。

## 3. CLAUDE.md → AGENTS.md 规则迁移对照

| # | 原 CLAUDE.md 规则 | AGENTS.md 位置 | 处理 |
|---|---|---|---|
| 1 | 项目定位、两个 npm 包与技术栈 | §2 | 原样迁移 |
| 2 | Node `>=22 <23`、npm `>=10 <11`，check-runtime 强制 | §2 | 迁移；补 `.nvmrc`、禁止擅自升级 |
| 3 | 规格在 `docs/specs/`，模块契约在 `modules/*/README.md` | §1 权威表 | 扩展为权威顺序 + 规格索引 |
| 4 | dev-up / build / db:generate / npm test / 后端测试 / verify:quick / e2e 命令块 | §2 | 原样迁移；补架构/迁移检查命令 |
| 5 | 后端测试 TRUNCATE，测试库可丢弃，一库一进程 | §2；workflow §3 | 迁移；补 `verify:quick` 库名检查 |
| 6 | 迁移命令从根目录执行；verify:quick 仅 schema 变化时自动迁移 | §2 命令块 | 迁移（命令块保留根目录形式；自动迁移细节见 testing-policy） |
| 7 | verify:local / no-e2e 范围，最终以 GitHub Actions 为准 | §2 | 迁移 |
| 8 | 模块结构 routes→controller→services，schema.ts，HttpError | §3 模块边界 | 原样迁移 |
| 9 | `app.ts` 挂载顺序承重 | §3 | 迁移，按代码改写 "merch routes" 为 merchandising 公共路由 |
| 10 | env 经 Zod 解析，写入 `.env.example` | §3 | 原样迁移 |
| 11 | 前端只经 `client.ts`，业务 401 设 `skipAuthRefresh` | §3 | 原样迁移 |
| 12 | 积分/佣金/金额整数；兑换一事务 | §3 资金与交易 | 原样迁移 |
| 13 | 非本人资源 404 | §3 授权 | 原样迁移 |
| 14 | Idempotency-Key、expectedPrice、PRICE_CHANGED/CHECKOUT_CHANGED | §3 | 原样迁移 |
| 15 | 先 Order 后 Offer | §3 并发 | 迁移；补 Order → FulfillmentJob |
| 16 | businessTime / calendarDayToUtc / businessDayRange，CI UTC | §3 时间 | 原样迁移 |
| 17 | Cron 必须经 cronLease | §3 并发与后台任务 | **按代码修订**：区分周期 cron 与行认领 worker |
| 18 | 生产禁止模拟器充值，`RECHARGE_MODE=disabled` | §4 | 原样迁移 |
| 19 | Tailwind `var()` 透明度失效及守卫测试 | §3 前端 | 原样迁移 |
| 20 | 测试分层与 E2E 准入 | §5 | 原样迁移 |
| 21 | 分支模型 develop/master | §5 | 原样迁移；补 Conventional Commits |
| 22 | `run-e2e` 标签条件；禁止 `[skip ci]` | §5 | 迁移；补"创建 PR 时带标签"及 CI 依据 |
| — | 首行 "guidance to Claude Code" | — | 删除（Harness 专属） |
| 新增 | wallet 唯一写入者、迁移规则（PR 模板）、高风险改动测试要求、凭据与人工授权、权威与冲突、Agent 行为 | §1、§3、§4、§6 | 来源：`architecture-rules.mjs`、`.github/pull_request_template.md`、Owner 指令 |

无规则被删除。Claude Code 加载验证见第 7 节。

## 4. OpenSpec 安装与初始化

```bash
export PATH=/root/.nvm/versions/node/v22.23.1/bin:$PATH OPENSPEC_TELEMETRY=0
npm install --prefix <scratch>/openspec-cli --ignore-scripts @fission-ai/openspec@2.1.0   # exit 0
openspec --version                                                                       # 2.1.0
openspec init --tools agents --scope project --language zh-CN --no-animation --no-copilot-cloud .  # exit 0
```

- 先在临时目录试运行 `--tools none` 与 `--tools agents`：两者都只生成 `openspec/`（`agents` 另生成 `.agents/skills/`），不改动已有 `AGENTS.md`/`CLAUDE.md`。
- 选择 `agents`（通用 `.agents/skills`，非任何单一 Harness），未安装 claude/codex/cursor 等专属适配；默认 core profile 6 个 workflow，未启用扩展 workflow。
- 初始化在 `~/.local/share/openspec/projects.json` 登记本地项目路径（仅本机，不入库）。
- 试验确认：change 目录中额外放置 `handoff.md` 不影响 `openspec validate --strict`；`config.yaml` 的 `rules` 已出现在 `openspec instructions proposal` 输出中。
- 存量能力首次接入（R1 #4）：在临时项目中，主规格不存在时用 `MODIFIED`，`validate --strict` 仍退出 0（只打印 INFO），但 `archive` 退出 1。改为先用 ADDED 建立基线并归档，再用 `MODIFIED` 提交功能 change，两步都能成功归档。规则见 workflow §2。
- 启动方式：`npx -y @fission-ai/openspec@2.1.0 --version` 与前缀安装后在 `PATH` 上执行 `openspec --version` 均输出 2.1.0。

## 5. 存量规格策略

见 [`docs/specs/INDEX.md`](../specs/INDEX.md)：仅凭代码/CI 引用判定 `CURRENT`（4 组），归档目录判定 `HISTORICAL`，其余全部 `NEEDS_REVIEW` 并摘录自述状态与合并佐证；不迁移、不改写、不废弃。已标出自述状态与合并记录冲突的文档（后端治理 v1、商务闭环、runtime-settings phase2、PR130 计划/报告），并声明不改变后端治理任务的范围与责任。

## 6. 跨 Agent 流程

见 [`docs/agent-workflow.md`](../agent-workflow.md)：§3 Worktree 与环境隔离（同库测试串行、Worktree 非沙箱）、§4 Handoff 协议与模板、§5 独立审查（固定 SHA、只读、Finding 五要素、P0–P3 与关闭条件、APPROVE/REQUEST_CHANGES/INCONCLUSIVE）、§6 本地与 CI 分工及证据格式、§7 成本与人工授权（Review-Fix 默认最多 3 轮）。

## 7. 验证记录

均在 worktree，revision = `3b6f1e0` + 本轮未提交修改。

| 命令 | 结果 |
|---|---|
| `openspec doctor` | exit 0，`OpenSpec root: ok` |
| `openspec validate --all --strict --no-interactive` | exit 0，"No items found to validate."（**没有任何规格被校验**，不代表存量规格有效） |
| 临时 change（`openspec new change zz-probe` + `instructions proposal`） | rules/context 注入成功；探针目录已删除 |
| `claude -p`（Claude Code 2.1.302，禁用文件工具，worktree 内新会话） | 逐字复述 `# AGENTS.md` 与 "同时加锁时**先 Order 后 Offer**…" 一行，证明 `@AGENTS.md` 导入生效；R1 修复后用 `--tools ""` 重跑，逐字复述新增的 `NEEDS_REVIEW` 行，exit 0 |
| `git diff --check` 及对新增文件的 `git diff --no-index --check` | 见交接文件验证记录 |

未执行：前后端构建与测试、`test:architecture`/`check:architecture`（无代码改动，且新 worktree 未安装 `node_modules`）；GitHub CI（未 push）；其他 Harness（Codex、Gemini CLI 等）对 `AGENTS.md` 的实际加载未测试。

## 8. 已知限制

- OpenSpec 2.1.0 为当天发布版本，未经观察期；若出现问题可回退到 `2.0.0`，需同步修改 workflow §2 与 config 注释。
- OpenSpec 不在项目依赖中，接手 Agent 须按 workflow §2 方式 A 把固定版本放上 `PATH`（Skills 调用裸 `openspec`），或只用 CLI 时用方式 B（`npx`）。
- Claude Code 默认不读取 `.agents/skills`（其 Skills 目录为 `.claude/skills`），Claude Code 使用 CLI + 本文档即可；未为其单独安装适配文件。
- `NEEDS_REVIEW` 项需要 Owner 逐步确认，本轮不做判断。

## 9. P1 建议（未实施，超出本轮范围）

1. 将 `@fission-ai/openspec` 以精确版本加入根 `devDependencies`，提供 `npm run spec:validate`（会改 `package.json`/lockfile 并触发 frontend job）。
2. CI 增加 `openspec validate --all --strict` 步骤，仅在 `openspec/**` 变化时运行（需改 `ci.yml`）。
3. PR 模板增加"交接文件 / 审查报告 / 验证 revision"三项（需改 `.github/pull_request_template.md`）。
4. 由 Owner 确认 `INDEX.md` 中冲突项的状态，并更新后端治理 v1 等文档的自述状态（需改存量规格正文）。
5. 测试库按 worktree 自动分配（如由分支名派生库名），替代人工约定（需改测试基础设施）。
6. 评估是否需要 `GEMINI.md` 等其他 Harness 的单行导入文件（以各工具实际支持 `AGENTS.md` 的情况为准，先实测）。
