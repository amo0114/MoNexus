import { describe, expect, it } from 'vitest'
import {
  SHORTLINK_CREATE_PATH,
  SHORTLINK_DESCRIBE,
  SHORTLINK_LOGIN_PATH,
  createShortlinkClient,
  isShortlinkConfigured,
  toPublicShortUrl,
} from './shortlinkClient.js'

const CFG = {
  apiBaseUrl: 'https://shortlink.example',
  publicOrigin: 'https://s.example',
  username: 'svc',
  password: 'secret',
  groupId: 'gid-1',
} as const

const ORIGIN_URL = 'https://shop.example/product/42'
const LOGIN_URL = `${CFG.apiBaseUrl}${SHORTLINK_LOGIN_PATH}`
const CREATE_URL = `${CFG.apiBaseUrl}${SHORTLINK_CREATE_PATH}`

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function successCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    code: '0',
    data: {
      fullShortUrl: 'http://s.example/Ab3x9',
      originUrl: ORIGIN_URL,
      gid: CFG.groupId,
      ...overrides,
    },
  }
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

describe('isShortlinkConfigured', () => {
  it('is false when config is missing', () => {
    expect(isShortlinkConfigured()).toBe(false)
    expect(isShortlinkConfigured({})).toBe(false)
    expect(isShortlinkConfigured({ apiBaseUrl: CFG.apiBaseUrl })).toBe(false)
  })

  it('is true only when every field is present', () => {
    expect(isShortlinkConfigured(CFG)).toBe(true)
  })
})

describe('toPublicShortUrl', () => {
  it('rebuilds an https public URL from an http provider URL', () => {
    expect(toPublicShortUrl('http://s.example/Ab3x9', CFG.publicOrigin)).toBe('https://s.example/Ab3x9')
  })

  it('rejects other domains, paths, userinfo, query, and hash', () => {
    expect(toPublicShortUrl('http://evil.example/Ab3x9', CFG.publicOrigin)).toBeNull()
    expect(toPublicShortUrl('http://s.example/a/b', CFG.publicOrigin)).toBeNull()
    expect(toPublicShortUrl('http://s.example/Ab3x9!', CFG.publicOrigin)).toBeNull()
    expect(toPublicShortUrl('http://s.example/', CFG.publicOrigin)).toBeNull()
    expect(toPublicShortUrl('http://s.example/Ab3x9?x=1', CFG.publicOrigin)).toBeNull()
    expect(toPublicShortUrl('http://s.example/Ab3x9#h', CFG.publicOrigin)).toBeNull()
    expect(toPublicShortUrl('http://user:pass@s.example/Ab3x9', CFG.publicOrigin)).toBeNull()
  })

  it('requires hostname and explicit port to match the public origin', () => {
    expect(toPublicShortUrl('http://s.example:8443/Ab3x9', 'https://s.example:8443')).toBe(
      'https://s.example:8443/Ab3x9',
    )
    expect(toPublicShortUrl('http://s.example/Ab3x9', 'https://s.example:8443')).toBeNull()
    expect(toPublicShortUrl('http://s.example:8443/Ab3x9', CFG.publicOrigin)).toBeNull()
  })
})

