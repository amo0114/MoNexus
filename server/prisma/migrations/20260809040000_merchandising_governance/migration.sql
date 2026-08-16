-- FND-CMI-001 F0 migration 4/4: merchandising governance foundation.
--
-- SPEC-MERCH-001 §5 (MerchandisingRun / ProductMerchandisingSnapshot /
-- PromotionPackage / PromotionCampaign / EditorialFeature / MerchantEntitlement),
-- §5.4 PointLog charge/refund relations and §12 SystemConfig keys.
--
-- Prisma-unexpressible constraints implemented in raw SQL:
--   * status / time / amount / hash CHECKs
--   * global single-running partial unique
--   * campaign placement collision partial unique
--   * active entitlement partial unique
-- The DESC query index on MerchandisingRun(status, completedAt DESC, id DESC)
-- is expressed in the schema and reproduced here with Prisma's exact name.

-- ── First step: SystemConfig preflight ──
-- Reject any pre-existing merchandising key whose integer value is outside
-- the frozen range BEFORE creating any table, so ON CONFLICT DO NOTHING cannot
-- silently mask an illegal value (no silent repair).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "SystemConfig"
    WHERE ("key" = 'hotWindowDays'            AND NOT ("value" BETWEEN 1 AND 365))
       OR ("key" = 'hotMinSales'              AND NOT ("value" BETWEEN 1 AND 100000))
       OR ("key" = 'hotTopPercent'            AND NOT ("value" BETWEEN 1 AND 100))
       OR ("key" = 'hotRecomputeMinutes'      AND NOT ("value" BETWEEN 10 AND 1440))
       OR ("key" = 'hotRunTimeoutMinutes'     AND NOT ("value" BETWEEN 10 AND 1440))
       OR ("key" = 'partnerSpendWindowDays'   AND NOT ("value" BETWEEN 1 AND 365))
       OR ("key" = 'partnerMinPromotionPoints' AND NOT ("value" BETWEEN 1 AND 2000000000))
       OR ("key" = 'partnerEntitlementDays'   AND NOT ("value" BETWEEN 1 AND 365))
  ) THEN
    RAISE EXCEPTION
      'Cannot seed merchandising SystemConfig keys: a pre-existing key has an out-of-range integer value. Reconcile before retrying.';
  END IF;
END $$;

-- CreateTable
CREATE TABLE "MerchandisingRun" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "minSales" INTEGER NOT NULL,
    "topPercent" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchandisingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMerchandisingSnapshot" (
    "runId" UUID NOT NULL,
    "productId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "effectiveOrderCount" INTEGER NOT NULL,
    "categoryRank" INTEGER NOT NULL,
    "categoryPopulation" INTEGER NOT NULL,
    "isHot" BOOLEAN NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMerchandisingSnapshot_pkey" PRIMARY KEY ("runId","productId")
);

