# MoNexus 运维手册（Runbook）

> 更新于 2026-07-28(P7b 自动开通实施后)。面向部署与值班：后台任务、配置旋钮、邮件通道、备份与常见排障。

## 1. 后台定时任务（cron）

全部注册于 `server/src/main.ts`，同构范式：`setInterval` + 重入守卫 + `start/stop` 对 + `unref` + **test 环境跳过** + **CronLease 舰队租约**（P7a）。进程即调度器，多实例部署安全：每个 job 每 tick 先领 `CronLease` 租约（单条原子 upsert，时间判定全部用 DB `now()`），领到才执行。租约含两个解耦机制：**运行互斥**（`lockedUntil`，固定 90s TTL + 30s 心跳，批次结束即释放，崩溃后 ≤ 90s 自然过期）与**窗口节流**（`lastStartedAt`，距上次启动不足「周期 − 5–60s margin」的领取被拒；窗口严格短于调度周期，短批次按配置周期正常运行）。租约丢失只告警不中断（下表「去重/状态」列保证重跑安全）；同名 job 崩溃后最大空窗 < 2×周期。观测：`SELECT * FROM "CronLease"`（holder = hostname:pid）。

| 任务 | 模块 | 周期 | 行为 | 去重/状态 |
|---|---|---|---|---|
| 订单自动关闭 | `modules/orders/cron.ts` | 24h | 交付超 `autoCloseDays` 未确认 → closed + 结算 + confirmedAt | 状态机 CAS |
| 交付文件清理 | `lib/fileCleanup.ts` | 1h | 孤儿 24h / tmp 遗留 / 退款 90d / 无行对象（advisory lock 二次确认） | 行标记 + 引用计数 |
| 低库存告警 | `lib/lowStockNotify.ts` | 1h | SKU 级低于 `lowStockThreshold` → 商家邮件 | `LowStockNotice`（成功才写 lastNotifiedAt；失败下轮重试） |
| 订阅到期提醒 | `lib/subscriptionRemind.ts` | 1h | 到期前 `subscriptionRemindDays` 天 + 到期时各一封（买家） | `SubscriptionReminder`（pre→expired 终态；过期 >7d 只落状态不发信） |
| SLA 超时提醒 | `lib/slaRemind.ts` | 1h | 人工单超 `fulfillmentDeadline` → 商家邮件 | `SlaReminder`（每单一封） |
| 预约日提醒 | `lib/bookingRemind.ts` | 1h | 预约日前 24h → 买卖双方各一封 | `BookingReminder`（双封全成才落行；重试可能对成功侧重复） |

**共同语义**：邮件发送失败一律 `logger.warn` 并保持状态可重试；单条失败不中断整批。

**多实例已知限界**（P7a 留档）：`express-rate-limit`（API 层限流）为进程内存计数，多实例下每实例独立限额——总上限 = N×配置值,有界不阻断;切 Redis 存储沿 2026-06-13 Redis 计划既定边界另议。业务级限流（进度更新、文件发放）已是 DB 计数 + 锁串行,跨实例精确。

### 1.1 自动开通外呼 worker(P7b,`modules/orders/provisionCron.ts`)

与上表六个「扫全表」cron **不同范式**:这是一条 **工作队列 worker**,故意 **不接 CronLease**——工作认领由 `FOR UPDATE SKIP LOCKED` 天然分片,多实例并行安全且线性加速。60s 一轮;每轮认领 ≤ 20 条,外呼并发 ≤ 4。

