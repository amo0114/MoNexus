# 后端治理 v1 验证记录

本目录仅含合成数据及本地隔离环境证据，不包含线上数据或凭据。基线 develop@8da71e0；契约版本 1.0.2。运行时代码 `2c53ba7` 已完成本地验证，最终 CI 与跨端门禁见 [后端 PR #349](https://github.com/amo0114/MoNexus/pull/349)。

## 已取得的证据

| 范围 | 证据和限制 |
| --- | --- |
| 编译与架构 | Node 22.23.1 下服务端编译、架构边界与 OpenAPI 引用通过；架构规则 9 项通过 |
| 第一组兼容回归 | merchant、auth-sessions、admin、file-cleanup、file-delivery-chain、deliveryFileOwnership、governance-v1 共 7 文件 103 项通过 |
| 高风险复查 | auth-mfa、notification-remediation-concurrency、recharge-refund-dispute-exclusion、governance-v1、file-cleanup 共 5 文件 53 项通过；不同运行有重叠，不相加为独立用例数 |
| 最终编号/HTTP 回归 | governance-v1、p7b-lifecycle-races、p7b-auto-provision、sla-remind、booking、subscription-remind 共 6 文件 65 项通过；包含真实 HTTP 契约校验、导出 kind/时区输入与跨管理员任务隐藏 |
| 账务及其他回归 | commerce-accounting-closure、accounting-concurrency、offers、refund-inventory-policy、chatbot-bind-abuse、xboard-bot-v2、leaderboard、announcements、admin-ai-settings、recharge-reconcile-resolution、p7b-result-settlement 全部通过；同轮仅 p7b-lifecycle-races 的旧邮件编号断言失败，该文件已在最终 65 项回归中通过 |
| CI 修复定向回归 | pagination-policy、admin-query、user-status-cache 共 3 文件 24 项通过；refund-reconcile-required-items、recharge-migration-replay 共 2 文件 6 项通过。保留已有分页配置，验证跨实例封禁不能被暖缓存绕过，以及空库/历史支付升级迁移 |
| 契约夹具 | 39 个操作、64 个 schema 引用有效；20 个合成 response 通过 schema 校验；导出按 kind 拒绝无关字段 |
| 真实存储 | [storage-evidence.txt](storage-evidence.txt)：真实本机 MinIO，私有访问、冻结快照、切换提供商后读取旧报告、有效文件保活和到期清理通过；可重跑 server/scripts/verify-governance-storage.mjs |
| 数据迁移 | [migration-verified.json](migration-verified.json)：回填、约束、索引验证通过。完整从旧 schema 的 118 个历史迁移升级：旧用户/商家/商品/订单/结算批次/售后均在扩展迁移前写入；未知状态阻止回填、最终约束缺项检测与修复均通过 |
| 规模查询 | [scale-evidence.json](scale-evidence.json)：10,004 用户、100,001 订单、100,000 流水、30,000 lot；每类查询 20 次，含 EXPLAIN ANALYZE/BUFFERS |

## 规模结果的解释

本机 PostgreSQL 14.24、Node 22.23.1、i5-12500H / 8 个逻辑 CPU / 8.3GB 内存，数据库在持久磁盘，保留默认持久性设置。测试通过编译后的真实领域查询调用数据库，包含权限读取；不是 HTTP 请求，也不代表生产并发负载。测量时同一主机另有隔离测试库活动。

| 查询 | 20 次样本 P95（ms） |
| --- | ---: |
| 用户默认排序 | 15.6 |
| 用户净消费排序 | 314.4 |
| 用户 UID 精确搜索 | 6.8 |
| 用户模糊搜索 | 17.9 |
| 用户详情 | 13.2 |
| 订单 keyset 明细 | 7.1 |
| 流水 keyset 明细 | 5.6 |
| 导出入队 | 36.9 |

列表/概览和入队 500ms、明细 300ms 的本地 P95 目标均满足。firstMs 是该测量循环第一次请求（例如默认列表 74.6ms），未清理 PostgreSQL/操作系统缓存，因此不能标作冷缓存。真正冷启动、HTTP 序列化和并发压力仍需预发布环境测量；本地数字不是 SLA。

普通列表仅对当前页用户聚合订单；按消费等派生字段排序时，对筛选集聚合后排序。规模脚本验证了 100,001 行导出明确失败，且快照行数为 0；巡检从首批 500 继续到 10,000 个账户完整覆盖，未引入资金差异。

## 迁移复现材料

[legacy-seed.sql](legacy-seed.sql) 用于治理迁移之前的合成旧 schema。[migration-assertions.sql](migration-assertions.sql) 对旧夹具 ID 检查非法状态/角色、编号不可变与唯一性、raw SQL 的 UTC updatedAt、上海历史日期。只能在新建隔离数据库执行，不能作为线上修复脚本。

本次完整升级额外保存 [回填前后](migration-backfill.json)、[非法历史阻止报告](migration-exception.json)、[提前收紧拒绝报告](migration-premature-finalize.json) 和 [缺失约束拒绝报告](migration-missing-constraint.json)。

迁移顺序：从基线 git 提取 server/prisma 到临时目录 → 对新建隔离库重放基线 migrations → 写 legacy-seed.sql → 当前版本 db:migrate:deploy → preflight/dry-run → backfill → finalize → verify → 执行断言 SQL。维护 CLI 及单实体恢复参数见 [发布手册](../../operations/backend-governance-v1.md)。

已验证 premature finalize 被拒绝；跳过部分 User 检查点后仍能检测缺失封禁；重复回填保留已有编号/历史；删除编号索引后 verify 被拒绝，重跑 deploy 修复索引后 verify 通过。未知充值来源和历史库存缺失作为观察项保留，不自动生成可证明来源。

## AC 对照

| AC | 主证据 |
| --- | --- |
| 01–04 | recharge-refund-dispute-exclusion.test.ts：其他来源不能补资格、原来源恢复、批准/拒绝竞争、争议竞争、幂等与一次冲正；渠道观察早于本地退款及 attempt-only 核对案件不能绕过 |
| 05–09 | governance-v1.test.ts：申请版本竞争与重提、停用旧会话撤销/新会话历史权限、下单与停用竞争、到期封禁与旧会话不复活 |
| 10–11 | governance-v1.test.ts：直接访问独立管理/上传/交付入口被拒；注入审计写失败后状态、撤销会话和回执同事务回滚 |
| 12–13 | 迁移报告与 migration-assertions.sql；编号唯一约束、重复/中断恢复、数据库直接写非法值和 raw SQL 更新时间 |
| 14–15 | governance-v1.test.ts：真实逐件批次、作废与销售竞争、白名单修订无秘密、同值无重复；数据库触发器覆盖全部 Offer 写入 |
| 16 | governance-v1.test.ts：Order 仍 closed 的已执行售后纳入退款统计，缺分区权限返回 null |
| 17–18 | governance-v1.test.ts、规模脚本和真实 MinIO 脚本：快照重试、旧租约不能完成、权限撤销、限额、切换存储和清理 |
| 19 | governance-v1.test.ts：已知两类差异、仅重查不改账；规模脚本完成固定上界分批覆盖 |
| 20 | 既有 admin/auth/merchant 回归验证旧响应；新前端对无能力版本后端的降级由前端 PR 验证，后端不能代替其完成 |

## 首轮 CI 与修正

[首轮 CI](https://github.com/amo0114/MoNexus/actions/runs/43254126492) 的架构、生产 compose、真实 Redis/存储、全部四个 E2E 任务及后端分片 1/6 通过。其余分片发现用户主列表未沿用系统分页配置、历史支付迁移夹具未排除依赖迁移、旧缓存实现断言与跨实例授权语义冲突、种子源码断言范围过宽，以及退款对账显式空外键被回退覆盖。已修复并通过上述 30 项定向回归；完整 CI 复验状态以 PR 为准。鉴权直接读取当前事实，避免进程内暖缓存放过其他实例写入的封禁或已撤销会话。

## 尚需发布门禁

同一 PR 需带 run-e2e，等待完整 backend / external-dependencies / E2E / CI OK。治理前端尚由另一 agent 负责，新页面全旅程在前端 PR 联调。生产迁移、备份恢复、真实支付渠道和告警 receiver 演练未执行；本批不部署生产或发送外部告警。
