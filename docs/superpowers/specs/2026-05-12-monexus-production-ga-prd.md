# MoNexus Production GA 产品需求文档（PRD）

| 字段 | 值 |
| --- | --- |
| 版本 | v2.0 |
| 日期 | 2026-05-12 |
| 文档状态 | Draft for Review |
| 文档定位 | 以 `origin/master` 为基线的生产化总 PRD，覆盖 M2 灰度上线、M3 生产化、M4 业务演进 |
| 稳定基线 | `origin/master@4ed16e6`，已包含 PR #1 P0 production-readiness sweep 与 PR #2 UI redesign |
| 当前本地工作分支 | `docs/production-ga-prd` |
| 取代关系 | 不废弃既有契约文档；本文档作为 2026-05-12 起的路线总纲 |
| 设计系统事实来源 | `design-system/monexus/MASTER.md`、`design-system/monexus/HANDOFF-ui-redesign.md`、`design-system/monexus/LOGO-BRIEF.md` |

---

## 0. 执行摘要

MoNexus 是一个内部福利积分兑换平台。平台不接入真实支付、充值、提现、银行卡、法币兑换或外部金融系统。用户通过注册、签到、邀请、运营发放等方式获得站内整数积分，并用积分兑换数字商品。商家供应商品并获得账面分润记录，管理员负责用户、商品、商家、订单、结算和审计治理。

截至 `origin/master@4ed16e6`，项目已经完成以下关键基础：

- PR #1：生产化基础扫尾，包含 GitHub Actions CI、生产 Docker 镜像、Nginx、prod compose、MinIO/S3 图片上传、密码重置、邮箱验证、依赖安全修补。
- PR #2：M2 UI 重设计已合并入 `master`，包含设计系统、Concentric 字标、全部 10 个页面、Layout、Modal、Toast、Tabs、Dialog 等 UI 基础组件。
- M1 商家与结算主链路已经可用：用户申请商家，管理员审核，商家上架商品并导入库存，用户兑换商家商品，系统生成订单、发货记录、积分流水和 Settlement。

本文档从产品经理视角将后续工作重新划分为三个阶段：

1. **M2 灰度上线收口**：目标是让 50-200 名内测用户稳定使用，优先补齐测试可运行、健康检查、备份恢复、runbook、系统配置、封禁解封、修改密码、结构化日志、错误聚合和 UI 细节打磨。
2. **M3 生产化能力**：目标是承载 1000 活跃用户，引入虚拟服务手动履约、订单状态机、争议处理、商家待办、运营自助、安全加固和基础指标看板。
3. **M4 业务演进**：目标是承载 10000 活跃用户，引入订阅续费、营销活动、邀请激励 v2、运营数据看板和更完整的可观测体系。

当前最高优先级不是继续扩业务，而是把已经具备的用户、商家、管理、UI 和部署能力打磨到可灰度上线状态。

---

## 1. 产品定位与边界

### 1.1 一句话定位

MoNexus 是一个面向内部用户的积分驱动数字商品兑换平台，由平台运营方发放积分，由商家供应数字资源，由用户消费积分，所有价值表达均为站内整数积分。

### 1.2 核心角色

| 角色 | 系统标识 | 核心目标 | 当前能力 |
| --- | --- | --- | --- |
| 普通用户 | `role = 'user'` | 获得积分、浏览商品、兑换数字资源、查看发货内容 | 注册、登录、邮箱验证、忘记密码、签到、邀请、兑换、订单详情 |
| 商家 | `role = 'merchant'` 且 `Merchant.status = 'active'` | 上架商品、维护库存、查看订单、查看结算 | 入驻申请、商品管理、库存导入、订单/结算列表、商家资料 |
| 管理员 | `role = 'admin'` | 平台治理、商家审核、用户管理、结算、审计 | 数据概览、用户列表、积分调整、商品/库存、订单、商家、结算、日志 |

### 1.3 永久边界

以下能力不进入当前产品路线，除非后续单独立项并重写合规边界：

