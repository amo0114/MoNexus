-- FND-CMI-001 F0 — post-migration verification for the legacy-clean fixture.
--
-- Run via dbguard.sh psql AFTER the four F0 migrations are deployed onto the
-- legacy-clean database. Read-only: it never mutates data.
--
-- EVERY invariant below is a hard assertion implemented as a DO block that
-- RAISE EXCEPTIONs, so a failed gate exits non-zero. The paired \echo + SELECT
-- rows are masked, evidence-only projections of the same counts. All output is
-- masked counts — no delivery content, no secrets.
--
-- Expected fixture (legacy-clean.sql) after the F0 wave:
--   users=3  merchants=1  products=9  offers=12  inventory_items=5
--   orders=3  inventory_logs=3
--   statuses: active=8 inactive=1 draft=0
--   categoryId mapping: network-node=3 shared-account=1 recharge-card=2
--                       invite-code=1 legacy-unclassified=2 (sum=9)
--   publishedAt backfilled = createdAt for all 9 (active/inactive)
--   empty legacy type (1 row) repaired to 待归类
--   externalSku canonicalized: 2 offers -> xboard-sku-a / xboard-sku-b
--   all merchandising tables + ExternalCatalogLink = 0 rows
--   exactly 8 merchandising SystemConfig keys, each within its frozen range

\set ON_ERROR_STOP on

\echo '=== F0 verify: data conservation counts (hard) ==='
SELECT
  (SELECT count(*) FROM "User")            AS users,
  (SELECT count(*) FROM "Merchant")        AS merchants,
  (SELECT count(*) FROM "Product")         AS products,
  (SELECT count(*) FROM "Offer")           AS offers,
  (SELECT count(*) FROM "InventoryItem")   AS inventory_items,
  (SELECT count(*) FROM "Order")           AS orders,
  (SELECT count(*) FROM "InventoryLog")    AS inventory_logs;

DO $$
DECLARE
  v_users INTEGER; v_merchants INTEGER; v_products INTEGER; v_offers INTEGER;
  v_items INTEGER; v_orders INTEGER; v_logs INTEGER;
BEGIN
  SELECT (SELECT count(*) FROM "User"),
         (SELECT count(*) FROM "Merchant"),
         (SELECT count(*) FROM "Product"),
         (SELECT count(*) FROM "Offer"),
         (SELECT count(*) FROM "InventoryItem"),
         (SELECT count(*) FROM "Order"),
         (SELECT count(*) FROM "InventoryLog")
    INTO v_users, v_merchants, v_products, v_offers, v_items, v_orders, v_logs;
  IF v_users     <> 3 THEN RAISE EXCEPTION 'conservation users: expected 3, got %', v_users; END IF;
  IF v_merchants <> 1 THEN RAISE EXCEPTION 'conservation merchants: expected 1, got %', v_merchants; END IF;
  IF v_products  <> 9 THEN RAISE EXCEPTION 'conservation products: expected 9, got %', v_products; END IF;
  IF v_offers    <> 12 THEN RAISE EXCEPTION 'conservation offers: expected 12, got %', v_offers; END IF;
  IF v_items     <> 5 THEN RAISE EXCEPTION 'conservation inventory_items: expected 5, got %', v_items; END IF;
  IF v_orders    <> 3 THEN RAISE EXCEPTION 'conservation orders: expected 3, got %', v_orders; END IF;
  IF v_logs      <> 3 THEN RAISE EXCEPTION 'conservation inventory_logs: expected 3, got %', v_logs; END IF;
END $$;

\echo '=== F0 verify: category seed (4 active + 1 inactive legacy-unclassified) ==='
SELECT "code", "label", "status", count(*) OVER () AS total
FROM "ProductCategory"
ORDER BY "sortOrder", "id";

DO $$
DECLARE
  n_active INTEGER;
  n_inactive_legacy INTEGER;
  n_total INTEGER;
