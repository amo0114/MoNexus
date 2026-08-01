# Spec：注册开关与邮件投递运营面

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-OPS-REGMAIL-001 |
| 版本 | 1.1.0（R1：邮件状态 `from`/`deliveryReady` 语义修订） |
| 日期 | 2026-07-31 |
| 状态 | Ready for Implementation |
| 产品 | MoNexus |
| 关联模块 | `server/src/modules/auth`、`server/src/modules/admin`、`src/pages/AdminPage.tsx` |

---

## 1. 背景

当前公开注册始终可用：登录页恒显示注册入口，`POST /api/auth/register` 也没有读取任何运营开关。管理员“系统配置”仅包含数值型业务参数；其中 `registerReward` 只控制注册赠送积分，**不是**注册启停开关。

交易邮件使用后端进程的 SMTP 环境变量：`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS`、`SMTP_FROM`。没有配置 `SMTP_HOST` 时，服务端降级为 console mailer，不进行真实投递。管理员前端目前无法判断生产环境是否处于该降级状态，也没有安全的测试发送入口。

## 2. 目标与非目标

### 2.1 本次目标

1. 管理员能在后台即时开启或关闭新用户自助注册；关闭后必须由后端拒绝直接调用 API 的注册请求。
2. 访客登录页根据当前注册状态隐藏或展示注册入口，并显示明确、非误导的提示。
3. 管理员能在后台查看邮件投递的**非敏感运行状态**，并可向指定地址发送一封受限、可审计的测试邮件。
4. 所有状态变更和测试发送均沿用管理员 MFA、审计与错误响应约定。

### 2.2 明确不在范围内

1. 不在浏览器、`SystemConfig` 或普通数据库字段中保存、读取或回显 `SMTP_USER` / `SMTP_PASS`。
2. 不提供“在后台编辑 SMTP 主机、端口、账号、密码”的功能。SMTP 仍由部署环境（`.env` / Secret Store / `docker-compose.prod.yml`）配置，变更后重启或重新部署后端。
3. 不实现邀请码制、白名单注册、审批注册、邮件域名限制或运营人员代建账号；这些是单独的身份产品需求。
4. 不修改当前移动端 UI 打磨的视觉契约、布局组件或其 E2E 文件。

> 决策：SMTP 凭证是基础设施密钥，不应下发给前端，也不应在缺少专用密钥管理、再认证和密文轮换机制时转存数据库。本次提供运营状态与测试能力，而非不安全的“网页改密码”。

## 3. 领域规则与不变量

| ID | 规则 |
| --- | --- |
| REG-01 | `registrationEnabled` 是唯一的公开注册开关，持久化为 `SystemConfig` 的整数值：`1` = 开启，`0` = 关闭；缺少记录时默认 `1`，确保升级兼容。 |
| REG-02 | 仅 `0` 或 `1` 是该 key 的合法值；其他现有数值型 SystemConfig 继续遵循既有非负整数校验。不得用“注册奖励为 0”隐式表示关闭注册。 |
| REG-03 | `POST /api/auth/register` 必须在创建 `User`、`PointAccount`、`PointLog`、`InviteRelation`、RefreshToken 前检查开关。关闭时返回 `403 REGISTRATION_DISABLED`，不写任何注册相关数据，也不得设置 refresh cookie 或返回 access token。 |
| REG-04 | 注册状态的前端展示只是体验优化，不能作为授权边界；即使旧前端、缓存 HTML 或脚本直接请求注册接口，也必须被 REG-03 拒绝。 |
| REG-05 | 开关修改成功后，已经在服务端通过检查并开始执行的少数并发请求可以完成；修改成功响应之后才开始处理的请求必须读取到新值。该开关不要求撤销已完成账号。 |
| MAIL-01 | 邮件状态接口绝不返回 SMTP 用户名、密码、provider token、完整连接串、内部主机名或任何原始环境变量。 |
| MAIL-02 | 测试邮件只能由已登录、活动、MFA 已验证的管理员触发；必须使用当前实际 mailer，不能伪造“已发送”结果。 |
| MAIL-03 | console mailer 模式下测试发送必须被拒绝并说明“未配置真实 SMTP”，不得返回成功。 |
| MAIL-04 | 邮件测试只发送固定的无业务、无敏感数据内容；不得包含 token、Cookie、订单、用户列表、配置值或错误堆栈。 |

## 4. 后端设计

### 4.1 注册开关配置

在 `server/src/lib/systemConfig.ts` 的 registry 中新增：

