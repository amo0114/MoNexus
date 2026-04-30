# MoNexus 内部福利积分平台产品需求文档（PRD）

| 字段 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 日期 | 2026-04-30 |
| 文档状态 | Draft for Approval |
| 文档定位 | 项目主蓝图：合并现有 Demo/MVP 与生产化路线 |
| 取代关系 | 不取代既有契约文档；与 `2026-04-28-monexus-demo-to-mvp-prd.md`、`2026-04-29-monexus-merchant-settlement-contract.md` 并行生效，本文档作为最高层次规划 |
| 主分支 | `master` |
| 当前活跃分支 | `feat/backend-merchant-settlement` |

---

## 0. 摘要（执行版）

MoNexus 是一个**纯内部福利/积分激励平台**：用户以站内虚拟积分兑换数字商品（卡密、订阅链接、虚拟服务），平台不接入任何真实货币体系。平台采用**用户 / 商家 / 管理员**三端结构，商家轻管控、自助上架，按预设比例与平台分润（分润仅在站内积分账面进行，不涉及法币结算）。

目标用户规模为**灰度上线 100–10000 人**。这一规模决定了：

- 单实例 PostgreSQL + 单进程 Node 服务足够，但必须配齐**每日备份、健康检查、错误聚合、基础监控、CI/CD**。
- 不引入消息队列、读写分离、集群、Redis 缓存等大型架构组件，但代码层必须保留可扩展空间。

商品扩展路径分三步：

1. **V1（已基本完成）**：纯卡密/订阅链接的即时发货模型。
2. **V2**：引入"虚拟服务（手动履约）"——订单从一锤子买卖升级为**状态机**：`pending → processing → delivered → disputed → closed`。
3. **V3**：引入"订阅/续费"——按月/按周期扣积分续约，含失败补偿、降级、暂停。

整体生命周期被划分为 **4 个里程碑**：

- **M1 MVP 收尾（已完成 90%）**：补齐 6 个 P0 缺陷，提交并合并代码，完成首次三角色联调。
- **M2 灰度上线**：完成生产化基础设施（备份、监控、CI、运行手册），可邀请 50 名内测用户。
- **M3 生产化**：完成虚拟服务履约、商家工作台增强、运营自助、安全加固，承载 1000 名活跃用户。
- **M4 业务演进**：订阅/续费、营销活动、邀请激励 v2、数据看板，承载 10000 名活跃用户。

---

## 1. 产品定位与边界

### 1.1 一句话定位

> 一个站内积分驱动的数字商品兑换平台，由平台运营方发放积分，由商家供应商品，由用户消费积分，所有金额仅在系统内账面流转，不与人民币、外币、银行卡、第三方支付发生任何关联。

### 1.2 业务边界（明确不做）

以下能力**永久不进入产品**，除非用户书面变更本 PRD：

| 排除项 | 说明 |
| --- | --- |
| 真实支付接入 | 不集成微信、支付宝、Stripe、PayPal、银行直连任何渠道 |
| 用户充值积分 | 用户不能用法币换取积分，只能通过注册、签到、邀请、运营发放、后台调整获得 |
| 提现/退款到法币 | 商家分润金额仅是站内积分账面，平台不承担线下结算义务 |
| 法币兑换 | 积分不与人民币、美元等法币建立任何兑换比例关系 |
| 实物商品 | 不引入物流地址、运费、退换货、批次管理 |
| 多租户白标 | 不把系统打包卖给其他企业作为 SaaS |
| 用户自由挂单（C2C） | 用户不能自己上架商品给其他用户，只有商家可以上架 |
| 评论/社区/UGC | 暂不引入用户评论、晒单、论坛 |
| 移动端原生 App | 仅 Web 端 + 移动浏览器响应式 |

### 1.3 业务边界（核心保留）

| 保留能力 | 说明 |
| --- | --- |
| 站内积分体系 | 用户、商家、管理员都基于积分进行所有金额表达，整数 |
| 三端角色 | user / merchant / admin，互不可越权 |
| 商家入驻审核 | 普通用户可申请，管理员审核，状态流转 `pending → active → suspended → rejected` |
| 平台抽成 | 每商家可配置 `0 ≤ commissionRate ≤ 1` 的抽成比例，订单创建时快照 |
| 商家分润结算 | 用户兑换商家商品时同事务创建 Settlement 记录，管理员批量结算 |
| 商品轻管控 | 商家可自由上架商品和导入库存，无须平台审核（V2 可选启用审核开关） |

### 1.4 不变量（产品级铁律）

任何功能演进不得违反：

1. **积分整数性**：所有金额、积分、佣金、结算金额均为非负整数，禁止使用浮点。
2. **抽成精度**：`commissionRate` 内部存储为 `Decimal(5,4)`，响应中以字符串表达，前端显示百分比。
3. **事务一致性**：兑换流程中"扣积分 / 创建订单 / 占用库存 / 创建发货 / 写积分流水 / 创建 Settlement"必须在同一事务，**禁止跨事务最终一致性**。
4. **凭证不可二次发放**：单条 InventoryItem 在被某订单占用后永远不可再次发给其他订单。
5. **审计可追溯**：管理员所有写操作（审核、抽成、停用、批量结算、调积分）必须落 AdminLog；所有积分变化必须落 PointLog。
6. **越权不可见**：商家访问其他商家资源、用户访问其他用户资源——返回 404 而非 403，避免暴露资源存在。

