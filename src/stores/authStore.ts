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
  isLoggedIn: boolean
  setUser: (user: User) => void
  setAccessToken: (access: string) => void
  login: (user: User, access: string) => void
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
      }),
    }
  )
)
