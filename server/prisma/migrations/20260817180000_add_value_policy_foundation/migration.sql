-- SPEC-VALUE-POLICY-P1-001: additive CNY value-policy foundation.
-- Replay-safe on empty and existing databases.
-- MUST NOT insert a production active ValuePolicy. The 100 PTS = 1 CNY
-- candidate ratio is a test fixture only (D-02 is not approved).

CREATE TYPE "AssetKind" AS ENUM ('reward_point', 'fiat');
CREATE TYPE "ValuePolicyStatus" AS ENUM ('draft', 'approved', 'scheduled', 'active', 'retired');
CREATE TYPE "MoneyRoundingMode" AS ENUM ('HALF_EVEN');

CREATE TABLE "AssetDefinition" (
    "code" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "scale" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "AssetDefinition_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "ValuePolicy" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "pointAssetCode" TEXT NOT NULL,
    "referenceAssetCode" TEXT NOT NULL,
    "referenceAtomicPerPointNumerator" BIGINT NOT NULL,
    "referenceAtomicPerPointDenominator" BIGINT NOT NULL,
    "roundingMode" "MoneyRoundingMode" NOT NULL DEFAULT 'HALF_EVEN',
    "status" "ValuePolicyStatus" NOT NULL DEFAULT 'draft',
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValuePolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderPricingSnapshot" (
    "orderId" INTEGER NOT NULL,
    "pointsAssetCode" TEXT NOT NULL,
    "pointsAmountAtomic" BIGINT NOT NULL,
    "valuePolicyId" TEXT NOT NULL,
    "referenceAssetCode" TEXT NOT NULL,
    "referenceAmountAtomic" BIGINT NOT NULL,
    "roundingMode" "MoneyRoundingMode" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPricingSnapshot_pkey" PRIMARY KEY ("orderId")
);

CREATE UNIQUE INDEX "ValuePolicy_version_key" ON "ValuePolicy"("version");
CREATE INDEX "ValuePolicy_status_referenceAssetCode_idx" ON "ValuePolicy"("status", "referenceAssetCode");
CREATE INDEX "ValuePolicy_pointAssetCode_status_idx" ON "ValuePolicy"("pointAssetCode", "status");

-- At most one active policy per point asset on the single-platform scope.
CREATE UNIQUE INDEX "value_policy_one_active_per_point_asset"
ON "ValuePolicy" ("pointAssetCode")
WHERE status = 'active';

ALTER TABLE "ValuePolicy"
    ADD CONSTRAINT "ValuePolicy_pointAssetCode_fkey"
    FOREIGN KEY ("pointAssetCode") REFERENCES "AssetDefinition"("code")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ValuePolicy"
    ADD CONSTRAINT "ValuePolicy_referenceAssetCode_fkey"
    FOREIGN KEY ("referenceAssetCode") REFERENCES "AssetDefinition"("code")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPricingSnapshot"
    ADD CONSTRAINT "OrderPricingSnapshot_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderPricingSnapshot"
    ADD CONSTRAINT "OrderPricingSnapshot_valuePolicyId_fkey"
    FOREIGN KEY ("valuePolicyId") REFERENCES "ValuePolicy"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPricingSnapshot"
    ADD CONSTRAINT "OrderPricingSnapshot_pointsAssetCode_fkey"
    FOREIGN KEY ("pointsAssetCode") REFERENCES "AssetDefinition"("code")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPricingSnapshot"
    ADD CONSTRAINT "OrderPricingSnapshot_referenceAssetCode_fkey"
    FOREIGN KEY ("referenceAssetCode") REFERENCES "AssetDefinition"("code")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ValuePolicy"
    ADD CONSTRAINT "value_policy_numerator_positive"
    CHECK ("referenceAtomicPerPointNumerator" > 0);

ALTER TABLE "ValuePolicy"
    ADD CONSTRAINT "value_policy_denominator_positive"
    CHECK ("referenceAtomicPerPointDenominator" > 0);

-- First-phase production protection: an active policy must be CNY-denominated.
ALTER TABLE "ValuePolicy"
    ADD CONSTRAINT "value_policy_active_reference_must_be_cny"
    CHECK (status <> 'active' OR "referenceAssetCode" = 'CNY');

