# Tasks: 订单消息通知体系

| 字段 | 值 |
|------|------|
| 文档 ID | TASK-NOTIFY-001 |
| 版本 | 1.1.0 |
| 日期 | 2026-08-07 |
| 状态 | Phase 1 Implemented |
| 规格 | [spec.md](./spec.md) |
| 设计 | [design.md](./design.md) |

---

## 依赖图

```text
T00 baseline
     │
     ▼
T01 Prisma migration
     │
     ▼
T02 Core modules (dispatcher + templates)
     │
     ├─────────┬─────────┬─────────┐
     ▼         ▼         ▼         ▼
T03 Service  T04 挂载点  T05 API  T06 前端
     │         │         │         │
     └─────────┴─────────┴─────────┘
               ▼
          T07 测试与验收
```

---

## Phase 0 — 基线

### Task-00: 基线与前置检查

**Objective**

确认环境、依赖、worktree 干净，记录基线 commit。

**Relevant Spec**

- spec.md §8 前置条件与依赖

**Dependencies**

无

**Implementation Notes**

1. 从最新 `develop` 建 `feat/order-notifications` worktree
2. 确认 `SPEC-MAIL-TPL-001` 已合入（`server/src/lib/mailer/templates/` 存在）
3. 确认 `OrderStatusEvent`、`Announcement` 现有功能正常
4. 记录 migration head

**Acceptance Criteria**

- [x] worktree 干净，`git status` 无未提交文件
- [x] `npm --prefix server run build` 成功
- [x] `npm --prefix server test -- orders` 通过
- [x] `npm --prefix server test -- announcements` 通过
- [x] migration head 记录在 task commit message

**Verification**

```bash
git status
npm --prefix server run build
npm --prefix server test -- orders/fulfillment
npm --prefix server test -- announcements
npx prisma migrate status --schema=server/prisma/schema.prisma
```

---

## Phase 1 — 数据模型

### Task-01: Prisma migration（Notification 表）

**Objective**

生成 Prisma migration，新增 `Notification` 表及索引。

**Relevant Spec**

- spec.md §6 配置
- design.md §2.1 Notification 表

**Likely Files**

- `server/prisma/schema.prisma`
- `server/prisma/migrations/<timestamp>_order_notifications/migration.sql`

**Dependencies**

- Task-00

**Implementation Notes**

1. 在 `schema.prisma` 添加 `Notification` model（见 design.md §2.1）
2. 在 `User` model 添加 `notifications Notification[]` 关系
3. 使用 `prisma migrate dev --name order_notifications` 生成
4. 验证 `@@unique([recipientUserId, eventType, dedupeKey])` 约束存在
5. 验证索引 `@@index([recipientUserId, status, createdAt])` 等存在
6. **不要**在本 migration 创建 `NotificationPreference`、`NotificationDelivery`、
   `Merchant.notificationEmail` 或任何平台值班/订单 owner 字段（spec D-09～D-11）
7. Phase 2 启用商家邮件时，收件人沿用 `Merchant.contactEmail ?? Merchant.user.email`；
   Phase 1 不实现邮件通道，也不为该回退规则新增字段

**Acceptance Criteria**

- [x] `Notification` model 包含所有必需字段
- [x] 唯一约束 `(recipientUserId, eventType, dedupeKey)` 存在
- [x] 索引 `recipientUserId + status + createdAt` 存在
- [x] migration 只新增 `Notification` 及其 `User` 关系，不新增偏好、邮件收件人或平台分配 schema
- [x] `prisma migrate status` 显示 "Database schema is up to date"
- [x] `prisma generate` 成功，TS 类型生成

**Verification**

```bash
cd server
npx prisma migrate status
npx prisma migrate reset --force  # 测试 migration 可重放
npx prisma generate
npm run build
```

---

## Phase 2 — 核心模块

### Task-02: NotificationDispatcher 与模板

**Objective**

实现通知分发器核心逻辑、过滤规则、模板渲染。

**Relevant Spec**

- spec.md §4 履约模式 × 通知矩阵
- spec.md §5 事件目录
- design.md §3.1 NotificationDispatcher
- design.md §3.2 通知模板

