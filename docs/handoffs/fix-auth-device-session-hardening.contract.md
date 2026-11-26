# 用户登录设备与会话数据安全加固契约

基线：`origin/develop@5b2624a`。
任务来源：Owner 于 2026-11-25 发起用户登录设备信息及相关网络/客户端/会话数据审计，经 Gemini 与 Codex（GPT）联合审校并达成一致设计方案（D1–D7），Owner 于同日明确批准按该方案启动实施。

> 授权边界（`AGENTS.md` §4）：本次仅授权在隔离 worktree 内实施代码、迁移、文档与本地验证，并送交 Codex 做固定 SHA 独立审查。**未获得推送、创建/合并 PR 或操作 `master` 的授权**，在 Owner 再次明确授权前严禁执行。

## D1 · 实现与审查分工

- Gemini 为唯一实现负责人，在独立 worktree `/root/.t3/worktrees/MoNexus-new/fix-auth-device-session-a3a370eea07d6246`（分支 `fix/auth-device-session-hardening`）分提交完成迁移、后端、前端、测试与交接文档。
- Codex 担任独立审查者，按固定提交 SHA 审阅代码并在独立可丢弃测试库上核验状态机、迁移回填、并发及多标签页行为。

## D2 · 敏感客户端数据最小化

1. **`RefreshToken` 写侧最小化**：
   - 新增可空列 `deviceLabel`、`ipHint`（保留旧列 `ip`、`userAgent` 供灰度兼容与回滚）。
   - 登录、注册、管理员 MFA 绑定/验证与续签仅写入规范化后的 `deviceLabel` 与 `ipHint`，原始 `ip` 和 `userAgent` 一律写入 `null`。
   - 读侧（`GET /api/auth/sessions`）优先读 `deviceLabel` / `ipHint`，对存量未回填行使用同一有界解析器回退解析旧列。
   - 提供可中断、可重跑、按主键分批的历史回填与清理任务：写入摘要后在同一批事务内将历史 `ip` / `userAgent` 置空。
2. **`FileGrantLog.userAgent` 最小化（方案 A）**：
   - 复用现有列名与管理端 API 字段名 `userAgent`，新写入仅持久化固定受控客户端摘要（`sessionDeviceLabel`），不再存储原始 UA。
   - 管理端接口 `GET /api/admin/delivery-files/:id/grants` 读侧对存量原始 UA 即时摘要输出；前端 `AdminFileGovernance.tsx` 展示标签改为「客户端摘要」。
   - 提供幂等、可重跑的主键分批历史改写：已命中白名单摘要的值保持不变，旧原始 UA 改写为固定摘要。

## D3 · IPv6 展示与限流键

- `redactIpHint` 对公网 IPv6 保持返回 `'IPv6 地址'`（不暴露前缀，维护 `clientIp.test.ts` 既定隐私契约）。
- IPv4-mapped IPv6（如 `::ffff:203.0.113.50`）剥离映射前缀后按 IPv4 `/24` 脱敏（`203.0.113.*`）。
- IPv6 `/56` 聚合仅用于限流与 SSE 并发计数（见 D7）。

## D4 · 重放状态机修复、家族级清理与备份脱敏

1. **重放 DoS 修复与 M3 D-07 修订**：
   - 持用户级 advisory lock 重读 `storedToken` 后，先校验 `expectedSessionId`，随后正常路径与 CAS 失败路径复用**同一分类函数**。
   - 以下任一条件成立时直接返回 `401`（不触发全量吊销、不写 `session_replay_detected`）：
     1. 提交行本身已过期（`expiresAt <= now`）；
     2. 所属 `sessionId` 家族存在任意终结标记（扩展 `EXPLICIT_SESSION_TERMINATION_REASONS` 纳入 `'refresh_replay'`、`'expired'`、`'login_replaced'`、`'session_limit'`）；
     3. 所属 `sessionId` 家族已无活跃后继（`revoked = false AND expiresAt > now AND (absoluteExpiresAt IS NULL OR absoluteExpiresAt > now)`）。
   - 仅当提交行未过期、类型为 `'refresh_rotation'` 或历史 `null`，且同家族仍存在活跃后继、无终结标记时，升级为 `handleRefreshReplay`：同事务全量吊销当前活跃家族、确保被重放家族写入 `'refresh_replay'` 终结标记，并仅记录一次 `session_replay_detected`（计数为被吊销的活跃家族数）。
   - **对存量规格 M3 D-07（`docs/superpowers/specs/2026-07-27-m3-identity-security-hardening/spec.md:94`）的获批修订**：历史 `revokeReason IS NULL` 行仅在同家族仍存在活跃后继时升级为重放；无活跃后继时返回 `401`。本修订已向 Owner 说明并获批准。
