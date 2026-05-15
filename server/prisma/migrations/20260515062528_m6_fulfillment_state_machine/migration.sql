-- AlterTable
ALTER TABLE "DeliveryRecord" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "publicNote" TEXT,
ALTER COLUMN "content" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'pending';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "deliveryMode" TEXT NOT NULL DEFAULT 'instant_inventory';

-- CreateTable
CREATE TABLE "OrderStatusEvent" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "actorUserId" INTEGER,
    "actorRole" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "publicNote" TEXT,
    "internalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderStatusEvent_orderId_createdAt_idx" ON "OrderStatusEvent"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderStatusEvent_actorUserId_idx" ON "OrderStatusEvent"("actorUserId");

-- AddForeignKey
ALTER TABLE "OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
