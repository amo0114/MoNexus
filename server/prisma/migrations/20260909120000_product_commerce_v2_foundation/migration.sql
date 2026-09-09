-- SPEC-PRODUCT-COMMERCE-002 P1: versioned templates, content fields, platform
-- file ownership, assurance/share persistence, and source-description columns.
-- Additive only: no existing tables/columns/relations are dropped. Historical
-- order snapshots, upload actors, and assurance grants stay null/absent.

-- ── Product content / visibility / template ──────────────────────────────
ALTER TABLE "Product"
  ADD COLUMN "templateKey" TEXT,
  ADD COLUMN "templateVersion" INTEGER,
  ADD COLUMN "attributes" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "details" JSONB NOT NULL DEFAULT '{"highlights":[],"usageInstructions":"","purchaseNotes":"","afterSalesInstructions":"","faq":[]}'::jsonb,
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'members_only',
  ADD COLUMN "contentVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_template_key_version_check"
    CHECK (
      ("templateKey" IS NULL AND "templateVersion" IS NULL)
      OR ("templateKey" IS NOT NULL AND "templateVersion" IS NOT NULL)
    ),
  ADD CONSTRAINT "Product_templateKey_allowed_check"
    CHECK (
      "templateKey" IS NULL
      OR "templateKey" IN (
        'redemption_code',
        'account',
        'digital_file',
        'fixed_content',
        'subscription',
        'manual_service',
        'appointment'
      )
    ),
  ADD CONSTRAINT "Product_visibility_check"
    CHECK ("visibility" IN ('public', 'members_only')),
  ADD CONSTRAINT "Product_contentVersion_positive_check"
    CHECK ("contentVersion" >= 1);

CREATE INDEX "Product_visibility_status_idx" ON "Product"("visibility", "status");
CREATE INDEX "Product_templateKey_templateVersion_idx" ON "Product"("templateKey", "templateVersion");

-- Existing rows stay members_only via the column default. Do not infer a
-- template from category labels. Xboard identity is backfilled only from an
-- explicit ExternalCatalogLink whose every Offer is faka_bridge.

-- ── Offer public attributes + shared-account structured fixed content ────
ALTER TABLE "Offer"
  ADD COLUMN "attributes" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "fixedStructuredContent" JSONB;

ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_fixed_structured_content_check"
    CHECK (
      "fixedStructuredContent" IS NULL
      OR (
        "deliveryMode" = 'instant_fixed'
        AND "fixedContentType" = 'text'
        AND "deliveryFields" IS NULL
        AND "fixedFileId" IS NULL
        AND "fixedContent" IS NOT NULL
      )
    );

-- ── Order product-term snapshot (historical rows remain NULL) ────────────
ALTER TABLE "Order"
  ADD COLUMN "productContentSnapshot" JSONB;

-- ── DeliveryFile platform ownership ──────────────────────────────────────
ALTER TABLE "DeliveryFile"
  ALTER COLUMN "merchantId" DROP NOT NULL;

ALTER TABLE "DeliveryFile"
  ADD COLUMN "uploadedByUserId" INTEGER;

ALTER TABLE "DeliveryFile"
  ADD CONSTRAINT "DeliveryFile_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DeliveryFile"
  ADD CONSTRAINT "DeliveryFile_owner_actor_check"
    CHECK ("merchantId" IS NOT NULL OR "uploadedByUserId" IS NOT NULL);

CREATE INDEX "DeliveryFile_uploadedByUserId_idx" ON "DeliveryFile"("uploadedByUserId");

-- ── ExternalCatalogLink source-description observation ───────────────────
ALTER TABLE "ExternalCatalogLink"
  ADD COLUMN "latestDescriptionHash" TEXT,
  ADD COLUMN "latestDescriptionHtml" TEXT,
  ADD COLUMN "latestDescriptionText" TEXT,
  ADD COLUMN "descriptionCheckedAt" TIMESTAMP(3),
  ADD COLUMN "acceptedDescriptionHash" TEXT;

-- ── ProductShareLink ─────────────────────────────────────────────────────
CREATE TABLE "ProductShareLink" (
    "productId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "attemptToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "url" TEXT,
    "targetUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductShareLink_pkey" PRIMARY KEY ("productId"),
    CONSTRAINT "ProductShareLink_status_check"
      CHECK ("status" IN ('creating', 'ready', 'failed')),
    CONSTRAINT "ProductShareLink_ready_url_check"
      CHECK ("status" <> 'ready' OR "url" IS NOT NULL),
    CONSTRAINT "ProductShareLink_creating_lease_check"
      CHECK (
        "status" <> 'creating'
        OR ("leaseUntil" IS NOT NULL AND "attemptToken" IS NOT NULL)
      )
);

