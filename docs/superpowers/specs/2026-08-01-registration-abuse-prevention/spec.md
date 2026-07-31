# Spec: 注册、激励与邮件反滥用闭环

| 字段 | 值 |
| --- | --- |
| 文档 ID | `SPEC-RAP-001` |
| 版本 | `1.0.0` |
| 日期 | `2026-08-01` |
| 状态 | `In implementation (parallel foundations)` |
| 产品 | MoNexus |
| 前置规格 | `SPEC-OPS-REGMAIL-001`（注册开关与邮件投递运营面） |
| 配套文档 | [plan.md](./plan.md) · [task.md](./task.md) · [implement.md](./implement.md) · [checklist.md](./checklist.md) |

---

## 1. 目的与问题陈述

### 1.1 目的

MoNexus 当前允许任何访客直接注册：注册接口会立刻创建可登录账号和积分账户，并立即发放注册积分；携带任意已有账号的邀请码时，还会立即给邀请人发放邀请积分。邮箱验证是可选提示，而非任何高价值动作的服务端门槛。公开注册、验证邮件和密码重置仅使用每进程、IP 维度的 `express-rate-limit`。

这使攻击者能够通过代理池、临时邮箱和已获邀请码批量创建账号，消耗 SMTP 配额、累积积分并兑换商品/服务。本规格把“注册成功”与“可获得价值”明确分离，并用低摩擦的人机验证、Redis 共享限流、验证邮箱、邀请码额度、奖励延迟和可审计运营处置形成闭环。

### 1.2 已核实的现状

| 事实 | 风险 / 影响 |
| --- | --- |
| `POST /api/auth/register` 不要求邀请码，成功后立即登录并写注册积分 | 注册机不必控制邮箱即可取得可用积分账号 |
| `User.emailVerified` 已存在，但 `requireActiveUser` 只检查封禁状态 | 未验证用户可创建订单、签到、申请商家和上传 |
| `registerReward` / `inviteReward` 在注册事务中即时入账；邀请码无配额、无有效期 | 一个老账号的邀请码可无限产出积分 |
| `/auth/send-verification` 与 `/auth/forgot-password` 仅有 5 次 / 15 分钟 / IP 的内存 limiter | 分布式 IP 可造成发信成本与目标邮箱骚扰；多副本会放大额度 |
| Redis 客户端、超时、熔断和健康检查已经存在，但缓存故障默认降级回数据库 | 反滥用路径不能沿用“静默 fail-open”缓存语义 |
| `EmailVerificationToken` 已有高熵 hash、TTL、used 字段 | 可演进为“登录用户持有 token 才可完成验证”，无需保存明文 token |
| `User.inviteCode` 是唯一随机值，`InviteRelation.inviteeId` 已唯一 | 可保留现有公开邀请码格式，新增资格/额度状态而不是迁移用户可见邀请码 |

### 1.3 成功标准

1. 未验证邮箱的账号不能通过直接 API 创建订单、签到领积分、申请商家、创建/修改评价或上传文件；登录、浏览、找回密码、发送验证邮件和已有订单的查看/售后不受阻断。
2. 开启公开注册时，真实用户通常只经历无感 Turnstile；缺失、过期、错误 action/hostname 或不可验证的 token 永远不能创建账号。
3. 所有注册与用户邮件发送配额在全部后端实例间一致；Redis 不可用时，公开注册和用户邮件发送在强制模式下安全失败，不创建账号、不调用 SMTP。
4. 同一邀请码不能绕过每日/生命周期资格额度；并发邮箱验证最多有一个请求占用最后一个资格名额，奖励不会重复入账。
5. 注册和邀请奖励在邮箱验证及固定冷静期后才可用；历史已发奖励不被重发或追扣。
6. 管理员可在不看数据库、不暴露原始 IP/邮件哈希/密钥的情况下，看见趋势、暂停邀请码资格、作废未发奖励并留下 MFA 审计。
7. 正常用户可理解“为什么暂时不能购买/领奖励”，并可在可预期的冷却时间内完成邮箱验证；验证码、速率限制或 SMTP 故障不会被误报为管理员关闭注册。

---

## 2. 范围

### 2.1 范围内

| 域 | 本波交付 |
| --- | --- |
| 账户状态 | `emailVerified` 成为交易和激励资格的服务端边界；前端展示明确但不泄露风控规则的引导 |
| 人机验证 | Cloudflare Turnstile managed/invisible challenge 的浏览器集成、服务端 siteverify、严格 action/hostname/一次性 token 验证 |
| Redis 反滥用 | 原子、多维固定窗口 limiter；注册/邮件路径的 fail-closed 语义；指标和生产 readiness 门槛 |
| 用户邮件 | 验证邮件、密码重置的用户/邮箱/IP 多维配额、冷却、通用响应、防日志泄露；验证链接与已登录账户绑定 |
| 邀请与奖励 | 现有邀请码兼容、邀请码资格、日/生命周期额度、奖励 held→granted 状态机和固定冷静期 |
| 运营 | 管理员 MFA 风控概览、邀请码暂停、未发奖励作废、受控审计和指标 |
| 数据与测试 | Prisma migration、并发/属性测试、真实 Redis 专用测试、E2E、OpenAPI、部署/回滚文档 |

