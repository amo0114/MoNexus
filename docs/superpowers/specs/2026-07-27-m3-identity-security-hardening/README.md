# M3 身份与特权操作安全收口 — 工程文档包

| 文档 | 角色 | 标准对应 |
| --- | --- | --- |
| [spec.md](./spec.md) | Specify / 规格与需求 | 问题、范围、领域规则、API 契约、验收标准 |
| [plan.md](./plan.md) | Plan / 技术规划 | 架构、技术方案、阶段、发布与回滚 |
| [task.md](./task.md) | Tasks / 工作分解 | 原子任务、依赖、所有权、DoD |
| [implement.md](./implement.md) | Implement / 执行协议 | 工作树/运行时隔离、三色权限、单任务日志、验证与合并闸门 |
| [checklist.md](./checklist.md) | Implement Gate / 完成定义 | P0/P1 门禁、安全、验证与发布就绪 |

执行顺序：Specify → Plan → Tasks → Implement → Checklist 验收。

| 字段 | 值 |
| --- | --- |
| 规格 ID | SPEC-M3-ISH-001 |
| 建议分支 | feat/m3-identity-security-hardening（从 develop 创建，PR → develop） |
| 日期 | 2026-07-27 |
| 状态 | Specify / Plan / Tasks：已冻结；Implement：I-00、I-01、I-02、I-03 本地完成；I-03 的 P1 `User`/session 锁序已复审验证；当前 P6c rebase 是 PR 前闸门 |

本包只收口“管理员身份安全 + 全角色设备会话管理 + 密码哈希升级”这一条主线。它刻意不混入 OAuth、Passkey、通用风控引擎、隐私导出/注销、业务订阅或通知队列。

I-03 采用 D-07：显式设备吊销与 refresh rotation replay 以**同一用户事务锁 + 锁后重读 + family 终结标记**区分；同一事务若还写 `User`，固定为 **advisory lock → User 写锁**。这同时确保“退出其他设备”不会反向退出当前设备、rotation 不会在吊销返回后留下 successor，且管理员封禁/角色变化不会与改密形成死锁。