**Likely Files**

- `server/src/modules/notifications/dispatcher.ts`（新建）
- `server/src/modules/notifications/templates.ts`（新建）
- `server/src/modules/notifications/__tests__/dispatcher.test.ts`（新建）
- `server/src/modules/notifications/__tests__/templates.test.ts`（新建）

**Dependencies**

- Task-01

**Implementation Notes**

1. **dispatcher.ts**:
   - `NotificationDispatcher.emit(event, tx)` 接口
   - `shouldNotifyMerchantNewOrder(input)` 过滤逻辑（spec NTF-05）：仅
     `manual_service + merchantId + 无 ProvisionTask/FakaBridgeTask + pending/processing`
   - `shouldNotifyBuyerDelivered(order)` 过滤逻辑（spec NTF-06）
   - 生成 `dedupeKey`：`order:{orderId}:merchant_new` 等
   - 幂等写入：`tx.notification.create` + `ON CONFLICT DO NOTHING`

2. **templates.ts**:
   - `renderNotification(eventType, context)` 函数
   - Phase 1 事件模板（见 design.md §3.2 文案清单）:
     - `order.created_merchant`
     - `order.processing_buyer`
     - `order.delivered_buyer`
     - `order.disputed_*`
     - `order.refunded_*`
     - `order.closed_buyer`
   - 生成 `deeplink`：`/orders?focus={id}` 或 `/merchant/orders/{id}`
   - 敏感内容过滤（spec NTF-03）
   - `title/body` 一律纯文本；拒绝/不生成 HTML、Markdown、image URL、附件和交付内容（spec NTF-12）

3. **测试覆盖**:
   - 即时单不通知商家
   - 人工单通知商家
   - checkout 直接创建为 `delivered` 的即时单只给买家创建 1 条弱通知
   - FakaBridge/autoProvision 成功不通知商家，仍通知买家
   - 平台自营 `manual_service` 不创建合成 admin/邮箱通知
   - 重复事件幂等（同 dedupeKey 多次调用只创建 1 条）
   - 各 eventType 模板渲染结果断言，且 HTML/Markdown 字符作为文本、payload 无 image/file/content

**Acceptance Criteria**

- [x] `shouldNotifyMerchantNewOrder` 对 instant/manual/faka 三种模式判定正确
- [x] 平台自营人工单与任一自动履约任务均不会进入商家新单分发
- [x] 幂等测试：同 dedupeKey 重复调用只创建 1 条通知
- [x] 所有 Phase 1 eventType 模板测试通过
- [x] `payload` 不包含敏感内容（卡密、交付 content）
- [x] `deeplink` 格式正确（相对路径，不含外部 URL）
- [x] 单元测试 15+ 用例全绿

**Verification**

```bash
npm --prefix server test -- notifications/dispatcher
npm --prefix server test -- notifications/templates
```

---

### Task-03: Notification Service（API 实现）

**Objective**

实现通知 CRUD API：列表、未读数、已读、全部已读。

**Relevant Spec**

- design.md §4 API 设计
- spec.md §3 领域规则（NTF-09 权限）

**Likely Files**

- `server/src/modules/notifications/service.ts`（新建）
- `server/src/modules/notifications/controller.ts`（新建）
- `server/src/modules/notifications/routes.ts`（新建）
- `server/src/modules/notifications/schema.ts`（新建）
- `server/src/modules/notifications/__tests__/service.test.ts`（新建）

**Dependencies**

- Task-01, Task-02

**Implementation Notes**

1. **service.ts**:
   - `listNotifications(userId, { cursor, limit, status, category })`
   - `getUnreadCount(userId)`
   - `markAsRead(userId, notificationId)`
   - `markAllAsRead(userId)`
   - 权限检查：只返回 `recipientUserId = userId`

2. **routes.ts**:
   - `GET /api/notifications`（需要 `requireActiveUser`）
   - `GET /api/notifications/unread-count`
   - `POST /api/notifications/:id/read`
   - `POST /api/notifications/read-all`

