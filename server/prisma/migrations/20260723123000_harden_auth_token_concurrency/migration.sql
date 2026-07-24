-- A cryptographic refresh-token hash identifies exactly one credential. This
-- makes both lookup and compare-and-set rotation unambiguous at the database
-- boundary as well as in Prisma's schema.
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
