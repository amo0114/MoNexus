CREATE TABLE "TrafficEvent" (
  "id" UUID NOT NULL PRIMARY KEY,
  "visitorId" UUID NOT NULL,
  "page" VARCHAR(100) NOT NULL,
  "productId" INTEGER,
  "merchantId" INTEGER,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(3)
);
CREATE INDEX "TrafficEvent_receivedAt_idx" ON "TrafficEvent" ("receivedAt");
CREATE INDEX "TrafficEvent_pending_idx" ON "TrafficEvent" ("receivedAt", "id")
  WHERE "processedAt" IS NULL;

CREATE TABLE "TrafficDailyVisitor" (
  "day" DATE NOT NULL,
  "page" VARCHAR(100) NOT NULL,
  "visitorId" UUID NOT NULL,
  "productId" INTEGER,
  "merchantId" INTEGER,
  "pv" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "TrafficDailyVisitor_pkey" PRIMARY KEY ("day", "page", "visitorId")
);
CREATE INDEX "TrafficDailyVisitor_merchantId_day_idx" ON "TrafficDailyVisitor" ("merchantId", "day");

CREATE TABLE "TrafficAggregationState" (
  "id" INTEGER NOT NULL DEFAULT 1 PRIMARY KEY,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3)
);
INSERT INTO "TrafficAggregationState" ("id") VALUES (1);
