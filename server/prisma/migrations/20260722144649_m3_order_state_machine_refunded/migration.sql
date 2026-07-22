-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "fulfillmentDeadline" TIMESTAMP(3),
ADD COLUMN     "holdingPoints" INTEGER;
