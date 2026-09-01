import { useEffect, useState } from 'react'
import { Coins } from 'lucide-react'
import {
  activateAdminPricePolicy,
  createAdminPricePolicy,
  listAdminPricePolicies,
  RP_CNY_VMQFOX_V1_CREATE_EXAMPLE,
  type AdminCreatePricePolicyBody,
  type AdminPricePolicy,
} from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import AdminPagination from '../AdminPagination'
import ConfirmDialog from '../../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import {
  formatCurrencyAmount,
  parseMajorInput,
} from '../../../pages/recharge/money'

const PAGE_SIZE = 50
const POLICY_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '生效中',
  retired: '已退役',
}

type FormState = {
  code: string
  currency: 'CNY' | 'USD'
  minYuan: string
  maxYuan: string
  stepYuan: string
  dailyYuan: string
  monthlyYuan: string
  pointsNumerator: string
  pointsDenominator: string
  limitTimeZone: string
  suggestedYuan: string
}

function exampleForm(): FormState {
  const example = RP_CNY_VMQFOX_V1_CREATE_EXAMPLE
  return {
    code: example.code,
    currency: 'CNY',
    minYuan: '1.00',
    maxYuan: '1000.00',
    stepYuan: '1.00',
    dailyYuan: '2000.00',
    monthlyYuan: '10000.00',
    pointsNumerator: example.pointsNumerator,
    pointsDenominator: example.pointsDenominator,
    limitTimeZone: example.limitTimeZone,
    suggestedYuan: '10, 30, 50, 100',
  }
}

function emptyForm(): FormState {
  return {
    code: '',
    currency: 'CNY',
    minYuan: '',
    maxYuan: '',
    stepYuan: '',
    dailyYuan: '',
    monthlyYuan: '',
    pointsNumerator: '1',
    pointsDenominator: '1',
    limitTimeZone: 'Asia/Shanghai',
    suggestedYuan: '',
  }
}

function parseYuanField(label: string, raw: string): string {
  const parsed = parseMajorInput(raw, 2)
  if (!parsed.ok) throw new Error(`${label}格式无效`)
  return parsed.minor
}

function buildCreateBody(form: FormState): AdminCreatePricePolicyBody {
  const suggested = form.suggestedYuan
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => ({
      amountMinor: parseYuanField(`推荐金额 ${item}`, item),
      sortOrder: index + 1,
    }))
  return {
    code: form.code.trim(),
    currency: form.currency,
    currencyScale: 2,
    pointsNumerator: form.pointsNumerator.trim(),
    pointsDenominator: form.pointsDenominator.trim(),
    roundingMode: 'HALF_EVEN',
    minAmountMinor: parseYuanField('最低金额', form.minYuan),
    maxAmountMinor: parseYuanField('最高金额', form.maxYuan),
    amountStepMinor: parseYuanField('金额步进', form.stepYuan),
    dailyLimitMinor: parseYuanField('日限额', form.dailyYuan),
    monthlyLimitMinor: parseYuanField('月限额', form.monthlyYuan),
    limitTimeZone: form.limitTimeZone.trim(),
    adminSandbox: false,
    suggestedAmounts: suggested,
  }
}

