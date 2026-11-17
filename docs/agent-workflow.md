# Agent 工作流与交接规程

> 适用于任何 Agent（Claude Code、Codex、OpenCode、Gemini CLI、Cursor 等）及人工协作者。自 2026-11-17 起试行（P0）。
> 工程约束以根目录 [`AGENTS.md`](../AGENTS.md) 为准；本文只规定**流程**，不重复业务规则。本文不依赖任何 Harness 的私有能力、会话历史或配置：所有需要延续的状态都写进仓库文件或 PR。

## 1. 任务生命周期

```
接手/立项 → 规格（OpenSpec change 或已批准的存量规格）→ 实施（单写者 worktree）
        → 本地验证 → 交接文件更新 → 独立审查（固定 SHA）→ 修复/复审 → PR + CI OK → Owner 合并
```

| 阶段 | 产出 | 谁可以做 |
|---|---|---|
| 规格 | `openspec/changes/<id>/` 的 proposal/specs/design/tasks，Owner 批准 | 任意 Agent 起草，Owner 批准 |
| 实施 | 分支提交 | 唯一写入负责人 |
| 验证 | 命令 + 退出码 + SHA（第 6 节） | 实施者；CI |
| 审查 | 审查报告（第 5 节） | 非实施者的独立会话 |
| 合并 / 部署 | — | 仅 Owner 或其明确授权 |

**Task ID**：有 OpenSpec change 时用 change id（kebab-case）；否则用分支名去掉前缀斜杠（如 `chore-agent-sdd-p0`）。

## 2. 规格管理（OpenSpec）

- 工具：OpenSpec CLI **固定版本 `@fission-ai/openspec@2.1.0`**，需 Node `>=22.20`（与项目 `.nvmrc` 22 兼容）。未加入项目依赖。`.agents/skills` 里的命令调用裸 `openspec`，因此需要让它出现在 `PATH` 上：

  ```bash
  export OPENSPEC_TELEMETRY=0                     # 关闭匿名统计
  # 方式 A：安装到用户目录（不改项目依赖），Skills 可直接使用
  npm install --prefix "$HOME/.local/openspec-2.1.0" --ignore-scripts @fission-ai/openspec@2.1.0
  export PATH="$HOME/.local/openspec-2.1.0/node_modules/.bin:$PATH"
  openspec --version                              # 应输出 2.1.0
  # 方式 B：只用 CLI、不用 Skills 时
  npx -y @fission-ai/openspec@2.1.0 <command>
  ```

  升级版本须单独 `chore/` PR，并同步本节与 `openspec/config.yaml` 注释。
- 目录：`openspec/config.yaml`（项目上下文与产物规则）、`openspec/specs/`（已生效的能力规格）、`openspec/changes/`（进行中的变更，完成后 `archive`）。
- `.agents/skills/openspec-*` 是 OpenSpec 生成的通用 Skills（propose / explore / apply / update / sync / archive），供能读取 `.agents/skills` 的 Harness 使用。它们只是便利层；不支持 Skills 的 Agent 直接用 CLI 与本文件即可，流程效力相同。
- **新需求**用 OpenSpec change 管理：`openspec new change <id>` → 补齐产物 → `openspec validate <id> --strict` → Owner 批准后实施 → 合并后 `openspec archive <id>`。
- **存量规格**（`docs/specs/`、`docs/superpowers/specs/`、`docs/implementation/`）原位保留，状态见 [规格索引](specs/INDEX.md)。不批量迁移，不改写旧文正文。改动涉及其中某项能力时，必须先阅读相关存量文档并对照代码核实。
- **首次接管存量能力**（`openspec/specs/<capability>/` 尚不存在）时，按两步走，可以放在同一个 PR：
  1. **基线 change**（`baseline-<capability>`）：只用 `ADDED Requirements` 记录**现行行为**，每条要求注明来源（存量文档路径 + 章节，或代码位置），且已对照代码核实；不引入任何新行为。因为主规格还不存在，此时不能使用 `MODIFIED`/`REMOVED`。经 Owner 批准后 `openspec archive`，生成主规格。
  2. **功能 change**：在已存在的主规格上用 `MODIFIED`/`ADDED`/`REMOVED` 表达本次需求变化。
- **替代范围按章节登记**：基线 change 归档时，在索引"去向登记"中写明被取代的**具体章节**。只有登记的章节改以 `openspec/specs/` 为准；同一文档的其他章节保持原分类，不因此整体作废。
- **权威切换时点**：基线 change 归档进 `openspec/specs/` 并合入 `develop` 之后，切换才生效；在此之前，旧文档仍按其索引分类适用。核实中发现旧文档与代码不一致时，不写入基线，交 Owner 决定。
- `openspec validate` 只校验 OpenSpec 产物的格式，**不证明任何业务规格有效**；空目录校验通过不代表存量规格已核实。

