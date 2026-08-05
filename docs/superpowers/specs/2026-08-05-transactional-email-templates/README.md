# 事务邮件品牌模板 — 工程文档包

| 文档 | 角色 | 标准对应 |
| --- | --- | --- |
| [spec.md](./spec.md) | Specify / 规格与需求 | 问题、范围、领域规则、模板清单、验收标准 |
| [plan.md](./plan.md) | Plan / 技术规划 | 架构、目录、阶段、发布与回滚 |
| [task.md](./task.md) | Tasks / 工作分解 | 原子任务、依赖、所有权、DoD |
| [implement.md](./implement.md) | Implement / 执行协议 | 工作树隔离、三色权限、验证与合并闸门 |
| [checklist.md](./checklist.md) | Implement Gate / 完成定义 | P0/P1 门禁与发布就绪 |

执行顺序：Specify → Plan → Tasks → Implement → Checklist 验收。

| 字段 | 值 |
| --- | --- |
| 规格 ID | SPEC-MAIL-TPL-001 |
| 建议分支 | `feat/email-templates-polish`（从 develop 创建，PR → develop） |
| Worktree | `/root/projects/worktrees/monexus-email-templates-polish` |
| 基线 | `origin/develop` @ `8c47201` |
| 日期 | 2026-08-05 |
| 状态 | Specify / Plan / Tasks / Implement 本地完成；待 PR → develop |

本包只收口「事务型 / 运营型外发邮件」的呈现层：统一品牌布局、双格式（HTML + text）、调用点收敛。  
不引入营销群发、模板 CMS、SMTP 配置变更或认证安全协议改动。
