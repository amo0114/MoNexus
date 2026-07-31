# 注册、激励与邮件反滥用闭环 — 工程文档包

| 文档 | 角色 | 标准对应 |
| --- | --- | --- |
| [spec.md](./spec.md) | Specify / 产品与安全规格 | 问题、范围、决策、领域不变量、API 契约、验收标准 |
| [plan.md](./plan.md) | Plan / 技术规划 | 现状、目标架构、数据/并发方案、阶段、发布与回滚 |
| [task.md](./task.md) | Tasks / 工作分解 | 原子任务、依赖、所有权、完成定义 |
| [implement.md](./implement.md) | Implement / 执行协议 | worktree、迁移、测试与合并约束 |
| [checklist.md](./checklist.md) | Implement Gate / 验收清单 | P0/P1 门禁、安全、发布就绪 |

执行顺序：**Specify → Plan → Tasks → Implement → Checklist 验收**。

| 字段 | 值 |
| --- | --- |
| 规格 ID | `SPEC-RAP-001` |
| 建议分支 | `feat/registration-abuse-prevention`（从最新 `develop` 创建，PR → `develop`） |
| 日期 | 2026-08-01 |
| 状态 | Feature implementation complete in `feat/registration-abuse-prevention`; CI/staging/release gates remain pending |
| 前置规格 | `SPEC-OPS-REGMAIL-001` 注册开关与邮件投递运营面；M3 身份与会话安全收口 |

## 范围边界

本包处理公开注册、验证邮件、邮箱交易资格、邀请码/奖励和反滥用运营闭环。它**不修改**正在并行开发的移动端 UI 文件，也不重写 `SPEC-OPS-REGMAIL-001` 的注册开关与 SMTP 管理面；后者合入后才是本包的实现基线。

本包故意不把 CAPTCHA 当成唯一防线：验证码、人群速率限制、邮箱验证、邀请码额度、奖励延迟和人工处置必须同时存在。邮箱验证是“可获得价值”的门槛，不是对用户身份真实性的 KYC 声明。

## 当前交付状态（2026-08-01）

- 已完成：Redis + Turnstile fail-closed 注册/邮件防护、邮箱资格门槛、延迟奖励账本与 cron、邀请码并发额度、MFA 管理端风控 API、管理台面板、OpenAPI 与运维文档。
- 已验证：隔离 PostgreSQL 库上的奖励/管理员/注册邮件流程 20 项测试，前端构建、后端构建，以及 5 项相关 Playwright 场景。
- 仍待发布责任人完成：完整 CI、真实 staging Redis/Turnstile/SMTP catcher 演练、24 小时观察和生产灰度。不得把这些外部步骤标记为已完成。
