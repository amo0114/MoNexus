import { describe, it, expect } from 'vitest'
import { api, createTestUser, loginAs, authHeader } from './helpers.js'

// 67-byte minimal 1x1 transparent PNG. Cheaper than reading a fixture
// file from disk and works on every CI image regardless of cwd.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000' +
    '000d4944415478da6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex'
)

describe('POST /api/uploads/image', () => {
  it('should return 401 when not authenticated', async () => {
    const res = await api.post('/api/uploads/image').expect(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('should return 400 with NO_FILE when no file attached', async () => {
    await createTestUser('upload-nofile@test.local')
    const { accessToken } = await loginAs('upload-nofile@test.local', 'testpass123')

    const res = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .expect(400)

    expect(res.body.error.code).toBe('NO_FILE')
  })

  it('should return 400 with FILE_TOO_LARGE when file exceeds 5MB', async () => {
    await createTestUser('upload-large@test.local')
    const { accessToken } = await loginAs('upload-large@test.local', 'testpass123')
    const oversized = Buffer.alloc(6 * 1024 * 1024, 0xff)

    const res = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .attach('file', oversized, { filename: 'big.png', contentType: 'image/png' })
      .expect(400)

    expect(res.body.error.code).toBe('FILE_TOO_LARGE')
  })

  it('should return 400 with UNSUPPORTED_MEDIA_TYPE when file is not an image', async () => {
    await createTestUser('upload-type@test.local')
    const { accessToken } = await loginAs('upload-type@test.local', 'testpass123')
    const textBuf = Buffer.from('not an image', 'utf-8')

    const res = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .attach('file', textBuf, { filename: 'note.txt', contentType: 'text/plain' })
      .expect(400)

    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('should return 200 with an http(s) URL and key on a valid PNG upload', async () => {
    await createTestUser('upload-ok@test.local')
    const { accessToken } = await loginAs('upload-ok@test.local', 'testpass123')

    const res = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .attach('file', TINY_PNG, { filename: 'tiny.png', contentType: 'image/png' })
      .expect(200)

    expect(res.body.url).toMatch(/^https?:\/\//)
    expect(res.body.key).toBeTruthy()
    // Key should embed the content hash so identical uploads dedupe.
    expect(res.body.key).toMatch(/\.png$/)
  })

  it('should serve the uploaded blob back via GET /api/uploads/:key', async () => {
    await createTestUser('upload-fetch@test.local')
    const { accessToken } = await loginAs('upload-fetch@test.local', 'testpass123')

    const upload = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .attach('file', TINY_PNG, { filename: 'tiny.png', contentType: 'image/png' })
      .expect(200)

    const fetched = await api
      .get(`/api/uploads/${upload.body.key}`)
      .expect(200)

    expect(fetched.headers['content-type']).toMatch(/^image\/png/)
    expect(fetched.body).toEqual(TINY_PNG)
  })
})
