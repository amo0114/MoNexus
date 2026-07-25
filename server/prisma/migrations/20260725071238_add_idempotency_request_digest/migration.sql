-- AlterTable
ALTER TABLE "IdempotencyRecord" ADD COLUMN     "requestDigest" TEXT NOT NULL DEFAULT '';
