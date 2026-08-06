# develop 全仓代码健康审计（2026-08-01）

> 2026-08-06 状态更新：第 1-15 节保留 2026-08-01 的原始审计口径和证据，
> 本节单独记录基于 `origin/develop` `d89e8946e88f3c4d3ba3901a8431d12817376fad`
> 的后续复核与处理结果，避免把历史状态误读为当前状态。

## 0. 2026-08-06 后续复核与处理

### 原审计 findings 状态

| ID | 当前状态 | 处理证据 |
| --- | --- | --- |
| AUD-2026-08-01-01 | 已修复，待合入 | `fix/issue-91-maintenance` 的 `3ed067d` 为 `verify-local.sh` 默认传入可覆盖的 `API_RATE_LIMIT_MAX=3000`；`bash -n` 通过。 |
| AUD-2026-08-01-02 | 已在 `develop` 修复 | `68a4805` 引入用户级锁和带 `userId`、`used=false`、有效期谓词的原子 `updateMany` claim，覆盖并发消费与跨账号 token 使用；旧的本地修复分支已删除。 |
| AUD-2026-08-01-03 | 已修复，待合入 | `fix/password-reset-mail-consistency` 的 `e011367` 使用“不可用候选 token -> SMTP 成功 -> 用户锁内激活并废止旧 token”的两阶段切换；SMTP 失败时旧链接仍有效。 |

密码重置修复保留统一 HTTP 200 契约，避免通过 SMTP 失败差异枚举账号；日志只记录有限错误分类，不记录 provider 原始错误或 token。专项验证为 2 个测试文件、25 个测试全部通过，Node 20 后端 TypeScript 构建通过。

### Issue #91 WIP 复核

- `agent-a760fc95c65ec0179`：30 个 tracked 修改中 19 个已与当前 `develop` 相同；邀请码源码已由 `#77` 合入。剩余 Turnstile `T8b` 规格明确要求实施前审批，且缺少配套前端，因此未擅自合入。
- `feat/rap-auth-integration`：管理接口、奖励 cron、奖励状态机与测试已由 `#67` / `#77` 的后续实现覆盖。唯一仍有必要的差异是按 `createdAt` 清理 `AbuseEvent` 时缺少单列索引。
- 索引已在 `fix/issue-91-maintenance` 的 `3aa72cd` 中补入 Prisma schema 和第 52 个迁移。Prisma validate 通过，迁移历史与 schema 的 diff 为空，可丢弃测试库部署成功，数据库中已验证为 btree `AbuseEvent_createdAt_idx`。
- 反滥用留存、奖励和管理专项验证为 3 个测试文件、17 个测试全部通过。

### 清理与恢复边界

- 清理前快照位于 `/root/projects/MoNexus-issue-91-backup-20260806`；`repository.bundle` 包含快照时全部 42 个 refs 和完整历史，6 棵 dirty worktree 的文件副本已保存，只有可重建的 `node_modules` 被排除。
- 复核并移除了已合并或被后续实现覆盖的 agent、RAP、邮箱验证、Compose 和 release worktree/本地分支。
- 删除了 5 个已被 `develop` / `master` 等价提交覆盖的远程 Compose/release 分支；远程现只保留 `develop`、`master` 和 `HEAD`。
- 未合入 Turnstile `T8b`，未删除密码重置、维护、审计或正在独立开发的对象存储分支。

## 1. 结论摘要

本次审计基于 `develop` 的 `236950dc0cd7eaf23524984923653392f6de2d79`，在独立分支 `audit/monexus-develop-20260801` 和独立 worktree 中完成。工作开始时工作树干净；未修改、stash、reset 或清理其他 worktree 的用户内容，也未 push、merge 或创建 PR。

在订单、积分、库存、交付、结算、认证、权限、上传、Webhook、FakaBridge、数据库迁移、前端会话恢复与 CI/本地门禁中，没有确认新的 P0/P1 缺陷。因此本次没有自动修改业务代码，也没有为了凑数降低严重程度或证据标准。

确认了 3 个 P2：本地全量验证脚本稳定触发全局 API 限流；邮箱验证令牌可在并发请求中被消费两次；密码重置邮件发送失败会提前烧毁旧链接并留下用户未收到的新有效令牌。另记录 3 项 P3/Hardening，以及本地组合门禁的 PostgreSQL 端口隔离问题。

