# Handoff: fix-auth-device-session-hardening

- Spec / 契约：[docs/handoffs/fix-auth-device-session-hardening.contract.md](fix-auth-device-session-hardening.contract.md)
- 审查记录：
  - Round 1（`5b2624a..4e1f55e`，Codex）：`REQUEST_CHANGES`（3 项 P1 + 4 项 P2），已于 `334f7f9` 修复；Round 2 复审确认 6/7 关闭。
  - Round 2（`5b2624a..e9079c7`，Codex）：`REQUEST_CHANGES`（2 项新 P1 + 1 项未关闭 P2），已于 `38d1d5e` 修复；Round 3 复审确认全部 P0/P1 关闭，余 1 项 P2 持续满预算回绕边界。
  - Round 3（`5b2624a..151bd9d`，Codex）：`REQUEST_CHANGES`（0 P0/P1，仅余 1 项 P2：持续满预算新增到期候选时游标不回绕），已于 `da4e851` 修复并补齐持续满预算回绕回归测试，送交第 3 轮（最后一轮）复审。
- 写入负责人：Gemini（更新时间 2026-11-25）
- 分支 / worktree：`fix/auth-device-session-hardening` / `/root/.t3/worktrees/MoNexus-new/fix-auth-device-session-a3a370eea07d6246`
- Base：`origin/develop@5b2624a`；已验证代码 revision：`da4e851`（本交接提交仅更新本文档，不改动代码）
- 隔离资源：独立可丢弃测试库 `monexus_test_session_hardening`（PostgreSQL 16，合成测试数据）；Node `v22.23.1` / npm `10.9.8`（`/root/.nvm/versions/node/v22.23.1/bin`）
- 独立审查对话：`thread:delegated-task:command%3Amcp%3A85fc1595-986e-4bca-9653-92f1cc3a6678%3Adelegate-task%3A0688eca4-0eb8-48ea-a168-374793b34770`

## 已完成（附证据）

1. **Commit 1 — `e2ac73f`**：`fix(auth): bound refresh replay escalation and complete revocation audit metadata`
   - 统一 `refreshAccessToken` 正常路径与 CAS 失败路径的重放分类逻辑，过期/已有终结标记/无活跃后继时仅返回 `401`，确保重放家族写入终结标记 `'refresh_replay'`（含获批的 M3 D-07 修订）。
   - `revokeAllUserRefreshTokens` 按单次 `now` 统计并记录活跃家族数，同时将已过期未吊销行标记为 `'expired'`；补齐改密/重置密码/用户封禁解封/商家审批停用恢复的 `{ ip, userAgent }` 审计透传。
   - 验证：`server build`、`test:architecture`、`check:architecture`、6 个后端核心测试套件（92/92）全部 exit 0。
2. **Commit 2 — `6694c73`**：`feat(auth): minimize session metadata, enforce absolute lifetimes, cap, and retention`
   - Prisma schema 与双迁移：`20261125100000_refresh_token_session_hardening`（新增 `absoluteExpiresAt` / `deviceLabel` / `ipHint`，回填非管理员活跃行与收紧管理员 7 天硬上限）及独立单语句并发索引迁移 `20261125100100_refresh_token_expires_at_id_idx`（`CREATE INDEX CONCURRENTLY`）。
   - D2：`RefreshToken` 新写入一律仅持久化 `deviceLabel`/`ipHint` 并对旧列写 `null`，读侧兼容旧行；`FileGrantLog.userAgent` 写入与读侧改为受控客户端摘要。
   - D5：角色分级绝对有效期（`admin <= 7d`，非管理员 `30..90d`）、Cookie `Max-Age` 与 Access JWT 整数秒 `exp` 同步裁剪、管理员鉴权中间件校验 `absoluteExpiresAt`、单用户 20 台活跃家族上限（按最旧 `lastUsedAt` 淘汰 `'session_limit'`）。
   - D4：`sessionRetentionCron.ts`（经 `defineLeasedCron` / `CronLease` 接入 `main.ts`）每日按推进游标与用户锁整族清理过期超 30 天家族，并幂等分批回填/脱敏历史 `RefreshToken` 与 `FileGrantLog`；`portable-backups/service.ts` 在 `pg_dump` 中排除 `RefreshToken` 与 `AuthChallenge` 表数据并在恢复事务清空两表。
   - 抽离纯函数有界线性 UA 解析器 `server/src/lib/deviceHint.ts`（512 UTF-8 字节截断、零回溯正则、扩展客户端/OS 识别与白名单校验）。
   - 验证：前后端构建、`test:architecture`、`check:architecture`、`check:migrations`、8 个后端测试套件（92/92）全部 exit 0。
