import api from './client'

export interface ReviewItem {
  id: number
  rating: number
  comment: string | null
  displayName: string
  editedAt: string | null
  createdAt: string
}

export interface ReviewPage {
  items: ReviewItem[]
  total: number
  page: number
  pageSize: number
}

export interface OwnReview {
  rating: number
  comment: string | null
  status: string
  editableUntil: string
  editedAt: string | null
  createdAt: string
}

export async function getProductReviews(productId: number, page = 1): Promise<ReviewPage> {
  const { data } = await api.get(`/products/${productId}/reviews`, { params: { page } })
  return data
}

export async function createOrderReview(orderId: number, body: { rating: number; comment?: string }): Promise<OwnReview> {
  const { data } = await api.post(`/orders/${orderId}/review`, body)
  return data
}

export async function updateOrderReview(orderId: number, body: { rating: number; comment?: string }): Promise<OwnReview> {
  const { data } = await api.put(`/orders/${orderId}/review`, body)
  return data
}