BEGIN
  SELECT count(*) INTO n_active FROM "ProductCategory"
    WHERE "status" = 'active' AND "code" IN
      ('network-node','shared-account','recharge-card','invite-code');
  SELECT count(*) INTO n_inactive_legacy FROM "ProductCategory"
    WHERE "status" = 'inactive' AND "code" = 'legacy-unclassified';
  SELECT count(*) INTO n_total FROM "ProductCategory";
  IF n_active <> 4 THEN
    RAISE EXCEPTION 'category seed: expected 4 active categories, found %', n_active;
  END IF;
  IF n_inactive_legacy <> 1 THEN
    RAISE EXCEPTION 'category seed: expected 1 inactive legacy-unclassified, found %', n_inactive_legacy;
  END IF;
  IF n_total <> 5 THEN
    RAISE EXCEPTION 'category seed: expected 5 total categories, found %', n_total;
  END IF;
END $$;

\echo '=== F0 verify: categoryId zero-null + NOT NULL + exact mapping ==='
SELECT c."code", count(p."id") AS n
FROM "ProductCategory" c
LEFT JOIN "Product" p ON p."categoryId" = c."id"
GROUP BY c."code"
ORDER BY c."code";

DO $$
DECLARE
  r RECORD;
  n_null INTEGER;
  n_mapped INTEGER;
BEGIN
  SELECT count(*) INTO n_null FROM "Product" WHERE "categoryId" IS NULL;
  IF n_null <> 0 THEN
    RAISE EXCEPTION 'categoryId zero-null violated: % NULL rows', n_null;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Product' AND column_name = 'categoryId'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Product.categoryId is not NOT NULL';
  END IF;
  -- Frozen legacy mapping (SPEC-CATALOG-OPS-001 §11.2): every product maps to
  -- exactly one seeded category with the expected distribution.
  SELECT count(*) INTO n_mapped FROM "Product" WHERE "categoryId" IS NOT NULL;
  IF n_mapped <> 9 THEN
    RAISE EXCEPTION 'categoryId mapping: expected 9 mapped products, got %', n_mapped;
  END IF;
  FOR r IN
    SELECT c."code", count(p."id") AS n
    FROM "ProductCategory" c
    LEFT JOIN "Product" p ON p."categoryId" = c."id"
    GROUP BY c."code"
  LOOP
    IF (r."code" = 'network-node' AND r.n <> 3)
       OR (r."code" = 'shared-account' AND r.n <> 1)
       OR (r."code" = 'recharge-card' AND r.n <> 2)
       OR (r."code" = 'invite-code' AND r.n <> 1)
       OR (r."code" = 'legacy-unclassified' AND r.n <> 2) THEN
      RAISE EXCEPTION 'categoryId mapping: code % has % products (frozen distribution violated)', r."code", r.n;
    END IF;
  END LOOP;
END $$;

\echo '=== F0 verify: Product.status distribution (active=8 inactive=1 draft=0) ==='
SELECT "status", count(*) AS n FROM "Product" GROUP BY "status" ORDER BY "status";

DO $$
DECLARE
  n_active INTEGER; n_inactive INTEGER; n_draft INTEGER; n_other INTEGER;
BEGIN
  SELECT count(*) FILTER (WHERE "status" = 'active'),
         count(*) FILTER (WHERE "status" = 'inactive'),
         count(*) FILTER (WHERE "status" = 'draft')
    INTO n_active, n_inactive, n_draft FROM "Product";
  SELECT count(*) INTO n_other FROM "Product"
    WHERE "status" NOT IN ('draft', 'active', 'inactive');
  IF n_active <> 8 THEN RAISE EXCEPTION 'Product status: expected 8 active, got %', n_active; END IF;
  IF n_inactive <> 1 THEN RAISE EXCEPTION 'Product status: expected 1 inactive, got %', n_inactive; END IF;
  IF n_draft <> 0 THEN RAISE EXCEPTION 'Product status: expected 0 draft, got %', n_draft; END IF;
  IF n_other <> 0 THEN RAISE EXCEPTION 'Product status: % rows outside draft|active|inactive', n_other; END IF;
END $$;

