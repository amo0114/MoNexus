import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminConfigPanel from './AdminConfigPanel'
import * as adminConfigApi from '../../api/adminConfig'
import { bpsToPercentString, percentStringToBps } from './adminConfigMeta'

// Mock adminConfig API
vi.mock('../../api/adminConfig', () => ({
  getAdminConfig: vi.fn(),
  updateAdminConfig: vi.fn(),
}))

const MOCK_CONFIGS: adminConfigApi.AdminSystemConfig[] = [
  // 注册与邀请
  {
    key: 'registrationEnabled',
    value: 1,
    defaultValue: 1,
    description: '允许新用户注册',
    group: '注册与邀请',
    unit: null,
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'registrationInviteOnly',
    value: 0,
    defaultValue: 0,
    description: '注册必须使用邀请码',
    group: '注册与邀请',
    unit: null,
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'emailVerificationRequiredForValue',
    value: 1,
    defaultValue: 1,
    description: '交易与积分操作前须验证邮箱',
    group: '注册与邀请',
    unit: null,
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'referralInviterMinAgeDays',
    value: 7,
    defaultValue: 7,
    description: '邀请人最小账户年龄',
    group: '注册与邀请',
    unit: '天',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'referralDailyQualifiedLimit',
    value: 10,
    defaultValue: 10,
    description: '邀请码每日合格人数上限',
    group: '注册与邀请',
    unit: '人',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'referralLifetimeQualifiedLimit',
    value: 100,
    defaultValue: 100,
    description: '邀请码生命周期合格人数上限',
    group: '注册与邀请',
    unit: '人',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'inviteMinTierRank',
    value: 0,
    defaultValue: 0,
    description: '普通用户发码会员等级门槛',
    group: '注册与邀请',
    unit: null,
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'inviteQuotaUserMonthly',
    value: 5,
    defaultValue: 5,
    description: '普通用户每月邀请名额',
    group: '注册与邀请',
    unit: '枚',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'inviteQuotaMerchantMonthly',
    value: 50,
    defaultValue: 50,
    description: '商家每月邀请名额',
    group: '注册与邀请',
    unit: '枚',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'inviteCodeTtlDays',
    value: 30,
    defaultValue: 30,
    description: '邀请码有效期',
    group: '注册与邀请',
    unit: '天',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },

  // 基础奖励
  {
    key: 'registerReward',
    value: 100,
    defaultValue: 100,
    description: '新用户注册奖励积分',
    group: '基础奖励',
    unit: '积分',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'checkinReward',
    value: 10,
    defaultValue: 10,
    description: '每日签到奖励积分',
    group: '基础奖励',
    unit: '积分',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'inviteReward',
    value: 50,
    defaultValue: 50,
    description: '邀请新用户奖励积分',
    group: '基础奖励',
    unit: '积分',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'growthRewardHoldDays',
    value: 7,
    defaultValue: 7,
    description: '注册与邀请奖励冷静期',
    group: '基础奖励',
    unit: '天',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },

  // 会员等级
  {
    key: 'memberTierSilverThreshold',
    value: 1000,
    defaultValue: 1000,
    description: '银卡会员累计积分门槛',
    group: '会员等级',
    unit: '积分',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'memberTierGoldThreshold',
    value: 5000,
    defaultValue: 5000,
    description: '金卡会员累计积分门槛',
    group: '会员等级',
    unit: '积分',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'memberTierPlatinumThreshold',
    value: 20000,
    defaultValue: 20000,
    description: '铂金会员累计积分门槛',
    group: '会员等级',
    unit: '积分',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'memberTierSilverBonusBps',
    value: 500, // 5%
    defaultValue: 500,
    description: '银卡额外加成基点',
    group: '会员等级',
    unit: '%',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'memberTierGoldBonusBps',
    value: 1000, // 10%
    defaultValue: 1000,
    description: '金卡额外加成基点',
    group: '会员等级',
    unit: '%',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: 'memberTierPlatinumBonusBps',
    value: 2000, // 20%
    defaultValue: 2000,
    description: '铂金额外加成基点',
    group: '会员等级',
    unit: '%',
    hint: null,
    updatedAt: null,
    updatedBy: null,
  },
]