-- CreateTable
CREATE TABLE "PromotionPackage" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "pricePoints" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByUserId" INTEGER NOT NULL,
    "updatedByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionCampaign" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "packageId" INTEGER NOT NULL,
    "packageCodeSnapshot" TEXT NOT NULL,
    "placementSnapshot" TEXT NOT NULL,
    "durationDaysSnapshot" INTEGER NOT NULL,
    "pricePointsSnapshot" INTEGER NOT NULL,
    "requestIdempotencyKey" TEXT NOT NULL,
    "requestPayloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedStartAt" TIMESTAMP(3),
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "chargePointLogId" INTEGER,
    "chargedPoints" INTEGER NOT NULL DEFAULT 0,
    "refundedPoints" INTEGER NOT NULL DEFAULT 0,
    "refundPointLogId" INTEGER,
    "adjustmentDecidedAt" TIMESTAMP(3),
    "adjustmentByUserId" INTEGER,
    "adjustmentReason" TEXT,
    "adjustmentIdempotencyKey" TEXT,
    "adjustmentPayloadHash" TEXT,
    "cancelledByUserId" INTEGER,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditorialFeature" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "placement" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "sortWeight" INTEGER NOT NULL DEFAULT 0,
    "publicReason" TEXT,
    "internalReason" TEXT NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "revokedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditorialFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantEntitlement" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "status" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedByUserId" INTEGER,
    "revokedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchandisingRun_status_completedAt_id_idx"
  ON "MerchandisingRun"("status", "completedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ProductMerchandisingSnapshot_runId_categoryId_isHot_effecti_idx"
  ON "ProductMerchandisingSnapshot"("runId", "categoryId", "isHot", "effectiveOrderCount", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionPackage_code_key" ON "PromotionPackage"("code");

-- CreateIndex
CREATE INDEX "PromotionPackage_placement_status_sortOrder_idx" ON "PromotionPackage"("placement", "status", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionCampaign_chargePointLogId_key" ON "PromotionCampaign"("chargePointLogId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionCampaign_refundPointLogId_key" ON "PromotionCampaign"("refundPointLogId");

-- CreateIndex
CREATE INDEX "PromotionCampaign_productId_status_idx" ON "PromotionCampaign"("productId", "status");

-- CreateIndex
CREATE INDEX "PromotionCampaign_packageId_idx" ON "PromotionCampaign"("packageId");

-- CreateIndex
CREATE INDEX "PromotionCampaign_status_startsAt_idx" ON "PromotionCampaign"("status", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionCampaign_merchantId_requestIdempotencyKey_key"
  ON "PromotionCampaign"("merchantId", "requestIdempotencyKey");

-- CreateIndex
CREATE INDEX "EditorialFeature_placement_status_startsAt_idx" ON "EditorialFeature"("placement", "status", "startsAt");

-- CreateIndex
CREATE INDEX "MerchantEntitlement_merchantId_status_idx" ON "MerchantEntitlement"("merchantId", "status");

-- CreateIndex
CREATE INDEX "MerchantEntitlement_code_status_idx" ON "MerchantEntitlement"("code", "status");

-- AddForeignKey
ALTER TABLE "ProductMerchandisingSnapshot" ADD CONSTRAINT "ProductMerchandisingSnapshot_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "MerchandisingRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMerchandisingSnapshot" ADD CONSTRAINT "ProductMerchandisingSnapshot_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMerchandisingSnapshot" ADD CONSTRAINT "ProductMerchandisingSnapshot_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionPackage" ADD CONSTRAINT "PromotionPackage_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionPackage" ADD CONSTRAINT "PromotionPackage_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCampaign" ADD CONSTRAINT "PromotionCampaign_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCampaign" ADD CONSTRAINT "PromotionCampaign_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCampaign" ADD CONSTRAINT "PromotionCampaign_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "PromotionPackage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCampaign" ADD CONSTRAINT "PromotionCampaign_reviewedByUserId_fkey"
  FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCampaign" ADD CONSTRAINT "PromotionCampaign_chargePointLogId_fkey"
  FOREIGN KEY ("chargePointLogId") REFERENCES "PointLog"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCampaign" ADD CONSTRAINT "PromotionCampaign_refundPointLogId_fkey"
  FOREIGN KEY ("refundPointLogId") REFERENCES "PointLog"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCampaign" ADD CONSTRAINT "PromotionCampaign_adjustmentByUserId_fkey"
  FOREIGN KEY ("adjustmentByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCampaign" ADD CONSTRAINT "PromotionCampaign_cancelledByUserId_fkey"
  FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditorialFeature" ADD CONSTRAINT "EditorialFeature_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditorialFeature" ADD CONSTRAINT "EditorialFeature_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditorialFeature" ADD CONSTRAINT "EditorialFeature_revokedByUserId_fkey"
  FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantEntitlement" ADD CONSTRAINT "MerchantEntitlement_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantEntitlement" ADD CONSTRAINT "MerchantEntitlement_grantedByUserId_fkey"
  FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantEntitlement" ADD CONSTRAINT "MerchantEntitlement_revokedByUserId_fkey"
  FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Raw SQL: MerchandisingRun constraints ──
ALTER TABLE "MerchandisingRun"
  ADD CONSTRAINT "MerchandisingRun_status_valid_check"
    CHECK ("status" IN ('running', 'completed', 'failed')),
  ADD CONSTRAINT "MerchandisingRun_window_order_check"
    CHECK ("windowStart" < "windowEnd"),
  ADD CONSTRAINT "MerchandisingRun_parameter_ranges_check"
    CHECK ("windowDays" BETWEEN 1 AND 365
           AND "minSales" BETWEEN 1 AND 100000
           AND "topPercent" BETWEEN 1 AND 100),
  ADD CONSTRAINT "MerchandisingRun_terminal_state_check"
    CHECK (
      ("status" = 'running'   AND "completedAt" IS NULL AND "failedAt" IS NULL AND "failureCode" IS NULL)
      OR ("status" = 'completed' AND "completedAt" IS NOT NULL AND "failedAt" IS NULL AND "failureCode" IS NULL)
      OR ("status" = 'failed' AND "failedAt" IS NOT NULL AND "failureCode" IS NOT NULL AND "completedAt" IS NULL)
    );

-- Global single-running partial unique (SPEC-MERCH-001 §5.1).
CREATE UNIQUE INDEX "MerchandisingRun_single_running"
  ON "MerchandisingRun" ((1))
  WHERE "status" = 'running';

-- ── Raw SQL: ProductMerchandisingSnapshot counters ──
ALTER TABLE "ProductMerchandisingSnapshot"
  ADD CONSTRAINT "ProductMerchandisingSnapshot_order_count_non_negative_check"
    CHECK ("effectiveOrderCount" >= 0),
  ADD CONSTRAINT "ProductMerchandisingSnapshot_rank_positive_check"
    CHECK ("categoryRank" >= 1),
  ADD CONSTRAINT "ProductMerchandisingSnapshot_population_positive_check"
    CHECK ("categoryPopulation" >= 1);

-- ── Raw SQL: PromotionPackage constraints ──
ALTER TABLE "PromotionPackage"
  ADD CONSTRAINT "PromotionPackage_placement_valid_check"
    CHECK ("placement" IN ('store_home_sponsored', 'category_sponsored')),
  ADD CONSTRAINT "PromotionPackage_durationDays_range_check"
    CHECK ("durationDays" BETWEEN 1 AND 90),
  ADD CONSTRAINT "PromotionPackage_pricePoints_positive_check"
    CHECK ("pricePoints" > 0),
  ADD CONSTRAINT "PromotionPackage_description_length_check"
    CHECK (char_length("description") <= 1000),
  ADD CONSTRAINT "PromotionPackage_status_valid_check"
    CHECK ("status" IN ('active', 'inactive'));

-- ── Raw SQL: PromotionCampaign constraints ──
ALTER TABLE "PromotionCampaign"
  ADD CONSTRAINT "PromotionCampaign_status_valid_check"
    CHECK ("status" IN ('pending_review', 'payment_failed', 'scheduled', 'active',
                        'paused', 'expired', 'rejected', 'cancelled')),
  ADD CONSTRAINT "PromotionCampaign_requestPayloadHash_format_check"
    CHECK ("requestPayloadHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "PromotionCampaign_requestIdempotencyKey_format_check"
    CHECK ("requestIdempotencyKey" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT "PromotionCampaign_points_balance_check"
    CHECK ("chargedPoints" >= 0 AND "refundedPoints" >= 0 AND "refundedPoints" <= "chargedPoints"),
  ADD CONSTRAINT "PromotionCampaign_charge_link_consistency_check"
    CHECK (("chargePointLogId" IS NOT NULL) = ("chargedPoints" > 0)),
  ADD CONSTRAINT "PromotionCampaign_refund_link_consistency_check"
    CHECK (("refundPointLogId" IS NOT NULL) = ("refundedPoints" > 0)),
  ADD CONSTRAINT "PromotionCampaign_adjustment_consistency_check"
    CHECK (
      ("adjustmentDecidedAt" IS NULL AND "adjustmentByUserId" IS NULL
        AND "adjustmentReason" IS NULL AND "adjustmentIdempotencyKey" IS NULL
        AND "adjustmentPayloadHash" IS NULL)
      OR
      ("adjustmentDecidedAt" IS NOT NULL AND "adjustmentByUserId" IS NOT NULL
        AND "adjustmentReason" IS NOT NULL AND "adjustmentIdempotencyKey" IS NOT NULL
        AND "adjustmentPayloadHash" IS NOT NULL
        AND "adjustmentIdempotencyKey" ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND "adjustmentPayloadHash" ~ '^[0-9a-f]{64}$')
    );

-- Same (productId, placementSnapshot) may have at most one scheduled|active|
-- paused campaign (SPEC-MERCH-001 §5.4, D-MERCH-12).
CREATE UNIQUE INDEX "PromotionCampaign_one_placement_per_product"
  ON "PromotionCampaign" ("productId", "placementSnapshot")
  WHERE "status" IN ('scheduled', 'active', 'paused');

-- ── Raw SQL: EditorialFeature constraints ──
ALTER TABLE "EditorialFeature"
  ADD CONSTRAINT "EditorialFeature_placement_valid_check"
    CHECK ("placement" IN ('store_editorial', 'category_editorial')),
  ADD CONSTRAINT "EditorialFeature_status_valid_check"
    CHECK ("status" IN ('scheduled', 'active', 'revoked', 'expired')),
  ADD CONSTRAINT "EditorialFeature_window_order_check"
    CHECK ("startsAt" < "endsAt"),
  ADD CONSTRAINT "EditorialFeature_publicReason_length_check"
    CHECK ("publicReason" IS NULL OR char_length("publicReason") <= 120),
  ADD CONSTRAINT "EditorialFeature_internalReason_length_check"
    CHECK (char_length("internalReason") BETWEEN 1 AND 500);

-- ── Raw SQL: MerchantEntitlement constraints ──
ALTER TABLE "MerchantEntitlement"
  ADD CONSTRAINT "MerchantEntitlement_code_valid_check"
    CHECK ("code" = 'partner'),
  ADD CONSTRAINT "MerchantEntitlement_source_valid_check"
    CHECK ("source" IN ('promotion_spend', 'admin_grant')),
  ADD CONSTRAINT "MerchantEntitlement_status_valid_check"
    CHECK ("status" IN ('active', 'expired', 'revoked')),
  ADD CONSTRAINT "MerchantEntitlement_validity_order_check"
    CHECK ("validFrom" < "validUntil"),
  ADD CONSTRAINT "MerchantEntitlement_reason_length_check"
    CHECK (char_length("reason") <= 500);

-- Same merchant + code may have at most one active entitlement
-- (SPEC-MERCH-001 §5.6).
CREATE UNIQUE INDEX "MerchantEntitlement_one_active_per_merchant"
  ON "MerchantEntitlement" ("merchantId", "code")
  WHERE "status" = 'active';

-- ── Raw SQL: SPEC-MERCH-001 §12 SystemConfig keys ──
INSERT INTO "SystemConfig" ("key", "value", "description", "updatedAt", "updatedBy")
VALUES
  ('hotWindowDays',            30,    '自然热卖统计窗口天数', now(), NULL),
  ('hotMinSales',              5,     '自然热卖最低销量门槛', now(), NULL),
  ('hotTopPercent',            20,    '自然热卖分类前百分之比', now(), NULL),
  ('hotRecomputeMinutes',      60,    '自然热卖重算周期（分钟）', now(), NULL),
  ('hotRunTimeoutMinutes',     30,    '排名 run 超时回收分钟数', now(), NULL),
  ('partnerSpendWindowDays',   90,    '合作伙伴自动授予窗口天数', now(), NULL),
  ('partnerMinPromotionPoints',1000,  '合作伙伴自动授予净推广消费积分阈值', now(), NULL),
  ('partnerEntitlementDays',   30,    '合作伙伴权益授予天数', now(), NULL)
ON CONFLICT ("key") DO NOTHING;

-- Database range guard for the merchandising keys (protects future writes
-- against out-of-range values from any code path).
ALTER TABLE "SystemConfig"
  ADD CONSTRAINT "SystemConfig_merchandising_key_ranges_check"
    CHECK (
      ("key" <> 'hotWindowDays' OR "value" BETWEEN 1 AND 365)
      AND ("key" <> 'hotMinSales' OR "value" BETWEEN 1 AND 100000)
      AND ("key" <> 'hotTopPercent' OR "value" BETWEEN 1 AND 100)
      AND ("key" <> 'hotRecomputeMinutes' OR "value" BETWEEN 10 AND 1440)
      AND ("key" <> 'hotRunTimeoutMinutes' OR "value" BETWEEN 10 AND 1440)
      AND ("key" <> 'partnerSpendWindowDays' OR "value" BETWEEN 1 AND 365)
      AND ("key" <> 'partnerMinPromotionPoints' OR "value" BETWEEN 1 AND 2000000000)
      AND ("key" <> 'partnerEntitlementDays' OR "value" BETWEEN 1 AND 365)
    );