2. **家族级清理与历史脱敏任务**：
   - 新增每日 `defineLeasedCron` 任务（走 `CronLease` 并暴露 `monexus_cron_*` 指标），按有界页宽、家族预算与行扫描上限扫描候选 `(userId, sessionId)`，在数据库侧以 `NOT EXISTS` 过滤仍活跃或宽限期内的家族，并在 `AuthSessionRetentionCursor` 持久化每轮最后实际处理到的 `(expiresAt, id)` 游标（到尾部后回绕置空），消除跨轮饥饿；删除前对每家族获取 `lockUserRefreshSessionMutations(tx, userId)` 二次核验全部行均满足 `expiresAt < now - 30d` 再整族删除。
   - 存量 `RefreshToken` 的 `absoluteExpiresAt` 回填与 PII 清理均按用户拆分短事务并先获取 `lockUserRefreshSessionMutations(tx, userId)` 再重读更新，与 `revokeAllUserRefreshTokens` 共享同一锁序，杜绝死锁；`FileGrantLog` 历史 UA 改写按主键分批幂等推进。
   - 在 `server/src/main.ts` 接入 `start*` / `stop*` 生命周期。
3. **索引迁移**：
   - 单独单语句迁移 `CREATE INDEX CONCURRENTLY "RefreshToken_expiresAt_id_idx" ON "RefreshToken"("expiresAt", "id");`，遵循 `AGENTS.md` §3 并在 `check:migrations` 下校验通过。
4. **可移植备份脱敏**：
   - `portable-backups/service.ts` 在 `pg_dump` 中加入 `--exclude-table-data=public."RefreshToken"` 与 `--exclude-table-data=public."AuthChallenge"`（保留表结构 DDL）。
   - 恢复路径（直接 `pg_restore` 与导出 SQL + `psql` 两条路径）在恢复事务提交前即通过 `pg_restore --use-list` 过滤旧格式备份中的 `RefreshToken` 与 `AuthChallenge` 表数据，并保留恢复后清空事务作纵深防御。

## D5 · 会话绝对有效期与单用户 20 台活跃设备上限

