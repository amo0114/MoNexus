import api from './client'
import type { PublicAnnouncement } from '../types/admin'

export interface AnnouncementReceiptResult {
  id: number
  version: number
  readAt: string
  acknowledgedAt: string | null
}

export async function getPublicAnnouncements(): Promise<PublicAnnouncement[]> {
  const { data } = await api.get<PublicAnnouncement[]>('/announcements')
  return Array.isArray(data) ? data : []
}

export async function markAnnouncementRead(id: number): Promise<AnnouncementReceiptResult> {
  const { data } = await api.post<AnnouncementReceiptResult>(`/announcements/${id}/read`)
  return data
}

export async function acknowledgeAnnouncement(id: number): Promise<AnnouncementReceiptResult> {
  const { data } = await api.post<AnnouncementReceiptResult>(`/announcements/${id}/acknowledge`)
  return data
}