| 字段 | 值 |
| --- | --- |
| key | `registrationEnabled` |
| 默认值 | `1` |
| 描述 | `允许新用户注册` |
| 分组 | `账户与注册` |
| UI 形态 | boolean switch，不复用数值输入框 |
| 提示 | `关闭后仅阻止新账号自助注册；现有账号仍可登录。` |

实现应将配置值校验改为 key-aware：`registrationEnabled` 只接受 `0`/`1`，其他 key 维持当前的整数范围和已有跨字段校验。新增 key 后须同步更新：

- `systemConfigKeys`、默认值、描述、分组和 hint；
- 管理员 key 参数 schema；
- 前端 `AdminSystemConfigKey` 类型；
- OpenAPI 契约（如该仓库维护的 `docs/superpowers/specs/monexus-api-openapi.json`）。

现有 `PUT /api/admin/config/registrationEnabled` 继续复用，不新增平行的写接口。该接口已有 `authenticate → requireActiveUser → requireAdmin → requireAdminMfa` 保护，并由 `updateSystemConfig` 写入 `AdminLog`；实现不得绕开此路径。

### 4.2 公开注册状态与注册拒绝

新增公开只读接口：

```http
GET /api/auth/registration-status
200 Cache-Control: no-store
Content-Type: application/json

{ "registrationEnabled": true }
```

要求：

- 不需要登录；仅返回 boolean，不暴露任何其他 SystemConfig。
- 路由不应受登录/注册的通用 `authLimiter` 影响；可使用合理的只读限流或既有全局限流。
- 前端请求失败或仍在加载时，默认**不显示**注册入口；同时保留登录与忘记密码入口。这样不会在开关关闭时短暂呈现可操作的注册 UX。

将注册开关判定置于 auth service 的 `registerUser` 入口，而不是仅放在 React 或 controller。建议封装为 `assertRegistrationEnabled()`，从 `getSystemConfigValue('registrationEnabled')` 读取并在关闭时抛出标准 `forbidden` 错误：

```json
{
  "error": {
    "code": "REGISTRATION_DISABLED",
    "message": "当前已关闭新用户注册"
  }
}
```

这使 HTTP 路由、后续 CLI 或服务内调用都共享同一强制边界。不得通过删除路由实现关闭，否则重新开启需要重新部署，且无法留下正常的运营审计记录。

### 4.3 邮件状态接口

新增管理员只读接口：

```http
GET /api/admin/mail/status
200 Content-Type: application/json

{
  "mode": "smtp",
  "deliveryReady": true,
  "from": "noreply@example.com",
  "authConfigured": true,
  "configuredVia": "environment"
}
```

字段约束：

| 字段 | 语义 |
| --- | --- |
| `mode` | `smtp` 或 `console`。 |
| `deliveryReady` | 仅当 `mode === "smtp"` 且实际生效的 mailer 具备有效发件地址（显式 `SMTP_FROM`，或 `SMTP_USER` 兜底）时为 `true`；不因缺少显式 `SMTP_FROM` 而判定未就绪。 |
| `from` | 仅在显式配置 `SMTP_FROM` 时返回该地址；未显式配置或 console 模式为 `null`，绝不回显 `SMTP_USER` 兜底值。`deliveryReady === true` 且 `from === null` 是合法组合，语义为“可投递但发件地址未公开展示”。 |
| `authConfigured` | SMTP 用户名和密码均存在时为 `true`；仅反映布尔状态。部分无需认证的受控 relay 可为 `false`，不应仅据此断言不可用。 |
| `configuredVia` | 固定值 `environment`，明确该项不在后台编辑。 |

接口不做 SMTP 网络探测，避免刷新后台页面就触发外部连接、阻塞或泄露内网拓扑。路由必须置于现有 admin router 的 MFA 中间件之后。

### 4.4 测试邮件接口

新增接口：

```http
POST /api/admin/mail/test
Content-Type: application/json

{ "email": "operator@example.com" }

200 { "message": "测试邮件已提交发送" }
```

校验和行为：