## 3. Worktree 与环境隔离

**分支**：从 `develop` 切出 `feat/` / `fix/` / `chore/`；Agent 不得操作 `master`。新建 worktree 时避免自动跟踪 `develop`：

```bash
git fetch origin
git worktree add --no-track -b chore/<topic> ../worktrees/<dir> origin/develop
git push -u origin chore/<topic>:chore/<topic>   # 仅在 Owner 授权 push 后
```

**单写者**：一个任务同一时刻只有一个写入负责人（记录在交接文件）。多个写 Agent 不得共用同一工作树；只读调研和审查可以并行。换人写入前先完成交接（第 4 节）。

**Worktree 只隔离工作目录**，不隔离以下资源，需要另行安排：

| 资源 | 现状 | P0 规则 |
|---|---|---|
| PostgreSQL 测试库 | 后端测试每个用例前 `TRUNCATE` 共享业务表 | 同库测试**串行**：一个库同一时刻只跑一个后端测试进程或 E2E 套件。并行任务各自使用独立的可丢弃库（库名含 `monexus_test`，`verify:quick` 会检查），并在交接中写明库名（不写口令） |
| Redis | 默认测试 `REDIS_ENABLED=false` | 需要真实 Redis 的用例使用独立容器与端口 |
| 端口 / 开发服务 | 后端 3000、前端 5173、移动套件 5192 | Playwright 会复用已在运行的服务；跑 E2E 前确认端口上不是别的 worktree 的服务 |
| Docker 容器、对象存储、外部服务 | 共享宿主机 | 使用带任务前缀的容器名/桶；不连接生产或共享外部服务 |
| 凭据 | 宿主机环境 | 不复制进 worktree、交接或日志 |

本轮不改 Docker Compose 或测试基础设施。**Worktree 不是安全沙箱**：运行不可信代码、接触凭据或使用高权限工具时，须另用容器/独立用户/最小权限凭据隔离。

## 4. 交接协议（Handoff）

**位置**：OpenSpec 任务写 `openspec/changes/<id>/handoff.md`（随 change 归档）；其他任务写 `docs/handoffs/<task-id>.md`。随分支提交，合并后保留为记录、不再更新。

**任务契约必须在仓库内可追溯**：交接中的 Spec 只能指向仓库路径。任务来自聊天或口头指令、且没有 OpenSpec change 时，先写 `docs/handoffs/<task-id>.contract.md`，内容包括目标、范围（允许/禁止修改的路径）、非目标、验收条件、授权边界，以及 Owner 批准的来源和日期。交接中引用的设计决策要指向契约或其他仓库文件中的具体条目。

**何时更新**（不要求每改一个文件就更新）：完成有意义的检查点；发生已批准的设计变更；切换 Agent 或新开会话；出现阻断；进入独立审查前。

**原则**
- 只写恢复任务所需的事实，不复制会话记录；以链接指向规格、提交、PR、日志位置。
- 区分**声明**与**已验证事实**：每条完成项注明证据（提交 SHA、测试命令及退出码）；没有证据的标为"未验证"。
- 不写 secret、连接串口令、Cookie、原始敏感日志或生产数据。

**接任者必做**：读 `AGENTS.md` → 读交接文件与规格 → 独立执行 `git status`、`git log <base>..HEAD`、`git diff` 核对 → 按需重跑关键测试 → 与交接不符时以实际状态为准，并在交接中记录差异。

**模板**

```markdown
# Handoff: <task-id>

- Spec / 契约: <openspec/changes/<id>/ 或 docs/handoffs/<task-id>.contract.md 等仓库路径>
- 审查记录: <PR 评论链接或 docs/reviews/... 路径，及结论>（尚无则写"无"）
- 写入负责人: <agent/人>（更新时间 YYYY-MM-DD）
- 分支 / worktree: <branch> / <path>
- Base: origin/develop@<sha>；已验证 revision: <sha>（工作区是否有未提交修改：是/否，列出文件）
- 隔离资源: 测试库 <name>、端口 <...>、容器 <...>

## 已完成（附证据）
- <事项> — <commit sha / 测试命令 + exit code>

## 待完成
- <事项>

## 已批准的设计决策
- <决策> — <批准人/来源链接>

## 风险与阻断
- <描述、原因、需要谁决定>

## 验证记录
| 命令 | 结果（exit code） | revision |
|---|---|---|

## 未运行 / 无法验证
- <检查> — <原因>

## 下一步
- <一条可直接执行的操作>
```

## 5. 独立审查规程