---

## 2. 用户与角色

### 2.1 角色定义

| 角色 | 系统标识 | 描述 | 创建路径 |
| --- | --- | --- | --- |
| 普通用户 | `role = 'user'` | 消费积分、兑换商品、签到、邀请 | 邮箱注册自助生成 |
| 商家 | `role = 'merchant'` | 在 `Merchant.status = 'active'` 前提下管理自有商品/订单/结算 | 普通用户提交申请 + 管理员审核通过 |
| 平台管理员 | `role = 'admin'` | 全量管理用户、商家、商品、订单、结算 | seed 预置 + 后续手动 SQL 提权（V3 引入"超级管理员授予角色"接口） |

### 2.2 复合状态矩阵

> 这是前端 Layout、入口控制、错误文案展示的真相来源。

| `User.role` | `Merchant.status` | 前端入口展示 | 商家后台访问 | 平台后台访问 |
| --- | --- | --- | --- | --- |
| `user` | `null`（未申请） | "申请成为商家" | 不可（重定向到申请页） | 不可 |
| `user` | `pending` | "商家申请审核中" | 不可（提示等待） | 不可 |
| `user` | `rejected` | "申请被拒绝，可重新申请" | 不可 | 不可 |
| `user` | `suspended` | "商家账号已被停用，请联系平台" | 不可 | 不可 |
| `merchant` | `active` | "进入商家后台" | 可 | 不可 |
| `admin` | 任意 | "进入平台后台"（管理员理论上不入驻商家，但允许并存） | 视 merchant 状态 | 可 |

**关键约束**：
- 管理员审核通过 / 停用商家时，**仅修改数据库**，不强制让用户重新登录。
- 用户 access token（JWT，15 分钟有效）中的 `role` 字段在被审核通过的瞬间是陈旧的。
- 前端必须实现 **role-skew 自愈**：每次 `/auth/me` 返回后比对 token 解码出的 `role` 与响应 `role`，不一致则触发 `/auth/refresh` 拿新 token，再放行角色敏感入口。
- 同时后端 `requireMerchant` 中间件以**数据库实时查询**为准，不仅信 JWT。

### 2.3 角色切换矩阵

| 操作 | 前置 `User.role` | 操作后 `User.role` | 同步 `Merchant.status` | 是否撤销 RefreshToken |
| --- | --- | --- | --- | --- |
| 用户注册 | 无 | `user` | — | — |
| 商家申请提交 | `user` | `user`（不变） | `pending` | 不撤销 |
| 管理员审核通过 | `user` | `merchant` | `active` | **必须撤销该用户所有 refreshToken** |
| 管理员拒绝 | `user` | `user`（不变） | `rejected` | 不撤销 |
| 管理员停用 | `merchant` | `user`（降级） | `suspended` | **必须撤销该用户所有 refreshToken** |
| 用户被封禁 | 任意 | `User.status = '已封禁'` | 不变 | **必须撤销该用户所有 refreshToken** |

> 撤销 RefreshToken 的设计目的：让用户在下次 access token 过期（≤15 min）时被强制走 `/auth/refresh`，然后因为 refreshToken 已撤销而被踢回登录页，从而拿到新角色的 token。

---

## 3. 核心业务模型

### 3.1 概念关系图

```
User ─┬─ PointAccount ── PointLog
      │                    │
      ├─ Merchant ── Product ── InventoryItem
      │     │           │
      │     │           └── Order ── DeliveryRecord
      │     │                  │
      │     │                  └── Settlement
      │     │
      │     └── (commissionRate 抽成快照)
      │
      ├─ CheckinRecord
      ├─ InviteRelation
      ├─ RefreshToken
      └─ AdminLog (admin 写)
```

### 3.2 核心实体职责

| 实体 | 职责 | 是否快照 |
| --- | --- | --- |
| `PointAccount` | 用户积分余额，单一权威来源 | 否 |
| `PointLog` | 每次余额变化的不可变日志，包含 `balanceAfter`、`reason`、`orderId?` | 是（写入即冻结） |
| `Product` | 商品定义，含 `merchantId nullable`（null = 平台自营） | 否 |
| `InventoryItem` | 单条卡密/订阅链接，状态 `available / sold / void` | 是（卖出即冻结） |
| `Order` | 订单，**快照**了下单时的 `price`、`merchantId`、`commissionRate`、`commissionAmount` | 是 |
| `DeliveryRecord` | 订单对应的实际发货内容（卡密文本） | 是 |
| `Settlement` | 商家分润记录，**快照**了 `orderAmount`、`commissionRate`、`commissionAmount`、`settlementAmount` | 是 |
| `CheckinRecord` | 每日签到，按 `(userId, date)` 唯一约束 | 是 |
| `InviteRelation` | 邀请关系，按 `inviteeId` 唯一（一人只能被一人邀请） | 是 |
| `RefreshToken` | 鉴权刷新令牌，存哈希，含 `userAgent`、`ip` | 是 |
| `AdminLog` | 管理员写操作审计 | 是 |

### 3.3 积分流向

