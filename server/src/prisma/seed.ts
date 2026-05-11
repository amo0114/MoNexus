import 'dotenv/config'
import { prisma } from '../lib/prisma.js'
import bcrypt from 'bcryptjs'

const FORCE_RESET = process.argv.includes('--force-reset')

async function upsertUser(opts: {
  email: string
  password: string
  role: string
  inviteCode: string
  extraUpdate?: Record<string, unknown>
}) {
  const { email, password, role, inviteCode, extraUpdate = {} } = opts
  const existing = await prisma.user.findUnique({ where: { email } })
  const hashed = await bcrypt.hash(password, 10)

  if (existing) {
    // 默认不覆盖密码，--force-reset 时才重置
    const updateData: Record<string, unknown> = { role, ...extraUpdate }
    if (FORCE_RESET) {
      updateData.password = hashed
      console.log(`  ↻ ${email} — 密码已重置`)
    } else {
      console.log(`  ✓ ${email} — 已存在，跳过密码`)
    }
    return prisma.user.update({ where: { email }, data: updateData })
  }

  console.log(`  + ${email} — 已创建`)
  return prisma.user.create({
    data: { email, password: hashed, role, inviteCode },
  })
}

async function main() {
  console.log('🌱 Seeding database...')
  if (FORCE_RESET) {
    console.log('  ⚠ --force-reset 模式：将重置所有用户密码')
  }

  // 创建管理员
  const admin = await upsertUser({
    email: 'admin@moyuan.net',
    password: 'admin123',
    role: 'admin',
    inviteCode: 'ADMIN-MOYUAN',
  })
  await prisma.pointAccount.upsert({
    where: { userId: admin.id },
    update: { balance: 99999 },
    create: { userId: admin.id, balance: 99999 },
  })

  // 创建测试用户
  const testUser = await upsertUser({
    email: 'test@moyuan.net',
    password: 'user123',
    role: 'user',
    inviteCode: 'MOYUAN26',
  })
  await prisma.pointAccount.upsert({
    where: { userId: testUser.id },
    update: { balance: 5000 },
    create: { userId: testUser.id, balance: 5000 },
  })

  // 创建示例商家
  const merchantUser = await upsertUser({
    email: 'merchant@moyuan.net',
    password: 'merchant123',
    role: 'merchant',
    inviteCode: 'MERCHANT-MOYUAN',
    extraUpdate: { status: '正常' },
  })
  await prisma.pointAccount.upsert({
    where: { userId: merchantUser.id },
    update: { balance: 5000 },
    create: { userId: merchantUser.id, balance: 5000 },
  })
  const merchant = await prisma.merchant.upsert({
    where: { userId: merchantUser.id },
    update: {
      name: '墨缘精选商家',
      description: '平台认证示例商家，提供可直接联调的自营商品。',
      status: 'active',
      commissionRate: '0.1000',
      contactEmail: 'merchant@moyuan.net',
      contactPhone: '13800000000',
      approvedAt: new Date(),
      approvedBy: admin.id,
    },
    create: {
      userId: merchantUser.id,
      name: '墨缘精选商家',
      description: '平台认证示例商家，提供可直接联调的自营商品。',
      status: 'active',
      commissionRate: '0.1000',
      contactEmail: 'merchant@moyuan.net',
      contactPhone: '13800000000',
      approvedAt: new Date(),
      approvedBy: admin.id,
    },
  })

  // 创建商品
  const products = [
    {
      name: '稳定专线节点订阅 (30天)',
      description: '秒开 4K，晚高峰不卡顿。全平台通用，一键导入使用。',
      richDescription: '<p><b>商品特点：</b></p><ul class="list-disc pl-5 space-y-1 mt-1"><li>速度快：国内多线 BGP 接入</li><li>流媒体：解锁大部分海外视频网站</li><li>客户端：支持 Clash, V2rayN, Shadowrocket 等</li></ul><p class="mt-3 text-xs text-red-400">注意：购买后发放订阅链接，请勿分享给他人。</p>',
      type: '网络节点',
      icon: 'wifi',
      imageUrl: 'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?auto=format&fit=crop&q=80&w=800',
      price: 800,
      originalPrice: 1000,
      isHot: true,
      inventoryItems: [
        'https://api.moyuan.net/sub/abc123def456',
        'https://api.moyuan.net/sub/ghi789jkl012',
        'https://api.moyuan.net/sub/mno345pqr678',
        'https://api.moyuan.net/sub/stu901vwx234',
        'https://api.moyuan.net/sub/yza567bcd890',
      ],
    },
    {
      name: 'ChatGPT Plus 共享车位',
      description: '5 人小车队，原生 GPT-4 接口，便宜好用的生产力工具。',
      richDescription: '<p><b>使用说明：</b></p><ul class="list-disc pl-5 space-y-1 mt-1"><li>发货格式：账号----密码</li><li>请在官方网页版登录</li><li>禁止使用 API，禁止乱改密码</li></ul>',
      type: '共享账号',
      icon: 'message-square',
      imageUrl: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&q=80&w=800',
      price: 1500,
      isHot: true,
      inventoryItems: [
        '账号: gpt_share_01@163.com\n密码: Pw83721',
        '账号: gpt_share_02@163.com\n密码: Pw49253',
        '账号: gpt_share_03@163.com\n密码: Pw16084',
      ],
    },
    {
      name: 'Netflix 4K 高级合租位',
      description: '一个人一个专属头像和 PIN 码，记录独立互不干扰。',
      richDescription: '<p>正规实体卡开通，非月抛黑卡：</p><ul class="list-disc pl-5 space-y-1 mt-1"><li>质保首月，掉线包退补</li><li>支持电视端、手机端、网页端</li><li>请仅登录自己的子频道，勿动他人配置</li></ul>',
      type: '共享账号',
      icon: 'tv',
      imageUrl: 'https://images.unsplash.com/photo-1522869635100-9f4c5e86aa37?auto=format&fit=crop&q=80&w=800',
      price: 1200,
      originalPrice: 1500,
      inventoryItems: [
        '子频道: Profile-3\nPIN: 8821\n登录邮箱: nf_rent@outlook.com\n密码: Netflix2026!',
        '子频道: Profile-4\nPIN: 6632\n登录邮箱: nf_rent@outlook.com\n密码: Netflix2026!',
      ],
    },
    {
      name: 'Apple ID 美区全新空白号',
      description: '手工注册白号，带密保问题，可自行改密码，安全防找回。',
      richDescription: '<p>用途广泛，极度安全：</p><ul class="list-disc pl-5 space-y-1 mt-1"><li>可用于下载国区没有的各类 App</li><li>发货格式：账号----密码----密保1----密保2----密保3----生日</li><li>强烈建议拿到手后登录官网修改所有信息</li></ul>',
      type: '充值卡密',
      icon: 'smartphone',
      imageUrl: 'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?auto=format&fit=crop&q=80&w=800',
      price: 300,
      isHot: true,
      inventoryItems: [
        'apple_us_001@icloud.com----Ap2026!x1----颜色?蓝色----宠物?猫咪----城市?纽约----1990-01-15',
        'apple_us_002@icloud.com----Ap2026!x2----颜色?红色----宠物?狗狗----城市?洛杉矶----1992-05-20',
        'apple_us_003@icloud.com----Ap2026!x3----颜色?绿色----宠物?兔子----城市?芝加哥----1995-11-08',
        'apple_us_004@icloud.com----Ap2026!x4----颜色?紫色----宠物?鹦鹉----城市?旧金山----1988-03-22',
      ],
    },
  ]

  for (const p of products) {
    const { inventoryItems, ...productData } = p
    const product = await prisma.product.upsert({
      where: { id: products.indexOf(p) + 1 },
      update: {},
      create: {
        ...productData,
        stock: inventoryItems.length,
        sales: Math.floor(Math.random() * 3000) + 100,
      },
    })

    // 插入库存
    const existingCount = await prisma.inventoryItem.count({ where: { productId: product.id } })
    if (existingCount === 0) {
      await prisma.inventoryItem.createMany({
        data: inventoryItems.map(content => ({
          productId: product.id,
          content,
          status: 'available',
        })),
      })
    }
  }

  const merchantInventoryItems = [
    '商家专线订阅链接: https://merchant.moyuan.net/sub/demo-001',
    '商家专线订阅链接: https://merchant.moyuan.net/sub/demo-002',
    '商家专线订阅链接: https://merchant.moyuan.net/sub/demo-003',
  ]
  const existingMerchantProduct = await prisma.product.findFirst({
    where: { merchantId: merchant.id, name: '商家自营高速节点包' },
  })
  const merchantProduct = existingMerchantProduct
    ? await prisma.product.update({
        where: { id: existingMerchantProduct.id },
        data: {
          description: '示例商家的自营商品，可用于商家端订单与结算联调。',
          richDescription: '<p>由示例商家提供的高速节点订阅包，用于本地联调商家订单与结算流程。</p>',
          type: '网络节点',
          icon: 'wifi',
          imageUrl: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&q=80&w=800',
          price: 600,
          originalPrice: 800,
          isHot: true,
          status: 'active',
          merchantId: merchant.id,
        },
      })
    : await prisma.product.create({
        data: {
          name: '商家自营高速节点包',
          description: '示例商家的自营商品，可用于商家端订单与结算联调。',
          richDescription: '<p>由示例商家提供的高速节点订阅包，用于本地联调商家订单与结算流程。</p>',
          type: '网络节点',
          icon: 'wifi',
          imageUrl: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&q=80&w=800',
          price: 600,
          originalPrice: 800,
          stock: merchantInventoryItems.length,
          sales: 0,
          isHot: true,
          status: 'active',
          merchantId: merchant.id,
        },
      })

  const existingMerchantInventory = await prisma.inventoryItem.count({ where: { productId: merchantProduct.id } })
  if (existingMerchantInventory === 0) {
    await prisma.inventoryItem.createMany({
      data: merchantInventoryItems.map(content => ({
        productId: merchantProduct.id,
        content,
        status: 'available',
      })),
    })
    await prisma.product.update({
      where: { id: merchantProduct.id },
      data: { stock: merchantInventoryItems.length },
    })
  }

  // 创建评价
  const reviewData = [
    { productId: 1, userName: '匿名用户', rating: 5, comment: '性价比很高，下载能跑到 50M/s，非常给力！' },
    { productId: 1, userName: '飞***猪', rating: 5, comment: '买了好几次了，老板发货很快，很靠谱。' },
    { productId: 2, userName: '学***渣', rating: 5, comment: '写作业全靠它了，虽然是共享的但很少被顶号。' },
    { productId: 2, userName: 'Q***Q', rating: 4, comment: '挺划算的，一个人买太贵，合租刚刚好。' },
    { productId: 3, userName: '追剧达人', rating: 5, comment: '画质真的没得说，看剧贼爽。' },
    { productId: 4, userName: 'A***', rating: 5, comment: '自动发卡，马上就收到了，照着教程改了密码，美滋滋。' },
  ]

  const existingReviews = await prisma.review.count()
  if (existingReviews === 0) {
    await prisma.review.createMany({ data: reviewData })
  }

  // 写初始积分流水
  const existingLogs = await prisma.pointLog.count()
  if (existingLogs === 0) {
    await prisma.pointLog.createMany({
      data: [
        { userId: admin.id, type: 'in', amount: 99999, balanceAfter: 99999, reason: '管理员初始积分' },
        { userId: testUser.id, type: 'in', amount: 5000, balanceAfter: 5000, reason: '新用户注册奖励' },
        { userId: merchantUser.id, type: 'in', amount: 5000, balanceAfter: 5000, reason: '示例商家初始积分' },
      ],
    })
  }

  console.log('✅ Seed completed!')
  console.log('  Admin:    admin@moyuan.net / admin123')
  console.log('  User:     test@moyuan.net / user123')
  console.log('  Merchant: merchant@moyuan.net / merchant123')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
