/**
 * Copies text to system clipboard using navigator.clipboard.writeText.
 * Returns true if succeeded, false if unsupported or rejected.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  const writeText = clipboard?.writeText
  if (typeof writeText !== 'function') return false
  try {
    await writeText.call(clipboard, text)
    return true
  } catch {
    return false
  }
}
