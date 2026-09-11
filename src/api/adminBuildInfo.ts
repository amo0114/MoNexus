import api from './client'

export type AdminBuildEnvironment = 'production' | 'staging' | 'development' | 'test'
export type AdminBuildInfoSource = 'build_artifact' | 'unavailable'

export interface AdminBuildInfo {
  version: string | null
  commit: string | null
  builtAt: string | null
  environment: AdminBuildEnvironment
  releaseTag: string | null
  source: AdminBuildInfoSource
}

export async function getAdminBuildInfo(): Promise<AdminBuildInfo> {
  const { data } = await api.get<AdminBuildInfo>('/admin/system/build-info')
  return {
    version: data.version ?? null,
    commit: data.commit ?? null,
    builtAt: data.builtAt ?? null,
    environment: data.environment,
    releaseTag: data.releaseTag ?? null,
    source: data.source,
  }
}