ALTER TABLE "ProductShareLink"
  ADD CONSTRAINT "ProductShareLink_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ProductAssuranceApplication / Grant ──────────────────────────────────
CREATE TABLE "ProductAssuranceApplication" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reviewReason" TEXT,
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAssuranceApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductAssuranceApplication_status_check"
      CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
    CONSTRAINT "ProductAssuranceApplication_reason_len_check"
      CHECK (char_length("reason") BETWEEN 20 AND 1000)
);

CREATE UNIQUE INDEX "ProductAssuranceApplication_one_pending_per_product"
  ON "ProductAssuranceApplication"("productId")
  WHERE "status" = 'pending';

CREATE INDEX "ProductAssuranceApplication_productId_status_idx"
  ON "ProductAssuranceApplication"("productId", "status");
CREATE INDEX "ProductAssuranceApplication_merchantId_status_idx"
  ON "ProductAssuranceApplication"("merchantId", "status");

ALTER TABLE "ProductAssuranceApplication"
  ADD CONSTRAINT "ProductAssuranceApplication_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProductAssuranceApplication_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProductAssuranceApplication_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProductAssuranceGrant" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "applicationId" INTEGER,
    "status" TEXT NOT NULL,
    "policyCode" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "grantedByUserId" INTEGER NOT NULL,
    "grantReason" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" INTEGER,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAssuranceGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductAssuranceGrant_status_check"
      CHECK ("status" IN ('active', 'expired', 'revoked')),
    CONSTRAINT "ProductAssuranceGrant_policy_check"
      CHECK ("policyCode" = 'platform_assistance_v1'),
    CONSTRAINT "ProductAssuranceGrant_validity_check"
      CHECK ("validUntil" > "validFrom"),
    CONSTRAINT "ProductAssuranceGrant_revoke_fields_check"
      CHECK (
        (
          "status" = 'revoked'
          AND "revokedAt" IS NOT NULL
          AND "revokedByUserId" IS NOT NULL
          AND "revokeReason" IS NOT NULL
        )
        OR (
          "status" <> 'revoked'
          AND "revokedAt" IS NULL
          AND "revokedByUserId" IS NULL
          AND "revokeReason" IS NULL
        )
      ),
    CONSTRAINT "ProductAssuranceGrant_grantReason_len_check"
      CHECK (char_length("grantReason") BETWEEN 1 AND 500),
    CONSTRAINT "ProductAssuranceGrant_applicationId_key" UNIQUE ("applicationId")
);

CREATE UNIQUE INDEX "ProductAssuranceGrant_one_active_per_product"
  ON "ProductAssuranceGrant"("productId")
  WHERE "status" = 'active';
CREATE INDEX "ProductAssuranceGrant_productId_status_idx"
  ON "ProductAssuranceGrant"("productId", "status");

ALTER TABLE "ProductAssuranceGrant"
  ADD CONSTRAINT "ProductAssuranceGrant_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProductAssuranceGrant_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "ProductAssuranceApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProductAssuranceGrant_grantedByUserId_fkey"
    FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ProductAssuranceGrant_revokedByUserId_fkey"
    FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Xboard template backfill from explicit catalog identity only ─────────
UPDATE "Product" AS p
SET
  "templateKey" = 'subscription',
  "templateVersion" = 1,
  "attributes" = jsonb_strip_nulls(jsonb_build_object(
    'serviceName', NULLIF(BTRIM(COALESCE(ecl."sourceSnapshot"->>'name', p.name)), ''),
    'serviceScope', NULLIF(BTRIM(COALESCE(p.description, '')), '')
  ))
FROM "ExternalCatalogLink" AS ecl
WHERE ecl."productId" = p.id
  AND ecl.provider = 'faka_bridge'
  AND EXISTS (SELECT 1 FROM "Offer" AS o WHERE o."productId" = p.id)
  AND NOT EXISTS (
    SELECT 1
    FROM "Offer" AS o
    WHERE o."productId" = p.id
      AND o."externalIntegration" IS DISTINCT FROM 'faka_bridge'
  );

UPDATE "Offer" AS o
SET "attributes" = jsonb_strip_nulls(jsonb_build_object(
  'entitlementSummary', NULLIF(BTRIM(o.name), '')
))
FROM "Product" AS p
WHERE o."productId" = p.id
  AND p."templateKey" = 'subscription'
  AND p."templateVersion" = 1;
