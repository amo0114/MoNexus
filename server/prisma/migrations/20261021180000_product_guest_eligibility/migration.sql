-- SPEC-CATALOG-VIS-001 P1.5-A — 商品游客公开准入（增量迁移）
--
-- 两张表：Product 加 publicContentRevision；新建 ProductGuestEligibility。
--
-- 关键安全属性：既有商品**不会**因为本迁移而变成"游客可见"。
--   - publicContentRevision 默认 1，仅用于判断批准是否仍匹配；
--   - ProductGuestEligibility 不预置任何记录，因此所有既有商品都处于
--     "无记录 → 不对游客展示"的状态。
-- 生产现状 public 商品为 0（2026-10-21 盘点），故本次迁移不改变任何线上
-- 可见性。反向做法（自动给历史 public 商品写 approved）是方案 §9.2 明确
-- 禁止的"不能写'所有历史 public 自动通过'"。
--
-- Prisma 无法表达 CHECK 约束，与既有 ProductCategory 约束同样手工追加。

ALTER TABLE "Product"
  ADD COLUMN "publicContentRevision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_publicContentRevision_positive_check"
    CHECK ("publicContentRevision" >= 1);

CREATE TABLE "ProductGuestEligibility" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "reviewedRevision" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "reasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductGuestEligibility_pkey" PRIMARY KEY ("id")
);

-- decision 只有三个值；撤销复用 denied + reasonCode='revoked'，不新增状态（§4.3）。
ALTER TABLE "ProductGuestEligibility"
  ADD CONSTRAINT "ProductGuestEligibility_decision_valid_check"
    CHECK ("decision" IN ('pending', 'approved', 'denied'));

-- version 是审批 CAS 的排序依据，必须为正。
ALTER TABLE "ProductGuestEligibility"
  ADD CONSTRAINT "ProductGuestEligibility_version_positive_check"
    CHECK ("version" >= 1);

-- reviewedRevision 若存在必须为正（沿用 publicContentRevision 的下界）。
ALTER TABLE "ProductGuestEligibility"
  ADD CONSTRAINT "ProductGuestEligibility_reviewedRevision_positive_check"
    CHECK ("reviewedRevision" IS NULL OR "reviewedRevision" >= 1);

-- approved 必须带 reviewedRevision；否则"已批准"与"版本匹配"会脱钩，
-- 门禁的 reviewedRevision === publicContentRevision 判断将永远不成立而静默失效。
ALTER TABLE "ProductGuestEligibility"
  ADD CONSTRAINT "ProductGuestEligibility_approved_requires_revision_check"
    CHECK ("decision" <> 'approved' OR "reviewedRevision" IS NOT NULL);

-- 一商品最多一条当前准入记录（§4.3："一商品最多一条当前申请，不因重复保存
-- 生成多条待办"）。Prisma 的 @unique 已建唯一索引，这两句显式声明约束名，
-- 让并发首次批准的冲突错误可被识别为唯一约束。
CREATE UNIQUE INDEX "ProductGuestEligibility_productId_key"
  ON "ProductGuestEligibility"("productId");

CREATE INDEX "ProductGuestEligibility_decision_idx"
  ON "ProductGuestEligibility"("decision");

ALTER TABLE "ProductGuestEligibility"
  ADD CONSTRAINT "ProductGuestEligibility_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductGuestEligibility"
  ADD CONSTRAINT "ProductGuestEligibility_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