### 2.2 范围外

| 项 | 原因 |
| --- | --- |
| 身份证/KYC、手机号、支付卡或生物识别 | 与当前无真实法币支付的产品边界不匹配，隐私与合规成本另立规格 |
| IP 黑名单、设备指纹、第三方信誉分或“AI 风控评分” | 容易误伤且需要数据治理；v1 只使用透明的、可解释的规则 |
| SMTP 凭证在后台编辑 | 保持前置规格的基础设施密钥边界 |
| 营销活动、优惠券、通用积分规则重构 | 本包只处理注册/邀请产生的激励 |
| 对历史已发积分自动追扣 | 有账务与客服风险；仅允许经现有管理员积分调整流程人工处理 |
| 通用异步消息中心 | 本波可同步发送并严格限流；大规模邮件队列另立规格 |
| 修改移动端 UI 打磨文件或其 E2E | 与当前并行移动端工作严格隔离 |

### 2.3 前置条件与依赖

| ID | 依赖 |
| --- | --- |
| A-01 | `SPEC-OPS-REGMAIL-001` 已先合入：存在 `registrationEnabled`、安全的 SMTP 状态接口、前端注册状态机和邮件运营面。 |
| A-02 | 生产真实 SMTP 已配置、`GET /api/admin/mail/status` 显示 `deliveryReady=true`，且发件域已完成 SPF、DKIM、DMARC 配置。 |
| A-03 | 生产 Redis 使用独立、持久化的服务，所有 API 实例访问同一 key namespace，并启用 `REDIS_ENABLED=true`、`REDIS_REQUIRED=true`。 |
| A-04 | 运维可提供 Turnstile site key、secret key 和生产 hostname；secret 只在后端 Secret Store，site key 可经安全公开状态 DTO 下发。 |
| A-05 | 本规格独立 worktree/分支实施；涉及 Prisma schema/migration，必须在前置规格和并行 migration 合入后 rebase。 |

---

## 3. 决策记录

| ID | 决策 | 结论 |
| --- | --- | --- |
| D-01 | “注册”与“激活” | 注册仅创建受限账号；邮箱验证后才可进行有价值的写操作，奖励再经过固定冷静期释放。 |
| D-02 | 邮箱验证强制范围 | 只拦截资产/滥用高风险写入：创建订单、签到、商家申请、评价写入、图片/交付文件上传；不拦截登录、浏览、验证邮件、密码找回、订单查询、争议/确认/下载等既有售后能力。 |
| D-03 | 验证链接 | 禁止匿名 `GET` 直接把邮箱标记为已验证。邮件链接使用 URL fragment；前端以已登录 bearer 调 `POST /auth/verify-email`，服务端要求 token 对应 `userId` 等于当前会话用户。 |
| D-04 | CAPTCHA 选择 | v1 使用 Cloudflare Turnstile managed challenge；前端 token 仅是待验证证明，后端调用固定 siteverify endpoint 并校验 `success`、`action=register`、预期 hostname。 |
| D-05 | CAPTCHA/Redis 故障 | 当公开注册的保护已启用时，Turnstile 或 Redis 不可用均 fail-closed：返回受控 503、不写账号/积分/会话、不发邮件。登录和已登录业务不受影响。 |
| D-06 | 限流存储 | 仅 Redis 原子 Lua 计数可用于本规格保护路径；不得使用 `express-rate-limit` MemoryStore、进程 Map 或“Redis 失败则放行”作为生产后备。 |
| D-07 | 用户邮件策略 | 验证邮件和重置邮件均有用户/邮箱/IP 三维额度；超过额度时绝不调用 mailer。重置接口继续返回通用成功响应，避免存在性枚举。 |
| D-08 | 邀请码兼容 | 保留 `User.inviteCode` 的现有公开值和 `InviteRelation` 关系；新增其资格、状态和额度语义，历史关系标为 `legacy`，绝不补发奖励。 |
| D-09 | 奖励账务 | 新增受唯一约束的 `GrowthReward` held ledger；注册时固定奖励金额和邀请人 tier 结果，验证后进入 held，冷静期到期后以同一事务原子入账并写 `PointLog`。 |
| D-10 | 邀请配额占用时机 | 注册只创建待验证关系；邀请码的日/生命周期资格额度仅在邮箱验证事务中占用。额度满不阻止该用户验证或自有注册奖励，只使该邀请关系无资格获得邀请人奖励。 |
| D-11 | 风控模型 | v1 不做不可解释的风险分。持久化受控事件类型、匿名关联 hash 和规则结果；管理员只能暂停后续邀请码资格或作废尚未发放的奖励。 |
| D-12 | 运营配置 | `registrationEnabled` 仍属于前置规格；Turnstile 密钥只能来自环境；业务侧的验证交易开关、奖励冷静期和邀请码额度才进入 SystemConfig，并有严格范围校验。 |

