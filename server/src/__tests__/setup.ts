import { beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '../lib/prisma.js'

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    "AdminLog",
    "Settlement",
    "DeliveryRecord",
    "Order",
    "InventoryItem",
    "PointLog",
    "CheckinRecord",
    "InviteRelation",
    "Review",
    "RefreshToken",
    "Product",
    "Merchant",
    "PointAccount",
    "User"
    RESTART IDENTITY CASCADE`)
})
