-- SPEC-CHAT-BOT-001: QQ/Telegram bot account binding + daily check-in.
-- Additive only: no existing tables/columns/relations are dropped.
--
-- Why a separate binding table instead of a column on "User": binding is
-- many-to-one by design (one platform identity per user, and one user per
-- platform identity), and the bot rejects duplicates in either direction. A
-- nullable "User.qqId" column could not express the reverse uniqueness
-- constraint without a partial index, and would silently allow a second QQ to
-- overwrite the first.

-- AlterTable
-- `source` records which entry point produced the row. It is statistics-only:
-- the existing @@unique([userId, date]) remains the single idempotency guard,
-- so a web check-in and a bot check-in on the same day still collide correctly.
ALTER TABLE "CheckinRecord" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'web';

-- CreateTable
CREATE TABLE "ChatBinding" (
    "id" SERIAL NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'qq',
    "platformId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatBindCode" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatBindCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckinRecord_date_idx" ON "CheckinRecord"("date");

-- CreateIndex
CREATE UNIQUE INDEX "ChatBinding_platform_platformId_key" ON "ChatBinding"("platform", "platformId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatBinding_platform_userId_key" ON "ChatBinding"("platform", "userId");

-- CreateIndex
CREATE INDEX "ChatBinding_userId_idx" ON "ChatBinding"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatBindCode_code_key" ON "ChatBindCode"("code");

-- CreateIndex
CREATE INDEX "ChatBindCode_expiresAt_idx" ON "ChatBindCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "ChatBinding" ADD CONSTRAINT "ChatBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatBindCode" ADD CONSTRAINT "ChatBindCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