- 不做真实支付，不接入微信、支付宝、Stripe、PayPal、银行卡。
- 不做积分充值、提现、退款到法币、法币兑换。
- 不做实物商品、物流地址、运费、退换货。
- 不做 C2C 用户自由挂单。
- 不做多租户白标 SaaS。
- 不做多级分销。邀请只允许一级关系。
- 不做原生移动 App，M2-M4 仅保证 Web 与移动浏览器响应式。

### 1.4 产品不变量

| 不变量 | 要求 |
| --- | --- |
| 积分整数性 | 所有积分、价格、佣金、结算金额必须为非负整数，禁止浮点金额作为权威值 |
| 兑换事务一致性 | 扣积分、创建订单、占用库存、创建发货、写 PointLog、创建 Settlement 必须在同一事务内完成 |
| 库存不可二次发放 | `InventoryItem` 一旦绑定订单，不能再次回到可发放状态 |
| 分润账面化 | 商家分润只进入 `Settlement`，不直接进入商家的 `PointAccount` |
| 审计可追溯 | 管理员写操作必须落 `AdminLog` 或等价审计记录；积分变化必须落 `PointLog` |
| 权限边界清晰 | 用户看不到他人订单；商家看不到其他商家的资源；管理员动作必须可审计 |
| 契约优先 | 响应字段、状态枚举、错误码变化必须先改文档或同 PR 更新文档 |

---

## 2. 当前项目审计

### 2.1 分支与 worktree 状态

| 项 | 状态 |
| --- | --- |
| 最新稳定基线 | `origin/master@4ed16e6`，提交信息为 `Merge pull request #2 from amo0114/feat/ui-redesign` |
| 当前本地分支 | `docs/production-ga-prd`，从 `origin/master` 创建 |
| 本地旧分支 | `chore/p0-prod-ready` 已被 PR #1 合入 `master`，不再作为新开发基线 |
| UI 分支 | `feat/ui-redesign` 已被 PR #2 合入 `master`，不再作为后续开发事项 |
| UI worktree | `../../../.claude/worktrees/feat-ui-redesign` 处于 prunable，可清理 |
| 未提交本地变更 | `.gitignore` 修改与 `design-system/monexus/icons-*` 未跟踪素材目录，本文档不修改这些内容 |

### 2.2 已实现能力

| 模块 | 已实现能力 | 证据位置 |
| --- | --- | --- |
| 前端路由 | 10 个页面、受保护路由、角色守卫、开发 tokens 页 | `src/App.tsx` |
| 设计系统 | indigo/green tokens、暗色模式、按钮、卡片、输入、modal、Concentric Logo | `src/index.css`、`src/components/ui/*` |
| 用户认证 | 注册、登录、refresh cookie、logout、`/me`、role-skew 自愈 | `server/src/modules/auth/*`、`src/api/auth.ts` |
| 邮箱能力 | 忘记密码、重置密码、邮箱验证、SMTP/console mailer | `server/src/lib/mailer/*`、`src/pages/ForgotPasswordPage.tsx` |
| 用户积分 | 注册奖励、邀请奖励、签到、积分流水、后台调积分 | `server/src/modules/points/*`、`server/src/modules/admin/service.ts` |
| 商品 | 商品列表、详情、富文本介绍、商家摘要、图片字段 | `server/src/modules/products/*` |
| 图片上传 | 认证上传、5MB 限制、MIME 校验、S3/MinIO/Memory adapter | `server/src/modules/uploads/routes.ts`、`server/src/lib/storage/*` |
| 即时兑换 | 扣积分、占库存、发货、写订单、写流水、创建 Settlement | `server/src/modules/orders/service.ts` |
| 商家 | 入驻申请、商品管理、库存导入、订单、结算、概览、资料 | `server/src/modules/merchant/*`、`src/pages/MerchantDashboardPage.tsx` |
| 管理后台 | 用户、积分、商品库存、订单、商家审核、抽成、结算、日志 | `server/src/modules/admin/*`、`src/pages/AdminPage.tsx` |
| CI 与镜像 | GitHub Actions、前后端 build、Vitest、Docker image build | `.github/workflows/ci.yml` |
| 生产部署雏形 | 前端 Nginx、后端 Docker、PostgreSQL、MinIO profile、prod compose | `Dockerfile`、`server/Dockerfile`、`docker-compose.prod.yml` |