- **认领谓词**:`status='pending'` + `nextAttemptAt` 到期 + `leaseUntil` 未持有(在途 HTTP 的任务被租约排除,绝不二次外呼)。
- **退避档**:第 n 次失败后下次尝试 = `[1m, 5m, 15m, 1h, 6h][min(n-1,4)]` 之后。`nextAttemptAt` 在认领时 **预写**,进程崩溃自然落入下轮,无紧循环。
- **租约**:`leaseUntil = 外呼超时 + 20s`;到期未落结果即可被重新认领。结果落库用 `id + leaseToken + status='pending'` 三条件 CAS——过期 worker 的迟到结果被丢弃。HTTP 调用 **全程在事务外**,且受 **硬性总时限 10s** 约束(墙钟定时器,慢滴响应也会被切断——socket `timeout` 只是空闲超时)。2xx 后结果落库若遇**瞬时故障**(连接/死锁),任务保留 pending 自动重呼(`result_write_failed`,接收端按 taskId 幂等);只有业务性竞争(订单已被手工交付/退款)才置 `cancelled`。降级邮件按 `FOR UPDATE SKIP LOCKED` 认领,多实例不重复发送。
- **首次认领** 由 system 把订单 `pending → processing`(事件 `system.auto_provision.start`);商家已手动接单则跳过。
- **降级转人工**:配置被撤销(`config_revoked`)、次数耗尽、或订单已被手工交付/退款 → 任务置 `degraded`/`cancelled`,发商家邮件(收件人 `merchant.contactEmail ?? user.email`,`merchantNotifiedAt` 单列管重试)。**买家的自动开通表单答案会外发到商家配置的回调服务**(产品页/结算页已明示)。
- **SSRF 防线**:仅 https、禁用户名密码、禁重定向;保存配置时即解析域名并拒绝私网/保留目标;连接期按解析出的公网 IP 钉扎,但 TLS SNI 用 **原始域名**(挡 DNS rebinding)。私网/保留 IP 一律拒绝。
- **生命周期线性化**(复审 P1):active 配置行的行锁是唯一线性化点——下单冻结/规格开关启用/**外呼前 gate** 拿 `FOR SHARE`,轮换/撤销拿 `FOR UPDATE`。撤销先提交 → 下单 409、开关启用 422、已认领任务在 gate 处降级且 **绝不外呼**(买家表单答案不外发);gate 先通过 → 本次外呼不可逆,其后的撤销只影响交付结果(结果 CAS 丢弃)。回归:`p7b-lifecycle-races.test.ts`。
- **时区约定**(P6 时区约定的 raw-SQL 变体):Prisma 模型层写入的 `nextAttemptAt`/`leaseUntil` 是 **UTC 裸值**存入无时区列,认领 SQL 必须用 `列 AT TIME ZONE 'UTC'` 再与绑定的 `${now}` 比较,否则会话时区(+08)会把未来时刻偏移 ~8h 到过去、击穿退避与租约。改这段 SQL 时务必保留 `AT TIME ZONE 'UTC'`。

**观测**:`SELECT status, count(*) FROM "ProvisionTask" GROUP BY status`;卡住的降级任务 `SELECT id, "orderId", attempts, "lastError", "lastHttpStatus", "merchantNotifiedAt" FROM "ProvisionTask" WHERE status='degraded'`。`lastError` 只存脱敏诊断码(见 §6),绝不含远端响应体。

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
| 订单 | autoProvisionMaxAttempts | 5 | 0–5;自动开通外呼最大尝试次数。**0 = 运维刹车**:整轮不认领、不外呼、不转状态(既有降级任务仍继续发通知邮件)。改小不影响在途,新一轮生效 |

## 3. 邮件通道

- 工厂：`server/src/lib/mailer/`。`SMTP_HOST` 未配置 → console 兜底（开发/测试）；生产配置 `SMTP_HOST/SMTP_USER/SMTP_FROM` 等（`SMTP_FROM ?? SMTP_USER` 生产必填，config 层校验）。
- 业务发信方：auth（改密/验证）、低库存（商家）、订阅到期（买家）、SLA 超时（商家）、预约提醒（双方）、自动开通降级(商家,P7b)。商家收件人一律 `merchant.contactEmail ?? user.email`。

## 4. 对象存储与备份

- 双桶：`STORAGE_BUCKET`（公开图片，anonymous download）与 `DELIVERY_STORAGE_BUCKET`（私有交付，绝不 anonymous；同名拒启）。生产必配 `DELIVERY_STORAGE_PUBLIC_ENDPOINT`（https 强制，config 层拒启）。
- **P7b webhook 密钥**:`WEBHOOK_SECRET_ENC_KEY`(64 位十六进制 = 32 字节,`openssl rand -hex 32`)加密商家 webhook 密钥(AES-256-GCM);**生产必配**,缺失则 config 层拒启、`scripts/check-prod-env.sh` 预检失败。轮换此 key 会使所有已存密文无法解密——需重置商家 webhook 配置。`AUTO_PROVISION_ALLOW_INSECURE_TARGETS` 是仅开发用的逃生阀(放开 https/IP 钉扎的 SSRF 防线),**生产置 true 直接拒启**。
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
| 自动开通任务不外呼 | `autoProvisionMaxAttempts` 是否为 0(运维刹车);商家 webhook 配置是否 `active`(撤销/轮换后旧任务会 `degraded` 转人工,`lastError='config_revoked'`);`SELECT * FROM "ProvisionTask" WHERE status='pending'` 看 `nextAttemptAt` 是否在未来(退避中) |
| 自动开通大面积降级 | `lastError` 诊断码:`dns_blocked`(域名解析到私网/被 SSRF 拦)、`tls_error`、`connect_error`、`http_5xx`/`http_4xx`(商家服务返回非 2xx)、`bad_body`(2xx 但响应非 `{content:非空≤5000}`)、`config_revoked`、`result_write_failed`(外呼成功但结果落库瞬时失败——**不是终态**,保留 pending 自动重呼,接收端按 taskId 幂等;反复出现查 DB 健康)。**只存脱敏码,排障需商家侧查其回调服务日志**;`lastHttpStatus` 记录末次 HTTP 码 |
| 商家收不到降级邮件 | `merchantNotifiedAt` 为空且反复扫描 = 发信持续失败(见 SMTP 排障行);发送成功才落时间戳,失败下轮重发 |
| cron 未按周期执行 | `SELECT * FROM "CronLease"`——多实例下同窗口已有他实例执行（holder 列 + lastStartedAt）属正常；互斥 `lockedUntil` 卡在未来而 holder 已死 = 心跳残留，≤ 90s 自然过期，不需手工清 |
| 全量 e2e 本机随机白屏 | WSL2 swap 压力（见 `.claude` 记忆）；`--workers=1 --retries=2` |