3. **schema.ts**:
   - `listNotificationsSchema`（cursor, limit, status, category）
   - `markAsReadSchema`（id 参数）

4. **测试覆盖**:
   - 用户只能访问自己的通知（跨用户返回 404）
   - 商家看到商家通知，买家看到买家通知
   - 未读数查询正确
   - 已读幂等（重复标记不报错）
   - Cursor 分页正确

**Acceptance Criteria**

- [x] 列表 API 返回格式符合 design.md §4.1
- [x] 未读数 API < 100ms（单索引查询）
- [x] 跨用户访问返回 404
- [x] 已读幂等：重复标记返回 200
- [x] Cursor 分页：`hasMore` 和 `nextCursor` 正确
- [x] 单元测试 10+ 用例全绿

**Verification**

```bash
npm --prefix server test -- notifications/service
npm --prefix server test -- notifications/routes
```

---

## Phase 3 — 业务集成

### Task-04: 挂载点接线（订单业务）

**Objective**

在订单状态迁移处触发通知分发，覆盖 Phase 1 所有事件。

**Relevant Spec**

- spec.md §5 事件目录
- design.md §3.3 挂载点

**Likely Files**

- `server/src/modules/orders/service.ts`（修改）
- `server/src/modules/orders/fulfillment.ts`（修改）
- `server/src/modules/orders/__tests__/orders.test.ts`（修改，增加通知断言）

**Dependencies**

- Task-02, Task-03

**Implementation Notes**

1. **下单成功（商家新单）**:
   - 位置：`createOrderOnce` 事务内，**自动履约任务创建分支和即时
     `DeliveryRecord` 写入之后**、幂等 claim 完成之前；不得在 `tx.order.create` 后立即分发
   - 条件：`config.notification.enabled && shouldNotifyMerchantNewOrder({ merchantId, deliveryMode, status, hasProvisionTask, hasFakaBridgeTask })`
   - 事件：`order.created_merchant`
   - 收件人：从既有 `Merchant.userId` 取商家主账号；`merchantId=null` 时跳过，
     不广播给所有 admin

2. **买家 delivered 通知（两条真实路径）**:
   - checkout 直接即时交付：`instant_inventory` / `instant_fixed` 在订单创建时已经
     是 `delivered`，在 `DeliveryRecord` 落库后创建弱 `order.delivered_buyer`
   - 状态迁移：`transitionOrderStatus` 的 `to === 'delivered'` 分支覆盖商家发货、
     autoProvision 与 Faka 成功
   - 事件：`order.delivered_buyer`
   - 自动开通成功只发给买家；不得生成商家成功确认通知

3. **状态迁移（争议/退款）**:
   - 位置：`transitionOrderStatus` 函数，各状态分支
   - 事件：`order.disputed_*`, `order.refunded_*`

4. **环境开关**:
   - 检查 `config.notification.enabled`，关闭时跳过（零副作用）

5. **测试更新**:
   - 现有订单测试增加通知断言
   - 新增集成测试：人工单、即时直接 delivered、Faka/autoProvision、平台自营人工单

**Acceptance Criteria**

- [x] 下单成功 → 商家收到 `order.created_merchant`（仅人工单）
- [x] 商家发货 → 买家收到 `order.delivered_buyer`
- [x] 即时 checkout 直接 delivered → 买家仅收到 1 条弱 `order.delivered_buyer`，商家无通知且无邮件
- [x] Faka/autoProvision 成功 → 买家通知存在，商家成功通知不存在；已有降级邮件行为无回归
- [x] 争议 → 买卖双方各收到 `order.disputed_*`
- [x] 退款 → 买卖双方各收到 `order.refunded_*`
- [x] 平台自营 `manual_service` 不生成 `order.created_merchant`，也不向所有 admin 广播
- [x] `NOTIFICATION_ENABLED=false` 时不写入通知
- [x] 现有订单测试仍通过（无回归）
- [x] 新增集成测试覆盖所有挂载点

**Verification**

```bash
npm --prefix server test -- orders/service
npm --prefix server test -- orders/fulfillment
npm --prefix server test -- notifications/integration
```

