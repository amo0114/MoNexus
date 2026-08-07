# Design: 订单消息通知体系

| 字段 | 值 |
|------|------|
| 文档 ID | DESIGN-NOTIFY-001 |
| 版本 | 1.1.0 |
| 日期 | 2026-08-07 |
| 状态 | Ready for Phase 1 |
| 输入 | [spec.md](./spec.md) |

---

## 1. 架构概览

```
订单业务动作（checkout / deliver / dispute / refund / faka worker）
         │
         ▼
  createOrderStatusEvent (已有)     ◄── 审计日志，保持不变
         │
         ▼
  NotificationDispatcher.emit(event) ◄── 新增：通知分发器
         │
         ├─ 过滤：角色 / 履约模式 / 静默规则 / Phase 1 固定默认矩阵
         ├─ 渲染：模板 → title, body, payload, deeplink
         └─ 幂等：dedupeKey
         │
         ▼
  INSERT Notification (status=unread)  ◄── 同事务或 Outbox（Phase 1 同事务）
         │
         ▼
  [Phase 2] ChannelRouter + 用户偏好
      ├─ in_app：已落库即完成；前端轮询刷新角标
      └─ email：异步 worker + 重试 + 退避
         │
         ▼
  [Phase 2] NotificationDelivery 投递日志
```

### 1.1 现有系统保持不变

| 系统 | 职责 | 保持原样 |
|------|------|----------|
| `OrderStatusEvent` | 订单状态变更审计日志 | ✓ 所有状态迁移仍写 event，通知只是额外推送 |
| `Announcement` | 运营广播（1:N） | ✓ 不修改公告系统，通知是独立的 1:1 消息 |
| 商家 Webhook | 自动开通机机协议 | ✓ 不修改 P7b webhook，通知不替代它 |
| 邮件基础设施 | `getMailer` / `renderMail` | ✓ Phase 2 复用，不重新造轮子 |
| 订单红点 | `orderAttentionCount` | ✓ 保持独立计数，与通知未读数并存 |

---

## 2. 数据模型

### 2.1 Notification 表

```prisma
model Notification {
  id                 Int       @id @default(autoincrement())
  recipientUserId    Int
  recipientRole      String    // user | merchant | admin
  eventType          String    // order.created_merchant | order.delivered_buyer ...
  category           String    // order | provision | booking | inventory | system
  title              String    // 纯文本展示标题（≤100 字）
  body               String    // 纯文本短文案（≤500 字，列表用；无 HTML/Markdown/图片）
  payload            Json?     // { orderId, productName, deliveryMode, ... } 禁止敏感内容、image/file/content
  deeplink           String    // 前端路由：/orders?focus=12 | /merchant/orders/12
  level              String    @default("info") // info | success | warning | critical
  status             String    @default("unread") // unread | read | archived
  dedupeKey          String    // 幂等键：order:{orderId}:merchant_new
  relatedOrderId     Int?      // 索引、聚合用
  relatedMerchantId  Int?      // 商家通知关联商家 ID
  readAt             DateTime?
  createdAt          DateTime  @default(now())
  expiresAt          DateTime? // 过期自动归档（cron）

  user User @relation(fields: [recipientUserId], references: [id], onDelete: Cascade)

  @@unique([recipientUserId, eventType, dedupeKey])
  @@index([recipientUserId, status, createdAt])
  @@index([relatedOrderId])
  @@index([expiresAt])
}
```

**关键设计决策：**

1. **幂等键三元组**：`(recipientUserId, eventType, dedupeKey)` 唯一约束，防止重复通知
2. **payload 不存敏感内容**：禁止卡密、交付 content、webhook secret（见 spec NTF-03）
3. **级联删除**：用户删除时通知一并删除（`onDelete: Cascade`）
4. **过期归档**：`expiresAt` 到期后 cron 改 status 为 `archived`
5. **文本边界**：通知不存富文本、图片 URL、附件或交付内容；订单详情是富内容与权限校验的唯一入口

### 2.2 NotificationPreference 表（Phase 2，非 Phase 1 migration）

