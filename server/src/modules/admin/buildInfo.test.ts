import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { readBuildInfo, unavailableBuildInfo } from './buildInfo.js'

const ORIGINAL_BUILD_INFO_PATH = process.env.BUILD_INFO_PATH

const ARTIFACT = {
  version: '1.2.3',
  commit: '0123456789abcdef0123456789abcdef01234567',
  builtAt: '2026-09-09T08:00:00.000Z',
  environment: 'production' as const,
  releaseTag: 'v1.2.3',
  source: 'build_artifact' as const,
}

async function withArtifactFile(contents: unknown | null) {
  const dir = await mkdtemp(join(tmpdir(), 'monexus-build-info-'))
  const filePath = join(dir, 'build-info.json')
  if (contents !== null) {
    await writeFile(filePath, `${JSON.stringify(contents)}\n`, 'utf8')
  }
  process.env.BUILD_INFO_PATH = filePath
  return { dir, filePath }
}

afterEach(async () => {
  if (ORIGINAL_BUILD_INFO_PATH === undefined) delete process.env.BUILD_INFO_PATH
  else process.env.BUILD_INFO_PATH = ORIGINAL_BUILD_INFO_PATH
})

describe('readBuildInfo', () => {
  it('returns unavailable nulls when the file is missing', async () => {
    const { dir, filePath } = await withArtifactFile(null)
    try {
      await expect(readBuildInfo(filePath)).resolves.toEqual(unavailableBuildInfo())
      expect(unavailableBuildInfo()).toEqual({
        version: null,
        commit: null,
        builtAt: null,
        environment: 'test',
        releaseTag: null,
        source: 'unavailable',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns the exact artifact JSON when the file is present', async () => {
    const { dir, filePath } = await withArtifactFile(ARTIFACT)
    try {
      await expect(readBuildInfo(filePath)).resolves.toEqual(ARTIFACT)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not fill version from package.json or the current time when missing', async () => {
    const { dir, filePath } = await withArtifactFile(null)
    try {
      const info = await readBuildInfo(filePath)
      expect(info.version).toBeNull()
      expect(info.commit).toBeNull()
      expect(info.builtAt).toBeNull()
      expect(info.source).toBe('unavailable')
      expect(info.version).not.toBe('1.0.0')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('strips unknown fields and treats a malformed file as unavailable', async () => {
    const { dir, filePath } = await withArtifactFile({
      ...ARTIFACT,
      secret: 'must-not-leak',
    })
    try {
      await expect(readBuildInfo(filePath)).resolves.toEqual(ARTIFACT)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    const invalid = await withArtifactFile({ version: '1.0.0' })
    try {
      await expect(readBuildInfo(invalid.filePath)).resolves.toEqual(unavailableBuildInfo())
    } finally {
      await rm(invalid.dir, { recursive: true, force: true })
    }
  })
})

describe('GET /api/admin/system/build-info', () => {
  async function loginAdmin(email: string) {
    const { user, password } = await createTestUser(email, 'admin123', 'admin')
    const { accessToken } = await loginAs(user.email, password)
    return { user, accessToken }
  }

  it('rejects unauthenticated access', async () => {
    await api.get('/api/admin/system/build-info').expect(401)
  })

  it('rejects non-admin access', async () => {
    await createTestUser('build-info-user@test.local', 'pass123', 'user')
    const { accessToken } = await loginAs('build-info-user@test.local', 'pass123')
    await api.get('/api/admin/system/build-info').set(authHeader(accessToken)).expect(403)
  })

  it('returns unavailable nulls when the artifact is missing', async () => {
    const { dir, filePath } = await withArtifactFile(null)
    const { accessToken } = await loginAdmin('build-info-missing@test.local')
    try {
      const res = await api
        .get('/api/admin/system/build-info')
        .set(authHeader(accessToken))
        .expect(200)
      expect(res.headers['cache-control']).toBe('private, no-store')
      expect(res.body).toEqual({
        version: null,
        commit: null,
        builtAt: null,
        environment: 'test',
        releaseTag: null,
        source: 'unavailable',
      })
      expect(res.body.version).not.toBe('1.0.0')
      expect(filePath.endsWith('build-info.json')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns the exact artifact JSON when the file is present', async () => {
    const { dir } = await withArtifactFile(ARTIFACT)
    const { accessToken } = await loginAdmin('build-info-present@test.local')
    try {
      const res = await api
        .get('/api/admin/system/build-info')
        .set(authHeader(accessToken))
        .expect(200)
      expect(res.headers['cache-control']).toBe('private, no-store')
      expect(res.body).toEqual(ARTIFACT)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
