-- 20260818140000 took AssetDefinition FOR SHARE on INSERT *and* UPDATE.
-- Application activate/retire already holds the governance advisory lock
-- before UPDATE, so FOR SHARE-after-advisory recreated the
-- advisory ↔ asset-row cycle against AssetDefinition disable/retire.
--
-- INSERT is the only statement that later takes a new FK KEY SHARE.
-- Take FOR SHARE only on INSERT, before the advisory lock.

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
  IF TG_OP = 'INSERT' THEN
    PERFORM 1
      FROM "AssetDefinition"
      WHERE code IN (NEW."pointAssetCode", NEW."referenceAssetCode")
      ORDER BY code
      FOR SHARE;
  END IF;

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