审计内容 HEAD（报告提交前）仍为基线 `236950dc0cd7eaf23524984923653392f6de2d79`；最终分支 HEAD 与报告提交 SHA 以最终 handoff 中的 `git rev-parse HEAD` / `git log` 为准。没有代码修复提交。

## 2. 基线与 Git 安全边界

| 项目 | 结果 |
| --- | --- |
| 来源分支 | `origin/develop` |
| develop 基线 | `236950dc0cd7eaf23524984923653392f6de2d79` |
| 基线提交 | `test(dashboard): 本月造数显式钉进当月窗口，修复月初 daysAgo 越界 (#66)` |
| 审计分支 | `audit/monexus-develop-20260801` |
| 独立 worktree | `/root/projects/worktrees/monexus-develop-audit-20260801` |
| 本地 `develop` ref | `4568ee4ab5a6f3b2e9ca3c13bb47963555da9932`（落后于 `origin/develop`，不作为审计比较基线） |
| 创建时状态 | 干净 |
| 远程写入 | 无 |
| 历史改写 | 无 |
| 其他 worktree | 未触碰；主 worktree 的未跟踪 RAP 规格目录保持原状 |

开始时记录的最近提交：

```text
236950d test(dashboard): 本月造数显式钉进当月窗口，修复月初 daysAgo 越界 (#66)
83c23d5 feat(auth,admin): 注册开关与邮件投递运营面后端（SPEC-OPS-REGMAIL-001 阶段 A） (#65)
09d9fb9 test: prevent dashboard fixture month rollover (#64)
1f8b38c feat(mobile): mobile-native UI — island nav, 2-col store, sheet dialogs, role tab bar (#63)
0fa90c8 chore(ci): sync production hotfixes to develop
```

## 3. 架构与目录健康度

仓库边界总体清晰，结构可继续维护：

- 根目录是 Vite/React 前端和部署入口；`src/` 按页面、组件、API、store、类型拆分。
- `server/` 是独立 Node/Express/Prisma 后端，`server/src/modules/` 以业务域组织，公共安全与基础设施能力位于 `lib/`、`middlewares/`、`config/`。
- `server/prisma/` 同时保存 schema、迁移与 seed；46 个迁移可从空 PostgreSQL 数据库顺序部署。
- `e2e/`、`server/src/__tests__/` 和少量模块内测试覆盖 HTTP、服务层、并发、数据库约束和外部集成边界。
- `docs/specs/`、`docs/operations/`、`docs/api/`、模块 README 与 `.github/workflows/` 对设计、运维和 CI 责任分层明确。

主要结构性债务不是立即 Bug：

- `server/src/modules/admin/service.ts` 2268 行、`merchant/service.ts` 1597 行、`auth/service.ts` 1141 行、`orders/service.ts` 1001 行。域边界仍清楚，但文件已大到增加评审遗漏和冲突概率，建议以后按用例族拆 service，不做一次性全仓重构。
- 后端测试既集中在 `server/src/__tests__/`，又有模块内 `*.test.ts`；运行规则能覆盖二者，但贡献者不容易预判测试应放哪一处。
- 仓库没有独立 lint 脚本；当前静态门禁主要依赖 TypeScript build、Vitest 和前端 build。

## 4. 核心业务不变量与实现证据

### 4.1 积分、订单、库存、交付和结算

- 积分与佣金均为整数模型；价格、积分余额、冻结余额和 PointLog 使用整数。
- 即时订单通过带余额谓词的 `PointAccount.updateMany` 原子扣减；人工服务通过同一行原子地把可用积分移入 `frozenBalance`。
- 订单创建、积分变化、PointLog、库存领取/扣减、DeliveryRecord、Settlement 和幂等完成均在同一 Prisma 事务内。
- 卡密库存通过 `UPDATE ... WHERE id=(SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` 单语句领取；限量服务通过 `stock > 0` 条件更新防超卖。
- 订单状态使用比较并交换（旧状态进入更新谓词）；关闭、退款、争议、商家拒单和自动履约不会在并发状态变化后重复结算。
- 退款先认领 `pending/holding` Settlement，已结算记录拒绝自动退款；库存报废/回补、销量净减、积分退还与结算作废同事务。
- 续费链在原订单行上 `FOR UPDATE`，避免同一链尾并发续费；退款与续费使用一致锁序。
- `IdempotencyRecord(userId,key)`、请求 HMAC 指纹和 claim lease 保证携带 `Idempotency-Key` 的同一意图最多产生一张订单。