```
来源（金额累加）
  ├─ 注册奖励（config.registerReward = 500）
  ├─ 邀请奖励（config.inviteReward = 200，邀请人）
  ├─ 签到奖励（config.checkinReward = 50）
  └─ 后台调整（管理员手动加，落 AdminLog + PointLog）

去向（金额扣减）
  ├─ 兑换商品（落 PointLog with orderId）
  └─ 后台调整（管理员手动扣，落 AdminLog + PointLog）

商家积分
  ├─ 商家本人也是 User，有 PointAccount
  ├─ 商家分润不直接进入商家 PointAccount
  └─ Settlement 仅在账面记录，"批量结算"仅改 status，不变更 PointAccount
       ※ 这是产品决策：内部福利平台的"商家"更像供应商角色，分润是平台的运营对账单据，
         不需要积分账户里真的多出钱来兑换其他商品
```

### 3.4 兑换流程时序（事务内）

```
POST /api/orders { productId }
  └─ 同事务：
     1. 查 PointAccount，校验余额 ≥ price
     2. 查 Product，校验 status='active'、库存 > 0
     3. 若 Product.merchantId ≠ null：
        - 查 Merchant，校验 status='active'
        - 计算 commissionAmount = floor(price * merchant.commissionRate)
        - 计算 settlementAmount = price - commissionAmount
     4. 锁取一条 InventoryItem（status='available'，按 id 升序）
     5. 扣减 PointAccount.balance
     6. 创建 Order（含快照字段）
     7. updateMany InventoryItem，校验 affected_count = 1（防并发）
     8. 创建 DeliveryRecord
     9. 创建 PointLog（type='out', orderId=order.id）
    10. 若有 merchantId：创建 Settlement（status='pending'）
    11. Product.stock -= 1, sales += 1
  └─ 返回 { orderId, productName, price, deliveryContent, balanceAfter, merchantId, merchantName }
```

> 第 7 步是**关键并发防御**：使用 `updateMany({ where: { id, status: 'available' }, data: ... })` 然后校验 `affected_count = 1`，避免乐观锁外加事务隔离级别问题。

---

## 4. 功能蓝图（按里程碑）

> ✅ = 已实现并测试  ⚠️ = 部分实现待补齐  🔲 = 未开始  ❌ = 明确不做

### 4.1 M1 — MVP 收尾（目标：2026-05-07）

#### 4.1.1 用户端

| 功能 | 状态 | 验收 |
| --- | --- | --- |
| 邮箱注册 / 登录 / 登出 | ✅ | 注册/登录/me/refresh/logout 接口 + 测试 |
| Cookie HttpOnly Refresh Token | ✅ | 浏览器 DevTools 看不到 refreshToken |
| 商品大厅 / 搜索 / 分类 | ✅ | StorePage 已具备 |
| 商品详情（含商家名） | ✅ | ProductDetailPage 展示 `merchant.name` 或"平台自营" |
| 兑换流程（含事务/库存校验） | ✅ | orders.test.ts 4 个用例覆盖 |
| 个人中心订单列表 | ✅ | ProfilePage 摘要展示，不暴露 deliveryContent |
| 订单详情弹窗 + 复制发货内容 | ✅ | OrderDetailModal |
| 每日签到 + 积分流水 | ✅ | 防重复签到，PointLog 完整 |
| 邀请码展示 | ✅ | ProfilePage |

#### 4.1.2 商家端

| 功能 | 状态 | 验收 |
| --- | --- | --- |
| 商家入驻申请页 | ✅ | MerchantApplyPage |
| 商家概览（productCount/orderCount/totalRevenue/pendingSettlement） | ✅ | MerchantDashboardPage:dashboard tab |
| 商品管理（创建/编辑/上下架） | ✅ | MerchantProductFormModal |
| 库存导入（多行文本拆分） | ✅ | MerchantInventoryImportModal |
| 订单列表 + 佣金/结算金额展示 | ⚠️ | **P0**：listMyOrders 未 include settlement，前端 `o.settlementAmount` 显示 undefined |
| 订单详情 | ⚠️ | 同上 |
| 结算列表 | ✅ | MerchantDashboardPage:settlements tab |
| 商家资料编辑 | ✅ | profile tab |

#### 4.1.3 平台管理端

| 功能 | 状态 | 验收 |
| --- | --- | --- |
| 数据概览 | ✅ | AdminPage:dashboard |
| 用户列表 + 积分调整 | ✅ | AdminPage:users |
| 商品库存导入（平台自营） | ✅ | AdminPage:products |
| 订单全量查看 | ✅ | AdminPage:orders |
| 操作日志查看 | ✅ | AdminPage:logs |
| 商家审核 / 拒绝 / 停用 | ✅ | AdminPage:merchants |
| 抽成调整 | ✅ | merchants tab 内联编辑 |
| 结算列表 + 批量结算 | ✅ | AdminPage:settlements |

#### 4.1.4 M1 必须修复的 P0 缺陷

> 这些是**阻断 MVP 交付**的明确缺陷，必须在 M1 关闭前清零。

