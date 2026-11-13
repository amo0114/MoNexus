export const BACKGROUND_ALERTS = [
  {
    "name": "MoNexusOrderLifecycleFailures",
    "expr": "increase(monexus_order_lifecycle_events_total{outcome=\"error\"}[10m]) > 0",
    "for_": "2m",
    "routing": "orders-p1",
    "severity": "P1",
    "summary": "Order background task failed; inspect the operation and retry affected work."
  },
  {
    "name": "MoNexusOrderCancellationStuck",
    "expr": "max(monexus_order_lifecycle_oldest_age_seconds{state=\"cancel_pending\"}) > 900 and max(monexus_order_lifecycle_backlog{state=\"cancel_pending\"}) > 0",
    "for_": "10m",
    "routing": "orders-p1",
    "severity": "P1",
    "summary": "Cancellation is unresolved; review the admin order queue. Unknown results never authorize a refund."
  },
  {
    "name": "MoNexusFulfillmentReconciliationStuck",
    "expr": "max(monexus_order_lifecycle_oldest_age_seconds{state=\"fulfillment_reconcile\"}) > 1800 and max(monexus_order_lifecycle_backlog{state=\"fulfillment_reconcile\"}) > 0",
    "for_": "10m",
    "routing": "orders-p1",
    "severity": "P1",
    "summary": "External fulfillment needs operator reconciliation."
  },
  {
    "name": "MoNexusFakaRevokeFailed",
    "expr": "max(monexus_order_lifecycle_backlog{state=\"faka_revoke_failed\"}) > 0",
    "for_": "5m",
    "routing": "orders-p1",
    "severity": "P1",
    "summary": "Remote revocation failed; inspect the Faka task and retained points."
  },
  {
    "name": "MoNexusFakaRevokePending",
    "expr": "max(monexus_faka_revoke_pending) > 0",
    "for_": "30m",
    "routing": "orders-p1",
    "severity": "P1",
    "summary": "Xboard revocation queue has not drained for 30 minutes; check task ages and arrival rate."
  },
  {
    "name": "MoNexusOrderDeadlineOverdue",
    "expr": "max(monexus_order_lifecycle_backlog{state=~\"accept_due|dispute_due\"}) > 0",
    "for_": "15m",
    "routing": "orders-p1",
    "severity": "P1",
    "summary": "Order deadline work is not draining; inspect cron leases and logs."
  },
  {
    "name": "MoNexusAiGenerationFailures",
    "expr": "sum(increase(monexus_ai_generation_total{status=\"failed\"}[10m])) >= 5",
    "for_": "5m",
    "routing": "ai-p1",
    "severity": "P1",
    "summary": "AI generation failures are accumulating; inspect provider and error codes."
  },
  {
    "name": "MoNexusAiValidationRejections",
    "expr": "sum(increase(monexus_ai_validation_rejections_total[15m])) >= 20",
    "for_": "5m",
    "routing": "ai-p1",
    "severity": "P1",
    "summary": "AI validators rejected an unusual volume; inspect redacted fixtures and prompt version."
  },
  {
    "name": "MoNexusAiTokenSurge",
    "expr": "sum(increase(monexus_ai_tokens_total[15m])) > 1000000",
    "for_": "5m",
    "routing": "ai-p1",
    "severity": "P1",
    "summary": "AI token consumption exceeded the initial operational threshold; verify quotas and traffic."
  },
{
  "name": "MoNexusRefundReviewOverdue",
  "expr": "max(monexus_governance_oldest_age_seconds{state=\"refund_manual\"}) > 86400",
  "for_": "5m",
  "routing": "governance-p1",
  "severity": "P1",
  "summary": "Recharge refund manual review exceeded 24 hours; assign an owner and inspect source evidence."
},
{
  "name": "MoNexusExportBacklog",
  "expr": "max(monexus_governance_oldest_age_seconds{state=\"export_pending\"}) > 1800 or max(monexus_governance_backlog{state=\"export_failed\"}) > 0",
  "for_": "5m",
  "routing": "governance-p1",
  "severity": "P1",
  "summary": "Private exports are delayed or failed; inspect storage and task error codes."
},
{
  "name": "MoNexusWalletIntegrityDifference",
  "expr": "max(monexus_governance_backlog{state=\"wallet_issue\"}) > 0",
  "for_": "0m",
  "routing": "governance-p1",
  "severity": "P1",
  "summary": "Wallet source conservation differs; investigate evidence without automatically adjusting balances."
},
{
  "name": "MoNexusWalletIntegrityStale",
  "expr": "time() - max(monexus_wallet_integrity_last_success_timestamp_seconds) > 7200",
  "for_": "5m",
  "routing": "governance-p1",
  "severity": "P1",
  "summary": "Wallet integrity scans have not completed for two scheduled rounds; inspect leases and checkpoints."
}
] as const
