CREATE TABLE "RecommendationImpression" (
    "listId" UUID NOT NULL,
    "productId" INTEGER NOT NULL,
    "sourceProductId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "tier" INTEGER NOT NULL,
    "sameSeller" BOOLEAN NOT NULL,
    "platformSeller" BOOLEAN NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "visitorId" UUID NOT NULL,
    "userId" INTEGER,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "implied" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "RecommendationImpression_pkey" PRIMARY KEY ("listId", "productId")
);
CREATE INDEX "RecommendationImpression_receivedAt_idx" ON "RecommendationImpression"("receivedAt");
CREATE INDEX "RecommendationImpression_sourceProductId_receivedAt_idx" ON "RecommendationImpression"("sourceProductId", "receivedAt");
CREATE TABLE "RecommendationClick" (
    "listId" UUID NOT NULL,
    "productId" INTEGER NOT NULL,
    "sourceProductId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "tier" INTEGER NOT NULL,
    "sameSeller" BOOLEAN NOT NULL,
    "platformSeller" BOOLEAN NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "visitorId" UUID NOT NULL,
    "userId" INTEGER,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecommendationClick_pkey" PRIMARY KEY ("listId", "productId")
);
CREATE INDEX "RecommendationClick_receivedAt_idx" ON "RecommendationClick"("receivedAt");
CREATE INDEX "RecommendationClick_userId_productId_receivedAt_idx" ON "RecommendationClick"("userId", "productId", "receivedAt");