### 2.3 当前验证结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run build` | 通过 | 前端 build 成功 |
| `npm --prefix server run build` | 通过 | 后端 TypeScript build 成功 |
| `npm --prefix server test` | 未进入测试 | 本地 `server/node_modules` 缺少 `@rolldown/binding-linux-x64-gnu` native optional binding，需要重装依赖后复跑 |

---

## 3. 里程碑规划

### 3.1 M2 灰度上线收口

| 项 | 内容 |
| --- | --- |
| 目标用户 | 50-200 名内测用户 |
| 核心目标 | 主链路稳定、故障可恢复、问题可定位、UI 体验不粗糙 |
| 时间建议 | 1-2 周，优先完成 P0 |
| 上线标准 | build 和测试可重复运行；备份可恢复；管理员可处理封禁、配置、结算；UI 通过桌面/移动/暗色基础验收 |

M2 不再包含“合并 UI 重设计”。UI 重设计已在 PR #2 合入 `master`，M2 只做增量打磨。

### 3.2 M3 生产化能力

| 项 | 内容 |
| --- | --- |
| 目标用户 | 1000 活跃用户 |
| 核心目标 | 支持虚拟服务手动履约、争议处理、商家待办和更强运营治理 |
| 时间建议 | M2 稳定后 3-5 周 |
| 上线标准 | 订单状态机完整测试；争议与退款规则闭环；管理员安全加固；监控指标可用于定位问题 |

### 3.3 M4 业务演进

| 项 | 内容 |
| --- | --- |
| 目标用户 | 10000 活跃用户 |
| 核心目标 | 订阅续费、营销活动、邀请激励 v2、运营数据看板 |
| 时间建议 | M3 稳定后分批推进 |
| 上线标准 | 自动续费成功率、活动稳定性、数据看板准确性达到运营要求 |

---

## 4. M2 P0 需求

### 4.1 测试环境修复

**背景**：当前后端测试启动失败，原因是本地依赖缺少 Rolldown optional native binding。CI 已配置测试，但本地必须可复现。

**需求**：

- 重装 `server` 依赖，确认 optional native binding 正常安装。
- 复跑 `npm --prefix server test`。
- 若测试依赖 PostgreSQL 测试库，补充本地测试启动说明。
- 禁止用“跳过测试”作为完成标准。

**验收**：

- `npm --prefix server run build` 通过。
- `npm --prefix server test` 进入测试并通过，或输出明确业务失败项。
- 文档写明测试数据库依赖和启动方式。

### 4.2 健康检查升级

**背景**：当前 `/api/health` 只返回进程状态，无法证明数据库可用。

**需求**：

- `/api/health` 返回 `{ status, time, db }`。
- `db = 'ok'` 表示 `SELECT 1` 成功。
- 数据库不可用时返回 503，并输出安全错误信封或健康检查专用响应。

**验收**：

- PostgreSQL 正常时 health 返回 200。
- PostgreSQL 停止时 health 返回 503。
- Docker healthcheck 可继续使用该接口。

### 4.3 备份与恢复

**背景**：平台以 PostgreSQL 为权威数据源，灰度前必须具备最低限度灾备。

**需求**：

- 新增 `scripts/backup.sh`，使用 `pg_dump` 输出 gzip 备份。
- 默认保留 30 天本地备份。
- 支持通过环境变量配置备份目录。
- 写明异地备份建议：S3/OSS/R2/rclone 均可，M2 可先手动执行。
- 新增一次恢复演练文档。

**验收**：

- 能从生产或 staging 数据库导出备份。
- 能把备份恢复到 staging 数据库。
- runbook 中包含备份、恢复、检查步骤。

### 4.4 部署 Runbook

**需求**：

