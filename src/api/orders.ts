import api from './client'
import { UserOrderListItem, UserOrderDetail } from '../types/order'

export async function getOrders(params?: { page?: number; pageSize?: number; status?: string }): Promise<UserOrderListItem[]> {
  const { data } = await api.get('/orders', { params })
  return data
}

export async function getOrderDetail(id: number): Promise<UserOrderDetail> {
  const { data } = await api.get(`/orders/${id}`)
  return data
}

export async function disputeOrder(id: number): Promise<void> {
  await api.post(`/orders/${id}/dispute`)
}

export async function closeOrder(id: number): Promise<void> {
  await api.post(`/orders/${id}/close`)
}
