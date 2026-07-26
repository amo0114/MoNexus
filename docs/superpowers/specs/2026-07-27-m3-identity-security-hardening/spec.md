# Spec: M3 身份与特权操作安全收口

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-M3-ISH-001 |
| 版本 | 1.2.0 |
| 日期 | 2026-07-27 |
| 状态 | Frozen for Implementation |
| 产品 | MoNexus |
| 关联 PRD | docs/superpowers/specs/2026-04-30-monexus-product-prd.md §4.3.5、§8 |
| 配套文档 | [plan.md](./plan.md) · [task.md](./task.md) · [checklist.md](./checklist.md) |

---

## 1. 目的与问题陈述

### 1.1 目的

MoNexus 已拥有积分调整、封禁、商家审核与停用、佣金修改、订单仲裁、批量结算、运行时配置和交付文件吊销等高影响管理操作。当前管理员登录仍只有邮箱和密码；RefreshToken 虽包含 userAgent、IP、创建时间、吊销状态与轮换防重放逻辑，却没有面向用户的设备会话列表或定向吊销能力。

本规格将管理员账号从“密码是唯一门槛”提升为“密码 + TOTP”；并把既有 RefreshToken 轮换机制升级为稳定、可见、可吊销的会话族。目标是先关闭最可能导致全平台失控的身份风险，而不是在同一波引入完整欺诈系统。

### 1.2 已核实的现状

| 事实 | 证据 / 影响 |
| --- | --- |
| User 只有 email、password、role、status 等身份字段，没有 MFA 状态、密钥或恢复码模型 | 管理员无法启用第二因子 |
| 登录成功即创建 RefreshToken 并签发 access token；密码哈希成本为 bcrypt 10 | 管理员密码泄露即可直接进入后台；成本低于 PRD 的“至少 12”目标 |
| RefreshToken 已有 hash、expiresAt、revoked、userAgent、ip 与原子轮换 | 可在其上演进会话族，无需重写登录体系 |
| access token 有效期为 15 分钟，当前只含 userId 与 role | 单设备吊销不能被 access token 精确识别；旧管理员 token 不携带 MFA 证明 |
| admin 路由组统一走 authenticate → requireActiveUser → requireAdmin | 可在同一入口增加 requireAdminMfa，不需逐个控制器复制判断 |
| 现有 AdminLog 覆盖多数管理写操作，认证/会话安全事件没有持久化记录 | 安全操作的取证链不完整 |

### 1.3 成功标准

1. 管理员无法仅凭密码取得正常 access token 或 refresh cookie；首次登录必须完成 TOTP 绑定，之后每次新登录必须通过 TOTP 或一次性恢复码。
2. 已有管理员在上线后不能用旧 access/refresh token继续访问 admin API；不会出现“先上线、再慢慢绑定”的无保护窗口。
3. 所有登录用户可查看自己的活跃设备会话，并可吊销一个会话、其他会话或全部会话；接口不返回 refresh token hash、原始 IP、原始 user-agent 或 MFA 密钥。
4. 管理员高风险路由仅接受带 MFA 证明且关联未吊销会话的 access token；被吊销会话对 admin API 立即失效，普通业务 API 至迟在现有 access token 15 分钟到期/刷新时失效。
5. 成功密码登录会把旧 bcrypt 成本的密码渐进重哈希至 12；错误密码不会触发写入。
6. MFA 密钥、恢复码、预认证 challenge、TOTP 码均不写明文数据库、不进入日志、审计详情或 HTTP 响应的后续读取接口。

---

## 2. 范围

### 2.1 范围内

