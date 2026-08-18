-- SPEC-VALUE-POLICY-ACTIVATION-CONTROLS-001
-- Additive maker-checker actors, immutable decision evidence, idempotent
-- governance commands, and append-only lifecycle events.

ALTER TABLE "ValuePolicy"
  ADD COLUMN "createdByUserId" INTEGER,
  ADD COLUMN "approvedByUserId" INTEGER,
  ADD COLUMN "scheduledByUserId" INTEGER,
  ADD COLUMN "activatedByUserId" INTEGER,
  ADD COLUMN "retiredByUserId" INTEGER,
  ADD COLUMN "d02DecisionRecordRef" TEXT,
  ADD COLUMN "d02DecisionRecordSha256" CHAR(64),
  ADD COLUMN "d03DecisionRecordRef" TEXT,
  ADD COLUMN "d03DecisionRecordSha256" CHAR(64),
  ADD COLUMN "disclosureVersion" TEXT;

-- Earlier Phase 1 code deliberately created no production policy. Refuse an
-- ambiguous backfill instead of inventing actors or approval evidence.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ValuePolicy") THEN
    RAISE EXCEPTION 'value_policy_activation_controls_require_empty_policy_table'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "ValuePolicy"
  ALTER COLUMN "createdByUserId" SET NOT NULL,
  ALTER COLUMN "d02DecisionRecordRef" SET NOT NULL,
  ALTER COLUMN "d02DecisionRecordSha256" SET NOT NULL,
  ALTER COLUMN "d03DecisionRecordRef" SET NOT NULL,
  ALTER COLUMN "d03DecisionRecordSha256" SET NOT NULL,
  ALTER COLUMN "disclosureVersion" SET NOT NULL;

