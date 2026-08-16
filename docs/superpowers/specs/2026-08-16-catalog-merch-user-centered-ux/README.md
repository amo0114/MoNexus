# Catalog / Merch 用户心智与媒体工作流修订 - Spec Coding 工程文档包

本目录是 `SPEC-CMI-UX-001` 的唯一规格入口。它修订已上线的 Catalog / Merch
前台陈列、分类封面、XBoard 封面和结算文案体验。当前交付只包含规格文档，
不包含业务代码、数据库迁移、运行时配置或生产数据变更。

| 文档 | 角色 | 交付内容 |
| --- | --- | --- |
| [spec.md](./spec.md) | Specify | 用户问题、冻结决策、交互/API 契约、需求与验收标准 |
| [plan.md](./plan.md) | Plan | 目标架构、文件影响面、阶段、测试、发布与回滚 |
| [task.md](./task.md) | Tasks | 原子任务、依赖、Owned/Must Not Touch、DoD |
| [implement.md](./implement.md) | Implement | Worktree、分支、提交顺序、命令、Gate 与证据模板 |
| [checklist.md](./checklist.md) | Checklist | P0/P1 完成定义、AC 索引和 PR Gate |

执行顺序固定为 Specify -> Plan -> Tasks -> Implement -> Checklist。实施 Agent
不得以当前代码中的注释、稳定错误码或旧组件测试反向推翻本规格的 Owner 决策。

| 字段 | 值 |
| --- | --- |
| 规格 ID | `SPEC-CMI-UX-001` |
| Plan ID | `PLAN-CMI-UX-001` |
| Tasks ID | `TASK-CMI-UX-001` |
| Implement ID | `IMPL-CMI-UX-001` |
| Checklist ID | `CHK-CMI-UX-001` |
| 版本 | `0.2.0` |
| 日期 | `2026-08-16` |
| 状态 | **Frozen for Implementation** |
| Owner | MoNexus Project Owner |
| 审查基线 | `develop@4554f96dd7780e83b80dc98ad4938bf5e181a275` |
| 目标实现分支 | `fix/catalog-merch-user-ux`，从包含本规格的最新 `origin/develop` 创建 |
| 目标 Worktree | `/root/projects/worktrees/monexus-catalog-merch-user-ux` |
| 前置规格 | `SPEC-CATALOG-OPS-001`、`SPEC-MERCH-001`、AMD-CMI-012 |
| 工程规范 | `docs/branching-and-ci.md`、`docs/testing-policy.md` |

## 一句话结论

用户只应操作商品、图片和业务动作，不应操作对象路径、数据库字段或稳定错误码；
推广与精选必须表现为商品获得更多曝光，而不是首页出现空的开发者式内容区。

## Owner 冻结决策摘要

- [x] `O-UX-01`：首页和分类页不再渲染独立 Sponsored/Editorial 空 shelf。
- [x] `O-UX-02`：推广商品以带明确“推广”披露的普通商品卡混入商品流，获得可量化曝光。
- [x] `O-UX-03`：平台精选以同一商品流中的精选卡表达，不占固定空区块。
- [x] `O-UX-04`：搜索结果保持相关性，不注入推广或精选。
- [x] `O-UX-05`：无候选、候选失效或推荐接口失败时静默回退普通商品流。
- [x] `O-UX-05A`：混排不丢弃已加载的自然商品；首屏未消费项紧随第 12 槽展示。
- [x] `O-UX-06`：分类封面不再要求填写 `/uploads/` 或 `/assets/` 路径。
- [x] `O-UX-07`：写入/确认以服务端登记的 `objectKey` 为权威，服务端派生 URL 写入既有字段；
  不新增 Category objectKey 持久字段。
- [x] `O-UX-08`：XBoard 本地上传、分类默认封面共享同一服务端媒体解析器。
- [x] `O-UX-09`：`COVER_INVALID` 等稳定码保留在协议、日志和测试，不作为主要可见文案。
- [x] `O-UX-10`：积分冻结/支付/返还文案按用户资金结果描述，不解释“分色展示”等实现细节。
- [x] `O-UX-11`：后台默认不展示 raw ID、`capacity_limit`、`null`、路径和 `blockReason`。
- [x] `O-UX-12`：本修订不改变推广计费、订单资金状态机、数据库表或生产存量数据。

## 交接入口

本 docs-only PR 必须先合入 `develop`。实施 Agent 开始前必须完整阅读本目录六份文档，
按 `implement.md` 动态取得规格 commit 并记录：

1. 最新 `origin/develop` SHA；
2. 本规格 docs commit 已是其祖先；
3. 新 worktree、分支、Node/npm 版本；
4. 预计触及的宿主文件；
5. 本地可用的 disposable PostgreSQL 和测试端口。

任何改变混排槽位、媒体信任边界、公开披露、资金语义或错误外部语义的提议，必须
先把本规格退回 Draft 并由 Owner 重新批准。