新增 `docs/operations/runbook.md`，覆盖：

- 本地启动。
- 生产启动。
- 停止与重启。
- 查看日志。
- 执行数据库迁移。
- 执行 seed 的风险说明。
- 备份与恢复。
- 用户紧急加积分。
- 商家紧急停用。
- 回滚上一版本。
- 常见故障：PG 连接失败、端口占用、磁盘满、SMTP 不可用、MinIO 不可用。

**验收**：

- 新成员 30 分钟内可按 runbook 完成启动、重启、备份恢复三件事。

### 4.5 修改密码

**需求**：

- 新增接口：`POST /api/auth/password-change`。
- 请求：`{ oldPassword: string, newPassword: string }`。
- 权限：登录用户。
- 校验旧密码正确后更新密码。
- 修改成功后撤销其他 refresh token，当前会话如何处理需产品明确。推荐：撤销所有 refresh token 并要求重新登录。
- 前端个人中心增加入口。

**验收**：

- 旧密码错误返回 400 或 401。
- 新密码生效。
- 旧 refresh token 无法继续刷新。
- 前端成功后给出清晰提示并跳转登录。

### 4.6 用户封禁与解封

**需求**：

- 管理员新增用户封禁接口：`PUT /api/admin/users/:id/ban`。
- 管理员新增用户解封接口：`PUT /api/admin/users/:id/unban`。
- 封禁写入 `User.status = '已封禁'`。
- 解封恢复 `User.status = '正常'`。
- 封禁时撤销该用户所有 refresh token。
- 登录、refresh、关键业务接口必须拒绝封禁用户。
- 前端 Admin 用户列表增加封禁/解封按钮与确认动作。
- 所有操作写入 `AdminLog`。

**验收**：

- 被封禁用户无法登录。
- 已登录用户在 access token 过期后无法 refresh。
- 管理员日志可看到封禁原因。

### 4.7 系统配置面板

**背景**：注册奖励、签到奖励、邀请奖励目前来自静态 config，不利于运营。

**需求**：

- 新增 `SystemConfig` 模型。
- 配置项：
  - `registerReward`
  - `checkinReward`
  - `inviteReward`
  - `refreshTokenMaxAgeDays`
- 管理员接口：
  - `GET /api/admin/config`
  - `PUT /api/admin/config/:key`
- 前端 Admin 增加“系统配置”页签。
- 修改配置必须写 `AdminLog`。
- 读取配置时优先读数据库，缺省 fallback 到代码配置。

**验收**：

- 修改签到奖励后，下一次签到立即使用新值。
- 非法值不能保存。
- 配置变更有审计记录。

### 4.8 结构化日志

**需求**：

- 引入 `pino` 或等价 JSON logger。
- 每个请求生成 `requestId`。
- 错误响应包含可用于排查的 `requestId`，但不暴露堆栈。
- 关键业务事件写日志：
  - 登录成功/失败。
  - 注册。
  - 密码重置。
  - 邮箱验证。
  - 兑换成功/失败。
  - 商家申请/审核/停用。
  - 批量结算。
  - 用户封禁/解封。

**验收**：

- 生产环境日志为 JSON。
- 能按 `requestId` 关联一次请求的关键日志。

### 4.9 错误聚合

**需求**：

- 前端接入 Sentry 或 GlitchTip SDK。
- 后端接入 Sentry 或 GlitchTip SDK。
- `SENTRY_DSN` 为空时不启用上报。
- 开发和测试环境默认不上报。
- 前端增加 ErrorBoundary。

**验收**：

- 手动触发前端错误可在平台看到。
- 手动触发后端 500 可在平台看到。
- 用户可见错误仍使用现有错误信封或友好提示。

### 4.10 UI 增量打磨

**背景**：PR #2 已合并 UI 重设计。M2 不再做大规模迁移，只处理上线前细节。

**需求**：

- 清理已 prunable 的 `feat-ui-redesign` worktree。
- 决策并处理 `/_dev/tokens`：
  - 若保留，必须只在 dev 环境可访问。
  - 若删除，移除路由和页面。