1. **绝对有效期（`RefreshToken.absoluteExpiresAt`）**：
   - 新增可空列 `absoluteExpiresAt`。
   - 有效滑动天数 `effectiveDays` 取自 `SystemConfig.refreshTokenMaxAgeDays`（`0` 回落默认 7 天）：
     - 管理员绝对窗口 = `min(effectiveDays, 7)` 天；
     - 普通用户 / 商家绝对窗口 = `min(90, max(30, effectiveDays))` 天。
   - 新签发家族时：`absoluteExpiresAt = now + absoluteWindowMs`，`expiresAt = min(now + idleMs, absoluteExpiresAt)`。
   - 续签轮换时：继承原 `absoluteExpiresAt`（历史空值与在线回填共用 `resolveLegacyAbsoluteExpiresAt`：管理员为 `sessionStartedAt + 7d`，非管理员为 `GREATEST(existingExpiresAt, sessionStartedAt + 30d)`，确保先续签与先回填结果完全一致）；若 `absoluteExpiresAt <= now` 拒绝并按过期处理；`nextExpiresAt = min(now + idleMs, absoluteExpiresAt)`。
   - 跨事务传递持久化绝对截止 `expiresAt`：JWT 签名时直接写入整数秒 `exp <= floor(expiresAt / 1000)`，写 Refresh Cookie 时按响应时刻重新计算剩余整秒 `Max-Age <= expiresAt - now`（剩余不足 1 秒均拒绝签发），确保即使提交与写响应之间存在延迟也不越界。
   - 迁移与回填解耦（无长表锁）：
     - DDL 迁移仅执行无默认值的可空列 `ALTER TABLE ... ADD COLUMN`（毫秒级元数据锁，不扫描或更新历史行）；
     - 新版本上线即在运行时鉴权（`getAdminMfaSessionState`、`requireActiveUser`、`activeRefreshTokenWhere`）与续签路径对 `absoluteExpiresAt IS NULL` 的存量管理员行立即执行 7 天硬上限，同时保持非管理员活跃会话在线；
     - 线上由 `authSessionRetention` 任务调用 `backfillLegacyRefreshTokenAbsoluteExpiry` 按主键分批仅回填 `revoked = false AND expiresAt > now AND absoluteExpiresAt IS NULL` 的活跃行（非管理员 `GREATEST(expiresAt, sessionStartedAt + 30d)`；管理员 `sessionStartedAt + 7d` 并收紧 `expiresAt` 与超期行标记 `expired`）。
   - 同步更新 `systemConfig.ts` 与 `adminConfigMeta.ts` 对 `refreshTokenMaxAgeDays` 的说明文案。
2. **单用户 20 台活跃家族上限**：
   - 新家族签发事务内（在 D6 同账号替换之后），若用户当前活跃家族（`revoked = false AND expiresAt > now`）数 `>= 20`，按 `(lastUsedAt ASC, sessionId ASC)` 淘汰最旧家族至插入新家族后总数 `<= 20`，被淘汰家族标记 `revoked = true, revokedAt = now, revokeReason = 'session_limit'` 并记录 `session_revoked`。续签轮换不触发淘汰。

## D6 · 同账号重登替换与改密安全清 Cookie

1. **同账号重登自动替换**：
   - 密码登录、注册、管理员 MFA 绑定确认与 MFA 登录验证**最终成功签发新会话时**（密码失败、封禁拒绝、管理员 202 pre-auth 均不触碰旧 Cookie），在同一用户锁事务内检查请求携带的 `refreshToken` Cookie。
   - 若其哈希对应同一 `userId` 的某个 `RefreshToken` 记录（即便该 Cookie 已是轮换前驱），先将该 `sessionId` 家族的活跃行置为 `revoked = true, revokedAt = now, revokeReason = 'login_replaced'` 并记录 `session_revoked`，再签发新家族。
   - 不触碰属于其他用户的旧 Cookie。
2. **改密安全清 Cookie**：
   - 前端 `ProfileIdentityCard.tsx` + `src/api/auth.ts`：提交前捕获 `AuthSessionContext`，获取 `withAuthCookieMutationLock`，锁内复核内存、持久化（`monexus-auth`）与 pending 会话身份；请求携带 `expectedSessionId` 与 `clearCookie: supportsCrossTabAuthLock()`（无 Web Locks 的浏览器不请求清 Cookie，避免迟到响应误清他标签新登录），保持 `skipAuthRefresh: true`。成功后在锁内清理本地状态并调用 `broadcastAuthSessionChange(null)`。
   - 后端 `auth/controller.ts`、`auth/schema.ts`、`auth/passwordService.ts`：接受可选 `expectedSessionId` 与 `clearCookie`。在用户锁内校验：若 `clearCookie === true`，要求 `expectedSessionId` 存在且等于 Bearer `req.user.sid`，且若请求携带 `refreshToken` Cookie，该 Cookie 必须属于同一 `expectedSessionId` 家族（否则在改密前抛 `409 SESSION_CHANGED`）。仅当 `clearCookie === true` 且校验通过并在密码修改提交成功后清理 Cookie。