---

## 4. 领域模型与状态机

### 4.1 账户资格状态

```text
visitor
  └─ register + challenge pass ─► registered_unverified
                                      │
                                      ├─ login / browse / request verification
                                      ├─ blocked: order, check-in, merchant application,
                                      │           review write, upload
                                      │
                                      └─ authenticated verification token claim ─► verified
                                                                                │
                                                                                └─ held rewards mature ─► value-enabled
```

`verified` 不代表 KYC、付款能力或绝对真人；它仅证明当前会话用户可持有发至该邮箱的一次性验证 token。

### 4.2 邀请关系与奖励状态

```text
InviteRelation
  legacy                 historical row; never creates a new GrowthReward
  pending_verification   registration accepted a currently eligible inviter code
  qualified              invitee verified; daily/lifetime quota atomically claimed
  quota_exhausted        invitee verified but inviter has no remaining slot
  voided                 operator invalidated before reward release

GrowthReward
  pending_verification ─► held ─► granted
                         └──────► voided
```

规则：

1. `InviteRelation.inviteeId` 继续全局唯一；一个账号不允许更换或叠加邀请人。
2. 邀请人代码在注册时必须来自状态正常、已验证、账户年龄达到 `referralInviterMinAgeDays` 且未被暂停资格的用户；否则不建立新 relation。
3. 验证邮箱时只允许一条 `pending_verification` relation 竞争额度；用邀请人行锁 + 当日/生命周期已 qualified 计数决定唯一结果。
4. 额度耗尽后，invitee 仍能成为 verified，并继续走自己的注册奖励；不会因为别人邀请码满额而锁死账号。
5. 每个 `GrowthReward.dedupeKey` 全局唯一；任何重试、并发 verify 或 cron 重跑均至多产生一条账务奖励。
6. 奖励金额是注册事务快照：注册奖励取当时 `registerReward`；邀请奖励取当时 `inviteReward` 加当时邀请人等级加成。后续配置、等级变化不回溯改变 held 奖励。

### 4.3 业务配置

在前置规格新增的 `registrationEnabled` 之外，本规格增加以下 SystemConfig。默认值仅为兼容发布值；生产切换必须按 §11 顺序执行。

| key | 默认 | 合法范围 | 语义 |
| --- | ---: | --- | --- |
| `emailVerificationRequiredForValue` | `0` | `0/1` | `1` 时启用 §5.1 的服务端资格门槛 |
| `growthRewardHoldDays` | `7` | `0..30` | 邮箱验证后注册/邀请奖励的统一冷静期；`0` 仅允许经显式管理员确认后即时释放 |
| `referralInviterMinAgeDays` | `30` | `0..365` | 邀请码可建立新关系前，邀请人账号至少存活天数 |
| `referralDailyQualifiedLimit` | `3` | `0..100` | 每邀请人每上海自然日最多 qualified 数；`0` 表示暂停后续邀请资格 |
| `referralLifetimeQualifiedLimit` | `20` | `0..10_000` | 每邀请人生命周期最多 qualified 数；`0` 表示暂停后续邀请资格 |

配置之间的不变量：`referralDailyQualifiedLimit ≤ referralLifetimeQualifiedLimit`，除非 daily 为 `0`；`growthRewardHoldDays=0` 只能在管理员确认对话框中明确展示“即时奖励会提高滥用风险”，但后端仍以配置值为准。

---

## 5. 功能与安全需求

### 5.1 邮箱交易资格门槛