- 清理 `feat/ui-redesign` 远程分支和本地分支，避免后续误用。
- `EmailVerificationBanner` 接入设计系统 warning token，避免散落 amber 样式。
- 检查 focus ring：按钮、输入、tab、关闭按钮、表格操作按钮必须有可见 focus。
- 检查暗色对比：导航、卡片、表格、modal、toast、邮箱验证横幅。
- 检查移动断点：登录、商品详情、个人中心、商家后台、管理后台。
- 对 Admin 大表格补齐横向滚动与密度控制。

**验收**：

- 后续 UI 打磨全部从 `master` 开短分支，每条独立 PR。
- 桌面 1440、平板 768、移动 375 三个宽度无明显遮挡、溢出和不可点击元素。
- 暗色模式下主要文字、按钮和状态标签可读。

---

## 5. M2 P1/P2 需求

### 5.1 管理后台高级筛选

**需求**：

- 用户列表支持按邮箱、状态、角色、注册时间筛选。
- 订单列表支持按用户、商品、商家、状态、时间筛选。
- 日志支持按 action、adminUserId、targetType、时间筛选。

**验收**：

- 筛选参数进入 URL query 或表单状态。
- 切换页签后筛选不会误污染其他页签。

### 5.2 商家低库存预警

**需求**：

- Product 增加 `lowStockThreshold`。
- 商家可设置阈值。
- 订单完成后若库存低于阈值，生成通知或在商家后台突出显示。
- M2 可先做站内提示，邮件通知放到 M3。

**验收**：

- 库存低于阈值的商品在商家商品列表可识别。

### 5.3 商家订单导出 CSV

**需求**：

- 商家订单列表增加导出按钮。
- M2 可前端导出当前筛选结果。
- 字段包含订单号、商品名、用户邮箱、订单金额、抽成、结算金额、状态、创建时间。

**验收**：

- 导出的 CSV 可被 Excel 或 Numbers 打开。
- 不导出发货内容，避免敏感信息泄露。

### 5.4 商家销售统计

**需求**：

- 新增接口：`GET /api/merchant/stats/timeseries?days=7|30`。
- 返回每日订单数、销售积分、结算金额。
- 商家后台概览增加图表。

**验收**：

- 无订单日期返回 0。
- 仅统计当前商家。

---

## 6. M3 需求

### 6.1 订单状态机

**背景**：当前订单模型只适合即时发货商品。虚拟服务需要商家手动履约、用户确认、争议处理。

**目标状态**：

```ts
type OrderStatus =
  | 'completed'
  | 'pending'
  | 'processing'
  | 'delivered'
  | 'closed'
  | 'disputed'
  | 'refunded'
```

**即时商品规则**：

- 仍然创建即 `completed`。
- 保持当前库存发货和 Settlement 创建逻辑。

**虚拟服务规则**：

- 创建订单时进入 `pending`。
- 用户积分先冻结，不立即扣减为最终消费。
- 商家接单后进入 `processing`。
- 商家提交履约结果后进入 `delivered`。
- 用户确认后进入 `closed`，积分正式扣减，Settlement 生效。
- 用户可在 `delivered` 发起争议进入 `disputed`。
- 管理员仲裁后进入 `closed` 或 `refunded`。

**新增模型建议**：

- `OrderEvent`：记录订单状态变化。
- `PointHold` 或 `Order.holdingPoints`：记录冻结积分。
- `Product.fulfillmentType`：`instant | manual`。
- `Product.fulfillmentSlaHours`：商家承诺履约时长。

### 6.2 争议与退款

**需求**：

- 用户对 `delivered` 订单发起争议。
- 管理员查看争议订单。
- 管理员选择支持商家或支持用户。
- 支持用户时退还冻结积分或退回已扣积分。
- Settlement 进入 `voided` 或不生成。

**验收**：

- 争议全过程有 `OrderEvent`。
- 积分变化有 `PointLog`。
- 管理员仲裁有 `AdminLog`。

### 6.3 商家待办中心

