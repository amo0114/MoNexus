ALTER TABLE "RefreshToken"
  ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3),
  ADD COLUMN "deviceLabel" TEXT,
  ADD COLUMN "ipHint" TEXT;

-- Non-admin active sessions keep at least their current expiresAt or 30 days
-- from sessionStartedAt so existing active users are not logged out on deploy.
UPDATE "RefreshToken" rt
SET "absoluteExpiresAt" = GREATEST(rt."expiresAt", rt."sessionStartedAt" + INTERVAL '30 days')
FROM "User" u
WHERE rt."userId" = u."id"
  AND rt."revoked" = false
  AND rt."absoluteExpiresAt" IS NULL
  AND u."role" <> 'admin';

-- Admin active sessions enforce the 7-day absolute cap immediately, including
-- tightening expiresAt so existing >7d admin sessions re-authenticate via MFA.
UPDATE "RefreshToken" rt
SET "absoluteExpiresAt" = rt."sessionStartedAt" + INTERVAL '7 days',
    "expiresAt" = LEAST(rt."expiresAt", rt."sessionStartedAt" + INTERVAL '7 days')
FROM "User" u
WHERE rt."userId" = u."id"
  AND rt."revoked" = false
  AND rt."absoluteExpiresAt" IS NULL
  AND u."role" = 'admin';
