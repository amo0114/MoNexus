-- User profile personalization: optional public avatar URL (OSS/public storage).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
