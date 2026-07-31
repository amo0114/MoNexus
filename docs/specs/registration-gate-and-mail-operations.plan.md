# 实施计划：注册开关与邮件投递运营面

| 字段 | 值 |
| --- | --- |
| 关联规格 | SPEC-OPS-REGMAIL-001 (`registration-gate-and-mail-operations.md`) |
| 日期 | 2026-07-31 |
| 状态 | Plan Ready（R1 修订已并入）— 交实现 agent 按阶段 A→B 执行 |
| 修订 | R1 2026-07-31：按评审重定义 C3（就绪性/测试发送随实际生效 mailer，`from` 仅回显显式 `SMTP_FROM`）；移除 chattr +i 项（原 R6） |
| 分析来源 | Codex 会话 ×2（后端 `019fb843-…6531aa`；前端/集成 `019fb84c-…fed854`，Gemini 三次调用失败后由 Codex 替补）+ Claude 人工核对 |

## 1. 多模型分析综合结论

后端视角与前端/集成视角一致确认：规格整体可按原文落地，**无 Prisma migration**，但存在 15 处"规格假设 vs 实际代码"的出入，均已转化为下述明确约束；实现顺序必须是 **阶段 A（后端，先行）→ 阶段 B（前端，移动端提交后）**。

### 1.1 影响实现的关键代码事实（已核实）

| # | 事实 | 影响 |
| --- | --- | --- |
| F1 | `httpError.ts` 的 `forbidden()`/`conflict()` 固定发 `FORBIDDEN`/`CONFLICT` 码；`REGISTRATION_DISABLED`/`MAILER_NOT_CONFIGURED` 不存在 | 需新增 ErrorCode 成员 + 专用助手 |
| F2 | `config/index.ts:258` 存在 `smtpFrom = SMTP_FROM ?? SMTP_USER` 兜底 | 兜底 mailer 合法可用；MAIL-01 只约束**回显**——状态 `from` 字段绝不返回 `SMTP_USER`（见 C3） |
| F3 | 无共享 email schema；auth 的 `z.string().email()` 不 trim/lowercase；唯一可复用 maskEmail 在 reviews service | 需抽取 `server/src/lib/email.ts` |
| F4 | admin key 参数 schema 直接由 `systemConfigKeys` 派生（`z.enum`） | 注册表加 key 后 schema 自动更新，无需手改 |
| F5 | `assertSystemConfigValue(value)` 是全局"非负整数"校验，非 key-aware | 需改签名为 `(key, value)` 并对 `registrationEnabled` 限 0/1 |
| F6 | `system-config.test.ts` 与 `admin-query.test.ts:314-342` 硬编码了注册表默认值与分组白名单 | 新增 key/分组 `账户与注册` 必须同步更新这两处测试 |
| F7 | `__setMailerForTesting` 只换缓存 adapter，不改 `config.mailer.kind`；vitest 环境无 SMTP 变量 | 状态 DTO 测试需快照/恢复 `config.mailer`，发送测试用 CaptureMailer |
| F8 | 仓库限流约定：`NODE_ENV=test` 下 `skip: skipInTests` | 测试邮件 limiter 做成工厂 `createAdminMailTestLimiter({skipInTests})`，专项测试传 `false` |
| F9 | `app.ts` 全局 `/api` limiter 在 admin router 之前 | 公开状态接口"合理只读限流"由它满足；全局限流拒绝不在本特性审计范围 |
| F10 | 注册业务行与 refresh token 分两个事务；admin router 全局 `authenticate→requireActiveUser→requireAdmin→requireAdminMfa`（routes.ts:23） | gate 放 `registerUser()` 入口即可；mail 路由挂在该中间件之后即天然受 MFA 保护 |
| F11 | OpenAPI 文档只列 4 个 config key；前端 `AdminSystemConfigKey` 缺 8 个既有 key | 本次一并纠偏（契约同步任务） |
| F12 | `express-rate-limit` 为进程内 MemoryStore | 3 次/10 分钟为**每进程**语义；多副本部署前须换共享 store（见 R2） |
| F13 | AdminLog.detail 为无约束字符串，无 attempt/terminal 助手 | mailOperations 内集中做脱敏序列化 |
| F14 | Pino redact 列表未覆盖 `SMTP_USER`/`SMTP_PASS`/嵌套 mailer auth | 需补 redact 路径 |
| F15 | 前端无单测 runner；e2e/helpers.ts 提供真实密码+TOTP 的 `loginAs(admin)` | UI 状态覆盖放新 Playwright spec；后端语义归 Vitest/Supertest |

