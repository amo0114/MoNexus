# 订单生命周期与 AI 告警

规则随生产 Prometheus 挂载。仓库不创建或激活外部 receiver；`orders-p1`、`ai-p1` 必须由运维接入现有值班路由并演练。receiver 未确认前，以管理端“仅待核对履约”队列和日志人工巡检兜底。阈值是初始运维阈值，可按观测负载调整。

积压 gauge 来自数据库，每次抓取最多缓存 15 秒，多实例用 max 聚合；标签不包含订单、用户、供应商输入或模型原文。最老年龄以订单对应时间为基准，不表示已确认远端失败。`MoNexusFakaRevokePending` 表示队列连续非空 30 分钟，持续新请求也可触发；它不是单任务等待时长。撤销失败统计包括已退款订单。

## 规则

- MoNexusOrderLifecycleFailures（orders-p1，持续 2m）：`increase(monexus_order_lifecycle_events_total{outcome="error"}[10m]) > 0`。Order background task failed; inspect the operation and retry affected work.
- MoNexusOrderCancellationStuck（orders-p1，持续 10m）：`max(monexus_order_lifecycle_oldest_age_seconds{state="cancel_pending"}) > 900 and max(monexus_order_lifecycle_backlog{state="cancel_pending"}) > 0`。Cancellation is unresolved; review the admin order queue. Unknown results never authorize a refund.
- MoNexusFulfillmentReconciliationStuck（orders-p1，持续 10m）：`max(monexus_order_lifecycle_oldest_age_seconds{state="fulfillment_reconcile"}) > 1800 and max(monexus_order_lifecycle_backlog{state="fulfillment_reconcile"}) > 0`。External fulfillment needs operator reconciliation.
- MoNexusFakaRevokeFailed（orders-p1，持续 5m）：`max(monexus_order_lifecycle_backlog{state="faka_revoke_failed"}) > 0`。Remote revocation failed; inspect the Faka task and retained points.
- MoNexusFakaRevokePending（orders-p1，持续 30m）：`max(monexus_faka_revoke_pending) > 0`。Xboard revocation queue has not drained for 30 minutes; check task ages and arrival rate.
- MoNexusOrderDeadlineOverdue（orders-p1，持续 15m）：`max(monexus_order_lifecycle_backlog{state=~"accept_due|dispute_due"}) > 0`。Order deadline work is not draining; inspect cron leases and logs.
- MoNexusAiGenerationFailures（ai-p1，持续 5m）：`sum(increase(monexus_ai_generation_total{status="failed"}[10m])) >= 5`。AI generation failures are accumulating; inspect provider and error codes.
- MoNexusAiValidationRejections（ai-p1，持续 5m）：`sum(increase(monexus_ai_validation_rejections_total[15m])) >= 20`。AI validators rejected an unusual volume; inspect redacted fixtures and prompt version.
- MoNexusAiTokenSurge（ai-p1，持续 5m）：`sum(increase(monexus_ai_tokens_total[15m])) > 1000000`。AI token consumption exceeded the initial operational threshold; verify quotas and traffic.

## 处理步骤

1. 查看后台订单列表，勾选“仅待核对履约”，按订单号查看详情；Faka 撤销失败同时查看现有 Faka 任务队列。
2. 点击“重新核对取消”触发取消/查询。未知结果保持冻结，确认成功则按实际结果交付。
3. Xboard 必须由撤销协议返回成功 tombstone，人工备注不能替代该条件。其他供应商自动查询持续失败时，在供应商侧核实操作键/订单号并取得撤销或未生效凭证；任务租约结束后，在订单详情记录核对证据并确认退款。不得以超时、404、任务年龄代替远端证据。
4. 核对审计、积分流水和库存；有历史交付的订单不回补产能。不要在此流程中修改供应商输入或重开 execute。
5. AI 告警先检查按错误码聚合的日志、配额与供应商状态，不向日志追加模型原文或商品秘密。模型诊断仅显示本地固定文案。

接入第二个真实 provider 前必须运行通用任务人工操作隔离、取消不确定性和批次隔离回归；R2-04/SR-01 已由 #333 修复，新增 provider 不得绕过该守卫。

治理任务使用 `governance-p1` 路由，由现有运维 receiver 接入；本次不自动创建外部接收人。

- MoNexusRefundReviewOverdue：`max(monexus_governance_oldest_age_seconds{state="refund_manual"}) > 86400`。Recharge refund manual review exceeded 24 hours; assign an owner and inspect source evidence.

- MoNexusExportBacklog：`max(monexus_governance_oldest_age_seconds{state="export_pending"}) > 1800 or max(monexus_governance_backlog{state="export_failed"}) > 0`。Private exports are delayed or failed; inspect storage and task error codes.

- MoNexusWalletIntegrityDifference：`max(monexus_governance_backlog{state="wallet_issue"}) > 0`。Wallet source conservation differs; investigate evidence without automatically adjusting balances.

- MoNexusWalletIntegrityStale：`time() - max(monexus_wallet_integrity_last_success_timestamp_seconds) > 7200`。Wallet integrity scans have not completed for two scheduled rounds; inspect leases and checkpoints.