| 域 | 本波交付 |
| --- | --- |
| 管理员 MFA | 强制 TOTP 绑定、首次绑定、正常登录验证、恢复码验证、换机/丢码的受控恢复策略 |
| 登录契约 | admin 密码校验成功后的预认证 challenge 流；只有 MFA 成功才签发完整会话 |
| Token / 中间件 | access token 增加 sessionId、mfaVerified、mfaVersion；admin 路由统一验证 MFA 与活动会话 |
| 设备会话 | 基于 RefreshToken sessionId 的列表、当前设备标识、单个/其他/全部吊销 |
| 认证审计 | 持久化关键 MFA、会话吊销、恢复码使用等安全事件；继续沿用 AdminLog 记录业务操作 |
| 密码防护 | bcrypt 成本统一目标 12，成功登录时 opportunistic rehash；注册、改密、重置新哈希直接使用 12 |
| 前端 | 登录 MFA 两阶段界面、首次绑定二维码/手动密钥与恢复码确认、个人中心设备管理 |
| 运维与测试 | 生产密钥启动门禁、日志 redact、丢失第二因子的 break-glass SOP、vitest 与 Playwright 覆盖 |

### 2.2 范围外

| 项 | 原因 |
| --- | --- |
| 普通用户和商家的可选 MFA | 先把最高权限角色强制收口；数据模型可为后续扩展保留空间 |
| OAuth、短信、Passkey / WebAuthn、第三方身份提供方 | 认证面会显著扩大，另立规格 |
| 完整通用风控引擎、异地登录拦截、IP 黑名单 | 需要策略、告警与运营处置闭环；本波只留下安全事件基础 |
| 每一次高危写操作重新输入 TOTP 的 step-up UX | 本波先强制 MFA 登录和活动会话验证；见 D-03 的明确取舍 |
| GDPR 数据导出、注销、敏感字段全量加密迁移 | PRD M3-S3 的独立隐私/数据治理波次 |
| 修改 RefreshToken Cookie 策略、接入 Redis、重构全局授权框架 | 现有 HttpOnly Cookie、轮换与权限守卫保持 |
| 业务订阅、履约、营销、通知队列、支付类能力 | 与身份安全无关，且产品边界禁止真实支付 |

### 2.3 依赖与假设

| ID | 假设 |
| --- | --- |
| A-01 | 当前分支模型为 feature 分支从 develop 创建，PR 目标为 develop |
| A-02 | PostgreSQL、Prisma migration、现有 auth 测试基线可用 |
| A-03 | 生产 SMTP、HTTPS、COOKIE_SECURE 与 JWT_SECRET 已按现有部署要求配置 |
| A-04 | 运维方可在部署前配置新的 32-byte MFA_ENCRYPTION_KEY，且该值不写入仓库 |
| A-05 | 管理员数量有限；上线时强制重新登录并绑定 MFA 是可接受的安全发布动作 |

---

## 3. 决策记录

| ID | 决策 | 结论 |
| --- | --- | --- |
| D-01 | MFA 覆盖范围 | v1 仅管理员强制 TOTP；数据字段不限制未来为 merchant/user 扩展 |
| D-02 | 密钥存储 | TOTP seed 采用 AES-256-GCM 加密落库；恢复码只存不可逆高熵 hash；不得只做 base64 或明文存储 |
| D-03 | 高危操作 step-up | v1 以“管理员登录时 MFA + admin API 实时活动会话校验”为 P0；不在本 PR 对每个业务写操作增加短时二次 TOTP 弹窗。后续若启用，应单列 SPEC 并覆盖积分调整、配置、商家状态/佣金、仲裁、结算、文件吊销 |
| D-04 | 丢失第二因子 | 无 HTTP 后门、无管理员自助关闭 MFA。恢复码可登录；恢复码也丢失时只走双人审批的离线 break-glass SOP，清空 MFA、递增版本、吊销全部会话后强制重新绑定 |
| D-05 | 设备会话语义 | 一个 sessionId 代表一个浏览器/设备登录族；refresh rotation 继承 sessionId。吊销立即拒绝该族 refresh；admin API 同时校验 sessionId，故立即拒绝已吊销管理员 token |
| D-06 | bcrypt 升级 | 目标 rounds=12；不做一次性全表重算，成功校验旧密码后按需重哈希，避免离线批处理与用户强制改密 |

