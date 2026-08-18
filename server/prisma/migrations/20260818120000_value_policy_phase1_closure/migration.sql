-- SPEC-VALUE-POLICY-P1-001 closure: tighten ValuePolicy lifecycle and
-- remove the AssetDefinition row-lock ↔ advisory-lock deadlock.
-- Additive only. Do NOT rewrite 20260817180000_add_value_policy_foundation.

-- ---------------------------------------------------------------------------
-- 1. Lifecycle CHECKs (empty production ValuePolicy table; fail closed)
-- ---------------------------------------------------------------------------

ALTER TABLE "ValuePolicy"
    ADD CONSTRAINT "value_policy_status_timestamps"
    CHECK (
      (status = 'draft' AND "approvedAt" IS NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL)
      OR (status = 'approved' AND "approvedAt" IS NOT NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL)
      OR (status = 'scheduled' AND "approvedAt" IS NOT NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL)
      OR (status = 'active' AND "approvedAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL)
      OR (status = 'retired' AND "approvedAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL)
    );

ALTER TABLE "ValuePolicy"
    ADD CONSTRAINT "value_policy_time_order"
    CHECK (
      ("approvedAt" IS NULL OR ("createdAt" <= "approvedAt" AND "approvedAt" <= "effectiveAt"))
      AND ("activatedAt" IS NULL OR ("createdAt" <= "activatedAt" AND "activatedAt" >= "effectiveAt"))
      AND ("retiredAt" IS NULL OR (
        "retiredAt" >= "createdAt"
        AND "retiredAt" >= "effectiveAt"
        AND ("activatedAt" IS NULL OR "retiredAt" >= "activatedAt")
      ))
    );

-- ---------------------------------------------------------------------------
-- 2. Policy asset trigger: advisory lock first, then read assets WITHOUT
--    FOR UPDATE so this path cannot wait on AssetDefinition row locks.
--    Asset updates take their own row lock and then the same advisory lock.
--    There is no lock cycle.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION value_policy_enforce_asset_kinds()
RETURNS trigger AS $$
DECLARE
  point_kind "AssetKind";
  point_enabled BOOLEAN;
  point_retired TIMESTAMP(3);
  ref_kind "AssetKind";
  ref_enabled BOOLEAN;
  ref_retired TIMESTAMP(3);
BEGIN
  -- Shared governance lock with asset_definition_protect_row.
  PERFORM pg_advisory_xact_lock(88170001, 1);

  IF TG_OP = 'INSERT' AND NEW.status IS DISTINCT FROM 'draft' THEN
    IF NEW.status = 'retired' THEN
      RAISE EXCEPTION 'value_policy_retire_requires_active'
        USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'value_policy_insert_must_be_draft'
      USING ERRCODE = '23514';
  END IF;

  -- Read the committed-visible asset state. Do not FOR UPDATE: that would
  -- wait behind an AssetDefinition UPDATE that already holds the row lock
  -- and is itself waiting for this advisory lock (40P01).
  SELECT kind, enabled, "retiredAt"
    INTO point_kind, point_enabled, point_retired
    FROM "AssetDefinition" WHERE code = NEW."pointAssetCode";
  SELECT kind, enabled, "retiredAt"
    INTO ref_kind, ref_enabled, ref_retired
    FROM "AssetDefinition" WHERE code = NEW."referenceAssetCode";

  IF point_kind IS NULL THEN
    RAISE EXCEPTION 'value_policy_point_asset_missing'
      USING ERRCODE = '23503';
  END IF;
  IF ref_kind IS NULL THEN
    RAISE EXCEPTION 'value_policy_reference_asset_missing'
      USING ERRCODE = '23503';
  END IF;

  IF point_kind IS DISTINCT FROM 'reward_point' THEN
    RAISE EXCEPTION 'value_policy_point_asset_must_be_reward_point'
      USING ERRCODE = '23514';
  END IF;
  IF ref_kind IS DISTINCT FROM 'fiat' THEN
    RAISE EXCEPTION 'value_policy_reference_asset_must_be_fiat'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'active' THEN
    IF point_enabled IS DISTINCT FROM TRUE OR point_retired IS NOT NULL
       OR ref_enabled IS DISTINCT FROM TRUE OR ref_retired IS NOT NULL THEN
      RAISE EXCEPTION 'value_policy_active_asset_must_be_enabled'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3. Status machine: only draft→approved→scheduled→active→retired.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION value_policy_protect_row()
RETURNS trigger AS $$
DECLARE
  identity_changed BOOLEAN;
  audit_changed BOOLEAN;
  legal_transition BOOLEAN;
BEGIN
  identity_changed :=
       NEW.id IS DISTINCT FROM OLD.id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW."pointAssetCode" IS DISTINCT FROM OLD."pointAssetCode"
    OR NEW."referenceAssetCode" IS DISTINCT FROM OLD."referenceAssetCode"
    OR NEW."referenceAtomicPerPointNumerator" IS DISTINCT FROM OLD."referenceAtomicPerPointNumerator"
    OR NEW."referenceAtomicPerPointDenominator" IS DISTINCT FROM OLD."referenceAtomicPerPointDenominator"
    OR NEW."roundingMode" IS DISTINCT FROM OLD."roundingMode";

  audit_changed :=
       NEW."effectiveAt" IS DISTINCT FROM OLD."effectiveAt"
    OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
    OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt";

  IF OLD.status = 'retired' THEN
    IF identity_changed OR audit_changed
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
      RAISE EXCEPTION 'value_policy_retired_immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  legal_transition :=
       NEW.status IS NOT DISTINCT FROM OLD.status
    OR (OLD.status = 'draft' AND NEW.status = 'approved')
    OR (OLD.status = 'approved' AND NEW.status = 'scheduled')
    OR (OLD.status = 'scheduled' AND NEW.status = 'active')
    OR (OLD.status = 'active' AND NEW.status = 'retired');

  IF NOT legal_transition THEN
    IF NEW.status = 'retired' THEN
      RAISE EXCEPTION 'value_policy_retire_requires_active'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'active' THEN
      RAISE EXCEPTION 'value_policy_invalid_activation'
        USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'value_policy_invalid_status_transition'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'scheduled' AND NEW.status = 'active' THEN
    IF identity_changed
       OR NEW."effectiveAt" IS DISTINCT FROM OLD."effectiveAt"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
      RAISE EXCEPTION 'value_policy_economic_fields_immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."activatedAt" IS NULL THEN
      RAISE EXCEPTION 'value_policy_activate_requires_activated_at'
        USING ERRCODE = '23514';
    END IF;
    IF CURRENT_TIMESTAMP < NEW."effectiveAt" THEN
      RAISE EXCEPTION 'value_policy_effective_at_not_reached'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    IF NEW."approvedAt" IS NULL THEN
      RAISE EXCEPTION 'value_policy_approve_requires_approved_at'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'scheduled' THEN
    IF NEW."approvedAt" IS NULL
       OR NEW."activatedAt" IS NOT NULL
       OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'value_policy_invalid_status_transition'
        USING ERRCODE = '23514';
    END IF;
    IF identity_changed
       OR NEW."effectiveAt" IS DISTINCT FROM OLD."effectiveAt"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'value_policy_economic_fields_immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'retired' THEN
    IF identity_changed
       OR NEW."effectiveAt" IS DISTINCT FROM OLD."effectiveAt"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'value_policy_economic_fields_immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."retiredAt" IS NULL THEN
      RAISE EXCEPTION 'value_policy_retire_requires_retired_at'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."retiredAt" < OLD."effectiveAt"
       OR (OLD."activatedAt" IS NOT NULL AND NEW."retiredAt" < OLD."activatedAt")
       OR NEW."retiredAt" < OLD."createdAt" THEN
      RAISE EXCEPTION 'value_policy_retired_at_invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' THEN
    IF NEW.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'value_policy_invalid_status_transition'
        USING ERRCODE = '23514';
    END IF;
    IF identity_changed OR audit_changed
       OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
      RAISE EXCEPTION 'value_policy_economic_fields_immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 4. Asset trigger: same advisory lock on identity/enabled/retiredAt changes.
--    Re-read policy state after the lock; never take ValuePolicy FOR UPDATE.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asset_definition_protect_row()
RETURNS trigger AS $$
DECLARE
  referenced BOOLEAN;
  active_ref BOOLEAN;
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.scale IS DISTINCT FROM OLD.scale
     OR NEW.enabled IS DISTINCT FROM OLD.enabled
     OR NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
    PERFORM pg_advisory_xact_lock(88170001, 1);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "ValuePolicy"
    WHERE "pointAssetCode" IN (OLD.code, NEW.code)
       OR "referenceAssetCode" IN (OLD.code, NEW.code)
  ) INTO referenced;

  IF referenced AND (
    NEW.code IS DISTINCT FROM OLD.code
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.scale IS DISTINCT FROM OLD.scale
  ) THEN
    RAISE EXCEPTION 'asset_definition_identity_immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "ValuePolicy"
    WHERE status = 'active'
      AND ("pointAssetCode" = OLD.code OR "referenceAssetCode" = OLD.code)
  ) INTO active_ref;

  IF active_ref AND (
    NEW.enabled IS DISTINCT FROM TRUE
    OR NEW."retiredAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'asset_definition_in_use_by_active_policy'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