Phase 1 不创建此表、不提供偏好 API 或设置页；全部用户使用 spec NTF-10
的固定 in_app 默认矩阵。只有邮件通道实际启用且出现可配置的用户需求时，
才创建此表和对应迁移。

```prisma
model NotificationPreference {
  id        Int      @id @default(autoincrement())
  userId    Int
  category  String   // order | provision | booking | inventory
  channel   String   // in_app | email
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, category, channel])
}
```

**Phase 1 默认矩阵（写死；不是 Preference 记录）：**

| category | 买家 in_app | 商家 in_app | Phase 1 外 |
|----------|-------------|-------------|------------|
| order（人工关键） | processing / delivered / refund / dispute ✓ | 新单 / 争议 / 退款 ✓ | 邮件 |
| order（即时） | delivered 弱 ✓ | ✗ | 邮件 |
| 自动开通成功 | delivered ✓ | ✗ | 商家成功提醒 |
| autoProvision 降级 | 既有订单状态照常可见 | 保持已有降级邮件，站内事件留 Phase 2 | 新 Notification 事件 |

Phase 2 邮件默认值与用户覆盖设置在该通道落地时再定义；商家地址复用
`merchant.contactEmail ?? merchant.user.email`，不新增字段。

### 2.3 NotificationDelivery 表（Phase 2，邮件通道）

```prisma
model NotificationDelivery {
  id              Int       @id @default(autoincrement())
  notificationId  Int
  channel         String    // email
  status          String    @default("pending") // pending | sent | failed | skipped
  attempts        Int       @default(0)
  lastError       String?
  providerMessageId String?
  sentAt          DateTime?
  createdAt       DateTime  @default(now())

  notification Notification @relation(fields: [notificationId], references: [id], onDelete: Cascade)

  @@index([notificationId])
  @@index([status, createdAt])
}
```

---

## 3. 核心组件

### 3.1 NotificationDispatcher（新建）

**位置：** `server/src/modules/notifications/dispatcher.ts`

**职责：**
1. 接收业务事件（`emit(event)`）
2. 应用过滤规则（履约模式、静默规则、Phase 1 固定默认矩阵）
3. 渲染通知内容（模板）
4. 生成幂等键
5. 写入 `Notification` 表

**接口：**

```typescript
type NotificationEvent = {
  type: string  // 'order.created_merchant' | 'order.delivered_buyer' ...
  recipientUserId: number
  recipientRole: 'user' | 'merchant' | 'admin'
  order: {
    id: number
    merchantId?: number
    deliveryMode: string
    productName: string
    offerId?: number
    offerName?: string
    // ...
  }
  context?: Record<string, any>  // 额外上下文
}

class NotificationDispatcher {
  // Phase 1: 同步写入，与订单事务同一个 tx
  static async emit(
    event: NotificationEvent,
    tx: Prisma.TransactionClient
  ): Promise<void>

  // Phase 2: Outbox 模式
  static async emitToOutbox(
    event: NotificationEvent,
    tx: Prisma.TransactionClient
  ): Promise<void>
}
```

**过滤逻辑（实现 spec NTF-05/NTF-06）：**

```typescript
function shouldNotifyMerchantNewOrder(input: {
  merchantId: number | null
  deliveryMode: string
  status: string
  hasProvisionTask: boolean
  hasFakaBridgeTask: boolean
}): boolean {
  // 1. 无商家 = 平台自营；Phase 1 没有平台 owner/轮值收件人
  if (input.merchantId == null) return false

  // 2. 仅人工履约存在商家待办
  if (input.deliveryMode !== 'manual_service') return false

  // 3. checkout 已创建任何自动履约任务即静默商家
  if (input.hasProvisionTask || input.hasFakaBridgeTask) return false

  // 4. 仍待商家动作
  return input.status === 'pending' || input.status === 'processing'
}
```

调用点必须在 checkout 已完成 ProvisionTask/FakaBridgeTask 创建判定之后传入
这两个布尔值；不能把不存在的 task 当作“非 cancelled 的活动任务”。
自动履约成功仅创建买家的 delivered 通知；autoProvision 降级保持现有邮件，
站内 provision 事件留到 Phase 2。

