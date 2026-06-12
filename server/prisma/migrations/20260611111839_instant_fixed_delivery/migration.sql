-- AlterTable
ALTER TABLE "DeliveryRecord" ADD COLUMN     "contentType" TEXT NOT NULL DEFAULT 'text';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "fixedContent" TEXT,
ADD COLUMN     "fixedContentType" TEXT NOT NULL DEFAULT 'text',
ADD COLUMN     "stockMode" TEXT NOT NULL DEFAULT 'limited';

-- 存量人工服务商品不参与库存扣减，回填为不限接单，避免 stock=0 阻断下单
UPDATE "Product" SET "stockMode" = 'unlimited' WHERE "deliveryMode" = 'manual_service';
