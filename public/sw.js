// SPEC-ENGAGE-001 PW-01：只处理推送与点击，不做离线缓存、不拦截 fetch，
// 版本切换仍由页面侧 chunkRecovery 与 nginx 缓存策略负责。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }
  const title = typeof payload.title === 'string' ? payload.title : 'MoNexus'
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof payload.body === 'string' ? payload.body : '',
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    icon: '/brand/ledger-knot/favicon-light-192.png',
    data: { deeplink: payload.deeplink },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const raw = event.notification.data && event.notification.data.deeplink
  // 只打开同源路径，忽略任何绝对地址或协议相对地址。
  const path = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
  const target = new URL(path, self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        await client.focus()
        if ('navigate' in client) await client.navigate(target)
        return
      }
    }
    await self.clients.openWindow(target)
  })())
})
