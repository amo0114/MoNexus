-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "purchaseFormAnswers" JSONB,
ADD COLUMN     "purchaseFormSnapshot" JSONB;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "purchaseForm" JSONB;
