-- Existing commercial orders stay on v1. No historical identity is inferred.
ALTER TABLE "FakaBridgeTask" ADD COLUMN "accountLinkIdSnapshot" UUID,
ADD COLUMN "clientIdSnapshot" TEXT,
ADD COLUMN "expectedPlanIdSnapshot" TEXT,
ADD COLUMN "instanceIdSnapshot" TEXT,
ADD COLUMN "originSnapshot" TEXT,
ADD COLUMN "paidResetResult" JSONB,
ADD COLUMN "protocolVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "resultVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "xboardUserIdSnapshot" TEXT;

ALTER TABLE "FakaBridgeTask" ADD CONSTRAINT "FakaBridgeTask_protocol_target_check" CHECK (
  "resultVersion" >= 0 AND (
    ("protocolVersion" = 1 AND "accountLinkIdSnapshot" IS NULL AND "clientIdSnapshot" IS NULL
      AND "expectedPlanIdSnapshot" IS NULL AND "instanceIdSnapshot" IS NULL AND "originSnapshot" IS NULL
      AND "xboardUserIdSnapshot" IS NULL AND "paidResetResult" IS NULL AND "resultVersion" = 0)
    OR
    ("protocolVersion" = 2 AND "periodSnapshot" = 'reset_traffic'
      AND "accountLinkIdSnapshot" IS NOT NULL AND "instanceIdSnapshot" IS NOT NULL AND length("instanceIdSnapshot") > 0
      AND "originSnapshot" IS NOT NULL AND length("originSnapshot") > 0
      AND "clientIdSnapshot" IS NOT NULL AND "clientIdSnapshot" ~ '^[a-z][a-z0-9_-]{0,63}$'
      AND "xboardUserIdSnapshot" IS NOT NULL AND "xboardUserIdSnapshot" ~ '^[1-9][0-9]{0,18}$'
      AND "xboardUserIdSnapshot"::numeric <= 9223372036854775807
      AND "expectedPlanIdSnapshot" IS NOT NULL AND "expectedPlanIdSnapshot" ~ '^[1-9][0-9]{0,9}$'
      AND "expectedPlanIdSnapshot"::numeric <= 2147483647)
  )
);

CREATE FUNCTION protect_faka_task_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."protocolVersion" IS DISTINCT FROM OLD."protocolVersion" OR
    (OLD."protocolVersion" = 2 AND ROW(
      NEW."orderId", NEW."requestOrderNo", NEW."emailSnapshot", NEW."skuSnapshot", NEW."periodSnapshot",
      NEW."accountLinkIdSnapshot", NEW."instanceIdSnapshot", NEW."originSnapshot",
      NEW."xboardUserIdSnapshot", NEW."expectedPlanIdSnapshot", NEW."clientIdSnapshot"
    ) IS DISTINCT FROM ROW(
      OLD."orderId", OLD."requestOrderNo", OLD."emailSnapshot", OLD."skuSnapshot", OLD."periodSnapshot",
      OLD."accountLinkIdSnapshot", OLD."instanceIdSnapshot", OLD."originSnapshot",
      OLD."xboardUserIdSnapshot", OLD."expectedPlanIdSnapshot", OLD."clientIdSnapshot"
    )) THEN
    RAISE EXCEPTION 'Faka task protocol and stable target are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "FakaBridgeTask_immutable_identity" BEFORE UPDATE ON "FakaBridgeTask"
FOR EACH ROW EXECUTE FUNCTION protect_faka_task_identity();