---

## 4. 角色与用例

### 4.1 角色

| 角色 | 关注点 |
| --- | --- |
| 管理员 | 绑定并使用 TOTP；保管恢复码；识别和吊销未知设备；所有后台操作被 MFA / 活动会话守卫 |
| 普通用户 / 商家 | 查看并管理自己的设备会话，不获得管理员 MFA 管理入口 |
| 平台运维 | 配置密钥、执行受控 break-glass、审查安全事件与发布门禁 |
| 系统 | 生成/加密 MFA 密钥、签发会话、轮换 refresh token、记录安全事件、拒绝无 MFA 的 admin 请求 |

### 4.2 主用例

~~~text
管理员首次登录
邮箱+密码正确 → enrollment challenge（无 cookie / 无 access token）
→ 展示 QR / 手动密钥 → 输入 TOTP 验证
→ 保存加密 seed + 恢复码 hash + 吊销旧会话
→ 签发 MFA 会话并一次性展示恢复码

已绑定管理员登录
邮箱+密码正确 → login challenge（无 cookie / 无 access token）
→ TOTP 或未用恢复码 → 签发 MFA 会话
→ admin API: requireAdminMfa 验证 token claim、MFA 版本与 session 活跃状态

任意登录用户管理设备
GET sessions → 仅见自己的脱敏设备会话
→ 吊销一台 / 其他 / 全部 → 对应 refresh token 族失效
~~~

---

## 5. 领域规则与安全不变量

| ID | 规则 |
| --- | --- |
| DR-01 | admin 身份的密码正确不等于已登录；未完成 MFA 的响应绝不含 accessToken，也不设置 refreshToken Cookie |
| DR-02 | admin API 必须同时满足 role=admin、user.status 非封禁、token.mfaVerified=true、token.mfaVersion 与 User 当前版本相等、token.sessionId 对应活动会话 |
| DR-03 | 任何 MFA 重新绑定、离线重置、密码重置导致的安全边界变化都必须递增 mfaVersion（适用时）并吊销相关 refresh token；旧 admin access token 因版本/会话检查失效 |
| DR-04 | TOTP 使用 6 位、30 秒周期、SHA-1 兼容 RFC 6238；校验窗口最多相邻 1 个周期，不能扩大为任意时间漂移 |
| DR-05 | 预认证 challenge 是短期、单次、限尝试的凭证：TTL 5 分钟、最多 5 次失败；成功/超限/过期后不可复用 |
| DR-06 | 恢复码高熵生成、单次使用；每次重新生成都原子作废旧码。响应仅在生成当次返回明文，之后查询接口只返回“剩余数量” |
| DR-07 | sessionId 是随机 UUID，会在 refresh rotation 中保持不变；tokenHash 仍只以 hash 形式保存，永不经 API 返回 |
| DR-08 | 设备列表只返回服务端生成的 deviceLabel、脱敏 ipHint、sessionStartedAt、lastUsedAt、current；不返回原始 IP、完整 UA、token hash、MFA 字段 |
| DR-09 | refresh token replay 沿用现有强制失效策略：发现已撤销 token 被使用时，仍吊销该用户全部 refresh sessions，记录 security event，不能因本波变弱 |
| DR-10 | 密码、TOTP、恢复码、challengeId、provisioningUri、手动密钥、MFA_ENCRYPTION_KEY 不得写日志、AdminLog.detail、SecurityEvent.detail、错误消息或前端持久化状态 |
| DR-11 | 非 admin 不可调用管理员 MFA 绑定/验证入口；所有登录用户只能读取和修改自己的 sessionId |
| DR-12 | 成功密码验证但 bcrypt rounds < 12 时才重哈希；密码错误、被封禁、未完成 MFA 均不得触发重哈希 |

### 5.1 拟议数据模型

字段名称为实现建议；实施时以 Prisma schema 和 migration 评审结果为准。