ALTER TABLE "ValuePolicy"
  ADD CONSTRAINT "ValuePolicy_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ValuePolicy_approvedByUserId_fkey"
    FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ValuePolicy_scheduledByUserId_fkey"
    FOREIGN KEY ("scheduledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ValuePolicy_activatedByUserId_fkey"
    FOREIGN KEY ("activatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ValuePolicy_retiredByUserId_fkey"
    FOREIGN KEY ("retiredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "value_policy_maker_checker"
    CHECK ("approvedByUserId" IS NULL OR "createdByUserId" <> "approvedByUserId"),
  ADD CONSTRAINT "value_policy_decision_evidence"
    CHECK (
      length("d02DecisionRecordRef") BETWEEN 1 AND 200
      AND "d02DecisionRecordSha256" ~ '^[0-9a-f]{64}$'
      AND length("d03DecisionRecordRef") BETWEEN 1 AND 200
      AND "d03DecisionRecordSha256" ~ '^[0-9a-f]{64}$'
      AND length("disclosureVersion") BETWEEN 1 AND 100
    );

ALTER TABLE "ValuePolicy" DROP CONSTRAINT "value_policy_status_timestamps";
ALTER TABLE "ValuePolicy"
  ADD CONSTRAINT "value_policy_status_timestamps"
  CHECK (
    (status = 'draft'
      AND "approvedAt" IS NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL
      AND "approvedByUserId" IS NULL AND "scheduledByUserId" IS NULL
      AND "activatedByUserId" IS NULL AND "retiredByUserId" IS NULL)
    OR (status = 'approved'
      AND "approvedAt" IS NOT NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL
      AND "approvedByUserId" IS NOT NULL AND "scheduledByUserId" IS NULL
      AND "activatedByUserId" IS NULL AND "retiredByUserId" IS NULL)
    OR (status = 'scheduled'
      AND "approvedAt" IS NOT NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL
      AND "approvedByUserId" IS NOT NULL AND "scheduledByUserId" IS NOT NULL
      AND "activatedByUserId" IS NULL AND "retiredByUserId" IS NULL)
    OR (status = 'active'
      AND "approvedAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL
      AND "approvedByUserId" IS NOT NULL AND "scheduledByUserId" IS NOT NULL
      AND "activatedByUserId" IS NOT NULL AND "retiredByUserId" IS NULL)
    OR (status = 'retired'
      AND "approvedAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL
      AND "approvedByUserId" IS NOT NULL AND "scheduledByUserId" IS NOT NULL
      AND "activatedByUserId" IS NOT NULL AND "retiredByUserId" IS NOT NULL)
  );

CREATE INDEX "ValuePolicy_createdByUserId_idx" ON "ValuePolicy"("createdByUserId");
CREATE INDEX "ValuePolicy_approvedByUserId_idx" ON "ValuePolicy"("approvedByUserId");
CREATE INDEX "ValuePolicy_activatedByUserId_idx" ON "ValuePolicy"("activatedByUserId");

CREATE TABLE "ValuePolicyGovernanceCommand" (
  "id" SERIAL NOT NULL,
  "valuePolicyId" TEXT NOT NULL,
  "actorUserId" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "action" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ValuePolicyGovernanceCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "value_policy_command_key_format" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "value_policy_command_payload_hash" CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "value_policy_command_action" CHECK ("action" IN ('create', 'approve', 'schedule', 'activate', 'retire')),
  CONSTRAINT "ValuePolicyGovernanceCommand_valuePolicyId_fkey"
    FOREIGN KEY ("valuePolicyId") REFERENCES "ValuePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ValuePolicyGovernanceCommand_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ValuePolicyGovernanceCommand_actorUserId_idempotencyKey_key"
  ON "ValuePolicyGovernanceCommand"("actorUserId", "idempotencyKey");
CREATE INDEX "ValuePolicyGovernanceCommand_valuePolicyId_createdAt_idx"
  ON "ValuePolicyGovernanceCommand"("valuePolicyId", "createdAt");

CREATE TABLE "ValuePolicyGovernanceEvent" (
  "id" BIGSERIAL NOT NULL,
  "valuePolicyId" TEXT NOT NULL,
  "commandId" INTEGER NOT NULL,
  "actorUserId" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "fromStatus" "ValuePolicyStatus",
  "toStatus" "ValuePolicyStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ValuePolicyGovernanceEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "value_policy_event_action" CHECK ("action" IN ('create', 'approve', 'schedule', 'activate', 'retire')),
  CONSTRAINT "value_policy_event_reason" CHECK (length("reason") BETWEEN 8 AND 500),
  CONSTRAINT "ValuePolicyGovernanceEvent_valuePolicyId_fkey"
    FOREIGN KEY ("valuePolicyId") REFERENCES "ValuePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ValuePolicyGovernanceEvent_commandId_fkey"
    FOREIGN KEY ("commandId") REFERENCES "ValuePolicyGovernanceCommand"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ValuePolicyGovernanceEvent_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ValuePolicyGovernanceEvent_commandId_key"
  ON "ValuePolicyGovernanceEvent"("commandId");
CREATE INDEX "ValuePolicyGovernanceEvent_valuePolicyId_occurredAt_id_idx"
  ON "ValuePolicyGovernanceEvent"("valuePolicyId", "occurredAt", "id");
CREATE INDEX "ValuePolicyGovernanceEvent_actorUserId_occurredAt_idx"
  ON "ValuePolicyGovernanceEvent"("actorUserId", "occurredAt");

CREATE OR REPLACE FUNCTION value_policy_governance_event_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'value_policy_governance_event_immutable'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ValuePolicyGovernanceEvent_append_only"
BEFORE UPDATE OR DELETE ON "ValuePolicyGovernanceEvent"
FOR EACH ROW EXECUTE FUNCTION value_policy_governance_event_append_only();

CREATE OR REPLACE FUNCTION value_policy_protect_row()
RETURNS trigger AS $$
DECLARE
  identity_changed BOOLEAN;
  base_audit_changed BOOLEAN;
BEGIN
  identity_changed :=
       NEW.id IS DISTINCT FROM OLD.id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW."pointAssetCode" IS DISTINCT FROM OLD."pointAssetCode"
    OR NEW."referenceAssetCode" IS DISTINCT FROM OLD."referenceAssetCode"
    OR NEW."referenceAtomicPerPointNumerator" IS DISTINCT FROM OLD."referenceAtomicPerPointNumerator"
    OR NEW."referenceAtomicPerPointDenominator" IS DISTINCT FROM OLD."referenceAtomicPerPointDenominator"
    OR NEW."roundingMode" IS DISTINCT FROM OLD."roundingMode"
    OR NEW."effectiveAt" IS DISTINCT FROM OLD."effectiveAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
    OR NEW."d02DecisionRecordRef" IS DISTINCT FROM OLD."d02DecisionRecordRef"
    OR NEW."d02DecisionRecordSha256" IS DISTINCT FROM OLD."d02DecisionRecordSha256"
    OR NEW."d03DecisionRecordRef" IS DISTINCT FROM OLD."d03DecisionRecordRef"
    OR NEW."d03DecisionRecordSha256" IS DISTINCT FROM OLD."d03DecisionRecordSha256"
    OR NEW."disclosureVersion" IS DISTINCT FROM OLD."disclosureVersion";

  base_audit_changed :=
       NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
    OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
    OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt"
    OR NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId"
    OR NEW."scheduledByUserId" IS DISTINCT FROM OLD."scheduledByUserId"
    OR NEW."activatedByUserId" IS DISTINCT FROM OLD."activatedByUserId"
    OR NEW."retiredByUserId" IS DISTINCT FROM OLD."retiredByUserId";

  IF OLD.status = 'retired' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'value_policy_retired_immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    IF identity_changed OR base_audit_changed THEN
      RAISE EXCEPTION 'value_policy_economic_fields_immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    IF identity_changed
       OR NEW."approvedAt" IS NULL
       OR NEW."approvedByUserId" IS NULL
       OR NEW."approvedByUserId" = OLD."createdByUserId"
       OR NEW."scheduledByUserId" IS NOT NULL
       OR NEW."activatedByUserId" IS NOT NULL
       OR NEW."retiredByUserId" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL
       OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'value_policy_approve_requires_independent_actor' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'scheduled' THEN
    IF identity_changed
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId"
       OR NEW."scheduledByUserId" IS NULL
       OR NEW."activatedByUserId" IS NOT NULL
       OR NEW."retiredByUserId" IS NOT NULL
       OR NEW."activatedAt" IS NOT NULL
       OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'value_policy_invalid_status_transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'scheduled' AND NEW.status = 'active' THEN
    IF identity_changed
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId"
       OR NEW."scheduledByUserId" IS DISTINCT FROM OLD."scheduledByUserId"
       OR NEW."activatedByUserId" IS NULL
       OR NEW."retiredByUserId" IS NOT NULL
       OR NEW."activatedAt" IS NULL
       OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'value_policy_invalid_activation' USING ERRCODE = '23514';
    END IF;
    IF CURRENT_TIMESTAMP < NEW."effectiveAt" THEN
      RAISE EXCEPTION 'value_policy_effective_at_not_reached' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'retired' THEN
    IF identity_changed
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId"
       OR NEW."scheduledByUserId" IS DISTINCT FROM OLD."scheduledByUserId"
       OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
       OR NEW."activatedByUserId" IS DISTINCT FROM OLD."activatedByUserId"
       OR NEW."retiredByUserId" IS NULL
       OR NEW."retiredAt" IS NULL THEN
      RAISE EXCEPTION 'value_policy_retire_requires_active' USING ERRCODE = '23514';
    END IF;
    IF NEW."retiredAt" < OLD."effectiveAt"
       OR NEW."retiredAt" < OLD."activatedAt"
       OR NEW."retiredAt" < OLD."createdAt" THEN
      RAISE EXCEPTION 'value_policy_retired_at_invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'retired' THEN
    RAISE EXCEPTION 'value_policy_retire_requires_active' USING ERRCODE = '23514';
  ELSIF NEW.status = 'active' THEN
    RAISE EXCEPTION 'value_policy_invalid_activation' USING ERRCODE = '23514';
  ELSE
    RAISE EXCEPTION 'value_policy_invalid_status_transition' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;
