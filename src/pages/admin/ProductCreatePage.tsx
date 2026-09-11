import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import AdminPlatformProductWizard from '../../components/catalog/AdminPlatformProductWizard'

export default function ProductCreatePage() {
  const navigate = useNavigate()

  function goToAdmin() {
    navigate('/admin')
  }

  return (
    <div className="max-w-3xl mx-auto pb-16 fade-in" data-testid="admin-product-create-page">
      <button
        type="button"
        onClick={goToAdmin}
        className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] mb-4 cursor-pointer"
        data-testid="admin-product-create-back"
      >
        <ArrowLeft className="w-4 h-4" /> 返回
      </button>
      <h1 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-6">新建平台商品</h1>
      <AdminPlatformProductWizard open onClose={goToAdmin} onCreated={goToAdmin} />
    </div>
  )
}