| ID | 标题 | 影响 | 修复位置 |
| --- | --- | --- | --- |
| P0-1 | 商家订单未带 settlement 字段，前端 `settlementAmount` 显示 undefined | 商家无法看到自己的结算金额 | `server/src/modules/merchant/service.ts` `listMyOrders` / `getMyOrderDetail` 加 `include: { settlement: true }`；controller 扁平化 settlementAmount 到订单对象 |
| P0-2 | 审核通过 / 停用商家后未撤销旧 refreshToken | 旧 token 仍可访问，权限脱节最长 7 天 | `server/src/modules/admin/service.ts` `approveMerchant` / `suspendMerchant` 事务内 `revokeAllRefreshTokens(userId)` |
| P0-3 | Layout 商家入口仅覆盖 active 一种状态 | pending/rejected/suspended/null 状态用户看不到对应文案 | `src/components/Layout.tsx` 加 4 种条件渲染分支 |
| P0-4 | 前端缺 role-skew 自愈逻辑 | 用户审核通过后必须重新登录才能进商家后台 | `src/App.tsx` ProtectedRoute 内：解码 access token role 与 me.role 不一致时主动 refresh |
| P0-5 | 大量未提交工作（50+ 文件） | 分支无法合并 | 拆 3-4 个 commit：契约文档、后端模块、前端模块、其他 |
| P0-6 | 测试需要手动注入 TEST_DATABASE_URL | CI 无法运行测试 | 创建 `server/.env.test`（gitignored）+ 改 `package.json scripts.test` 默认加载 |

#### 4.1.5 M1 不做（推迟到 M2/M3）

- 订单状态机 / 手动履约
- 订阅 / 续费
- 商家提现申请流程
- 邮件通知
- 监控 / 告警
- CI/CD pipeline

### 4.2 M2 — 灰度上线（目标：2026-05-21）

#### 4.2.1 业务功能补强

| 模块 | 功能 | 优先级 | 说明 |
| --- | --- | --- | --- |
| 用户端 | 密码重置（邮箱链接） | P0 | 灰度阶段必须，否则忘记密码无人处理 |
| 用户端 | 修改密码（已登录态） | P1 | 个人中心入口 |
| 用户端 | 商品收藏 / 心愿单 | P3 | 推迟到 M4 |
| 商家端 | 销售统计图表（近 7/30 天） | P2 | 仪表盘升级 |
| 商家端 | 库存预警（库存 < 阈值时邮件提醒） | P1 | 触达 |
| 商家端 | 商家订单导出 CSV | P2 | 灰度运营会用 |
| 平台端 | 用户搜索高级筛选（按状态/积分区间/注册日期） | P1 | |
| 平台端 | 平台广告位管理（首页 banner） | P2 | 内容运营 |
| 平台端 | 系统配置面板（注册奖励、签到奖励、邀请奖励金额可配置） | P0 | 现在写死在 config，不能在线调整 |
| 平台端 | 用户封禁 / 解封 | P0 | 灰度必备 |
| 平台端 | 操作日志筛选 / 搜索 / 导出 | P1 | 审计 |

#### 4.2.2 生产化基础设施

| 类别 | 功能 | 优先级 | 实施 |
| --- | --- | --- | --- |
| **持久化** | PostgreSQL 每日定时备份（保留 30 天） | P0 | `pg_dump` cron + 异地存储 |
| **持久化** | 数据库密码、JWT_SECRET 走 secrets 管理 | P0 | `.env` → 1Password / Vault / docker secrets |
| **持久化** | 数据库慢查询日志 | P1 | postgresql.conf `log_min_duration_statement = 500ms` |
| **可观测** | 健康检查接口（`/api/health` 已具备）+ 数据库探活 | P0 | health 增加 `prisma.$queryRaw('SELECT 1')` |
| **可观测** | 结构化日志（JSON 格式 + 请求 ID） | P0 | pino + express-pino-logger |
| **可观测** | 错误聚合（前端 + 后端） | P0 | Sentry 或 self-hosted GlitchTip |
| **可观测** | 基础指标（QPS / 错误率 / 响应时间） | P1 | Prometheus + Grafana 或 hosted（如 OpenObserve） |
| **可观测** | 业务指标埋点（注册 / 登录 / 兑换 / 签到 / 申请商家） | P1 | 落到日志即可，不另起埋点系统 |
| **CI/CD** | GitHub Actions：lint + build + test | P0 | merge to master 必须通过 |
| **CI/CD** | 自动部署到 staging 环境 | P1 | rsync + pm2 reload，或 Docker compose pull |
| **CI/CD** | 数据库迁移自动化（部署时 `prisma migrate deploy`） | P0 | 部署脚本中执行 |
| **安全** | API 限流（已具备 helmet/cors/rate-limit）→ 增加按 IP+endpoint 细粒度 | P0 | 登录/注册/兑换三个端点单独限流 |
| **安全** | bcrypt rounds 至少 12 | P1 | 当前 10，灰度可保留，生产前升级 |
| **安全** | 依赖漏洞扫描（npm audit + Dependabot） | P0 | 周期性 |
| **安全** | secrets 不入仓 | P0 | `.gitleaks` precommit |
| **运维** | 部署 runbook（启动 / 停止 / 备份 / 回滚 / 紧急修复） | P0 | 写入 `docs/operations/runbook.md` |
| **运维** | 错误恢复演练（一次拉数据备份还原 staging） | P1 | 每月一次 |

#### 4.2.3 M2 验收硬指标

- [ ] 50 名内测用户注册，主链路成功率 ≥ 99%
- [ ] 一次完整故障演练通过：模拟 PG 重启 → 服务自愈 ≤ 30s
- [ ] CI 在所有合并 PR 上跑通 build + test
- [ ] 7 天滚动错误率 < 0.5%
- [ ] 一份 runbook，新运维 30 分钟内可独立完成"重启 / 备份恢复 / 改积分"三件事

### 4.3 M3 — 生产化（目标：2026-06-30）

#### 4.3.1 订单状态机（重要重构）

> 引入虚拟服务（手动履约）后，订单不再是"立即发货"。

