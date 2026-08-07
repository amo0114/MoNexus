# Spec: 订单消息通知体系

| 字段 | 值 |
|------|------|
| 文档 ID | SPEC-NOTIFY-001 |
| 版本 | 1.1.0 |
| 日期 | 2026-08-07 |
| 状态 | Ready for Phase 1 |
| 产品 | MoNexus |
| 前置规格 | 已有 `OrderStatusEvent`、`Announcement`、邮件基础设施（SPEC-MAIL-TPL-001）、商家自动开通 webhook（P7b） |
| 配套文档 | [design.md](./design.md) · [tasks.md](./tasks.md) |

---

## 1. 背景与问题陈述

### 1.1 当前状态

MoNexus 已具备以下通知能力：

| 能力 | 覆盖场景 | 入口 | 局限性 |
|------|----------|------|--------|
| `OrderStatusEvent` | 订单状态变更审计日志 | 订单详情时间线 | 无主动推送，需要用户打开订单才能看到 |
| `Announcement` | 运营广播（all/user/merchant/admin） | 顶栏铃铛 | 1:N 广播，不是 1:1 事务消息 |
| 邮件 | 验证、重置密码、低库存、预约、订阅到期、自动开通降级 | 用户邮箱 | 无站内聚合入口，关键订单事件未覆盖 |
| 商家 Webhook | 自动开通（机机协议） | 商家服务器 | 非人类通知，仅 autoProvision 场景 |
| 订单 attention 红点 | 进行中订单数（`pending`/`processing`/`disputed`） | 顶栏/订单 Tab | 仅计数，不显示"发生了什么事件" |

**代码依据：**
- `server/prisma/schema.prisma`: `OrderStatusEvent`, `Announcement`, `AnnouncementReceipt`
- `server/src/modules/orders/fulfillment.ts`: `createOrderStatusEvent`
- `server/src/modules/announcements/service.ts`: 公告系统
- `src/utils/orderAttention.ts`: 订单红点逻辑
- `src/stores/appStore.ts`: `orderAttentionCount`

### 1.2 核心问题

| 角色 | 痛点 | 当前解决方案 | 问题 |
|------|------|--------------|------|
| **商家** | 买家下了需人工处理的单，商家不知道 | 需要主动刷新订单列表 | 无主动通知，漏单风险 |
| **商家** | 即时发货单也需要关注吗？ | 订单列表全部平铺 | 噪声：即时单系统已发货，无需商家操作 |
| **买家** | 商家发货/开通完成后不知道 | 需要主动回来查看订单 | 无主动通知，体验割裂 |
| **双方** | 争议、退款进度不透明 | 只能通过订单详情时间线看到 | 需要主动轮询，无法及时响应 |

### 1.3 目标

本规格交付站内消息通知系统，作为主通知渠道，邮件作为辅助触达：

1. **事件驱动**：通知由订单真实状态变化产生，不靠轮询。
2. **履约模式分流**：人工链路强提醒，即时/自动链路默认静默商家（系统已处理完毕）。
3. **站内优先**：铃铛 + 消息中心 + 未读角标，可跳转到具体订单。
4. **邮件为辅**：重要且"人不在线"的节点可选邮件（复用现有 mailer 基础设施）。
5. **边界清晰**：不吞掉 `Announcement`（运营广播），不滥用商家 Webhook（机机协议）。
6. **可审计、幂等**：Phase 1 固定默认矩阵；用户偏好与邮件投递日志后置到 Phase 2。

### 1.4 成功标准

1. 买家下一笔 `manual_service` 人工单 → 商家 10 秒内站内未读 +1，文案含商品名与跳转。
2. 买家下一笔 `instant_inventory`/`instant_fixed` 即时单 → 商家**无**新订单通知。
3. 商家点发货 → 买家收到「已发货」通知，点击进入订单详情可见交付。
4. FakaBridge/autoProvision 开通成功 → 买家「已开通」；商家**默认无**「新订单」。
5. 同一事件重试业务逻辑**不产生**重复通知（幂等键去重）。
6. 公告与事务消息在 UI 上可区分，互不覆盖未读数。

---

## 2. 范围

### 2.1 范围内

