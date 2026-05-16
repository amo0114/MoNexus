# M6 Gemini UI Contract

> **Purpose.** This document is the frozen contract the Gemini UI companion follows after A1-A7 land. It is not an implementation. It defines the pages / components / states the frontend must build, the API contracts those screens consume, and the invariants the UI must preserve.
>
> **Authority.** Backend contracts are authoritative — see `docs/superpowers/specs/monexus-api-openapi.json` (`v1.4.0`) and `docs/operations/openapi-m6-note.md`. UI invariants here override visual / micro-interaction preferences. Anything that conflicts with the OpenAPI spec is a UI bug, not a contract change.
>
> **Out of scope.** This document does not pick component libraries, styles, or animation budgets. It does not authorize new business semantics (no payment, no fiat, no shipping, no C2C). Visual style follows `design-system/monexus/MASTER.md`.

---

## 1. Contract rules (read once, apply everywhere)

1. **Consume registry, do not hardcode labels.** `GET /api/config/registry` returns `productTypes`, `deliveryModes`, `orderStatuses`, `settlementStatuses` with `{value, label, tone}`. Render labels and status pills from this payload only. Hardcoded strings like `已交付`, `待处理`, `争议中` in `.tsx` files are a contract violation. `rg -n '已交付|待处理|争议中|已关闭|已下架|待结算|已结算' src/pages src/components` must return zero hits in code (only schema / type files may quote them as comments).
2. **Use `availableActions` from backend.** Every merchant order list / detail row carries `availableActions: string[]`. Possible values: `start_fulfillment`, `deliver`, `respond_dispute`. Render the action buttons enabled if-and-only-if the action is present in this array; render them disabled (or hidden) otherwise. Do not compute eligibility client-side from the status string.
3. **Never display platform inventory secret content in merchant views.** Merchant list and merchant detail responses already strip `delivery.content`. The UI must not attempt to render that field on any merchant screen — no fallback fetch through admin tokens, no caching of stale content from a previous bug. Treat `delivery` as `{status, publicNote?, deliveredAt?}` on every merchant screen.
4. **Amounts are integer points; never introduce currency.** Server fields like `price`, `commissionAmount`, `settlementAmount`, `balanceAfter` are non-negative integers representing internal points. Do not format them with `$`, `¥`, `CNY`, `USD`, percentage of fiat, or any other currency-flavored symbol. Use the existing `formatPoints` helper or render the bare integer + the `积分` suffix consistent with M5.
5. **Pagination uses backend envelopes.** All M6 list endpoints return either an array (legacy user list) or a `{items, total, page, pageSize}` envelope (merchant orders, merchant products). Drive the pager UI from `total` / `page` / `pageSize`; do not infer "last page" from `items.length < pageSize`.
6. **Deliver content boundary on input.** When the merchant submits a `deliver` action, treat the `deliveryContent` field as sensitive. Do not store it in client-side state longer than necessary, do not log it in analytics, do not include it in error toasts that round-trip to monitoring.
7. **Do not invent new endpoints.** If a screen seems to need data that no documented endpoint provides, surface that gap to A0 and the OpenAPI owner — do not synthesize the field client-side from a related call.

---

## 2. `MerchantDashboardPage`

Entry route: `/merchant`. Top-level shell for the merchant role; tabs for sub-views.

**Data sources**

- `GET /api/merchant/me` — header / identity.
- `GET /api/merchant/stats` — KPI tiles (`productCount`, `orderCount`, `totalRevenue`, `pendingSettlement`).
- `GET /api/config/registry` — labels and tones for any pill rendered in tiles or recent-activity rows.

**Required UI states**

| State | Trigger | UI behavior |
| --- | --- | --- |
| loading | first mount, no cache | skeleton tiles + skeleton tab list; do not flash empty zeros. |
| ready | both `me` and `stats` resolved | KPI tiles + tabs. |
| degraded / partial | `me` resolved but `stats` failed | render header + tabs; replace KPI tile values with a single retry CTA per tile. |
| error / retry | both failed | full-page error card with a single retry button that re-fires both calls. |
| forbidden | `me` returns 404 (user is not a merchant) | redirect to `/merchant/apply` (existing flow), no error toast. |

