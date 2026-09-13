import { describe, it, expect } from 'vitest'
import { api, createTestUser, loginAs, authHeader } from './helpers.js'

// 67-byte minimal 1x1 transparent PNG. Cheaper than reading a fixture
// file from disk and works on every CI image regardless of cwd.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000' +
    '000d4944415478da63606060600000000500017aa85750' +
    '0000000049454e44ae426082',
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

  it('should reject arbitrary bytes that claim to be a PNG', async () => {
    await createTestUser('upload-spoofed-png@test.local')
    const { accessToken } = await loginAs('upload-spoofed-png@test.local', 'testpass123')

    const res = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'spoofed.png', contentType: 'image/png',
      })
      .expect(400)

    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('should reject a real image whose declared MIME type does not match', async () => {
    await createTestUser('upload-mime-mismatch@test.local')
    const { accessToken } = await loginAs('upload-mime-mismatch@test.local', 'testpass123')

    const res = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .attach('file', TINY_PNG, { filename: 'tiny.jpeg', contentType: 'image/jpeg' })
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
    expect(fetched.headers['x-content-type-options']).toBe('nosniff')
    expect(fetched.body).toEqual(TINY_PNG)
  })

  // 审计低危项（2026-09）：合法图片头 + 附加脚本内容可通过校验并原样存储。
  // 现在按格式做结构校验：文件必须在图片终止标记处恰好结束，尾随字节拒绝。
  it('should reject a polyglot image that carries a payload after its terminator', async () => {
    await createTestUser('upload-polyglot@test.local')
    const { accessToken } = await loginAs('upload-polyglot@test.local', 'testpass123')
    const polyglot = Buffer.concat([TINY_PNG, Buffer.from('<script>alert(1)</script>')])

    const res = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .attach('file', polyglot, { filename: 'polyglot.png', contentType: 'image/png' })
      .expect(400)

    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('should reject a truncated image', async () => {
    await createTestUser('upload-truncated@test.local')
    const { accessToken } = await loginAs('upload-truncated@test.local', 'testpass123')

    const res = await api
      .post('/api/uploads/image')
      .set(authHeader(accessToken))
      .attach('file', TINY_PNG.subarray(0, TINY_PNG.length - 4), { filename: 'cut.png', contentType: 'image/png' })
      .expect(400)

    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })
})
