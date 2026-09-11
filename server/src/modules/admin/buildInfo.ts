import { readFile } from 'node:fs/promises'
import type { Request, Response } from 'express'
import { config } from '../../config/index.js'

export const DEFAULT_BUILD_INFO_PATH = '/app/build-info.json'

const ENVIRONMENTS = ['production', 'staging', 'development', 'test'] as const
export type BuildEnvironment = (typeof ENVIRONMENTS)[number]
export type BuildInfoSource = 'build_artifact' | 'unavailable'

export interface AdminBuildInfo {
  version: string | null
  commit: string | null
  builtAt: string | null
  environment: BuildEnvironment
  releaseTag: string | null
  source: BuildInfoSource
}

function isEnvironment(value: unknown): value is BuildEnvironment {
  return typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value)
}

export function getBuildInfoPath(): string {
  const fromEnv = process.env.BUILD_INFO_PATH
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : DEFAULT_BUILD_INFO_PATH
}

export function runtimeEnvironment(): BuildEnvironment {
  if (config.monexusDeployEnv === 'staging') return 'staging'
  if (config.nodeEnv === 'production' || config.nodeEnv === 'development' || config.nodeEnv === 'test') {
    return config.nodeEnv
  }
  return 'development'
}

export function unavailableBuildInfo(): AdminBuildInfo {
  return {
    version: null,
    commit: null,
    builtAt: null,
    environment: runtimeEnvironment(),
    releaseTag: null,
    source: 'unavailable',
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function parseArtifact(raw: unknown): AdminBuildInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const version = asNonEmptyString(record.version)
  const commit = asNonEmptyString(record.commit)
  const builtAt = asNonEmptyString(record.builtAt)
  const releaseTag = asNonEmptyString(record.releaseTag)
  if (!version || !commit || !builtAt) return null
  if (!isEnvironment(record.environment)) return null
  if (Number.isNaN(Date.parse(builtAt))) return null
  return {
    version,
    commit,
    builtAt,
    environment: record.environment,
    releaseTag,
    source: 'build_artifact',
  }
}

export async function readBuildInfo(filePath = getBuildInfoPath()): Promise<AdminBuildInfo> {
  try {
    const text = await readFile(filePath, 'utf8')
    const parsed = parseArtifact(JSON.parse(text) as unknown)
    return parsed ?? unavailableBuildInfo()
  } catch {
    return unavailableBuildInfo()
  }
}

export async function getBuildInfo(_req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'private, no-store')
  res.json(await readBuildInfo())
}