\echo '=== F0 verify: publishedAt backfill (all 9 active/inactive = createdAt) ==='
SELECT count(*) AS active_inactive_missing_published_at
FROM "Product"
WHERE "status" IN ('active','inactive') AND "publishedAt" IS NULL;

DO $$
DECLARE
  n_missing INTEGER; n_total_set INTEGER; n_exact INTEGER;
BEGIN
  SELECT count(*) INTO n_missing FROM "Product"
    WHERE "status" IN ('active','inactive') AND "publishedAt" IS NULL;
  IF n_missing <> 0 THEN
    RAISE EXCEPTION 'publishedAt backfill: % active/inactive rows missing publishedAt', n_missing;
  END IF;
  SELECT count(*) INTO n_total_set FROM "Product" WHERE "publishedAt" IS NOT NULL;
  IF n_total_set <> 9 THEN
    RAISE EXCEPTION 'publishedAt backfill: expected 9 products with publishedAt, got %', n_total_set;
  END IF;
  -- Legacy rows are backfilled to their own createdAt (never now()).
  SELECT count(*) INTO n_exact FROM "Product" WHERE "publishedAt" = "createdAt";
  IF n_exact <> 9 THEN
    RAISE EXCEPTION 'publishedAt backfill: expected 9 products with publishedAt = createdAt, got %', n_exact;
  END IF;
END $$;

\echo '=== F0 verify: empty legacy type repaired to 待归类 ==='
SELECT count(*) AS empty_type_rows FROM "Product" WHERE btrim("type") = '';

DO $$
DECLARE
  n_empty INTEGER; n_reclassified INTEGER;
BEGIN
  SELECT count(*) INTO n_empty FROM "Product" WHERE btrim("type") = '';
  IF n_empty <> 0 THEN
    RAISE EXCEPTION 'empty legacy type: % rows still have empty type', n_empty;
  END IF;
  SELECT count(*) INTO n_reclassified FROM "Product" WHERE "type" = '待归类';
  IF n_reclassified <> 1 THEN
    RAISE EXCEPTION 'empty legacy type: expected exactly 1 row repaired to 待归类, got %', n_reclassified;
  END IF;
END $$;

\echo '=== F0 verify: externalSku canonicalized (lower(btrim)) ==='
SELECT "externalIntegration", "externalSku"
FROM "Offer"
WHERE "externalSku" IS NOT NULL
ORDER BY "externalSku";

DO $$
DECLARE
  n_non_canonical INTEGER; n_offers INTEGER; n_a INTEGER; n_b INTEGER;
BEGIN
  SELECT count(*) INTO n_non_canonical FROM "Offer"
    WHERE "externalSku" IS NOT NULL AND "externalSku" <> lower(btrim("externalSku"));
  IF n_non_canonical <> 0 THEN
    RAISE EXCEPTION 'externalSku canonicalization: % non-canonical rows remain', n_non_canonical;
  END IF;
  SELECT count(*) INTO n_offers FROM "Offer" WHERE "externalSku" IS NOT NULL;
  IF n_offers <> 2 THEN
    RAISE EXCEPTION 'externalSku canonicalization: expected 2 offers with externalSku, got %', n_offers;
  END IF;
  SELECT count(*) INTO n_a FROM "Offer" WHERE "externalSku" = 'xboard-sku-a';
  SELECT count(*) INTO n_b FROM "Offer" WHERE "externalSku" = 'xboard-sku-b';
  IF n_a <> 1 OR n_b <> 1 THEN
    RAISE EXCEPTION 'externalSku canonicalization: expected xboard-sku-a and xboard-sku-b once each (got % and %)', n_a, n_b;
  END IF;
END $$;

\echo '=== F0 verify: partial unique indexes present (pg_indexes + pg_index) ==='
SELECT i.relname AS index_name,
       CASE WHEN ix.indpred IS NULL THEN 'non-partial' ELSE 'PARTIAL' END AS partial,
       pg_get_indexdef(ix.indexrelid) AS indexdef
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = i.relnamespace
WHERE n.nspname = 'public'
  AND i.relname IN (
    'CategoryApplication_one_pending_per_merchant_label',
    'MerchandisingRun_single_running',
    'PromotionCampaign_one_placement_per_product',
    'MerchantEntitlement_one_active_per_merchant'
  )
