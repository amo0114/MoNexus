/**
 * 上传图片的结构校验（审计 2026-09 低危项：合法图片头 + 尾随脚本可过校验）。
 *
 * 只看 magic bytes 时，`<有效图片><任意字节>` 会被原样存进公开桶。这里按
 * 各格式的容器规则走到文件应当结束的位置，并要求缓冲区在那里**恰好结束**：
 * - PNG：签名 + 逐 chunk 走到 IEND，每个 chunk 的 CRC 必须正确；
 * - JPEG：SOI + 逐 segment（含 SOS 熵编码段与 RSTn/填充 0xFF）走到 EOI；
 * - GIF：header + LSD（+GCT）+ 逐 block（图像/扩展）走到 trailer 0x3B；
 * - WebP：RIFF 声明的大小必须等于文件长度（含奇数 payload 的 pad）。
 *
 * 不解码像素，不依赖原生库；校验通过只保证「容器边界闭合、没有尾随负载」，
 * 不保证图片可渲染——那由浏览器决定，与安全无关。
 */

import { crc32 } from 'node:zlib'

export type ValidatedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function validatePng(buf: Buffer): boolean {
  if (buf.length < PNG_SIGNATURE.length + 12 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  let offset = 8
  let sawIhdr = false
  while (true) {
    if (offset + 12 > buf.length) return false
    const length = buf.readUInt32BE(offset)
    if (length > 0x7fffffff) return false
    const chunkEnd = offset + 12 + length
    if (chunkEnd > buf.length) return false
    const type = buf.toString('latin1', offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) return false
    if (offset === 8 && type !== 'IHDR') return false
    if (type === 'IHDR') sawIhdr = true
    const expectedCrc = buf.readUInt32BE(offset + 8 + length)
    if ((crc32(buf.subarray(offset + 4, offset + 8 + length)) >>> 0) !== expectedCrc) return false
    offset = chunkEnd
    if (type === 'IEND') return sawIhdr && length === 0 && offset === buf.length
  }
}

function validateJpeg(buf: Buffer): boolean {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false
  let offset = 2
  while (true) {
    if (offset + 2 > buf.length) return false
    if (buf[offset] !== 0xff) return false
    // Fill bytes: any number of 0xFF may precede a marker.
    while (offset < buf.length && buf[offset] === 0xff) offset++
    if (offset >= buf.length) return false
    const marker = buf[offset]
    offset++
    if (marker === 0xd9) return offset === buf.length // EOI
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue // standalone
    if (marker === 0x00) return false // stuffed byte outside entropy data
    if (offset + 2 > buf.length) return false
    const segmentLength = buf.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buf.length) return false
    offset += segmentLength
    if (marker !== 0xda) continue // not SOS
    // Entropy-coded data: skip until a marker that is not 0xFF00 (stuffing)
    // and not RSTn. The next real marker is processed by the loop above.
    while (true) {
      if (offset >= buf.length) return false
      if (buf[offset] !== 0xff) { offset++; continue }
      if (offset + 1 >= buf.length) return false
      const next = buf[offset + 1]
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue }
      if (next === 0xff) { offset++; continue }
      break
    }
  }
}

function skipGifSubBlocks(buf: Buffer, offset: number): number | null {
  while (true) {
    if (offset >= buf.length) return null
    const size = buf[offset]
    offset++
    if (size === 0) return offset
    offset += size
    if (offset > buf.length) return null
  }
}

function validateGif(buf: Buffer): boolean {
  if (buf.length < 14) return false
  const header = buf.toString('latin1', 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return false
  let offset = 6
  const packed = buf[offset + 4]
  offset += 7 // logical screen descriptor
  if (packed & 0x80) {
    offset += 3 * (1 << ((packed & 0x07) + 1)) // global color table
    if (offset > buf.length) return false
  }
  while (true) {
    if (offset >= buf.length) return false
    const block = buf[offset]
    offset++
    if (block === 0x3b) return offset === buf.length // trailer
    if (block === 0x2c) {
      if (offset + 9 > buf.length) return false
      const imgPacked = buf[offset + 8]
      offset += 9
      if (imgPacked & 0x80) offset += 3 * (1 << ((imgPacked & 0x07) + 1))
      offset += 1 // LZW minimum code size
      if (offset > buf.length) return false
      const next = skipGifSubBlocks(buf, offset)
      if (next == null) return false
      offset = next
      continue
    }
    if (block === 0x21) {
      if (offset >= buf.length) return false
      offset++ // extension label; every extension is a sub-block chain
      const next = skipGifSubBlocks(buf, offset)
      if (next == null) return false
      offset = next
      continue
    }
    return false
  }
}

function validateWebp(buf: Buffer): boolean {
  if (buf.length < 12) return false
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return false
  const riffSize = buf.readUInt32LE(4)
  if (riffSize < 4 || riffSize + 8 !== buf.length) return false
  // Walk the chunk list so a RIFF size that happens to match still needs
  // internally consistent chunks (each padded to an even length).
  let offset = 12
  let sawChunk = false
  while (offset < buf.length) {
    if (offset + 8 > buf.length) return false
    const fourcc = buf.toString('ascii', offset, offset + 4)
    if (!/^[A-Za-z0-9 ]{4}$/.test(fourcc)) return false
    const size = buf.readUInt32LE(offset + 4)
    const padded = size + (size & 1)
    if (offset + 8 + padded > buf.length) return false
    offset += 8 + padded
    sawChunk = true
  }
  return sawChunk && offset === buf.length
}

/** True only when `buf` is one complete image of `mime` with no trailing bytes. */
export function validateImageStructure(buf: Buffer, mime: ValidatedImageMime): boolean {
  try {
    switch (mime) {
      case 'image/png': return validatePng(buf)
      case 'image/jpeg': return validateJpeg(buf)
      case 'image/gif': return validateGif(buf)
      case 'image/webp': return validateWebp(buf)
      default: return false
    }
  } catch {
    return false
  }
}