**Tabs** (each tab is a separate documented contract below): `概览` (KPI), `商品`, `订单`, `结算`, `资料`.

**Invariants**

- KPI values are integers; format with thousands separator, never with a decimal.
- Do not show a "本月收入" or "今日交易额" KPI unless a backend endpoint exists for it — the `stats` shape is fixed.
- The page must not call any `POST` / `PUT` on initial mount.

---

## 3. `MerchantProductFormModal`

Used from the `MerchantDashboardPage > 商品` tab for both create and edit.

**Data sources**

- `POST /api/merchant/products` (create) — request body must match `CreateMerchantProductRequest`.
- `PUT /api/merchant/products/{id}` (edit) — request body must match `UpdateMerchantProductRequest`.
- `GET /api/config/registry` — populates the `type` dropdown (from `productTypes`) and the `deliveryMode` radio (from `deliveryModes`). `productTypes[].deliveryModes` constrains which delivery modes are valid for a given product type; the UI must filter the radio options accordingly.

**Required fields**

- `name` (text, min 1).
- `type` (select; values from `registry.productTypes[].value`).
- `price` (integer; min 1; helper text `单位：积分`).
- `deliveryMode` (radio; default `instant_inventory`; required).

**Optional fields**

- `description` (textarea).
- `richDescription` (rich text or markdown textarea).
- `icon` (icon picker; defaults to `package`).
- `imageUrl` (URL input or upload widget).
- `originalPrice` (integer; min 1).
- `isHot` (toggle).
- `status` — **only shown in edit mode**, never create. Values from `registry` or hardcoded as `active` / `inactive` keyed off the `ProductStatus` enum (the only place a non-registry enum is acceptable because the spec defines it directly).

**Required UI states**

| State | UI behavior |
| --- | --- |
| idle (create) | empty form; submit disabled until required fields valid. |
| idle (edit) | prefilled from product row; submit disabled until any field changes. |
| submitting | button → spinner; whole form disabled. |
| validation error from server (400) | per-field error message keyed off `error.details[].field` from `ErrorEnvelope`; do not blow away other entered fields. |
| network error | inline error banner above the buttons; offer retry. |
| success | close modal; toast `商品已保存`; parent list refreshes via re-fetch (no optimistic insert). |

**Invariants**

- `deliveryMode` cannot be changed for a product that has live inventory items (`availableStock > 0`) without an explicit confirmation step in the UI — server allows it (no DB constraint), but the UI must warn that switching `instant_inventory → manual_service` makes existing inventory invisible until merged back. Surface this as a confirm dialog inside the modal.
- Do not send fields the user did not change in edit mode — send only the diff, so unrelated server-side defaults aren't accidentally clobbered.
- Do not display a "category" or other taxonomy outside the registry.

---

## 4. `MerchantInventoryImportModal`

Entry: row action on the `商品` tab. Used only on `instant_inventory` products; the action button must be hidden for `manual_service` rows.

**Data sources**

- `POST /api/merchant/products/{id}/inventory/preview` — request `{text?, items?}`; response `InventoryPreviewResponse` (`totalRows`, `validRows`, `emptyRows`, `duplicateRows`, `existingDuplicateRows`, `canImport`).
- `POST /api/merchant/products/{id}/inventory` — same request shape; response `MerchantInventoryImportResponse` (adds `imported`, `skippedEmptyRows`).
- `GET /api/config/registry` — `inventory.lowStockThreshold` for the "after import" callout.

**Flow**

1. Merchant pastes multi-line text OR uploads a file the UI splits into `items[]`.
2. UI sends `preview`. UI must always preview first — never call `import` directly.
3. Preview response renders a stats panel:
   - `共 totalRows 行`
   - `有效 validRows 行`（绿色）
   - `空行 emptyRows`（灰色，仅信息提示）
   - `请求内重复 duplicateRows`（橙，存在时禁用导入按钮）
   - `与既有库存重复 existingDuplicateRows`（红，存在时禁用导入按钮）
