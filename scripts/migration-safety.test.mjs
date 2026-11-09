import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrationSafetyErrors } from './check-migration-safety.mjs'
test('rejects strong DDL sharing a transaction with an existing-table index build', () => {
  assert.notEqual(migrationSafetyErrors('ALTER TABLE "Order" ADD COLUMN "deadline" timestamp; CREATE INDEX "idx" ON "Order"("deadline");').length, 0)
  assert.notEqual(migrationSafetyErrors('SET lock_timeout=5000; CREATE INDEX CONCURRENTLY "idx" ON "Order"("id");').length, 0)
})
test('permits a standalone concurrent index and indexes on a new empty table', () => {
  assert.deepEqual(migrationSafetyErrors('-- comment\nCREATE INDEX CONCURRENTLY "idx" ON "Order"("id");'), [])
  assert.deepEqual(migrationSafetyErrors('CREATE TABLE "New" (id int); CREATE INDEX "idx" ON "New"("id");'), [])
})
