-- P4b: structured delivery content. Purely additive nullable JSON columns —
-- no existing column, constraint or index is touched, so this migration is
-- safely reversible (drop the three columns). Plain-text delivery remains a
-- permanently valid shape: NULL means "no structured content" everywhere.
--
-- Offer.deliveryFields   : merchant-defined template [{key,label,sensitive,placeholder?}]
--                          (public metadata; the VALUES are the sensitive part)
-- InventoryItem/DeliveryRecord.structuredContent
--                        : { fields, values } self-contained snapshot; the
--                          canonical plain text stays authoritative in
--                          "content" (uniqueness / claim SQL unchanged).

ALTER TABLE "Offer" ADD COLUMN "deliveryFields" JSONB;
ALTER TABLE "InventoryItem" ADD COLUMN "structuredContent" JSONB;
ALTER TABLE "DeliveryRecord" ADD COLUMN "structuredContent" JSONB;
