# Merchant workbench — PR1 read APIs

Contract: `docs/specs/merchant-workbench-v1.md`. Frontend integration is PR2.

Mounted at `/api/merchant/workbench` after the existing active-user and active-merchant middleware. Scope is looked up from the authenticated user, never supplied by the client. `MERCHANT_WORKBENCH_ENABLED` defaults to false. Disabled endpoints return 404; collection 200 means enabled; 503/network failure must not hide the UI entry. A single-resource 404 does not imply the feature is disabled.

| GET endpoint | Response / limit |
| --- | --- |
| `/urgent` | `fulfillment`, `soldOut`, `urgentTotal`, `urgentKnownCount`; at most 200 items per group |
| `/availability` | One availability group, at most 200 items |
| `/drafts?beforeProductId=...` | Up to 20 scanned products, at most 4 concurrent checks; explicit `results`, `failedProductIds`, `hasMore`, `nextBeforeProductId` |
| `/items/:rule/:targetId` | `match` with item, `clear`, or `ineligible`; foreign/missing resource 404; read failure 503 |

Groups expose `items`, `matchedTotal`, `truncated`, `evaluatedAt`, `status`. Failed urgent groups return null counts and status failed. When both urgent groups fail, the request returns 503. No partial count is presented as a total. Draft batches retain unknown results for individual read failures; a candidate removed/transferred after enumeration becomes ineligible, without returning its content.

Only `/urgent` is intended for 60-second polling. It never invokes readiness. Normal availability and drafts refresh on page entry, focus, explicit refresh, or relevant successful operations. Draft continuation uses a product-ID cursor; other rules have no pagination.

`repository.ts` owns data access. Availability uses scoped inventory aggregation; group rows/counts share a repeatable-read transaction. Orders are scoped by `Order.merchantId`, with Prisma Date filters; no implicit SQL timestamptz comparison against the legacy timestamp column. Draft ownership and inspection share a snapshot.

Publication's `checkProductReadiness` keeps its existing return shape. It and the workbench use `inspectProductReadiness`, with the same options/defaults and the extracted pure `readinessOffer.ts` evaluator. The workbench receives safe availability navigation hints from that evaluation; it never parses diagnostic prose or reimplements publish decisions.

DTOs explicitly construct every public field. No delivery content, purchase answers, emails, provider identifiers, or internal diagnostic prose. Actions are closed objects for PR2 to map to local navigation, not executable requests or arbitrary URLs. No business writes, preferences, new database tables, notifications, cron, or model calls.

Metrics use finite rule/result labels, with read latency, failures, truncated groups, and scanned draft counts. No resource IDs or content appear in metric labels.
