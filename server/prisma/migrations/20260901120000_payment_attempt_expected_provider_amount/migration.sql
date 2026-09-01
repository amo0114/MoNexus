-- Additive PaymentAttempt.expectedProviderAmountMinor.
-- Quoted amount is written first; persistProviderCreate may CAS-update it to the
-- provider payable after create. Fail closed if any historical row is null or <= 0.

ALTER TABLE "PaymentAttempt"
  ADD COLUMN "expectedProviderAmountMinor" BIGINT;

UPDATE "PaymentAttempt" AS attempt
SET "expectedProviderAmountMinor" = intent."amountMinor"
FROM "PaymentIntent" AS intent
WHERE attempt."paymentIntentId" = intent."id";

DO $$
DECLARE
  violating_count INTEGER;
  diagnostic TEXT;
BEGIN
  SELECT COUNT(*) INTO violating_count
  FROM "PaymentAttempt"
  WHERE "expectedProviderAmountMinor" IS NULL
     OR "expectedProviderAmountMinor" <= 0;

  IF violating_count > 0 THEN
    SELECT string_agg(
      format('id=%s expected=%s', "id", "expectedProviderAmountMinor"),
      '; '
    )
    INTO diagnostic
    FROM (
      SELECT "id", "expectedProviderAmountMinor"
      FROM "PaymentAttempt"
      WHERE "expectedProviderAmountMinor" IS NULL
         OR "expectedProviderAmountMinor" <= 0
      ORDER BY "id"
      LIMIT 20
    ) AS offenders;

    RAISE NOTICE 'FAIL CLOSED PaymentAttempt.expectedProviderAmountMinor: % violating row(s): %',
      violating_count, diagnostic;
    RAISE EXCEPTION
      'FAIL CLOSED: cannot set PaymentAttempt.expectedProviderAmountMinor NOT NULL; % violating row(s): %',
      violating_count, diagnostic;
  END IF;
END $$;

ALTER TABLE "PaymentAttempt"
  ALTER COLUMN "expectedProviderAmountMinor" SET NOT NULL;

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_expectedProviderAmountMinor_check"
    CHECK ("expectedProviderAmountMinor" > 0);