**新订单状态枚举**：

```ts
type OrderStatus =
  | 'completed'      // 即时商品（卡密/订阅链接）兑换后立即完成（兼容现有）
  | 'pending'        // 虚拟服务下单，等待商家手动处理
  | 'processing'     // 商家已接单，正在履约
  | 'delivered'      // 商家已交付，等待用户确认
  | 'closed'         // 用户已确认 OR 自动 7 天后关闭
  | 'disputed'       // 用户发起争议
  | 'refunded'       // 平台仲裁退积分
```

**状态转移**：

```
即时商品：
  - 创建 → completed（与当前一致，零侵入）

虚拟服务：
  - 创建 → pending → processing → delivered → closed
                                      └─→ disputed → refunded / closed
```

**积分流转规则**：
- 创建虚拟服务订单时，积分**冻结**（标记为 `holding`），不直接扣减。
- `delivered` 状态超过 7 天自动 `closed`，积分正式扣减并触发 Settlement。
- `disputed` 由管理员仲裁，仲裁结果为 `refunded` 时**回滚**积分到用户余额，对应 Settlement 设为 `voided`。

**新增字段**（schema 演进）：
- `Order.holdingPoints: Int?` — 积分冻结量（虚拟服务订单使用）
- `Order.fulfillmentDeadline: DateTime?` — 商家履约截止时间
- `Order.confirmedAt: DateTime?` — 用户确认时间
- `OrderEvent` 新表：记录订单所有状态变化，含 `actor`、`fromStatus`、`toStatus`、`note`、`createdAt`

**接口扩展**：
- `POST /api/merchant/orders/:id/accept`（商家接单：pending → processing）
- `POST /api/merchant/orders/:id/deliver` body `{ content }`（商家提交履约结果：processing → delivered）
- `POST /api/orders/:id/confirm`（用户确认：delivered → closed，触发 Settlement）
- `POST /api/orders/:id/dispute` body `{ reason }`（用户发起争议：delivered → disputed）
- `POST /api/admin/orders/:id/resolve` body `{ result, note }`（管理员仲裁：disputed → refunded/closed）

#### 4.3.2 Settlement 演进

`Settlement.status` 增加：
- `holding` — 积分已冻结但订单未完结，结算未生效
- `voided` — 因争议退款而作废

`POST /api/admin/settlements/batch-settle` 仅允许处理 `pending` 状态。

#### 4.3.3 商家工作台增强

| 功能 | 说明 |
| --- | --- |
| 待处理订单消息中心 | 顶部消息提示有 N 条 pending 订单，点击进入待办 |
| 订单超时报警 | 超过 `fulfillmentDeadline` 高亮红色 |
| 商家自定义 SLA | 商家可设置自己的履约时长（默认 24h） |
| 拒单流程 | 商家可拒单（pending → refunded），积分立即退用户 |
| 商家通知偏好 | 邮件 / 站内信开关 |

#### 4.3.4 平台运营自助

| 功能 | 说明 |
| --- | --- |
| 系统公告 | 全站头部条幅，可设置生效起止时间 |
| 用户标签 | 给用户打 VIP / 黑名单 / 内测 等标签 |
| 商家评分 | 平台或用户对商家的服务评分（仅供平台内部参考） |
| 商家黑名单库存校验 | 同样卡密在多个商家上架时报警 |
| 数据看板 | 注册数 / DAU / 兑换转化率 / 商家分润排行 / 库存周转 |

#### 4.3.5 安全加固

| 项目 | 说明 |
| --- | --- |
| 多因素认证（TOTP） | 管理员强制开启 |
| 会话设备管理 | 用户可看到所有活动 RefreshToken（设备/IP/最近登录），一键吊销 |
| 风控规则引擎 | 异地登录提示、短时间多次失败封 IP、新注册账号兑换限额 |
| 数据脱敏 | 日志中邮箱/卡密一律打码 |
| 数据分类分级 | 敏感字段加密落库（如商家联系邮箱） |
| GDPR/隐私 | 用户数据导出 / 注销账户接口 |

#### 4.3.6 M3 验收硬指标

- [ ] 1000 名活跃用户，主链路 SLA ≥ 99.9%
- [ ] 虚拟服务订单全流程（接单/履约/确认/争议）完整覆盖测试
- [ ] 安全渗透测试（OWASP Top 10）一轮通过
- [ ] 一次完整生产灾备演练（异地恢复 ≤ 1h）

### 4.4 M4 — 业务演进（目标：2026-09-30）

#### 4.4.1 订阅 / 续费

| 功能 | 说明 |
| --- | --- |
| 订阅商品类型 | Product 增加 `isRecurring`、`billingCycleDays`、`autoRenew` |
| 订阅订单 | 新表 `Subscription`：`userId`、`productId`、`status`、`nextBillingAt`、`canceledAt` |
| 自动扣费 cron | 每日扫 `nextBillingAt ≤ now` 的订阅，事务内扣积分 + 发新库存 + 推下次扣费日 |
| 续费失败 | 积分不足时 `status = 'past_due'`，3 天宽限期，仍失败则 `canceled` |
| 订阅暂停 / 恢复 / 取消 | 用户可主动操作 |

#### 4.4.2 营销活动

| 功能 | 说明 |
| --- | --- |
| 满减 / 折扣券 | 仅在站内积分使用，不与法币挂钩 |
| 限时秒杀 | 商品级别限时半价 |
| 拼团 | 可选，运营复杂度高 |
| 积分商城活动 | 双倍积分日、抽奖等 |