---

## Phase 4 — 前端

### Task-05: API 客户端与类型

**Objective**

添加前端通知 API 客户端、TypeScript 类型。

**Relevant Spec**

- design.md §4 API 设计

**Likely Files**

- `src/api/notifications.ts`（新建）
- `src/types/notification.ts`（新建）

**Dependencies**

- Task-03

**Implementation Notes**

1. **notifications.ts**:
   - `getNotifications(params: { cursor?, limit?, status?, category? })`
   - `getUnreadCount()`
   - `markAsRead(id: number)`
   - `markAllAsRead()`

2. **notification.ts**:
   - `Notification` 接口（对应后端响应）
   - `NotificationListResponse` 接口

**Acceptance Criteria**

- [x] API 函数签名与后端契约一致
- [x] TypeScript 类型完整，无 `any`
- [x] 错误处理（401/404/500）

**Verification**

```bash
npm run typecheck
```

---

### Task-06: 消息中心页与铃铛集成

**Objective**

实现前端消息中心页、铃铛未读数、公告/消息双分区。

**Relevant Spec**

- design.md §5 前端集成
- spec.md 决策 D-06（铃铛入口）

**Likely Files**

- `src/pages/NotificationsPage.tsx`（新建）
- `src/components/Layout.tsx`（修改，铃铛集成）
- `src/components/AnnouncementCenter.tsx`（扩展为公告/消息双 Tab；可重命名但复用现有 Dialog）
- `src/stores/appStore.ts`（修改，添加 `notificationUnreadCount`）
- `src/App.tsx`（添加路由 `/notifications`）

**Dependencies**

- Task-05

**Implementation Notes**

1. **NotificationsPage.tsx**:
   - 列表展示（标题、正文、时间、已读状态）
   - Tab 筛选：全部 / 订单 / 系统
   - 点击跳转到 `deeplink`
   - 已读按钮、全部已读按钮
   - 分页加载（cursor-based）

2. **铃铛集成（决定：单铃铛、同一 Dialog 双 Tab）**:
   - 顶栏铃铛显示总未读数（公告 + 消息）
   - 扩展现有桌面 `AnnouncementBellButton` 和移动 Bell trigger；不新建第二个图标，
     不将既有 Dialog 改成 Popover
   - 点击打开同一个中心 Dialog，两个 Tab：公告 | 消息
   - 有 `acknowledgement_required` 公告时默认公告 Tab；否则有消息未读时默认消息 Tab
   - 消息 Tab 显示最近 5 条，"查看全部"跳转 `/notifications`

3. **appStore.ts**:
   - `notificationUnreadCount: number`
   - `refreshNotificationUnread()` 方法
   - 轮询逻辑：登录后启动，30s 间隔

4. **路由**:
   - `/notifications` → `NotificationsPage`

**Acceptance Criteria**

- [x] 消息中心页展示通知列表
- [x] 点击通知跳转到对应订单详情
- [x] 已读按钮工作，未读数实时更新
- [x] 铃铛未读数 = 公告未读 + 消息未读
- [x] 一个桌面/移动铃铛打开同一 Dialog，公告/消息双 Tab 正确切换
- [x] 待确认公告仍可自动打开且优先公告 Tab；既有公告 test id/已读行为不回归
- [x] 轮询每 30s 刷新未读数
- [x] 响应式布局（移动端友好）

**Verification**

```bash
npm run dev  # 本地测试
npm run build  # 生产构建
npm run typecheck
```

---

## Phase 5 — 测试与验收

### Task-07: E2E 测试与 Checklist

**Objective**

编写 E2E 测试覆盖关键场景，完成 checklist 验收。

**Relevant Spec**

- spec.md §7 验收标准
- design.md §7 测试策略

**Likely Files**

- `e2e/notifications.spec.ts`（新建）
- `docs/specs/order-notification-system/checklist.md`（新建）

**Dependencies**

- Task-04, Task-06

**Implementation Notes**

