-- Preserve the product identity that a buyer actually purchased.  Columns
-- remain nullable so historical orders created before this migration continue
-- to render through the legacy Product relation fallback.
ALTER TABLE "Order"
  ADD COLUMN "productNameSnapshot" TEXT,
  ADD COLUMN "productTypeSnapshot" TEXT,
  ADD COLUMN "productIconSnapshot" TEXT,
  ADD COLUMN "productImageUrlSnapshot" TEXT;
