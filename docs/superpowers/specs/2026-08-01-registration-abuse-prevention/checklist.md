# Checklist: 注册、激励与邮件反滥用闭环完成定义

| 字段 | 值 |
| --- | --- |
| 文档 ID | `CHK-RAP-001` |
| 版本 | `1.0.0` |
| 状态 | `Code-level evidence and CI validation recorded; staging/release gates remain pending` |
| 规格 | [spec.md](./spec.md) |
| 实施协议 | [implement.md](./implement.md) |

> P0 未全部勾选不得合并。每一项应附命令、测试名、PR/CI URL 或 staging 演练证据；“代码已写”“理论上可行”“本地没有报错”不是证据。

### 当前本地证据（不替代 P0 勾选）

- 隔离库仅为 `/monexus_rap_test`；reset/replay/status 显示 47 个 migration、schema up to date，临时 shadow database 的 migration→datamodel diff 为 `No difference detected` 后已删除；
- `npm --prefix server run build`、`npm run build` 均通过；
- `growth-rewards`、`rap-admin-abuse`、`registration-auth-flow`：20/20 通过；
- `registration-abuse-prevention.spec.ts`：5/5 Chromium 场景通过；
- `git diff --check` 与 OpenAPI JSON parse 通过。
- GitHub Actions [CI #30683242294](https://github.com/amo0114/MoNexus/actions/runs/30683242294) 通过：backend 102 files / 863 tests、Playwright 85 passed、frontend build 与 `CI OK` 全绿。

以下清单仍保持 gate 语义：CI 证据已补齐；真实 staging 演练和 release owner 仍必须补齐，尤其是 CHK-REL-*；不得把本地 mock 或 test adapter 当作生产证据。

---

## 1. Process / 前置条件（P0）

- [ ] **CHK-PROC-01** `SPEC-OPS-REGMAIL-001` 已合入 latest `develop`；`registrationEnabled`/mail status 契约和其测试均存在。
- [ ] **CHK-PROC-02** 实现分支在 latest `develop` 上创建/rebase；没有从 mobile UI worktree 复制未提交变更。
- [ ] **CHK-PROC-03** `schema.prisma`、migration、auth service 各有单一 owner；`AdminPage.tsx` 前端集成发生在移动端 PR 合入之后。
- [ ] **CHK-PROC-04** 所有任务对应 [task.md](./task.md) ID、spec requirement 和 reviewer 证据；无未说明的 scope expansion。
- [ ] **CHK-PROC-05** 无 `.env`、provider token、SMTP credential、真实 HMAC key、真实邮箱 fixture、Turnstile response 或截图秘密进入 git diff。

## 2. 配置、Redis 与 Turnstile（P0）

- [ ] **CHK-CONF-01** `ABUSE_PROTECTION_MODE`、`ABUSE_HASH_KEY`、Turnstile site/secret/hostname 配置均通过 schema；production `off` 或任一缺失/非法值在启动前失败。
- [ ] **CHK-CONF-02** production `enforce` 同时要求 `REDIS_ENABLED=true` 和 `REDIS_REQUIRED=true`；本发布的单机 Redis 必须认证、仅 Compose 私网可达并启用 AOF `everysec`。不部署 Sentinel/副本，不得表述为 HA；Redis 或主机故障时注册与用户邮件路径 fail-closed。部署 preflight 与运行时的判断一致。
- [ ] **CHK-CONF-03** site key 仅在 `registration-status.challenge` 的白名单 DTO 中出现；secret、hostname 内部细节、Redis/SMTP config 永不返回。
- [ ] **CHK-CONF-04** logger/Sentry/AdminLog/AbuseEvent/metrics 对 turnstileToken、Turnstile secret、ABUSE_HASH_KEY、SMTP secret 和验证/重置 token 的金丝雀测试全部通过。
- [ ] **CHK-CONF-05** `abuseLimiter` 使用单个 Lua `INCR + PEXPIRE + PTTL`，没有 `INCR`/`EXPIRE` 分离 race、MemoryStore、process Map 或 Redis fail-open fallback。
- [ ] **CHK-CONF-06** 所有 bucket 使用 HMAC/数值 user ID，key 带 versioned prefix；未将 raw email/IP/invite code 用作 Redis key 或 Prometheus label。
- [ ] **CHK-CONF-07** Redis command timeout、circuit open、disabled client、malformed eval 返回均产生受控 503 与零后续副作用。
- [ ] **CHK-CONF-08** verifier 使用固定 endpoint 和 3 秒总 timeout，严格验证 success/action/hostname；不存在 header/query/环境 bypass。
- [ ] **CHK-CONF-09** verifier rejects/unavailable 分类和 HTTP semantics 精确符合 `HUMAN_VERIFICATION_FAILED` / `HUMAN_VERIFICATION_UNAVAILABLE`。

## 3. 注册与邮件反滥用（P0）

- [ ] **CHK-REG-01** `registrationEnabled=false` 仍先于 bcrypt/DB/session 拒绝；本规格新增 guard 未破坏前置注册总开关语义。
- [ ] **CHK-REG-02** 注册的 preflight IP bucket 在 provider 调用前执行；其余 registration IP/email buckets 在 provider success 后、bcrypt/DB 写前执行。
- [ ] **CHK-REG-03** 所有缺 token、invalid/reused token、action mismatch、hostname mismatch、bucket hit、Redis unavailable、verifier unavailable 的路径均使 User、PointAccount、InviteRelation、GrowthReward、RefreshToken 零增。
- [ ] **CHK-REG-04** 跨两实例/并发 bucket 测试证明每个窗口累计允许数不超过规格数值；TTL/Retry-After 边界没有 off-by-one。
- [ ] **CHK-REG-05** 验证邮件 user/email/IP 三维额度和密码重置 email/IP 三维额度均在 token DB/SMTP 前执行；每个超限路径 CaptureMailer 调用数为 0。
- [ ] **CHK-REG-06** 新验证邮件原子作废此前未使用 token；重试不留下多个可用 token。
- [ ] **CHK-REG-07** reset-password 对已有、未知、封禁、限流、Redis unavailable、SMTP error 的公开 HTTP 形态不能作为邮箱存在性 oracle；内部不向攻击者透出原因。
- [ ] **CHK-REG-08** 验证邮件链接使用 `#token`；fragment 在页面加载后被立即移除；token 不在 URL query、storage、analytics、console、trace 或 screenshot。
- [ ] **CHK-REG-09** 匿名/错误用户访问 verify token 均不改变 `emailVerified`；仅 token 所属用户的 authenticated POST 能原子成功一次。
- [ ] **CHK-REG-10** legacy GET verification 路径不再直接写验证状态，且其过渡行为不会泄露 token 或创建邮件/奖励副作用。

## 4. 邮箱资格门槛（P0）

- [ ] **CHK-GATE-01** `emailVerificationRequiredForValue=0` 时新中间件完全兼容；为 1 时仅读取数据库当前 `emailVerified`，不信任前端/JWT 缓存。
- [ ] **CHK-GATE-02** 未验证用户创建订单返回 `403 EMAIL_VERIFICATION_REQUIRED`，且没有 Order、库存、积分、幂等记录或外呼副作用。
- [ ] **CHK-GATE-03** 未验证用户签到返回 403，CheckinRecord、PointAccount、PointLog 均零增。
- [ ] **CHK-GATE-04** 未验证用户商家申请、评价 create/update、图片上传、交付文件上传均返回 403 且各自表/对象存储无副作用。
- [ ] **CHK-GATE-05** 登录、refresh、logout、密码找回/重置、发送/完成邮箱验证、`/auth/me`、商品浏览、checkout preview、订单读/争议/close/文件下载仍按既有权限可用。
- [ ] **CHK-GATE-06** 用户验证成功、刷新 profile 后受保护动作恢复；因 API 403 的 UI 引导不会绕过 server guard。

## 5. 邀请、奖励与账务（P0）

- [ ] **CHK-RWD-01** 新注册只建立 `PointAccount(balance=0)` 和 registration `GrowthReward(pending_verification)`；不立即创建注册/邀请 PointLog 或提高返回 points。
- [ ] **CHK-RWD-02** 新 reward 的金额及邀请 tier 结果在注册时快照；后续 SystemConfig/tier 改动不改变该 held reward。
- [ ] **CHK-RWD-03** 只有正常、已验证、达到账户年龄、未 referralSuspended 的邀请人代码能建立 pending relation；无效/不合格 code 不阻止基本注册也不创建邀请奖励。
- [ ] **CHK-RWD-04** 注册时 pending invite relation 的日 cap、验证时 qualified 日/生命周期 cap 均有效；`0` cap 表示暂停资格且不产生奖励。
- [ ] **CHK-RWD-05** 同一 invitee 至多一条 relation；同一 GrowthReward dedupeKey/InviteRelation 至多一条 reward，即使注册/验证/重试并发。
- [ ] **CHK-RWD-06** 最后一个邀请码额度的真实 PostgreSQL 并发场景中至多一个 relation qualified；其余安全地转 quota_exhausted，自己验证和注册 reward 不被错误阻断。
- [ ] **CHK-RWD-07** `growthRewardHoldDays` 前 cron 不入账；到期 cron 在一个 transaction 内只增加一次 balance、只写一次 PointLog、只标一次 granted。
- [ ] **CHK-RWD-08** cron retry、进程重启、两个 worker、管理员 void 与 cron race 后，余额和 PointLog 与 granted rewards 一致；没有双发/负余额。
- [ ] **CHK-RWD-09** ban、referral suspension 或管理员 void 仅改变 pending/held reward；已 granted 返回 conflict，不能由此模块自动改历史 PointLog。
- [ ] **CHK-RWD-10** migration 前的所有 InviteRelation 为 legacy；应用/重放 migration 后旧 PointAccount/PointLog 数量与余额不变，绝不补发奖励。
- [ ] **CHK-RWD-11** growth reward cron 使用 DB lease 和 `FOR UPDATE SKIP LOCKED`，每批失败回滚、停止流程干净；AbuseEvent retention 只删 90 天前事件。

## 6. 审计、运营与隐私（P0）

- [ ] **CHK-OPS-01** AbuseEvent vocabulary/detail serializer 为封闭集合；未知 type、未知 detail key、自由文本 error 或原始标识被拒绝。
- [ ] **CHK-OPS-02** 安全事件只含 IDs、HMAC hash、fixed rule reason、受控 count/caseRef；没有 raw IP/email/UA/token/provider payload。
- [ ] **CHK-OPS-03** Prometheus metrics 使用固定低基数 flow/outcome/reason；静态/运行测试证明无 user/email/IP/code label。
- [ ] **CHK-OPS-04** 所有 `/api/admin/abuse/*` 路由均要求真实 admin MFA；匿名、普通用户、未完成 MFA 管理员全被拒。
- [ ] **CHK-OPS-05** overview / referral / reward projection 分页、过滤和 mask 正确；不暴露完整邮箱、raw hashes、token、credentials 或内部 stack。
- [ ] **CHK-OPS-06** suspend/restore referral 和 void pending/held reward 均要求合法 caseRef、确认语义、单飞；每个成功/失败动作产生 AdminLog 和 AbuseEvent。
- [ ] **CHK-OPS-07** admin 不能借 `/abuse` API 增减积分、批准已无资格邀请、重复发放 reward、void granted reward 或绕过 email verification。

## 7. 前端 UX 与可访问性（P0）

- [ ] **CHK-FE-01** 登录页根据 public status 正确区分 registration disabled、available、provider/static unavailable；不把技术不可用提示为管理员暂停。
- [ ] **CHK-FE-02** Turnstile managed flow 完成后才提交 token；失败可重试；token 不持久化、不泄露；旧前端直接注册仍被 server 拦截。
- [ ] **CHK-FE-03** 注册成功文案、Profile 邀请卡和其他营销文字不再承诺“立即赠送/每注册必得”；清楚说明验证和资格期。
- [ ] **CHK-FE-04** EmailVerificationBanner 可发送、loading、冷却、失败恢复正确；用户在被 gate 的购买/签到/入驻/上传动作中必能重新发现验证入口。
- [ ] **CHK-FE-05** VerifyEmailPage 清除 fragment；未登录用户被指引先登录并重新发送验证邮件，不能匿名或跨账户完成验证。
- [ ] **CHK-FE-06** 403 `EMAIL_VERIFICATION_REQUIRED` 的 local UX 保留非敏感已填字段，不存密码/token，不产生重复下单。
- [ ] **CHK-FE-07** Admin abuse panel 保留移动端 safe-area/粘性布局；375px/desktop 无横向溢出，按钮/开关/确认控件触控目标 ≥40 CSS px，键盘可操作。
- [ ] **CHK-FE-08** 不修改/放宽 `e2e/mobile-ui-polish.spec.ts`、`e2e/mobile-regression.spec.ts` 或已有移动几何契约。

## 8. QA、构建与文档（P0）

- [ ] **CHK-QA-01** targeted auth/limiter/verifier/mail/gate/reward/admin suites全绿，且 test mode 没有自动跳过 abuse limiter。
- [ ] **CHK-QA-02** 真实 PostgreSQL 对 token claim、邀请码最后名额、cron/void 并发有 Promise-barrier/row-lock 证明；不使用 sleep/mock 代替。
- [ ] **CHK-QA-03** 专用 Redis 测试覆盖 Lua atomicity、TTL、timeout/circuit、multi-instance semantics；没有 `FLUSHALL` 共享实例。
- [x] **CHK-QA-04** `npm --prefix server run build`、`npm --prefix server test`、`npm run build`、相关 Playwright 全绿（CI #30683242294：backend 102/863、Playwright 85 passed）。
- [x] **CHK-QA-05** Prisma `generate`、migration reset/replay/status/drift 在显式隔离的 `/monexus_rap_test` 全绿；migration SQL 未被手改。
- [x] **CHK-QA-06** 新 E2E 与所有既有移动套件并跑通过；用 mock Turnstile 和 CaptureMailer，不访问真实 provider（CI `npm run e2e`：85 passed）。
- [x] **CHK-QA-07** `git diff --check`、OpenAPI JSON parse、TypeScript strict checks 通过；CI OK 聚合 green（CI #30683242294）。
- [ ] **CHK-DOC-01** OpenAPI 覆盖 status/register/verify/admin abuse/error DTO；auth/admin README 同步。
- [ ] **CHK-DOC-02** env examples、preflight、secrets-management、runbook 记载 Redis/Turnstile/HMAC key、SMTP readiness、灰度、回滚与 incident SOP，且无真实值。

## 9. Staging 与发布（P0）

- [ ] **CHK-REL-01** staging 使用同一 Redis namespace、enforce mode、真实 Turnstile staging host和 SMTP catcher；ready/metrics/alert 无异常。
- [ ] **CHK-REL-02** 演练：正常注册、challenge failure、Redis down、验证邮件节流、password reset generic response、verified purchase、unverified block、邀请码 cap、reward hold/release、admin void。
- [ ] **CHK-REL-03** 生产 SMTP 已经从 admin mail panel 验证 delivery ready；SPF/DKIM/DMARC 与 provider daily quota 由运维确认。
  - 2026-08-01 只读 Mailu 审计：应用到已配置 `587 + STARTTLS` SMTP 的 TCP/TLS
    和不投递的 Nodemailer 认证验证均通过，发件域对齐且 MX/SPF/DMARC/DKIM 路径
    存在，队列为空。待上线后的 MFA 管理员 Mail Panel 受控收件地址测试和每日额度
    确认，故本项保持未勾选。
- [ ] **CHK-REL-04** 在生产先开启 Turnstile/Redis protection，观察 24 小时，再依据通知窗口开启 `emailVerificationRequiredForValue=1`。
- [ ] **CHK-REL-05** 开关、报警阈值、值班 owner、用户支持话术和回滚责任人已记录；发布负责人已确认单机 Redis 的主机故障影响及恢复路径；不依赖个人记忆。
  - 2026-08-01：仓库负责人确认兼任 release/on-call/rollback 三个角色；用户支持
    owner、发布窗口和实际告警联络路径待补后才可勾选。
- [ ] **CHK-REL-06** 回滚演练只使用 registrationEnabled/verification value gate，不删除 migration/ledger/PointLog，不把 production abuse mode 改为 off。

## 10. P1（不阻塞 P0，但需明确跟踪）

- [ ] **CHK-P1-01** 风险事件保留期限可在后台只读展示，并有 data retention dashboard。
- [ ] **CHK-P1-02** 用户邀请页显示粗粒度冷静期倒计时和“今日资格已用完”状态。
- [ ] **CHK-P1-03** 增加 anomaly alert（如 challenge failure ratio、mail throttle spike、邀请码 quota exhaustion spike）到既有告警路由。
- [ ] **CHK-P1-04** 评估 transactional mail outbox/队列、provider suppression webhook 和一次性邮箱域名策略，另立规格后实施。

## 11. 合并前最终门闩

复制到 PR 描述：

```markdown
## DoD Gate (RAP)
- [ ] Process / isolation (CHK-PROC-*)
- [ ] Config / Redis / Turnstile (CHK-CONF-*)
- [ ] Registration & mail anti-abuse (CHK-REG-*)
- [ ] Verified-value gates (CHK-GATE-*)
- [ ] Referral / rewards / ledger (CHK-RWD-*)
- [ ] Operations / privacy (CHK-OPS-*)
- [ ] Frontend UX (CHK-FE-*)
- [ ] QA / migration / docs (CHK-QA-*, CHK-DOC-*)
- [ ] Staging / release (CHK-REL-*)
```

## 12. 豁免记录

| 检查项 | 原因 | 代偿控制 | 批准人 | 到期日 |
| --- | --- | --- | --- | --- |
| | | | | |

P0 默认不接受豁免。仅可由仓库负责人书面批准短期生产处置，且不得取消后端邮箱资格 gate、Redis fail-closed、Turnstile server verification 或账务幂等约束。

## 13. 修订记录

当前发布决定：单机 Redis 是已批准的生产拓扑；发布前验证 AOF、私网和 fail-closed 行为，不部署 Sentinel/副本。

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0.0 | 2026-08-01 | 初版完成定义、质量与发布门禁。 |
