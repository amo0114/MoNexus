# MoNexus 运维手册（Runbook）

> 更新于 2026-07-27（P6a/b/c 实施后）。面向部署与值班：后台任务、配置旋钮、邮件通道、备份与常见排障。

## 1. 后台定时任务（cron）

全部注册于 `server/src/main.ts`，同构范式：`setInterval` + 重入守卫 + `start/stop` 对 + `unref` + **test 环境跳过** + **CronLease 舰队租约**（P7a）。进程即调度器，多实例部署安全：每个 job 每 tick 先领 `CronLease` 租约（单条原子 upsert，时间判定全部用 DB `now()`，不信任实例时钟），领到才执行；运行期**心跳续租**（每 TTL/4）维持互斥，批次结束不释放——同名 job 舰队级至多每 TTL 窗口启动一次。实例崩溃后租约 ≤ TTL 自然过期，最大空窗 < 2×周期；租约丢失只告警不中断（下表「去重/状态」列保证重跑安全）。观测：`SELECT * FROM "CronLease"`（holder = hostname:pid）。

| 任务 | 模块 | 周期 | 行为 | 去重/状态 |
|---|---|---|---|---|
| 订单自动关闭 | `modules/orders/cron.ts` | 24h | 交付超 `autoCloseDays` 未确认 → closed + 结算 + confirmedAt | 状态机 CAS |
| 交付文件清理 | `lib/fileCleanup.ts` | 1h | 孤儿 24h / tmp 遗留 / 退款 90d / 无行对象（advisory lock 二次确认） | 行标记 + 引用计数 |
| 低库存告警 | `lib/lowStockNotify.ts` | 1h | SKU 级低于 `lowStockThreshold` → 商家邮件 | `LowStockNotice`（成功才写 lastNotifiedAt；失败下轮重试） |
| 订阅到期提醒 | `lib/subscriptionRemind.ts` | 1h | 到期前 `subscriptionRemindDays` 天 + 到期时各一封（买家） | `SubscriptionReminder`（pre→expired 终态；过期 >7d 只落状态不发信） |
| SLA 超时提醒 | `lib/slaRemind.ts` | 1h | 人工单超 `fulfillmentDeadline` → 商家邮件 | `SlaReminder`（每单一封） |
| 预约日提醒 | `lib/bookingRemind.ts` | 1h | 预约日前 24h → 买卖双方各一封 | `BookingReminder`（双封全成才落行；重试可能对成功侧重复） |

**共同语义**：邮件发送失败一律 `logger.warn` 并保持状态可重试；单条失败不中断整批。

**多实例已知限界**（P7a 留档）：`express-rate-limit`（API 层限流）为进程内存计数，多实例下每实例独立限额——总上限 = N×配置值，有界不阻断；切 Redis 存储沿 2026-06-13 Redis 计划既定边界另议。业务级限流（进度更新、文件发放）已是 DB 计数 + 锁串行，跨实例精确。

## 2. SystemConfig 旋钮（管理端「系统配置」）

全部为非负整数；改动即时生效（cron 每轮/事务内读取），每次修改写 AdminLog。

| 组 | 键 | 默认 | 范围/说明 |
|---|---|---|---|
| 奖励发放 | registerReward / checkinReward / inviteReward | — | 积分 |
| 安全 | refreshTokenMaxAgeDays | — | 新签发生效 |
| 安全 | checkoutVerifyAmountThreshold / checkoutVerifyDailyThreshold | 0 | 0=关闭；触发结算密码确认 |
| 分页限制 | defaultPageSize / maxPageSize | — | |
| 库存 | lowStockThreshold | 5 | SKU 级判定 |
| 库存 | lowStockNotifyCooldownHours | 24 | 0–720；0=进入低位只发一次 |
| 会员等级 | memberTier*Threshold / *BonusBps | — | 银<金<铂金交叉校验 |
| 文件交付 | fileUrlTtlSeconds | 300 | 30–3600；签出不可撤销 |
| 文件交付 | fileAccessWindowDays | 30 | 0=不限窗口 |
| 文件交付 | deliveryFileMaxMb | 100 | 1–100，与 Nginx 上传路由 100m 锁定一致 |
| 订单 | autoCloseDays | 7 | 1–90 |
| 订单 | fulfillmentSlaDays | 7 | 1–90；仅影响新订单 |
| 订单 | subscriptionRemindDays | 3 | 0–30；0=关闭到期前提醒 |

## 3. 邮件通道

- 工厂：`server/src/lib/mailer/`。`SMTP_HOST` 未配置 → console 兜底（开发/测试）；生产配置 `SMTP_HOST/SMTP_USER/SMTP_FROM` 等（`SMTP_FROM ?? SMTP_USER` 生产必填，config 层校验）。
- 业务发信方：auth（改密/验证）、低库存（商家）、订阅到期（买家）、SLA 超时（商家）、预约提醒（双方）。商家收件人一律 `merchant.contactEmail ?? user.email`。

## 4. 对象存储与备份

- 双桶：`STORAGE_BUCKET`（公开图片，anonymous download）与 `DELIVERY_STORAGE_BUCKET`（私有交付，绝不 anonymous；同名拒启）。生产必配 `DELIVERY_STORAGE_PUBLIC_ENDPOINT`（https 强制，config 层拒启）。
- Nginx：`/${DELIVERY_STORAGE_BUCKET}/` 原样透传且 `proxy_set_header Host $http_host`（`$host` 去端口会毁 SigV4）；上传路由单独放宽 100m。
- 备份：`scripts/backup.sh` 双桶快照（/backup/uploads + /backup/delivery）；恢复演练 `scripts/restore-objects-check.sh`；可移植备份 v2 含私有桶（旧版服务器遇 v2 响亮失败）。运营状态表（LowStockNotice/SubscriptionReminder/SlaReminder/BookingReminder）随 pg_dump 自然覆盖，丢失仅导致重复提醒，不致数据损坏。

## 5. 部署预检与 CI

- `scripts/check-prod-env.sh`：compose 启动前变量/格式/同名桶/https 预检；config 层为最终守门（绕过 compose 直接启动同样被挡）。
- 分支/CI 规范见 `docs/branching-and-ci.md`（master 生产 / develop 集成；`CI OK` 为唯一 required check；**提交信息禁写 skip-ci 方括号标记**——required check 将永远 Pending）。

## 6. 常见排障

| 症状 | 先查 |
|---|---|
| 签名下载 403 SignatureDoesNotMatch | Nginx 是否 `$http_host` 透传；`DELIVERY_STORAGE_PUBLIC_ENDPOINT` 与浏览器访问域是否逐字节一致 |
| 商家收不到告警邮件 | SMTP 配置（console 兜底会打日志）；`merchant.contactEmail`；对应状态表的 lastNotifiedAt/sentAt |
| 订阅未到期但买家 403 下载 | 订阅交付（expiresAt 非空）**豁免**平台 `fileAccessWindowDays` 窗口、只受自身有效期约束（FILE_SUBSCRIPTION_EXPIRED）；非订阅交付才受窗口约束（FILE_WINDOW_EXPIRED）——先看订单是否真有 expiresAt |
| 提醒重复发送 | 预约提醒双封语义（部分失败整体重试）；其余通道检查状态表是否被误删 |
| cron 未按周期执行 | `SELECT * FROM "CronLease"`——多实例下同窗口已有他实例执行（holder 列）属正常；lockedUntil 卡在未来而 holder 已死 = 等待自然过期（≤ 周期），不需手工清 |
| 全量 e2e 本机随机白屏 | WSL2 swap 压力（见 `.claude` 记忆）；`--workers=1 --retries=2` |