### 3.2 通知模板（新建）

**位置：** `server/src/modules/notifications/templates.ts`

**职责：** 渲染纯文本 `title`、`body`、安全 `payload`、相对 `deeplink`。
模板不得返回 HTML、Markdown、图片 URL、附件或 DeliveryRecord 内容。

```typescript
type NotificationTemplate = {
  title: string
  body: string
  payload: Record<string, any>
  deeplink: string
  level: 'info' | 'success' | 'warning' | 'critical'
  category: string
}

function renderNotification(
  eventType: string,
  context: Record<string, any>
): NotificationTemplate

// 示例：
renderNotification('order.created_merchant', {
  orderId: 123,
  productName: 'ChatGPT Plus 月卡',
  offerName: '美区',
})
// =>
{
  title: '新的待处理订单',
  body: '买家兑换了「ChatGPT Plus 月卡（美区）」，请尽快处理',
  payload: { orderId: 123, productName: 'ChatGPT Plus 月卡', offerName: '美区' },
  deeplink: '/merchant/orders/123',
  level: 'info',
  category: 'order'
}
```

**文案清单（Phase 1）：**

| eventType | title | body |
|-----------|-------|------|
| `order.created_merchant` | 新的待处理订单 | 买家兑换了「{商品名}」，请尽快处理 |
| `order.processing_buyer` | 订单处理中 | 商家正在处理「{商品名}」订单 |
| `order.delivered_buyer`（人工） | 订单已发货 | 「{商品名}」已交付，点击查看内容 |
| `order.delivered_buyer`（instant_*） | 订单已交付 | 「{商品名}」已交付，可在订单中查看 |
| `order.delivered_buyer` (Faka) | 订阅已开通 | 「{商品名}」已开通成功 |
| `order.disputed_*` | 订单进入争议 | 订单 #{订单号} 状态更新，请查看 |
| `order.refunded_*` | 订单已退款 | 订单 #{订单号} 已退款，积分已返还 |

### 3.3 挂载点（修改已有文件）

**原则：** 在状态迁移完成后、事务提交前触发通知

#### 3.3.1 Checkout 完成（商家新单 + 即时单买家弱通知）

**文件：** `server/src/modules/orders/service.ts`

**位置：** `createOrderOnce` 事务内，自动履约任务创建分支和即时
`DeliveryRecord` 写入之后、幂等 claim 完成之前。

不能在 `tx.order.create` 后立即发商家通知：此时尚未知道本单会不会在同一事务内
创建 `ProvisionTask` 或 `FakaBridgeTask`，会错误地把自动单当成人工待办。

```typescript
const merchantOwnerUserId = merchantId == null
  ? null
  : (await tx.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { userId: true },
    })).userId

// 仅人工、商家归属且没有自动任务的订单：收件人是 Merchant.userId。
if (
  config.notification.enabled &&
  merchantOwnerUserId != null &&
  shouldNotifyMerchantNewOrder({
    merchantId,
    deliveryMode,
    status: order.status,
    hasProvisionTask: autoProvisionTaskCreated,
    hasFakaBridgeTask: fakaBridgeTaskId != null,
  })
) {
  await NotificationDispatcher.emit({
    type: 'order.created_merchant',
    recipientUserId: merchantOwnerUserId,
    recipientRole: 'merchant',
    order: orderNotificationSnapshot(order),
  }, tx)
}

// instant_inventory / instant_fixed 的 status 在 create 时就是 delivered；
// DeliveryRecord 已写完，因此补一条弱的、纯文本的买家历史记录。
if (config.notification.enabled && isInstantMode(deliveryMode)) {
  await NotificationDispatcher.emit({
    type: 'order.delivered_buyer',
    recipientUserId: userId,
    recipientRole: 'user',
    order: orderNotificationSnapshot(order),
    context: { deliveryKind: 'instant' },
  }, tx)
}
```