| ID | 优先级 | 要求 |
| --- | --- | --- |
| REQ-F-001 | P0 | 新增 `requireVerifiedEmail`，在 `emailVerificationRequiredForValue=1` 且用户 `emailVerified=null` 时返回 `403 EMAIL_VERIFICATION_REQUIRED`。中间件必须查询当前数据库状态，不信任 JWT/前端 store。 |
| REQ-F-002 | P0 | 将该门槛挂在 `POST /api/orders`、`POST /api/points/checkin`、`POST /api/merchant/register`、订单评价 create/update、`POST /api/uploads/image`、`POST /api/uploads/delivery-file`。 |
| REQ-F-003 | P0 | 不将该门槛挂到登录、refresh、logout、`/auth/send-verification`、密码找回/重置、`GET /auth/me`、订单列表/详情、争议/close、订单文件下载 URL 或 checkout preview。 |
| REQ-F-004 | P0 | 前端按 `/auth/me` 的 `emailVerified` 在购买/签到/商家申请/上传入口提供可解释拦截与“发送验证邮件”主操作；直接 API 403 时也必须展示同一引导。 |
| REQ-F-005 | P1 | 现有未验证账号的 rollout 先保持开关 `0`；启用前至少 14 天展示不可永久关闭的轻提示。启用后支持工单化管理员积分/账号处理，但不提供无审计白名单 bypass。 |

### 5.2 公开注册与 Turnstile

| ID | 优先级 | 要求 |
| --- | --- | --- |
| REQ-F-010 | P0 | 注册 payload 增加严格、长度受限的 `turnstileToken`；保护启用时缺失 token 返回 `400 HUMAN_VERIFICATION_REQUIRED`，不得创建任何注册相关行。 |
| REQ-F-011 | P0 | 后端 verifier 只请求固定 Cloudflare siteverify URL；3 秒总超时；验证 `success=true`、`action==='register'`、hostname 精确属于 `TURNSTILE_ALLOWED_HOSTNAMES`。不能接受客户端提交的 hostname、action 或 provider URL。 |
| REQ-F-012 | P0 | 失败/过期/重复 token 返回 `403 HUMAN_VERIFICATION_FAILED`；provider/网络/配置故障返回 `503 HUMAN_VERIFICATION_UNAVAILABLE`。两者均不暴露 provider 原始错误码、token 或响应体。 |
| REQ-F-013 | P0 | `GET /api/auth/registration-status` 在保持 `registrationEnabled` 兼容的前提下，新增 `registrationAvailable` 与安全的 `challenge` 描述符。只有可用时返回 `{ provider:'turnstile', siteKey }`；它绝不返回 secret、host、Redis/SMTP 细节。 |
| REQ-F-014 | P0 | 登录页仅在 `registrationAvailable=true` 时提供注册入口；Turnstile 使用 managed/invisible 模式，挑战失败时可刷新重试，不把技术错误误称“平台暂停注册”。 |
| REQ-F-015 | P1 | `turnstileToken`、provider 响应、secret、siteverify request body 进入 Pino/Sentry/AdminLog/数据库/浏览器持久化任一处即为安全缺陷。 |

### 5.3 Redis 共享限流

所有数值均为 v1 固定安全阈值；不在管理员 UI 暴露为可任意调高的配置。key 仅使用 HMAC-SHA-256 后的规范化 IP/邮箱或数值 user id，带 `CACHE_KEY_PREFIX:abuse:v1` 前缀。

| 流程 | 维度 | 窗口与上限 | 消耗时机 |
| --- | --- | --- | --- |
| 注册 provider 预检 | IP | 20 / 10 分钟 | 验证 Turnstile 前；抑制 provider 打点攻击 |
| 注册成功尝试 | IP | 5 / 1 小时；20 / 24 小时 | Turnstile 通过后、bcrypt/DB 写前；失败的业务校验也消耗 |
| 注册 | 规范化邮箱 | 2 / 24 小时 | Turnstile 通过后、DB 写前 |
| 验证邮件 | userId | 1 / 60 秒；5 / 24 小时 | 解析认证后、创建 token/SMTP 前 |
| 验证邮件 | 邮箱 hash | 1 / 60 秒；5 / 24 小时 | 同上 |
| 验证邮件 | IP | 10 / 1 小时；30 / 24 小时 | 同上 |
| 密码重置 | 邮箱 hash | 1 / 60 秒；5 / 24 小时 | 用户查找/SMTP 前；不存在邮箱也消耗 IP bucket |
| 密码重置 | IP | 10 / 1 小时；30 / 24 小时 | schema 校验后 |
| 待验证邀请码关系 | inviterId | 6 / 上海自然日 | 建 relation 前；满额时账号仍可注册但不绑定 invite relation |