export default function AdminPricePolicies() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminPricePolicy[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(exampleForm)
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [activateTarget, setActivateTarget] = useState<AdminPricePolicy | null>(null)
  const [acting, setActing] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await listAdminPricePolicies({
        page,
        pageSize: PAGE_SIZE,
        adminSandbox: false,
      })
      setItems(data.items)
      setTotal(data.total)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载价格政策失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [page])

  return (
    <div className="space-y-4" data-testid="admin-price-policies">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-text-muted)]">
          创建只生成草稿。激活会退役同币种生产通道的当前生效政策，不会通过迁移自动生效。
        </p>
        <button
          type="button"
          className="btn-primary"
          onClick={() => { setForm(exampleForm()); setFormError(''); setCreating(true) }}
          data-testid="admin-price-policy-create"
        >
          创建生产草稿
        </button>
      </div>

      {loading && items.length === 0 ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState compact icon={Coins} title="暂无生产价格政策" description="可创建 rp-cny-vmqfox-v1 草稿，确认后再激活。" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>代码 / 版本</th>
                <th>币种</th>
                <th>积分比例</th>
                <th>金额范围</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} data-testid={`admin-price-policy-row-${item.code}`}>
                  <td data-label="代码 / 版本">
                    <div className="font-mono text-sm">{item.code}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">v{item.version}</div>
                  </td>
                  <td data-label="币种">{item.currency}</td>
                  <td data-label="积分比例">
                    {item.pointsNumerator}/{item.pointsDenominator} 分
                  </td>
                  <td data-label="金额范围">
                    <div className="whitespace-nowrap">
                      {formatCurrencyAmount(item.minAmountMinor, item.currency)}
                      {' – '}
                      {formatCurrencyAmount(item.maxAmountMinor, item.currency)}
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      步进 {formatCurrencyAmount(item.amountStepMinor, item.currency)}
                    </div>
                  </td>
                  <td data-label="状态">{POLICY_STATUS_LABEL[item.status] ?? item.status}</td>
                  <td className="text-right whitespace-nowrap" data-label="操作">
                    {item.status !== 'active' && (
                      <button
                        type="button"
                        className="text-sm font-bold text-[var(--color-primary)]"
                        onClick={() => setActivateTarget(item)}
                        data-testid={`admin-price-policy-activate-${item.code}`}
                      >
                        激活
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <Dialog open={creating} onOpenChange={(open) => { if (!open && !submitting) setCreating(false) }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>创建生产价格政策草稿</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-[var(--color-text-muted)]">
            1 分 = 1 积分时填写分子/分母为 1/1。创建后仍是草稿，需手动激活。
          </DialogDescription>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm font-bold sm:col-span-2">
              代码
              <input className="input mt-1 w-full" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} data-testid="admin-price-policy-code" />
            </label>
            <label className="text-sm font-bold">
              最低金额（元）
              <input className="input mt-1 w-full" value={form.minYuan} onChange={(e) => setForm({ ...form, minYuan: e.target.value })} />
            </label>
            <label className="text-sm font-bold">
              最高金额（元）
              <input className="input mt-1 w-full" value={form.maxYuan} onChange={(e) => setForm({ ...form, maxYuan: e.target.value })} />
            </label>
            <label className="text-sm font-bold">
              步进（元）
              <input className="input mt-1 w-full" value={form.stepYuan} onChange={(e) => setForm({ ...form, stepYuan: e.target.value })} />
            </label>
            <label className="text-sm font-bold">
              日限额（元）
              <input className="input mt-1 w-full" value={form.dailyYuan} onChange={(e) => setForm({ ...form, dailyYuan: e.target.value })} />
            </label>
            <label className="text-sm font-bold">
              月限额（元）
              <input className="input mt-1 w-full" value={form.monthlyYuan} onChange={(e) => setForm({ ...form, monthlyYuan: e.target.value })} />
            </label>
            <label className="text-sm font-bold">
              积分分子
              <input className="input mt-1 w-full" value={form.pointsNumerator} onChange={(e) => setForm({ ...form, pointsNumerator: e.target.value })} />
            </label>
            <label className="text-sm font-bold">
              积分分母
              <input className="input mt-1 w-full" value={form.pointsDenominator} onChange={(e) => setForm({ ...form, pointsDenominator: e.target.value })} />
            </label>
            <label className="text-sm font-bold sm:col-span-2">
              推荐金额（元，逗号分隔）
              <input className="input mt-1 w-full" value={form.suggestedYuan} onChange={(e) => setForm({ ...form, suggestedYuan: e.target.value })} data-testid="admin-price-policy-suggested" />
            </label>
          </div>
          {formError && <p className="mt-2 text-sm text-[var(--color-danger)]">{formError}</p>}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => { setForm(exampleForm()); setFormError('') }}
              data-testid="admin-price-policy-fill-example"
            >
              填充 VMQFox CNY 示例
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={submitting}
              onClick={() => {
                setSubmitting(true)
                setFormError('')
                try {
                  const body = buildCreateBody(form)
                  createAdminPricePolicy(body)
                    .then((created) => {
                      showToast(`已创建草稿 ${created.code}`)
                      setCreating(false)
                      setForm(emptyForm())
                      void load()
                    })
                    .catch((err) => setFormError(getApiErrorMessage(err, '创建失败')))
                    .finally(() => setSubmitting(false))
                } catch (err) {
                  setFormError(err instanceof Error ? err.message : '创建失败')
                  setSubmitting(false)
                }
              }}
              data-testid="admin-price-policy-submit"
            >
              {submitting ? '创建中…' : '创建草稿'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={activateTarget != null}
        onOpenChange={(open) => { if (!open && !acting) setActivateTarget(null) }}
        title="激活该价格政策？"
        description="将退役同币种生产通道的当前生效政策。历史充值仍按下单时冻结的政策计价。"
        confirmLabel="确认激活"
        tone="primary"
        loading={acting}
        onConfirm={() => {
          if (!activateTarget) return
          setActing(true)
          activateAdminPricePolicy(activateTarget.id)
            .then(() => {
              showToast('价格政策已激活')
              setActivateTarget(null)
              void load()
            })
            .catch((err) => showToast(getApiErrorMessage(err, '激活失败'), 'error'))
            .finally(() => setActing(false))
        }}
      />
    </div>
  )
}
