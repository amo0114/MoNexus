ALTER TABLE "Order" ADD COLUMN "externalFulfillmentProvider" TEXT;

-- Compatibility for existing tasks and for an old application instance during a rolling upgrade.
CREATE FUNCTION monexus_bind_legacy_fulfillment_provider() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Order"
  SET "externalFulfillmentProvider" = 'faka_bridge'
  WHERE id = NEW."orderId" AND "externalFulfillmentProvider" IS NULL;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF to_regclass('"FakaBridgeTask"') IS NOT NULL THEN
    CREATE TRIGGER bind_legacy_fulfillment_provider
    AFTER INSERT ON "FakaBridgeTask"
    FOR EACH ROW EXECUTE FUNCTION monexus_bind_legacy_fulfillment_provider();

    UPDATE "Order" AS o
    SET "externalFulfillmentProvider" = 'faka_bridge'
    FROM "FakaBridgeTask" AS t
    WHERE o.id = t."orderId" AND o."externalFulfillmentProvider" IS NULL;
  END IF;
END
$$;
