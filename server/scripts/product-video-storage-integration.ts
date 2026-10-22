/** Run only against an isolated test bucket; creates one UUID namespace and deletes its own objects. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3'
import { DeliveryS3Storage } from '../src/lib/storage/deliveryS3.js'
import { videoKey } from '../src/lib/storage/videoKeys.js'
const endpoint = process.env.INT_ENDPOINT || 'http://localhost:19380'
const bucket = process.env.INT_BUCKET || 'monexus-video-integration'
const accessKey = process.env.INT_ACCESS_KEY || 'video-test'
const secretKey = process.env.INT_SECRET_KEY || 'video-test-secret'
const credentials = { accessKeyId: accessKey, secretAccessKey: secretKey }
const client = new S3Client({ endpoint, region: 'us-east-1', credentials, forcePathStyle: true })
try { await client.send(new CreateBucketCommand({ Bucket: bucket })) } catch (err) { if ((err as { name: string }).name !== 'BucketAlreadyOwnedByYou') throw err }
const storage = new DeliveryS3Storage({ endpoint, publicEndpoint: process.env.INT_PUBLIC_ENDPOINT || endpoint, region: 'us-east-1', bucket, accessKey, secretKey, forcePathStyle: true })
const key = videoKey(randomUUID())
const bytes = Buffer.from('private-video-range-integration')
try {
  const put = await storage.putStream(key, Readable.from(bytes), 1024, { contentType: 'video/mp4' })
  assert.equal(put.size, bytes.length)
  assert.equal((await fetch(`${endpoint}/${bucket}/${key}`)).status, 403)
  const { url } = await storage.presignInlineVideo(key, 'video/mp4', 60)
  const response = await fetch(url, { headers: { Range: 'bytes=2-9' } })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-type'), 'video/mp4')
  assert.equal(response.headers.get('content-disposition'), 'inline')
  assert.match(response.headers.get('cache-control') || '', /no-store/)
  assert.equal(response.headers.get('content-range'), `bytes 2-9/${bytes.length}`)
  assert.equal(response.headers.get('content-length'), '8')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(2, 10))
  assert.equal((await fetch(url, { headers: { Range: 'bytes=99999-' } })).status, 416)
  assert.equal((await fetch(url.replace(/X-Amz-Signature=[a-f0-9]+/, 'X-Amz-Signature=' + '0'.repeat(64)))).status, 403)
  const expired = await storage.presignInlineVideo(key, 'video/mp4', 1)
  await new Promise(r => setTimeout(r, 2200))
  assert.equal((await fetch(expired.url)).status, 403)
  const paid = await storage.presignDownload(key, 'file.mp4', 60)
  const download = await fetch(paid.url)
  assert.match(download.headers.get('content-disposition') || '', /^attachment/)
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  console.log('PASS: real S3 private access, inline MIME/no-store, Range 206/416, tamper/expiry, paid download unchanged')
} finally { await storage.delete(key); client.destroy() }
