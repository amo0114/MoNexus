-- FND-CMI-001 F0 migration 2/4: legacy category bootstrap + backfill + tighten.
--
-- SPEC-CATALOG-OPS-001 §11.2:
--   1. seed four active categories + one inactive `legacy-unclassified`;
--   2. Product.type exact match -> active category; unknown/empty -> legacy-unclassified
--      (original type preserved; empty type repaired to `待归类` as a snapshot fix,
--      count recorded);
--   3. publishedAt backfill: legacy active/inactive -> createdAt (draft stays null);
--   4. zero-null guard -> Product.categoryId SET NOT NULL (final in F0; no DB
--      default, no trigger, no deferral to a business lane).
--
-- The category seed only runs when a platform actor already exists (legacy
-- upgrade); on a brand-new database (zero users) the application bootstrap seed
-- creates the categories and the backfill is a no-op. No synthetic user is ever
-- inserted.

DO $$
DECLARE
  actor_id    INTEGER;
  n_empty     INTEGER;
  legacy_id   INTEGER;
  n_products  INTEGER;
  n_no_default INTEGER;
BEGIN
  -- Migration audit actor: prefer the lowest-id admin, else any platform user.
  SELECT id INTO actor_id FROM "User" WHERE "role" = 'admin' ORDER BY id ASC LIMIT 1;
  IF actor_id IS NULL THEN
    SELECT id INTO actor_id FROM "User" ORDER BY id ASC LIMIT 1;
  END IF;

  -- Preflight BEFORE ANY mutation: legacy products with no resolvable platform
  -- actor must fail clearly, not silently skip the publishedAt/type backfill.
  SELECT count(*) INTO n_products FROM "Product";
  IF n_products > 0 AND actor_id IS NULL THEN
    RAISE EXCEPTION
      'Cannot backfill Product.categoryId: legacy products exist but no User actor is present.';
  END IF;

  -- Preflight BEFORE ANY mutation: every product must have a default Offer
  -- (SPEC-CATALOG-OPS-001 §11.1). No silent repair.
  SELECT count(*) INTO n_no_default
  FROM "Product" p
  WHERE NOT EXISTS (SELECT 1 FROM "Offer" o WHERE o."productId" = p."id" AND o."isDefault");
  IF n_no_default > 0 THEN
    RAISE EXCEPTION
      'Cannot backfill Product.categoryId: products without a default Offer exist. Reconcile before retrying.';
  END IF;

  -- 3. publishedAt backfill (D-CAT-04). Legacy rows are active/inactive only.
  UPDATE "Product"
  SET "publishedAt" = "createdAt"
  WHERE "publishedAt" IS NULL AND "status" IN ('active', 'inactive');

  -- 2. Empty legacy type snapshot repair (record count).
  UPDATE "Product" SET "type" = '待归类' WHERE btrim("type") = '';
  GET DIAGNOSTICS n_empty = ROW_COUNT;
  RAISE NOTICE 'F0 backfill: repaired % product row(s) with empty legacy type to 待归类', n_empty;

  -- 1. Seed the canonical categories (idempotent by code).
  IF actor_id IS NOT NULL THEN
    INSERT INTO "ProductCategory"
      ("code", "label", "normalizedLabel", "description", "sortOrder", "status",
       "createdByUserId", "updatedByUserId", "createdAt", "updatedAt")
    VALUES
      ('network-node',      '网络节点', '网络节点', NULL, 10, 'active', actor_id, actor_id, now(), now()),
      ('shared-account',    '共享账号', '共享账号', NULL, 20, 'active', actor_id, actor_id, now(), now()),
      ('recharge-card',     '充值卡密', '充值卡密', NULL, 30, 'active', actor_id, actor_id, now(), now()),
      ('invite-code',       '邀请码',   '邀请码',   NULL, 40, 'active', actor_id, actor_id, now(), now()),
      ('legacy-unclassified', '待归类', '待归类', '历史数据中未映射到正式分类的商品归入此类', 0, 'inactive', actor_id, actor_id, now(), now())
    ON CONFLICT ("code") DO NOTHING;
  END IF;

  -- 2. Exact legacy type -> active category (label is the canonical type value).
  UPDATE "Product" p
  SET "categoryId" = c."id"
  FROM "ProductCategory" c
  WHERE c."status" = 'active'
    AND p."categoryId" IS NULL
    AND p."type" = c."label";

  -- 2. Unknown/empty -> legacy-unclassified (type original preserved; empty was
  -- already repaired to 待归类 above).
  SELECT id INTO legacy_id FROM "ProductCategory" WHERE "code" = 'legacy-unclassified';
  IF legacy_id IS NOT NULL THEN
    UPDATE "Product" p
    SET "categoryId" = legacy_id
    WHERE p."categoryId" IS NULL;
  END IF;
END $$;

-- 4. Zero-null guard: any Product without a category blocks tightening. The
-- migration never silently deletes/merges rows; an operator reconciles and
-- reruns.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Product" WHERE "categoryId" IS NULL) THEN
    RAISE EXCEPTION
      'Cannot tighten Product.categoryId: NULL rows remain. Reconcile and rerun deployment.';
  END IF;
END $$;

ALTER TABLE "Product" ALTER COLUMN "categoryId" SET NOT NULL;