4. The "确认导入" button is enabled if-and-only-if `canImport === true`. When disabled, surface the specific blocker(s) below the button.
5. On confirm, send `import`. Use the cleaned text/items the merchant edited after preview — do not silently strip dupes for them. If the merchant insists on importing partial sets, they edit the input and re-preview.

**Required UI states**

| State | UI behavior |
| --- | --- |
| idle | textarea + upload + 预览 button. |
| previewing | preview button → spinner; stats panel hidden. |
| previewed | stats panel visible; import button enabled only if `canImport`. |
| importing | import button → spinner; cancel disabled. |
| imported | success state showing `成功导入 X 条`, plus `当前可用库存：N`. Optional low-stock hint if `availableStock <= lowStockThreshold` (the parent product row will refresh from the list endpoint to confirm). |
| import error (400 with dupes) | re-render stats panel using the error's `details[]` payload; do not lose the merchant's edited input. |
| network error | inline error; offer retry. |

**Invariants**

- Never display the merchant's inventory rows back to other users — this modal is merchant-only.
- Do not call `preview` on every keystroke. Debounce or require an explicit button.
- Do not pre-strip duplicates in the request body; the server is the source of truth for "what counts as duplicate".

---

## 5. Merchant order list

Entry: `MerchantDashboardPage > 订单` tab.

**Data source**

- `GET /api/merchant/orders?status=&q=&productId=&dateFrom=&dateTo=&page=&pageSize=` — response is `MerchantOrderListEnvelope` (`{items, total, page, pageSize}`).
- `GET /api/config/registry` — labels and tones for the status filter chips and the row pills.

**Required UI controls**

- Status filter chips (from `registry.orderStatuses`; chip `tone` from registry; chip count badges optional).
- Free-text search input (mapped to `q`; debounced; min length 1 enforced server-side).
- Product picker (optional; mapped to `productId`).
- Date range picker (mapped to `dateFrom`, `dateTo`; values must be `YYYY-MM-DD`).
- Pager (driven by `total` / `page` / `pageSize`).

**Per-row content**

- Order id + created date.
- Buyer email (from `user.email`).
- Product name + icon + `deliveryMode` badge (from registry).
- Status pill (from registry; tone-aware).
- Settlement amount (integer + `积分`).
- Action buttons rendered from `availableActions` (see contract rule 2). For `start_fulfillment` and `respond_dispute`, render inline buttons; for `deliver`, render a primary button that opens a small modal that takes the `deliveryContent` field before submitting (because manual service must accept the credential).

**Required UI states**

| State | UI behavior |
| --- | --- |
| loading | skeleton row list; filters remain interactive. |
| ready | rows + pager. |
| empty (no filter) | empty state card: "你还没有订单" + 商品列表 CTA。 |
| filtered empty | empty state card: "没有匹配此筛选条件的订单" + a 重置筛选 button. |
| error / retry | full-list error card; filters preserved on retry. |
| acting | the row being acted on shows an inline spinner; other rows remain interactive. |
| action error | toast + the row re-fetches its own state (or the page refetches). Do not silently swallow `400 BAD_REQUEST` from an illegal transition — show the server message. |

**Invariants**

- The list MUST send `dateFrom` / `dateTo` only when the merchant explicitly picked them; do not default to "last 30 days" without UI signaling that.
- Do not show `delivery.content` anywhere on this list.
- Pager increments / decrements are 1-indexed.

---

## 6. Merchant order detail

Entry: row click on merchant order list, or after performing an action.

**Data source**

- `GET /api/merchant/orders/{id}` → `MerchantOrderDetail` (includes `availableActions` and `statusEvents`).

**Required sections**

