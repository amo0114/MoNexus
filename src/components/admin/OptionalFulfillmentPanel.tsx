import { lazy, Suspense, useEffect, useState } from 'react'
import { getFakaPluginStatus, setFakaPluginMounted, type FakaPluginStatus } from '../../api/adminIntegrations'
import { getApiErrorMessage } from '../../api/error'
import { useAdminCapabilities } from '../../stores/adminCapabilities'

const AdminFakaSettingsPanel = lazy(() => import('./AdminFakaSettingsPanel'))

export default function OptionalFulfillmentPanel() {
  const { optionalFulfillment, reload } = useAdminCapabilities()
  const [status, setStatus] = useState<FakaPluginStatus | undefined>(optionalFulfillment)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    void getFakaPluginStatus().then(value => { if (current) setStatus(value) }).catch(() => {})
    return () => { current = false }
  }, [])

  async function change(mounted: boolean) {
    setPending(true)
    setError('')
    try {
      setStatus(await setFakaPluginMounted(mounted))
      reload()
    } catch (failure) {
      setError(getApiErrorMessage(failure, '无法更新插件状态'))
    } finally {
      setPending(false)
    }
  }

  if (!status?.installed) return null
  return <>
    <section className="card p-4 mt-4 space-y-2">
      <h3 className="font-semibold">FakaBridge 履约插件</h3>
      <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => void change(!status.mounted)}>
        {status.mounted ? '注销插件' : '装载插件'}
      </button>
      {error && <p role="alert" className="text-sm">{error}</p>}
    </section>
    {status.mounted && <Suspense fallback={null}><AdminFakaSettingsPanel /></Suspense>}
  </>
}