ORDER BY i.relname;

DO $$
DECLARE
  missing TEXT := '';
  bad TEXT := '';
BEGIN
  -- Presence + genuinely partial (indpred NOT NULL) via pg_index.
  IF NOT EXISTS (SELECT 1 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_namespace n ON n.oid = i.relnamespace
                 WHERE n.nspname = 'public' AND i.relname = 'CategoryApplication_one_pending_per_merchant_label' AND ix.indpred IS NOT NULL)
    THEN missing := missing || ' CategoryApplication_one_pending_per_merchant_label'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_namespace n ON n.oid = i.relnamespace
                 WHERE n.nspname = 'public' AND i.relname = 'MerchandisingRun_single_running' AND ix.indpred IS NOT NULL)
    THEN missing := missing || ' MerchandisingRun_single_running'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_namespace n ON n.oid = i.relnamespace
                 WHERE n.nspname = 'public' AND i.relname = 'PromotionCampaign_one_placement_per_product' AND ix.indpred IS NOT NULL)
    THEN missing := missing || ' PromotionCampaign_one_placement_per_product'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_namespace n ON n.oid = i.relnamespace
                 WHERE n.nspname = 'public' AND i.relname = 'MerchantEntitlement_one_active_per_merchant' AND ix.indpred IS NOT NULL)
    THEN missing := missing || ' MerchantEntitlement_one_active_per_merchant'; END IF;
  IF length(missing) > 0 THEN
    RAISE EXCEPTION 'missing/non-partial unique index:%', missing;
  END IF;
  -- Predicate text sanity via pg_indexes.indexdef (the WHERE clause must exist).
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                 AND indexname = 'CategoryApplication_one_pending_per_merchant_label' AND indexdef ILIKE '%WHERE%')
    THEN bad := bad || ' CategoryApplication_one_pending_per_merchant_label'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                 AND indexname = 'MerchandisingRun_single_running' AND indexdef ILIKE '%WHERE%')
    THEN bad := bad || ' MerchandisingRun_single_running'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                 AND indexname = 'PromotionCampaign_one_placement_per_product' AND indexdef ILIKE '%WHERE%')
    THEN bad := bad || ' PromotionCampaign_one_placement_per_product'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                 AND indexname = 'MerchantEntitlement_one_active_per_merchant' AND indexdef ILIKE '%WHERE%')
    THEN bad := bad || ' MerchantEntitlement_one_active_per_merchant'; END IF;
  IF length(bad) > 0 THEN
    RAISE EXCEPTION 'partial unique index lacks a WHERE predicate:%', bad;
  END IF;
END $$;

\echo '=== F0 verify: Offer external identity unique index (old non-unique dropped) ==='
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'Offer'
  AND indexname IN ('Offer_externalIntegration_externalSku_key', 'Offer_externalIntegration_externalSku_idx')
ORDER BY indexname;

DO $$
DECLARE
  n_unique INTEGER; n_old INTEGER;
BEGIN
  SELECT count(*) INTO n_unique FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'Offer'
      AND indexname = 'Offer_externalIntegration_externalSku_key';
  SELECT count(*) INTO n_old FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'Offer'
      AND indexname = 'Offer_externalIntegration_externalSku_idx';
  IF n_unique <> 1 THEN
    RAISE EXCEPTION 'Offer_externalIntegration_externalSku_key missing';
  END IF;
  IF n_old <> 0 THEN
    RAISE EXCEPTION 'old non-unique Offer_externalIntegration_externalSku_idx was not dropped';
  END IF;
END $$;

\echo '=== F0 verify: merchandising table counts (upgrade must be 0) ==='
SELECT
  (SELECT count(*) FROM "MerchandisingRun")              AS runs,
  (SELECT count(*) FROM "ProductMerchandisingSnapshot")  AS snapshots,
  (SELECT count(*) FROM "PromotionPackage")              AS packages,
  (SELECT count(*) FROM "PromotionCampaign")             AS campaigns,
  (SELECT count(*) FROM "EditorialFeature")              AS editorial_features,
  (SELECT count(*) FROM "MerchantEntitlement")           AS entitlements,
  (SELECT count(*) FROM "ExternalCatalogLink")           AS external_links;

