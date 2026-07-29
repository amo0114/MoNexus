-- P7b autoProvision and FakaBridge externalIntegration are mutually exclusive
-- on a single Offer (both create automatic fulfillment side-effects).
ALTER TABLE "Offer" DROP CONSTRAINT IF EXISTS "Offer_auto_provision_faka_mutex_check";
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_auto_provision_faka_mutex_check" CHECK (
  NOT ("autoProvision" = true AND "externalIntegration" = 'faka_bridge')
);
