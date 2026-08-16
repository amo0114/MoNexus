// platformMedia.ts — centralized platform public image resolver
// (SPEC-CMI-UX-001 §5; D-UX-13/14; AC-UX-009~017; T-UX-002).
//
// The single trust boundary for Category default covers and XBoard covers:
//   - the write/confirm trust anchor is the registered `objectKey` from the
//     authenticated upload API — a client-supplied URL or path is NEVER a
//     trust input (§5.1, §5.2 rule 7);
//   - uploads must exist as a public/active/upload_image StoredObject;
//   - static assets are limited to the existing `/assets/` allowlist;
//   - legacy strings (`/uploads/...`, `/assets/...`, absolute CDN URL) go
//     through the SAME resolver — no duplicated per-path rules anywhere;
//   - canonical URLs are derived from the object's own provider config, never
//     from the request body.
//
// No provider credentials or storage internals are ever exposed.

import { prisma } from '../../lib/prisma.js'
import { resolvePublicObjectCanonicalUrl } from '../../lib/storage/runtime.js'
import { isPlatformPublicAssetUrl } from './categorySchema.js'
import type { Prisma } from '@prisma/client'

/** DB handle accepted by the resolver: the singleton client or a transaction. */
export type MediaDb = typeof prisma | Prisma.TransactionClient

export type PlatformMediaRef =
  | { kind: 'upload'; objectKey: string }
  | { kind: 'static'; path: string }

export interface ResolvedPlatformImage {
  canonicalUrl: string
  objectKey: string | null
  source: 'upload_image' | 'static_asset'
}

export type MediaRefResolutionReason =
  | 'invalid_ref'
  | 'invalid_key'
  | 'object_missing'
  | 'wrong_source'
  | 'provider_mismatch'
  | 'provider_unresolved'
  | 'invalid_static'

/** Stable, machine-readable resolution failure (never shown raw to consumers). */
export class MediaRefResolutionError extends Error {
  constructor(
    public readonly reason: MediaRefResolutionReason,
    message: string,
  ) {
    super(message)
    this.name = 'MediaRefResolutionError'
  }
}

/**
 * Object-key format guard: no traversal, no path separators, no control/query/
 * hash characters, no percent-encoded navigation. Content-addressed keys
 * (`[0-9a-f]{32}.ext` and friends) all pass.
 */
export function isSafeObjectKey(key: string): boolean {
  if (!key || key.length > 512) return false
  if (key.includes('..')) return false
  if (key.includes('/') || key.includes('\\')) return false
  if (/%2e|%2f|%5c/i.test(key)) return false
  if (key.includes('?') || key.includes('#')) return false
  if (!/^[A-Za-z0-9._~+-]+$/.test(key)) return false
  return true
}

async function resolveStaticAssetPath(
  path: string,
): Promise<ResolvedPlatformImage> {
  // The static kind is limited to /assets/ (never /uploads/, never remote).
  if (!path.startsWith('/assets/') || !isPlatformPublicAssetUrl(path)) {
    throw new MediaRefResolutionError('invalid_static', '静态资源路径不受支持')
  }
  return { canonicalUrl: path, objectKey: null, source: 'static_asset' }
}

async function resolveUploadObjectKey(
  objectKey: string,
  db: MediaDb,
): Promise<ResolvedPlatformImage> {
  if (!isSafeObjectKey(objectKey)) {
    throw new MediaRefResolutionError('invalid_key', '上传对象键格式不安全')
  }
  // Rules 2-5: StoredObject exists, public bucket, active status, upload_image.
  const stored = await db.storedObject.findFirst({
    where: {
      bucketRole: 'public',
      objectKey,
      status: 'active',
      source: 'upload_image',
    },
    select: { objectKey: true, providerConfigId: true },
  })
  if (!stored) {
    throw new MediaRefResolutionError('object_missing', '上传图片不存在或已失效')
  }
  // Rule 6: the provider config must be able to produce a canonical public URL.
  const canonicalUrl = await resolvePublicObjectCanonicalUrl(
    stored.providerConfigId,
    stored.objectKey,
    db,
  )
  if (!canonicalUrl) {
    throw new MediaRefResolutionError('provider_unresolved', '无法生成公开访问地址')
  }
  return { canonicalUrl, objectKey: stored.objectKey, source: 'upload_image' }
}