| ID | 优先级 | 要求 |
| --- | --- | --- |
| REQ-F-020 | P0 | 所有 bucket 必须用单个 Redis Lua 原子 `INCR + 首次 PEXPIRE + PTTL` 实现；返回可安全展示的 retry-after 秒数。不得用 `INCR` 后另一次 `EXPIRE`。 |
| REQ-F-021 | P0 | 强制保护启用后，Redis client 缺失、熔断或命令超时返回 `503 ABUSE_PROTECTION_UNAVAILABLE`。注册、验证邮件、密码重置均不得继续到 bcrypt、数据库 token 或 SMTP。 |
| REQ-F-022 | P0 | 前置 provider 预检若限流，直接返回 `429 RATE_LIMITED`，不调用 Turnstile；其余 bucket 命中也不得调用后续副作用。 |
| REQ-F-023 | P0 | `NODE_ENV=test` 不得自动跳过此 limiter；测试必须通过注入 fake Redis 或真实隔离 Redis 精确验证。开发环境可显式使用 `ABUSE_PROTECTION_MODE=off`，生产禁止 off。 |
| REQ-F-024 | P1 | 响应对注册/验证邮件可提示“操作过于频繁，请稍后重试”，不得返回命中的维度、剩余额度、原始 IP/邮箱或邀请码状态。 |

### 5.4 用户邮件与验证证明

| ID | 优先级 | 要求 |
| --- | --- | --- |
| REQ-F-030 | P0 | 验证邮件每次请求使此前未使用验证 token 失效，并只在全部 limiter 通过后生成一个新 token。SMTP `send()` 前后错误不泄露 token、邮箱、provider 原始报文。 |
| REQ-F-031 | P0 | 邮件链接为 `${APP_BASE_URL}/verify-email#token=<raw>`；fragment 不发送给 HTTP server。前端读取后立即 `history.replaceState` 清除 fragment，并只在内存中短暂保留 token。 |
| REQ-F-032 | P0 | 新 `POST /api/auth/verify-email` 必须 `authenticate + requireActiveUser`，body 严格仅 `{ token }`；原子 claim 要求 token 未使用、未过期且 `token.userId === req.user.userId`。`GET /api/auth/verify-email` 永远不得改变验证状态；上线前已发送的 query 链接只允许前端在一个 token TTL 的过渡窗口内读取后立即清除 URL，并仍走同一认证 POST，过渡期后提示用户重新发送。 |
| REQ-F-033 | P0 | 密码重置保持“无论邮箱存在与否均返回同一 200 文案”；若其邮箱/user/IP bucket 命中、Redis 不可用或 SMTP 异常，HTTP 外观不得变为邮箱存在性 oracle。内部仍可记录受控指标/事件。 |
| REQ-F-034 | P0 | 验证 token、重置 token、邮箱明文、SMTP password、邮件正文不得写入审计/结构化日志/Sentry；管理员只可看脱敏地址或聚合数据。 |
| REQ-F-035 | P1 | 生产发布门禁在 `emailVerificationRequiredForValue=1` 前验证 SMTP real delivery；console mailer、`deliveryReady=false` 或 provider send failure 不得被误判为“已发信”。 |

### 5.5 邀请资格与奖励账务

| ID | 优先级 | 要求 |
| --- | --- | --- |
| REQ-F-040 | P0 | 注册创建 `PointAccount` 但余额为 0；不再在注册事务内直接写注册/邀请积分 `PointLog`。 |
| REQ-F-041 | P0 | 注册事务为每个新用户创建一条 `GrowthReward(kind='registration', state='pending_verification')`，金额快照为当前 `registerReward`，`dedupeKey='registration:<userId>'`。 |
| REQ-F-042 | P0 | 邀请码只有在邀请人已验证、状态正常、账户年龄满足配置且 referral 未暂停时才建立 `InviteRelation(state='pending_verification')`；否则注册成功但不建立关系或奖励。 |
| REQ-F-043 | P0 | 验证邮箱事务内：将注册奖励转为 `held`，设 `availableAt=verifiedAt+growthRewardHoldDays`；邀请 relation 以 inviter 行锁检查额度，成功则转 `qualified` 并创建一条 inviter `GrowthReward(kind='referral', state='held')`，否则转 `quota_exhausted`。 |
| REQ-F-044 | P0 | 定时任务只认 `held && availableAt<=now` 的奖励；以 `GrowthReward` 条件更新 claim 后，在同一数据库事务原子增加 `PointAccount`、写 `PointLog`、标记 `grantedAt`。任何一次 race/retry 至多发放一次。 |
| REQ-F-045 | P0 | 若 user 被封禁、邀请码资格被暂停或管理员在释放前作废，关联 held/pending 奖励转 `voided`，绝不入账；已 `granted` 奖励不可由本模块自动扣回。 |
| REQ-F-046 | P1 | Profile 邀请区显示资格状态、剩余额度仅以粗粒度文案呈现（如“今日邀请资格已用完”），不展示内部风控分数、IP 或完整被邀请邮箱。 |

### 5.6 运营、审计与可观测性