#### 4.4.3 邀请激励 v2

| 功能 | 说明 |
| --- | --- |
| 多层邀请追踪 | 仅记录 1 级，不做多级分销（合规底线） |
| 邀请人数排行榜 | 头部用户激励 |
| 邀请奖励规则可配置 | 后台可设置不同活动期奖励额 |

#### 4.4.4 数据看板（运营版）

| 维度 | 指标 |
| --- | --- |
| 用户 | DAU / WAU / MAU、留存曲线、注册渠道分布 |
| 交易 | GMV（积分计价）、客单价、复购率、订单成功率 |
| 商家 | 商家排行、库存周转、争议率、SLA 达成率 |
| 履约 | 平均履约时长、超时率、自动关闭率 |

#### 4.4.5 M4 验收硬指标

- [ ] 10000 名活跃用户，DAU > 1000
- [ ] 订阅功能稳定运行 30 天，自动续费成功率 ≥ 99%
- [ ] 完成至少一次大型营销活动（双倍积分日）

---

## 5. 非功能需求

### 5.1 性能

| 指标 | M2 灰度 | M3 生产 | M4 演进 |
| --- | --- | --- | --- |
| API P95 响应时间 | < 500ms | < 300ms | < 200ms |
| 兑换接口峰值 QPS | 5 | 50 | 200 |
| 数据库连接数 | < 10 | < 30 | < 100（含读副本） |
| 静态资源加载 | < 3s | < 2s | < 1s（CDN） |

> 注：M3/M4 才考虑 PostgreSQL 读写分离 / Redis 缓存。M1/M2 单实例足够。

### 5.2 可用性

| 指标 | M2 | M3 | M4 |
| --- | --- | --- | --- |
| SLA | 99% | 99.9% | 99.95% |
| RTO（故障恢复） | 1h | 30min | 10min |
| RPO（数据丢失） | 24h | 1h | 5min |
| 备份频次 | 每日 | 每 6h + WAL | 实时复制 |

### 5.3 安全

详见 4.2.2、4.3.5。核心红线：

- 所有敏感字段（password、tokenHash、JWT_SECRET）禁止明文落仓。
- 所有用户输入必须 Zod 校验（已具备）。
- 所有数据库操作必须用 Prisma 参数化（禁止 `$queryRawUnsafe`，setup.ts 中的 TRUNCATE 是特例且仅在测试库）。
- 所有跨域请求必须 `credentials: true` + 白名单 origin。
- 所有错误响应不得泄露内部堆栈或 SQL 信息（已具备 errorHandler）。

### 5.4 可观测

| 类别 | 工具 | 说明 |
| --- | --- | --- |
| 日志 | pino → 文件 → Loki / Elasticsearch | 结构化 JSON，含 requestId、userId |
| 错误 | Sentry / GlitchTip | 前后端统一 |
| 指标 | Prometheus / Grafana | API、DB、JVM-style |
| 业务 | 写入 PointLog / AdminLog / OrderEvent | 业务即审计 |
| 告警 | Alertmanager → Slack / 飞书 / 邮件 | 阈值定义在 runbook |

### 5.5 可维护性

- 前后端独立 PR，禁止跨边界修改（已具备规范）。
- Conventional Commits（已具备）。
- 每个模块必须有 README 或 DESIGN（M3 启动前补齐）。
- 所有 P0/P1 缺陷必须有对应回归测试。
- 契约变更必须先改文档再改代码。

---

## 6. 技术架构

### 6.1 当前架构

```
┌──────────────────────────────────────────────┐
│  Browser (React 18 + Vite + Zustand + Tailwind) │
└──────────────────┬───────────────────────────┘
                   │ HTTPS (Cookie + Bearer)
                   ▼
┌──────────────────────────────────────────────┐
│  Express 4 (Node 22)                         │
│  ├─ helmet / cors / rate-limit / cookie-parser│
│  ├─ Zod 校验                                  │
│  ├─ JWT (15min) + RefreshToken (7d, hashed)  │
│  └─ Modules: auth/products/orders/points/    │
│             admin/merchant                   │
└──────────────────┬───────────────────────────┘
                   │ Prisma 6
                   ▼
┌──────────────────────────────────────────────┐
│  PostgreSQL 16                               │
└──────────────────────────────────────────────┘
```

### 6.2 M2 目标架构

```
+ Nginx (TLS 终止 + 静态资源 + 反向代理)
+ pino 结构化日志 → 本地文件
+ Sentry SDK
+ Prometheus exporter（node-exporter + postgres-exporter + 应用 /metrics）
+ Grafana
+ pg_dump cron + 异地备份
+ pm2 进程管理 + 自动重启
```

### 6.3 M3 目标架构

```
+ 应用多实例（pm2 cluster mode）
+ Redis（用于：rate-limit 共享 / 会话黑名单 / OTP 缓存）
+ 全文搜索（PostgreSQL + pg_trgm 即可，不引入 ES）
+ S3 兼容对象存储（用户头像、商品图片、备份）
+ CDN（静态资源）
```

### 6.4 M4 目标架构

```
+ 读副本（PostgreSQL streaming replication）
+ 消息队列（用于：订阅扣费 cron 解耦、邮件异步发送）
+ 数据仓库 / 报表数据库（增量同步主库）
```