- body 为严格对象；`email` 采用项目既有 email schema，trim、lowercase 后再发送。
- `mode === "console"` 时返回 `409 MAILER_NOT_CONFIGURED`，消息：`尚未配置真实 SMTP，无法发送测试邮件`。
- SMTP adapter resolve 及 `send()` 成功后才返回 200；连接或 provider 错误须透过现有错误映射返回通用失败信息，日志可以保留诊断但不得含密码、token 或完整认证头。
- 邮件主题固定为 `MoNexus 邮件投递测试`；正文只说明该邮件由管理员测试触发、时间（UTC）和站点名。不得生成链接或包含任何用户业务数据。
- 使用独立 limiter：每管理员每 10 分钟最多 3 次；`NODE_ENV=test` 遵循项目既有测试绕过策略。限制命中返回现有 `RATE_LIMITED` 契约。
- 发送成功、发送失败、未配置拒绝和限流拒绝均写 `AdminLog`。记录动作和结果，收件人仅保存脱敏形式（例如 `o***@example.com`），不得写原始 email、SMTP 凭证或报错堆栈。

为避免 controller 依赖全局隐式状态，可在 mail operations service 中提供：

- `getMailDeliveryStatus()`：基于已经解析的 `config.mailer` 返回安全 DTO；
- `sendMailDeliveryTest({ adminUserId, email })`：执行模式检查、发送与审计；
- mailer 适配器在测试中通过既有 `__setMailerForTesting` / CaptureMailer 进行替换。

## 5. 前端设计

### 5.1 登录页

登录页初始加载时请求 `/api/auth/registration-status`：

- `true`：保留现有“没有账号？注册新账号”切换入口、邀请码输入和注册奖励文案。
- `false`：不显示注册切换按钮、邀请码输入和“注册立送积分”文案；显示静态说明：`当前暂停新用户注册，如需帮助请联系平台管理员。`
- 加载中/请求失败：不显示注册入口，显示登录 UI；可在开发日志记录请求失败，但不要把技术错误展示给访客。
- 已切至注册表单时，若状态刷新为 `false`，立即切回登录表单、清空邀请码；已填写的邮箱/密码仅留在内存，不发送注册请求。
- 若提交时仍收到 `REGISTRATION_DISABLED`，展示服务端消息并切回登录态。这处理多标签页/状态变更竞态。

### 5.2 管理后台

在既有“系统配置”tab 内新增两个独立卡片；不把 SMTP 字段混入纯数值配置表：

1. **账户与注册**
   - 展示 `允许新用户注册` switch，开启/关闭的状态文字须同时存在，不能只依靠颜色。
   - 关闭前弹出确认：`关闭后新访客无法创建账号，现有用户仍可登录。确认关闭？`
   - 复用 `PUT /admin/config/registrationEnabled`；保存中禁用重复操作，失败时恢复服务端状态并展示错误 toast。
   - switch 可点击/聚焦区域最小为 40×40 CSS px，键盘 Space/Enter 可切换，使用 `role="switch"` 和正确的 `aria-checked`。

2. **邮件投递**
   - 页面加载时调用 status API；展示“真实 SMTP 已配置”或“未配置真实 SMTP（当前仅记录到服务端日志）”。
   - 仅显示 `from`、认证是否已配置和“配置来源：部署环境变量”；不得显示 host、用户名或密码。
   - `deliveryReady === true` 且 `from === null` 时，发件地址处显示“发件地址未公开展示；配置 SMTP_FROM 可显示”，不得据此表述为“SMTP 未就绪”或禁用测试发送。
   - 明确给出受控操作提示：`SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM 需在部署环境中配置，修改后重启后端。`
   - 当 `deliveryReady` 时展示收件地址输入和“发送测试邮件”按钮；当不就绪时禁用按钮并显示原因。
   - 发送期间按钮禁用，成功/失败按 API 响应 toast；页面不得记录、缓存或在 URL 中放入收件地址。

前端应新增独立 `src/api/adminMail.ts` 与 `AdminMailPanel`，避免把 SMTP 逻辑塞入通用 `AdminConfigPanel`。注册 switch 可作为专用 `RegistrationControlPanel`，或让 `AdminConfigPanel` 对该 key 显式渲染 switch；不得通过 `value === 0` 这类无标签数字输入让管理员猜测含义。

## 6. 数据迁移、兼容与发布

1. 不需要 Prisma schema migration：复用现有 `SystemConfig(key, value)` 表。首次读取使用 default `1`；管理员首次保存时创建记录。
2. 上线后默认行为保持“开放注册”，避免部署意外封闭注册。
3. 先部署包含后端 gate 的版本，再使用管理员开关关闭注册；不允许仅先发布前端隐藏入口。
4. 生产 SMTP 变量缺失不应阻断整个服务启动（沿用当前 console fallback），但管理员状态必须准确显示降级，生产发布检查仍应按 `scripts/check-prod-env.sh` 的 SMTP 门禁执行。
5. 管理员页面和新接口均要求既有 MFA；缺少 MFA 的管理员会话不得能读取邮件状态或切换注册。