| ID | 优先级 | 要求 |
| --- | --- | --- |
| REQ-F-050 | P0 | 新增 `AbuseEvent` 受控词表：注册拒绝/限流、challenge 失败/不可用、邮件节流、验证成功、邀请 qualified/quota_exhausted、奖励 granted/voided、邀请码暂停/恢复。普通成功请求只记 Prometheus 指标，避免把高流量日志表当计数器。 |
| REQ-F-051 | P0 | `AbuseEvent` 只存 `userId`/`inviterId`/`inviteeId` 等关系 ID、HMAC IP/邮箱关联值、固定 rule code 和安全 JSON；不存原始 IP、邮箱、UA、token、CAPTCHA 响应或自由文本。默认保留 90 天，由租约 cron 清理。 |
| REQ-F-052 | P0 | 管理员 MFA 路由提供 overview、受控列表、邀请码资格暂停/恢复、held/pending reward 作废。所有动作必须 `caseRef`（格式沿用安全事件的工单格式）、写 AdminLog 和 AbuseEvent；不能直接改积分余额或手工发放奖励。 |
| REQ-F-053 | P0 | overview 至少展示 1h/24h 注册尝试/接受/拒绝、challenge 失败、验证邮件发送/节流、未验证账户、邀请 pending/qualified/quota-exhausted、held/granted/voided 奖励。 |
| REQ-F-054 | P1 | Prometheus 指标只用固定低基数标签（flow/outcome/reason）；严禁 userId、email hash、IP hash、邀请码或 provider error message 作为 label。 |

---

## 6. 数据模型与迁移要求

字段名为实现建议；实际 Prisma schema 以 migration review 为准。

| 模型 | 拟议字段 / 约束 | 用途 |
| --- | --- | --- |
| `User` | `referralSuspended Boolean @default(false)`；保留现有 `inviteCode` / `emailVerified` | 不改变用户现有邀请码；管理员可停止其后续邀请资格 |
| `InviteRelation` | `status String @default('legacy')`、`qualifiedAt`、`voidedAt`、`qualificationDay String?`；索引 `[inviterId,status,qualifiedAt]` | 历史 relation 明确为 legacy；新 relation 走 pending/qualified 状态机 |
| `GrowthReward` | `recipientUserId`、`inviteRelationId? @unique`、`kind`、`amount`、`state`、`availableAt?`、`grantedAt?`、`voidedAt?`、`voidReason?`、`dedupeKey @unique`、timestamps；索引 `[state,availableAt]` | 正常化 held 奖励，保证 exactly-once 账务 |
| `AbuseEvent` | `type`、可选 user/inviter/invitee relation、`ipHash?`、`emailHash?`、`detailSafe?`、`createdAt`；索引 `[type,createdAt]`、`[inviterId,createdAt]` | 可解释的风险/运营证据，90 天留存 |

迁移不变量：

1. 既有 `InviteRelation` 统一 backfill 为 `legacy`；不创建 `GrowthReward`、不改变 PointAccount/PointLog。
2. 新字段默认必须使旧 API 在 `emailVerificationRequiredForValue=0` 时兼容运行；绝不根据 migration 时间自动发奖励。
3. `GrowthReward` 的 `dedupeKey`、`InviteRelation.inviteeId` 与条件 claim 共同保证重复请求不会产生双倍积分。
4. 所有 migration 仅用 `prisma migrate dev` 在显式、隔离数据库生成；绝不手写或事后修改 migration SQL。

---

## 7. API 契约

### 7.1 公开和认证接口

| 方法 | 路径 | 契约 |
| --- | --- | --- |
| GET | `/api/auth/registration-status` | 扩展为 `{ registrationEnabled, registrationAvailable, challenge: null | { provider:'turnstile', siteKey } }`；无缓存、无 secret |
| POST | `/api/auth/register` | 既有 `{ email,password,inviteCode? }` 加 `{ turnstileToken? }`；启用保护时 token 必须有效 |
| POST | `/api/auth/send-verification` | 已登录活动用户；Redis 多维 limiter 后创建/发送一个验证 token |
| POST | `/api/auth/verify-email` | 已登录活动用户，严格 `{ token }`；token 必须属于当前 user |
| GET | `/api/auth/verify-email?token=` | 返回受控过渡/失效响应，绝不改 DB 状态；不得把 token 重定向、回显或写日志 |
| POST | `/api/auth/forgot-password` | 保持 generic 200；内部受 Redis 多维 limiter 和 SMTP 保护 |

### 7.2 管理员风控接口

