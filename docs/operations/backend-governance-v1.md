# 后端治理 v1 发布与处置手册

本手册覆盖 B1–B7。发布需要维护窗口；不支持旧后端与英文用户状态混跑。本文是操作步骤，不代表已部署生产或已配置外部告警接收器。接口见 [协作契约](../api/governance-v1/README.md)，本地证据见 [验证记录](../verification/backend-governance-v1/README.md)。

## 发布前准备

记录旧镜像、新镜像、数据库备份恢复点、全部 API/worker/独立脚本实例、支付回调暂停窗口。备份包含数据库及存储配置密钥的受控恢复方式；不要把密钥放进报告。准备能识别英文状态、结构化封禁和新授权的兼容回退产物。

先在隔离恢复库演练完整流程。确认 PostgreSQL 支持 pgcrypto，迁移账号可建扩展、触发器、并发索引和约束。所有数据库会话使用直接连接执行 DDL；设置 DIRECT_URL 时以它为准。不要经事务池运行并发索引。

导出需要可恢复的私有 S3 兼容存储。生产内存适配器会被拒绝。检查旧提供商凭据仍可解密、私有桶禁止匿名读取、签名地址外部可达。数据库升级成功不等于存储已验证。

## 维护窗口中的执行顺序

1. 阻止新业务写入，停止全部旧 API、worker、cron 和独立写脚本。记录窗口起止时刻、支付渠道及待查询订单范围。
2. 使用新镜像执行扩展迁移及并发索引。普通容器启动命令在 verify 通过前不会启动 API，因此用一次性容器执行下列维护命令。
3. 运行 preflight；审查未知状态、身份组合、旧管理员名单、钱包差异和存储诊断。未知充值来源与未知历史库存只盘点，不补造事实。未知状态/身份异常/钱包差异会阻止 backfill。
4. backfill 分批规范状态、编号、封禁、申请和规格基线；审查报告，完成全部实体后执行 finalize 和 verify。
5. 校验通过后启动新 API/worker，按名单复核 super 授权，测试旧前端登录、订单读取和高危操作。再开放写入和前端新入口。
6. 对窗口内支付事件运行既有渠道查询、对账和补偿，不假设渠道一定会重发失败回调。记录未决案件及负责人。

以下命令在新容器的 `/app` 下执行，环境和报告目录由运维通过受控挂载注入。示例不包含连接串或密钥。`/reports` 必须可写且持久保存；一次只运行一个治理迁移进程。

```bash
node scripts/migrate-deploy.mjs
node dist/scripts/governanceMigrate.js preflight --report /reports/preflight.json
node dist/scripts/governanceMigrate.js backfill --dry-run --report /reports/dry-run.json
node dist/scripts/governanceMigrate.js backfill --maintenance --batch-size 1000 --report /reports/backfill.json
node dist/scripts/governanceMigrate.js finalize --maintenance --report /reports/finalize.json
node dist/scripts/governanceMigrate.js verify --report /reports/verify.json
```

本地源码等价入口是 `npm --prefix server run governance:migrate -- <phase> ...`。镜像内可用 `npm run governance:migrate:runtime -- <phase> ...`，不依赖 tsx 或源文件。

扩展迁移自动执行 UTC 时间戳触发器、不可变编号和规格白名单修订触发器；并发索引不放在 Prisma 事务迁移内。部署包装器为其设置 5 秒锁等待、15 分钟语句超时，失败退出，重跑会修复本批遗留的 invalid 索引。定义不符但 valid 的索引由 verify 拒绝，需人工查明后重建，不能直接掩盖。

finalize 在回填或索引缺项时拒绝执行；成功后验证 7 个 CHECK。verify 同时检查数据、8 个本批索引定义/有效性以及最终约束。镜像每次启动依次执行 deploy、verify、API；数据库未完成切换时失败退出，不静默启动。

## 中断恢复和历史含义

每批提交后写 report 的 checkpoints。恢复必须明确实体，ID 不能跨表通用：

```bash
node dist/scripts/governanceMigrate.js backfill --maintenance --entity Order --resume-after-id 1234 --batch-size 1000 --report /reports/orders-resume.json
```

