-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
ALTER COLUMN "status" SET DEFAULT 'active';

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "currentApplicationVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lifecycleVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "commercialRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "batchId" UUID;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "orderNo" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

-- AlterTable
ALTER TABLE "DeliveryRecord" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

-- AlterTable
ALTER TABLE "SettlementBatch" ADD COLUMN     "batchNo" TEXT;

-- AlterTable
ALTER TABLE "OrderAfterSalesCase" ADD COLUMN     "caseNo" TEXT;

-- AlterTable
ALTER TABLE "AdminLog" ADD COLUMN     "actionCode" TEXT,
ADD COLUMN     "detailSafe" JSONB,
ADD COLUMN     "detailSchemaVersion" INTEGER,
ADD COLUMN     "requestId" TEXT;

-- AlterTable
ALTER TABLE "RechargeRefund" ADD COLUMN     "reviewDecisionCode" TEXT,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedByUserId" INTEGER;

-- CreateTable
CREATE TABLE "AdminCommandReceipt" (
    "id" TEXT NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "resultSafe" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "AdminCommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountBan" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT NOT NULL,
    "reason" TEXT,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdByUserId" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'admin',
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" INTEGER,
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "AccountBan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuthorization" (
    "userId" INTEGER NOT NULL,
    "tier" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "AdminAuthorization_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AdminPermissionGrant" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "permissionCode" TEXT NOT NULL,
    "grantedBy" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "revokedAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,

    CONSTRAINT "AdminPermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeRefundReviewAction" (
    "id" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "expectedReviewVersion" INTEGER NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "evidenceRef" TEXT,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "RechargeRefundReviewAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantApplicationRevision" (
    "id" UUID NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "submittedByUserId" INTEGER,
    "isLegacyBaseline" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MerchantApplicationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantLifecycleEvent" (
    "evidenceRef" TEXT,
    "id" UUID NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "applicationRevisionId" UUID,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "actorUserId" INTEGER,
    "requestKey" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "versionAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "MerchantLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryBatch" (
    "id" UUID NOT NULL,
    "productId" INTEGER NOT NULL,
    "offerId" INTEGER NOT NULL,
    "merchantId" INTEGER,
    "actorUserId" INTEGER,
    "importedCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "InventoryBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferCommercialRevision" (
    "id" UUID NOT NULL,
    "offerId" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorUserId" INTEGER,
    "sourceRef" TEXT,
    "reasonCode" TEXT NOT NULL,
    "beforeSafe" JSONB,
    "afterSafe" JSONB NOT NULL,
    "changedFields" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "OfferCommercialRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminExportJob" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "requestedByUserId" INTEGER NOT NULL,
    "sessionId" UUID NOT NULL,
    "mfaVersion" INTEGER NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "filters" JSONB NOT NULL,
    "columnVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT,
    "snapshotAt" TIMESTAMP(3),
    "rowCount" INTEGER,
    "byteSize" INTEGER,
    "sha256" TEXT,
    "providerConfigId" INTEGER,
    "objectKey" TEXT,
    "leaseToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AdminExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminExportRow" (
    "jobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "payloadSafe" JSONB NOT NULL,

    CONSTRAINT "AdminExportRow_pkey" PRIMARY KEY ("jobId","rowNumber")
);

-- CreateTable
CREATE TABLE "WalletIntegrityScanRun" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "upperUserId" INTEGER NOT NULL,
    "cursorUserId" INTEGER NOT NULL DEFAULT 0,
    "scannedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,

    CONSTRAINT "WalletIntegrityScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletIntegrityIssue" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "accountValue" INTEGER NOT NULL,
    "sourceValue" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "lastVerifiedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "WalletIntegrityIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountBan_userId_createdAt_id_idx" ON "AccountBan"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AccountBan_releasedAt_expiresAt_idx" ON "AccountBan"("releasedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "AdminPermissionGrant_userId_revokedAt_idx" ON "AdminPermissionGrant"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeRefundReviewAction_requestKey_key" ON "RechargeRefundReviewAction"("requestKey");

-- CreateIndex
CREATE INDEX "RechargeRefundReviewAction_refundId_createdAt_id_idx" ON "RechargeRefundReviewAction"("refundId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantApplicationRevision_merchantId_version_key" ON "MerchantApplicationRevision"("merchantId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantLifecycleEvent_requestKey_key" ON "MerchantLifecycleEvent"("requestKey");

-- CreateIndex
CREATE INDEX "MerchantLifecycleEvent_merchantId_createdAt_id_idx" ON "MerchantLifecycleEvent"("merchantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "InventoryBatch_productId_createdAt_id_idx" ON "InventoryBatch"("productId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OfferCommercialRevision_offerId_revision_key" ON "OfferCommercialRevision"("offerId", "revision");

-- CreateIndex
CREATE INDEX "AdminExportJob_status_nextAttemptAt_idx" ON "AdminExportJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AdminExportJob_requestedByUserId_createdAt_id_idx" ON "AdminExportJob"("requestedByUserId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AdminExportJob_requestedByUserId_requestKey_key" ON "AdminExportJob"("requestedByUserId", "requestKey");

-- CreateIndex
CREATE INDEX "WalletIntegrityScanRun_startedAt_id_idx" ON "WalletIntegrityScanRun"("startedAt", "id");

-- CreateIndex
CREATE INDEX "WalletIntegrityIssue_lastSeenAt_id_idx" ON "WalletIntegrityIssue"("lastSeenAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WalletIntegrityIssue_userId_type_key" ON "WalletIntegrityIssue"("userId", "type");

-- CreateIndex
-- Built concurrently by scripts/migrate-deploy.mjs after Prisma expansion.

-- CreateIndex
-- Built concurrently by scripts/migrate-deploy.mjs after Prisma expansion.

-- CreateIndex
-- Built concurrently by scripts/migrate-deploy.mjs after Prisma expansion.

-- CreateIndex
-- Built concurrently by scripts/migrate-deploy.mjs after Prisma expansion.

-- CreateIndex
-- Built concurrently by scripts/migrate-deploy.mjs after Prisma expansion.

-- CreateIndex
-- Built concurrently by scripts/migrate-deploy.mjs after Prisma expansion.

-- CreateIndex
-- Built concurrently by scripts/migrate-deploy.mjs after Prisma expansion.

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRefund" ADD CONSTRAINT "RechargeRefund_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminCommandReceipt" ADD CONSTRAINT "AdminCommandReceipt_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBan" ADD CONSTRAINT "AccountBan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBan" ADD CONSTRAINT "AccountBan_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBan" ADD CONSTRAINT "AccountBan_releasedByUserId_fkey" FOREIGN KEY ("releasedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuthorization" ADD CONSTRAINT "AdminAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminPermissionGrant" ADD CONSTRAINT "AdminPermissionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminPermissionGrant" ADD CONSTRAINT "AdminPermissionGrant_grantedBy_fkey" FOREIGN KEY ("grantedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRefundReviewAction" ADD CONSTRAINT "RechargeRefundReviewAction_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "RechargeRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRefundReviewAction" ADD CONSTRAINT "RechargeRefundReviewAction_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantApplicationRevision" ADD CONSTRAINT "MerchantApplicationRevision_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantApplicationRevision" ADD CONSTRAINT "MerchantApplicationRevision_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantLifecycleEvent" ADD CONSTRAINT "MerchantLifecycleEvent_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantLifecycleEvent" ADD CONSTRAINT "MerchantLifecycleEvent_applicationRevisionId_fkey" FOREIGN KEY ("applicationRevisionId") REFERENCES "MerchantApplicationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantLifecycleEvent" ADD CONSTRAINT "MerchantLifecycleEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Offer revision evidence survives physical deletion of an unused offer.

-- AddForeignKey
ALTER TABLE "OfferCommercialRevision" ADD CONSTRAINT "OfferCommercialRevision_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminExportJob" ADD CONSTRAINT "AdminExportJob_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminExportRow" ADD CONSTRAINT "AdminExportRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AdminExportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletIntegrityIssue" ADD CONSTRAINT "WalletIntegrityIssue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Time-dependent expiry belongs in queries, never in an index predicate.
CREATE UNIQUE INDEX "AccountBan_one_unreleased" ON "AccountBan" ("userId") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "AdminPermissionGrant_one_effective" ON "AdminPermissionGrant" ("userId", "permissionCode") WHERE "revokedAt" IS NULL;
CREATE UNIQUE INDEX "MerchantLifecycleEvent_one_application_decision" ON "MerchantLifecycleEvent" ("applicationRevisionId") WHERE action IN ('approve', 'reject');
CREATE UNIQUE INDEX "AdminExportJob_one_active_per_admin" ON "AdminExportJob" ("requestedByUserId") WHERE status IN ('queued', 'running');
ALTER TABLE "AccountBan" ADD CONSTRAINT "AccountBan_period_check" CHECK (("expiresAt" IS NULL OR "startsAt" IS NULL OR "expiresAt" > "startsAt") AND version >= 0 AND source IN ('admin','legacy'));
ALTER TABLE "AdminAuthorization" ADD CONSTRAINT "AdminAuthorization_tier_check" CHECK (tier IN ('super','operator') AND version >= 0);
ALTER TABLE "RechargeRefundReviewAction" ADD CONSTRAINT "RefundReviewAction_kind_check" CHECK (kind IN ('resume','reject') AND "expectedReviewVersion" >= 0);
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_count_check" CHECK ("importedCount" > 0);
ALTER TABLE "AdminExportJob" ADD CONSTRAINT "AdminExportJob_status_check" CHECK (status IN ('queued','running','succeeded','failed','expired') AND kind IN ('users','orders','point_logs') AND (phase IS NULL OR phase IN ('materializing','uploading')));
ALTER TABLE "WalletIntegrityIssue" ADD CONSTRAINT "WalletIntegrityIssue_status_check" CHECK (status IN ('open','resolved') AND type IN ('balance_source_mismatch','frozen_source_mismatch'));

-- This projection function is shared by raw SQL audience and qualification queries.
CREATE FUNCTION governance_user_active(uid INTEGER) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM "User" u WHERE u.id=uid
   AND NOT EXISTS (SELECT 1 FROM "AccountBan" b WHERE b."userId"=u.id AND b."releasedAt" IS NULL AND (b."expiresAt" IS NULL OR b."expiresAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))
   AND (u.status IN ('active','正常') OR (u.status IN ('banned','已封禁') AND EXISTS (SELECT 1 FROM "AccountBan" b WHERE b."userId"=u.id))))
$$;

CREATE FUNCTION governance_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW."updatedAt" := clock_timestamp() AT TIME ZONE 'UTC'; RETURN NEW; END;
$$;
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['User','Order','Product','Offer','Settlement','DeliveryRecord','Review'] LOOP
   EXECUTE format('CREATE TRIGGER governance_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION governance_touch_updated_at()', tab);
 END LOOP;
END $$;

-- Assigning once is allowed during backfill. Changing an existing number is forbidden.
CREATE FUNCTION governance_business_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field TEXT := TG_ARGV[0]; prefix TEXT := TG_ARGV[1]; value TEXT; prior TEXT; bytes BYTEA; suffix TEXT; i INTEGER; attempt INTEGER; occupied BOOLEAN;
BEGIN
 value := to_jsonb(NEW)->>field;
 IF TG_OP='UPDATE' THEN
   prior := to_jsonb(OLD)->>field;
   IF prior IS NOT NULL AND value IS DISTINCT FROM prior THEN RAISE EXCEPTION 'business_number_immutable' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF value IS NOT NULL THEN RETURN NEW; END IF;
 FOR attempt IN 1..8 LOOP
   bytes := uuid_send(gen_random_uuid()); suffix := '';
   FOREACH i IN ARRAY ARRAY[0,1,2,3,4,5,7,9,10,11,12,13] LOOP
     suffix := suffix || substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (get_byte(bytes,i) & 31)+1,1);
   END LOOP;
   value := prefix || to_char((NEW."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai','YYYYMMDD') || '-' || suffix;
   PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_NAME || ':' || value, 0));
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE %I=$1)',TG_TABLE_NAME,field) INTO occupied USING value;
   IF NOT occupied THEN RETURN jsonb_populate_record(NEW,jsonb_build_object(field,value)); END IF;
 END LOOP;
 RAISE EXCEPTION 'business_number_exhausted' USING ERRCODE='23505';
END;
$$;
CREATE TRIGGER governance_order_number BEFORE INSERT OR UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION governance_business_number('orderNo','MN');
CREATE TRIGGER governance_batch_number BEFORE INSERT OR UPDATE ON "SettlementBatch" FOR EACH ROW EXECUTE FUNCTION governance_business_number('batchNo','MNSB');
CREATE TRIGGER governance_case_number BEFORE INSERT OR UPDATE ON "OrderAfterSalesCase" FOR EACH ROW EXECUTE FUNCTION governance_business_number('caseNo','MNAS');

-- A whitelist snapshot prevents secrets entering the audit for any Offer writer.
CREATE FUNCTION governance_offer_safe(row_data JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('name',row_data->'name','price',row_data->'price','originalPrice',row_data->'originalPrice',
 'validityDays',row_data->'validityDays','status',row_data->'status','fulfillmentType',row_data->'deliveryMode',
 'inventoryMode',row_data->'stockMode','isDefault',row_data->'isDefault','autoProvision',row_data->'autoProvision','externalSkuId',row_data->'externalSku')
$$;
CREATE FUNCTION governance_offer_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW."commercialRevision" := 1;
 ELSIF governance_offer_safe(to_jsonb(NEW)) IS DISTINCT FROM governance_offer_safe(to_jsonb(OLD)) THEN NEW."commercialRevision" := OLD."commercialRevision"+1;
 ELSE NEW."commercialRevision" := CASE WHEN OLD."commercialRevision"=0 AND EXISTS(SELECT 1 FROM "OfferCommercialRevision" r WHERE r."offerId"=OLD.id AND r.revision=1 AND r."actorType"='migration') THEN 1 ELSE OLD."commercialRevision" END;
 END IF; RETURN NEW;
END;
$$;
CREATE FUNCTION governance_offer_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous JSONB; current JSONB; changed TEXT[]; actor INTEGER; actor_type TEXT;
BEGIN
 IF TG_OP='UPDATE' AND governance_offer_safe(to_jsonb(NEW)) IS NOT DISTINCT FROM governance_offer_safe(to_jsonb(OLD)) THEN RETURN NEW; END IF;
 previous := CASE WHEN TG_OP='INSERT' THEN NULL ELSE governance_offer_safe(to_jsonb(OLD)) END;
 current := governance_offer_safe(to_jsonb(NEW));
 SELECT coalesce(array_agg(k ORDER BY k),'{}') INTO changed FROM jsonb_object_keys(current) k WHERE current->k IS DISTINCT FROM previous->k;
 actor := NULLIF(current_setting('monexus.commercial_actor',true),'')::integer;
 actor_type := CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END;
 INSERT INTO "OfferCommercialRevision" (id,"offerId",revision,"actorType","actorUserId","sourceRef","reasonCode","beforeSafe","afterSafe","changedFields")
 VALUES(gen_random_uuid(),NEW.id,NEW."commercialRevision",actor_type,actor,NULLIF(current_setting('monexus.commercial_source',true),''),
 coalesce(NULLIF(current_setting('monexus.commercial_reason',true),''),'system_update'),previous,current,changed);
 RETURN NEW;
END;
$$;
CREATE TRIGGER governance_offer_version BEFORE INSERT OR UPDATE ON "Offer" FOR EACH ROW EXECUTE FUNCTION governance_offer_version();
CREATE TRIGGER governance_offer_audit AFTER INSERT OR UPDATE ON "Offer" FOR EACH ROW EXECUTE FUNCTION governance_offer_audit();

CREATE FUNCTION governance_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'governance_fact_is_append_only' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER governance_refund_action_immutable BEFORE UPDATE OR DELETE ON "RechargeRefundReviewAction" FOR EACH ROW EXECUTE FUNCTION governance_append_only();
CREATE TRIGGER governance_merchant_event_immutable BEFORE UPDATE OR DELETE ON "MerchantLifecycleEvent" FOR EACH ROW EXECUTE FUNCTION governance_append_only();
CREATE TRIGGER governance_application_immutable BEFORE UPDATE OR DELETE ON "MerchantApplicationRevision" FOR EACH ROW EXECUTE FUNCTION governance_append_only();
CREATE TRIGGER governance_offer_revision_immutable BEFORE UPDATE OR DELETE ON "OfferCommercialRevision" FOR EACH ROW EXECUTE FUNCTION governance_append_only();

-- Replace the legacy Chinese actor check with the same effective-status rule.
DO $$ DECLARE definition TEXT; BEGIN
 SELECT pg_get_functiondef('value_policy_enforce_actor_role()'::regprocedure) INTO definition;
 definition := replace(definition, 'actor_status IS DISTINCT FROM ''正常''', 'NOT governance_user_active(actor_id)');
 EXECUTE definition;
END $$;
-- Built concurrently by scripts/migrate-deploy.mjs after Prisma expansion.