ALTER TABLE "OrderPricingSnapshot"
    ADD CONSTRAINT "order_pricing_snapshot_points_non_negative"
    CHECK ("pointsAmountAtomic" >= 0);

ALTER TABLE "OrderPricingSnapshot"
    ADD CONSTRAINT "order_pricing_snapshot_reference_non_negative"
    CHECK ("referenceAmountAtomic" >= 0);

-- Frozen identity for first-phase assets.
ALTER TABLE "AssetDefinition"
    ADD CONSTRAINT "asset_definition_rp_identity"
    CHECK (code <> 'RP' OR (kind = 'reward_point' AND scale = 0));

ALTER TABLE "AssetDefinition"
    ADD CONSTRAINT "asset_definition_cny_identity"
    CHECK (code <> 'CNY' OR (kind = 'fiat' AND scale = 2));

-- Point asset must be reward_point; reference asset must be fiat.
-- Active policies may only bind enabled, non-retired assets.
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
  IF TG_OP = 'INSERT' AND NEW.status = 'retired' THEN
    RAISE EXCEPTION 'value_policy_retire_requires_active'
      USING ERRCODE = '23514';
  END IF;

  -- Serialize activation against asset disable/retire via a shared
  -- transaction advisory lock (see asset_definition_protect_row).
  -- This is trigger-mediated mitigation, not a SERIALIZABLE proof:
  -- it does not hold if these triggers are disabled or bypassed.
  IF NEW.status = 'active' THEN
    PERFORM pg_advisory_xact_lock(88170001, 1);
  END IF;

  SELECT kind, enabled, "retiredAt"
    INTO point_kind, point_enabled, point_retired
    FROM "AssetDefinition" WHERE code = NEW."pointAssetCode" FOR UPDATE;
  SELECT kind, enabled, "retiredAt"
    INTO ref_kind, ref_enabled, ref_retired
    FROM "AssetDefinition" WHERE code = NEW."referenceAssetCode" FOR UPDATE;

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

CREATE TRIGGER value_policy_asset_kinds_guard
BEFORE INSERT OR UPDATE ON "ValuePolicy"
FOR EACH ROW EXECUTE FUNCTION value_policy_enforce_asset_kinds();

-- Active: lock economic + audit timestamps. The only allowed mutation is a
-- controlled active -> retired transition with a valid retiredAt.
-- Retired: every business and audit field is immutable.
CREATE OR REPLACE FUNCTION value_policy_protect_row()
RETURNS trigger AS $$
DECLARE
  identity_changed BOOLEAN;
  audit_changed BOOLEAN;
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

  IF NEW.status = 'retired' AND OLD.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'value_policy_retire_requires_active'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'active' AND OLD.status NOT IN ('active', 'scheduled') THEN
    RAISE EXCEPTION 'value_policy_invalid_activation'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'retired' THEN
    IF identity_changed OR audit_changed THEN
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

CREATE TRIGGER value_policy_protect_row_guard
BEFORE UPDATE ON "ValuePolicy"
FOR EACH ROW EXECUTE FUNCTION value_policy_protect_row();

-- Referenced assets cannot change identity. Assets used by an active policy
-- cannot be disabled or retired.
CREATE OR REPLACE FUNCTION asset_definition_protect_row()
RETURNS trigger AS $$
DECLARE
  referenced BOOLEAN;
  active_ref BOOLEAN;
BEGIN
  IF NEW.enabled IS DISTINCT FROM TRUE OR NEW."retiredAt" IS NOT NULL THEN
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

CREATE TRIGGER asset_definition_protect_row_guard
BEFORE UPDATE ON "AssetDefinition"
FOR EACH ROW EXECUTE FUNCTION asset_definition_protect_row();

-- Matches server/src/modules/valuePolicy/money.ts HALF_EVEN conversion.
CREATE OR REPLACE FUNCTION convert_points_to_reference_atomic(
  points_atomic BIGINT,
  numerator BIGINT,
  denominator BIGINT,
  rounding_mode "MoneyRoundingMode"
) RETURNS BIGINT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  product NUMERIC;
  quotient NUMERIC;
  remainder NUMERIC;
