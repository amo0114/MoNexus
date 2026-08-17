# 管理员平台商品发布闭环 - Spec Coding 工程文档包

本目录是 `SPEC-ADMIN-PUB-001` 的唯一规格入口，解决平台管理员从 XBoard
导入或手工创建平台商品后，商品停留在草稿但后台没有发布入口的问题。

当前交付只包含规格文档，不包含业务代码、数据库迁移、运行时配置或生产数据变更。

| 文档 | 角色 | 内容 |
| --- | --- | --- |
| [spec.md](./spec.md) | Specify | 用户问题、冻结决策、状态/交互/API 契约和验收标准 |
| [plan.md](./plan.md) | Plan | 组件边界、文件影响面、测试、风险和回滚 |
| [task.md](./task.md) | Tasks | 原子任务、依赖、Owned/Must Not Touch 和 DoD |
| [implement.md](./implement.md) | Implement | 分支、worktree、命令、提交顺序和证据模板 |
| [checklist.md](./checklist.md) | Checklist | P0/P1、AC 索引和 PR Gate |

执行顺序固定为 Specify -> Plan -> Tasks -> Implement -> Checklist。实施 Agent
不得以现有页面缺少按钮为理由改变已冻结的 draft/readiness/publish 领域状态机。

| 字段 | 值 |
| --- | --- |
| 规格 ID | `SPEC-ADMIN-PUB-001` |
| Plan ID | `PLAN-ADMIN-PUB-001` |
| Tasks ID | `TASK-ADMIN-PUB-001` |
| Implement ID | `IMPL-ADMIN-PUB-001` |
| Checklist ID | `CHK-ADMIN-PUB-001` |
| 版本 | `0.1.0` |
| 日期 | `2026-08-17` |
| 状态 | **Frozen for Implementation** |
| Owner | MoNexus Project Owner |
| 编写基线 | `develop@fe163ffc93cc32218e9476a07494307716a1e7aa` |
| 目标实现分支 | `fix/admin-platform-product-publication`，从包含本规格的最新 `origin/develop` 创建 |
| 目标 Worktree | `/root/projects/worktrees/monexus-admin-platform-publication` |
| 前置规格 | `SPEC-CATALOG-OPS-001`、`SPEC-CMI-UX-001` |
| 工程规范 | `docs/branching-and-ci.md`、`docs/testing-policy.md` |

## 一句话结论

XBoard 导入仍然只创建平台草稿，但导入成功后立即进入发布检查；管理员也可以在
“商品与库存”列表中看懂状态并完成发布、重新上架或下架，不再需要手工调用 API。

## Owner 决策摘要

- [x] `O-APUB-01`：保留 `create/confirm -> draft -> readiness -> active`，禁止自动发布。
- [x] `O-APUB-02`：XBoard 导入成功后自动打开发布检查，而不是只显示 toast 后关闭。
- [x] `O-APUB-03`：商品列表展示“草稿 / 已发布 / 已下架”，不显示 raw status。
- [x] `O-APUB-04`：发布/重新上架/下架入口只提供给 `merchantId=null` 的平台商品；
  商家商品继续由商家工作台管理。
- [x] `O-APUB-05`：发布前必须读取服务端 readiness；客户端不得自行推断可发布。
- [x] `O-APUB-06`：发布问题显示用户文案和规格名称，不显示稳定错误码、字段名或 raw Offer ID。
- [x] `O-APUB-07`：复用现有 Admin + MFA API，不新增或放宽后端权限。
- [x] `O-APUB-08`：本次不改变 XBoard 导入、发布状态机、库存、订单、营销和数据库契约。
- [x] `O-APUB-09`：管理员发布/下架缺少 actor 审计作为独立债务登记，不在本次 UI 闭环中顺手重构。

以上为本规格的冻结边界。任何改变必须先退回 Draft 并由 Owner 重新批准。
