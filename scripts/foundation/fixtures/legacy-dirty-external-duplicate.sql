-- FND-CMI-001 F0 — dirty fixture delta: normalized external-SKU duplicate.
--
-- Loaded AFTER legacy-clean.sql into a baseline-head database. Adds two offers
-- whose canonical (provider, sku) identity collides ('xboard-dup-1'), so the
-- migration 3 preflight must fail instead of silently deleting or merging.
--
-- Expected failure (the gate asserts the exact guard):
--   Cannot create Offer external identity unique constraint: normalized
--   duplicate (provider, sku) rows exist.

INSERT INTO "Offer"
  ("productId", "name", "price", "status", "deliveryMode", "stockMode", "stock",
   "isDefault", "externalIntegration", "externalSku", "createdAt")
VALUES
  (1, '重复SKU甲', 11000, 'active', 'manual_service', 'limited', 5, false, 'faka_bridge', 'XBOARD-DUP-1', now()),
  (1, '重复SKU乙', 12000, 'active', 'manual_service', 'limited', 5, false, 'faka_bridge', '  xboard-dup-1 ', now());
