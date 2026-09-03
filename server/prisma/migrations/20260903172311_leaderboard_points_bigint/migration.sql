-- DropForeignKey
ALTER TABLE "OrderPricingSnapshot" DROP CONSTRAINT "OrderPricingSnapshot_valuePolicyId_fkey";

-- AlterTable
ALTER TABLE "LeaderboardEntry" ALTER COLUMN "points" SET DATA TYPE BIGINT;

-- AddForeignKey
ALTER TABLE "OrderPricingSnapshot" ADD CONSTRAINT "OrderPricingSnapshot_valuePolicyId_fkey" FOREIGN KEY ("valuePolicyId") REFERENCES "ValuePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