实体为 Order、SettlementBatch、OrderAfterSalesCase、User、OrderStatus、Merchant、Offer。非零 resume 缺少 entity 会拒绝。完成单实体恢复后，运行一次无 entity 的完整 backfill 检查剩余实体；重复执行不会重编已存在编号、覆盖授权或伪造历史决定。恢复起点只能采用已提交检查点，不能跳过未处理行。

编号日期按原 createdAt 的上海日期，随机段为 12 位 Crockford Base32；技术 ID、链接、外部供应商引用不变。User.status 规范成 active/banned，旧响应 status 保留中文；Order.completed 规范成 delivered。新版 CHECK 生效后旧写入会被拒绝。

旧封禁只创建 legacy_unknown 基线，不编造原因/操作人；旧商家资料与规格仅创建观察基线，不编造审核/调价时间。updatedAt 的初始值是迁移观察时刻，不能用于声称已恢复历史修改时间。新管理员默认无权限；仅扩展迁移之前的原管理员由 backfill 初始化为 super，发布时必须逐一复核。

## 锁与业务恢复边界

充值人工审核保持 RechargeOrder → RechargeRefund → 账户/来源的顺序。渠道退款观察即使早于本地退款，也先取得充值订单根锁并留下订单或支付尝试关联的核对案件。存在 open 对账案件时禁止人工恢复、新建或再次提交外部退款；通过既有对账流程核实事实，不能删除案件绕过。审核成功的 points_held 仅表示已冻结待处理，外部执行沿用原 worker 和渠道幂等键。

商家生命周期使用用户会话 advisory lock → Merchant 排他锁；下单保留 Product/Offer → Merchant SHARE。停用不反锁 Product。商家 webhook 写侧由每商家 advisory lock 串行化，持 Merchant SHARE 复核资格，再取得配置排他锁；下单的配置共享锁保留原线性化语义。配置轮换不以 Merchant 排他锁挡住下单回读。

文件绑定持 DeliveryFile SHARE 并锁内复核可用性；GC 先持对象 key advisory lock、DeliveryFile UPDATE，再复核真实引用。候选扫描结果不能单独授权删除，GC 不反锁订单。导出使用独立任务租约 token CAS，物化事务与上传分离；旧 worker 不能覆盖新租约结果。

封禁到期按查询时刻生效，不依赖 cron；撤销的旧会话到期后也不会复活。恢复商家不会解除账号封禁或支付争议限制。权限在请求时检查；导出另在创建、执行和下载检查当前权限与原管理会话。

## 导出、巡检与告警

导出上限为每任务 100,000 行、128 MiB，每管理员 1 个活动任务、全局最多 2 个有效执行租约。物化超限会回滚快照行，重试复用已提交快照。完成后保留 24 小时，签名下载最长 60 秒；已签发 URL 在剩余有效期内仍是持有者凭证。任务摘要不保存下载 URL。

切换存储必须保留旧提供商配置与凭据，已完成任务按绑定 providerConfigId 读取。GC 识别 admin-exports 命名空间，保留未过期成功报告和有效执行租约，删除过期快照/对象及超过宽限期的孤儿对象。失败任务看 errorCode；不要通过改数据库 status 假装成功。

治理 worker 每 15 秒尝试认领导出；维护任务受舰队租约控制。余额来源巡检每批 500 账户，固定上界和检查点，完整扫描结束后按小时启动下一轮。巡检只记录差异；重查守恒恢复后才自动将案件标为 resolved，不提供自动调账。

`governance-p1` 包含退款人工审核超过 24 小时、导出等待超过 30 分钟/失败、钱包守恒差异、巡检超过两小时未完成。后端值班人负责首响；规则及指标已入库，外部 receiver 尚未启用。本 PR 不发送 Slack/邮件。上线前由运维配置接收器并演练 firing/resolved；完成前人工查看队列与指标，不能宣称告警已送达。

## 回滚

扩展之后、状态切换之前，可在确认兼容后恢复旧应用；保留新增表、触发器和编号。英文状态切换之后禁止直接恢复不认识新封禁/权限的旧后端。优先使用兼容回退产物，必要时关闭业务入口，保留身份判断、钱包和支付收敛能力。

不执行 DROP 表、重置编号或仅恢复余额表。全库恢复必须同时规划恢复点之后的渠道支付、退款、结算和外部权益核对；这属于单独的事故恢复操作。任何未知外部结果保持待核对，不通过重建退款主记录重新出款。