## 7. 测试与验收

### 7.1 后端测试（Vitest + Supertest）

1. default：清除 `registrationEnabled` row 后，公开状态返回 `true`，注册成功且保持既有积分/邀请语义。
2. enabled：管理员写入 `1` 后，状态为 `true`，注册可成功。
3. disabled：管理员写入 `0` 后，状态为 `false`；`POST /auth/register` 返回 403 `REGISTRATION_DISABLED`；核验 `User`、`PointAccount`、`PointLog`、`InviteRelation` 和 RefreshToken 行数均未增加。
4. validation：管理员尝试写 `-1`、`2`、小数、字符串到 `registrationEnabled` 均返回 400；其他既有配置项的校验不回归。
5. authorization：未登录、普通用户、非 MFA 管理员不能读取/修改 admin mail 或注册配置；普通公开状态接口可读。
6. mail status：SMTP / console 两种 config 生成的 DTO 精确符合 §4.3（含仅配置 `SMTP_USER` 时 `deliveryReady === true` 且 `from === null`、测试发送不被拒绝），序列化结果不含 `host`、`user`、`pass`、`SMTP_` 或其他 secret 字段。
7. mail test：CaptureMailer 下发送固定安全内容；console 返回 409 且 CaptureMailer 无发送；SMTP send 抛错时返回标准失败；成功、失败和拒绝均有脱敏 `AdminLog`。
8. rate limit：同一管理员第四次测试邮件在 10 分钟窗口内被拒绝，另一管理员不共享限额。

### 7.2 前端与 E2E

1. 开放注册：登录页显示注册入口，切换后可看到邀请码字段和注册按钮。
2. 关闭注册：登录页无注册入口与注册奖励文案，仍可登录和打开忘记密码；手工 API 注册仍被拒绝。
3. 竞态：在注册表单打开后由 API 切为关闭，下一次状态同步或提交 `REGISTRATION_DISABLED` 后回到登录态并展示提示。
4. 管理后台：MFA 管理员可切换注册状态，刷新后状态持久；关闭确认框和失败回滚可用。
5. 邮件面板：console 状态显示降级且测试按钮不可用；SMTP ready 状态仅显示允许字段；测试发送的 loading/success/error 状态正确。
6. 所有新增可点击控件在 375px 视口和桌面视口均不横向溢出，触控目标不小于 40px；不修改或放宽现有 `mobile-ui-polish` 的断言。

### 7.3 完成门槛

- `npm run build` 零错误；
- 相关 server 测试、认证测试、管理员配置测试、前端/E2E 新增用例全绿；
- `git diff --check` 通过；
- 不提交 `.env`、真实 SMTP 凭证、测试 provider token 或截图中的秘密；
- 审计日志及 HTTP 响应的 secret-redaction 测试必须明确断言。

## 8. 实施分工与移动端隔离

当前 worktree 正有未提交的移动端 UI 打磨，且已改动 `src/pages/AdminPage.tsx`。实现本规格时：

1. **先只实现后端**：`systemConfig`、auth gate、admin mail routes/service/schema/tests；该部分不触碰移动端 UI 文件。
2. **前端在独立 worktree/分支完成**，基于移动端 UI 改动提交后的最新 commit 开工，或由集成人员处理 `AdminPage.tsx` 的唯一冲突点。
3. 前端新增独立 panel/API 文件，避免重写 `Layout`、`BottomTabBar`、`StorePage`、`ProductDetailPage`、`index.css`、`e2e/mobile-ui-polish.spec.ts` 和 `e2e/mobile-regression.spec.ts`。
4. 合并时保留移动端的 safe-area 与 40px 按钮契约；本规格新增的后台控件也必须遵守 40px 最小触控尺寸。

## 9. 交付清单

| 层 | 预期变更 |
| --- | --- |
| Backend config | `registrationEnabled` registry/default/validation，安全邮件状态 DTO |
| Auth | `GET /auth/registration-status` 与 `registerUser` 强制 gate |
| Admin API | `/admin/mail/status`、`/admin/mail/test`、限流、审计、schema |
| Frontend | 登录页状态感知；注册开关 panel；邮件状态/测试 panel；独立 API client |
| Documentation | 本 spec、OpenAPI、部署文档中 SMTP 环境变量入口与重启说明 |
| Tests | §7 所列 unit/integration/E2E 与 secret-redaction 覆盖 |
