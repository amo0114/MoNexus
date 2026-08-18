-- Break the remaining INSERT/UPDATE ValuePolicy ↔ AssetDefinition identity
-- deadlock: FK KEY SHARE (or a later asset row wait) must not be taken
-- while already holding the governance advisory lock if the asset UPDATE
-- path holds the row exclusive lock and then waits for that advisory lock.
--
-- New order for value_policy_enforce_asset_kinds:
--   1. FOR SHARE referenced assets in stable code order
--   2. pg_advisory_xact_lock(88170001, 1)
--   3. re-read asset state and fail closed
--
-- Additive only. Do not rewrite 20260817180000 or 20260818120000.

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
  PERFORM 1
    FROM "AssetDefinition"
    WHERE code IN (NEW."pointAssetCode", NEW."referenceAssetCode")
    ORDER BY code
    FOR SHARE;

  PERFORM pg_advisory_xact_lock(88170001, 1);

  IF TG_OP = 'INSERT' AND NEW.status IS DISTINCT FROM 'draft' THEN
    IF NEW.status = 'retired' THEN
      RAISE EXCEPTION 'value_policy_retire_requires_active'
        USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'value_policy_insert_must_be_draft'
      USING ERRCODE = '23514';
  END IF;

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
