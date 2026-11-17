# Review R1: chore-agent-sdd-p0

- 审查对象：`3b6f1e0` + 16 个未提交文件（工作区阶段性审查，非固定提交快照）
- 审查者：独立会话（Owner 转交），只读
- 结论：**REQUEST_CHANGES**（P1 ×1，P2 ×3）

## Findings 与处置

| # | 级别 | Finding（摘要） | 处置（实施者） | 关闭条件 |
|---|---|---|---|---|
| 1 | P1 | `AGENTS.md` 权威表把全部 `NEEDS_REVIEW` 规格归为"历史文档，仅作背景"，与 `INDEX.md`"不得忽略其约束"冲突，可能导致后续 Agent 跳过结账、充值、治理等现有需求 | `AGENTS.md` §1 单列 `NEEDS_REVIEW` 行："待核实，不是历史文档；涉及该能力时必须阅读并核实，冲突报 Owner"；历史材料只保留 reviews/refactoring/archive；`INDEX.md` 分类说明同步 | R2 已接受 |
| 2 | P2 | wallet 规则写"测试也须用 wallet 命令、脚本强制"，但扫描器排除测试文件（`check-architecture.mjs:11`）、允许 seed 例外，现有测试直接改余额；worker 认领描述未覆盖 `fulfillment/jobProvider.ts` 的"先锁 Order 行再检查租约" | wallet 规则限定为 `server/src/` 非测试代码，写明 seed 例外，并说明测试不在扫描范围、不要求整改；worker 规则改为通用描述，列出三种现有实现形态及对应文件，注明不要求改造 | R2 已接受 |
| 3 | P2 | 交接的 Spec 指向未落盘的会话指令，"Owner 指令 §四.2"在仓库中无法追溯；缺少原始范围、非目标、验收条件 | 新增 `docs/handoffs/chore-agent-sdd-p0.contract.md`（按原文节号）；交接改为链接该契约；`agent-workflow.md` §4 新增"任务契约必须在仓库内可追溯"，模板加入契约与审查记录字段 | R2 已接受 |
| 4 | P2 | 首次把存量能力接入 OpenSpec 的规则不闭合：主规格不存在时无法使用 `MODIFIED`（sync skill 会拒绝），"部分被替代"的边界和权威切换时点未定义 | `agent-workflow.md` §2 新增两步流程（只用 ADDED 记录现行行为的基线 change → 功能 change）、按章节登记替代范围、切换时点 = 基线归档并合入 develop；`INDEX.md` 去向表增加章节与生效提交列。已在临时项目实测：主规格不存在时 `MODIFIED` 能通过 `validate`（仅 INFO），但 `archive` 退出 1；两步流程均成功归档 | R2 已接受 |
| — | 备注 | 固定版本 `npx` 与 Skills 中裸 `openspec` 命令未打通 | `agent-workflow.md` §2 增加方式 A（安装到用户目录 + `PATH`），Skills 可直接使用；已实测 `openspec --version` = 2.1.0 | — |

R1 中"其余判断"（CronLease 区分方向、锁顺序、`run-e2e` 时机、未改业务代码/CI/依赖、不实施 P1）未要求改动。

## R2 复审

- 审查对象：`3b6f1e0` + 18 个未提交文件（工作区）
- 结论：**通过**。R1 四条处置全部接受，未发现新的阻断问题；交接、契约、审查记录作为 P0 必要交付证据保留。
- 审查者独立执行：固定版本 CLI 版本检查、`openspec doctor`、`openspec validate --all --strict`（空规格结果）、空白检查、本地 Markdown 链接检查，均通过。未重跑：两步归档实验、Claude 导入验证、业务测试。
