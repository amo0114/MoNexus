CREATE TABLE "PaymentRuntimeAccount" (
  "id" UUID NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "providerAccountKey" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "identity" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PaymentRuntimeAccount_provider_providerAccountKey_key" ON "PaymentRuntimeAccount"("provider", "providerAccountKey");
CREATE FUNCTION monexus_preserve_payment_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Payment account identity is immutable'; END;
$$;
CREATE TRIGGER payment_account_immutable BEFORE UPDATE OR DELETE ON "PaymentRuntimeAccount" FOR EACH ROW EXECUTE FUNCTION monexus_preserve_payment_account();
ALTER TABLE "RechargeQuote" ADD COLUMN "providerCredentialRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT;
ALTER TABLE "RechargeOrder" ADD COLUMN "providerCredentialRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT;
ALTER TABLE "PaymentAttempt" ADD COLUMN "providerCredentialRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT;
ALTER TABLE "PaymentEvent" ADD COLUMN "providerCredentialRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT;
ALTER TABLE "ReconciliationRun" ADD COLUMN "providerCredentialRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT;
CREATE FUNCTION monexus_preserve_payment_config_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."providerCredentialRevisionId" IS DISTINCT FROM OLD."providerCredentialRevisionId" THEN
    RAISE EXCEPTION 'Payment configuration binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_config_binding_immutable BEFORE UPDATE ON "RechargeQuote" FOR EACH ROW EXECUTE FUNCTION monexus_preserve_payment_config_binding();
CREATE TRIGGER payment_config_binding_immutable BEFORE UPDATE ON "RechargeOrder" FOR EACH ROW EXECUTE FUNCTION monexus_preserve_payment_config_binding();
CREATE TRIGGER payment_config_binding_immutable BEFORE UPDATE ON "PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION monexus_preserve_payment_config_binding();
CREATE TRIGGER payment_config_binding_immutable BEFORE UPDATE ON "ReconciliationRun" FOR EACH ROW EXECUTE FUNCTION monexus_preserve_payment_config_binding();

ALTER TABLE "IntegrationConfigRevision" ADD COLUMN "paymentAccountId" UUID REFERENCES "PaymentRuntimeAccount"("id") ON DELETE RESTRICT;
