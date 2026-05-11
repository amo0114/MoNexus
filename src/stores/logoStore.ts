import { create } from 'zustand'

export type LogoVariant = 'flow' | 'concentric'

const KEY = 'monexus-logo-variant'

function readStored(): LogoVariant {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'flow' || v === 'concentric') return v
  } catch {
    // ignore storage errors (private mode, etc.)
  }
  return 'flow'
}

interface LogoState {
  variant: LogoVariant
  setVariant: (v: LogoVariant) => void
}

/**
 * Two candidate brand marks (Flow vs Concentric) are shipped in parallel.
 * The preference is read once on store creation and persisted on each set.
 * Switching the variant updates every mounted <Logo /> immediately because
 * Layout subscribes via useLogoStore.
 */
export const useLogoStore = create<LogoState>((set) => ({
  variant: readStored(),
  setVariant: (variant) => {
    try {
      localStorage.setItem(KEY, variant)
    } catch {
      // ignore
    }
    set({ variant })
  },
}))