3. **Commit 3 — `2a04ede`**：`fix(auth): replace same-account login cookies, harden password-change/IPv6/proxy guards and UI`
   - D6：同账号密码登录/注册/管理员 MFA 验证最终成功签发时，在用户锁内先替换请求携带的同账号旧 Cookie 家族（`'login_replaced'`，位于 20 台上限淘汰之前；失败登录、202 pre-auth 与跨账号 Cookie 不受影响）；改密端到端支持 `expectedSessionId` + `clearCookie`（前端在 `withAuthCookieMutationLock` 锁内仅在 `supportsCrossTabAuthLock()` 为真时请求清 Cookie，服务端在锁内先核对 Bearer `sid` 与 Cookie 家族一致再改密并清 Cookie，不匹配返回 `409 SESSION_CHANGED`）。
   - D7：`clientIp.ts` 新增 `normalizeClientIp`（IPv4-mapped IPv6 剥离与 RFC 5952 IPv6 压缩规范化）与 `clientIpRateLimitKey`（IPv6 `/56` 聚合），接入 `securityEvents.ts`、`abuseEvents.ts`、`orders/fileAccess.ts`、`abuseLimiter.ts`、`auth/routes.ts`、`authProtection.ts`、`loginFailures.ts` 与 `notifications/realtime/streamController.ts`；`server/src/config/index.ts` 增加生产 `DEPLOY_TOPOLOGY` ↔ `TRUST_PROXY` 启动硬校验。
   - 前端加固：`SessionManager.tsx` 默认展示前 3 条、「最近活跃」改为「最近续签」、列表防乱序回写、确认弹窗绑定 `AuthSessionContext`；`ProfilePage.tsx` 与 `UserAvatarHoverCard.tsx` 退出失败不再静默吞错清本地状态且防止 `disablePush()` 期间跨标签切号串话；`AdminFileGovernance.tsx` 改称「客户端摘要」；更新 `e2e/m3-identity-security-hardening.spec.ts` 与 `server/src/modules/auth/README.md`。
   - 验证：前后端构建、架构/迁移检查、全量前端单测（244 文件 / 1984 用例）、11 个后端核心测试套件（139 用例）全部 exit 0。
4. **Commit 4 — `334f7f9`**：`fix(auth): address Codex review findings on deadline clamping, lock-free backfill, password-change cookie proof, cleanup cursor, and backup restore filtering`
   - P1-1：跨事务传递持久化绝对截止 `expiresAt`，`generateAccessToken` 签发时直接写入整数秒 `exp <= floor(expiresAt / 1000)`，`setRefreshTokenCookie` 响应时重算剩余整秒 `Max-Age`，不足 1 秒统一 401 拒绝。
   - P1-2：`20261125100000_refresh_token_session_hardening` 改为纯元数据 DDL（零表锁回填）；运行时鉴权（`getAdminMfaSessionState`、`requireActiveUser`、`activeRefreshTokenWhere`）与续签对 `absoluteExpiresAt IS NULL` 存量管理员行立即执行 7 天硬上限；`backfillLegacyRefreshTokenAbsoluteExpiry` 仅按主键分批回填活跃未过期行。
   - P1-3：`changePassword` 在用户锁内复核 Bearer `sid` 仍活跃，且 `clearCookie=true` 时对任何无法证明属于 `(userId, expectedSessionId)` 的已提交 Cookie（含未知 Cookie）在改密前返回 `409 SESSION_CHANGED` 且不写 `Set-Cookie`。
   - P2-1：`cleanupExpiredRefreshTokenFamilies` 以 CTE + `NOT EXISTS` 在数据库侧排除仍活跃/宽限期内家族并增加 `maxRowsScanned` 上限，避免活跃家族前驱耗尽家族预算导致合格家族饥饿。
   - P2-2：`handleRefreshReplay` 与 `revokeAllUserRefreshTokens` 共享同一锁内判定 `now`，并显式确保重放家族写入 `revokeReason = 'refresh_replay'` 终结标记。
   - P2-3：`portable-backups/service.ts` 在直接 `pg_restore` 与 SQL+`psql` 两条恢复路径均应用 `pg_restore --use-list`（`filterRestoreTocList`）过滤旧格式备份中的 `RefreshToken` / `AuthChallenge` 表数据，防止恢复事务先提交临时凭据。
   - P2-4：`deviceHint.ts` 先按 UTF-16 截断上限再 UTF-8 编码，并将 `hasSafariSignature` 改为基于 `lastIndexOf('safari/')` 的真单趟线性扫描。
   - 验证：重建干净测试库 `monexus_test_session_hardening` 执行 `db:generate` + `db:migrate:deploy`（127 迁移全量通过）、前后端构建、架构/迁移检查、6 个核心后端测试套件（77/77）全部 exit 0。
