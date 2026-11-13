import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { UserRole } from '../types/merchant'
import type { MerchantCapability } from '../types/governance'
import { hasMerchantCapability } from '../auth/merchantAccess'

interface RoleGuardProps {
  children: React.ReactNode
  allowedRoles: UserRole[]
  requireActiveMerchant?: boolean
  /**
   * With a governance-v1 backend, merchant routes are gated by capability
   * instead of role + active status, so a suspended merchant can still open
   * read-only history. Ignored on older backends (no merchantCapabilities).
   */
  merchantCapability?: MerchantCapability
}

export default function RoleGuard({ children, allowedRoles, requireActiveMerchant, merchantCapability }: RoleGuardProps) {
  const user = useAuthStore((s) => s.user)

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (merchantCapability && Array.isArray(user.merchantCapabilities)) {
    if (hasMerchantCapability(user, merchantCapability)) return <>{children}</>
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <h2 className="text-xl font-bold mb-2">暂不可用</h2>
        <p className="text-[var(--color-text-muted)]">
          {user.accountStatus === 'banned'
            ? '你的账号已被封禁，商家功能不可用'
            : user.merchantStatus === 'suspended'
              ? '商家经营已停用，此功能暂不可用；历史订单与资料仍可在商家中心查看'
              : '当前商家状态不支持此功能'}
        </p>
      </div>
    )
  }

  if (!allowedRoles.includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <h2 className="text-xl font-bold mb-2">访问被拒绝</h2>
        <p className="text-[var(--color-text-muted)]">你没有权限访问此页面</p>
      </div>
    )
  }

  if (requireActiveMerchant) {
    if (user.role !== 'merchant' || user.merchant?.status !== 'active') {
      return (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <h2 className="text-xl font-bold mb-2">需要商家权限</h2>
          <p className="text-gray-500">
            {user.merchant?.status === 'pending'
              ? '你的商家入驻申请正在审核中'
              : user.merchant?.status === 'rejected'
              ? '你的商家入驻申请已被拒绝'
              : user.merchant?.status === 'suspended'
              ? '你的商家账号已被停用'
              : '你还没有入驻成为商家'}
          </p>
        </div>
      )
    }
  }

  return <>{children}</>
}
