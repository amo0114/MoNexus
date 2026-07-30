-- FakaBridge: ownership proof for provision emails (anti spoofing of third-party accounts).
-- Verified proofs allow upgrade/downgrade on the owned Xboard account; unowned emails are blocked.

CREATE TABLE "FakaProvisionEmailProof" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "confirmAttempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "proofExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FakaProvisionEmailProof_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FakaProvisionEmailProof_userId_email_key" ON "FakaProvisionEmailProof"("userId", "email");
CREATE INDEX "FakaProvisionEmailProof_userId_proofExpiresAt_idx" ON "FakaProvisionEmailProof"("userId", "proofExpiresAt");

ALTER TABLE "FakaProvisionEmailProof" ADD CONSTRAINT "FakaProvisionEmailProof_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