全部在现有 `authenticate → requireActiveUser → requireAdmin → requireAdminMfa` 后。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/admin/abuse/overview?window=1h\|24h` | 低基数聚合指标，不返回原始标识 |
| GET | `/api/admin/abuse/referrals?state=&q=&page=` | 邀请关系安全投影，邮箱默认打码 |
| GET | `/api/admin/abuse/rewards?state=&userId=&page=` | held/pending/granted/voided 奖励安全投影 |
| PUT | `/api/admin/abuse/users/:id/referral-suspension` | `{ suspended:boolean, caseRef }`；停止/恢复未来邀请码资格 |
| POST | `/api/admin/abuse/rewards/:id/void` | `{ caseRef }`；仅 `pending_verification` / `held` 可作废 |

### 7.3 错误语义

| 场景 | HTTP / code | 副作用 |
| --- | --- | --- |
| 未验证高价值操作 | `403 EMAIL_VERIFICATION_REQUIRED` | 零业务写入 |
| 缺少 CAPTCHA token | `400 HUMAN_VERIFICATION_REQUIRED` | 零注册写入 |
| CAPTCHA 无效 | `403 HUMAN_VERIFICATION_FAILED` | 零注册写入 |
| CAPTCHA/Redis 不可用 | `503 HUMAN_VERIFICATION_UNAVAILABLE` / `ABUSE_PROTECTION_UNAVAILABLE` | 零账号、token、邮件、积分写入 |
| 任一 abuse bucket 命中 | `429 RATE_LIMITED`（reset 保持 generic 200） | 不触发后续 mailer/DB/Turnstile 副作用 |
| 已使用/失效/不属于当前用户的验证 token | `400 BAD_REQUEST` 通用消息 | 不改变 `emailVerified` |
| 邀请资格满 | 注册/验证本身仍成功；relation 安全转为 `quota_exhausted` | 不发邀请奖励 |
| 运营作废已 granted 奖励 | `409 CONFLICT` | 不改积分；引导走现有人工积分调整流程 |

---

## 8. UI / UX 要求

1. 注册页先取 `registration-status`。`registrationEnabled=false` 显示前置规格定义的暂停文案；`registrationAvailable=false` 显示“注册服务暂不可用，请稍后重试”，不得错误归因于管理员关闭。
2. Turnstile 使用无感 widget；用户按“注册”后才取 token。失败时只显示可行动文案“请完成安全验证后重试”，提供刷新 challenge 的按钮，不展示内部 provider 错误。
3. 未验证状态使用现有邮箱 banner 升级为不可永久忽略的资格提示：它可在当前页关闭视觉提示，但在被拦截的高价值动作处必须重新出现。按钮至少 40px 触控目标。
4. 被拦截购买时保留用户已填写的**本地**非敏感表单；绝不把密码、Turnstile token 或邮箱验证 token 写 localStorage、URL、analytics 或日志。
5. 验证邮件发送成功显示冷却提示；限流时显示服务端通用 message。验证页面从 fragment 读取 token 后立即清 URL；未登录时只引导其登录后重新发送验证邮件，不跨页面持久化 token。上线前已发 query 链接仅在一个 token TTL 的过渡窗口内按同一方式清除并认证 POST。
6. Profile 邀请区不承诺“每邀请必得积分”；显示“完成邮箱验证并通过资格期后发放”，并在暂停/额度满时给出简短状态。
7. AdminPage 使用独立 `AbuseProtectionPanel`，不改移动端导航/安全区组件；长列表必须分页，任意敏感标识仅显示脱敏版本。

---

## 9. 非功能需求

| ID | 类别 | 需求 |
| --- | --- | --- |
| REQ-NF-001 | 安全 | 任何安全判断以服务端数据库/Redis/Turnstile 结果为准；前端状态、JWT claim、请求 header 和客户端时间均不是授权依据。 |
| REQ-NF-002 | 隐私 | HMAC key 使用独立 `ABUSE_HASH_KEY`，生产必须为 32+ 随机字节 Secret；不得复用公开 site key，优先不复用 JWT secret。 |
| REQ-NF-003 | 可用性 | 反滥用 Redis fail-closed 仅影响注册和用户邮件发送；已登录交易在用户已 verified 后不依赖 Redis。 |
| REQ-NF-004 | 并发 | 验证 token claim、邀请码额度、GrowthReward grant/void 必须用真实 PostgreSQL transaction 与条件更新/锁验证，不接受仅靠 JS mutex 的证明。 |
| REQ-NF-005 | 性能 | Turnstile 调用总超时 3s；Redis 命令沿用现有短超时；运营聚合走有索引的时间范围查询，禁止对全量 AbuseEvent 在应用内扫描。 |
| REQ-NF-006 | 可观测 | 记录固定 outcome 指标、Redis 不可用计数、Turnstile 延迟；不产生高基数 Prometheus labels。 |
| REQ-NF-007 | 测试性 | verifier、clock、mailer、Redis limiter、cron lease 均可注入/隔离；测试不访问真实 Turnstile 或真实 SMTP。 |
| REQ-NF-008 | 兼容 | 已有客户端不携带 Turnstile token 时，仅在保护开关实际启用后才被拒绝；历史 query 验证链接只在一个 token TTL 的前端过渡窗口内可认证完成，服务端 GET 永不匿名验证。 |

---

## 10. 验收标准

### AC-01 未验证交易门槛

**Given** `emailVerificationRequiredForValue=1` 的未验证、状态正常用户
**When** 其直接调用创建订单、签到、商家申请、评价写入或上传接口
**Then** 每个接口返回 `403 EMAIL_VERIFICATION_REQUIRED`，对应 Order/Checkin/PointLog/Merchant/Review/Storage 写入均为零；其仍可登录、请求验证邮件、查看和处理已有订单。

### AC-02 真人注册与 CAPTCHA

**Given** 公开注册开启且 Turnstile 可用
**When** 请求缺 token、带错误 action/hostname/token、或重复使用 token
**Then** 不创建 User/PointAccount/InviteRelation/GrowthReward/RefreshToken；只有正确 verifier 结果才可进入注册事务。

### AC-03 Redis 多实例一致性与故障

**Given** 两个 API 实例共享同一 Redis
**When** 并发越过任一注册或邮件 bucket 上限
**Then** 总成功数不超过上限，余者不触发下游副作用；Redis 断开时注册和用户邮件请求受控失败且不写副作用。

### AC-04 邮件防滥发与验证持有证明

**Given** 攻击者已用受害者邮箱注册但不控制其邮箱
**When** 其反复请求验证邮件，或邮箱扫描器访问邮件链接
**Then** 请求受多维额度限制；匿名访问链接不验证账号；只有持有该账号已登录会话的用户能 claim token。密码重置对存在/不存在邮箱保持相同 HTTP 外观。

### AC-05 邀请配额与奖励恰一次

**Given** 一个已合格邀请码只剩一个日额度，多个 invitee 并发完成验证
**When** 所有验证请求完成并奖励 cron 重复运行
**Then** 至多一个 relation 为 `qualified`，其余为 `quota_exhausted`；每个 `GrowthReward` 和对应 PointLog 最多一条，账户余额与流水一致。

### AC-06 冷静期与历史兼容

**Given** 新注册用户已验证但 `growthRewardHoldDays=7`
**When** 冷静期前后分别运行 reward cron
**Then** 前期不入账、到期后恰好入账一次；migration 前的 InviteRelation 皆为 `legacy`，绝不生成新奖励或改变历史余额。

### AC-07 运营处置与隐私

**Given** MFA 管理员查看 overview 并暂停邀请码资格/作废 held 奖励
**When** 刷新页面或查询审计
**Then** 能看到受控状态和 caseRef；新邀请被拒绝、待发奖励不再入账；API、AdminLog、AbuseEvent、日志和指标不含 raw IP、完整邮箱、token、Turnstile secret 或 SMTP secret。

### AC-08 发布与回滚

**Given** staging 真实 SMTP、Redis 与 Turnstile 已通过受控演练
**When** 按 §11 逐步启用开关并发生需要回退的异常
**Then** 可先关闭公开注册或将 `emailVerificationRequiredForValue` 回退为 `0`，而不删除 migration、不清空 ledger、不重新开放已被暂停的邀请码资格或重复发奖。

---

## 11. 发布与回滚

1. 先合入/部署前置注册开关与邮件运营面，保持注册默认开启。
2. 部署本规格的 schema、后端和前端，但保持 `emailVerificationRequiredForValue=0`；此时新注册奖励已进入 held 路径，因此在切流前将 `registerReward`/`inviteReward` 的产品文案同步为“验证后发放”。
3. 配置并验证 Redis、`ABUSE_HASH_KEY`、Turnstile、真实 SMTP；运行 staging 的真实浏览器 + SMTP catcher 演练。生产不满足 A-02/A-03/A-04 时不得开启公开注册保护。
4. 启用 Turnstile/Redis 强制保护，监控至少 24 小时的 register、challenge、mail、Redis 指标。
5. 先对既有未验证用户展示至少 14 天验证提醒，再将 `emailVerificationRequiredForValue=1`。
6. 如 CAPTCHA/Redis 出现事故，优先把 `registrationEnabled=0` 暂停新注册；如需恢复既有未验证用户交易，只回退 `emailVerificationRequiredForValue=0`，不删除数据、不绕过邮件 limiter。
7. 已 granted 的奖励账务只通过既有管理员积分调整和工单处理；不得 SQL 删除/重写 `GrowthReward` 或 PointLog。

---

## 12. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-08-01 | 初版：将邮箱交易资格、Turnstile、Redis 限流、邮件防滥发、邀请码额度、延迟奖励和运营闭环统一定义。 |
