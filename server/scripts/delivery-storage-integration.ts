/**
 * P5 T7：真实 MinIO（S3 兼容）私有交付桶集成验证（设计 §9 T7 四项）。
 *
 * 用法（一次性 MinIO 容器示例）：
 *   docker run -d --rm --name p5-minio-int -p 19000:9000 \
 *     -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio_int_secret \
 *     minio/minio server /data
 *   INT_ENDPOINT=http://localhost:19000 INT_PUBLIC_ENDPOINT=http://localhost:19000 \
 *     INT_ACCESS_KEY=minio INT_SECRET_KEY=minio_int_secret \
 *     npx tsx scripts/delivery-storage-integration.ts
 *
 * 若经 nginx 透传验证（SigV4 原样转发），把 INT_PUBLIC_ENDPOINT 指向 nginx。
 *
 * 验证项：
 *  1. 匿名直取私有桶对象 → 403（桶只创建、无 anonymous 策略）
 *  2. presigned URL 浏览器视角可访问（200）且响应头强制 attachment + octet-stream
 *  3. 篡改签名 → 403
 *  4. 过期签名 → 403
 * 附加：流式上传→晋升→去重与 tmp 清理路径在真实 S3 语义下走通。
 */
import { Readable } from 'node:stream'
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3'
import { DeliveryS3Storage } from '../src/lib/storage/deliveryS3.js'
import { TMP_KEY_PREFIX } from '../src/lib/storage/deliveryTypes.js'

const endpoint = process.env.INT_ENDPOINT ?? 'http://localhost:19000'
const publicEndpoint = process.env.INT_PUBLIC_ENDPOINT ?? endpoint
const accessKey = process.env.INT_ACCESS_KEY ?? 'minio'
const secretKey = process.env.INT_SECRET_KEY ?? 'minio_int_secret'
const bucket = process.env.INT_BUCKET ?? 'monexus-files-int'

let failures = 0
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  const admin = new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  })
  // 只创建，绝不设置 anonymous 策略——与生产初始化脚本同约束。
  try {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }))
  } catch (err) {
    const e = err as { name?: string }
    if (e?.name !== 'BucketAlreadyOwnedByYou' && e?.name !== 'BucketAlreadyExists') throw err
  }

  const storage = new DeliveryS3Storage({
    endpoint,
    region: 'us-east-1',
    bucket,
    accessKey,
    secretKey,
    publicEndpoint,
    forcePathStyle: true,
  })

  // 流式上传 → 晋升到内容寻址键。
  const body = Buffer.from(`integration-${process.pid}-${Math.random()}`)
  const tmpKey = `${TMP_KEY_PREFIX}int-check`
  const { sha256, size } = await storage.putStream(tmpKey, Readable.from(body), 1024 * 1024)
  check('streaming upload hashes and counts', sha256.length === 64 && size === body.length)
  const finalKey = `${sha256}.bin`
  await storage.promote(tmpKey, finalKey)
  const tmpLeft = await storage.listTmpKeysOlderThan(new Date(Date.now() + 60_000))
  check('tmp key removed after promote', !tmpLeft.includes(tmpKey))

  // 1. 匿名直取必须 403。
  const anonymous = await fetch(`${publicEndpoint}/${bucket}/${finalKey}`)
  check('anonymous direct GET is denied', anonymous.status === 403, `status=${anonymous.status}`)

  // 2. presigned URL 可访问且强制下载。
  const { url } = await storage.presignDownload(finalKey, '交付包 v1.zip', 60)
  const signed = await fetch(url)
  const disposition = signed.headers.get('content-disposition') ?? ''
  const contentType = signed.headers.get('content-type') ?? ''
  check('presigned GET succeeds', signed.status === 200, `status=${signed.status}`)
  check('response forces attachment', disposition.startsWith('attachment'), disposition)
  check('response content-type is octet-stream', contentType === 'application/octet-stream', contentType)
  check('body round-trips', Buffer.from(await signed.arrayBuffer()).equals(body))

  // 3. 篡改签名 → 403。
  const tampered = await fetch(url.replace(/X-Amz-Signature=[0-9a-f]{8}/, 'X-Amz-Signature=deadbeef'))
  check('tampered signature is denied', tampered.status === 403, `status=${tampered.status}`)

  // 4. 过期签名 → 403。
  const { url: shortUrl } = await storage.presignDownload(finalKey, 'expired.bin', 1)
  await new Promise(resolve => setTimeout(resolve, 2500))
  const expired = await fetch(shortUrl)
  check('expired signature is denied', expired.status === 403, `status=${expired.status}`)

  await storage.delete(finalKey)
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