| 域 | 本波交付 |
|---|---|
| 数据模型 | Phase 1 仅 `Notification` 表；`NotificationPreference`、`NotificationDelivery` 均为 Phase 2 候选 |
| 站内消息 | 列表 API、未读数 API、已读 API、前端消息中心页、复用现有公告铃铛与中心弹窗 |
| 事件 | 订单域核心事件（新单、发货、争议、退款）|
| 通道 | `in_app`（站内，Phase 1）、`email`（Phase 2） |
| 偏好 | Phase 1 服务端固定默认矩阵；无偏好表、API 或设置页，Phase 2 再加 |
| 幂等 | `(recipientUserId, eventType, dedupeKey)` 唯一约束 |
| 权限 | 只能访问 `recipientUserId = me` 的通知 |

### 2.2 范围外（明确不做）

| 项 | 原因 |
|---|---|
| 完整 IM 聊天 | 范围过大，本期是「事件通知」不是会话系统 |
| 短信 / App Push | 依赖外部通道，Phase 3+ |
| 用 `Announcement` 塞订单消息 | 公告是运营广播，订单是 1:1 事务消息，语义不同 |
| 用商家 Webhook 当「人类通知」 | Webhook 是机机开通协议（P7b），语义不同 |
| 营销 / 优惠推送 | 另开营销通道，避免与履约通知混权 |
| SSE / WebSocket 实时推送 | Phase 3+，Phase 1 用短轮询（30-60s） |
| 多成员商家子账号订阅 | Phase 3+ |
| 历史订单回溯通知 | v1 不做，只从部署后新事件开始 |
| 通知偏好 UI / API / `NotificationPreference` migration | Phase 1 固定默认矩阵即可；邮件通道尚未交付 |
| 独立「店铺通知邮箱」字段 | 已有 `Merchant.contactEmail` + `User.email` 可复用；Phase 1 不新增 schema |
| 平台自营 `manual_service` 新单主动通知 | Phase 1 不生成收件人，待平台人工履约责任模型明确后再决定 |
| 通知富文本、图片、附件 | 事务通知只需短文本和订单跳转；避免新增 XSS、存储与敏感交付内容边界 |

### 2.3 决策记录

| ID | 决策 | 结论 |
|----|------|------|
| D-01 | 通知 vs 公告 | 独立 `Notification` 表；公告保持原有 `Announcement` 系统 |
| D-02 | 订单红点 vs 通知未读 | 并存：红点=待处理订单实体数，通知=事件未读数 |
| D-03 | 即时单商家通知 | 默认不推（系统已自动处理），Phase 2 可设置「自动单也通知我」 |
| D-04 | 发货通知邮件 | **Phase 2** 默认人工单开、即时单关（即时单页面已弹成功） |
| D-05 | 通知过期 | `expiresAt` 30-90 天后自动归档（cron） |
| D-06 | 铃铛入口 | **单铃铛、同一中心弹窗双 Tab**（公告 \| 消息）；复用现有 `AnnouncementBellButton`、移动端铃铛和 `AnnouncementCenter`，不新增第二个图标或 Popover |
| D-07 | 即时单买家「已发货」 | 下单事务直接创建为 `delivered` 后，写一条弱 `in_app` 通知；不发邮件、不展示交付内容 |
| D-08 | Faka / autoProvision 成功的商家通知 | 成功只通知买家；商家不收「新订单」或「开通成功」。已有 autoProvision 降级邮件保持，站内降级通知留给 Phase 2 |
| D-09 | Phase 1 偏好 | 不做偏好 UI、API 或表；使用固定服务端默认矩阵 |
| D-10 | 平台自营人工单 | **Deferred**：Phase 1 不合成 admin/邮箱收件人；平台人工履约 owner/值班机制出现时再决定 |
| D-11 | 商家邮件收件地址 | 不新增字段；Phase 2 商家邮件沿用 `merchant.contactEmail ?? merchant.user.email` |
| D-12 | 站内消息格式 | Phase 1 仅纯文本 `title/body` + 相对 `deeplink`；不支持 Markdown、HTML、图片或附件 |

---

## 3. 领域规则与不变量

