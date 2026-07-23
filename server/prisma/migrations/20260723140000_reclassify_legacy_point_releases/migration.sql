-- Before frozenBalance existed, manual-order rejection and arbitration refund
-- wrote a synthetic `in` audit row even though the account balance was never
-- credited. Those rows must not count as earned points for member tiers.
UPDATE "PointLog"
SET "type" = 'release'
WHERE "type" = 'in'
  AND "orderId" IS NOT NULL
  AND (
    "reason" LIKE '商家拒单退款: #%'
    OR "reason" LIKE '管理员仲裁退款: #%'
  );