## 2. 已消解的决策点（实现约束，零模糊）

| ID | 决策点 | 约束（依据） |
| --- | --- | --- |
| C1 | 关闭注册与 400/429 的优先级 | 维持既有中间件顺序；`REGISTRATION_DISABLED` 的保证边界是"进入 `registerUser()` 的请求"。畸形请求可先 400、限流可先 429（REG-03 只要求创建数据前拒绝） |
| C2 | 数据库中被手工写坏的值（如 2） | fail-closed：`enabled ⇔ value === 1`；**缺行仍默认开启**（REG-01/REG-02） |
| C3 | `from` 与 `SMTP_USER` 兜底 | **R1 修订**：`deliveryReady` 与测试发送基于**实际生效 mailer**（`SMTP_FROM ?? SMTP_USER` 兜底合法可用），不因缺显式 `SMTP_FROM` 而拒绝；状态 `from` 仅在显式配置 `SMTP_FROM` 时返回，否则 `null`，绝不回显 `SMTP_USER`（MAIL-01 只约束回显，不约束使用）；UI 在就绪且 `from === null` 时提示「发件地址未公开展示；配置 SMTP_FROM 可显示」（已同步规格 §4.3/§5.2/§7.1） |
| C4 | `authConfigured` 语义 | `SMTP_USER && SMTP_PASS` 同时存在为 true；**不参与** `deliveryReady` 判定（免认证 relay 合法，规格 §4.3 原文） |
| C5 | limiter 配额消耗范围 | 挂在 MFA 鉴权之后、body 校验之前；已认证的每次 POST（含畸形、409、发送失败）都计数；key 为 `admin:<userId>`；窗口 10min、上限 3 |
| C6 | 限流审计范围 | 仅审计**专用 mail limiter** 的拒绝（收件人畸形时记 `[invalid]`）；全局 `/api` limiter 拒绝不在范围 |
| C7 | SMTP 副作用与审计的非原子性 | 出网前写脱敏 attempt 行（写失败则不发送）→ 发送 → 写 terminal 行（写失败返回 500）；同一 correlation id 关联；**不自动重试**，文档注明客户端重试可能重复发信 |
| C8 | 后端是否下发 UI 控件类型 | 不加 DTO 字段；前端按 key `registrationEnabled` 显式渲染 switch（规格 §5.2 允许项） |
| C9 | 测试邮件内容参数 | 主题固定 `MoNexus 邮件投递测试`；站点名固定字面量 `MoNexus`；时间 `new Date().toISOString()`（UTC）；纯文本、无链接 |
| C10 | 失败信息出口 | SMTP 错误分类为白名单码（EAUTH/ETIMEDOUT/ENOTFOUND/UNKNOWN）；HTTP 响应与 AdminLog 只含分类，不含原始 provider 报文/堆栈/收件人明文 |
| C11 | 登录页状态刷新时机 | mount 加载 + `focus`/`visibilitychange` 时 latest-wins 刷新；不做轮询；提交时 403 是最终竞态兜底（规格 §5.1 "状态刷新"的落地化） |
| C12 | 加载失败 vs 明确关闭 | 状态请求失败/加载中 = "unavailable"：隐藏注册入口但**不显示**"暂停注册"公告；公告仅在显式 `false` 时出现（避免误导访客） |
| C13 | 确认框不对称性 | 仅"关闭"需确认（规格只给了关闭文案）；开启直接保存 |
| C14 | 注册奖励"500 积分"硬编码文案 | 本特性不改：开启时保留现状，关闭时隐藏。文案与 `registerReward` 的既有漂移是独立债务，不在范围 |
| C15 | deliveryReady=false 的原因粒度 | 前端展示通用"配置不完整"提示；DTO 保持固定 5 字段，不加 reasonCode（规格 §4.3 字段封闭） |
| C16 | E2E 策略 | 新建 `e2e/registration-mail-operations.spec.ts`：真实 `loginAs(admin)`（密码+TOTP），特性端点用精确 pathname mock 覆盖 UI 状态矩阵；真实全局开关持久化/API 拒绝语义归后端 Supertest（改全局配置会与并行 auth 注册测试竞态） |
| C17 | 公开状态接口归属 | 按规格放 `GET /api/auth/registration-status`（auth 模块），不复用 `config/registry`；响应 `Cache-Control: no-store`，不挂 authLimiter，不鉴权 |
| C18 | 前端预认证请求 | `getRegistrationStatus` 走 `src/api/auth.ts` 既有 `skipAuthRefresh` 约定，不改 `client.ts`（避免过期 token 触发 refresh 消耗） |