| 模型 | 拟议字段 / 约束 | 用途 |
| --- | --- | --- |
| User | mfaEnabled、mfaSecretEncrypted、mfaVerifiedAt、mfaVersion | 管理员 MFA 状态；seed 只存加密密文 |
| MfaRecoveryCode | userId、codeHash、usedAt、createdAt；unique(userId, codeHash) | 一次性恢复码；无明文列 |
| AuthChallenge | UUID id、userId、purpose、secretEncrypted nullable、expiresAt、consumedAt、failedAttempts、createdAt | 登录 / 首次绑定的短期单次预认证状态；绑定前 seed 也只存加密值 |
| RefreshToken | sessionId UUID（会话族标识，不是 token 行全局唯一值）、sessionStartedAt、lastUsedAt、revokedAt、revokeReason；保留 tokenHash / expiresAt / revoked | 将轮换 token 行归属为稳定设备会话族 |
| SecurityEvent | userId nullable、sessionId nullable、type、ipHash nullable、deviceHint nullable、detailSafe nullable、createdAt | 只记录可审计、非秘密的身份安全事实 |

迁移要求：

1. 经仓库负责人授权，M3-ISH 可在独立 worktree 并行生成 schema/migration；但 P6a 合入后、M3-ISH 开 PR 前必须 rebase 并人工确认两套 schema/migration 都保留。命令始终显式指向专用 `monexus_m3_ish_test`，不手写或事后修改 migration SQL。
2. 采用两阶段、可部署的生成迁移：Migration A 先把历史 `RefreshToken` 的 session 字段以 nullable 形式扩展；旧 API 实例排空后，受版本控制的应用回填命令为**每条**历史 token 行分配不同的随机 UUID，并以 `createdAt` 初始化会话时间；只在隔离库证明无 null 后，再由 Migration B 收紧为 non-null。不得假定 Prisma `uuid()` 默认值会安全回填既有行。
3. `sessionId` 的唯一性属于会话族：每个历史 token 行初始获得一个不同的 family ID；refresh rotation 的新旧 token 必须共享该 ID，因此数据库不得对 `RefreshToken.sessionId` 建全局 UNIQUE 约束。
4. 回填/切换中必须吊销全部 legacy admin refresh token，避免旧无 MFA claim 的会话继续使用；不回填 MFA，`mfaEnabled` 默认 false，旧管理员下一次密码登录必须走首次绑定。
5. `SecurityEvent.userId` 使用保留审计的删除语义；challenge/recovery artifact 才可随 User 清理。所有迁移、回填与 drift 验证都只在专用隔离库运行。

---

## 6. 功能需求

### 6.1 管理员 MFA

| ID | Pri | 需求 | 验收要点 |
| --- | --- | --- | --- |
| REQ-F-010 | P0 | admin 密码登录成功且未绑定 MFA 时返回 enrollment challenge，而非正常会话 | 无 access token / refresh cookie；challenge 5 分钟有效 |
| REQ-F-011 | P0 | 绑定开始接口创建加密 seed，返回 QR provisioning URI 与手动输入密钥 | 密文不含可读 seed；不写日志 |
| REQ-F-012 | P0 | 正确 TOTP 确认绑定后，原子开启 MFA、保存 recovery hash、吊销旧会话、签发新 MFA 会话 | 恢复码只返回一次；失败不能半绑定 |
| REQ-F-013 | P0 | 已绑定 admin 登录必须经 TOTP 或未使用 recovery code 才能建会话 | 错码/超限不签发 cookie；恢复码第二次失败 |
| REQ-F-014 | P0 | admin API 统一增加 requireAdminMfa | 旧 token、无 sid、版本不匹配或 session 已吊销均拒绝 |
| REQ-F-015 | P1 | 个人安全区展示“已启用 MFA、恢复码剩余数”；可在当前密码 + 现有 MFA 因子验证后重新生成恢复码 | 旧码原子作废；新码一次性展示 |
| REQ-F-016 | P1 | 管理员换机可在已登录的安全区重新绑定 TOTP | 需当前密码 + 现有 TOTP/恢复码；成功后 bump version、吊销其他会话 |

