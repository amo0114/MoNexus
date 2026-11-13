CREATE FUNCTION pg_temp.expect_rejected(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE statement;
 EXCEPTION WHEN OTHERS THEN IF SQLSTATE=expected THEN RETURN; END IF; RAISE; END;
 RAISE EXCEPTION 'expected SQLSTATE %, statement was accepted',expected;
END $$;
SELECT pg_temp.expect_rejected('UPDATE "User" SET status=''typo'' WHERE id=4','23514');
SELECT pg_temp.expect_rejected('UPDATE "User" SET role=''root'' WHERE id=4','23514');
SELECT pg_temp.expect_rejected('UPDATE "Order" SET status=''completed'' WHERE id=1','23514');
SELECT pg_temp.expect_rejected('UPDATE "Order" SET "orderNo"=NULL WHERE id=1','23514');
SELECT pg_temp.expect_rejected('UPDATE "Order" SET "orderNo"=''MN20261001-000000000000'' WHERE id=1','23514');
SELECT pg_temp.expect_rejected('INSERT INTO "Order" ("userId","productId",price,status,"orderNo") SELECT "userId","productId",price,status,"orderNo" FROM "Order" WHERE id=1','23505');
CREATE TEMP TABLE old_timestamp AS SELECT id,"updatedAt" FROM "User" WHERE id=4;
SELECT pg_sleep(0.02);
UPDATE "User" SET nickname='raw SQL verification' WHERE id=4;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM "User" u JOIN old_timestamp o ON u.id=o.id WHERE u."updatedAt">o."updatedAt" AND u."updatedAt"<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+interval '5 seconds') THEN RAISE EXCEPTION 'UTC updatedAt failed'; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM "Order" WHERE id=1 AND "orderNo" LIKE 'MN20261001-%') THEN RAISE EXCEPTION 'historical Shanghai date mismatch'; END IF; END $$;
