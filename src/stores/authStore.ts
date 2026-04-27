import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface User {
  id: number
  email: string
  role: string
  inviteCode: string
  points: number
}

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  isLoggedIn: boolean
  setUser: (user: User) => void
  setTokens: (access: string, refresh: string) => void
  login: (user: User, access: string, refresh: string) => void
  logout: () => void
  updatePoints: (points: number) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isLoggedIn: false,

      setUser: (user) => set({ user }),
      setTokens: (access, refresh) => set({ accessToken: access, refreshToken: refresh }),

      login: (user, access, refresh) =>
        set({ user, accessToken: access, refreshToken: refresh, isLoggedIn: true }),

      logout: () =>
        set({ user: null, accessToken: null, refreshToken: null, isLoggedIn: false }),

      updatePoints: (points) =>
        set((state) => ({
          user: state.user ? { ...state.user, points } : null,
        })),
    }),
    { name: 'monexus-auth' }
  )
)