### 6.2 设备会话

| ID | Pri | 需求 | 验收要点 |
| --- | --- | --- | --- |
| REQ-F-020 | P0 | 每次注册/登录创建一个稳定 sessionId；每次 refresh rotation 继承该 id 并更新 lastUsedAt | 两次轮换 sessionId 不变 |
| REQ-F-021 | P0 | 所有登录用户可列出自己的活跃会话 | 仅 active、未过期项；有 current 标记；数据脱敏 |
| REQ-F-022 | P0 | 用户可吊销指定非当前 session | 只能影响自己的 session；被吊销 refresh 返回 401 |
| REQ-F-023 | P0 | 用户可吊销其他全部 session；已有 logout 保留为吊销当前 session | 当前 session 不会被“其他全部”误伤 |
| REQ-F-024 | P1 | 用户可选择吊销全部会话（含当前），响应清理当前 cookie 并前端退出 | 后续 refresh 均失败 |
| REQ-F-025 | P0 | 已吊销 session 的 admin access token 立即不能访问 admin API | 证明 requireAdminMfa 查询/验证活动 session |

### 6.3 审计、密码和日志

| ID | Pri | 需求 | 验收要点 |
| --- | --- | --- | --- |
| REQ-F-030 | P0 | 记录 mfa_enrolled、mfa_login_succeeded、mfa_login_failed、mfa_recovery_used、session_revoked、session_replay_detected、mfa_break_glass_reset 等安全事件 | 事件不含秘密，可按 userId / sessionId 追溯 |
| REQ-F-031 | P0 | Pino redact 覆盖 MFA 请求字段和新环境变量；测试锁定 | 日志序列化中不出现明文 |
| REQ-F-032 | P0 | 新密码操作 bcrypt rounds=12；成功验证旧 hash 时 opportunistic rehash | 成功/失败分支均有测试 |
| REQ-F-033 | P1 | AdminLog 对关键业务写操作保留原语义，并可在 detailSafe 中关联 sessionId 的短安全摘要（不得把 token 放入 detail） | 审计可关联，不泄露凭证 |

---

## 7. API 契约

所有路径位于 /api；错误沿用现有 error envelope。challengeId 是敏感短期凭证，客户端只能保存在 React 内存状态，不能写 Zustand persist、URL、localStorage 或日志。

### 7.1 登录状态机

~~~text
POST /auth/login
  non-admin              → 200 { user, accessToken } + refresh cookie
  admin, MFA 未绑定       → 202 { status: "mfa_enrollment_required", challengeId, expiresAt }
  admin, MFA 已绑定       → 202 { status: "mfa_required", challengeId, expiresAt }
  密码错误 / 封禁          → 现有 401 / 400 语义

POST /auth/mfa/enrollment/start
  enrollment challenge    → 200 { provisioningUri, manualKey, expiresAt }

POST /auth/mfa/enrollment/confirm
  正确 TOTP               → 201 { user, accessToken, recoveryCodes } + refresh cookie

POST /auth/mfa/verify
  login challenge + TOTP  → 200 { user, accessToken } + refresh cookie
  login challenge + 恢复码 → 200 { user, accessToken, recoveryCodeRemaining } + refresh cookie
~~~

### 7.2 请求与响应约束