**需求**：

- 商家后台展示 pending、processing、超时订单数量。
- 订单列表支持按状态筛选。
- 超过 SLA 的订单高亮。
- 后续可接邮件或站内通知。

### 6.4 安全加固

**需求**：

- 管理员 MFA。
- 会话设备管理。
- 管理员 IP 白名单可选。
- 敏感日志脱敏。
- bcrypt rounds 从 10 升级到至少 12，并提供渐进升级策略。

---

## 7. M4 需求

### 7.1 订阅与续费

**需求**：

- 商品支持订阅类型。
- 新增 `Subscription`。
- 到期自动扣积分并发新库存或延长权益。
- 积分不足进入 `past_due`。
- 宽限期后取消订阅。

### 7.2 营销活动

**需求**：

- 双倍签到积分日。
- 商品限时折扣。
- 优惠券或满减券，仍仅以站内积分表达。
- 活动配置必须有开始、结束、启停状态和审计。

### 7.3 运营看板

**需求**：

- 注册数、DAU、WAU、MAU。
- 兑换 GMV，以积分计。
- 客单价。
- 复购率。
- 商家排行。
- 库存周转。
- 争议率。
- SLA 达成率。

---

## 8. 模块开发划分

### 8.1 账号与安全模块

**职责**：

- 登录、注册、refresh、logout、`/me`。
- 忘记密码、修改密码、邮箱验证。
- refresh token 存储、轮换、撤销。
- 用户封禁后的登录和刷新控制。

**打磨方向**：

- 所有公开邮件接口必须防枚举。
- 所有 token 只存 hash。
- 所有密码变更必须撤销 refresh token。
- `role-skew` 自愈继续保留，不能因 UI 重构退化。

**任务划分**：

1. 修复后端测试依赖并复跑认证测试。
2. 实现修改密码接口和测试。
3. 在 Profile 页面加入修改密码入口。
4. 增加封禁用户 refresh 拒绝测试。
5. 补充认证模块 README。

### 8.2 积分与配置模块

**职责**：

- PointAccount 权威余额。
- PointLog 不可变流水。
- 注册、签到、邀请奖励。
- 后台调积分。
- SystemConfig 在线配置。

**打磨方向**：

- 配置变更必须有审计。
- 奖励金额变更后只影响未来动作，不回溯历史。
- 所有积分变化必须能解释原因。

**任务划分**：

1. 新增 SystemConfig schema 与 migration。
2. 新增 admin config API。
3. 接入签到、注册、邀请奖励读取配置。
4. Admin 增加系统配置 UI。
5. 补充配置变更审计测试。

### 8.3 商品与媒体模块

**职责**：

- 商品搜索、分类、详情。
- 商品图片上传。
- 库存导入。
- 平台自营与商家商品统一展示。

**打磨方向**：

- 图片为空时必须有稳定 fallback，不允许破图影响卡片。
- 商品价格文案统一为“积分”，不能出现人民币符号。
- 富文本展示继续使用 DOMPurify。
- 库存展示与真实可用库存保持一致。

**任务划分**：

1. 检查 UI 中所有价格标签，移除 `¥` 表述。
2. 增加商品图片 fallback。
3. 增加低库存阈值字段。
4. 商家商品列表展示低库存状态。
5. 商品模块 README 补充库存不变量。

### 8.4 订单与履约模块

**职责**：

- 即时兑换。
- 库存占用。
- 发货记录。
- 订单详情。
- 后续订单状态机、积分冻结、争议退款。

**打磨方向**：

- 兑换事务不可拆散。
- `updateMany` 占库存并校验 count 的并发防御必须保留。
- 发货内容只能对订单用户、所属商家、管理员可见。
- M3 状态机引入时不能破坏现有 `completed` 订单。

**任务划分**：

1. M2 补订单模块 README。
2. M2 增加订单列表筛选。
3. M3 设计并实现 `Product.fulfillmentType`。
4. M3 新增 OrderEvent。
5. M3 实现 pending/processing/delivered/closed/disputed/refunded。

