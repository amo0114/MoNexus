-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN     "pushEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pushedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CheckinRecord" ADD COLUMN     "streak" INTEGER NOT NULL DEFAULT 1;

-- Backfill streak (gaps-and-islands): consecutive dates share the same
-- (date - row_number) anchor; the row number inside each island is the streak.
WITH ordered AS (
    SELECT "id", "userId", "date",
           "date"::date - (ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "date"))::int AS anchor
    FROM "CheckinRecord"
), ranked AS (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId", anchor ORDER BY "date") AS streak
    FROM ordered
)
UPDATE "CheckinRecord" c SET "streak" = r.streak FROM ranked r WHERE c."id" = r."id" AND r.streak <> 1;

-- CreateTable
CREATE TABLE "CheckinReward" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "milestone" INTEGER NOT NULL,
    "periodKey" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'claimable',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "pointLogId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckinReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserActiveDay" (
    "userId" INTEGER NOT NULL,
    "day" TEXT NOT NULL,

    CONSTRAINT "UserActiveDay_pkey" PRIMARY KEY ("userId","day")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckinReward_pointLogId_key" ON "CheckinReward"("pointLogId");

-- CreateIndex
CREATE INDEX "CheckinReward_userId_state_expiresAt_idx" ON "CheckinReward"("userId", "state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckinReward_userId_kind_periodKey_milestone_key" ON "CheckinReward"("userId", "kind", "periodKey", "milestone");

-- CreateIndex
CREATE INDEX "UserActiveDay_day_idx" ON "UserActiveDay"("day");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- AddForeignKey
ALTER TABLE "CheckinReward" ADD CONSTRAINT "CheckinReward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserActiveDay" ADD CONSTRAINT "UserActiveDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