### 4.2 身份认证与权限

- Refresh Token 只存 SHA-256 摘要，按设备 family 轮换；旧令牌重放会撤销用户全部 session，并写安全事件。
- 登录、刷新、登出、单 session 撤销、全部撤销、密码变更和角色变更通过用户级 advisory lock 串行化。
- 管理员密码只创建 MFA challenge；通过 TOTP/恢复码后才创建 refresh family。管理员能力同时检查数据库中的当前角色、状态、MFA 开关/版本和活跃 session。
- 商家路由统一要求认证、活跃用户、JWT 商家角色和活跃 Merchant 行；商家查询/写入以 `merchantId` 归属校验。
- 封禁、商家批准/停用和密码变化会撤销 refresh session；管理员访问令牌还受当前数据库状态和 MFA 版本约束。
- 密码重置令牌单次 claim 使用条件更新；密码改变、其他重置链接失效、MFA challenge 失效和 refresh session 撤销在同一用户锁事务内。

### 4.3 文件、Webhook 和外部桥接

- 图片上传限制 5 MB，并校验客户端 MIME 与 PNG/JPEG/WebP/GIF magic bytes 一致。
- 私有交付文件流式计量与哈希；对象键由 SHA-256 和安全扩展名组成，响应不返回存储键。下载发放按买家/商家/管理员矩阵授权，并记录审计。
- Merchant Webhook 密钥 AES-256-GCM 加密落库；外呼签名绑定原始 JSON 字符串和时间戳。
- Merchant Webhook 的 URL 校验、DNS 解析和 socket lookup 钉扎阻止私网、回环和 DNS rebinding；不跟随重定向，限制响应体和总时钟。
- 自动履约使用 transactional outbox、任务租约、`SKIP LOCKED`、dispatch 前生命周期 gate 和结果 CAS；HTTP 不在数据库事务内。
- FakaBridge 是平台配置而非商家/买家输入；使用 HMAC、响应订单号绑定、响应体上限、总时钟和生产环境 HTTPS/不安全开关启动守卫。

## 5. 已执行命令与结果

运行时统一为 Node `20.19.5`、npm `10.8.2`。仓库的 runtime guard 会拒绝不受支持的 Node 版本。

| 命令/验证 | 结果 |
| --- | --- |
| `npm ci` | 通过 |
| `npm --prefix server ci` | 通过 |
| `npm --prefix server run db:generate` | 通过 |
| `npm --prefix server run build` | 通过，TypeScript 零错误 |
| `npm run build` | 通过；仅有既有的约 757 KB 主 chunk 和 `src/api/auth.ts` 静态/动态混合导入警告 |
| `TEST_DATABASE_URL=... API_RATE_LIMIT_MAX=3000 npm --prefix server test` | 通过：95 files、801 tests、约 1152 秒 |
| 最终复核：`auth-tokens.test.ts` + `auth-sessions.test.ts` | 通过：2 files、27 tests |
| 最终复核：后端 build + 前端 build | 均再次通过；前端仍只有上述既有 warning |
| 46 个迁移部署到现有 `monexus_test` | 无待执行迁移 |
| 46 个迁移部署到新建空库 `monexus_audit_20260801` | 全部按序成功；验证后仅删除本次创建的临时数据库 |
| `npm run verify:local:no-e2e` | 环境阻塞于 `docker compose up -d postgres`：宿主 `127.0.0.1:5432` 已被 PostgreSQL 占用，Compose 服务强制发布 `5432:5432` |
| 默认限流独立复现 | 第 301 个 `/api/_audit-rate-probe` 返回 429 |
| 邮箱验证并发复现 | 同一 raw token 并发两次：`fulfilled=2, rejected=0` |
| 密码重置 SMTP 失败复现 | 请求 rejected；旧 token `used=true`；留下 1 个用户未收到的 active token |

本地门禁尝试曾重建 `monexus-db` 容器；没有删除数据卷。随后使用原 `monexus-new_pgdata` 数据卷恢复同名容器，目前容器 healthy 且不发布宿主端口。