## D7 · IP 规范化、UA 解析、审计补齐、启动校验与前端加固

1. **IP 规范化与 IPv6 `/56`**：
   - `server/src/lib/clientIp.ts` 导出 `normalizeClientIp(ip)`（剥离 `::ffff:`，经 `node:net` 校验并按 RFC 5952 压缩小写规范化 IPv6）与 `clientIpRateLimitKey(ip, ipv6PrefixBits = 56)`（IPv4 规范串，IPv6 `/56` 网络前缀串）。
   - `hashSecurityEventIp`、`hashAbuseEventIp`、`orders/fileAccess.ts:hashIp` 使用 `normalizeClientIp`。
   - `abuseLimiter.ts`（`dimension === 'ip'`）、`abusePolicy` 限流入口、`notifications/realtime/streamController.ts` 的 `ipConnectionCount` 统一使用 `clientIpRateLimitKey`。
2. **有界线性 UA 解析器**：
   - 抽离纯函数模块 `server/src/lib/deviceHint.ts`（零业务模块反向依赖），解析前截断至 512 UTF-8 字节，移除回溯正则 `/Version\/[^ ]+.*Safari\//i`，补充识别 `EdgiOS/`、`EdgA/`、`FxiOS/`、`MicroMessenger/`（WeChat）、`QQ/`/`MQQBrowser/`、iOS WebView、`CrOS`（ChromeOS）、`HarmonyOS`/`OpenHarmony`。
   - 当浏览器与平台均不可识别时，`getSecurityEventDeviceHint` 返回 `null`，`sessionDeviceLabel` 回落中文 `'浏览器会话'`。提供白名单校验函数供 `FileGrantLog` 幂等回填使用。
3. **审计元数据与家族计数修正**：
   - 所有调用 `revokeAllUserRefreshTokens` 的控制器/服务路径（`resetPassword`、`changePassword`、用户封禁/解封、商家通过/停用/恢复）透传 `{ ip: req.ip, userAgent: req.headers['user-agent'] }`。
   - `revokeAllUserRefreshTokens` 统一使用单次 `now` 过滤 `expiresAt > now` 统计活跃家族数，向 `session_revoked` 写入活跃家族数并返回家族数（同时将已过期未吊销行标记 `expired` 使未吊销行归零）。
4. **生产拓扑启动守卫**：
   - `server/src/config/index.ts` 在 `NODE_ENV === 'production'` 时强校验 `DEPLOY_TOPOLOGY` 与 `TRUST_PROXY` 映射表（`nginx → 1`、`caddy → 2`、`cloudflare_openresty_nginx → 2`），不匹配时非零退出；非生产环境维持允许 `TRUST_PROXY=0`。
5. **前端体验与并发防串话**：
   - `SessionManager.tsx`：默认展示前 3 条（当前设备 + 最近 2 台，超出时才显示展开按钮）；文案「最近活跃」改为「最近续签」；确认弹窗绑定打开时的 `AuthSessionContext`，执行前与响应后复核身份；`loadSessions` 加请求序号防乱序回写，且随会话切换重置状态。
   - `ProfilePage.tsx`：`handleLogout` 在异步 `disablePush()` 前捕获上下文，不再静默吞掉 `logoutCurrentSession()` 失败——失败时留在原页提示错误重试，仅在后端成功或遇到 `AuthSessionChangedError` 时按上下文安全收敛本地状态。
   - `AdminFileGovernance.tsx`：「客户端信息（UA）」改为「客户端摘要」。

## 明确延期（不在本次范围）

1. 将 `SecurityEvent` / `FileGrantLog` 的 `ipHash` 从 `JWT_SECRET` 迁移至新独立密钥。
2. 管理端查询 `SecurityEvent` 页面/接口与普通用户登录写 `SecurityEvent`。
3. 调整 `orders/fileAccess.ts` 对 `suspended` 商家的举证下载策略。
4. 拆分推荐 `visitorId` 与站内流量 `visitorId`。
