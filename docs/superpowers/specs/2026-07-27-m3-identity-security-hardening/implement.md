# Implement Protocol: M3 身份与特权操作安全收口

| 字段 | 值 |
| --- | --- |
| 文档 ID | IMPL-M3-ISH-001 |
| 版本 | 1.3.0 |
| 日期 | 2026-07-27 |
| 状态 | I-00 Done；I-01 In Progress（P6a rebase 为 PR 前闸门） |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) · [checklist.md](./checklist.md) |
| 方法依据 | [JavaGuide Spec Coding：Specify → Plan → Tasks → Implement](https://javaguide.cn/ai-coding/practices/spec-coding.html) |

---

## 1. Implement 入口门槛

Implement 不是“文档写完就直接编码”。每个任务开始前，执行者必须确认：

- [ ] Specify 已冻结：spec.md 的 D-01 至 D-06 无未决产品/安全决策。
- [ ] Plan 已冻结：plan.md 的架构、API、数据模型、发布/回滚路径可执行。
- [ ] Tasks 已冻结：只执行 task.md 中当前任务卡，验收条件可测试。
- [ ] 当前工作在独立 worktree 和 feature branch；不是 P6a 的工作树或分支。
- [ ] 当前任务的 Owned files、Must Not Touch、测试命令、回滚语义已写入本文件 §4。
- [ ] 不需要读取生产密钥、生产数据库、真实用户数据或另一 agent 的未提交文件。

任一项不成立时，停止进入该任务的代码编辑，先修订文档或向仓库负责人报告。

---

## 2. 并行隔离契约

### 2.1 Worktree / Git 隔离

| 角色 | worktree | branch | 规则 |
| --- | --- | --- | --- |
| P6a 并行开发 | /root/projects/MoNexus-new | feat/p6a-subscription | 本任务绝不在此目录执行 git switch、git add、编辑、format、test 或 migration |
| M3-ISH 安全任务 | /root/projects/monexus-m3-identity-security-hardening | feat/m3-identity-security-hardening | 本任务唯一可写目录 |

当前安全分支从 origin/develop 的 bf25d01 创建，未跟踪远端，避免自动推送或与 P6a 混合。

### 2.2 Runtime / 数据库隔离

| 资源 | M3-ISH 规则 |
| --- | --- |
| Docker / compose | 不在 P6a 目录运行 docker compose up/down/restart；不停止共享容器 |
| 单元/集成数据库 | 仅使用专用 TEST_DATABASE_URL，数据库名为 monexus_m3_ish_test；绝不使用 P6a 或默认 monexus_test |
| 迁移 | 每条 migrate/status/drift 命令都显式传 `DATABASE_URL=$M3_ISH_DATABASE_URL`，且该变量只能指向 `monexus_m3_ish_test`；shadow database 也必须隔离；不得对共享开发库、staging、production 执行 migrate dev/deploy |
| 后端服务 | 若必须手动/E2E 启动，使用独立 PORT=3103 和独立日志；不得占用 3000 |
| 前端服务 | 若必须手动/E2E 启动，使用独立端口 5178；不得占用 5173 |
| E2E | 只在独立 server、独立数据库和独立 browser context 上运行；固定 3103/5178、`reuseExistingServer=false`；禁止 `npm run verify:local(:no-e2e)` 和默认 `npm run e2e`，P6a 正在做端到端测试时不并发抢用共享服务 |

若专用测试数据库或独立端口不可用，先只运行静态/typecheck 单元，不以共享资源为代价抢跑完整验证。

### 2.3 文件 Ownership

| 安全任务可改 | P6a 不可碰 / 安全任务禁止改 |
| --- | --- |
| server/src/modules/auth/** | server/src/modules/orders/** |
| server/src/middlewares/auth.ts | server/src/modules/merchant/** |
| server/src/lib/logger.ts、server/src/config/index.ts | server/src/lib/systemConfig.ts |
| LoginPage、新建 auth 安全子组件、src/api/auth.ts | P6a 当前正在修改的 src/pages/ProfilePage.tsx 及订阅前端/业务 UI |
| 本规格目录、auth README、OpenAPI、auth 运维文档 | P6a migration 与 P6 设计文件 |
| schema.prisma 中 User / RefreshToken / 新 MFA 模型的最小块 | schema.prisma 中 Order / Offer / Subscription 的 P6a 块 |

schema.prisma 是唯一共同文件。安全任务不得重排、格式化或编辑 P6a 相关字段；最终合并前由安全分支 rebase 最新 develop 并人工复核这一文件。ProfilePage 也已成为 P6a 的当前工作文件：M3-ISH 在 P6a 合入前只能新增独立安全组件和 API，不得改挂载点。

### 2.4 Migration 协议

1. P6a 已使用 20260727090000_p6a_subscription_foundation。
2. 安全任务可先在隔离分支生成更晚且唯一的目录；生成后其时间戳必须字典序排在已知 P6a migration 之后。若本机时钟早于其时间戳，可仅为 `prisma migrate dev` 使用受控时区生成名称，并在实施日志记录；不手改 SQL、不重命名 P6a migration。
3. 永不修改、重命名、删除或重新生成 P6a migration。
4. I-01 可由仓库负责人授权在独立 worktree 开始；但 PR 前解除条件固定为：P6a 已进入 `origin/develop` → M3-ISH rebase 成功 → 人工确认两套 migration 与 `User` / `RefreshToken` 块均保留 → 专用库跑 migration/status/drift；四项均有证据后才可开 PR。
5. 如果 P6a 在合并前新增触及 User / RefreshToken 的字段，停止该任务，先更新 Specify/Plan/Tasks 的影响分析。

---

## 3. 三色执行权限

| 等级 | 行为 |
| --- | --- |
| ✅ Always | 在安全 worktree 修改当前任务 Owned files；新增针对性测试；运行专用库测试、typecheck、diff/check；更新当前 spec 包的任务状态与证据 |
| ⚠️ Ask first | 改已有 API URL/成功响应语义；更改 P6a 所拥有文件；迁移出现跨域字段/索引依赖；需要共享端口/数据库；发现 D-01..D-06 必须改变；rebase 有语义冲突 |
| 🚫 Never | 修改 P6a worktree/branch/未提交文件；运行 git reset --hard、git clean、docker compose down；访问/输出生产数据或密钥；写 HTTP MFA bypass；将 secret、TOTP、recovery code、challengeId 写入日志、fixture 或 commit；修改/删除 P6a migration |

---

## 4. 单任务执行卡

每次只允许一个 Implement task 为 In Progress。开始前只读取当前任务所需的全局规则、当前 spec 章节、当前 plan 章节、当前 task 卡和相关代码文件；不要把整个项目或全部文档塞入执行上下文。

| Implement ID | 对应 Tasks | 状态 | 输入 / Owned files | 完成与提交门槛 |
| --- | --- | --- | --- | --- |
| I-00 | T-00 | Done | 本包、AGENTS.md、auth 基线 | 记录基线、隔离资源、决策确认；不改业务代码 |
| I-01 | T-BE-01 | In Progress | schema、config、env example、database-default migration / legacy-admin revoke | 仅在安全 worktree/专用库实施；PR 前满足 §2.4 四项 rebase 条件；migration 必须由 Prisma 生成并经 legacy fixture 验证 |
| I-02 | T-BE-02 | Todo | auth/mfa、security event、logger、原语测试 | 密钥/OTP/challenge/recovery/redact 单测通过；无真实 secret |
| I-03 | T-BE-03 + T-BE-05 | Todo | auth service/controller/schema/routes、auth middleware、admin route、auth tests | admin MFA flow、guard、bcrypt 通过；不改 P6a 文件 |
| I-04 | T-BE-04 | Todo | auth session service/routes/serializer/tests | session family/revoke/replay 通过；owner 404 与脱敏锁定 |
| I-05 | T-FE-01 + T-FE-02 | Blocked by P6a UI ownership | LoginPage、新 auth security components、auth API；P6a 合入/rebase 后才可改 ProfilePage 挂载点 | UI 不持久化秘密；独立端口 smoke / E2E 通过 |
| I-06 | T-QA-01 + T-QA-02 + T-DOC-01 | Todo | tests、OpenAPI、auth README、runbook、checklist | 完整验证、rebase 后 drift、所有 P0 勾选、PR 准备完成 |
| I-07 | T-BE-06 + T-FE-03 | Todo (P1) | MFA security settings、revoke-all API/UI | 不削弱 P0 guard；若纳入 PR 则 P1 checklist 全部有证据，若拆后续则在 PR 明确链接 follow-up |

### 当前任务的标准循环

1. 将当前 I-* 标为 In Progress，并记录 HEAD、worktree、专用测试库名称。
2. 先增加/调整失败测试，精确覆盖 task.md 的验收条件。
3. 在 Owned files 内做最小实现；不得顺手重构。
4. 运行该任务的定向测试、server build、相关前端检查。
5. 按 checklist 自查安全、错误码、越权、并发、日志与秘密泄露。
6. 只暂存本任务文件，创建 focused commit；更新 I-* 和 task.md 状态、写入证据。
7. 下一个任务重新读取对应最小上下文，不能把上一个任务假设带入。

---

## 5. 验证矩阵

| 层级 | 每个相关任务最低检查 | 全波门槛 |
| --- | --- | --- |
| Schema / config | prisma generate、专用库 migration、config guard | migrate status/drift clean |
| Auth | MFA/challenge/recovery/session 定向 vitest | server npm test |
| Guard | admin 旧 token、吊销 session、普通 user/merchant 拒绝 | auth + admin 回归 |
| Frontend | npm run build、秘密不入 persisted store、关键 testid | MFA / sessions Playwright |
| Integration | 专用库、3103/5178、`reuseExistingServer=false` 的 smoke | `npm run verify:m3-identity-security-hardening` 与独立 M3-ISH e2e |
| Documentation | OpenAPI、README、runbook、checklist 证据 | P0 全部勾选 |

验证失败只能修当前任务、修 spec，或明确报告 Blocked；不得删除/放松测试、跳过 migration 或在 P6a 环境中“借跑”。

---

## 6. 变更与合并闸门

| 事件 | 必须动作 |
| --- | --- |
| P6a 合入 develop | 在安全 worktree 只读确认远端状态后 rebase；检查 schema/migrations/config；显式使用专用库跑 migration/status/drift 与 auth 定向测试；未全部通过则不得开 PR |
| P6a 新增 User/RefreshToken 改动 | 停止 I-01/I-03/I-04；更新 spec 影响分析，确认 ownership 后再继续 |
| P6a 修改 LoginPage/ProfilePage | 不改该页面；仅新增无挂载副作用的 auth 组件/API，待其合入后 rebase 再集成 |
| 安全 spec 决策变更 | 先更新 spec → plan → task → implement → checklist，再修改代码 |
| 任意 P0 检查失败 | 保持 PR 不开 / 不合；在 checklist 写证据和修复任务 |
| 准备 PR | 先确认本分支只含 M3-ISH 文件、目标 develop、P6a commit 未被混入；再运行最终验证 |

---

## 7. 实施日志

| 时间 | I-* | 状态 | HEAD / 证据 | 备注 |
| --- | --- | --- | --- | --- |
| 2026-07-27 | I-00 | Done | branch `feat/m3-identity-security-hardening` from `bf25d01`；独立 worktree；Prisma 6.19.3；专用库 `monexus_m3_ish_test`（31 migrations up to date） | `auth/auth-tokens/refresh-token-wiring/auth-active-user` 4 files、36 tests PASS；frontend build 与 server build PASS；未修改业务代码 |
| 2026-07-27 | I-01 | In Progress | 仓库负责人已明确授权在独立 worktree 并行开始；P6a 尚未合入 `develop`，预期 migration 为 `20260727090000_p6a_subscription_foundation` | 1.3 基于专用 PostgreSQL 14 的 `gen_random_uuid()` 验证，采用单一 database-default migration；仍禁止改 P6a worktree/共享运行时 |

---

## 8. 完成条件

只有当 checklist.md 的全部 P0、I-06 的验证矩阵、P6a 合并后的 rebase/drift 复核和发布隔离检查均通过时，状态才能从 In Progress 变为 Ready for Review。