结束检查按任务要求执行了 `git diff --stat develop...HEAD` 和 `git log develop..HEAD`。因为本地 `develop` ref 停在 `4568ee4`，该比较会混入基线之后已经合入远端的 202 个文件，不代表本审计分支新增内容；权威比较使用固定 SHA / `origin/develop`，结果只有本报告。`git diff --check develop...HEAD` 同理命中旧区间内既有文档尾随空格；固定基线到 HEAD 的新增报告通过 `git diff --check`。

## 6. Findings 总表

| ID | 严重度 | 类型 | 置信度 | 状态 |
| --- | --- | --- | --- | --- |
| AUD-2026-08-01-01 | P2 | Reliability Defect | 高 | Confirmed，未修复 |
| AUD-2026-08-01-02 | P2 | Security Defect | 高 | Confirmed，未修复 |
| AUD-2026-08-01-03 | P2 | Reliability Defect | 高 | Confirmed，未修复 |
| AUD-2026-08-01-04 | P3 | Hardening | 高 | 未修复，需 API 兼容决策 |
| AUD-2026-08-01-05 | P3 | Hardening | 高 | 未修复，维护性建议 |
| AUD-2026-08-01-06 | P3 | Test Gap | 中 | 未修复，需 CI 时长证据 |

数量：P0 = 0，P1 = 0，P2 = 3，P3 = 3。

## 7. Confirmed Findings

### AUD-2026-08-01-01：本地全量门禁在默认配置下稳定被全局 API 限流击穿

- 严重程度：P2
- 类型：Reliability Defect
- 置信度：高
- 位置：`scripts/verify-local.sh:66-67`、`server/src/app.ts:38-49,81`、`server/vitest.config.ts:14-16`、`server/src/config/index.ts:67`
- 被破坏的不变量：仓库提供的本地验证命令应能在其自行建立的标准测试环境中完成，而不是因测试流量触发生产型限流器。
- 可达路径：`npm run verify:local:no-e2e` → `scripts/verify-local.sh` → `npm test` → Vitest `singleFork` 复用同一 `app` → `/api` 全局内存 limiter 累计请求。
- 根因：脚本只传入 `TEST_DATABASE_URL`，没有传 `API_RATE_LIMIT_MAX=3000`。默认上限是 300/15 分钟，而全量测试在一个 fork 内执行 801 个测试，HTTP 请求数超过 300。
- 最小复现：在未设置 `API_RATE_LIMIT_MAX` 的 Node 20 test 环境中，对同一 `app` 连续请求 301 次 `/api/_audit-rate-probe`。
- 实际证据：`{"request":301,"status":429}`。
- 实际影响：本地开发者按 README/脚本执行标准门禁时会得到大面积无关 429；失败与测试顺序和此前请求数量相关，掩盖真实回归。
- 最小修复方向：在 `verify-local.sh` 的后端测试子进程显式传入 `API_RATE_LIMIT_MAX=${API_RATE_LIMIT_MAX:-3000}`，与 CI backend/E2E 和 Playwright 配置一致；不要在生产代码中跳过 test 环境限流。
- 回归测试：脚本级 shell 测试或在 CI 中执行 `RUN_E2E=false` 门禁；另保留一个小测试确认默认 300 限制仍对正常运行时生效。
- API/migration/产品决策：无。
- 自动修复：否；严重度低于任务允许的 P0/P1 自动修复边界。

### AUD-2026-08-01-02：同一邮箱验证令牌可被并发成功消费两次

- 严重程度：P2
- 类型：Security Defect
- 置信度：高
- 位置：`server/src/modules/auth/service.ts:1122-1140`
- 被破坏的不变量：邮箱验证令牌必须是单次、不可重放凭证。
- 可达路径：公开 `GET /api/auth/verify-email?token=...` → `verifyEmailWithToken` → 事务外读取 `used=false` → 事务内无条件更新 User 和 token。
- 根因：`used`/`expiresAt` 只在事务前检查；事务内 `emailVerificationToken.update({ where: { id } })` 没有 `used=false` 条件 claim，也没有用户级锁。两个请求可同时通过旧快照，然后依次把同一行写为 `used=true`。
- 最小复现：插入一条未使用令牌，同时执行两次 `verifyEmailWithToken(rawToken)`。
- 实际证据：`{"fulfilled":2,"rejected":0}`。
- 实际影响：当前副作用只是把同一用户的 `emailVerified` 写成两个相近时间，未产生权限提升或跨用户影响；但单次凭证语义被破坏，也没有可靠的重放审计边界，因此定为 P2 而非 P1。
- 最小修复方向：事务内先用 `updateMany({ id, tokenHash, used:false, expiresAt:{gt:now} })` 原子 claim，`count !== 1` 时返回已使用/过期；claim 成功后再更新 User。也可同时作废该用户其他验证令牌。
- 回归测试：并发两次验证必须恰好一次成功；过期/已使用令牌不更新 `emailVerified`。
- API/migration/产品决策：无。
- 自动修复：否；严重度低于任务允许的 P0/P1 自动修复边界。