5. **Commit 5 — `38d1d5e`**：`fix(auth): unify legacy expiry derivation, serialize backfill per user lock, and persist cleanup cursor`
   - R2 P1-1：`sessionPolicy.ts` 抽离 `resolveLegacyAbsoluteExpiresAt`（管理员 `sessionStartedAt + 7d`，非管理员 `GREATEST(existingExpiresAt, sessionStartedAt + 30d)`），由 `refreshAccessToken`/`computeSessionExpiry` 与 `backfillLegacyRefreshTokenAbsoluteExpiry` 共同调用，确保先续签与先回填结果完全一致。
   - R2 P1-2：`backfillLegacyRefreshTokenAbsoluteExpiry` 与 `scrubLegacyRefreshTokenMetadata` 改为按 `userId` 拆分短事务，先获取 `lockUserRefreshSessionMutations(tx, userId)` 再重读更新，与 `revokeAllUserRefreshTokens` 等全部会话写路径保持统一锁序，从结构上消除死锁。
   - R2 P2-1：新增 1 行状态表 `AuthSessionRetentionCursor`（合入纯 DDL 迁移 `20261125100000_refresh_token_session_hardening` 与测试 `setup.ts`），`cleanupExpiredRefreshTokenFamilies` 跨轮持久化最后实际处理到的 `(expiresAt, id)` 游标，到尾部后按 `initialCursor` 上界单次回绕并置空，消除行扫描预算耗尽导致的跨轮饥饿。
   - 验证：重建干净测试库执行 `db:generate` + `db:migrate:deploy`（127 迁移全量通过）、前后端构建、架构/迁移检查、`auth-session-retention-and-backup.test.ts`（6/6，含先续签/先回填对照、用户锁串行防死锁、3 周期跨轮推进+第 4 周期回绕回归）及其他 5 个核心后端套件全部 exit 0。
6. **Commit 6 — `da4e851`**：`fix(auth): persist fixed sweepCutoff on cleanup cursor to guarantee bounded wrap-around`
   - R3 P2-1：`AuthSessionRetentionCursor` 增加可空列 `sweepCutoff`（同步合入未应用的纯元数据 DDL 迁移 `20261125100000_refresh_token_session_hardening`）；`cleanupExpiredRefreshTokenFamilies` 跨轮持久化当前扫描周期固定的 `sweepCutoff`，查询使用 `scanCutoff = min(activeSweepCutoff, cutoff)` 严格限定当前扫描终点，到达终点后强制回绕至表头并以最新 `cutoff` 开启新周期，简化 `fetchCleanupPage` SQL；在 `auth-session-retention-and-backup.test.ts` 补齐“管理员回填把旧家族收紧到游标之前 + 连续 5 天新增到期候选每日打满预算仍能在有限轮次内回绕并删除旧家族”回归测试。
   - 验证：重建干净测试库执行 `db:generate` + `db:migrate:deploy`（127 迁移全量通过）、前后端构建、架构/迁移检查、6 个核心后端测试套件（6 files / 80 tests，含新增持续满预算回绕回归）及 `git diff --check` 全部 exit 0。