| 方法 | 路径 | 身份 | 请求摘要 | 成功响应 | 关键失败 |
| --- | --- | --- | --- | --- | --- |
| POST | /auth/login | public | email, password | 200 正常登录或 202 MFA challenge | 401 UNAUTHENTICATED |
| POST | /auth/mfa/enrollment/start | preauth challenge | challengeId | provisioningUri, manualKey, expiresAt | 400 MFA_CHALLENGE_INVALID |
| POST | /auth/mfa/enrollment/confirm | preauth challenge | challengeId, code | user, accessToken, recoveryCodes | 401 MFA_VERIFICATION_FAILED；429 MFA_TOO_MANY_ATTEMPTS |
| POST | /auth/mfa/verify | preauth challenge | challengeId, method=totp/recovery, code | user, accessToken | 同上 |
| GET | /auth/sessions | authenticated | — | items: active session summaries | 401 |
| DELETE | /auth/sessions/:sessionId | authenticated | — | 204 | 404（不属于自己或不存在） |
| POST | /auth/sessions/revoke-others | authenticated | — | { revokedCount } | 401 |
| POST | /auth/sessions/revoke-all | authenticated | — | { revokedCount } + clear cookie | 401 |
| POST | /auth/mfa/recovery-codes/regenerate | admin + MFA | currentPassword, method, code | recoveryCodes | 401 / 429 |
| POST | /auth/mfa/reconfigure/start | admin + MFA | currentPassword, method, code | provisioningUri, manualKey, challengeId | 401 / 429 |
| POST | /auth/mfa/reconfigure/confirm | admin + MFA | challengeId, code | recoveryCodes | 401 / 429 |

返回 session summary 的最小结构：

~~~json
{
  "items": [
    {
      "sessionId": "uuid",
      "deviceLabel": "Chrome · macOS",
      "ipHint": "203.0.113.*",
      "sessionStartedAt": "2026-07-27T00:00:00.000Z",
      "lastUsedAt": "2026-07-27T01:00:00.000Z",
      "current": true
    }
  ]
}
~~~

### 7.3 管理路由守卫

admin 路由组最终顺序：

~~~text
authenticate
→ requireActiveUser
→ requireAdmin
→ requireAdminMfa
→ admin routes
~~~

requireAdminMfa 的拒绝码应可供前端正确退出或提示重新登录：

| 场景 | HTTP / code |
| --- | --- |
| token 没有 MFA claim、mfaVersion 不匹配、User 尚未绑定 | 403 MFA_REQUIRED |
| sessionId 缺失或已撤销/过期 | 401 SESSION_REVOKED |
| 用户已封禁 | 保持现有 403 FORBIDDEN |

---

## 8. UI / UX 需求

### 8.1 管理员登录与绑定

1. LoginPage 的密码提交需要识别 202 challenge，不把它当作“登录失败”。
2. 首次绑定页只显示在登录壳内，不能先渲染 Layout 或任何 admin 数据。
3. 页面展示二维码、手动密钥、6 位验证码输入；手动密钥允许复制，但不写入浏览器持久化存储。
4. 绑定成功后用全屏一次性恢复码确认页展示 10 个码；用户勾选“已安全保存”才允许进入后台。关闭/刷新后不提供再次查看。
5. 已绑定登录页提供“使用恢复码”切换；错误不泄露是 TOTP 错误、已使用还是不存在。
6. 管理员账户安全区说明“不能关闭 MFA”；提供恢复码重生和换机入口，并提示其会使其他会话失效。

### 8.2 设备会话

1. ProfilePage 的账号安全区对所有角色展示“登录设备”卡片。
2. 当前设备显式标注；非当前设备有“退出此设备”二次确认；“退出其他设备”也需确认。
3. 显示友好设备标签、脱敏 IP 与最近活跃时间；无法解析 UA 时回退为“浏览器会话”，不展示完整 UA。
4. 吊销当前/全部会话后调用现有前端 logout，跳转登录页；吊销其他会话后刷新列表并 Toast。
5. 控件提供可访问名称和稳定 data-testid；移动宽度下会话卡不依赖横向表格。

---

## 9. 非功能需求

