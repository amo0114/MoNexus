/**
 * SPEC-ENGAGE-001 FX-01..FX-04：签到 / 领奖成功时的庆祝动效。
 * canvas-confetti 只在触发时动态加载，不进入入口 chunk；动效不承载信息，
 * reduced-motion 或加载失败时直接跳过，文字反馈照常由调用方给出。
 */
export async function celebrate(): Promise<void> {
  if (typeof window === 'undefined') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  try {
    const { default: confetti } = await import('canvas-confetti')
    await confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.7 },
      disableForReducedMotion: true,
      zIndex: 9999,
    })
  } catch {
    // Decorative only; feedback text has already been shown.
  }
}
