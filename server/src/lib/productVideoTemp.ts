import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

/** Separate local worktrees/instances; cleanup never scans the system temp root. */
export function productVideoTempRoot() {
  return process.env.PRODUCT_VIDEO_TEMP_ROOT
    ? path.resolve(process.env.PRODUCT_VIDEO_TEMP_ROOT)
    : path.join(os.tmpdir(), 'monexus-product-videos', createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16))
}
