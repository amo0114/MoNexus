import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserRouter } from 'react-router-dom'
import AnnouncementCenter from './AnnouncementCenter'
import type { PublicAnnouncement } from '../types/announcement'
import { useAppStore } from '../stores/appStore'

const { getNotifications, markNotificationRead } = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}))

vi.mock('../api/notifications', () => ({
  getNotifications,
  markNotificationRead,
}))

const sampleAnnouncement: PublicAnnouncement = {
  id: 101,
  title: '普通更新公告',
  content: '这是普通公告内容',
  audience: 'all',
  priority: 100,
  presentation: 'notice',
  startsAt: new Date(Date.now() - 3600_000).toISOString(),
  endsAt: null,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  updatedAt: new Date(Date.now() - 3600_000).toISOString(),
  version: 1,
  status: 'published',
  readAt: null,
  acknowledgedAt: null,
}

describe('AnnouncementCenter Tab Prioritization (NTF-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getNotifications.mockResolvedValue({
      notifications: [
        {
          id: 501,
          userId: 1,
          type: 'order_delivered',
          title: '订单已发货',
          body: '您购买的卡密已发货',
          status: 'unread',
          createdAt: new Date().toISOString(),
          readAt: null,
          data: {},
        },
      ],
      total: 1,
      unreadCount: 1,
      page: 1,
      limit: 5,
    })
  })

  it('NTF-11: defaults to messages tab when unread messages exist, even if normal unread announcements exist', async () => {
    useAppStore.setState({ notificationUnreadCount: 3 })

    render(
      <BrowserRouter>
        <AnnouncementCenter
          open={true}
          onOpenChange={vi.fn()}
          items={[sampleAnnouncement]}
          unreadCount={1}
          onMarkRead={vi.fn().mockResolvedValue(undefined)}
          onAcknowledge={vi.fn().mockResolvedValue(undefined)}
          forceAnnouncementTab={false}
        />
      </BrowserRouter>
    )

    // NTF-11: 待确认公告优先打开公告 Tab，其他情况有未读消息时默认消息 Tab
    const messagesTab = screen.getByRole('tab', { name: /消息/ })
    expect(messagesTab).toHaveAttribute('aria-selected', 'true')
    const announcementsTab = screen.getByRole('tab', { name: /公告/ })
    expect(announcementsTab).toHaveAttribute('aria-selected', 'false')

    await waitFor(() => {
      expect(screen.getByText('订单已发货')).toBeInTheDocument()
    })
  })

  it('NTF-11: defaults to announcements tab when forceAnnouncementTab is true, even if unread messages exist', async () => {
    useAppStore.setState({ notificationUnreadCount: 5 })

    render(
      <BrowserRouter>
        <AnnouncementCenter
          open={true}
          onOpenChange={vi.fn()}
          items={[sampleAnnouncement]}
          unreadCount={1}
          onMarkRead={vi.fn().mockResolvedValue(undefined)}
          onAcknowledge={vi.fn().mockResolvedValue(undefined)}
          forceAnnouncementTab={true}
        />
      </BrowserRouter>
    )

    // forceAnnouncementTab triggers on acknowledgement_required or clicking announcement banner
    const announcementsTab = screen.getByRole('tab', { name: /公告/ })
    expect(announcementsTab).toHaveAttribute('aria-selected', 'true')
    const messagesTab = screen.getByRole('tab', { name: /消息/ })
    expect(messagesTab).toHaveAttribute('aria-selected', 'false')

    expect(screen.getByText('普通更新公告')).toBeInTheDocument()
  })

  it('defaults to announcements tab when there are no unread messages', async () => {
    useAppStore.setState({ notificationUnreadCount: 0 })

    render(
      <BrowserRouter>
        <AnnouncementCenter
          open={true}
          onOpenChange={vi.fn()}
          items={[sampleAnnouncement]}
          unreadCount={1}
          onMarkRead={vi.fn().mockResolvedValue(undefined)}
          onAcknowledge={vi.fn().mockResolvedValue(undefined)}
          forceAnnouncementTab={false}
        />
      </BrowserRouter>
    )

    const announcementsTab = screen.getByRole('tab', { name: /公告/ })
    expect(announcementsTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('普通更新公告')).toBeInTheDocument()
  })
})
