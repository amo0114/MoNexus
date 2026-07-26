-- P4b review fix: snapshot the offer's delivery-fields template onto the order
-- at purchase time. The manual-service deliver path previously read the
-- CURRENT offer template, so a merchant editing the template would change the
-- fulfillment contract of already-purchased, not-yet-delivered orders —
-- inconsistent with the order snapshot principle (productNameSnapshot,
-- deliveryModeSnapshot, offerNameSnapshot all freeze at purchase).
-- Purely additive nullable column; NULL = plain-text delivery contract.

ALTER TABLE "Order" ADD COLUMN "deliveryFieldsSnapshot" JSONB;
