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
import {
  formatFenPointRatio,
  previewTenYuanCredit,
  vmqfoxCnyExampleRateMismatch,
} from '../../../pages/recharge/pricePolicyPreview'

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

function activateConfirmCopy(target: AdminPricePolicy, currentActive: AdminPricePolicy | undefined): {
  title: string
  description: string
} {
  const preview = previewTenYuanCredit(target)
  const ratio = formatFenPointRatio(target.pointsNumerator, target.pointsDenominator)
  const rate = [ratio, preview?.preview].filter(Boolean).join('；')
  const retire = currentActive
    ? `将退役当前生效政策 ${currentActive.code}。`
    : '当前生产通道没有生效政策。'
  return {
    title: `激活草稿 ${target.code}？`,
    description: `${rate}。${retire}历史充值仍按下单时冻结的政策计价。`,
  }
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

  const createPreview = previewTenYuanCredit({
    currency: form.currency,
    pointsNumerator: form.pointsNumerator,
    pointsDenominator: form.pointsDenominator,
  })
  const createExampleMismatch = vmqfoxCnyExampleRateMismatch(form)
  const currentActive = items.find((item) => item.status === 'active')
  const activateCopy = activateTarget ? activateConfirmCopy(activateTarget, currentActive) : null

  return (
    <div className="space-y-4" data-testid="admin-price-policies">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-[var(--color-text)]">充值金额与积分兑换规则</h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            配置不同币种下的充值换算比率与充值限额。创建只生成草稿，激活将替换同币种当前生效政策。
          </p>
        </div>
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
                <th>规则代码 / 版本</th>
                <th>适用币种</th>
                <th>兑换规则</th>
                <th>充值金额范围</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const preview = previewTenYuanCredit(item)
                return (
                <tr key={item.id} data-testid={`admin-price-policy-row-${item.code}`}>
                  <td data-label="规则代码 / 版本">
                    <div className="font-mono text-sm font-semibold text-[var(--color-text)]">{item.code}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">v{item.version}</div>
                  </td>
                  <td data-label="适用币种">{item.currency}</td>
                  <td data-label="兑换规则">
                    <div className="text-xs font-semibold text-[var(--color-text)]">
                      每 {item.pointsDenominator} {item.currency === 'CNY' ? '分人民币' : '美分'} 兑换 {item.pointsNumerator} 积分
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)] font-mono mt-0.5">
                      {formatFenPointRatio(item.pointsNumerator, item.pointsDenominator)
                        ?? `${item.pointsNumerator}/${item.pointsDenominator}`}
                    </div>
                    {preview && (
                      <div className="text-xs text-[var(--color-cta)] mt-0.5">
                        {preview.preview}
                      </div>
                    )}
                  </td>
                  <td data-label="充值金额范围">
                    <div className="whitespace-nowrap font-medium text-[var(--color-text)]">
                      {formatCurrencyAmount(item.minAmountMinor, item.currency)}
                      {' – '}
                      {formatCurrencyAmount(item.maxAmountMinor, item.currency)}
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      步进 {formatCurrencyAmount(item.amountStepMinor, item.currency)}
                    </div>
                  </td>
                  <td data-label="状态">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border border-[var(--color-border)] bg-[var(--color-background)]">
                      {POLICY_STATUS_LABEL[item.status] ?? item.status}
                    </span>
                  </td>
                  <td className="text-right whitespace-nowrap" data-label="操作">
                    {item.status === 'draft' && (
                      <button
                        type="button"
                        className="text-sm font-bold text-[var(--color-primary)] hover:underline cursor-pointer"
                        onClick={() => setActivateTarget(item)}
                        data-testid={`admin-price-policy-activate-${item.code}`}
                      >
                        激活
                      </button>
                    )}
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <Dialog open={creating} onOpenChange={(open) => { if (!open && !submitting) setCreating(false) }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>创建生产价格政策草稿</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-[var(--color-text-muted)]">
            设置充值换算比率与金额额度。创建后生成草稿，确认无误后可在列表手动激活。
          </DialogDescription>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 兑换比率：每 N 分人民币兑换 M 积分 */}
            <div className="sm:col-span-2 p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]">
              <div className="text-xs font-bold text-[var(--color-text)] mb-1.5">兑换比率设置</div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text)]">
                <span>每</span>
                <label htmlFor="admin-price-policy-denominator" className="sr-only">基准充值金额（分）</label>
                <input
                  id="admin-price-policy-denominator"
                  className="input py-1 px-2 w-20 text-center font-bold"
                  value={form.pointsDenominator}
                  onChange={(e) => setForm({ ...form, pointsDenominator: e.target.value })}
                  data-testid="admin-price-policy-denominator"
                  placeholder="分母"
                />
                <span>分{form.currency === 'CNY' ? '人民币' : '货币'}，可兑换</span>
                <label htmlFor="admin-price-policy-numerator" className="sr-only">对应获得的积分数</label>
                <input
                  id="admin-price-policy-numerator"
                  className="input py-1 px-2 w-24 text-center font-bold"
                  value={form.pointsNumerator}
                  onChange={(e) => setForm({ ...form, pointsNumerator: e.target.value })}
                  data-testid="admin-price-policy-numerator"
                  placeholder="分子"
                />
                <span>积分</span>
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-1.5">
                以最小货币单位计（1 元 = 100 分）。例如填写每 1 分兑换 1 积分，则充值 10.00 元（1000 分）到账 1000 积分。
              </div>
            </div>

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
            <label className="text-sm font-bold sm:col-span-2">
              月限额（元）
              <input className="input mt-1 w-full" value={form.monthlyYuan} onChange={(e) => setForm({ ...form, monthlyYuan: e.target.value })} />
            </label>
            <label className="text-sm font-bold sm:col-span-2">
              推荐金额（元，逗号分隔）
              <input className="input mt-1 w-full" value={form.suggestedYuan} onChange={(e) => setForm({ ...form, suggestedYuan: e.target.value })} data-testid="admin-price-policy-suggested" />
            </label>

            {/* 高级技术参数折叠 */}
            <details className="sm:col-span-2 rounded-lg border border-[var(--color-border)] p-3 text-xs bg-[var(--color-background)]/50">
              <summary className="cursor-pointer font-bold text-[var(--color-text)] hover:text-[var(--color-primary)] transition-colors">
                高级技术参数（规则代号与时区）
              </summary>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-xs font-bold sm:col-span-2">
                  规则代号 (Rule Code)
                  <input
                    className="input mt-1 w-full font-mono text-xs"
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                    data-testid="admin-price-policy-code"
                  />
                  <span className="font-normal text-[var(--color-text-muted)] mt-0.5 block">系统策略代号，如 rp-cny-vmqfox-v1</span>
                </label>
                <label className="text-xs font-bold">
                  小数位数 (Scale)
                  <input
                    className="input mt-1 w-full bg-[var(--color-background)]"
                    disabled
                    value="2 位小数（最小单位：分）"
                  />
                </label>
                <label className="text-xs font-bold">
                  限额统计时区 (Time Zone)
                  <input
                    className="input mt-1 w-full font-mono text-xs"
                    value={form.limitTimeZone}
                    onChange={(e) => setForm({ ...form, limitTimeZone: e.target.value })}
                  />
                </label>
              </div>
            </details>
          </div>
          {createPreview && (
            <p className="mt-3 text-sm font-bold text-[var(--color-text)]" data-testid="admin-price-policy-rate-preview">
              每 {form.pointsDenominator} 分{form.currency === 'CNY' ? '人民币' : '货币'}可兑换 {form.pointsNumerator} 积分（{createPreview.ratio}）；{createPreview.preview}
            </p>
          )}
          {createExampleMismatch && (
            <p className="mt-2 text-sm text-[var(--color-danger)]" data-testid="admin-price-policy-rate-mismatch">
              当前兑换比率不符合标准设定（参考标准：每 1 分人民币兑换 1 积分，即 1 PTS / 1 分，¥10.00 → 1000 积分，非 1 元 1 积分）。
            </p>
          )}
          {formError && <p className="mt-2 text-sm text-[var(--color-danger)]">{formError}</p>}
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <div className="flex flex-col items-start mr-auto">
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => { setForm(exampleForm()); setFormError('') }}
                data-testid="admin-price-policy-fill-example"
              >
                填入人民币充值草稿示例
              </button>
              <span className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                仅填充表单，不保存、不启用
              </span>
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={submitting || createExampleMismatch}
              onClick={() => {
                if (createExampleMismatch) return
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
        title={activateCopy?.title ?? '激活草稿？'}
        description={activateCopy?.description}
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