1. **E2E 测试场景**:
   - A-01: 买家下人工单 → 商家未读 +1
   - A-02: 买家下即时单 → 商家无通知
   - A-03: 商家发货 → 买家通知，点击跳转
   - A-04: FakaBridge 成功 → 买家有通知，商家无通知
   - A-06: 公告未读与消息未读独立
   - A-11: 即时 checkout 直接 delivered → 买家有弱消息记录、无邮件
   - A-12: 公告/消息共用单铃铛与同一 Dialog；待确认公告优先公告 Tab
   - A-13: 通知内容纯文本，不渲染 HTML/Markdown 或媒体
   - A-14: 平台自营人工单不生成虚构的 admin/邮箱收件人

2. **Checklist**:
   - Phase 1 功能完整性
   - 所有单元测试通过
   - 所有集成测试通过
   - E2E 测试通过
   - 性能基准（未读数 < 100ms）
   - 安全检查（跨用户访问、敏感内容）

**Acceptance Criteria**

- [x] E2E 测试覆盖 spec.md §7 所有验收标准
- [x] Checklist 所有 P0 项勾选
- [x] 不存在 `NotificationPreference`、`NotificationDelivery`、独立店铺通知邮箱或平台 owner schema 的 Phase 1 migration
- [x] `npm run e2e -- e2e/notifications.spec.ts` 全绿（完整 e2e 套件未在本 session 全量跑）
- [x] `npm --prefix server test -- notifications|orders|announcements` 全绿（全量 server test 未在本 session 跑完）
- [x] 性能基准达标（未读数单索引 count 查询）

**Verification**

```bash
npm run e2e -- notifications
npm --prefix server test
npm run verify:local:no-e2e
```

---

## Task 汇总

| Task | 描述 | 预估工作量 | 依赖 |
|------|------|-----------|------|
| T00 | 基线与前置检查 | 0.5h | - |
| T01 | Prisma migration | 1h | T00 |
| T02 | Dispatcher + 模板 | 4h | T01 |
| T03 | Service + API | 3h | T01, T02 |
| T04 | 挂载点接线 | 3h | T02, T03 |
| T05 | 前端 API 客户端 | 1h | T03 |
| T06 | 消息中心页 + 铃铛 | 4h | T05 |
| T07 | E2E + Checklist | 2h | T04, T06 |
| **总计** | | **18.5h** | |

---

## 并行策略

| 阶段 | 可并行 Task | 串行约束 |
|------|------------|---------|
| Phase 1-2 | T01 → T02, T03 可并行（共享 migration） | T01 必须先完成 |
| Phase 3 | T04 独立（修改订单模块） | 依赖 T02, T03 |
| Phase 4 | T05, T06 可并行 | 依赖 T03 API 稳定 |
| Phase 5 | T07 必须最后（集成验收） | 依赖所有前置 |

---

## 实施注意事项

### ✅ Always

- 阅读相关现有代码（`orders/fulfillment.ts`, `announcements/`）
- 修改 Task 范围内代码
- 添加/修改单元测试
- 运行 `lint` / `typecheck` / `test`

### ⚠️ Ask First

- 修改公共 API contract（如改变 `OrderStatusEvent` 结构）
- 修改 `Announcement` 系统
- 引入新依赖（如 Redis Pub/Sub）
- 改变已有订单状态机逻辑

### 🚫 Never

- 修改生产数据库
- 提交真实用户通知测试数据
- 绕过权限检查（跨用户访问）
- 删除现有 `OrderStatusEvent` 测试

---

## 验证脚本

每个 Task 完成后运行：

```bash
# 类型检查
npm run typecheck
cd server && npm run build

# 单元测试
npm --prefix server test -- notifications

# 集成测试
npm --prefix server test -- orders

# E2E 测试（Task 07）
npm run e2e -- notifications

# 完整门禁
npm run verify:local:no-e2e
```

---

## 回滚计划

如果需要回滚：

1. 关闭 `NOTIFICATION_ENABLED=false`（通知接口 404，写入跳过）
2. 前端隐藏通知入口（feature flag）
3. 数据库表保留（不删除 migration）
4. 代码回滚：`git revert <merge-commit>`