## 3. PBT 性质（不变量 → 证伪策略）

### 后端

- [ ] P.1 **边界**：`registrationEnabled` 恰好接受整数 {0,1}；生成越界整数/小数/字符串/布尔/null/数组/对象打 PUT，任何非法值被持久化或合法值被拒即证伪
- [ ] P.2 **不变量保持**：关闭态下注册对 `User/PointAccount/PointLog/InviteRelation/RefreshToken` 行数零增且无 Set-Cookie/accessToken；生成随机合法注册载荷（含邀请码变体）对比快照
- [ ] P.3 **往返一致**：删行/PUT 0/PUT 1 任意序列后，DB 行、`getSystemConfigValue`、公开状态、admin 列表四者一致
- [ ] P.4 **单调性**：disable 提交成功响应之后开始的注册调用不可成功，直至下一次 enable；用事务 barrier 构造交叠验证（提交前已读到 1 的在途请求允许完成，REG-05）
- [ ] P.5 **白名单投影**：状态 DTO 序列化后键集合恰为 5 个规格字段，仅配 `SMTP_USER` 时呈 `deliveryReady: true, from: null`；注入 host/user/pass/token 金丝雀字符串（含 `SMTP_USER` 值本身），序列化结果含任一即证伪
- [ ] P.6 **幂等**：email 规范化二次应用不变；CaptureMailer 收到的地址恒为 trim+lowercase 规范形
- [ ] P.7 **边界**：limiter 每管理员每 10 分钟窗口至多 3 次、跨管理员独立、窗口过期恢复；在 599999/600000/600001ms 边界与多 admin 交错下验证
- [ ] P.8 **不变量保持**：每个终态（成功/失败/409/429）恰有脱敏 AdminLog；构造含唯一密钥标记的 Mailer 错误，扫描响应与审计字段无任何原始标记/明文地址

### 前端（Playwright 断言）

- [ ] P.9 **fail-closed**：注册入口可达 ⇔ 最新已接受状态为 enabled；loading/失败/畸形响应均隐藏；登录与忘记密码恒可达
- [ ] P.10 **公告独占**：暂停公告仅显式 false 出现（error→true、true→error、false→error 序列验证）
- [ ] P.11 **单调revocation**：新响应报 disabled 后，更早的延迟 enabled 响应不得重新打开注册 UI（乱序 resolve 构造）
- [ ] P.12 **竞态恢复**：表单打开后状态转 false 或提交得 403 → 回登录态、清邀请码、保留邮箱/密码、无会话建立
- [ ] P.13 **switch 忠实性**：`aria-checked` 与状态文字等于最后确认的服务端值；保存失败回读而非乐观残留；单飞（延迟+连点下恰一次 PUT）；Space/Enter 可切换
- [ ] P.14 **布尔不漏渗**：`registrationEnabled` 不出现在通用数字编辑器，也不产生空的 `账户与注册` 数字分组
- [ ] P.15 **邮件面板白名单渲染**：mock 注入金丝雀秘密字段，整个渲染文档与 console 输出无泄漏
- [ ] P.16 **就绪性解耦**：发送表单启用 ⇔ `deliveryReady === true`，与 `authConfigured` 无关
- [ ] P.17 **单飞 + 非持久**：测试发送恰一次 POST、body 仅 `{email}`；地址不入 localStorage/sessionStorage/URL/持久 store，成功后清空
- [ ] P.18 **响应式契约**：375px 与桌面无横向溢出；新增控件 ≥40px 触控目标；长字符串换行；确认框保留 safe-bottom