BEGIN
  IF points_atomic IS NULL OR points_atomic < 0 THEN
    RAISE EXCEPTION 'pointsAtomic must be non-negative' USING ERRCODE = '23514';
  END IF;
  IF numerator IS NULL OR numerator <= 0 OR denominator IS NULL OR denominator <= 0 THEN
    RAISE EXCEPTION 'ratio must be positive' USING ERRCODE = '23514';
  END IF;
  IF rounding_mode IS DISTINCT FROM 'HALF_EVEN' THEN
    RAISE EXCEPTION 'roundingMode must be HALF_EVEN' USING ERRCODE = '23514';
  END IF;

  product := points_atomic::numeric * numerator::numeric;
  quotient := trunc(product / denominator::numeric);
  remainder := product - (quotient * denominator::numeric);
  IF remainder <> 0 THEN
    IF remainder * 2 > denominator::numeric THEN
      quotient := quotient + 1;
    ELSIF remainder * 2 = denominator::numeric AND mod(quotient, 2) <> 0 THEN
      quotient := quotient + 1;
    END IF;
  END IF;
  IF quotient < 0 THEN
    RAISE EXCEPTION 'reference amount must be non-negative' USING ERRCODE = '23514';
  END IF;
  IF quotient > 9223372036854775807::numeric OR quotient < (-9223372036854775808)::numeric THEN
    RAISE EXCEPTION 'reference_amount_overflows_int8' USING ERRCODE = '22003';
  END IF;
  RETURN quotient::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION order_pricing_snapshot_enforce_consistency()
RETURNS trigger AS $$
DECLARE
  order_price INTEGER;
  policy RECORD;
  expected_reference BIGINT;
BEGIN
  SELECT price INTO order_price FROM "Order" WHERE id = NEW."orderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_pricing_snapshot_order_missing' USING ERRCODE = '23503';
  END IF;
  IF NEW."pointsAmountAtomic" IS DISTINCT FROM order_price::bigint THEN
    RAISE EXCEPTION 'order_pricing_snapshot_points_mismatch' USING ERRCODE = '23514';
  END IF;

  -- Lock the policy row so a concurrent retire either waits or is already visible.
  SELECT * INTO policy FROM "ValuePolicy" WHERE id = NEW."valuePolicyId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_pricing_snapshot_policy_missing' USING ERRCODE = '23503';
  END IF;
  IF policy.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'order_pricing_snapshot_policy_not_active' USING ERRCODE = '23514';
  END IF;
  IF NEW."pointsAssetCode" IS DISTINCT FROM policy."pointAssetCode"
     OR NEW."referenceAssetCode" IS DISTINCT FROM policy."referenceAssetCode" THEN
    RAISE EXCEPTION 'order_pricing_snapshot_asset_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."roundingMode" IS DISTINCT FROM policy."roundingMode" THEN
    RAISE EXCEPTION 'order_pricing_snapshot_rounding_mismatch' USING ERRCODE = '23514';
  END IF;

  expected_reference := convert_points_to_reference_atomic(
    NEW."pointsAmountAtomic",
    policy."referenceAtomicPerPointNumerator",
    policy."referenceAtomicPerPointDenominator",
    policy."roundingMode"
  );
  IF NEW."referenceAmountAtomic" IS DISTINCT FROM expected_reference THEN
    RAISE EXCEPTION 'order_pricing_snapshot_reference_mismatch' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_pricing_snapshot_consistency_guard
BEFORE INSERT ON "OrderPricingSnapshot"
FOR EACH ROW EXECUTE FUNCTION order_pricing_snapshot_enforce_consistency();

CREATE OR REPLACE FUNCTION order_pricing_snapshot_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_pricing_snapshot_immutable'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_pricing_snapshot_immutable_guard
BEFORE UPDATE OR DELETE ON "OrderPricingSnapshot"
FOR EACH ROW EXECUTE FUNCTION order_pricing_snapshot_immutable();

-- Reference data only. No production ValuePolicy rows.
INSERT INTO "AssetDefinition" ("code", "kind", "scale", "enabled", "createdAt")
VALUES
  ('RP', 'reward_point', 0, true, CURRENT_TIMESTAMP),
  ('CNY', 'fiat', 2, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
