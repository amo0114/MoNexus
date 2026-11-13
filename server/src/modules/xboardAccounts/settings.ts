import { fakaBridgeConfig, fakaInstanceId } from '../../lib/runtimeSettings/fakaBridge.js'
import { config } from '../../config/index.js'
import { HttpError } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'

export function unavailable() { return new HttpError(503, 'XBOARD_CAPABILITY_UNAVAILABLE', '套餐查询暂不可用，请稍后重试') }
export function unresolved() { return new HttpError(409, 'XBOARD_ACCOUNT_UNRESOLVED', '账号关联待核验，请联系管理员处理历史关联') }

export function accountSettings() {
  const instanceId = fakaInstanceId()
  const bridge = fakaBridgeConfig()
  if (!instanceId || !bridge.enabled) throw unavailable()
  const target = new URL(bridge.url)
  if (target.username || target.password || target.search || target.hash
    || !/^\/plugin\/faka-bridge\/order-paid\/?$/.test(target.pathname)
    || (target.protocol !== 'https:' && !(target.protocol === 'http:' && fakaBridgeConfig().allowInsecureTargets))) throw unavailable()
  return { instanceId, origin: target.origin }
}

export async function requireInstance() {
  const settings = accountSettings()
  const row = await prisma.xboardInstance.findUnique({ where: { id: settings.instanceId } })
  if (!row || row.origin !== settings.origin) throw unavailable()
  return settings
}
