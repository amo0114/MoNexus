import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPointLogPanel from './AdminPointLogPanel'
import * as apiModule from '../../api/adminPointLogs'

vi.mock('../../api/adminPointLogs')

const mockPointLogs: apiModule.AdminPointLogItem[] = [
  {
    id: 101,
    userId: 1,
    type: 'in',
    amount: 1000,
    balanceAfter: 6000,
    reason: '充值到账',
    orderId: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    user: { id: 1, email: 'admin@test.local', nickname: '管理员' },
  },
  {
    id: 102,
    userId: 2,
    type: 'out',
    amount: 2500,
    balanceAfter: 3500,
    reason: '订单支付',
    orderId: 888,
    createdAt: '2026-09-01T11:00:00.000Z',
    user: { id: 2, email: 'user@test.local', nickname: '买家' },
  },
  {
    id: 103,
    userId: 3,
    type: 'sandbox_in',
    amount: 5000,
    balanceAfter: 5000,
    reason: '沙箱充值',
    orderId: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    user: { id: 3, email: 'tester@test.local', nickname: '测试员' },
  },
]

describe('AdminPointLogPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders table with items, thousand-separator amounts, and Chinese type labels', async () => {
    vi.mocked(apiModule.listAdminPointLogs).mockResolvedValueOnce({
      items: mockPointLogs,
      total: 3,
      page: 1,
      pageSize: 20,
    })

    render(<AdminPointLogPanel active={true} />)

    // Verify headers
    expect(screen.getByText('积分流水')).toBeInTheDocument()
    expect(await screen.findByText('充值到账')).toBeInTheDocument()

    const badges = screen.getAllByTestId('point-log-type-badge')
    expect(badges).toHaveLength(3)

    // Row 1: in, +1,000, 6,000, 入账
    expect(screen.getByText('+1,000')).toBeInTheDocument()
    expect(screen.getByText('6,000')).toBeInTheDocument()
    expect(badges[0]).toHaveTextContent('入账')

    // Row 2: out, −2,500, 3,500, 已支付, 关联订单 #888
    expect(screen.getByText('−2,500')).toBeInTheDocument()
    expect(screen.getByText('3,500')).toBeInTheDocument()
    expect(badges[1]).toHaveTextContent('已支付')
    expect(screen.getByText('关联订单 #888')).toBeInTheDocument()

    // Row 3: sandbox_in, +5,000, 5,000, 沙箱入账
    expect(screen.getByText('+5,000')).toBeInTheDocument()
    expect(screen.getByText('5,000')).toBeInTheDocument()
    expect(badges[2]).toHaveTextContent('沙箱入账')
  })

  it('renders empty state when no items are returned', async () => {
    vi.mocked(apiModule.listAdminPointLogs).mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    render(<AdminPointLogPanel active={true} />)

    expect(await screen.findByText('暂无积分流水')).toBeInTheDocument()
  })

  it('renders error state and allows retry on API failure', async () => {
    vi.mocked(apiModule.listAdminPointLogs)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        items: mockPointLogs,
        total: 3,
        page: 1,
        pageSize: 20,
      })

    render(<AdminPointLogPanel active={true} />)

    expect(await screen.findByText('Network error')).toBeInTheDocument()

    // Click retry button
    const retryBtn = screen.getByRole('button', { name: '重试' })
    fireEvent.click(retryBtn)

    expect(await screen.findByText('充值到账')).toBeInTheDocument()
  })

  it('applies filters on search and resets page to 1', async () => {
    vi.mocked(apiModule.listAdminPointLogs).mockResolvedValue({
      items: mockPointLogs,
      total: 3,
      page: 1,
      pageSize: 20,
    })

    render(<AdminPointLogPanel active={true} />)
    await screen.findByText('充值到账')

    // Fill filter form
    fireEvent.change(screen.getByTestId('admin-point-logs-user-id-filter'), {
      target: { value: '42' },
    })
    fireEvent.change(screen.getByTestId('admin-point-logs-email-filter'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.change(screen.getByTestId('admin-point-logs-type-filter'), {
      target: { value: 'out' },
    })
    fireEvent.change(screen.getByTestId('admin-point-logs-from-filter'), {
      target: { value: '2026-09-01' },
    })
    fireEvent.change(screen.getByTestId('admin-point-logs-to-filter'), {
      target: { value: '2026-09-02' },
    })

    // Click search button
    fireEvent.click(screen.getByTestId('admin-point-logs-search-button'))

    await waitFor(() => {
      expect(apiModule.listAdminPointLogs).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
        userId: 42,
        email: 'user@example.com',
        type: 'out',
        from: '2026-09-01',
        to: '2026-09-02',
      })
    })
  })

  it('clears form inputs and requests page 1 on reset', async () => {
    vi.mocked(apiModule.listAdminPointLogs).mockResolvedValue({
      items: mockPointLogs,
      total: 3,
      page: 1,
      pageSize: 20,
    })

    render(<AdminPointLogPanel active={true} />)
    await screen.findByText('充值到账')

    // Fill filter form
    const userIdInput = screen.getByTestId('admin-point-logs-user-id-filter')
    fireEvent.change(userIdInput, { target: { value: '99' } })
    fireEvent.click(screen.getByTestId('admin-point-logs-search-button'))

    await waitFor(() => {
      expect(apiModule.listAdminPointLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: 99 }),
      )
    })

    // Click reset button
    fireEvent.click(screen.getByTestId('admin-point-logs-reset-button'))

    expect(userIdInput).toHaveValue('')

    await waitFor(() => {
      expect(apiModule.listAdminPointLogs).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
      })
    })
  })

  it('validates form inputs and prevents search when invalid', async () => {
    vi.mocked(apiModule.listAdminPointLogs).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    render(<AdminPointLogPanel active={true} />)
    await screen.findByText('暂无积分流水')
    vi.mocked(apiModule.listAdminPointLogs).mockClear()

    // Input invalid email
    const emailInput = screen.getByTestId('admin-point-logs-email-filter')
    fireEvent.change(emailInput, { target: { value: 'not-an-email' } })
    fireEvent.click(screen.getByTestId('admin-point-logs-search-button'))

    expect(await screen.findByTestId('admin-point-logs-email-error')).toHaveTextContent('请输入有效的邮箱地址')
    expect(emailInput).toHaveAttribute('aria-invalid', 'true')
    expect(apiModule.listAdminPointLogs).not.toHaveBeenCalled()

    // Fix email, input invalid date range
    fireEvent.change(emailInput, { target: { value: 'valid@example.com' } })
    fireEvent.change(screen.getByTestId('admin-point-logs-from-filter'), {
      target: { value: '2026-09-05' },
    })
    fireEvent.change(screen.getByTestId('admin-point-logs-to-filter'), {
      target: { value: '2026-09-04' },
    })
    fireEvent.click(screen.getByTestId('admin-point-logs-search-button'))

    expect(await screen.findByTestId('admin-point-logs-date-error')).toHaveTextContent('开始日期不能晚于结束日期')
    expect(apiModule.listAdminPointLogs).not.toHaveBeenCalled()
  })

  it('validates user ID: rejects 0, negative numbers, decimals, and unsafe integers before sending request', async () => {
    vi.mocked(apiModule.listAdminPointLogs).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    render(<AdminPointLogPanel active={true} />)
    await screen.findByText('暂无积分流水')
    vi.mocked(apiModule.listAdminPointLogs).mockClear()

    const userIdInput = screen.getByTestId('admin-point-logs-user-id-filter')
    const searchBtn = screen.getByTestId('admin-point-logs-search-button')

    const invalidInputs = ['0', '-1', '3.14', '99999999999999999999999999999']
    for (const invalid of invalidInputs) {
      fireEvent.change(userIdInput, { target: { value: invalid } })
      fireEvent.click(searchBtn)

      expect(await screen.findByTestId('admin-point-logs-user-id-error')).toHaveTextContent(
        '用户 ID 必须为有效的正整数',
      )
      expect(userIdInput).toHaveAttribute('aria-invalid', 'true')
      expect(apiModule.listAdminPointLogs).not.toHaveBeenCalled()
    }
  })

  it('displays pure Chinese labels in type dropdown and does not expose raw English enums', async () => {
    vi.mocked(apiModule.listAdminPointLogs).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    render(<AdminPointLogPanel active={true} />)
    await screen.findByText('暂无积分流水')

    const typeSelect = screen.getByTestId('admin-point-logs-type-filter')
    const options = Array.from(typeSelect.querySelectorAll('option'))

    // Verify option labels are strictly pure Chinese without "(in)", "(out)", etc.
    const optionLabels = options.map((o) => o.textContent?.trim())
    expect(optionLabels).toEqual([
      '全部类型',
      '入账',
      '已支付',
      '待支付',
      '已返还',
      '退款',
      '沙箱入账',
    ])

    // Verify no option label contains English letters
    for (const label of optionLabels) {
      expect(label).not.toMatch(/[a-zA-Z]/)
    }

    // Verify option values preserve backend enums
    const optionValues = options.map((o) => o.value)
    expect(optionValues).toEqual(['', 'in', 'out', 'hold', 'release', 'refund', 'sandbox_in'])
  })

  it('renders error state when API contract violation occurs (e.g. array returned instead of envelope)', async () => {
    vi.mocked(apiModule.listAdminPointLogs).mockRejectedValueOnce(
      new Error('积分流水接口契约异常：预期分页对象格式 { items, total, page, pageSize }'),
    )

    render(<AdminPointLogPanel active={true} />)

    expect(await screen.findByText('积分流水接口契约异常：预期分页对象格式 { items, total, page, pageSize }')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('ignores stale response when racing requests occur', async () => {
    let resolveFirst: (v: any) => void = () => {}
    let resolveSecond: (v: any) => void = () => {}

    vi.mocked(apiModule.listAdminPointLogs)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          }),
      )

    render(<AdminPointLogPanel active={true} />)

    // Trigger second request (search)
    fireEvent.change(screen.getByTestId('admin-point-logs-user-id-filter'), {
      target: { value: '1' },
    })
    fireEvent.click(screen.getByTestId('admin-point-logs-search-button'))

    // Resolve second request first
    resolveSecond({
      items: [mockPointLogs[0]],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    expect(await screen.findByText('充值到账')).toBeInTheDocument()

    // Now resolve first request with older data
    resolveFirst({
      items: [mockPointLogs[1]],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    // Row from second request should remain displayed, not overwritten by stale first request
    expect(screen.getByText('充值到账')).toBeInTheDocument()
    expect(screen.queryByText('订单支付')).not.toBeInTheDocument()
  })
})