> **关键决策**：从 M1 到 M4 全程**不引入 Kubernetes**。100-10000 用户规模 + 内部福利平台属性下，docker-compose + pm2 完全够用，K8s 是过度设计。

### 6.5 数据库扩展能力

- M1/M2：单实例 + 每日备份 ✅
- M3：streaming replication（主从）+ 自动故障切换（patroni 可选，过早可不上）
- M4：分库可能性极小；如真到瓶颈，按 `merchantId` 水平分片是最自然方向

### 6.6 部署拓扑（M2 推荐）

```
┌──────────────────────────────┐
│  Cloud VPS (4C8G)            │
│  ├─ Nginx (TLS, 443/80)      │
│  ├─ Node.js (3000) × 2 进程  │
│  ├─ PostgreSQL 16 (5432)     │
│  └─ pgBackRest 备份脚本       │
└────────────┬─────────────────┘
             │
             ▼
   异地备份存储（OSS/S3）
```

---

## 7. 开发与协作规范

### 7.1 分支模型

```
master            ← 受保护，仅由 integration/* 合入
  ├─ feat/backend-*       后端独立功能
  ├─ feat/frontend-*      前端独立功能
  ├─ integration/*        前后端联调集成
  ├─ fix/*                热修复
  └─ docs/*               纯文档
```

详见 `2026-04-28-monexus-demo-to-mvp-prd.md` § 12，本 PRD 不重复。

### 7.2 提交规范

Conventional Commits + scope：

```
feat(server): add order state machine
feat(frontend): add merchant order detail drawer
fix(auth): revoke refresh tokens on suspend
docs(prd): add M3 milestone
chore(ci): add github actions workflow
test(merchant): cover ownership boundary
refactor(orders): extract settlement creation
```

### 7.3 文件所有权

| 目录 | 所有者 | 备注 |
| --- | --- | --- |
| `server/**` | 后端 | 前端禁止修改 |
| `src/**` | 前端 | 后端禁止修改 |
| `docs/superpowers/specs/**` | 集成人员 + 双方确认 | 契约变更先改这里 |
| `docs/superpowers/plans/**` | 集成人员 | 任务计划 |
| 根 `package.json` / `vite.config.ts` | 前端 | |
| `docker-compose.yml` | 后端 | |
| `scripts/dev-up.*` | 集成人员 | 双方协商 |

### 7.4 Definition of Done

每个任务必须：

1. 代码实现完成 + 自检通过
2. 单元测试 / 集成测试覆盖关键路径
3. `npm run build`（前端）+ `npm --prefix server run build`（后端）通过
4. 契约一致（如改了响应字段，必须同时改 contract.md）
5. 提交信息符合 Conventional Commits
6. PR 描述包含：背景 / 改动点 / 测试方式 / 已知限制

---

## 8. 风险与应对

| 风险 | 影响 | 概率 | 应对 |
| --- | --- | --- | --- |
| 商家恶意上架卡密但实际无效 | 用户信任度受损 | 中 | M3 引入争议流程；商家信用评分；超过阈值自动停用 |
| 同一卡密被多个商家上架 | 重复发货 | 低 | M3 库存指纹哈希校验，发现重复触发管理员告警 |
| 积分通货膨胀（运营持续发奖励但无消耗渠道） | 用户兑换无吸引力 | 中 | 后台监控积分发放 vs 兑换比，运营动态调整 |
| 单实例 PG 故障 | 数据全丢 | 低 | M2 上每日备份 + 异地存储；M3 上主从复制 |
| 管理员账号泄露 | 平台被颠覆 | 低 | M3 上 MFA 强制；M2 上限制管理员 IP 白名单 |
| 灰度阶段流量爆发（病毒邀请） | 服务雪崩 | 中 | rate-limit 分层；活动前压测；M3 起 Redis-based 全局限流 |
| 前后端契约漂移 | 发布即坏 | 中 | OpenAPI lint 进 CI；契约变更必须双签 |
| 测试库与生产库混用导致清理事故 | 数据丢失 | 低 | TEST_DATABASE_URL 严格校验（已具备）；测试 truncate 仅在 NODE_ENV=test |
| 用户密码恢复流程缺失 | 灰度阶段大量用户求助 | 高 | M2 必做：邮箱链接重置密码 |
| 内部福利平台积分变成"灰色货币"（用户站外交易） | 合规风险 | 中 | 用户协议明确"积分仅站内使用，禁止站外交易"；账号实名（M3） |

---

## 9. 验收路标

### 9.1 M1 验收（2026-05-07 前）

- [ ] P0-1 ~ P0-6 全部修复并提交
- [ ] 三角色完整联调一次（user / merchant / admin）
- [ ] 后端测试套件 ≥ 40 用例全过
- [ ] 前后端 build 通过
- [ ] PR 合并到 `master`
- [ ] `master` 分支可直接启动并完整跑通主链路
- [ ] OpenAPI 文档与实现一致（手动 diff 一轮）

### 9.2 M2 验收（2026-05-21 前）

- [ ] CI/CD pipeline 工作
- [ ] 监控仪表盘可访问
- [ ] 错误聚合 SDK 接入
- [ ] 备份脚本运行至少一次成功还原演练
- [ ] 部署 runbook 完成
- [ ] 50 名内测用户完成至少一次兑换
- [ ] 一次故障演练（kill 数据库 → 自动重启 → 服务可用）

