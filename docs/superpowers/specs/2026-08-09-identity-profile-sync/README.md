# 当前用户资料同步与头像一致性 — Spec Coding 工程文档包

本目录是 SPEC-IDENTITY-SYNC-001 的唯一实施入口。当前仅完成规格设计，不包含业务代码、数据库迁移、运行时配置或通知实时化改动。

| 文档 | 角色 | 交付内容 |
| --- | --- | --- |
| [spec.md](./spec.md) | Specify | 问题、Owner 决策、同步协议、API、不变量、需求与验收 |
| [plan.md](./plan.md) | Plan | 目标架构、分阶段方案、并行边界、测试、发布与回滚 |
| [task.md](./task.md) | Tasks | 原子任务、依赖、Owned/Must Not Touch、DoD 与证据 |
| [implement.md](./implement.md) | Implement | Worktree、权限、文件锁、实施卡、Race Gate 与交接 |
| [checklist.md](./checklist.md) | Checklist | P0/P1 完成定义、AC 索引、PR/发布闸门 |

执行顺序固定为 Specify → Plan → Tasks → Implement → Checklist。实施 Agent 不得用当前代码中的裸 `setUser` 行为反向改写已冻结的同步协议。

| 字段 | 值 |
| --- | --- |
| 规格 ID | SPEC-IDENTITY-SYNC-001 |
| Plan ID | PLAN-IDENTITY-SYNC-001 |
| Tasks ID | TASK-IDENTITY-SYNC-001 |
| Implement ID | IMPL-IDENTITY-SYNC-001 |
| Checklist ID | CHK-IDENTITY-SYNC-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| Spec Worktree | `/root/projects/worktrees/monexus-catalog-inventory-merchandising` |
| 实施 Worktree（批准后） | `/root/projects/worktrees/monexus-identity-profile-sync` |
| 并行契约 | [PAR-CMI-001](../2026-08-09-catalog-merch-identity-parallel-contract.md) |
| 外部文件锁 | SPEC-NOTIFY-RT-001 的 T-FE-002 完成前独占 `src/components/Layout.tsx` |
| 方法依据 | [JavaGuide：Spec Coding 实践](https://javaguide.cn/ai-coding/practices/spec-coding.html)；仓库既有六件套规范 |

## 一句话结论

这不是 WebSocket/SSE 缺失，而是“同一 SPA 内没有唯一当前用户提交协议”加上 Navbar 根本未渲染 `avatarUrl`：以 session epoch、用户修订号和请求序号拒绝过期响应，串行化资料 PATCH，所有 `/me`/资料写入经统一 coordinator 提交，并让桌面 Navbar、移动抽屉和个人中心共同消费同一头像组件。

## Owner 已批准的冻结决策

- [x] `O-ID-01`：本问题使用本地单向状态同步解决，不引入 WS、SSE、消息队列或新数据库表。
- [x] `O-ID-02`：`AuthUser` 在当前浏览器 Tab 内只有 authStore 一个权威副本；所有 `/auth/me` 响应只能经 profile coordinator 提交。
- [x] `O-ID-03`：运行时使用非持久化 `sessionEpoch + userRevision + profileMutationRevision + forceGeneration + requestId + expectedUserId`；不满足提交票据的响应必须静默丢弃。
- [x] `O-ID-04`：昵称和头像 PATCH 由同一 per-session 队列串行执行；成功响应是完整服务端 Profile，禁止用 React 闭包中的旧 `user` 合并。
- [x] `O-ID-05`：登录、登出和当前主体切换推进 session epoch；同一主体的 access-token refresh 不推进 epoch，但 token 写入也必须做当前会话校验。
- [x] `O-ID-06`：GET/PATCH `/api/auth/me` 均返回完整 AuthUser projection，并显式发送 `Cache-Control: private, no-store`。
- [x] `O-ID-07`：头像 blob 继续使用内容寻址不可变 key；新内容必须得到新 URL，相同内容允许去重，禁止覆盖旧 key 或用 query 参数伪装可变对象。
- [x] `O-ID-08`：桌面 Navbar、移动导航抽屉和个人中心即时显示同一 `avatarUrl`；清除后同步恢复文字 fallback。
- [x] `O-ID-09`：路由变化不再直接触发裸 `/me → setUser`；受保护入口、显式业务完成和回前台校准经 coordinator 触发并受去重/新鲜度约束。
- [x] `O-ID-10`：Identity Core 不修改 `Layout.tsx`、`appStore.ts`、通知模块或 `server/src/middlewares/auth.ts`；Layout 接线等待通知 T-FE-002 释放 commit。
- [x] `O-ID-11`：P0 保证同一 SPA Tab 内的资料一致性；保留既有、受 current-session guard 保护的 token-only 跨 Tab refresh 协调，但不广播 AuthUser/profile；跨设备实时同步不在本波范围。
- [x] `O-ID-12`：旧请求 401、旧 refresh 结果、旧 PATCH 成功或失败都不得影响已经切换的新会话，也不得显示误导性成功 Toast。

Owner 已批准 O-ID-01～12 与 PAR-CMI-001；六份文档已冻结。全部 Implement 卡继续保持 Pending，直至 `S` 与各卡 Entry Gate 真实满足。

## 已核实根因

- `ProtectedRoute` 和 `Layout` 可并行请求 `/auth/me`，随后均无条件 `setUser`，没有会话代次、请求序号或 mutation barrier。
- `ProfileIdentityCard` 的昵称、上传头像、清除头像处理器都使用闭包中的旧 `user` 合并完整响应；并发完成时可互相覆盖。
- 桌面 Navbar 始终渲染固定 `User` 图标，移动抽屉也始终渲染固定图标；即使 store 已更新，它们也不会显示头像。
- GET/PATCH `/auth/me` 没有显式 `no-store`；上传 blob 则已正确使用内容哈希 key 和一年 `immutable` 缓存。
- `authStore.setUser` 是整对象无条件替换；刷新 token、登出/重新登录与旧 `/me` 响应之间没有主体隔离。

## 与其他规格的边界

- Catalog/Merch 不依赖本规格；Identity 不修改商品 schema、migrations、products service 或 StorePage。
- SPEC-NOTIFY-RT-001 先拥有 `Layout.tsx`、`appStore.ts` 和 auth middleware；Identity Core 可立即并行，Layout 接线严格后置。
- 本规格不新增任何通知事件，也不改变 SSE、通知 polling、订单、积分或商家状态业务语义。

## 实施祖先契约

- Owner Freeze 时最新 `origin/develop` 记为 `D`；只含三套六件套与 PAR-CMI-001、且直接父提交为 `D` 的 Frozen spec commit 记为 `S`。
- Identity Backend/Core 从 `S` 分叉；Frontend 从以 `S` 为祖先的 Core contract tip 开始。任何较新的 develop 都不能绕过 `S`。
- 通知 Layout release 记为 `N`，Identity Core/FE handoff 记为 `C_ID`；协调者建立同时以二者为祖先的 `M_ID`，Identity Layout 只能从 `M_ID` 开始。
- Evidence Ledger 必须保存 `S^=D` 以及 `git merge-base --is-ancestor <N> <M_ID>`、`git merge-base --is-ancestor <C_ID> <M_ID>` 的 exit 0；“基于/包含”文字不是证据。

## 审核与变更控制

- Owner 修改任一 O-ID 决策时，必须同步六件套、PAR-CMI-001、版本与追溯矩阵。
- Frozen 后改变提交票据、PATCH 串行语义、触发器、缓存或 Layout 文件锁，须退回 Draft 重新批准。
- 本包不授权修改通知 Worktree、生产账户、生产对象存储、生产数据库或真实用户资料。
