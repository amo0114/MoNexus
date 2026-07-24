import api from './client'

export type PortableBackupState = 'running' | 'ready' | 'failed'

export interface PortableBackupJob {
  id: string
  createdAt: string
  state: PortableBackupState
  fileName?: string
  byteSize?: number
  objectCount?: number
  error?: string
}

export async function createPortableBackup(passphrase: string) {
  const { data } = await api.post<PortableBackupJob>('/admin/portable-backups/export', { passphrase })
  return data
}

export async function getPortableBackup(id: string) {
  const { data } = await api.get<PortableBackupJob>(`/admin/portable-backups/${id}`)
  return data
}

export async function downloadPortableBackup(job: PortableBackupJob) {
  const { data } = await api.get<Blob>(`/admin/portable-backups/${job.id}/download`, {
    responseType: 'blob',
    timeout: 0,
  })
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url
  link.download = job.fileName ?? 'monexus-backup.monexus-backup'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export async function restorePortableBackup(file: File, passphrase: string) {
  const form = new FormData()
  form.append('backup', file)
  form.append('passphrase', passphrase)
  form.append('confirmation', 'RESTORE_PORTABLE_BACKUP')
  const { data } = await api.post<{ objectCount: number; reauthenticate: boolean }>(
    '/admin/portable-backups/import',
    form,
    {
      timeout: 0,
      onUploadProgress: undefined,
    }
  )
  return data
}

export async function getPortableRestoreBootstrapStatus() {
  const { data } = await api.get<{ available: boolean }>('/portable-restore/bootstrap/status')
  return data
}

export async function createPortableRestoreBootstrapAdmin(payload: {
  token: string
  email: string
  password: string
}) {
  await api.post('/portable-restore/bootstrap/admin', payload)
}
