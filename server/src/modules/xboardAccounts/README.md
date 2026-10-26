# Xboard 账号关联与只读查询（B1）

本模块恢复历史购买的稳定账号身份，供签名 QQ 通道查询；权益由独立 [trafficReset 模块](../trafficReset/README.md) 管理，B2 已接入回填/交付。

- `evidence.ts`：来源必须为成功且有 trade/完成时间的 Faka task，订单和有效交付属于同一正常用户；历史 refunded/disputed 可以证明关联，不能据此推断赠送资格。注册邮箱无需等于开通邮箱，使用下单时已存在且有效的邮箱证明；下单后才验证的地址不能反向授权旧账号。
- `recovery.ts`：用历史外部单号向插件解析稳定 ID，核对原 trade。实例固定 origin，用户行锁和远端账号 advisory lock 串行化认领；同远端账号的跨用户冲突阻止已有链接并保留双方证据，绝不自动转移所有权。证据来源订单全局唯一，不能切换实例重用旧订单。
- `queries.ts`：每次通过现存 ChatBinding ID + QQ sender + 正常用户校验；返回前再次检查。别人的 link 返回 404。单个有效账号自动选中，多个账号必须显式选择；偏好与选择记录使用归属复合外键。选择 requestId 幂等，旧重试不覆盖后来的选择，换绑后不能复用旧选择请求。
- `bridgeQueries.ts`：能力/快照 15 秒进程缓存，按实例、URL、密钥、稳定 ID 隔离，在途合并。瞬时故障可用最多 60 秒旧快照并标记 stale/unavailable；没有快照返回 null。明确撤销能力清理旧快照并拒绝，不把权限故障当普通离线。缓存不能代替业务授权。
- `backfill.ts`：默认只预览，单批 1–100 行（默认 50），按买家 ID/任务 ID 稳定排序。应用模式共用 cron lease，逐行 CAS checkpoint；远端故障不跨过失败行。空页重置游标并增加 cycle，再次扫描迟成功/新任务。预览只在本批内投影潜在归属冲突，不能代替完整应用结果或跨批异常清单。
- `cron.ts`：仅查询开关启用后启动，每分钟至多一批 50 行；启动即尝试一批，关闭停止新批次，退出等待在途批次。新购买关联为最终一致；等待时间取决于历史量与远端可用性。此扫描的 apply 在稳定关联完成后调用 B2 发放 helper；直接及对账成功交付另有原事务内钩子。

## 运维入口

先应用增量 migration，再配置已有 FAKA_BRIDGE_URL/SECRET、稳定 XBOARD_INSTANCE_ID、BOT_SHARED_SECRET、Redis。查询默认关闭；CLI 可在查询未开放时先回填。实例 ID 首次应用后不得改指另一个 origin。

```bash
# 以下命令从仓库根运行，环境变量应指向操作者明确选择的环境。
# 默认仅读取本地来源和远端只读协议；输出不含邮箱、QQ 或远端响应原文。
npm --prefix server run xboard-accounts:backfill -- --limit 50
npm --prefix server run xboard-accounts:backfill -- --limit 50 --after-user-id 10 --after-task-id 100
# 应用仅从数据库 checkpoint 续跑，不接受手动游标覆盖。
npm --prefix server run xboard-accounts:backfill -- --apply --limit 50
```

输出 scanned、counts、anomalies（本地 taskId 与有限原因）、previewNext 和 checkpoint。previewNext 是最后安全完成行的游标；空页 null 表示本轮已到末尾。apply=false 不保存关联/游标，也不计入赠送；apply=true 且赠送开关开启时，linked/existing 会 upsert 一次权益；读取远端仍会消耗插件防重放 nonce。应用运行可能因 lease 返回 skipped=true。

有限结果分类：linked（可恢复/已写来源）、existing、conflict、source_incomplete（失败/待处理/取消/缺完成证据）、delivery_untrusted、user_unavailable、ownership_proof_missing、untrusted_source（远端等待后来源变化）、remote_unresolved（含缺远端账号/订单、trade 不匹配）、remote_unavailable。汇总按来源行计数，不是独立用户/邮箱数；异常清单仅给任务引用和原因，人工核验需使用受控数据库审计。冲突不会自动解除。

## QQ 接口与边界

`POST /api/bot/v2/xboard/accounts`、`profile`、`select-default` 位于 JSON 全局 parser 之前，保持支付 raw webhook 在前。原始 body <=8KiB、禁止压缩、严格 DTO、原始字节签名、Redis nonce SET NX PX601000；防护存储不可用拒绝。共享机器人主机 600/分钟、每个绑定用户 10/分钟；无 JWT，不接受 userId/邮箱/URL。响应 private,no-store。

DTO/签名见仓库 OpenAPI 和 [协议说明](../../../../docs/specs/2026-10-25-performance-and-qq-xboard/protocol-v2.md)。B2 `freeReset` 返回已发放余额（无 grant 为 null），`canFreeReset` 需新鲜写预检与请求开关；`freeSuccessfulForAccount`/`paidSuccessfulForAccount` 分列免费/付费 v2 已核实执行，`platformSuccessfulForAccount` 为两者之和，coverageScope=verified_v2_only；`xboardAllSources` 是原生 reset_count，不能作为免费次数。未知流量/次数不伪造零。独立 AstrBot 0.2.0 已本地实现真实 sender 取值、群聊拦截及私聊渲染，仍需实际 AstrBot/NapCat 验收。

定向测试：`xboard-account-recovery.test.ts`、`xboard-bot-v2.test.ts`、`config-xboard-guards.test.ts`，使用真实可丢弃 PostgreSQL，桥接 transport/Redis 为可控测试替身；不证明生产数据可恢复率、真实 Redis 故障转移或真实 QQ 会话已经验收。


## QQ 付费入口与次数（B3b4）

`purchase.ts` 的 POST `/api/bot/v2/xboard/purchase-reset` 接受本人可选账号 UUID；需查询开关和 `XBOARD_PAID_RESET_TARGET_V2_ENABLED`。只读当前稳定 ID 新鲜套餐，匹配 active 且有本地库存的当前 plan reset_traffic/reset_price，过滤商品生命周期/商家状态，再通过商业预检；绑定、目标和商品在远端等待后重验。返回 typed 商品/规格/账号引用和积分参考价，找不到/资格不符返回有限原因及 null，不扣款。member 可见性与站内已登录用户相同，可信适配器只在私聊调用；不输出商品描述、远端身份或任意链接。

`resetHistory.ts` 只按实例/origin/稳定远端账号和买家读取 v2 task；每次复验冻结身份/hash及完整执行快照，按外部单号去重，completed 或已执行 revoked 均保留次数，不用邮箱推断旧 v1。最多最近1000条，超过标 truncated=true，显示已核实下限。旧 v1/站外不覆盖。查询不受新付费结账开关关闭影响，原生全来源次数单列；coverageFrom 不是完整统计起点。profile 在异步工作后检查 UUID 仍对应原稳定目标，避免改向后泄露旧快照。

新增定向测试 `xboard-paid-bot.test.ts`；使用本机可丢弃 PostgreSQL 和受控远端 transport。无新增 schema/migration，无实际消息发送。