DO $$
DECLARE
  v INTEGER;
BEGIN
  SELECT (SELECT count(*) FROM "MerchandisingRun") +
         (SELECT count(*) FROM "ProductMerchandisingSnapshot") +
         (SELECT count(*) FROM "PromotionPackage") +
         (SELECT count(*) FROM "PromotionCampaign") +
         (SELECT count(*) FROM "EditorialFeature") +
         (SELECT count(*) FROM "MerchantEntitlement") +
         (SELECT count(*) FROM "ExternalCatalogLink") INTO v;
  IF v <> 0 THEN
    RAISE EXCEPTION 'F0 upgrade must create zero merchandising/identity rows, found % total', v;
  END IF;
END $$;

\echo '=== F0 verify: merchandising SystemConfig keys (exactly 8, all legal) ==='
SELECT "key", "value",
  CASE
    WHEN "key" = 'hotWindowDays' AND "value" BETWEEN 1 AND 365 THEN 'ok'
    WHEN "key" = 'hotMinSales' AND "value" BETWEEN 1 AND 100000 THEN 'ok'
    WHEN "key" = 'hotTopPercent' AND "value" BETWEEN 1 AND 100 THEN 'ok'
    WHEN "key" = 'hotRecomputeMinutes' AND "value" BETWEEN 10 AND 1440 THEN 'ok'
    WHEN "key" = 'hotRunTimeoutMinutes' AND "value" BETWEEN 10 AND 1440 THEN 'ok'
    WHEN "key" = 'partnerSpendWindowDays' AND "value" BETWEEN 1 AND 365 THEN 'ok'
    WHEN "key" = 'partnerMinPromotionPoints' AND "value" BETWEEN 1 AND 2000000000 THEN 'ok'
    WHEN "key" = 'partnerEntitlementDays' AND "value" BETWEEN 1 AND 365 THEN 'ok'
    ELSE 'INVALID'
  END AS range
FROM "SystemConfig"
WHERE "key" IN ('hotWindowDays','hotMinSales','hotTopPercent','hotRecomputeMinutes',
                'hotRunTimeoutMinutes','partnerSpendWindowDays',
                'partnerMinPromotionPoints','partnerEntitlementDays')
ORDER BY "key";

DO $$
DECLARE
  n_keys INTEGER; n_invalid INTEGER; n_dup INTEGER;
BEGIN
  SELECT count(*) INTO n_keys FROM "SystemConfig"
    WHERE "key" IN ('hotWindowDays','hotMinSales','hotTopPercent','hotRecomputeMinutes',
                    'hotRunTimeoutMinutes','partnerSpendWindowDays',
                    'partnerMinPromotionPoints','partnerEntitlementDays');
  IF n_keys <> 8 THEN
    RAISE EXCEPTION 'expected exactly 8 merchandising SystemConfig keys, found %', n_keys;
  END IF;
  SELECT count(*) INTO n_invalid FROM "SystemConfig"
    WHERE ("key" = 'hotWindowDays' AND NOT ("value" BETWEEN 1 AND 365))
       OR ("key" = 'hotMinSales' AND NOT ("value" BETWEEN 1 AND 100000))
       OR ("key" = 'hotTopPercent' AND NOT ("value" BETWEEN 1 AND 100))
       OR ("key" = 'hotRecomputeMinutes' AND NOT ("value" BETWEEN 10 AND 1440))
       OR ("key" = 'hotRunTimeoutMinutes' AND NOT ("value" BETWEEN 10 AND 1440))
       OR ("key" = 'partnerSpendWindowDays' AND NOT ("value" BETWEEN 1 AND 365))
       OR ("key" = 'partnerMinPromotionPoints' AND NOT ("value" BETWEEN 1 AND 2000000000))
       OR ("key" = 'partnerEntitlementDays' AND NOT ("value" BETWEEN 1 AND 365));
  IF n_invalid <> 0 THEN
    RAISE EXCEPTION '% merchandising SystemConfig key(s) have out-of-range values', n_invalid;
  END IF;
  SELECT count(*) INTO n_dup FROM (
    SELECT "key" FROM "SystemConfig" GROUP BY "key" HAVING count(*) > 1
  ) d;
  IF n_dup <> 0 THEN
    RAISE EXCEPTION '% duplicate SystemConfig key rows', n_dup;
  END IF;
