ALTER TABLE "FakaBridgeTask" ADD COLUMN "configRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT;
ALTER TABLE "XboardTrafficResetOperation" ADD COLUMN "configRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT;
CREATE FUNCTION monexus_preserve_faka_config_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."configRevisionId" IS DISTINCT FROM OLD."configRevisionId" THEN
    RAISE EXCEPTION 'Fulfillment configuration binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER faka_config_binding_immutable BEFORE UPDATE ON "FakaBridgeTask" FOR EACH ROW EXECUTE FUNCTION monexus_preserve_faka_config_binding();
CREATE TRIGGER reset_config_binding_immutable BEFORE UPDATE ON "XboardTrafficResetOperation" FOR EACH ROW EXECUTE FUNCTION monexus_preserve_faka_config_binding();