1. **Header** — order id, status pill (registry), created date, buyer email.
2. **Product card** — product name, icon, `deliveryMode` badge.
3. **Fulfillment actions** — a single primary action picked from `availableActions[0]` if present (with secondary actions if multiple); for `deliver`, open a modal that collects `deliveryContent` + optional public/internal note.
4. **Timeline** — render `statusEvents` in chronological order. Each event row:
   - dot tone matches the toStatus tone from the registry,
   - label = `{actorRole label}（{action key 翻译表}）`,
   - public note rendered if present,
   - internal note never shown to merchants — internal notes are admin-only; do not query / display.
5. **Settlement summary** — `settlementAmount`, settlement status pill (registry). If `settlement.payable` is exposed (when listing settlements separately), echo it next to a tooltip explaining `blockReason`. Merchant order detail itself does NOT carry `payable` / `blockReason` directly — only the settlement list does. The UI must not invent these fields here.

**Required UI states**

| State | UI behavior |
| --- | --- |
| loading | skeleton; show breadcrumb back to list. |
| ready | full detail. |
| acting | action button spinner; other interactions disabled until the response. |
| action 400 | inline banner showing the server `error.message`; the timeline does not pre-render the failed transition. |
| not-found / wrong-merchant | redirect back to list with a toast `订单不存在或不属于你`. |

**Invariants**

- Never call `deliver` for an `instant_inventory` order — the button must not be rendered.
- Never call `respond-dispute` outside of `disputed` state — `availableActions` is the gate.
- Do not surface `internalNote` from `statusEvents` (the field is allowed in OpenAPI but is admin-only by convention; merchant UI omits it).

---

## 7. User order list

Entry: `/orders` for end users.

**Data source**

- `GET /api/orders?status=&page=&pageSize=` → array of `UserOrderListItem`. `status` accepts the v1.4 enum and the legacy `completed` alias.
- `GET /api/config/registry` for labels and tones.

**Required UI controls**

- Status filter chips (from registry).
- Pager (page / pageSize controlled; total is not returned for this endpoint — drive "show more" by request length until backend exposes total).

**Per-row content**

- Product name + icon.
- Merchant name (if `merchantId != null`).
- Status pill (from registry).
- `deliveryMode` badge (`instant_inventory` → success, `manual_service` → info — both come from registry).
- Created date.
- A "查看详情" link to detail page.
- Do **not** show `delivery.content` on the list view.

**Required UI states**

| State | UI behavior |
| --- | --- |
| loading | skeleton rows. |
| ready | rows + pager. |
| empty (no filter) | empty card with CTA back to the product page. |
| filtered empty | "没有此状态的订单" + reset filter. |
| error / retry | full-list error card; preserve filters on retry. |

**Invariants**

- The legacy `completed` filter still works; if the buyer's URL has `?status=completed`, do not break — the backend normalizes it to `delivered`, and the UI should mirror that by selecting the `delivered` chip.
- Do not synthesize a fake `total` count; if the API doesn't return one, the pager is a forward-only "下一页 / 上一页".

---

## 8. User order detail

Entry: row click in user order list, or post-redeem confirmation.

**Data source**

- `GET /api/orders/{id}` → `UserOrderDetail` (includes `delivery.content` and `timeline`).

**Required sections**

1. **Header** — product name + icon, status pill (registry tone), created date.
2. **Delivery panel** — branches on `deliveryMode`:
   - `instant_inventory` → render `delivery.content` directly with a copy button. If `delivery.publicNote` exists, render below.
   - `manual_service` → if `delivery.content` exists, render it the same way. Otherwise render a "履约中" / "待商家发货" empty state aligned to the current `status`.
3. **Action buttons** — `disputed` / `closed` actions when applicable:
   - From `delivered` → `dispute` available.
   - From `delivered` or `disputed` → `close` available.
   - Render buttons enabled only if the underlying status allows it; rely on the same client-side derivation only because the user endpoint does not return `availableActions`. The merchant convention (server-driven `availableActions`) does not apply to the user side yet.
4. **Timeline** — render `timeline[]` (already synthesized server-side for legacy orders). Show `actorRole`, action key (translated via a small UI-side map), and `publicNote` if any.