`orderNotificationSnapshot` 是只投影订单 id、merchantId、deliveryModeSnapshot、
productNameSnapshot、offerNameSnapshot 的纯函数；不得读取交付内容。实现可直接传
两个自动任务布尔值，但不得根据缺失 task 的 status 推断。平台自营人工单因 `merchantId=null` 不发
`order.created_merchant`，也不广播给 admin。

#### 3.3.2 状态迁移到 delivered（人工 / autoProvision / Faka）

**文件：** `server/src/modules/orders/fulfillment.ts`

**位置：** `transitionOrderStatus` 函数内，`to === 'delivered'` 分支，且在
`DeliveryRecord.upsert` 后、事务提交前。该单一路径覆盖商家人工发货、
`system.auto_provision.deliver` 与 `system.faka_bridge.deliver`。

```typescript
if (to === 'delivered') {
  // 已有：upsert DeliveryRecord
  await client.deliveryRecord.upsert({ ... })

  // 新增：通知分发
  if (config.notification.enabled) {
    await NotificationDispatcher.emit({
      type: 'order.delivered_buyer',
      recipientUserId: order.userId,
      recipientRole: 'user',
      order: {
        id: order.id,
        merchantId: order.merchantId,
        deliveryMode: updated.deliveryModeSnapshot,
        productName: updated.productNameSnapshot,
        offerName: updated.offerNameSnapshot,
      },
    }, client)
  }
}
```

这一路径绝不生成自动开通成功的商家通知。为渲染安全快照，扩展
`transitionOrderStatus` 的订单 select 时只取 merchantId、deliveryModeSnapshot、
productNameSnapshot、offerNameSnapshot 等非敏感字段，不取交付内容。

#### 3.3.3 争议/退款（双方通知）

**文件：** `server/src/modules/orders/service.ts` (dispute/refund handlers)

**类似逻辑：** 状态迁移后分别通知买卖双方

---

## 4. API 设计

### 4.1 通知列表

```http
GET /api/notifications?cursor=<id>&limit=20&status=unread
Authorization: Bearer <token>

Response 200:
{
  "notifications": [
    {
      "id": 123,
      "eventType": "order.delivered_buyer",
      "category": "order",
      "title": "订单已发货",
      "body": "「ChatGPT Plus 月卡」已交付，点击查看内容",
      "level": "info",
      "status": "unread",
      "deeplink": "/orders?focus=456",
      "relatedOrderId": 456,
      "readAt": null,
      "createdAt": "2026-08-07T10:00:00Z"
    }
  ],
  "nextCursor": 122,
  "hasMore": true
}
```

**权限：** 只返回 `recipientUserId = req.user.id`

**分页：** Cursor-based（id 降序），`limit` 默认 20，最大 100

### 4.2 未读数

```http
GET /api/notifications/unread-count
Authorization: Bearer <token>

Response 200:
{
  "count": 3
}
```

**查询：** `COUNT(*) WHERE recipientUserId = ? AND status = 'unread'`

**索引：** `@@index([recipientUserId, status, createdAt])`

### 4.3 标记已读

```http
POST /api/notifications/:id/read
Authorization: Bearer <token>

Response 200:
{
  "id": 123,
  "status": "read",
  "readAt": "2026-08-07T10:05:00Z"
}
```

**逻辑：**
1. 验证 `recipientUserId = req.user.id`（否则 404）
2. `UPDATE SET status='read', readAt=NOW() WHERE id=? AND status='unread'`
3. 幂等：已读重复调用返回 200

### 4.4 全部已读

```http
POST /api/notifications/read-all
Authorization: Bearer <token>

Response 200:
{
  "updated": 5
}
```

**逻辑：** `UPDATE SET status='read', readAt=NOW() WHERE recipientUserId=? AND status='unread'`

### 4.5 删除（Phase 2）

```http
DELETE /api/notifications/:id
Authorization: Bearer <token>

Response 204
```

**逻辑：** Soft delete（`status='archived'`）或物理删除（根据产品决策）

---

## 5. 前端集成

### 5.1 铃铛入口（决定：单铃铛、同一 Dialog 双 Tab）

**位置：** `src/components/Layout.tsx` 顶栏

**复用边界：**

