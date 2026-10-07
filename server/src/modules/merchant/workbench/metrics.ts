import { Counter, Histogram } from 'prom-client'
import { registry } from '../../../lib/metrics.js'
import type { WorkbenchRule } from './schema.js'

const reads = new Counter({ name: 'monexus_workbench_reads_total', help: 'Workbench rule reads', labelNames: ['rule', 'result'], registers: [registry] })
const duration = new Histogram({ name: 'monexus_workbench_read_seconds', help: 'Workbench rule read latency', labelNames: ['rule'], registers: [registry] })
export const scannedDrafts = new Counter({ name: 'monexus_workbench_drafts_scanned_total', help: 'Draft candidates checked on demand', registers: [registry] })
export const truncatedGroups = new Counter({ name: 'monexus_workbench_truncated_groups_total', help: 'Groups exceeding the item limit', labelNames: ['rule'], registers: [registry] })
export async function observeRead<T>(rule: WorkbenchRule, read: () => Promise<T>): Promise<T> {
  const end = duration.startTimer({ rule })
  try {
    const result = await read()
    reads.inc({ rule, result: 'success' })
    return result
  } catch (error) {
    reads.inc({ rule, result: 'failed' })
    throw error
  } finally { end() }
}
