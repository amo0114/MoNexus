-- Merchant settlement income moves to its own PointLog type so member growth,
-- invite eligibility and leaderboards (all `type = 'in'`) stop counting it.
-- Settlement rows are identified by the reason prefix written by settlementAdmin.
UPDATE "PointLog"
SET "type" = 'settlement_in'
WHERE "type" = 'in' AND "reason" LIKE '商家结算入账:%';
