-- FakaBridge OTP: per-user rolling 24h outbound-mail budget.
-- FakaProvisionEmailProof is unique per (user,email), so it cannot cap an
-- account that cycles through distinct third-party addresses.

CREATE TABLE "FakaProvisionEmailSendBudget" (
    "userId" INTEGER NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FakaProvisionEmailSendBudget_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "FakaProvisionEmailSendBudget"
  ADD CONSTRAINT "FakaProvisionEmailSendBudget_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