## 待完成

- 由 Codex 对固定提交范围 `5b2624a..<HEAD>` 在独立可丢弃测试库上完成独立代码审查与验证。
- 如审查提出有效 P0/P1/P2 finding，完成修复与复审；全部关闭后向 Owner 汇报结果并等待后续授权（当前**未授权** push、建 PR 或合并）。

## 已批准的设计决策

- D1–D7 与 M3 D-07 修订均记录于 [fix-auth-device-session-hardening.contract.md](fix-auth-device-session-hardening.contract.md)，由 Gemini 与 Codex 联合审校并于 2026-11-25 获 Owner 批准实施。
- 明确延期（本次未改动）：`SecurityEvent`/`FileGrantLog` `ipHash` 迁移独立密钥；管理端查询 `SecurityEvent` 与普通用户登录写 `SecurityEvent`；`orders/fileAccess.ts` 对 `suspended` 商家策略调整；拆分推荐与站内流量 `visitorId`。

## 风险与阻断

- 当前无实现阻断。
- 注意：PR 涉及认证、会话与中间件，按 `AGENTS.md` §5，将来获授权创建 PR 时须在创建即附带 `run-e2e` 标签。

## 验证记录

| 命令 | 结果（exit code） | revision |
|---|---|---|
| 重建空测试库 + `db:generate` + `db:migrate:deploy`（127 迁移） | PASS (0) | `da4e851` |
| `npm --prefix server run build` | PASS (0) | `da4e851` |
| `npm run build` | PASS (0) | `da4e851` |
| `npm run test:architecture`、`check:architecture`、`check:migrations` | PASS (0) | `da4e851` |
| `REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 npm --prefix server test -- src/__tests__/auth-session-retention-and-backup.test.ts src/__tests__/auth-sessions.test.ts src/__tests__/refresh-token-wiring.test.ts src/__tests__/auth-mfa.test.ts src/__tests__/auth.test.ts src/lib/deviceHint.test.ts`（对 `monexus_test_session_hardening`） | PASS (0) — 6 files, 80 tests | `da4e851` |
| `npm test`（全量前端 Vitest，无前端改动） | PASS (0) — 244 files, 1984 tests | `2a04ede` |
| `REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 npm --prefix server test -- src/lib/clientIp.test.ts src/__tests__/config-trust-proxy.test.ts src/__tests__/auth-security-events.test.ts src/__tests__/abuse-events.test.ts src/__tests__/registration-abuse-primitives.test.ts src/modules/notifications/__tests__/realtime-hub-controller.test.ts` | PASS (0) — 含于 11-file 139-test 联合执行 | `2a04ede` |
| `REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 npm --prefix server test -- src/__tests__/admin-file-governance.test.ts src/__tests__/file-delivery-chain.test.ts src/__tests__/system-config.test.ts` | PASS (0) — 含于 8-file 92-test 联合执行 | `6694c73` |
| `REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 npm --prefix server test -- src/__tests__/governance-v1.test.ts` | PASS (0) — 含于 6-file 92-test 联合执行 | `e2ac73f` |
| `git diff --check` | PASS (0) | `da4e851` |

## 未运行 / 无法验证

- Playwright 浏览器 E2E（含已更新的 `e2e/m3-identity-security-hardening.spec.ts`）— 未在本轮本地启动全栈服务执行；须在最终 `CI OK`（带 `run-e2e` 标签）或独立验证阶段覆盖。
- 后端未修改模块的其余全量集成测试分片、真实 Redis 联调与生产部署预检完整环境 — 未在本地全量运行，留待独立审查抽检与 GitHub Actions `CI OK`。

## 下一步

- 提交本交接文档后，将固定提交范围 `5b2624a..<HEAD>` 交由 Codex 审查会话在独立可丢弃测试库上执行独立审查与复核。