END $$;

\echo '=== F0 verify: Prisma-invisible constraints present ==='
SELECT conrelid::regclass::text AS table_name, conname, contype
FROM pg_constraint
WHERE conname IN (
  'Product_status_valid_check',
  'ProductCategory_status_valid_check',
  'ProductCategory_code_format_check',
  'ProductCategory_label_length_check',
  'CategoryApplication_status_valid_check',
  'CategoryApplication_description_length_check',
  'ExternalCatalogLink_idempotencyKey_format_check',
  'ExternalCatalogLink_requestHash_format_check',
  'MerchandisingRun_status_valid_check',
  'MerchandisingRun_terminal_state_check',
  'MerchandisingRun_window_order_check',
  'MerchandisingRun_parameter_ranges_check',
  'ProductMerchandisingSnapshot_order_count_non_negative_check',
  'ProductMerchandisingSnapshot_rank_positive_check',
  'ProductMerchandisingSnapshot_population_positive_check',
  'PromotionPackage_placement_valid_check',
  'PromotionPackage_durationDays_range_check',
  'PromotionPackage_pricePoints_positive_check',
  'PromotionPackage_status_valid_check',
  'PromotionCampaign_status_valid_check',
  'PromotionCampaign_requestPayloadHash_format_check',
  'PromotionCampaign_requestIdempotencyKey_format_check',
  'PromotionCampaign_points_balance_check',
  'PromotionCampaign_charge_link_consistency_check',
  'PromotionCampaign_refund_link_consistency_check',
  'PromotionCampaign_adjustment_consistency_check',
  'EditorialFeature_placement_valid_check',
  'EditorialFeature_status_valid_check',
  'EditorialFeature_window_order_check',
  'EditorialFeature_internalReason_length_check',
  'MerchantEntitlement_code_valid_check',
  'MerchantEntitlement_source_valid_check',
  'MerchantEntitlement_status_valid_check',
  'MerchantEntitlement_validity_order_check',
  'MerchantEntitlement_reason_length_check',
  'SystemConfig_merchandising_key_ranges_check'
)
ORDER BY conname;

DO $$
DECLARE
  missing TEXT := '';
  n_expected INTEGER := 36;
  n_found INTEGER;
BEGIN
  SELECT count(*) INTO n_found FROM pg_constraint
    WHERE conname IN (
      'Product_status_valid_check',
      'ProductCategory_status_valid_check',
      'ProductCategory_code_format_check',
      'ProductCategory_label_length_check',
      'CategoryApplication_status_valid_check',
      'CategoryApplication_description_length_check',
      'ExternalCatalogLink_idempotencyKey_format_check',
      'ExternalCatalogLink_requestHash_format_check',
      'MerchandisingRun_status_valid_check',
      'MerchandisingRun_terminal_state_check',
      'MerchandisingRun_window_order_check',
      'MerchandisingRun_parameter_ranges_check',
      'ProductMerchandisingSnapshot_order_count_non_negative_check',
      'ProductMerchandisingSnapshot_rank_positive_check',
      'ProductMerchandisingSnapshot_population_positive_check',
      'PromotionPackage_placement_valid_check',
      'PromotionPackage_durationDays_range_check',
      'PromotionPackage_pricePoints_positive_check',
      'PromotionPackage_status_valid_check',
      'PromotionCampaign_status_valid_check',
      'PromotionCampaign_requestPayloadHash_format_check',
      'PromotionCampaign_requestIdempotencyKey_format_check',
      'PromotionCampaign_points_balance_check',
      'PromotionCampaign_charge_link_consistency_check',
      'PromotionCampaign_refund_link_consistency_check',
      'PromotionCampaign_adjustment_consistency_check',
      'EditorialFeature_placement_valid_check',
      'EditorialFeature_status_valid_check',
      'EditorialFeature_window_order_check',
      'EditorialFeature_internalReason_length_check',
      'MerchantEntitlement_code_valid_check',
      'MerchantEntitlement_source_valid_check',
      'MerchantEntitlement_status_valid_check',
      'MerchantEntitlement_validity_order_check',
      'MerchantEntitlement_reason_length_check',
      'SystemConfig_merchandising_key_ranges_check'
    );
  IF n_found <> n_expected THEN
    RAISE EXCEPTION 'expected % F0 constraint names in pg_constraint, found %', n_expected, n_found;
  END IF;
