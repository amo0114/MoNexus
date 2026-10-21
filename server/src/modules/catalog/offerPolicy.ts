import { badRequest } from '../../lib/httpError.js'

export function assertOriginalPrice(price: number, originalPrice: number | null | undefined) {
  if (originalPrice != null && originalPrice < price) {
    throw badRequest('原价不能低于售价')
  }
}
