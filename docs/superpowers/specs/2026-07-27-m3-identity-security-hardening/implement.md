# Implement Protocol: M3 身份与特权操作安全收口

| 字段 | 值 |
| --- | --- |
| 文档 ID | IMPL-M3-ISH-001 |
| 版本 | 1.27.0 |
| 日期 | 2026-07-27 |
| 状态 | I-00 至 I-05 Done (local)；I-06 In Progress（PR #53 CI 收集边界修复），PR / CI / release 仍受最终门禁约束 |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) · [checklist.md](./checklist.md) |
| 方法依据 | [JavaGuide Spec Coding：Specify → Plan → Tasks → Implement](https://javaguide.cn/ai-coding/practices/spec-coding.html) |

---

## 1. Implement 入口门槛

Implement 不是“文档写完就直接编码”。每个任务开始前，执行者必须确认：

- [ ] Specify 已冻结：spec.md 的 D-01 至 D-07 无未决产品/安全决策。
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
| P7b 并行开发 | /root/projects/MoNexus-new | feat/p7b-auto-provision | 本任务绝不在此目录执行 git switch、git add、编辑、format、test 或 migration |
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
| LoginPage、ProfilePage（仅 I-05 挂载）、新建 auth 安全子组件、src/api/auth.ts | P7b worktree / branch / 未提交文件，以及其运行时和数据库资源 |
| 本规格目录、auth README、OpenAPI、auth 运维文档 | P6a migration 与 P6 设计文件 |
| schema.prisma 中 User / RefreshToken / 新 MFA 模型的最小块 | schema.prisma 中 Order / Offer / Subscription 的 P6a 块 |

schema.prisma 是唯一共同文件。安全任务不得重排、格式化或编辑 P6a 相关字段；最终合并前由安全分支 rebase 最新 develop 并人工复核这一文件。ProfilePage 也已成为 P6a 的当前工作文件：M3-ISH 在 P6a 合入前只能新增独立安全组件和 API，不得改挂载点。

**P1 安全例外（I-03）：**当前 P6c 的 `server/src/modules/admin/service.ts` 与 M3 的三处安全边界调用不存在行级重叠；但该文件仍是潜在集成面。仅在 M3 独立 worktree 修改 `banUser`、`approveMerchant`、`suspendMerchant` 的 lock-before-`User`-write 调用及所需 import，不重排 P6 代码、不运行 formatter。P6c 合入 develop 后必须 rebase 并逐段复核此最小 diff；此例外不授权改其他 admin 逻辑。

### 2.4 Migration 协议

1. P6a 已使用 20260727090000_p6a_subscription_foundation。
2. 安全任务可先在隔离分支生成更晚且唯一的目录；生成后其时间戳必须字典序排在已知 P6a migration 之后。Prisma CLI 若以 UTC 忽略受控时区而生成过早目录，只可重命名未提交的 M3-only 目录，逐字保留 migration.sql、记录 hash，并 reset/replay 专用测试库；不手改 SQL、不重命名 P6a migration。
3. 永不修改、重命名、删除或重新生成 P6a migration。
4. I-01 可由仓库负责人授权在独立 worktree 开始；但 PR 前解除条件固定为：P6a 已进入 `origin/develop` → M3-ISH rebase 成功 → 人工确认两套 migration 与 `User` / `RefreshToken` 块均保留 → 专用库跑 migration/status/drift；四项均有证据后才可开 PR。
5. 如果 P6a 在合并前新增触及 User / RefreshToken 的字段，停止该任务，先更新 Specify/Plan/Tasks 的影响分析。

---

## 3. 三色执行权限

| 等级 | 行为 |
| --- | --- |
| ✅ Always | 在安全 worktree 修改当前任务 Owned files；新增针对性测试；运行专用库测试、typecheck、diff/check；更新当前 spec 包的任务状态与证据 |
| ⚠️ Ask first | 改已有 API URL/成功响应语义；更改 P6a 所拥有文件；迁移出现跨域字段/索引依赖；需要共享端口/数据库；发现 D-01..D-07 必须改变；rebase 有语义冲突 |
| 🚫 Never | 修改 P6a worktree/branch/未提交文件；运行 git reset --hard、git clean、docker compose down；访问/输出生产数据或密钥；写 HTTP MFA bypass；将 secret、TOTP、recovery code、challengeId 写入日志、fixture 或 commit；修改/删除 P6a migration |

---

## 4. 单任务执行卡

每次只允许一个 Implement task 为 In Progress。开始前只读取当前任务所需的全局规则、当前 spec 章节、当前 plan 章节、当前 task 卡和相关代码文件；不要把整个项目或全部文档塞入执行上下文。

| Implement ID | 对应 Tasks | 状态 | 输入 / Owned files | 完成与提交门槛 |
| --- | --- | --- | --- | --- |
| I-00 | T-00 | Done | 本包、AGENTS.md、auth 基线 | 记录基线、隔离资源、决策确认；不改业务代码 |
| I-01 | T-BE-01 | Done (local) | schema、config、env example、database-default migration / legacy-admin revoke | `2f212e8`；PR 前仍须满足 G-PR-01 的四项 rebase 条件，任务完成不等于可开 PR |
| I-02 | T-BE-02 | Done (local) | auth/mfa、security event、logger、原语测试 | `2483b0f`；密钥/OTP/challenge/recovery/redact 12 条定向单测与 server build 通过；无真实 secret |
| I-03 | T-BE-04 | Done (local) | auth session service、auth refresh/session boundary、全用户 revoke audit、routes/serializer/tests；P1 仅限 admin service 三处 lock 调用 | `auth-sessions` 11/11、全量后端 65 files / 520 tests（575.53s）、server/root build 均 PASS；二次安全复审无 P0/P1。P6c→develop rebase 仍是 PR 前闸门 |
| I-04 | T-BE-03 + T-BE-05 | Done (local) | auth service/controller/schema/routes、auth middleware、admin route、orders route、announcements controller、auth tests | 已 rebase `origin/develop@4568ee4`；MFA flow、guard、bcrypt、密码变更 challenge 作废、D-04 无 HTTP break-glass、文件取证/公告旁路均完成。75 files / 611 tests、server/root build、38-migration status/drift 通过；I-05 前端 202 流未完成，故不可 PR/合并 |
| I-05 | T-FE-01 + T-FE-02 | Done (local) | LoginPage、ProfilePage、独立 auth security components、auth API、M3 专用 Playwright config | 登录 200/202 union、二维码本地渲染、恢复码确认前不写 store、MFA 失败不 refresh/replay、设备确认吊销；3103/5178 的 UI suite 6/6、双端 build 与 diff check PASS。真实整栈 QA/文档仍归 I-06 |
| I-06 | T-QA-01 + T-QA-02 + T-DOC-01 | In Progress | `playwright.config.ts`、M3 config/real fixture、spec bundle；不得碰 P7b worktree/runtime | PR #53 初次 CI 的默认 E2E 加载了隔离 real fixture、缺少 `M3_ISH_DATABASE_URL`。先将默认 config ignore real spec 的边界写入规格，再补最小 config 修复并重新验证 CI；专用 verifier 既有 76/618 与 10/10 证据保持有效。 |
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
| Integration | 专用库、3103/5178、`reuseExistingServer=false` 的 smoke；config 启动前 DB pathname 拒绝、MFA 秘密不进入失败产物 | `npm run verify:m3-identity-security-hardening` 与独立 M3-ISH e2e |
| Documentation | OpenAPI、README、runbook、checklist 证据 | P0 全部勾选 |

验证失败只能修当前任务、修 spec，或明确报告 Blocked；不得删除/放松测试、跳过 migration 或在 P6a 环境中“借跑”。

---

## 6. 变更与合并闸门

任务的本地 Done 与 PR Ready 是不同状态：在不触碰 P6a owned files 的前提下，G-PR-01 pending 不阻止 I-02/I-03/I-04 的 M3 独立模块实现；它**绝对阻止**开 PR 或把全波标记 Ready for Review。

| 事件 | 必须动作 |
| --- | --- |
| G-PR-01：P6a 合入 develop | 在 M3 安全 worktree rebase；人工确认 P6a/M3 migration 及 `User` / `RefreshToken` 块均保留；专用库重跑 migration/status/drift 与定向 auth 测试。四项证据齐全前不得开 PR |
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
| 2026-07-27 | I-01 | Done (local) | `2f212e8`；`20260727110000_identity_security_hardening`，SQL SHA-256 `d7674f9747f7fdfd32e7272d678f45ce3b9e96d35fd59cbcbfab3c5ec441e55a`；同一专用库 legacy fixture → migration → reset/replay；status 32 up to date / drift no diff；14 targeted tests、server build、62 files / 497 tests（712.46s）PASS | G-PR-01 pending：P6a 尚未进入 `origin/develop`，未 rebase/人工复核，故不可开 PR |
| 2026-07-27 | I-02 | In Progress | HEAD `2f212e8`；T-BE-02 owned files 仅限 auth MFA primitives、security events、logger/redact、原语测试 | 不修改 auth service/controller/routes/middleware、ProfilePage 或 P6a worktree |
| 2026-07-27 | I-02 | Done (local) | `2483b0f`；`otpauth@9.4.1`；专用库 `auth-mfa-crypto` + `auth-security-events`：12/12 PASS；`npm run build` PASS | 只读安全复审已关闭 MFA request-body `code`、pending seed 与测试输出泄露风险；未触碰 auth service/controller/routes/middleware、ProfilePage 或 P6a worktree |
| 2026-07-27 | I-03 | In Progress | HEAD `2483b0f`；仅开始 T-BE-04 的 session service / refresh boundary 只读影响分析 | 仍不得编辑 P6a 文件或启动共享 runtime；G-PR-01 继续阻止 PR |
| 2026-07-27 | I-03 | In Progress | 先新增 `auth-sessions` 红测：sid/rotation、owner/current boundary、revoke-others、replay audit | 红测暴露 explicit session revoke 后旧 cookie 被旧 replay 逻辑全用户吊销；已先同步 D-07/plan/task/checklist 再继续编码 |
| 2026-07-27 | I-03 | In Progress | 只读安全复审发现 token-row reason 无法覆盖 rotation predecessor，且 rotation/revoke 可在 statement snapshot 间漏掉 successor | 已先将文档包升至 1.12.0：以同用户 transaction advisory lock、锁后重读、family terminal marker 优先为唯一实现方案；下一步先写失败测试，未修改 P6a 或启动 runtime |
| 2026-07-27 | I-03 | In Progress | P0 复审进一步确认 global revoke、login/create 与 reset/change 的同一 user ordering 也必须纳入 | 文档包升至 1.13.0：锁协议列出每个 caller、默认 `revoke_all`+audit、登录锁后复核；不新增 migration，不修改 P6 未提交的 `admin/service.ts` |
| 2026-07-27 | I-03 | In Progress | 二次独立复审确认管理员 ban / merchant role 事务仍是“`User` 写锁 → advisory lock”，可与 reset/change 反向死锁 | 在编码前将文档包升至 1.14.0：仅授权独立 worktree 内的三处 admin 调用改为 advisory→`User`；新增真实 PostgreSQL 并发回归，P6c 主工作树、运行时与默认测试库不触碰 |
| 2026-07-27 | I-03 | Done (local) | `auth-sessions` 11/11（含 ban/approve/suspend 的真实 PG lock-order）；`npm test` 65 files / 520 tests PASS（575.53s）；server/root build PASS | 二次独立安全复审无 P0/P1；仅 M3 worktree 与 `monexus_m3_ish_test` 被使用。Focused commit 后保持 G-PR-01 pending，不推送、不建 PR |
| 2026-07-28 | I-04 | In Progress | `d905033`（已 rebase `origin/develop@4568ee4`）；T-BE-03 + T-BE-05 | 仅 M3 独立 worktree 与专用 `monexus_m3_ish_test`；不触碰 P7 或其他 agent 的 worktree/runtime |
| 2026-07-28 | I-04 | In Progress | 密码变更跨越 pre-auth 的安全复核 | 先更新 Specify → Plan → Tasks → Implement → Checklist：管理员成功改密/重置必须在同一锁定事务消费未消费 challenge、递增 `mfaVersion`、再吊销 session；随后以红测实现 |
| 2026-07-28 | I-04 | In Progress | D-04 break-glass implementation gap | 已先同步 Specify → Plan → Tasks → Implement → Checklist：只导出离线原子服务，不新增 HTTP route；清空 seed、作废 recovery/challenge、bump version、revoke session、写受控 caseRef 审计；随后以红测实现 |
| 2026-07-28 | I-04 | In Progress | break-glass seed-residue review | 在最终回归前发现已消费 challenge 的密文不再可用但仍残留；先将规格收紧为同事务置空，再补断言/实现 |
| 2026-07-28 | I-04 | Done (local) | `auth-mfa` 14/14；全量 server 75 files / 611 tests PASS（915.71s）；server/root build PASS；38 migrations status/drift clean | D-04 break-glass、密码变更 pre-auth 失效与非 admin-router MFA 旁路均有回归；未改并行 worktree/runtime。I-05 前端 MFA 流、I-06 docs/QA 尚未完成，故不推送/不开 PR |
| 2026-07-28 | I-05 | In Progress | HEAD `097b4c9`；T-FE-01 + T-FE-02 | P6 已入 develop 且 M3 已 rebase `4568ee4`，故仅在本 worktree 开始 LoginPage / ProfilePage 集成；P7b worktree、branch、未提交文件与运行时资源零触碰。 |
| 2026-07-28 | I-05 | Done (local) | `MfaEnrollment` / `MfaVerification` / `RecoveryCodeConfirmation` / `SessionManager`；M3 独立 Playwright 6/6（3103/5178、专用库）；frontend/server build 与 `git diff --check` PASS | 精确 API-path 测试夹具防止误拦 Vite 模块；验证 recovery/access token 不在确认前持久化、失败因子不 refresh/replay、单/其他会话确认吊销及 320/375px 无横向溢出。仅 M3 worktree/runtime 被使用；I-06 仍阻止 PR。 |
| 2026-07-28 | I-06 | In Progress | HEAD `237ff25`；已先完成 contract 审计并将真实 E2E/runbook 范围同步至 Specify → Plan → Tasks → Implement → Checklist | 仅此 M3 worktree、`monexus_m3_ish_test`、3103/5178；不读取、编辑、测试、格式化或切换 `/root/projects/MoNexus-new`。先实现 runner/real E2E，再更新外部契约文档与全量证据。 |
| 2026-07-28 | I-06 | In Progress | 只读运维审计确认 server startup 已校验 MFA key、但 production preflight 未覆盖且 break-glass 没有安全的命令入口 | 已先同步 Spec → Plan → Tasks → Implement → Checklist：新增无 HTTP CLI 和 canonical-base64-32 preflight；不改变原子 service 或 data model。 |
| 2026-07-28 | I-06 | In Progress | real-E2E 只读复审发现 baseURL/启动前 DB 校验、recovery 一次性、失败产物与单设备 revoke 证据不足 | 已先将文档包升至 1.25.0：冻结精确的 config/context/secret、窗口外 TOTP、recovery、`session-revoke-device`、admin stats 规则；旧版 verifier 已停止，待测试修复后重新全量验证。 |
| 2026-07-28 | I-06 | Done (local) | 单一隔离 verifier exit 0：status/diff、76 files / 618 tests（754.49s）、server/frontend build、staging template preflight、Playwright 10/10（49.4s） | 复审发现均由真实 E2E/config 回归覆盖；错误 DB 启动前拒绝与 break-glass CLI 7/7 已另行定向验证。没有触碰 P7b worktree/runtime；未推送、未开 PR。 |
| 2026-07-28 | I-06 | In Progress | PR #53 CI 默认 Playwright 在收集阶段加载 `m3-identity-security-hardening.real.spec.ts`，因没有 M3 专用 URL 而失败 | 先同步 Specify → Plan → Tasks → Implement → Checklist 到 1.27.0：根 config 仅 ignore real suite，专用 config 继续覆盖 mock + real；随后最小修复、静态发现列表与 CI 重跑。 |

---

## 9. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.6.0 | 2026-07-27 | 只读 auth/session impact review 后，将 session core 调整为 I-03、MFA/guard/bcrypt 调整为 I-04；冻结 `sid`、current logout 和 bcrypt pre-auth 边界 |
| 1.7.0 | 2026-07-27 | 写入 I-01 可复核 migration/fixture/status/drift/targeted-test 证据；明确本地完成不替代 P6a rebase 闸门 |
| 1.8.0 | 2026-07-27 | 记录完整隔离后端回归 62 files / 497 tests PASS（712.46s） |
| 1.9.0 | 2026-07-27 | 将 I-01 标记为本地完成、以 G-PR-01 保留 PR 闸门，并启动唯一 In Progress 的 I-02 |
| 1.10.0 | 2026-07-27 | 标记 I-02 本地完成并启动唯一 In Progress 的 I-03；记录原语、日志脱敏与安全复审证据 |
| 1.11.0 | 2026-07-27 | I-03 红测驱动的 D-07 同步：明确 explicit revoke 与 rotation replay 的实现边界 |
| 1.12.0 | 2026-07-27 | P0 安全复审后，先规范化 I-03 的并发串行化与 family-marker 判定，再进入实现 |
| 1.13.0 | 2026-07-27 | 明确所有 RefreshToken mutation 都受同 user lock 约束，并记录无 migration / 不触碰 P6 admin service 的实施边界 |
| 1.14.0 | 2026-07-27 | P1 并发复审收紧 `User`/session 的全路径锁序；记录 P6c worktree 隔离与仅三处 admin security-call 的最小例外 |
| 1.15.0 | 2026-07-27 | I-03 本地完成：三路径锁序、D-07 session 语义与全量隔离验证已回填；不解除 P6c rebase / PR 闸门 |
| 1.16.0 | 2026-07-28 | P6/P7 已进入 develop 后完成 M3 独立 rebase，启动唯一 In Progress 的 I-04；范围保持为 MFA API、admin guard、bcrypt 与定向测试 |
| 1.17.0 | 2026-07-28 | I-04 编码前的只读安全审计将 orders 文件仲裁取证和 public announcement 的 admin audience 列为非 admin-router 的 admin 专属能力；先同步 spec/plan/task，再以条件 MFA middleware、visitor 降级及无 URL/无 audit 回归收口 |
| 1.18.0 | 2026-07-28 | I-04 实现复核发现密码变更后的 pre-auth challenge 仍可完成 MFA；已先明确同事务 challenge consume、管理员 `mfaVersion` bump 与回归门槛，再继续编码 |
| 1.19.0 | 2026-07-28 | I-04 复核发现 break-glass 仅有安全事件类型但缺服务实现；已先冻结无 HTTP 路由的原子操作与完整凭证作废边界，再继续编码 |
| 1.20.0 | 2026-07-28 | break-glass 残留审计将 pending challenge 密文纳入清空范围；完成前必须由回归验证 |
| 1.21.0 | 2026-07-28 | P6→develop rebase 已满足，解除 I-05 的旧 ProfilePage ownership 阻塞并启动唯一 In Progress 的 I-05；记录 P7b 的 worktree/runtime 零干扰边界。 |
| 1.22.0 | 2026-07-28 | I-05 本地完成并回填行为、隔离 UI suite、双端构建与 diff-check 证据；不把 mock-based UI suite 误记为 I-06 的真实整栈 AC-08。 |
| 1.23.0 | 2026-07-28 | I-06 在编码前完成 Specify → Plan → Tasks → Implement → Checklist 同步：冻结专用 runner、real E2E fixture/cleanup 和文档契约审计范围。 |
| 1.24.0 | 2026-07-28 | I-06 运维审计后先冻结离线 break-glass CLI 与 MFA key preflight 的 implementation contract，再进入相应代码编辑。 |
| 1.25.0 | 2026-07-28 | I-06 real-E2E 复审后先冻结早期 DB 防护、显式 context baseURL、无秘密失败产物、确定性 TOTP/recovery、精确单设备 revoke 与真实 admin API 断言，再进入测试修复。 |
| 1.26.0 | 2026-07-28 | I-06 本地交付完成并回填单一专用 verifier 证据；保留 PR/CI/release 门槛，未将本地绿误记为上线批准。 |
| 1.27.0 | 2026-07-28 | PR #53 CI 发现默认 E2E 与隔离 real fixture 边界缺口；I-06 恢复为 In Progress，先冻结根 config ignore 规则再修复与重跑。 |

---

## 8. 完成条件

只有当 checklist.md 的全部 P0、I-06 的验证矩阵、P6a 合并后的 rebase/drift 复核和发布隔离检查均通过时，状态才能从 In Progress 变为 Ready for Review。
