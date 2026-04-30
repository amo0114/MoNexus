import api from './client'
import { UserOrderListItem, UserOrderDetail } from '../types/order'

export async function getOrders(): Promise<UserOrderListItem[]> {
  const { data } = await api.get('/orders')
  return data
}

export async function getOrderDetail(id: number): Promise<UserOrderDetail> {
  const { data } = await api.get(`/orders/${id}`)
  return data
}
