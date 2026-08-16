-- FND-CMI-001 F0 — read-only legacy preflight report (SPEC-CATALOG-OPS-001
-- §11.1). Run via dbguard.sh psql against a disposable F0 database at the
-- frozen PRE-F0 migration head (or post-F0). Read-only: it never mutates
-- data. Output is masked counts — no delivery content, no secrets.

\echo '=== F0 preflight: Product.type distribution ==='
SELECT "type", count(*) AS n
FROM "Product"
GROUP BY "type"
ORDER BY n DESC, "type";

\echo '=== F0 preflight: null/empty type count ==='
SELECT count(*) AS null_or_empty_type
FROM "Product"
WHERE "type" IS NULL OR btrim("type") = '';

\echo '=== F0 preflight: normalized external-SKU duplicate groups ==='
SELECT "externalIntegration", lower(btrim("externalSku")) AS canonical_sku, count(*) AS n
FROM "Offer"
WHERE "externalIntegration" IS NOT NULL AND "externalSku" IS NOT NULL
GROUP BY "externalIntegration", lower(btrim("externalSku"))
HAVING count(*) > 1;

\echo '=== F0 preflight: products without a default Offer ==='
SELECT count(*) AS products_without_default_offer
FROM "Product" p
WHERE NOT EXISTS (SELECT 1 FROM "Offer" o WHERE o."productId" = p."id" AND o."isDefault");

\echo '=== F0 preflight: products with multiple default Offers ==='
SELECT count(*) AS products_with_multiple_defaults
FROM (
  SELECT "productId" FROM "Offer" WHERE "isDefault"
  GROUP BY "productId" HAVING count(*) > 1
) d;

\echo '=== F0 preflight: default Offer projection drift (vs Product columns) ==='
SELECT count(*) AS projection_drift_rows
FROM "Product" p
JOIN "Offer" o ON o."productId" = p."id" AND o."isDefault"
WHERE o."price" <> p."price"
   OR o."deliveryMode" <> p."deliveryMode"
   OR o."stockMode" <> p."stockMode"
   OR o."stock" <> p."stock";

\echo '=== F0 preflight: imageUrl/images canonical cover mismatch ==='
-- Canonical cover contract: images[0] must strictly equal imageUrl
-- (SPEC-CATALOG-OPS-001 §6.1 readiness item 3). IS DISTINCT FROM also
-- catches imageUrl pointing at a non-first image.
SELECT count(*) AS image_mismatch_rows
FROM "Product"
WHERE "imageUrl" IS DISTINCT FROM ("images")[1];

\echo '=== F0 preflight: active products without a canonical cover ==='
SELECT count(*) AS active_without_image
FROM "Product"
WHERE "status" = 'active' AND ("imageUrl" IS NULL OR "imageUrl" = '');
