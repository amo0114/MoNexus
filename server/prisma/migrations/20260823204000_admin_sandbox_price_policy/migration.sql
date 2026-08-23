-- Keep administrator sandbox pricing in a lane that can never be selected by
-- a future live provider. The explicit admin_sandbox runtime gate remains the
-- authority for whether this policy can be used.
ALTER TABLE "RechargePricePolicy"
  ADD COLUMN "adminSandbox" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "RechargePricePolicy_currency_version_key";
DROP INDEX "RechargePricePolicy_currency_status_idx";
DROP INDEX "recharge_price_policy_one_active_per_currency";

CREATE UNIQUE INDEX "RechargePricePolicy_currency_adminSandbox_version_key"
  ON "RechargePricePolicy" ("currency", "adminSandbox", "version");

CREATE INDEX "RechargePricePolicy_currency_adminSandbox_status_idx"
  ON "RechargePricePolicy" ("currency", "adminSandbox", "status");

CREATE UNIQUE INDEX "recharge_price_policy_one_active_per_lane"
  ON "RechargePricePolicy" ("currency", "adminSandbox")
  WHERE status = 'active';

-- This policy is non-monetary test data: it can only produce sandboxBalance
-- credits through administrator MFA confirmation. It is intentionally seeded
-- independently from all live price-policy governance.
INSERT INTO "RechargePricePolicy" (
  "id",
  "code",
  "version",
  "currency",
  "adminSandbox",
  "currencyScale",
  "pointsNumerator",
  "pointsDenominator",
  "roundingMode",
  "minAmountMinor",
  "maxAmountMinor",
  "amountStepMinor",
  "dailyLimitMinor",
  "monthlyLimitMinor",
  "limitTimeZone",
  "bonusRuleVersion",
  "status",
  "effectiveAt"
) VALUES (
  'a4d11000-0000-4000-8000-000000000001',
  'admin-sandbox-cny-v1',
  1,
  'CNY',
  true,
  2,
  1,
  1,
  'HALF_EVEN',
  100,
  100000,
  100,
  200000,
  1000000,
  'Asia/Shanghai',
  NULL,
  'active',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "adminSandbox" = true,
  "status" = 'active';

INSERT INTO "RechargeSuggestedAmount" (
  "id", "policyId", "amountMinor", "sortOrder"
) SELECT suggested."id", policy."id", suggested."amountMinor", suggested."sortOrder"
FROM "RechargePricePolicy" AS policy
CROSS JOIN (VALUES
  ('a4d11000-0000-4000-8000-000000000011'::uuid, 1000::bigint, 1),
  ('a4d11000-0000-4000-8000-000000000012'::uuid, 5000::bigint, 2),
  ('a4d11000-0000-4000-8000-000000000013'::uuid, 10000::bigint, 3)
) AS suggested("id", "amountMinor", "sortOrder")
WHERE policy."code" = 'admin-sandbox-cny-v1'
ON CONFLICT ("policyId", "amountMinor") DO NOTHING;