### 8.5 商家工作台模块

**职责**：

- 商家入驻申请。
- 商品管理。
- 库存导入。
- 订单查看。
- 结算查看。
- 商家资料。
- 销售统计。

**打磨方向**：

- 商家只能操作自己资源。
- 商家订单列表要能快速定位待处理订单。
- 商家不能看到用户积分余额、平台审计日志。
- 结算金额与 Settlement 保持一致。

**任务划分**：

1. M2 增加 CSV 导出。
2. M2 增加销售统计 time series。
3. M2 增加低库存提示。
4. M3 增加待办中心。
5. M3 增加手动履约操作入口。

### 8.6 管理后台模块

**职责**：

- 用户治理。
- 商家审核。
- 商品和库存治理。
- 订单与结算治理。
- 系统配置。
- 审计日志。

**打磨方向**：

- 高风险操作必须二次确认。
- 批量操作必须全成功或全失败。
- 所有写操作必须有 AdminLog。
- 管理端表格要优先可扫描、可筛选、可恢复，不追求花哨。

**任务划分**：

1. M2 用户封禁/解封。
2. M2 系统配置页签。
3. M2 日志筛选。
4. M2 订单筛选。
5. M3 争议仲裁页签。
6. M3 管理员 MFA 设置。

### 8.7 运维与可观测模块

**职责**：

- CI。
- Docker 与 compose。
- 健康检查。
- 日志。
- 错误聚合。
- 备份恢复。
- runbook。

**打磨方向**：

- 灰度前先保证能恢复。
- 所有生产故障都应能通过日志、错误聚合和 runbook 定位第一步。
- 不引入 Kubernetes。
- M2 不做复杂链路追踪，先完成基础可观测闭环。

**任务划分**：

1. 修复本地测试依赖。
2. 升级 health check。
3. 增加 backup script。
4. 编写 runbook。
5. 接入 pino。
6. 接入 Sentry/GlitchTip。
7. OpenAPI lint 进入 CI。

### 8.8 UI 与设计系统模块

**职责**：

- 维护 PR #2 已合并的设计系统。
- 确保 10 页、Layout、Modal、Toast、Tabs、Dialog 在桌面/移动/暗色可用。
- 管理品牌文档和 logo 规范。

**打磨方向**：

- 不再重做一遍 UI redesign。
- 后续只从 master 开短分支做小步增量。
- 组件 focus ring、暗色对比、移动端布局是 M2 重点。
- `/_dev/tokens` 必须做保留或删除决策。

**任务划分**：

1. 清理 prunable UI worktree。
2. 删除或限制 `/_dev/tokens`。
3. EmailVerificationBanner 接入 warning token。
4. 桌面、平板、移动截图验收。
5. 暗色对比审查。
6. 管理后台表格响应式打磨。

---

## 9. 推荐开发顺序

### 9.1 第一批：M2 P0，必须先做

| 顺序 | 模块 | 任务 | 原因 |
| --- | --- | --- | --- |
| 1 | 测试 | 修复 server 测试依赖并复跑 | 没有可重复测试就无法判断后续改动质量 |
| 2 | 运维 | health check + DB 探活 | Docker 和灰度监控依赖它 |
| 3 | 运维 | backup + restore + runbook | 灰度前必须能恢复 |
| 4 | 账号 | 修改密码 | 灰度用户账户安全基础能力 |
| 5 | 管理 | 封禁/解封 | 灰度治理必备 |
| 6 | 配置 | SystemConfig + Admin UI | 运营奖励不能继续写死 |
| 7 | 可观测 | 结构化日志 + 错误聚合 | 出问题能定位 |
| 8 | UI | tokens 页决策 + focus/暗色/移动打磨 | PR #2 后的上线级 polish |

### 9.2 第二批：M2 P1/P2，可并行

- 管理端筛选。
- 商家低库存预警。
- 商家 CSV 导出。
- 商家销售统计图。
- OpenAPI lint 进入 CI。
- 模块 README。

### 9.3 第三批：M3 主项目

