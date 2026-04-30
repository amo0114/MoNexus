import api from './client'
import { AuthUser } from '../types/merchant'

export async function getMe(): Promise<AuthUser> {
  const { data } = await api.get<AuthUser>('/auth/me')
  return data
}