- 桌面继续复用 `AnnouncementBellButton`，移动继续复用现有 navbar 的 Bell trigger；
- 继续使用 `src/components/AnnouncementCenter.tsx` 的 Dialog、焦点管理、公告已读与
  `acknowledgement_required` 处理；组件可以更名，但不能在同一顶栏增加第二个铃铛；
- 不使用 Popover。现有中心是可滚动 Dialog，能容纳公告确认动作和消息列表，改变为
  Popover 会无谓改变桌面/移动端已验证的交互。

**UI：**

```
┌ 通知 ─────────────┐
│ [公告 1] [消息 3]  │  ← Tab 切换
│                    │
│ · 您有新订单 #128  │  ← 消息列表
│ · 订单已发货 #120  │
│ · 系统公告：...    │  ← 公告列表（当前实现保持）
└────────────────────┘
```

**实现：**

1. 顶栏唯一铃铛显示 `announcementUnreadCount + notificationUnreadCount`；公告与消息各自
   仍保留独立计数，不能以总数替代其状态。
2. 点击打开扩展后的中心 Dialog，Tab 标签显示各自未读数：`公告 {n}` / `消息 {n}`。
3. 若有 `acknowledgement_required` 公告，强制默认公告 Tab，保留既有自动弹出语义；
   否则 notification 未读数大于 0 时默认消息 Tab；两者均无未读时默认公告 Tab。
4. 公告 Tab 复用 `useAnnouncements` 与现有 announcements API；消息 Tab 调用新
   `GET /api/notifications`，只展示最近 5 条并提供“查看全部”到 `/notifications`。
5. 继续保留既有 announcement trigger 的 test id；为总数和消息 Tab 新增独立 test id，
   防止把公告未读与消息未读混为一个数据源。

### 5.2 消息中心页

**路由：** `/notifications`

**UI：**
- 顶部 Tab：全部 / 订单 / 系统
- 列表卡片：标题、正文、时间、已读状态
- 点击跳转到 `deeplink`（`/orders?focus=<id>`）
- 已读按钮、全部已读按钮

**实现：**

```typescript
// src/pages/NotificationsPage.tsx
function NotificationsPage() {
  const [notifications, setNotifications] = useState([])
  const [filter, setFilter] = useState<'all' | 'order' | 'system'>('all')

  useEffect(() => {
    void fetchNotifications(filter)
  }, [filter])

  async function fetchNotifications(category?: string) {
    const data = await api.get('/notifications', { params: { category } })
    setNotifications(data.notifications)
  }

  async function markAsRead(id: number) {
    await api.post(`/notifications/${id}/read`)
    void fetchNotifications(filter)
  }

  // ...
}
```

### 5.3 未读数轮询

**位置：** `src/stores/appStore.ts`

**逻辑：**

```typescript
// 已有：orderAttentionCount（订单红点）
// 新增：notificationUnreadCount（通知红点）

export const useAppStore = create<AppState>((set, get) => ({
  notificationUnreadCount: 0,

  async refreshNotificationUnread() {
    if (!authStore.getState().user) return
    try {
      const { count } = await api.get('/notifications/unread-count')
      set({ notificationUnreadCount: count })
    } catch (err) {
      console.error('Failed to fetch notification unread count', err)
    }
  },
}))

// 触发时机：
// 1. 登录后
// 2. 回到前台（visibilitychange）
// 3. 定时轮询（30-60s）
useEffect(() => {
  if (!user) return
  void refreshNotificationUnread()
  const timer = setInterval(() => void refreshNotificationUnread(), 30000)
  return () => clearInterval(timer)
}, [user?.id])
```

### 5.4 商家邮件收件人（Phase 2）

Phase 1 不发送通知邮件，也不新增 Merchant 字段。邮件通道启用后，商家收件人
统一按既有运营邮件规则解析：

```typescript
const recipient = merchant.contactEmail ?? merchant.user.email
```

这与 `lowStockNotify.ts`、`slaRemind.ts`、`bookingRemind.ts` 和 autoProvision
降级邮件一致。不得另建 `notificationEmail`，也不得在没有店铺 contactEmail 时
跳过账号邮箱回退。

