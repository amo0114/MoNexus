import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { UserRole } from '../types/merchant'

interface RoleGuardProps {
  children: React.ReactNode
  allowedRoles: UserRole[]
  requireActiveMerchant?: boolean
}

export default function RoleGuard({ children, allowedRoles, requireActiveMerchant }: RoleGuardProps) {
  const user = useAuthStore((s) => s.user)

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (!allowedRoles.includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <h2 className="text-xl font-bold mb-2">访问被拒绝</h2>
        <p className="text-gray-500">您没有权限访问此页面</p>
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
              ? '您的商家入驻申请正在审核中'
              : user.merchant?.status === 'rejected'
              ? '您的商家入驻申请已被拒绝'
              : user.merchant?.status === 'suspended'
              ? '您的商家账号已被停用'
              : '您还没有入驻成为商家'}
          </p>
        </div>
      )
    }
  }

  return <>{children}</>
}