## 4. 任务清单

### 阶段 A：后端（新分支基于 `develop`，不触碰任何移动端 UI 文件）

- [x] A.1 `server/src/lib/httpError.ts`：ErrorCode 增 `REGISTRATION_DISABLED`、`MAILER_NOT_CONFIGURED`；新增 `registrationDisabled()`(403)、`mailerNotConfigured()`(409) 助手；`RATE_LIMITED` 沿用 `tooManyRequests()`
- [x] A.2 新建 `server/src/lib/email.ts`：`normalizedEmailSchema`（trim→校验→max255→lowercase）与 `maskEmail()`（从 reviews service 迁移，输出不变，原处 re-export 保兼容）
- [x] A.3 `server/src/lib/logger.ts`：redact 路径补 `SMTP_USER`/`SMTP_PASS`/`mailer.user`/`mailer.pass`/嵌套 auth；不误伤无关 `user` 字段
- [x] A.4 `server/src/config/index.ts`：mailer 配置区分两个字段——实际生效发件地址（`SMTP_FROM ?? SMTP_USER`，驱动 `deliveryReady` 与实际发送，现状不变）与可展示发件地址（仅显式 `SMTP_FROM`，如 `mailer.displayFrom`，驱动状态 `from`）（C3）
- [x] A.5 `server/src/lib/systemConfig.ts`：注册表增 `registrationEnabled`（默认 1、描述 `允许新用户注册`、分组 `账户与注册`、hint 按规格、无单位）；`assertSystemConfigValue` 改为 key-aware，该 key 仅收 0/1，其余 key 校验不回归
- [x] A.6 同步更新硬编码注册表元数据的既有测试：`server/src/__tests__/system-config.test.ts`、`server/src/modules/admin/admin-query.test.ts`（分组白名单）
- [x] A.7 `server/src/modules/auth/service.ts`：`assertRegistrationEnabled()` 作为 `registerUser()` 第一步（在查重/bcrypt/事务之前）；`controller.ts`+`routes.ts` 增 `GET /registration-status`（无鉴权、无 authLimiter、`Cache-Control: no-store`、仅 `{registrationEnabled}`）
- [x] A.8 `server/src/modules/admin/schema.ts`：`mailDeliveryTestSchema = z.object({ email: normalizedEmailSchema }).strict()`
- [x] A.9 新建 `server/src/modules/admin/mailOperations.ts`：`getMailDeliveryStatus()`（基于 `config.mailer` 的 5 字段白名单 DTO：`deliveryReady` 随实际生效 mailer 含兜底，`from` 仅回显显式 `SMTP_FROM` 否则 `null`，无网络探测）；`sendMailDeliveryTest({adminUserId,email})`（仅 console 模式 409；否则 attempt 审计→发送→terminal 审计，固定纯文本内容，失败分类白名单，脱敏收件人 `o***@example.com` 形态）
- [x] A.10 新建 `server/src/modules/admin/mailTestLimiter.ts`：`createAdminMailTestLimiter({skipInTests})` 工厂（10min/3/`admin:<userId>`，拒绝时写审计并走 `tooManyRequests()`）；导出生产单例
- [x] A.11 `server/src/modules/admin/controller.ts`+`routes.ts`：挂载 `GET /mail/status`、`POST /mail/test`（既有 MFA 中间件之后；limiter 在 body 校验之前）
- [ ] A.12 后端测试（新 `registration-gate.test.ts` + `admin-mail-operations.test.ts`）：§7.1 全部 8 项 + C 系列约束 + P.1–P.8（含 default/enabled/disabled、副作用零增、校验矩阵、授权矩阵、DTO 序列化金丝雀、CaptureMailer 固定内容、console 409 且零发送、SMTP 失败分类、审计脱敏断言、`skipInTests:false` 专项 limiter 测试）
- [ ] A.13 文档同步：`docs/superpowers/specs/monexus-api-openapi.json`（两个新路由、错误码、config key 全量纠偏）、`server/src/modules/auth/README.md`、`server/src/modules/admin/README.md`、部署文档 SMTP 变量与重启说明
- [ ] A.14 验证门槛：`npm --prefix server run build` 零错误；目标套件 + 全量 server 测试（`TEST_DATABASE_URL` + `REDIS_ENABLED=false`）全绿；`git diff --check`；无 `.env`/凭证入库