- 订单状态机设计。
- Product fulfillmentType。
- OrderEvent。
- 积分冻结。
- 商家接单/交付。
- 用户确认/争议。
- 管理员仲裁。
- Settlement 状态扩展。

---

## 10. 验收 Gate

### 10.1 M2 灰度上线 Gate

- [ ] `origin/master` 或 release 分支前后端 build 通过。
- [ ] 后端测试可在本地和 CI 通过。
- [ ] `/api/health` 包含 DB 探活。
- [ ] 数据库备份脚本可执行。
- [ ] 至少完成一次恢复演练。
- [ ] runbook 覆盖启动、停止、迁移、备份、恢复、回滚、紧急用户处理。
- [ ] 修改密码上线。
- [ ] 用户封禁/解封上线。
- [ ] SystemConfig 上线。
- [ ] 结构化日志上线。
- [ ] 错误聚合上线。
- [ ] UI 完成 focus、暗色、移动端基础验收。
- [ ] `/_dev/tokens` 已删除或限制为 dev 环境。

### 10.2 M3 生产化 Gate

- [ ] 虚拟服务订单状态机全流程通过测试。
- [ ] 争议退款不破坏积分一致性。
- [ ] OrderEvent、PointLog、AdminLog 三类审计闭环。
- [ ] 商家待办中心可用。
- [ ] 管理员仲裁界面可用。
- [ ] 管理员 MFA 上线。
- [ ] 1000 活跃用户规模压测通过。

### 10.3 M4 业务演进 Gate

- [ ] 订阅商品上线。
- [ ] 自动续费运行 30 天成功率达到 99%。
- [ ] 至少一次营销活动稳定完成。
- [ ] 运营看板数据与数据库抽样核对一致。

---

## 11. 风险与应对

| 风险 | 影响 | 概率 | 应对 |
| --- | --- | --- | --- |
| 测试环境不可重复 | 后续改动无法可靠验收 | 高 | M2 第一优先级修复依赖和测试库文档 |
| 备份缺失 | 数据丢失不可恢复 | 中 | M2 必做 backup + restore 演练 |
| UI dev tokens 页暴露 | 内部调试页面进入生产 | 中 | 删除或限制 dev 环境 |
| 管理员误操作 | 积分、商家、结算被错误修改 | 中 | 二次确认、AdminLog、runbook 回滚步骤 |
| 商家发无效卡密 | 用户信任受损 | 中 | M3 争议流程、商家评分、停用机制 |
| 积分通胀 | 商品吸引力下降 | 中 | SystemConfig + 运营看板监控发放/消耗比 |
| 商品图片上传滥用 | 存储成本和安全风险 | 中 | MIME/大小限制已具备，M3 增加内容审核或管理员下架 |
| 订单状态机引入破坏即时商品 | 主链路回归 | 中 | `completed` 兼容路径保留，先加测试后迁移 |
| 远程旧分支误用 | 后续开发基线混乱 | 低 | 清理 `feat/ui-redesign` 和 prunable worktree |

---

## 12. 文档引用

- `docs/superpowers/specs/2026-04-27-postgresql-auth-security-design.md`
- `docs/superpowers/specs/2026-04-29-monexus-merchant-settlement-contract.md`
- `docs/superpowers/specs/2026-04-30-monexus-product-prd.md`
- `docs/superpowers/specs/monexus-api-openapi.json`
- `docs/superpowers/plans/2026-04-30-monexus-m1-m2-execution.md`
- `design-system/monexus/MASTER.md`
- `design-system/monexus/HANDOFF-ui-redesign.md`
- `design-system/monexus/LOGO-BRIEF.md`

---

## 13. 后续流程

本文档确认后，进入 `superpowers:writing-plans` 阶段，输出实施计划到：

`docs/superpowers/plans/2026-05-12-monexus-production-ga-implementation.md`

计划应按 M2 P0 优先拆分，并要求每个任务包含：

- 精确文件路径。
- 测试用例。
- 验收命令。
- 回归风险。
- 独立提交建议。

---

**文档结束**