describe('createShortlinkClient', () => {
  it('logs in once, creates a link, and returns the verified https URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = createShortlinkClient({
      config: CFG,
      fetchImplementation: async (input, init) => {
        const url = String(input)
        calls.push({ url, init })
        if (url === LOGIN_URL) {
          return jsonResponse(200, { code: '0', data: { token: 'tok-1' } })
        }
        expect(headerOf(init, 'username')).toBe(CFG.username)
        expect(headerOf(init, 'token')).toBe('tok-1')
        expect(JSON.parse(String(init?.body))).toEqual({
          originUrl: ORIGIN_URL,
          gid: CFG.groupId,
          createdType: 0,
          validDateType: 0,
          validDate: null,
          describe: SHORTLINK_DESCRIBE,
        })
        return jsonResponse(200, successCreateBody())
      },
    })

    await expect(client.createShortLink(ORIGIN_URL)).resolves.toEqual({ url: 'https://s.example/Ab3x9' })
    expect(calls.map(call => call.url)).toEqual([LOGIN_URL, CREATE_URL])
  })

  it('treats HTTP 200 business failure as unavailable and does not retry create', async () => {
    let creates = 0
    const client = createShortlinkClient({
      config: CFG,
      fetchImplementation: async (input) => {
        if (String(input) === LOGIN_URL) {
          return jsonResponse(200, { code: '0', data: { token: 'tok-1' } })
        }
        creates += 1
        return jsonResponse(200, { ...successCreateBody(), code: 'A000001' })
      },
    })

    await expect(client.createShortLink(ORIGIN_URL)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(creates).toBe(1)
  })

  it('drops the token on 401, re-logins once, and retries the rejected create once', async () => {
    const tokens: string[] = []
    let logins = 0
    let creates = 0
    const client = createShortlinkClient({
      config: CFG,
      fetchImplementation: async (input, init) => {
        if (String(input) === LOGIN_URL) {
          logins += 1
          const token = `tok-${logins}`
          return jsonResponse(200, { code: '0', data: { token } })
        }
        creates += 1
        const token = headerOf(init, 'token') ?? ''
        tokens.push(token)
        if (token === 'tok-1') return new Response('', { status: 401 })
        return jsonResponse(200, successCreateBody())
      },
    })

    await expect(client.createShortLink(ORIGIN_URL)).resolves.toEqual({ url: 'https://s.example/Ab3x9' })
    expect(logins).toBe(2)
    expect(creates).toBe(2)
    expect(tokens).toEqual(['tok-1', 'tok-2'])
  })

  it('does not retry create after a second 401', async () => {
    let creates = 0
    const client = createShortlinkClient({
      config: CFG,
      fetchImplementation: async (input) => {
        if (String(input) === LOGIN_URL) {
          return jsonResponse(200, { code: '0', data: { token: `tok-${creates + 1}` } })
        }
        creates += 1
        return new Response('', { status: 401 })
      },
    })

    await expect(client.createShortLink(ORIGIN_URL)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(creates).toBe(2)
  })

  it('coalesces concurrent logins onto one token', async () => {
    let logins = 0
    let releaseLogin: () => void = () => {}
    const loginGate = new Promise<void>(resolve => {
      releaseLogin = resolve
    })
    const client = createShortlinkClient({
      config: CFG,
      fetchImplementation: async (input) => {
        if (String(input) === LOGIN_URL) {
          logins += 1
          await loginGate
          return jsonResponse(200, { code: '0', data: { token: 'shared' } })
        }
        return jsonResponse(200, successCreateBody())
      },
    })

    const pending = Promise.all([
      client.createShortLink(ORIGIN_URL),
      client.createShortLink(ORIGIN_URL),
    ])
    await Promise.resolve()
    expect(logins).toBe(1)
    releaseLogin()
    await expect(pending).resolves.toEqual([
      { url: 'https://s.example/Ab3x9' },
      { url: 'https://s.example/Ab3x9' },
    ])
    expect(logins).toBe(1)
  })

  it('times out within the remote budget and does not invent a token', async () => {
    const client = createShortlinkClient({
      config: CFG,
      remoteBudgetMs: 30,
      fetchImplementation: (_input, init) => new Promise((_, reject) => {
        const abort = () => {
          const err = new Error('Aborted')
          err.name = 'TimeoutError'
          reject(err)
        }
        if (init?.signal?.aborted) {
          abort()
          return
        }
        init?.signal?.addEventListener('abort', abort)
      }),
    })

    await expect(client.createShortLink(ORIGIN_URL)).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('rejects a mismatched originUrl or gid without returning a URL', async () => {
    const client = createShortlinkClient({
      config: CFG,
      fetchImplementation: async (input) => {
        if (String(input) === LOGIN_URL) {
          return jsonResponse(200, { code: '0', data: { token: 'tok-1' } })
        }
        return jsonResponse(200, successCreateBody({ originUrl: 'https://evil.example/product/42', gid: 'other' }))
      },
    })
    await expect(client.createShortLink(ORIGIN_URL)).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('rejects a wrong domain or path even when business code is success', async () => {
    const client = createShortlinkClient({
      config: CFG,
      fetchImplementation: async (input) => {
        if (String(input) === LOGIN_URL) {
          return jsonResponse(200, { code: '0', data: { token: 'tok-1' } })
        }
        return jsonResponse(200, successCreateBody({ fullShortUrl: 'http://evil.example/Ab3x9' }))
      },
    })
    await expect(client.createShortLink(ORIGIN_URL)).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('does not call fetch or invent a token when config is missing', async () => {
    const fetchImplementation = async () => {
      throw new Error('fetch must not run')
    }
    const client = createShortlinkClient({ fetchImplementation })
    await expect(client.createShortLink(ORIGIN_URL)).rejects.toMatchObject({ kind: 'unconfigured' })
  })

  it('does not invent a token when login fails', async () => {
    let creates = 0
    const client = createShortlinkClient({
      config: CFG,
      fetchImplementation: async (input) => {
        if (String(input) === LOGIN_URL) {
          return jsonResponse(200, { code: '1', data: { token: 'forged' } })
        }
        creates += 1
        return jsonResponse(200, successCreateBody())
      },
    })
    await expect(client.createShortLink(ORIGIN_URL)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(creates).toBe(0)
  })
})