### AUD-2026-08-01-03：密码重置邮件发送失败会提前烧毁旧链接

- 严重程度：P2
- 类型：Reliability Defect
- 置信度：高
- 位置：`server/src/modules/auth/service.ts:972-1002`
- 被破坏的不变量：外部邮件依赖失败不应让用户丢失仍有效的密码恢复凭证，或留下无法送达却被数据库视为有效的唯一凭证。
- 可达路径：公开 `POST /api/auth/forgot-password` → 查用户 → 事务中作废全部旧令牌并创建新令牌 → 事务提交 → SMTP `send`。
- 根因：数据库凭证轮换先于不可回滚的外部发送；发送失败没有补偿，也没有 outbox/投递状态。
- 最小复现：用户已有一条未过期旧 token；把 Mailer 替换为抛错实现；调用 `requestPasswordReset(email)`。
- 实际证据：`{"request":"rejected","oldTokenUsed":true,"activeUnsentTokens":1}`。
- 实际影响：SMTP 短暂故障期间，用户手上的旧链接立即失效，新链接从未送达；用户只能再次请求并依赖后续邮件成功。不会更改密码或泄露凭证，因此为 P2。
- 最小修复方向：采用事务型邮件 outbox；或先创建 pending token/outbox、发送成功后原子激活并作废旧 token。不要在 SMTP 调用前使旧凭证不可用。
- 回归测试：发送失败后旧 token 仍可使用，或数据库中不存在 active-but-unsent token；成功发送后仅新 token 有效。
- API/migration/产品决策：可靠 outbox 方案通常需要非破坏性 migration；在本任务中禁止自动扩展数据模型。
- 自动修复：否；严重度低于 P0/P1，且完整修复可能涉及数据模型。

## 8. P3 / Hardening / Test Gaps

### AUD-2026-08-01-04：订单幂等头仍为可选兼容路径

- 类型：Hardening，P3，高置信度。
- 位置：`server/src/modules/orders/controller.ts:9-25`、`server/src/modules/orders/README.md:40-52`。
- 证据：没有 `Idempotency-Key` 时服务明确按旧行为下单；重复请求可以产生多张合法订单和多次扣分。当前前端始终发送 UUID，因此不是已确认的产品客户端 Bug。
- 建议：在旧客户端淘汰窗口结束后，把头升级为公开 API 必填；这会改变 API 契约，需要版本/兼容决策，不能在本次自动修改。

### AUD-2026-08-01-05：核心 service 文件过大

- 类型：Hardening，P3，高置信度。
- 证据：四个核心 service 合计 6007 行，其中 admin 2268 行。
- 影响：提高所有权边界遗漏、锁序回归和多人改动冲突的概率，但当前没有由文件长度直接证明的运行时缺陷。
- 建议：按“用户/商家管理、结算、Faka 运维、文件治理”等用例族渐进拆分；每次拆分保持 API、事务边界和测试不变。

### AUD-2026-08-01-06：backend CI 的 15 分钟上限可能不足

- 类型：Test Gap，P3，中置信度。
- 位置：`.github/workflows/ci.yml:88-100`。
- 证据：本机 Node 20 全量后端测试约 1152 秒（约 19.2 分钟），超过 backend job 的 `timeout-minutes: 15`。
- 限制：不同 GitHub runner/数据库性能可能更快；本次未访问远程 Actions 运行历史，因此不能报告为 Confirmed CI Bug。
- 建议：查看最近 10 次 backend job 时长；如 P95 接近 15 分钟，先定位最慢套件和共享数据库清理成本，再决定分片或提高上限。

## 9. 已确认但未修复 / 已修复

### 已确认并修复

