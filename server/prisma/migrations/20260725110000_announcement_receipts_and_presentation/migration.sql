-- Add presentation controls to the existing announcement table. Defaults keep
-- all historical rows working as ordinary notifications without data backfill.
ALTER TABLE "Announcement"
  ADD COLUMN "presentation" TEXT NOT NULL DEFAULT 'notice',
  ADD COLUMN "maxImpressions" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Per-user receipt rows are deliberately versioned. A revised announcement
-- therefore asks for a fresh read/acknowledgement without erasing history.
CREATE TABLE "AnnouncementReceipt" (
  "id" SERIAL NOT NULL,
  "announcementId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "readAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AnnouncementReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnnouncementReceipt_announcementId_userId_version_key"
  ON "AnnouncementReceipt"("announcementId", "userId", "version");
CREATE INDEX "AnnouncementReceipt_userId_readAt_idx"
  ON "AnnouncementReceipt"("userId", "readAt");
CREATE INDEX "AnnouncementReceipt_userId_acknowledgedAt_idx"
  ON "AnnouncementReceipt"("userId", "acknowledgedAt");

ALTER TABLE "AnnouncementReceipt"
  ADD CONSTRAINT "AnnouncementReceipt_announcementId_fkey"
  FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnnouncementReceipt"
  ADD CONSTRAINT "AnnouncementReceipt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
