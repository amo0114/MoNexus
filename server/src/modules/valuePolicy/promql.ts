export type PromqlSelector = {
  metric: string
  labels: Record<string, string>
}

const SELECTOR = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?:\{([^}]*)\})?/g

export function extractPromqlSelectors(expr: string): PromqlSelector[] {
  const selectors: PromqlSelector[] = []
  for (const match of expr.matchAll(SELECTOR)) {
    const metric = match[1]
    if (
      metric === 'increase'
      || metric === 'rate'
      || metric === 'sum'
      || metric === 'and'
      || metric === 'or'
      || metric === 'unless'
    ) {
      continue
    }
    const labels: Record<string, string> = {}
    const raw = match[2]
    if (raw) {
      for (const part of raw.split(',')) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const eq = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|=~|!=|!~)\s*"([^"]*)"$/)
        if (eq) labels[eq[1]] = eq[2]
      }
    }
    selectors.push({ metric, labels })
  }
  return selectors
}

export function labelSetsCompatible(left: PromqlSelector, right: PromqlSelector): boolean {
  const leftKeys = Object.keys(left.labels).sort()
  const rightKeys = Object.keys(right.labels).sort()
  if (leftKeys.length === 0 && rightKeys.length === 0) return true
  if (leftKeys.join(',') !== rightKeys.join(',')) return false
  return leftKeys.every(key => left.labels[key] === right.labels[key])
}

export function assertUnlabeledBinaryOperands(expr: string, metrics: string[]): void {
  const selectors = extractPromqlSelectors(expr).filter(item => metrics.includes(item.metric))
  expectNonEmpty(selectors, metrics)
  for (const selector of selectors) {
    if (Object.keys(selector.labels).length > 0) {
      throw new Error(`${selector.metric} must not carry labels in ${expr}`)
    }
  }
}

function expectNonEmpty(selectors: PromqlSelector[], metrics: string[]): void {
  for (const metric of metrics) {
    if (!selectors.some(item => item.metric === metric)) {
      throw new Error(`missing metric ${metric}`)
    }
  }
}