---

## 6. 并发与一致性

### 6.1 幂等保证

**数据库级：** `@@unique([recipientUserId, eventType, dedupeKey])`

**应用层：** `INSERT ... ON CONFLICT DO NOTHING`（Prisma `createMany` + `skipDuplicates`）

**测试场景：**
- 订单状态迁移重试（网络超时）
- 并发事务（两个请求同时触发同一事件）

### 6.2 事务边界

**Phase 1：** 通知写入与订单事务同一个 `tx`

```typescript
await prisma.$transaction(async (tx) => {
  // 1. 状态迁移
  await tx.order.update({ ... })

  // 2. 写 OrderStatusEvent
  await createOrderStatusEvent(tx, { ... })

  // 3. 写 Notification
  await NotificationDispatcher.emit({ ... }, tx)
})
```

**优点：** 简单，失败全回滚

**缺点：** 增加事务时间（+5-10ms）；Phase 1 不在事务内发送邮件，邮件通道必须等 Phase 2 Outbox 后才启用

**Phase 2（Outbox）：** 通知写入 `NotificationOutbox` 表，异步 worker 消费

### 6.3 邮件投递（Phase 2）

**策略：** 异步 worker + 指数退避重试

```
NotificationDelivery (pending)
  ↓ attempt 1 (立即)
  ↓ attempt 2 (+1min)
  ↓ attempt 3 (+5min)
  ↓ attempt 4 (+15min)
  ↓ failed → 管理员可查死信
```

**Cron：** `server/src/modules/notifications/deliveryCron.ts`

**已有参考：** `server/src/modules/orders/provisionCron.ts`（P7b 重试逻辑）

---

## 7. 测试策略

### 7.1 单元测试

**文件：** `server/src/modules/notifications/__tests__/`

| 测试文件 | 覆盖 |
|----------|------|
| `dispatcher.test.ts` | 过滤逻辑、幂等键生成 |
| `templates.test.ts` | 各 eventType 渲染结果 |
| `service.test.ts` | API 权限、分页、已读逻辑 |

**关键用例：**
- 即时单不通知商家
- checkout 直接创建为 `delivered` 的 instant_* 单只给买家创建 1 条弱通知
- 人工单通知商家
- FakaBridge / autoProvision 成功不通知商家，仍通知买家
- 平台自营 `manual_service` 单不广播给 admin
- 重复事件不产生重复通知
- 跨用户访问返回 404
- 模板将 HTML/Markdown 按纯文本处理，payload 不含 image/file/content

### 7.2 集成测试

**文件：** `server/src/modules/notifications/__tests__/integration.test.ts`

**场景：**
- 完整下单流程 → 商家收到通知
- 即时 checkout → 买家弱通知、商家无新订单通知
- 商家发货 → 买家收到通知
- autoProvision / Faka 成功 → 买家通知、商家成功静默
- 争议 → 双方收到通知
- 退款 → 双方收到通知

### 7.3 E2E 测试

**文件：** `e2e/notifications.spec.ts`

**场景：**
- 买家下人工单 → 商家铃铛未读 +1
- 商家发货 → 买家铃铛未读 +1
- 点击通知 → 跳转到订单详情
- 标记已读 → 未读数 -1
- 公告和消息共用一个铃铛/中心 Dialog；待确认公告优先公告 Tab

---

## 8. 性能优化

### 8.1 查询优化

**索引：**
```prisma
@@index([recipientUserId, status, createdAt])  // 列表查询
@@index([relatedOrderId])                      // 按订单聚合
@@index([expiresAt])                           // Cron 归档
```

**分页：** Cursor-based（`WHERE id < cursor ORDER BY id DESC LIMIT 20`）

### 8.2 缓存策略（Phase 2+）

**未读数缓存：** Redis `notification:unread:{userId}` (TTL 30s)

**失效：** 写入/已读时 `DEL` 缓存

---

## 9. 监控与可观测性

### 9.1 Metrics