| ID | 规则 |
|----|------|
| NTF-01 | 通知必须由真实业务状态变化触发，禁止凭空创建或人工批量生成测试通知（除测试环境 seed） |
| NTF-02 | 幂等键 `@@unique([recipientUserId, eventType, dedupeKey])`；重试/重放不产生重复通知 |
| NTF-03 | `payload` 禁止包含敏感内容：卡密明文、交付完整 content、webhook secret、完整邮箱（可脱敏前 3 后 2） |
| NTF-04 | `deeplink` 必须是前端路由，不是外部 URL；格式：`/orders?focus=<id>` 或 `/merchant/orders/<id>` |
| NTF-05 | 商家「新订单」只在 checkout 已完成自动履约任务创建判定后发出：`merchantId != null`、`deliveryMode = manual_service`、没有本单 `ProvisionTask` / `FakaBridgeTask`、且订单仍为 `pending/processing`。平台自营单不合成 admin 收件人 |
| NTF-06 | 买家首次获得 `delivered` 结果时触发「已发货/已开通」：覆盖人工状态迁移、autoProvision/Faka 成功和 checkout 直接创建为 `delivered` 的 `instant_*`。直接即时交付只写弱 `in_app` 记录，不发邮件 |
| NTF-07 | 通知写入与业务事务同事务（或 Outbox 表同事务），邮件投递异步可重试 |
| NTF-08 | 角标刷新：Phase 1 用前端短轮询（30-60s）或登录/回前台时拉一次；Phase 2 再 SSE |
| NTF-09 | 权限：用户只能访问 `recipientUserId = req.user.id` 的通知；商家看的是商家主账号 `userId` 的收件箱 |
| NTF-10 | Phase 1 默认矩阵固定在服务端：人工待处理新单、争议、退款和买家交付事件写 `in_app`；即时单 delivered 为弱记录；自动开通成功商家静默。邮件和用户覆盖设置均不在 Phase 1 |
| NTF-11 | 顶栏只保留一个铃铛入口。它显示公告未读与事务消息未读总数，并在同一中心弹窗中以「公告 / 消息」Tab 分区；待确认公告优先打开公告 Tab，其他情况有未读消息时默认消息 Tab |
| NTF-12 | Phase 1 通知 `title`、`body` 一律按纯文本渲染；不得存/渲染 HTML、Markdown、图片 URL、附件或交付内容 |
| NTF-13 | Phase 1 不创建 `NotificationPreference`、不提供偏好 API/UI；全部用户使用 NTF-10 默认矩阵 |
| NTF-14 | Phase 2 如启用商家邮件，收件人解析固定为 `Merchant.contactEmail ?? Merchant.user.email`，不新增独立通知邮箱列 |
| NTF-15 | 平台自营 `manual_service` 新单在 Phase 1 不发主动通知；订单仍可由既有管理员全量订单列表查看。平台定义人工履约 owner/轮值或分配模型后再重审 |

---

## 4. 履约模式 × 通知矩阵

### 4.1 商家侧（Merchant owner）

| 事件 | 即时发货 `instant_*` | 人工 `manual_service` | Faka/自动开通 | 说明 |
|------|---------------------|----------------------|---------------|------|
| 新订单创建 | **默认不推** | **推：待处理新订单** | **默认不推** | 核心诉求 |
| 买家发起争议 | **推** | **推** | **推** | 与发货模式无关 |
| 管理员退款/关闭 | 推（可选） | 推 | 推 | |
| 自动开通失败/降级 | — | — | **已有降级邮件；站内 provision 事件 Phase 2** | 对齐现有 |

**判定规则（NTF-05）：**

```typescript
needsMerchantHumanAttention(input): boolean {
  if (input.merchantId == null) return false  // 平台自营没有收件人
  if (input.deliveryMode !== 'manual_service') return false  // 即时单已完成
  if (input.hasProvisionTask || input.hasFakaBridgeTask) return false  // 自动链路接管
  if (input.status in ['pending', 'processing']) return true  // 仍待商家动作
  return false
}
```

**新订单商家通知触发条件（收紧，NTF-05）：**

```
on checkout.success, after task/delivery branches have completed:
  if merchantId 为空 → skip 商家通知
  if deliveryMode !== manual_service → skip 商家「新订单」
  if ProvisionTask OR FakaBridgeTask 已创建 → skip 商家「新订单」
  else → emit 'order.created_merchant'
```

`ProvisionTask` / `FakaBridgeTask` 的存在即表示本单在 checkout 时已选择自动履约，
不以“任务字段为 undefined 时是否等于 cancelled”判断。自动履约成功仅沿买家
`order.delivered_buyer` 路径；autoProvision 降级继续使用已有的商家邮件路径。
平台自营 `manual_service` 不广播给所有 admin，也不猜测值班邮箱。

### 4.2 买家侧（Buyer）

