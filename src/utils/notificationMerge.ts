export function mergeNotificationFirstPage<T extends { id: number }>(first: T[], history: T[]): T[] {
  const incoming = new Map(first.map((item) => [item.id, item]))
  return [...first, ...history.filter((item) => !incoming.has(item.id))]
}

export function appendUniqueNotifications<T extends { id: number }>(history: T[], page: T[]): T[] {
  const seen = new Set(history.map((item) => item.id))
  return [...history, ...page.filter((item) => !seen.has(item.id))]
}