**基本要求**
- 实现者的自评不能批准合并。审查者使用**独立会话**，优先不同模型或 Harness；不继承实现者的聊天上下文，只读交接文件、规格与代码。
- 审查对象是**固定提交快照**：报告首行写明 `base..head` SHA。工作区仍在变化时只能给阶段性意见，不能给最终结论。
- 审查者默认只读：不修改被审查分支、不 push、不 resolve 他人的 finding。可以在自己的临时目录写复现脚本或测试。
- 依据：已批准规格 + `git diff base..head` + 实际代码与调用链 + 可运行的测试。不得以"看起来正确"代替验证。

**高风险领域加审**：订单、充值、退款、钱包、库存、结算、权限相关改动，逐项检查状态机转移是否完整且不可越级；并发（锁顺序、行认领、CAS、事务边界）；幂等（`Idempotency-Key`、重放、重复回调）；回滚与部分失败（事务外副作用、补偿）；异常恢复（worker 崩溃、租约过期、未知结果）；所有权 404；整数金额。

**Finding 格式**（每条必须具备，缺项视为无效）

```markdown
### [P1] <一句话缺陷描述>
- 位置: server/src/modules/x/y.ts:123（符号名）
- 触发前提: <输入/状态/并发时序>
- 影响: <错误结果、受影响的数据或用户>
- 证据: <复现步骤/失败测试/代码路径推理；标注"已复现"或"推理未复现">
- 建议: <修复方向（可选）>
```

**严重度与关闭条件**

| 级别 | 含义 | 合并 | 关闭条件 |
|---|---|---|---|
| P0 | 资金/积分错误、数据损坏或丢失、越权或数据泄露、生产不可用、不可逆外部副作用 | 阻断 | 修复提交 + 回归测试证据 + 审查者在新 SHA 上复核 |
| P1 | 违反 `AGENTS.md` 硬约束或规格验收标准、可触发的并发/幂等缺陷、核心流程错误、关键路径缺回归测试 | 阻断 | 同 P0 |
| P2 | 边界情形错误、可观测性或人工处理出口缺失、非关键路径缺陷 | 合并前修复，或 Owner 书面接受并登记后续项 | 修复并复核，或 Owner 接受记录 |
| P3 | 可维护性、命名、文档 | 不阻断 | 实施者自行决定 |

- 误报由审查者撤回并写明理由；实施者不能自行关闭 P0/P1。
- 无法验证的内容（如需真实支付渠道、生产数据、CI 才有的环境）必须列在"未验证"中，不得默认通过。
- 结论只能是：`APPROVE`（无未关闭 P0/P1）/ `REQUEST_CHANGES` / `INCONCLUSIVE`（列明缺失的验证条件）。不接受无 finding、无验证说明的空泛 LGTM。
- 报告存放：随 PR 评论，或较大审查写入 `docs/reviews/YYYY-MM-DD-<topic>.md`。报告价值在发现与证据，不追求篇幅。

## 6. 验证与证据报告

| 检查 | 本地（Agent） | GitHub CI |
|---|---|---|
| 受影响的前端单测 / 后端集成测试 | 必须（`npm test -- <files>`、`npm --prefix server test -- <files>`、`npm run verify:quick`） | 全量（backend 6 shard） |
| 类型检查 / 构建 | 改到对应一端时 `npm run build` / `npm --prefix server run build` | 是 |
| 架构、契约、迁移检查 | 改模块边界、OpenAPI、迁移时 `npm run test:architecture`、`npm run check:architecture`、`npm run check:migrations` | 是 |
| E2E | 仅排查或按 `testing-policy.md` 需要时运行指定 spec | push→develop 全量；PR 需 `run-e2e` 标签 |
| 部署契约、真实 Redis/MinIO | 一般不跑 | 是 |

- 最终门禁是 `CI OK`。本地结果只证明对应 revision 上执行过的那部分。
- 每次报告验证都写：**实际命令、退出码与结论、对应提交 SHA（以及是否含未提交修改）、未执行的检查及原因**。失败要附关键输出，不得改写成"基本通过"。
- 明显与本次修改无关的既有失败，记录后不扩大范围修复。
- 本轮不修改 CI 工作流；CI 调整以建议形式提交 Owner。

## 7. 成本与人工控制

- 本阶段只记录要求，不引入自动计费或编排系统。未来自动化编排必须支持：任务预算、最大尝试次数、最长执行时长、人工随时停止。
- **禁止无限 Review-Fix 循环**：同一任务默认最多 3 轮"审查 → 修复 → 复审"；仍有未关闭 P0/P1 时停止并交 Owner 决策。同一失败测试连续 3 次修复无进展也停止上报。
- 必须由人工授权（每次单独授权，不跨任务延续）：push、创建/合并 PR、修改受保护分支、改写历史、部署、修改生产环境或生产数据、破坏性迁移、删除云资源、修改权限、发布包。
- 并行 Agent 数量以能独立审查和隔离资源为上限；不为"多角度"而无谓派生 Agent。