| 事件 | 即时发货 | 人工 / 开通中 | 说明 |
|------|---------|---------------|------|
| 下单成功 | **可选弱提示** | 同左 | 避免与 SuccessModal 重复 |
| 商家接单 `processing` | 一般无此态 | **推：商家处理中** | |
| 已发货/已开通 `delivered` | **推（弱，仅 in_app）** | **推：已发货，去查看** | 即时单成功弹窗已展示，仍留一条可回看的纯文本记录；不发邮件、不含交付内容 |
| 开通失败/需补资料 | — | **推** | |
| 争议进度 | 推 | 推 | |
| 退款成功 | 推 | 推 | |
| 订阅即将到期/已过期 | 已有邮件 cron | 同左 | 归入订阅类模板 |
| 预约提醒 | 已有 bookingRemind | 同左 | 归入预约类 |

---

## 5. 事件目录（Phase 1）

统一 `eventType` 命名：`{domain}.{action}_{recipient?}`。

### 5.1 订单域（P0）

| eventType | 触发点 | 默认收件人 | 默认通道 | 默认开启 | dedupeKey 示例 |
|-----------|--------|-----------|----------|----------|---------------|
| `order.created_merchant` | checkout 中自动任务创建判定完成后（满足 NTF-05） | 商家主账号 | in_app（Phase 1） | 仅人工待处理单 | `order:{orderId}:merchant_new` |
| `order.processing_buyer` | 商家接单 pending→processing | 买家 | in_app | 开 | `order:{orderId}:processing` |
| `order.delivered_buyer` | 首次得到 delivered（人工 deliver / checkout 直接即时交付 / Faka 或 autoProvision 成功） | 买家 | in_app（Phase 1） | 开；即时单为弱记录 | `order:{orderId}:delivered` |
| `order.delivered_merchant_ack` | 人工单交付成功（可选） | 商家 | in_app（弱） | 默认关 | `order:{orderId}:merchant_ack` |
| `order.refunded_buyer` | → refunded | 买家 | in_app（Phase 1）；email（Phase 2） | 开 | `order:{orderId}:refunded` |
| `order.refunded_merchant` | → refunded | 商家 | in_app（Phase 1）；email（Phase 2） | 开 | `order:{orderId}:refunded_m` |
| `order.disputed_buyer` | → disputed | 买家 | in_app（Phase 1）；email（Phase 2） | 开 | `order:{orderId}:disputed` |
| `order.disputed_merchant` | → disputed | 商家 | in_app（Phase 1）；email（Phase 2） | 开 | `order:{orderId}:disputed_m` |
| `order.dispute_resolved_buyer` | 仲裁结果 | 买家 | in_app（Phase 1）；email（Phase 2） | 开 | `order:{orderId}:resolved` |
| `order.dispute_resolved_merchant` | 仲裁结果 | 商家 | in_app（Phase 1）；email（Phase 2） | 开 | `order:{orderId}:resolved_m` |
| `order.closed_buyer` | 自动关单/确认完成 | 买家 | in_app | 开 | `order:{orderId}:closed` |

### 5.2 开通/降级（Phase 2，对齐现有）

| eventType | 说明 |
|-----------|------|
| `provision.failed_merchant` | 自动开通失败、需人工 |
| `provision.degraded_merchant` | webhook 配置撤销导致降级（已有邮件语义） |

### 5.3 已有邮件迁入（Phase 2，统一偏好）

- `inventory.low_stock_merchant`
- `booking.remind_buyer` / `booking.remind_merchant`
- `subscription.remind_buyer` / `subscription.expired_buyer`
- `auth.*`：**不进消息中心**（安全邮件独立）

### 5.4 明确不进 Phase 1

- 营销、上新、积分活动
- 签到成功
- 评价邀请（可 Phase 3）
- 平台自营 `manual_service` 的主动新单通知（NTF-15；不阻塞商家订单通知）
- 通知偏好设置、独立店铺通知邮箱、富文本/图片/附件

---

## 6. 配置

| env | 取值 | 默认 | 说明 |
|-----|------|------|------|
| `NOTIFICATION_ENABLED` | boolean | `false` | 总开关：站内消息系统 |
| `NOTIFICATION_EMAIL_ENABLED` | boolean | `false` | 邮件通道（Phase 2，依赖 SPEC-MAIL-TPL-001） |
| `NOTIFICATION_EXPIRY_DAYS` | number | `90` | 通知自动归档天数（cron） |

**启动守卫（`server/src/config/index.ts`）：**
- `NOTIFICATION_ENABLED=false` 时：通知接口 404，写入侧静默跳过（零副作用）
- `NOTIFICATION_EMAIL_ENABLED=true` 必须 `NOTIFICATION_ENABLED=true`

---

## 7. 验收标准