无。未发现满足“P0/P1 + 稳定复现 + 局部修复 + 不改变契约/模型”的问题。

### 已确认但未修复

- AUD-2026-08-01-01：P2，本地门禁限流。
- AUD-2026-08-01-02：P2，邮箱验证并发重放。
- AUD-2026-08-01-03：P2，密码重置邮件失败烧毁旧链接。

没有业务代码修复 commit。报告自身使用独立 docs commit，不计入“最多两个 P0/P1 修复批次”。

## 10. 环境阻塞与未能验证区域

### 环境阻塞

- `npm run verify:local:no-e2e` 的 Compose PostgreSQL 固定发布宿主 5432，与已有宿主 PostgreSQL 冲突。脚本还固定检查容器名 `monexus-db`，隔离复用能力有限。
- 因同一阻塞，未直接完成 `npm run verify:local` 组合门禁；没有无变化重试。

### 未能完全验证

- 浏览器 E2E 没有在本次审计 worktree 里完整运行；前后端 build 与后端 801 tests 已覆盖主要代码路径。
- 未使用真实生产 SMTP、S3/MinIO、Redis、Merchant Webhook 接收端或 Xboard/Faka 服务；结论基于本地实现、mock/集成测试和配置启动守卫。
- 未操作生产数据库、远程服务器、GitHub Actions 或远程分支。
- 没有做依赖漏洞在线查询；本次审计不引入依赖变更。

## 11. 高置信度但尚未完全验证

- backend CI 15 分钟超时风险（AUD-2026-08-01-06），需要远程历史时长确认。
- 多浏览器标签页的刷新协调依赖 Web Locks；不支持 Web Locks 的浏览器退化为每标签页内 single-flight。代码具备终止错误登出保护，但真实目标浏览器矩阵下的跨标签压力未执行。
- `verify-local.sh` 的固定 Compose 服务/容器名在并行 worktree、多项目或已有本地 PostgreSQL 环境中容易冲突；本次已实际命中端口问题，但是否改成动态端口/项目名属于开发基础设施设计。

## 12. 推荐后续修复批次

1. 小型 P2 工具链 PR：只修 `verify-local.sh` 的 `API_RATE_LIMIT_MAX` 透传，并增加脚本门禁测试；可同时讨论但不要顺手重写 Compose 隔离。
2. 小型 P2 认证 PR：邮箱验证采用事务内条件 claim，加入并发回归。
3. 独立 P2 设计/实现：为密码重置邮件引入可靠 outbox 或 token 激活状态；先确认数据模型与失败语义。
4. CI 维护：核对 backend job P95 时长，再做测试分片/清理优化或调整 timeout。
5. 渐进式服务拆分：仅在后续功能触碰相应域时拆，不做纯结构大爆炸重构。

## 13. API、数据库和配置变化

本审计分支没有业务代码、公开 API、Prisma schema、migration 或运行时配置变化。仅新增本报告。

建议项中：

- AUD-01 只需脚本配置变化。
- AUD-02 可不改 API/数据库。
- AUD-03 的可靠 outbox 方案可能需要非破坏性 migration。
- 强制 `Idempotency-Key` 会改变公开 API 契约，必须单独决策。

## 14. 是否具备创建 PR 的条件

从代码基线看，后端 build、95 files / 801 tests、前端 build和空库迁移均通过，且没有确认 P0/P1。审计分支本身只增加报告，可以提交供人工审阅。

不过不建议把本报告当成“所有门禁完整通过”的证明：组合 `verify:local`/E2E 仍有本地环境阻塞，且报告明确列出 3 个未修复 P2。创建任何修复 PR 时应按上节拆分，不把三个问题和结构重构混为一批。

## 15. 人工复核优先顺序

1. 先看 AUD-2026-08-01-01 的独立 301 请求复现，以及 `verify-local.sh` 与 CI env 的差异。
2. 再看 AUD-2026-08-01-02 的事务外检查/事务内无条件写，确认单次 token 语义。
3. 最后评审 AUD-2026-08-01-03 的邮件失败语义，决定 outbox 还是两阶段 token 激活模型。
4. 对无 P0/P1 的结论，重点抽查订单 `accounting.ts`、`fulfillment.ts`、`service.ts`，以及认证 `refreshAccessToken`、管理员 MFA guard 和商家 owner scope。