### 9.3 M3 验收（2026-06-30 前）

- [ ] 订单状态机上线，至少一种虚拟服务全流程跑通
- [ ] 商家工作台增强发布
- [ ] 多因素认证强制开启（管理员）
- [ ] 安全渗透测试通过
- [ ] 1000 用户规模压测通过

### 9.4 M4 验收（2026-09-30 前）

- [ ] 至少一种订阅商品上线
- [ ] 一次双倍积分活动
- [ ] DAU > 1000
- [ ] 数据看板上线

---

## 10. 关键决策记录（ADR-style）

> 这里只记录"为什么这么选"，不记录"如何做"。

### 10.1 决策 #1：积分体系永不与法币挂钩

- **背景**：用户明确选择"纯内部福利/积分激励平台"。
- **决策**：积分仅站内使用，不支持充值、提现、法币兑换、多币种。
- **影响**：架构上不需要支付通道、合规发票、KYC、AML、税务接口。

### 10.2 决策 #2：商家分润不进入商家积分账户

- **背景**：商家是供应商角色，非"消费者"。
- **决策**：Settlement 仅是账面记录，"批量结算"仅改 status，**不变更 PointAccount**。
- **影响**：商家的 PointAccount 仅作为"商家本人作为用户使用平台"的余额，不与分润混淆。

### 10.3 决策 #3：商品轻管控

- **背景**：用户选择"轻管控（当前）"。
- **决策**：商家可自由上架商品和导入库存，无需平台审核；平台保留 suspend 与商品下架兜底能力。
- **影响**：M3 起增加"商家信用评分"+"争议流程"+"商品下架"作为事后兜底，不引入事前审核流。

### 10.4 决策 #4：不引入 Kubernetes

- **背景**：100-10000 用户规模，内部福利平台属性。
- **决策**：M1-M4 全程使用 docker-compose + pm2。
- **影响**：运维成本低；如真到 10万级别再迁 K8s，迁移成本可控。

### 10.5 决策 #5：列表接口不返回 total

- **背景**：契约 §5 明确"本阶段列表响应冻结为数组，不返回 total"。
- **决策**：保持当前数组返回；UI 用"加载更多 / 下一页"模式。
- **影响**：M3 起如运营要 total，必须先变更契约，前后端同时升级。

### 10.6 决策 #6：管理员审核通过后强制撤销 RefreshToken

- **背景**：JWT 是 15 分钟无状态的，role 字段陈旧期最长 7 天（refreshToken 寿命）。
- **决策**：审核通过、停用、封禁三个动作必须撤销该用户所有 RefreshToken；前端实现 role-skew 自愈。
- **影响**：用户体验上会被强制重新登录一次，但角色权限边界永远清晰。

### 10.7 决策 #7：订单状态机仅在 M3 引入

- **背景**：当前 `status='completed'` 已能覆盖即时商品。
- **决策**：M3 引入新状态时**保持兼容**：即时商品继续 `completed`，虚拟服务走 `pending → processing → delivered → closed`。
- **影响**：迁移零侵入；现有订单不需要数据迁移。

---

## 11. 附录

### 11.1 引用文档

- `docs/superpowers/specs/2026-04-27-postgresql-auth-security-design.md` — 鉴权设计
- `docs/superpowers/specs/2026-04-29-monexus-merchant-settlement-contract.md` — 商家结算契约
- `docs/superpowers/specs/monexus-api-openapi.json` — OpenAPI 机器可读契约
- `docs/superpowers/2026-04-28-postgresql-auth-security-review-and-local-manual.md` — 鉴权评审与本地手册

### 11.2 术语表

| 术语 | 含义 |
| --- | --- |
| 积分 | 站内整数虚拟币，禁止与法币挂钩 |
| 卡密 / InventoryItem | 单条数字商品凭证，状态 available/sold/void |
| 抽成 / commissionRate | 平台对商家订单按比例抽成，0-1 之间小数 |
| 结算 / Settlement | 商家分润账面记录 |
| 履约 | 商家把商品交付给用户的过程，即时 / 手动两种模式 |
| role-skew | JWT 中角色与数据库实际角色不一致 |
| ownership 校验 | 商家访问资源时校验资源 merchantId 与请求者商家 id 一致 |
| 即时商品 | 库存类商品（卡密 / 订阅链接），下单即发货 |
| 虚拟服务 | 需要商家手动履约的商品（M3 起） |

### 11.3 不变量自检清单

任何 PR 合并前必须自检：

- [ ] 积分相关字段全部为整数
- [ ] commissionRate 响应为字符串
- [ ] 兑换流程在单事务内完成
- [ ] 库存 updateMany affected_count = 1 校验仍在
- [ ] 管理员写操作落 AdminLog
- [ ] 积分变化落 PointLog
- [ ] 商家访问资源经过 ownership 校验
- [ ] 越权返回 404 而非 403
- [ ] 无 `parseInt(req.params.*)` 残留
- [ ] 无 `throw new Error(...)` 用户态错误
- [ ] 无 `new PrismaClient()` 复制（仅 `lib/prisma.ts`）

---

## 12. 文档维护

- 本 PRD 是**活文档**，每次里程碑收尾必须 review 一遍。
- 任何业务边界变更（如未来引入支付）必须升 v2.0 并备份 v1.0。
- 当前版本审批人：项目负责人。
- 下一次 review 时间：M1 收尾时（2026-05-07）。

---

**文档结束**
