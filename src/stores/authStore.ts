import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { AuthUser } from '../types/merchant'

interface AuthState {
  user: AuthUser | null
  accessToken: string | null
  isLoggedIn: boolean
  setUser: (user: AuthUser) => void
  setAccessToken: (access: string) => void
  login: (user: AuthUser, access: string) => void
  logout: () => void
  updatePoints: (points: number) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      isLoggedIn: false,

      setUser: (user) => set({ user }),
      setAccessToken: (access) => set({ accessToken: access }),

      login: (user, access) =>
        set({ user, accessToken: access, isLoggedIn: true }),

      logout: () =>
        set({ user: null, accessToken: null, isLoggedIn: false }),

      updatePoints: (points) =>
        set((state) => ({
          user: state.user ? { ...state.user, points } : null,
        })),
    }),
    {
      name: 'monexus-auth',
      partialize: (state) => ({
        user: state.user,
        isLoggedIn: state.isLoggedIn,
        accessToken: state.accessToken,
      }),
    }
  )
)
