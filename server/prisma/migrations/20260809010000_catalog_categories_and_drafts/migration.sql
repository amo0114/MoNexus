-- FND-CMI-001 F0 migration 1/4: catalog taxonomy + draft/published product fields.
--
-- SPEC-CATALOG-OPS-001 §5.1/§5.2/§5.3:
--   * ProductCategory (platform-governed taxonomy)
--   * CategoryApplication (merchant applications)
--   * Product.categoryId (nullable here; backfilled + tightened by
--     20260809020000_catalog_backfill_categories) and Product.publishedAt
--   * Product.status CHECK extended to draft|active|inactive (no legacy rewrite)
--
-- Prisma cannot express CHECK constraints, the code/label length rules or the
-- partial unique "one pending per merchant+normalizedLabel", so they are
-- implemented here in raw SQL.

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "normalizedLabel" TEXT NOT NULL,
    "description" TEXT,
    "iconKey" TEXT,
    "defaultCoverUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByUserId" INTEGER NOT NULL,
    "updatedByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryApplication" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "proposedLabel" TEXT NOT NULL,
    "normalizedLabel" TEXT NOT NULL,
    "proposedCode" TEXT,
    "description" TEXT NOT NULL,
    "exampleProducts" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolution" TEXT,
    "approvedCategoryId" INTEGER,
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryApplication_pkey" PRIMARY KEY ("id")
);

-- AlterTable (Product draft/publish increments; categoryId stays nullable until
-- the 20260809020000 backfill and is tightened to NOT NULL there).
ALTER TABLE "Product" ADD COLUMN "categoryId" INTEGER;
ALTER TABLE "Product" ADD COLUMN "publishedAt" TIMESTAMP(3);

-- Draft-first DB default (D-CAT-02); legacy rows are untouched by backfill.
ALTER TABLE "Product" ALTER COLUMN "status" SET DEFAULT 'draft';

-- Extend the status CHECK to include 'draft' (20260724120000 created the old
-- active|inactive constraint; existing rows are already within the new set).
ALTER TABLE "Product" DROP CONSTRAINT "Product_status_valid_check";
ALTER TABLE "Product" ADD CONSTRAINT "Product_status_valid_check"
  CHECK ("status" IN ('draft', 'active', 'inactive'));

-- CreateIndex (Prisma naming)
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_code_key" ON "ProductCategory"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_normalizedLabel_key" ON "ProductCategory"("normalizedLabel");

-- CreateIndex
CREATE INDEX "ProductCategory_status_sortOrder_id_idx" ON "ProductCategory"("status", "sortOrder", "id");

-- CreateIndex
CREATE INDEX "CategoryApplication_merchantId_status_idx" ON "CategoryApplication"("merchantId", "status");

-- CreateIndex
CREATE INDEX "CategoryApplication_reviewedByUserId_idx" ON "CategoryApplication"("reviewedByUserId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryApplication" ADD CONSTRAINT "CategoryApplication_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryApplication" ADD CONSTRAINT "CategoryApplication_approvedCategoryId_fkey"
  FOREIGN KEY ("approvedCategoryId") REFERENCES "ProductCategory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryApplication" ADD CONSTRAINT "CategoryApplication_reviewedByUserId_fkey"
  FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Raw SQL: ProductCategory constraints ──
ALTER TABLE "ProductCategory"
  ADD CONSTRAINT "ProductCategory_status_valid_check"
    CHECK ("status" IN ('active', 'inactive')),
  ADD CONSTRAINT "ProductCategory_code_format_check"
    CHECK ("code" ~ '^[a-z][a-z0-9_-]{1,63}$'),
  ADD CONSTRAINT "ProductCategory_label_length_check"
    CHECK (char_length("label") BETWEEN 1 AND 50),
  ADD CONSTRAINT "ProductCategory_normalizedLabel_length_check"
    CHECK (char_length("normalizedLabel") BETWEEN 1 AND 50),
  ADD CONSTRAINT "ProductCategory_description_length_check"
    CHECK ("description" IS NULL OR char_length("description") <= 500),
  ADD CONSTRAINT "ProductCategory_iconKey_length_check"
    CHECK ("iconKey" IS NULL OR char_length("iconKey") <= 64);

-- ── Raw SQL: CategoryApplication constraints + partial unique ──
ALTER TABLE "CategoryApplication"
  ADD CONSTRAINT "CategoryApplication_status_valid_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
  ADD CONSTRAINT "CategoryApplication_resolution_valid_check"
    CHECK ("resolution" IS NULL OR "resolution" IN ('create_new', 'map_existing')),
  ADD CONSTRAINT "CategoryApplication_proposedLabel_length_check"
    CHECK (char_length("proposedLabel") BETWEEN 1 AND 50),
  ADD CONSTRAINT "CategoryApplication_normalizedLabel_length_check"
    CHECK (char_length("normalizedLabel") BETWEEN 1 AND 50),
  ADD CONSTRAINT "CategoryApplication_description_length_check"
    CHECK (char_length("description") BETWEEN 20 AND 1000),
  ADD CONSTRAINT "CategoryApplication_exampleProducts_length_check"
    CHECK ("exampleProducts" IS NULL OR char_length("exampleProducts") <= 1000),
  ADD CONSTRAINT "CategoryApplication_reviewReason_length_check"
    CHECK ("reviewReason" IS NULL OR char_length("reviewReason") BETWEEN 1 AND 500);

-- SPEC-CATALOG-OPS-001 §5.2: same merchant + normalizedLabel may have at most
-- one pending application. Partial unique (Prisma-invisible, drift-exempt).
CREATE UNIQUE INDEX "CategoryApplication_one_pending_per_merchant_label"
  ON "CategoryApplication" ("merchantId", "normalizedLabel")
  WHERE "status" = 'pending';
