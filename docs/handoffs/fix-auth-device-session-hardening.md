# 用户登录设备与会话数据安全加固交接

- 任务契约：[fix-auth-device-session-hardening.contract.md](fix-auth-device-session-hardening.contract.md)
- 基线：`origin/develop@5b2624a`
- 分支：`fix/auth-device-session-hardening`（worktree：`/root/.t3/worktrees/MoNexus-new/fix-auth-device-session-a3a370eea07d6246`）
- 隔离测试库：`monexus_test_session_hardening`（PostgreSQL 16，合成测试数据）
- 独立审查对话：`thread:delegated-task:command%3Amcp%3A85fc1595-986e-4bca-9653-92f1cc3a6678%3Adelegate-task%3A0688eca4-0eb8-48ea-a168-374793b34770`

## 当前状态

- 状态：实施中（已建立工作区、Node 22.23.1 环境、依赖与隔离测试库，正在按 Commit 1 → Commit 2 → Commit 3 推进）
- 授权状态：仅授权本地实施、验证与送交 Codex 审查；**未授权** push、创建/合并 PR 或操作 `master`。

## 计划提交切片

1. **Commit 1**：重放 DoS 状态机修复 + `revokeAllUserRefreshTokens` 活跃家族计数与全路径审计元数据透传 + 契约/交接文档 + 回归测试。
2. **Commit 2**：Prisma Schema 与双迁移（字段/回填 + 单语句 `CREATE INDEX CONCURRENTLY`）+ D2 写侧最小化与历史回填 + D5 绝对有效期与 20 台设备上限 + D4 每日家族级清理 Cron 与可移植备份排除 + 回归测试。
3. **Commit 3**：D6 同账号重登替换与改密安全清 Cookie + D7 IP 规范化/IPv6 `/56`、有界线性 UA 解析器、生产拓扑启动守卫 + 前端 `SessionManager` / `ProfilePage` / `ProfileIdentityCard` / `AdminFileGovernance` 加固 + 模块文档更新 + 回归测试。

## 验证记录

（待各提交与最终快照验证完成后如实补齐命令、退出码与对应 SHA。）