| ID | 类别 | 需求 |
| --- | --- | --- |
| REQ-NF-01 | 密钥管理 | MFA_ENCRYPTION_KEY 使用 base64 编码的随机 32-byte 值；生产缺失或长度不合法时拒绝启动；测试使用隔离假值 |
| REQ-NF-02 | 加密 | AES-256-GCM 每次加密使用独立随机 IV，密文包含认证 tag；解密失败只给安全错误，不透出实现细节 |
| REQ-NF-03 | 限流 | MFA 验证既有 auth IP 限流外，再受 challenge 单次 5 次尝试限制；超限后重新输入密码取得新 challenge |
| REQ-NF-04 | 性能 | requireAdminMfa 可因 admin API 低频直接查活动 session；普通用户设备会话不对每个业务请求新增数据库查询 |
| REQ-NF-05 | 隐私 | 会话 API 绝不返回原始 IP、完整 UA、tokenHash；安全事件只存 IP HMAC 和安全摘要 |
| REQ-NF-06 | 兼容 | 非 admin 登录/刷新/登出契约保持 200 成功形态；只新增 session claim，不移除 userId/role |
| REQ-NF-07 | 可用性 | TOTP 不依赖外部短信/网络服务；服务器时钟必须由现有宿主机 NTP 保持合理同步 |
| REQ-NF-08 | 可测试性 | TOTP 时钟、随机码、mailer/日志依赖可注入或隔离，不能以真实时间等待 30 秒测试 |
| REQ-NF-09 | 可观测 | 不记录密码/OTP，但记录成功/失败计数和安全事件类型；Sentry 上报不得带 request body |

---

## 10. 验收标准

### AC-01 管理员首次绑定

Given 一个 mfaEnabled=false 的管理员  
When 其提交正确邮箱和密码  
Then 返回 202 enrollment challenge，且没有 access token 或 refresh cookie；完成正确 TOTP 后才获得 MFA 会话和一次性恢复码。

### AC-02 已绑定管理员登录

Given 已绑定 TOTP 的管理员  
When 其只提交正确邮箱和密码  
Then 返回 202 mfa_required；错误 TOTP 不创建会话；正确 TOTP 才返回 200 和 refresh cookie。

### AC-03 恢复码安全

Given 已绑定管理员及一枚未用恢复码  
When 使用它完成登录  
Then 该码只可使用一次、剩余数减少；相同恢复码再次使用被拒绝且不签发会话。

### AC-04 管理后台强制 MFA

Given 一个发布前签发的旧管理员 token 或缺失 MFA claim 的 token  
When 请求任一 admin API  
Then 返回 MFA_REQUIRED 或 SESSION_REVOKED，不能读取或写入后台数据。

### AC-05 会话隔离与吊销

Given 同一用户有两个 sessionId  
When 当前设备吊销另一个 sessionId  
Then 被吊销设备 refresh 失败、当前设备继续可用，且列表不泄露其他用户的数据。

### AC-06 管理员即时会话失效

Given 管理员某个活动会话已获得 access token  
When 该 sessionId 被吊销  
Then 使用该 access token 请求 admin API 立即得到 SESSION_REVOKED。

### AC-07 密码升级与秘密不泄露

Given bcrypt 10 的旧 hash  
When 正确密码登录  
Then hash 升级为 rounds 12；错误密码不改变 hash；日志、DB 安全事件与 API 不含明文 MFA 秘密。

### AC-08 回归

Given 全量测试和生产配置检查  
When 本波 PR 合并前执行  
Then vitest、相关 Playwright、双端 build、Prisma drift 检查以及 production env guard 全部通过。

---

## 11. 风险与开放问题

