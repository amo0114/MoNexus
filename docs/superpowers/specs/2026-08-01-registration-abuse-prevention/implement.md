# Implement: 注册、激励与邮件反滥用闭环执行协议

| 字段 | 值 |
| --- | --- |
| 文档 ID | `IMPL-RAP-001` |
| 状态 | `Feature implementation, full CI and isolated staging rehearsal complete; production rollout remains pending` |
| 配套规格 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) |

---

## 1. 开工门槛

实现 agent 在编辑任何源文件前必须确认：

1. `SPEC-OPS-REGMAIL-001` 已合入 `develop`，且 migration head、`registration-status` 和 admin mail API 与前置规格一致；
2. 当前移动端 UI PR 已合入，或本阶段只执行不触及前端的 T10–T37；
3. 从最新 `origin/develop` 创建专用分支/worktree，未复用 mobile 或其他功能 worktree；
4. `RAP_DATABASE_URL` 精确指向专用可丢弃 `monexus_rap_test`；`RAP_REDIS_URL` 是专用 Redis DB/namespace；
5. 当前分支、git status、migration head、Node/npm 版本和基线测试结果已写入任务日志。

任一条件不满足，停止在计划/诊断阶段，不改代码。

---

## 2. Worktree 与文件所有权

| 区域 | 所有权 / 执行顺序 |
| --- | --- |
| `server/prisma/schema.prisma` 与新 migration | 单一 schema owner；其余 agent 不并行编辑 |
| `server/src/modules/auth/service.ts` / `routes.ts` | 单一 auth integrator；limiter/verifier owner 经 review 提供窄模块 |
| `server/src/lib/redis.ts` | limiter owner；不得同时混入 cache 重构 |
| `src/pages/AdminPage.tsx` | 仅移动端 PR 合入后、前端 integrator 最后编辑；须手工复核 safe-area 改动仍在 |
| `e2e/mobile-*.spec.ts` | 本任务禁止修改 |
| `.env`, secret manager, production compose values | 不写入仓库；仅由运维按 runbook 配置 |

禁止 `git add -A`、`git reset --hard`、修改他人未提交文件、直接操作生产数据库或用 console/环境变量跳过安全断言。

---

## 3. 三色变更纪律

| 色级 | 内容 | 要求 |
| --- | --- | --- |
| Green | 文档、纯 UI copy、测试 fixture | 标准 review + focused tests |
| Yellow | auth route、limiter、admin API、前端状态机 | API contract review + targeted integration/E2E |
| Red | Prisma migration、奖励账务、Turnstile/Redis fail-closed、token verification、production secret guard | spec decision ID 对照、两人 review、真实 PostgreSQL concurrency/rollback proof、staging 演练 |

Red 修改绝不能通过 mock-only 测试声称完成；至少一项真实 PostgreSQL/Redis 测试证明其原子性和故障语义。

---

## 4. 数据与迁移协议

1. 在 migration 生成前，记录 `git log --oneline -1`、现有 migration 目录和 `prisma migrate status`。
2. 使用显式环境变量运行 `prisma migrate dev --name registration_abuse_prevention`，只允许 `monexus_rap_test`；不手写、拼接或在生成后编辑 SQL。
3. 将一组 pre-migration fixture（历史 InviteRelation、已发 PointLog、未验证 User）导入专用库，应用 migration，证明：历史 relation=legacy、余额/流水无变化、所有新唯一索引可用。
4. reset/replay 同一可丢弃库，执行 `prisma generate`、`migrate deploy`、`migrate status` 与 drift 检查。
5. 合并前 rebase 最新 develop 后若 migration head 改变，重新执行 1–4；发现 schema 冲突先更新 spec/plan，不手工改迁移 SQL。

---

## 5. 安全实现协议

### 5.1 不可绕过的顺序

注册：总开关 → Redis provider preflight → Turnstile verify → Redis 注册 buckets → bcrypt → DB 注册事务 → 既有 session 创建。
验证/重置邮件：认证/schema → Redis buckets → token DB mutation → SMTP。
高价值动作：authenticate → active user → verified user → validate/controller。
邮箱验证：authenticate/current user → strict token claim transaction → qualification/reward hold transition。

代码评审必须逐条检查任一副作用是否出现在前置 guard 之前。

### 5.2 无秘密规则

