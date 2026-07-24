-- PointAccount.balance is the spendable balance.  Manual-service orders reserve
-- their amount in frozenBalance until they are closed or refunded.
ALTER TABLE "PointAccount"
ADD COLUMN "frozenBalance" INTEGER NOT NULL DEFAULT 0;

-- Existing open orders were created before funds were physically reserved.  Do
-- not retroactively debit them in a migration: that could silently make an
-- account negative.  Application code keeps their legacy settlement path until
-- completion, while all newly created manual orders set this flag to true.
ALTER TABLE "Order"
ADD COLUMN "fundsHeld" BOOLEAN NOT NULL DEFAULT false;
