# Order Notification System — Phase 1 Checklist

| 字段 | 值 |
|------|------|
| Spec | SPEC-NOTIFY-001 v1.1.0 |
| Date | 2026-08-07 |

## P0 Functional

- [x] Notification Prisma model + unique `(recipientUserId, eventType, dedupeKey)`
- [x] Indexes: `recipientUserId+status+createdAt`, `relatedOrderId`, `expiresAt`
- [x] No `NotificationPreference` / `NotificationDelivery` / merchant notification email field
- [x] Dispatcher central filter + templates (plain text only)
- [x] Idempotent write (`createMany` + `skipDuplicates`)
- [x] API: list / unread-count / mark read / mark all read
- [x] Auth: only `recipientUserId = me`
- [x] Checkout mount: merchant new order (NTF-05) + instant weak delivered (NTF-06)
- [x] `transitionOrderStatus` mount: delivered / processing / disputed / refunded / closed / resolved
- [x] Platform-owned manual: no admin fanout (NTF-15)
- [x] `NOTIFICATION_ENABLED=false` → API 404, writes skipped
- [x] Single bell + 公告/消息 dual Tab (NTF-11)
- [x] `/notifications` page + `/orders?focus=` deeplink

## Acceptance Criteria (spec §7)

| ID | Status |
|----|--------|
| A-01 | Covered (integration + E2E) |
| A-02 | Covered (integration + E2E) |
| A-03 | Covered (integration + E2E) |
| A-04 | Covered by design path via `transitionOrderStatus` + unit filter (Faka worker uses same deliver path) |
| A-05 | Covered (dispatcher + integration) |
| A-06 | Covered (separate counters; UI dual tab) |
| A-07 | Covered (service API + E2E) |
| A-08 | Covered (templates + dispatcher + integration) |
| A-09 | Covered (service API) |
| A-10 | Covered (templates all Phase 1 eventTypes + lifecycle integration) |
| A-11 | Covered (integration) |
| A-12 | Covered (E2E UI dual tab) |
| A-13 | Covered (templates + E2E plain text) |
| A-14 | Covered (integration) |

## Verification commands run

```bash
# Backend
TEST_DATABASE_URL=... REDIS_ENABLED=false npm --prefix server test -- src/modules/notifications
TEST_DATABASE_URL=... REDIS_ENABLED=false npm --prefix server test -- src/__tests__/orders.test.ts
npm --prefix server run build

# Frontend
npm run build   # includes tsc -b

# E2E (requires NOTIFICATION_ENABLED=true on API server)
npm run e2e -- e2e/notifications.spec.ts
```

## Non-Goals (must remain undone)

- [x] No preference table / API / UI
- [x] No email channel
- [x] No rich HTML/Markdown/images/attachments
- [x] No new merchant notification email field
- [x] No platform duty/owner model