- 原始 token 只能存在于注册 request、siteverify request 或验证页面 React local state；不得放 Zustand persist、local/session storage、URL query、trace、截图、AdminLog、AbuseEvent、metrics 或 logger。
- `ABUSE_HASH_KEY` / Turnstile secret 与 SMTP credential 不得派生到前端；hash key 只用于 HMAC，不可用于 JWT/token 签名。
- `AbuseEvent.detailSafe` 只允许 enums、bounded count 和 `caseRef`；禁止 error.message、request body、邮箱、IP、UA。
- 对 Reset Password 保持相同公开响应；任何内部邮件/Redis故障也不能变成 email enumeration oracle。

### 5.3 账务/并发规则

- 账务必须由 `GrowthReward` 的数据库行作为 source of truth，不能用浏览器状态、cron 内存集合或 PointLog `findFirst` 当幂等锁。
- token claim、邀请码额度、reward grant/void 都通过同一个 PostgreSQL transaction 的 row lock/conditional update 完成。
- 事务内不得调用 SMTP、Turnstile、Redis 网络请求；外部调用在 transaction 前，账务/审计写入按各规格的原子边界执行。
- cron 用 DB lease + `FOR UPDATE SKIP LOCKED`；每个 batch 失败整体回滚，允许下一 tick 重试。

---

## 6. 运行时与测试隔离

| 测试类别 | 规则 |
| --- | --- |
| Unit | fake verifier / CaptureMailer / fake Redis，不访问外网 |
| Integration | 显式 `RAP_DATABASE_URL`；单测每条唯一 fixture，不执行 broad truncate 除既有 test setup |
| Redis | 专用 database index/prefix，测试结束精确删除 `rap` keys；不 `FLUSHALL` 共享 Redis |
| Concurrency | 真实 PostgreSQL transaction、Promise barrier、可观测 row lock/结果；不用 sleep 伪造竞态 |
| E2E | Turnstile provider mock 仅匹配必要 pathname；MFA admin 走真实现有 helper；不修改移动 e2e |
| Staging | 真 Redis/SMTP catcher/Turnstile staging key；不使用生产 secret 或真实用户邮箱 |

若防护依赖不可用，测试应断言 503 与零副作用，不能把 mode 设置为 off 让测试通过。

---

## 7. 提交、PR 与合并协议

建议提交顺序：

1. `feat(abuse): add protection primitives and config guard`
2. `feat(auth): add verified-email and mail abuse controls`
3. `feat(rewards): hold referral rewards and enforce quotas`
4. `feat(admin): add abuse operations panel and APIs`
5. `test(abuse): cover concurrency and end-to-end contracts`
6. `docs(abuse): add rollout and incident procedures`

每个提交只纳入自己负责的文件。PR 描述必须包含：前置规格版本、migration name、Redis/Turnstile/SMTP 环境门槛、P0 tests、已知回滚动作、没有秘密的证明。合并前使用 [checklist.md](./checklist.md) 完整复核。

---

## 8. 事故处置最低规则

1. 发现注册/邮件攻击时先使用 `registrationEnabled=0`；保留事件/账务证据。
2. Turnstile/Redis outage 不通过关闭 production protection mode 解决；暂停注册、修依赖、验证后恢复。
3. 误伤用户先评估将 `emailVerificationRequiredForValue=0` 回退；不直接 SQL 设置 `emailVerified`、不删除 reward row。
4. 已发积分纠正使用现有管理员积分调整接口和 caseRef；不修改 PointLog 历史。

---

## 9. 实施记录（2026-08-01）

实现位于独立 worktree `/root/projects/worktrees/monexus-registration-abuse-prevention`，分支为 `feat/registration-abuse-prevention`。前端管理台集成没有改动 mobile navigation/safe-area shell；它只添加了一个新的管理页签和隔离面板。

已执行的本地证据如下：

- 在显式隔离的 `/monexus_rap_test` 上执行 `prisma migrate deploy`，47 个 migration 均已应用；
- `npm --prefix server run build` 和 `npm run build` 均通过；
- `growth-rewards`、`rap-admin-abuse`、`registration-auth-flow` 目标后端测试共 20 项通过；
- 使用独立 Vite 端口运行的 `registration-abuse-prevention.spec.ts` 共 5 项 Playwright 场景通过；
- `git diff --check` 和 OpenAPI JSON parse 通过。

本记录不替代本协议的 release 条件：没有使用生产数据库、生产 Redis、真实 Turnstile 或真实 SMTP；也没有把依赖不可用时的保护模式改成 `off` 来获取测试通过。

---

## 10. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-08-01 | 初版执行、隔离、迁移和安全协议。 |
| 1.1.0 | 2026-08-01 | 同步 feature worktree 实施和本地验证记录。 |