/**
 * Legacy absolute CDN URL entry. The URL only resolves when its origin/path
 * maps unambiguously to the object's OWN provider base AND a valid StoredObject
 * exists — an external URL, private/delivery bucket or provider mismatch is
 * rejected (spec §5.2 rules 3-4).
 */
async function resolveLegacyAbsoluteUrl(
  value: string,
  db: MediaDb,
): Promise<ResolvedPlatformImage> {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new MediaRefResolutionError('invalid_ref', 'URL 无法解析')
  }
  if (parsed.search || parsed.hash) {
    throw new MediaRefResolutionError('invalid_key', 'URL 不允许携带查询或片段')
  }
  const objectKey = parsed.pathname.split('/').filter(Boolean).at(-1) ?? ''
  if (!isSafeObjectKey(objectKey)) {
    throw new MediaRefResolutionError('invalid_key', 'URL 无法映射到公开对象')
  }
  const stored = await db.storedObject.findFirst({
    where: {
      bucketRole: 'public',
      objectKey,
      status: 'active',
      source: 'upload_image',
    },
    select: { objectKey: true, providerConfigId: true },
  })
  if (!stored) {
    throw new MediaRefResolutionError('object_missing', '上传图片不存在或已失效')
  }
  const canonicalUrl = await resolvePublicObjectCanonicalUrl(
    stored.providerConfigId,
    stored.objectKey,
    db,
  )
  if (!canonicalUrl) {
    throw new MediaRefResolutionError('provider_unresolved', '无法生成公开访问地址')
  }
  // Provider mismatch / unresolvable URL → the canonical projection differs.
  const canonical = new URL(canonicalUrl)
  const inputPath = parsed.pathname.replace(/\/+$/, '')
  const canonicalPath = canonical.pathname.replace(/\/+$/, '')
  if (parsed.origin !== canonical.origin || inputPath !== canonicalPath) {
    throw new MediaRefResolutionError('provider_mismatch', 'URL 无法映射到当前公开对象')
  }
  return { canonicalUrl, objectKey: stored.objectKey, source: 'upload_image' }
}

/**
 * Resolve a new-contract media reference (Category `defaultCover` / XBoard
 * uploaded cover) to a canonical public display URL.
 */
export async function resolvePlatformPublicImage(
  ref: PlatformMediaRef,
  db: MediaDb = prisma,
): Promise<ResolvedPlatformImage> {
  if (ref.kind === 'static') {
    return resolveStaticAssetPath(ref.path)
  }
  return resolveUploadObjectKey(ref.objectKey, db)
}

/**
 * Legacy string entry (old `defaultCoverUrl` / XBoard `imageUrl`) — routed
 * through the SAME resolver so no duplicated per-path rules survive.
 */
export async function resolveLegacyPlatformImageUrl(
  value: string,
  db: MediaDb = prisma,
): Promise<ResolvedPlatformImage> {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new MediaRefResolutionError('invalid_ref', '封面不能为空')
  }
  if (trimmed.startsWith('/assets/')) {
    return resolveStaticAssetPath(trimmed)
  }
  if (trimmed.startsWith('/uploads/')) {
    return resolveUploadObjectKey(trimmed.slice('/uploads/'.length), db)
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return resolveLegacyAbsoluteUrl(trimmed, db)
  }
  throw new MediaRefResolutionError(
    'invalid_ref',
    '封面仅支持平台 /assets/、/uploads/ 或已登记公开地址',
  )
}