**Required UI states**

| State | UI behavior |
| --- | --- |
| loading | skeleton. |
| ready | full detail with credential visible (for owners — server-enforced). |
| 404 | redirect with toast `订单不存在`. Do not differentiate "owned by someone else" vs "doesn't exist" — server returns 404 for both. |
| action error | inline error banner; preserve the current order panel. |
| network error | retry button at the top of the panel. |

**Invariants**

- Never POST `dispute` / `close` from any role other than the order owner.
- Do not display merchant `internalNote` content if it ever leaks into the user response (it shouldn't, but the UI is a second line of defense — drop unknown fields, do not render them raw).

---

## 9. Cross-cutting requirements

- **Loading** — every list / detail surface owns a skeleton state. Loading spinners are reserved for in-flight mutations, not initial reads.
- **Empty** — distinguish "you have no data yet" (CTA to the relevant onboarding) from "your filter matched nothing" (CTA to reset filters). They are different states.
- **Error / retry** — every fetched surface owns an error card with a single retry button. The retry button re-runs the originating fetch, not a full page reload.
- **Action disabled / pending** — buttons backed by `availableActions` (merchant) or client-derived eligibility (user) must reflect both "not allowed in current state" (visually disabled) and "request in flight" (spinner + disabled). These are two visually distinguishable states.
- **Tone tokens** — `tone` from registry is `success` / `info` / `warning` / `danger` / `neutral`. Map to the design-system tokens in `design-system/monexus/MASTER.md` once; do not re-pick colors per page.
- **No silent failures** — surfacing `error.message` is preferred over a generic toast when the server returns one. The error envelope contract (`{error: {code, message, details?}}`) is stable.

---

## 10. Verification (frontend smoke before handoff back to A0)

Gemini's smoke pass before A0 reviews:

1. `rg -n '已交付|待处理|争议中|已关闭|已下架|待结算|已结算' src/pages src/components` returns **0**.
2. `rg -n 'currency|usd|cny|\\$|¥' src/pages src/components` returns 0 hits in business-flow components (existing locale or icon files may match; review each manually).
3. `rg -n 'availableActions' src/pages src/components` returns at least one hit in the merchant order surface — proof the UI reads the server signal.
4. Page-by-page click-through against a seeded DB:
   - Redeem an `instant_inventory` product as a user, see credential on detail; merchant detail does not show it.
   - Redeem a `manual_service` product, walk it through `start` → `deliver` → `delivered`, then user `dispute` → merchant `respond-dispute (close)`. Verify each step's status pill comes from the registry.
   - Open a settlement view as a merchant; rows linked to `disputed` orders render `不可结算` with the server-provided `blockReason`.
   - Use the inventory import modal: paste duplicates, see preview block import; clean input, import succeeds, product list refreshes with new `availableStock`.
5. Confirm Sentry / web vitals are not regressing (M4 dashboards in `docs/operations/runbook.md` §25).

---

## 11. Hard exclusions (do not implement)

These appear in some legacy UI sketches but are out of scope for M6 and contradict the product boundary (`SHARED-RULES.md §1`):

- Payment / wallet / fiat balance display.
- Recharge / withdrawal / refund flows.
- Shipping address, courier tracking, logistics status.
- C2C "list my own product" flow.
- Cryptocurrency / token / blockchain UI.
- Affiliate / referral programs beyond the existing invite reward.

If a UI mock includes any of the above, treat the mock as a bug and escalate to A0 before implementing.

---

## 12. Pointers

- API spec: `docs/superpowers/specs/monexus-api-openapi.json` (v1.4.0).
- API change rationale: `docs/operations/openapi-m6-note.md`.
- Operator runbook (smoke, failure modes, registry inspection): `docs/operations/runbook.md` §§35-37.
- Design system tokens / typography / spacing: `design-system/monexus/MASTER.md`.
- M5 deploy / rollback procedures (still apply unchanged): `docs/operations/runbook.md` §§27-33.
