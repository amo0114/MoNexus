import { readFile } from 'node:fs/promises'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { defaultNicknameForUser } from '../lib/defaultNickname.js'
import avatarPresetUrls from '../modules/auth/avatarPresetUrls.json' with { type: 'json' }

describe('friendly default nickname migration', () => {
  it('backfills only approved legacy names and preserves saved avatars and other account fields', async () => {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    try {
      // pg_temp shadows the real User table; test the exact migration on pre-upgrade rows.
      await client.query('CREATE TEMP TABLE "User" (id int PRIMARY KEY, nickname text, "avatarUrl" text, password text DEFAULT \'unchanged\')')
      await client.query(`INSERT INTO "User" (id, nickname, "avatarUrl")
        SELECT id, 'mn_23456789', CASE WHEN id % 3 = 0 THEN $1 WHEN id % 3 = 1 THEN $2 ELSE NULL END
        FROM generate_series(1, 1024) id`, [avatarPresetUrls[0], 'http://localhost:3000/uploads/kept.png'])
      const legacy: [number, string | null][] = [[2001, null], [2002, ''], [2003, '   '], [2147483647, 'mn_ZZZZZZZZ']]
      const manual: [number, string][] = [[2004, '我的小名'], [2005, 'mn_12345678'], [2006, 'MN_23456789'], [2007, 'mn_23456789x'], [2008, '爱喝茶的小军师']]
      for (const [id, nickname] of [...legacy, ...manual]) {
        await client.query('INSERT INTO "User" (id, nickname, "avatarUrl") VALUES ($1, $2, $3)', [id, nickname, avatarPresetUrls[1]])
      }
      const before = (await client.query('SELECT id, "avatarUrl", password FROM "User" ORDER BY id')).rows
      const sql = await readFile(new URL('../../prisma/migrations/20261005120000_friendly_default_nicknames/migration.sql', import.meta.url), 'utf8')
      await client.query(sql)
      expect((await client.query('SELECT id, "avatarUrl", password FROM "User" ORDER BY id')).rows).toEqual(before)
      const after = (await client.query('SELECT id, nickname, "nicknameIsGenerated" FROM "User" ORDER BY id')).rows
      const manualNames = new Map(manual)
      for (const row of after) {
        expect(row.nickname).toBe(manualNames.get(row.id) ?? defaultNicknameForUser(row.id))
        expect(row.nicknameIsGenerated).toBe(!manualNames.has(row.id))
      }
    } finally {
      await client.end()
    }
  })
})