| ID | 标准 | 验证方式 |
|----|------|----------|
| A-01 | 买家下 `manual_service` 人工单 → 商家 10s 内未读 +1 | E2E：创建订单 → GET `/api/notifications/unread-count` → 断言 `count >= 1` |
| A-02 | 买家下 `instant_inventory` 即时单 → 商家无通知 | E2E：创建即时单 → GET 商家通知列表 → 断言该订单不在列表 |
| A-03 | 商家点发货 → 买家「已发货」通知，点击跳转到订单详情 | E2E：`POST /api/merchant/orders/:id/deliver` → GET 买家通知 → 断言 `deeplink=/orders?focus={id}` |
| A-04 | FakaBridge 成功 → 买家「已开通」，商家无「新订单」 | 集成测试：FakaBridge task succeed → 断言买家通知存在、商家通知不存在 |
| A-05 | 同一订单状态迁移重试不产生重复通知 | 单元测试：重复调用 `NotificationDispatcher.emit` → 断言数据库只有 1 条记录 |
| A-06 | 公告未读 与 通知未读 独立计数 | E2E：创建公告+订单 → 断言两个未读数独立 |
| A-07 | 用户只能访问自己的通知 | API 测试：用户 A 尝试读取用户 B 的通知 → 404 |
| A-08 | 通知 `payload` 不包含敏感内容 | 单元测试：mock 卡密订单 → 断言 payload 不含 `content` 字段 |
| A-09 | 已读通知不再计入未读数 | API 测试：POST `/api/notifications/:id/read` → GET `/api/notifications/unread-count` → 断言 count 减 1 |
| A-10 | Phase 1 所有事件触发点覆盖 | 集成测试矩阵：每个 eventType 至少一个测试用例 |
| A-11 | 即时单 checkout 直接得到 delivered → 买家有 1 条弱通知、商家没有新订单通知 | 集成测试：断言买家 `order.delivered_buyer`、无邮件投递、商家列表不含该单 |
| A-12 | 公告与事务消息复用一个铃铛和中心弹窗 | 前端测试：仅一个桌面/移动铃铛触发器；Tab 未读数与总角标正确，待确认公告优先公告 Tab |
| A-13 | Phase 1 通知只渲染纯文本 | 单元/UI 测试：title/body 中的 HTML/Markdown 字符按文本显示，payload 无 image/file/content |
| A-14 | 平台自营人工单不向所有 admin 或未配置邮箱广播 | 集成测试：`merchantId=null` 的 `manual_service` 单不创建 `order.created_merchant` |

---

## 8. 前置条件与依赖

| ID | 依赖 |
|----|------|
| DEP-01 | 邮件基础设施（`getMailer`、`renderMail`）已就绪（SPEC-MAIL-TPL-001 已合入） |
| DEP-02 | `OrderStatusEvent` 已稳定（`server/src/modules/orders/fulfillment.ts`） |
| DEP-03 | `Announcement` 系统不受影响（`server/src/modules/announcements`） |
| DEP-04 | 订单状态机明确（`transitionOrderStatus`、`createOrderStatusEvent`） |
| DEP-05 | 履约模式判定明确（`isInstantMode`、`getProductFulfillmentMode`） |

---

## 9. 非功能需求

### 9.1 性能

- 未读数查询 < 100ms（单索引 `recipientUserId + status`）
- 通知列表分页（cursor-based，`limit=20`）
- 写入与订单事务同事务，不增加超过 10ms 开销

### 9.2 可靠性

- 幂等键唯一约束防止重复（数据库级）
- 邮件投递失败可重试（Phase 2，`NotificationDelivery` 表）
- 事务回滚不会留下孤儿通知

### 9.3 可观测性

- 每种 `eventType` 的通知创建计数（Prometheus metrics）
- 邮件投递成功/失败计数（Phase 2）
- 未读数分布 histogram

### 9.4 安全

- 用户只能访问自己的通知（`recipientUserId` 鉴权）
- `payload` 禁止敏感内容（NTF-03）
- `deeplink` 只允许前端路由，不允许外部 URL

---

## 10. 迁移与回滚

### 10.1 迁移策略

- Phase 1 Prisma migration 只新增 `Notification` 表及 `User.notifications` 关系；不创建 `NotificationPreference` 或 `NotificationDelivery`
- 不迁移历史 `OrderStatusEvent` 为通知（v1 只处理新事件）
- 前端渐进增强：扩展现有公告铃铛与中心弹窗为双 Tab，不新增第二个入口

### 10.2 回滚

- 数据库表保留（不删除 migration）
- 关闭 `NOTIFICATION_ENABLED=false`：接口 404，写入侧跳过
- 前端回滚：隐藏通知入口，恢复纯公告铃铛