describe('AdminConfigPanel & B2 Specifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(adminConfigApi.getAdminConfig).mockResolvedValue(MOCK_CONFIGS)
  })

  it('accurately converts between percentage strings and integer basis points', () => {
    expect(bpsToPercentString(500)).toBe('5')
    expect(bpsToPercentString(525)).toBe('5.25')
    expect(bpsToPercentString(0)).toBe('0')

    expect(percentStringToBps('5')).toEqual({ value: 500 })
    expect(percentStringToBps('5.25')).toEqual({ value: 525 })
    expect(percentStringToBps('0.01')).toEqual({ value: 1 })
    expect(percentStringToBps('100')).toEqual({ value: 10000 })
    expect(percentStringToBps('5.255').error).toBe('百分比最多支持两位小数')
    expect(percentStringToBps('101').error).toBe('百分比必须在 0% ~ 100% 之间')
    expect(percentStringToBps('-1').error).toBe('百分比最多支持两位小数')
  })

  it('renders all 7 group tabs and loads configs from single source', async () => {
    render(<AdminConfigPanel />)
    expect(screen.getByText('加载中...')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '注册与邀请' })).toBeInTheDocument()
    })

    const groupTitles = [
      '注册与邀请',
      '基础奖励',
      '会员等级',
      '交易与交付',
      '库存提醒',
      '商品运营',
      '高级运维',
    ]

    for (const title of groupTitles) {
      expect(screen.getByRole('tab', { name: title })).toBeInTheDocument()
    }
  })

  it('switches between group tabs while preserving draft inputs in memory', async () => {
    render(<AdminConfigPanel />)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '基础奖励' })).toBeInTheDocument()
    })

    // Switch to 基础奖励
    fireEvent.click(screen.getByRole('tab', { name: '基础奖励' }))

    const checkinInput = await screen.findByTestId('admin-config-input-checkinReward')
    expect(checkinInput).toHaveValue(10)

    // Edit input draft
    fireEvent.change(checkinInput, { target: { value: '25' } })
    expect(checkinInput).toHaveValue(25)

    // Switch away to 会员等级
    fireEvent.click(screen.getByRole('tab', { name: '会员等级' }))
    expect(await screen.findByText('青铜会员')).toBeInTheDocument()

    // Switch back to 基础奖励
    fireEvent.click(screen.getByRole('tab', { name: '基础奖励' }))
    const checkinInputAgain = screen.getByTestId('admin-config-input-checkinReward')
    expect(checkinInputAgain).toHaveValue(25) // draft preserved in memory!
  })

  it('enforces strictly increasing order on member tier thresholds', async () => {
    render(<AdminConfigPanel />)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '会员等级' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('tab', { name: '会员等级' }))
    await screen.findByText('青铜会员')

    // Current silver=1000, gold=5000, platinum=20000
    // Try setting silver threshold >= gold (5000)
    const silverInput = screen.getByTestId('admin-config-input-memberTierSilverThreshold')
    fireEvent.change(silverInput, { target: { value: '6000' } })

    const silverSave = screen.getByTestId('admin-config-save-memberTierSilverThreshold')
    fireEvent.click(silverSave)

    // updateAdminConfig must not be called
    expect(adminConfigApi.updateAdminConfig).not.toHaveBeenCalled()
    expect(screen.getByText(/银卡门槛必须小于金卡门槛/)).toBeInTheDocument()
  })

  it('saves percentage bonus by converting to bps', async () => {
    vi.mocked(adminConfigApi.updateAdminConfig).mockResolvedValue({
      key: 'memberTierSilverBonusBps',
      value: 750,
      defaultValue: 500,
      description: '银卡额外加成基点',
      group: '会员等级',
      unit: '%',
      hint: null,
      updatedAt: null,
      updatedBy: null,
    })

    render(<AdminConfigPanel />)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '会员等级' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('tab', { name: '会员等级' }))

    const silverBonusInput = await screen.findByTestId('admin-config-input-memberTierSilverBonusBps')
    expect(silverBonusInput).toHaveValue(5) // converted from 500 bps

    fireEvent.change(silverBonusInput, { target: { value: '7.5' } })
    const silverBonusSave = screen.getByTestId('admin-config-save-memberTierSilverBonusBps')
    fireEvent.click(silverBonusSave)

    await waitFor(() => {
      // Must have converted 7.5% -> 750 bps
      expect(adminConfigApi.updateAdminConfig).toHaveBeenCalledWith('memberTierSilverBonusBps', 750)
    })
  })

  it('handles save failures without fake success, retaining draft and displaying error', async () => {
    vi.mocked(adminConfigApi.updateAdminConfig).mockRejectedValue({
      response: { data: { error: '网络超时，保存失败' } },
    })

    render(<AdminConfigPanel />)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '基础奖励' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('tab', { name: '基础奖励' }))

    const checkinInput = await screen.findByTestId('admin-config-input-checkinReward')
    fireEvent.change(checkinInput, { target: { value: '30' } })

    const saveBtn = screen.getByTestId('admin-config-save-checkinReward')
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(screen.getByText('网络超时，保存失败')).toBeInTheDocument()
    })
    // Draft is retained
    expect(checkinInput).toHaveValue(30)
  })
})