END $$;

\echo '=== F0 verify: FK onDelete semantics (RESTRICT/CASCADE) ==='
SELECT c.relname AS table_name, con.conname, con.confdeltype
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.contype = 'f' AND n.nspname = 'public'
  AND c.relname IN ('Product','ProductCategory','ExternalCatalogLink','ProductMerchandisingSnapshot',
   'PromotionCampaign','EditorialFeature','MerchantEntitlement')
ORDER BY c.relname, con.conname;

DO $$
DECLARE
  bad TEXT := '';
BEGIN
  -- Product.categoryId -> ProductCategory must be RESTRICT (a = no action,
  -- r = restrict) with CASCADE update.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'Product_categoryId_fkey' AND confdeltype = 'r' AND confupdtype = 'c')
    THEN bad := bad || ' Product_categoryId_fkey(RESTRICT/CASCADE)'; END IF;
  -- ExternalCatalogLink.productId -> Product must be CASCADE on delete.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'ExternalCatalogLink_productId_fkey' AND confdeltype = 'c')
    THEN bad := bad || ' ExternalCatalogLink_productId_fkey(CASCADE)'; END IF;
  -- ProductMerchandisingSnapshot.runId/productId -> CASCADE; categoryId -> RESTRICT.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'ProductMerchandisingSnapshot_runId_fkey' AND confdeltype = 'c')
    THEN bad := bad || ' ProductMerchandisingSnapshot_runId_fkey(CASCADE)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'ProductMerchandisingSnapshot_productId_fkey' AND confdeltype = 'c')
    THEN bad := bad || ' ProductMerchandisingSnapshot_productId_fkey(CASCADE)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'ProductMerchandisingSnapshot_categoryId_fkey' AND confdeltype = 'r')
    THEN bad := bad || ' ProductMerchandisingSnapshot_categoryId_fkey(RESTRICT)'; END IF;
  -- PromotionCampaign -> Product / Merchant / PromotionPackage must be RESTRICT.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'PromotionCampaign_productId_fkey' AND confdeltype = 'r')
    THEN bad := bad || ' PromotionCampaign_productId_fkey(RESTRICT)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'PromotionCampaign_merchantId_fkey' AND confdeltype = 'r')
    THEN bad := bad || ' PromotionCampaign_merchantId_fkey(RESTRICT)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'PromotionCampaign_packageId_fkey' AND confdeltype = 'r')
    THEN bad := bad || ' PromotionCampaign_packageId_fkey(RESTRICT)'; END IF;
  -- EditorialFeature / MerchantEntitlement -> Product / Merchant must be RESTRICT.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'EditorialFeature_productId_fkey' AND confdeltype = 'r')
    THEN bad := bad || ' EditorialFeature_productId_fkey(RESTRICT)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'MerchantEntitlement_merchantId_fkey' AND confdeltype = 'r')
    THEN bad := bad || ' MerchantEntitlement_merchantId_fkey(RESTRICT)'; END IF;
  IF length(bad) > 0 THEN
    RAISE EXCEPTION 'FK onDelete semantics violated:%', bad;
  END IF;
END $$;

\echo '=== F0 verify: complete (all hard assertions passed) ==='