| ID | 风险 / 问题 | 缓解 / 结论 |
| --- | --- | --- |
| R-01 | 强制 MFA 可能让管理员在发布时暂时不能工作 | 发布窗口前准备 MFA_ENCRYPTION_KEY、通知管理员；上线后首次密码登录即完成绑定；保留离线 break-glass SOP |
| R-02 | AES key 丢失将无法验证已有 TOTP seed | 密钥进入现有 secrets 管理和备份清单；轮换方案不在 v1，任何变更须先设计 keyring 迁移 |
| R-03 | 设备吊销对普通业务 access token 不是毫秒级全局拦截 | 明确最大暴露为现有 15 分钟 access TTL；admin API 额外实时校验，达到 P0 风险目标 |
| R-04 | LoginPage / auth refresh 有状态变化，易引入自动刷新误判 | 202 challenge 不是 401；前端 Axios 只对会话型 401 走 refresh，MFA 业务错误不得自动重放 |
| R-05 | TOTP 测试依赖时间与随机数 | 提供 clock/OTP adapter；禁止 sleep 式测试 |
| R-06 | 过早把 step-up 覆盖所有 admin 写操作会放大 UI 冲突和运营摩擦 | 按 D-03 先不做；本规格要求保留高危路由矩阵，后续专规覆盖 |
| R-07 | 通用本地验证脚本会启动共享 compose、使用默认测试库并占用 3000/5173 | 本波只使用专用数据库、3103/5178 与 `reuseExistingServer=false` 的 M3-ISH 专用验证入口；不得借跑 `verify:local` 或默认 e2e |
| OQ-01 | 是否将登录密码最小长度从 6 提升至 10/12 并接入泄露密码库 | 推荐另开 auth password policy 小规格，避免和 MFA/session migration 混合 |
| OQ-02 | 是否给普通用户/商家也开放 TOTP | 等管理员强制 MFA 稳定并观察真实需求后决定 |

---

## 12. 需求追溯矩阵

| 需求 | plan 阶段 | task | checklist |
| --- | --- | --- | --- |
| REQ-F-010–014 | Phase A / B / D | T-BE-01、T-BE-02、T-BE-03、T-BE-05、T-FE-01、T-QA-01 | CHK-MFA-01..08、11..12、CHK-AUTH-* |
| REQ-F-015–016 | Phase D（P1） | T-BE-06、T-FE-03 | CHK-MFA-09..10、CHK-FE-08..09 |
| REQ-F-020–023 | Phase A / C / D | T-BE-01、T-BE-04、T-FE-02、T-QA-01 | CHK-DATA-04、CHK-SES-01..06、08..09、CHK-FE-05..07 |
| REQ-F-024 | Phase C / D（P1） | T-BE-06、T-FE-03 | CHK-SES-07、CHK-FE-05 |
| REQ-F-025、REQ-F-032 | Phase B / C | T-BE-05、T-QA-01 | CHK-AUTH-01..09 |
| REQ-F-030–033 | Phase A / E | T-BE-02、T-BE-05、T-DOC-01 | CHK-SEC-* |
| REQ-NF-01–09、AC-01–08 | 全程 / Phase E | T-00、T-QA-01、T-QA-02 | CHK-PROC-*、CHK-QA-*、验收场景 |

---

## 13. 变更控制

1. D-01 至 D-06 任一项变更必须更新本 spec、plan、task、checklist 后再编码。
2. 不得将“临时跳过 MFA”“测试环境 HTTP 后门”或明文恢复码导出作为实现捷径。
3. 任何新增 auth API 必须同步 docs/superpowers/specs/monexus-api-openapi.json，或在 PR 中明确说明 OpenAPI follow-up 与阻塞原因。
4. 本文档版本按语义化递增；扩大 MFA 覆盖角色或加入 step-up 为 minor 级范围变更。

---

## 14. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-07-27 | 初版安全规格 |
| 1.1.0 | 2026-07-27 | 收口 session family 唯一性、两阶段生成迁移与独立验证约束；使 P1 追溯与任务优先级一致 |
| 1.2.0 | 2026-07-27 | 仓库负责人授权在隔离 worktree 并行实现；P6a rebase 从编码前闸门改为 PR 前强制闸门 |

---

## 15. 批准

| 角色 | 姓名 | 日期 | 结论 |
| --- | --- | --- | --- |
| 产品 / 仓库负责人 | | | |
| 技术负责人 | | | |
| 安全评审 | | | |
