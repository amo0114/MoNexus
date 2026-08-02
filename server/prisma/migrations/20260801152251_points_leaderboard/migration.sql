-- CreateTable
CREATE TABLE "LeaderboardEntry" (
    "id" SERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaderboardEntry_scope_periodKey_rank_idx" ON "LeaderboardEntry"("scope", "periodKey", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardEntry_scope_periodKey_userId_key" ON "LeaderboardEntry"("scope", "periodKey", "userId");

-- CreateIndex
CREATE INDEX "PointLog_type_createdAt_idx" ON "PointLog"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "LeaderboardEntry" ADD CONSTRAINT "LeaderboardEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