### 阶段 B：前端（前置条件：移动端 UI 打磨已提交；基于该 commit 新开 worktree/分支）

- [ ] B.1 契约同步：`src/api/adminConfig.ts` 增 `registrationEnabled` 并补齐 8 个缺失 key；`src/api/auth.ts` 增 `getRegistrationStatus()`（`skipAuthRefresh`）；新建 `src/api/adminMail.ts`（5 字段白名单类型 + `getAdminMailStatus`/`sendAdminMailTest`）
- [ ] B.2 `src/components/admin/AdminConfigPanel.tsx`：按精确 key 排除 `registrationEnabled`（不排除整个分组），其余数字项渲染不变
- [ ] B.3 新建 `src/components/admin/RegistrationControlPanel.tsx`：`role="switch"`+`aria-checked`+状态文字、≥40px 触控、关闭前确认（规格文案）、单飞保存、失败回读服务端值
- [ ] B.4 新建 `src/components/admin/AdminMailPanel.tsx`：白名单渲染、`deliveryReady` 驱动表单、就绪且 `from === null` 时显示「发件地址未公开展示；配置 SMTP_FROM 可显示」、运维提示文案（SMTP_* 环境变量+重启）、收件地址仅组件内存、成功后清空
- [ ] B.5 `src/pages/AdminPage.tsx`：系统配置 tab 内插入两卡片（唯一预期冲突点；保留移动端 safe-area/粘性头/padding 改动）
- [ ] B.6 `src/pages/LoginPage.tsx`：状态机 loading/enabled/disabled/unavailable（fail-closed）；mount+focus/visibility 刷新（latest-wins）；条件渲染注册切换/邀请码/奖励文案；显式 false 才显示暂停公告；`REGISTRATION_DISABLED` 竞态恢复（回登录、清邀请码、留邮箱密码）
- [ ] B.7 新建 `e2e/registration-mail-operations.spec.ts`：C16 策略覆盖 §7.2 全部 6 项 + P.9–P.18；**不修改** `mobile-ui-polish.spec.ts`/`mobile-regression.spec.ts`/`m3-identity-security-hardening.spec.ts`
- [ ] B.8 验证门槛：`npm run build` 零错误；新 spec + 既有 `auth.spec.ts`/`admin-config.spec.ts` 全绿；移动端两套件不改动且跑通；`git diff --check`

### 发布顺序（规格 §6）

- [ ] R.1 先部署阶段 A（默认开启注册，行为不变）→ 合入阶段 B → 之后管理员才可实际关闭注册；禁止只发前端隐藏入口

## 5. 风险与限制

| ID | 风险 | 处置 |
| --- | --- | --- |
| R1 | SMTP 发送与审计无法原子化：发送成功但 terminal 审计写失败 | C7：返回 500、不自动重试、文档注明重试可能重复发信 |
| R2 | limiter 为进程内存储，多副本部署会放大配额 | 本版声明"每进程"语义；扩副本前必须换共享 store（发布检查项） |
| R3 | `from: null` 时管理员无法从后台确认实际发件地址（兜底为 `SMTP_USER`，依 MAIL-01 不回显） | 按 C3 显示「发件地址未公开展示；配置 SMTP_FROM 可显示」引导显式配置 |
| R4 | 注册增加一次 SystemConfig 主键读；DB 故障时注册不可用 | 主键索引读、置于全部 CPU/写操作之前、不缓存以满足 REG-05 即时性 |
| R5 | mailer 缓存与 config 覆盖在测试间泄漏 | 测试串行 + 快照/恢复 `config.mailer` + `afterEach __setMailerForTesting(null)` |