```typescript
// server/src/lib/metrics.ts
export const notificationCreatedCounter = new promClient.Counter({
  name: 'notification_created_total',
  help: 'Total notifications created',
  labelNames: ['event_type', 'recipient_role'],
})

export const notificationDeliveryCounter = new promClient.Counter({
  name: 'notification_delivery_total',
  help: 'Total notification delivery attempts',
  labelNames: ['channel', 'status'],
})

export const notificationUnreadHistogram = new promClient.Histogram({
  name: 'notification_unread_distribution',
  help: 'Distribution of unread notification counts per user',
  buckets: [0, 1, 5, 10, 20, 50, 100],
})
```

### 9.2 日志

```typescript
logger.info({
  event: 'notification.created',
  eventType: 'order.delivered_buyer',
  recipientUserId,
  orderId,
  dedupeKey,
}, 'Notification created')

logger.warn({
  event: 'notification.duplicate',
  eventType,
  dedupeKey,
}, 'Duplicate notification skipped')
```

### 9.3 告警（Phase 2）

- 邮件投递失败率 > 5%
- 未读数 P95 > 50
- Outbox lag > 5 分钟

---

## 10. 安全考虑

### 10.1 权限

- 用户只能访问 `recipientUserId = req.user.id`
- 商家只能访问商家主账号的通知（`recipientUserId = merchant.userId`）
- 管理员可访问所有通知（Phase 2+，审计用）

### 10.2 敏感内容

**禁止进入 `payload`：**
- 卡密明文（`InventoryItem.content`）
- 交付完整内容（`DeliveryRecord.content`）
- Webhook secret（`MerchantWebhookConfig.secretCiphertext`）
- 买家完整邮箱（可脱敏为 `a***@b.com`）

**允许进入 `payload`：**
- 订单号、商品名、规格名
- 订单状态、时间
- 非敏感的 publicNote

### 10.3 XSS 防护

**前端：** 使用 React 默认转义，`deeplink` 只允许相对路径

**后端：** `deeplink` 校验（禁止 `http://`、`javascript:`）

**内容：** `title`、`body` 按纯文本契约校验/渲染；不接受 HTML、Markdown、
图片 URL、附件或交付内容。富内容只在订单详情既有权限边界内展示。

---

## 11. 向后兼容

### 11.1 迁移前

- `OrderStatusEvent` 保持不变
- `Announcement` 保持不变
- 订单红点保持不变

### 11.2 迁移后

- 通知系统独立运行
- 关闭 `NOTIFICATION_ENABLED=false` 可回退
- 前端渐进增强（扩展既有单铃铛与中心 Dialog，而非新旧双入口并存）

---

## 12. Phase 2+ 扩展

### 12.1 邮件通道

- `NotificationDelivery` 表
- 异步 worker + 重试
- 用户偏好：哪些事件发邮件

### 12.2 用户偏好 UI

- `/settings/notifications`
- 按 category 或 eventType 开关
- 分通道（站内 / 邮件）

### 12.3 SSE 实时推送

- `/api/notifications/stream`
- Server-Sent Events
- 替代短轮询

### 12.4 多成员商家

- 商家子账号订阅
- 权限：店长 / 客服 / 财务

### 12.5 富文本 / 图片（未规划）

Phase 2 不预设 Markdown、HTML、图片或附件支持，也不为其修改 Notification schema。
只有出现无法由订单 deeplink 解决的明确业务用例时，才以单独规格评估内容安全、
存储、访问控制和迁移兼容性。

---

## 13. 参考资料

### 13.1 现有代码

- `server/src/modules/orders/fulfillment.ts` - 订单状态机
- `server/src/modules/announcements/` - 公告系统
- `server/src/lib/mailer/` - 邮件基础设施
- `src/utils/orderAttention.ts` - 订单红点逻辑

### 13.2 相关 Spec

- `SPEC-MAIL-TPL-001` - 邮件模板
- `SPEC-RAP-001` - 反滥用（验证邮件、限流）
- `SPEC-LEGAL-001` - 协议同意（Outbox 模式参考）

### 13.3 外部参考

- GitHub Notifications API
- Slack Notifications
- Discord Webhooks
