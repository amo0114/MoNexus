CREATE TABLE "IntegrationConfigRevision" (
  "id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "settings" JSONB NOT NULL,
  "credentialsCiphertext" TEXT,
  "createdBy" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationConfigRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IntegrationConfigRevision_key_createdAt_idx" ON "IntegrationConfigRevision"("key", "createdAt");
CREATE TABLE "IntegrationConfig" (
  "key" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "draft" JSONB,
  "draftRevisionId" UUID,
  "draftCredentialsCiphertext" TEXT,
  "testedVersion" INTEGER,
  "activeRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT,
  "previousRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "previousEnabled" BOOLEAN NOT NULL DEFAULT true,
  "rollbackAvailable" BOOLEAN NOT NULL DEFAULT false,
  "updatedBy" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntegrationConfig_pkey" PRIMARY KEY ("key")
);
ALTER TABLE "ProductShareLink" ADD COLUMN "configRevisionId" UUID REFERENCES "IntegrationConfigRevision"("id") ON DELETE RESTRICT;
-- Retain immutable snapshots while jobs, payments or share links may reference them.
CREATE FUNCTION monexus_preserve_integration_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'credentialsCiphertext') = (to_jsonb(OLD) - 'credentialsCiphertext') THEN
    RETURN NEW; -- Root-key rotation may rewrap the same credentials without changing the snapshot.
  END IF;
  RAISE EXCEPTION 'Integration configuration revisions are immutable';
END;
$$;
CREATE TRIGGER integration_revision_immutable BEFORE UPDATE OR DELETE ON "IntegrationConfigRevision"
  FOR EACH ROW EXECUTE FUNCTION monexus_preserve_integration_revision();
