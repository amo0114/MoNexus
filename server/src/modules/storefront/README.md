# Storefront

`GET /api/storefront/candidates?categoryCode=<optional stable code>` aggregates
sponsored and editorial candidates for the storefront. Optional JWT auth uses
the existing active-user gate and determines the guest/member audience.

- The server derives home/category placements; clients cannot choose audience,
  merchant, arbitrary placement or limit. Each source is bounded to six cards.
- Editorial category and exact guest eligibility filtering occur before the
  limit. A bounded feature-ID query uses the shared public visibility SQL
  (including content revision equality); hydration rechecks current visibility.
  Time windows and sort order remain unchanged.
- Union IDs are hydrated once via products' bounded public-card use case. It
  rechecks visibility/merchant state and batches availability and merchandising.
  Internal content, offers and governance/billing fields are excluded.
- A failed selector logs a bounded source/reason and degrades to the other
  source. Card hydration failure is an ordinary server error; frontend organic
  results remain independent.
- Responses are `private, no-store`. Existing sponsored ID selection caching
  and invalidation remain in place. No new full-card cache is introduced, so
  revocation/visibility checks are not bypassed on a new query.
- Legacy sponsored, editorial and summaries endpoints remain supported.

Frontend `storeCandidates.ts` shares in-flight requests by protocol, complete
browser session and category. Consumer aborts are independent; the final
consumer releases the shared transport. No completed result is retained.

Contract: `docs/superpowers/specs/monexus-api-openapi.json` (`StorefrontCandidates`).
Targeted integration coverage: `candidates.test.ts` with disposable PostgreSQL.