---

## 11. Decision Review（2026-08-07）

本轮没有需要人工阻塞 Phase 1 的问题。第 5 项被明确延后，Phase 1 默认行为已写入 NTF-15。

| # | Evidence | Decision | Recommendation | Rationale | Impact |
|---|----------|----------|----------------|-----------|--------|
| 1 | src/components/Layout.tsx 已分别在桌面/移动端渲染同一个公告铃铛语义；src/components/AnnouncementCenter.tsx 已提供带未读数的中心 Dialog；src/hooks/useAnnouncements.ts 已维护公告未读 | **DECIDED** | 一个铃铛、一个中心 Dialog，Tab 为「公告 / 消息」 | 保持现有入口、移动布局、公告已读/确认流程和测试契约；不引入第二个密集图标或新 Popover | requirements: NTF-11；design: §5；task: T06 前端复用现有组件 |
| 2 | server/src/modules/orders/service.ts 在 instant_* checkout 时直接创建 delivered 和 DeliveryRecord；server/src/__tests__/orders.test.ts、orders-instant-fixed.test.ts 覆盖该行为；src/pages/ProductDetailPage.tsx + src/components/SuccessModal.tsx 已即时展示交付 | **DECIDED** | 买家保留一条弱 order.delivered_buyer 站内记录；不发邮件 | 成功弹窗解决当下反馈，通知历史解决回看；纯文本深链不重复暴露交付内容 | requirements: NTF-06；design: checkout 挂载点；task: T02/T04/T07 直达 delivered 测试 |
| 3 | server/src/modules/orders/provisionCron.ts 成功时以 system 交付，降级时才经 merchantNotifiedAt 发邮件；server/src/lib/fakaBridge/worker.ts 也由 system 推进至 delivered；p7b-auto-provision.test.ts 验证降级邮件 | **DECIDED** | Faka/autoProvision 成功只通知买家，商家成功静默；保留既有降级邮件 | 自动路径没有商家待办，成功提醒只增加噪声；降级才是人工介入信号 | requirements: D-08；design: dispatcher filter；task: T02/T04/T07 |
| 4 | 当前无通知偏好模型、路由或设置页；现有邮件行为由服务端 cron/default 规则决定 | **DECIDED** | Phase 1 不建偏好表、不做 UI/API，固定默认矩阵 | 仅有 in_app 通道时开关没有足够收益；避免提前锁定偏好数据模型 | requirements: NTF-13；design: §2.2/§12.2；task: T01/T06 排除该范围 |
| 5 | Order.merchantId 可空表示平台自营；server/src/modules/admin/README.md 只有全量查看/仲裁，无订单 owner、值班或人工交付分配模型；lowStockNotify.ts、slaRemind.ts 同样排除 merchantId=null，注明无收件人 | **DEFERRED** | Phase 1 不创建平台自营人工单通知，也不广播给所有 admin；继续由既有 /api/admin/orders 可见 | 收件人选择属于平台运营责任，当前没有可推导 owner；不改变现有行为且无需新 schema，后续可直接向 recipientUserId 增加已定义 owner | requirements: NTF-15；design: §3.1；task: T04/T07 明确排除并回归 |
| 6 | Merchant.contactEmail 与 User.email 已存在；server/src/lib/lowStockNotify.ts、slaRemind.ts、bookingRemind.ts 都使用 contactEmail ?? user.email，并有相应测试 | **DECIDED** | 不新增字段；Phase 2 商家邮件沿用 contactEmail ?? user.email | 已有、经过测试的运营邮件收件人优先级更一致，且零 migration | requirements: NTF-14；design: §5.4；task: Phase 1 无 schema/API 变更 |
| 7 | AnnouncementCenter.tsx 将公告内容作为文本渲染；OrderStatusEvent/交付内容有明确敏感数据边界；Notification 只需短文案与 deeplink | **DECIDED** | Phase 1 纯文本 title/body + deeplink；无 Markdown、HTML、图片或附件 | 订单详情已承载富内容和权限检查；通知保持安全、轻量且可逆 | requirements: NTF-12；design: §2.1/§10.3；task: T02/T06/T07 纯文本测试 |

**Deferred 重新决策条件：** 平台首次上架需要人工履约的自营商品，且已定义订单 owner、值班轮值或可审计的分配机制时；届时在「创建订单的运营人员 / 已分配 owner / 所有 order-management admin」中选择收件人，并补充相应权限与审计设计。
