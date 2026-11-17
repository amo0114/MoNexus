# Task Contract: chore-agent-sdd-p0

- 来源：仓库 Owner 于 2026-11-17 在 Agent 会话中下达的指令《MoNexus — Agent-Agnostic SDD 工程规范化试点 P0》。本文是该指令的忠实摘要，节号沿用原文（§一–§十）；与原文冲突时以 Owner 确认为准。
- 批准：Owner 下达即授权在 §九 范围内修改文件；commit、push、PR、merge、deploy **未授权**。

## §一 目标
建立与具体模型、Agent Harness 无关的轻量工程规范：跨 Agent 统一契约、无上下文交接、独立审查、可验证交付。技术路线：OpenSpec 2.1、`AGENTS.md`、Git Worktree、Handoff、Independent Review、复用现有 CI。只做 P0 工程规范化：不改业务代码、不开发功能、不部署。

## §二 先做只读基线调查
Git 状态与 worktree；现有指令文件与真实业务不变量（建立规则清单：来源、范围、是否有效）；`docs/specs|superpowers|implementation|verification|reviews|api` 的有效性分类（**不得把历史文档整体复制进 OpenSpec**；不得改变已有后端治理任务的范围、契约、实施责任）；验证体系真实入口（不得编造命令）；OpenSpec 确切版本、Node 兼容、init/skills/validate 真实参数（固定版本，不用不受控的 latest；不为它升级 Node/npm/依赖）。只有存在破坏现有工程的阻断风险时才暂停。

## §三 P0-1 统一工程规则
根目录 `AGENTS.md` 为权威入口，至少保留：技术栈与模块边界、整数金额、交易一致性、Idempotency-Key 与价格保护、404 防枚举、锁顺序与并发、时间/时区、多实例定时任务、测试分层与 CI 纪律、生产/凭据/部署限制——**与代码核对，不得照抄过期规则**。要求精简可操作、引用而非复制、写明权威与冲突处理、覆盖接手/开发/验证/审查/交接。`CLAUDE.md` 在确认规则已迁移、Claude Code 可正确加载后收敛为 `@AGENTS.md`。输出迁移对照表。

## §四 P0-2 引入 OpenSpec
1. 优先仓库内可版本化配置；2. **不默认安装所有 Harness 适配文件**；3. 不引入 Spec Kit/BMAD；4. 不改已有业务规格语义；5. 不自动迁移 `docs/specs`；6. 不生成大量空模板；7. 新权威规格须有归属与生命周期。有效存量规格原位保留、以索引引用；新需求用 OpenSpec；旧规格在明确业务变更中逐步整理；无法确认有效性的标 `NEEDS_REVIEW`，不得凭模型判断废弃。

## §五 P0-3 交接协议
新增 `docs/agent-workflow.md`。交接记录：Task ID 与 Spec、分支/base SHA/已验证 revision、未提交修改、已完成、待完成、已批准决策、风险与阻断、已运行测试及退出结果、未运行项、下一步。区分完成声明与已验证事实；接任者独立核对。只存恢复所需信息，不存秘密。更新时机：检查点、批准的设计变更、切换 Agent/会话、阻断、进入审查前；不要求每改一个文件就更新。

## §六 P0-4 独立审查
实现者不能自评批准；独立会话，优先不同模型/Harness；依据规格、diff、代码；审查固定快照；默认只读；Finding 含位置、触发前提、影响、证据；禁止空泛 LGTM；P0–P3 分级与关闭条件；无法验证的必须说明。资金/订单/库存/结算/权限类改动加审状态机、并发、幂等、回滚、异常恢复。

## §七 P0-5 Worktree 与环境隔离
保持现有分支模型（develop、`feat/` `fix/` `chore/`，Agent 不操作 master，保留 PR/CI 审批）。一个任务同时只有一个写入负责人。写明 worktree 不隔离 PostgreSQL、Redis、Docker、端口、对象存储、外部服务、凭据；同库集成测试必须串行；本轮不重构 Compose/测试基础设施；worktree 不是安全沙箱。

## §八 P0-6 验证、成本、人工控制
复用现有验证体系，不重建、不自动修改 CI。区分本地与 CI 检查。报告命令、退出码、代码版本、未执行项。成本治理只记录要求（预算、最大尝试、最长时长、人工停止）；禁止无限 Review-Fix 循环；生产数据、受保护分支、push、merge、deploy 须人工授权。

## §九 范围
- 允许修改：`AGENTS.md`、`CLAUDE.md`、必要的 OpenSpec 配置与项目级 Skills、`docs/agent-workflow.md`、必要的规格索引或 P0 报告。
- 禁止修改：`src/**`、`server/**`、`e2e/**`、存量业务规格正文、已有迁移、CI/CD 工作流、Docker 与部署配置、业务逻辑与测试断言。
- 超出范围的必要修改记为 P1 建议；不自动 commit/push/PR/merge/deploy；不用破坏性 Git 操作。

## §十 验收
交付：基线总结、文件清单、迁移对照表、OpenSpec 版本与初始化结果、存量规格分类与迁移策略、交接协议、审查规程、隔离规则、验证命令/退出码/证据、diff/限制/P1 建议。执行 OpenSpec 校验与 `git diff --check`；空目录校验通过不得解释为业务规格有效。通过标准：硬约束未丢失；无业务代码改动；规则不依赖特定 Agent；不产生新的权威冲突；交接支持全新会话接手；CI 与开发流程未被破坏；无不必要的编排器/服务/依赖。完成后等待人工审查，**不进入 P1**。
