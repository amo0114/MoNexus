import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'

/**
 * 按交付对象 finalKey 的跨路径互斥（Postgres advisory lock）。
 *
 * 竞态（评审 P0）：上传的「promote → DeliveryFile.create」与 GC 的
 * 「查引用 → 删对象」之间没有互斥时，GC 可能在同内容重新上传已 promote
 * （对象已存在故仅删 tmp）、但行尚未建成的窗口里把对象删掉——建行成功后
 * 数据库指向不存在的对象。
 *
 * 用 pg_advisory_xact_lock 以事务生命周期持锁：上传侧从 promote 前持有到
 * create 完成；GC 侧取得同一把锁后**二次确认**无非 deleted 引用才删对象。
 * 锁随事务提交/回滚自动释放，进程崩溃不会遗留。
 *
 * 回调**必须**通过入参 tx 访问数据库——锁与后续查询共用同一条事务连接。
 * 若回调走全局 prisma，每个持锁请求会占住事务连接再等第二条连接，并发
 * 多 key 上传时连接池耗尽形成等待链（评审 P1）。S3 操作无法进事务，
 * 在事务生命周期内执行即可，不额外占连接。
 */

// classid 命名空间常量：避免与未来其他 advisory lock 用途撞号。
const DELIVERY_KEY_LOCK_CLASS = 20260726

export async function withDeliveryKeyLock<T>(
  key: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(
    async tx => {
      // $executeRaw：pg_advisory_xact_lock 返回 void，$queryRaw 反序列化会报错。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DELIVERY_KEY_LOCK_CLASS}::int4, hashtext(${key}))`
      return fn(tx)
    },
    // promote 是 S3 服务端复制（100MB 级仍在秒级），但要给足余量；
    // maxWait 是排队等锁前拿连接的上限。
    { maxWait: 10_000, timeout: 60_000 }
  )
}
