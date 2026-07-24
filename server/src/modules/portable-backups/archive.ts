import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

const MAGIC = Buffer.from('MNBK1\0', 'ascii')
const AUTH_TAG_BYTES = 16
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

interface EncryptedHeader {
  formatVersion: 1
  encryption: 'aes-256-gcm'
  kdf: 'scrypt'
  salt: string
  iv: string
}

export interface PortableObjectManifest {
  key: string
  archivePath: string
  mimeType: string
  size: number
  sha256: string
}

export interface PortableBackupManifest {
  formatVersion: 1
  createdAt: string
  applicationVersion: string
  database: { archivePath: 'database.dump'; size: number; sha256: string }
  objects: PortableObjectManifest[]
}

export async function createTarGz(sourceDirectory: string, destination: string) {
  await runProgram('tar', ['-C', sourceDirectory, '-czf', destination, '.'])
}

export async function extractTarGz(source: string, destination: string) {
  // Do this check before extraction. A pathname whitelist alone is not enough:
  // a tar member can be a symbolic link or a hard link whose *target* is not
  // represented in the ordinary name listing.
  const verboseListing = await runProgram('tar', ['-tvzf', source])
  for (const line of verboseListing.split('\n').filter(Boolean)) {
    const kind = line[0]
    if (kind !== '-' && kind !== 'd') {
      throw new Error('备份包不能包含链接或特殊文件')
    }
  }

  const listing = await runProgram('tar', ['-tzf', source])
  const entries = listing.split('\n').map(entry => entry.trim()).filter(Boolean)

  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '')
    if (!normalized || normalized === 'objects') continue
    if (
      normalized !== 'manifest.json' &&
      normalized !== 'database.dump' &&
      !/^objects\/[a-f0-9]{64}$/.test(normalized)
    ) {
      throw new Error('备份包包含不允许的文件路径')
    }
  }

  await runProgram('tar', ['-xzf', source, '-C', destination])
  await assertNoLinks(destination)
}

export async function encryptArchive(source: string, destination: string, passphrase: string) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = await deriveKey(passphrase, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const cipherTemp = `${destination}.cipher-${crypto.randomUUID()}`

  try {
    await pipeline(
      fs.createReadStream(source),
      cipher,
      fs.createWriteStream(cipherTemp, { flags: 'wx', mode: 0o600 })
    )

    const header: EncryptedHeader = {
      formatVersion: 1,
      encryption: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
    }
    const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8')
    if (encodedHeader.length > 65_536) throw new Error('备份包头部异常')

    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(encodedHeader.length)
    await fsp.writeFile(destination, Buffer.concat([MAGIC, length, encodedHeader]), { mode: 0o600 })
    await pipeline(
      fs.createReadStream(cipherTemp),
      fs.createWriteStream(destination, { flags: 'a', mode: 0o600 })
    )
    await fsp.appendFile(destination, cipher.getAuthTag())
  } finally {
    key.fill(0)
    await fsp.rm(cipherTemp, { force: true })
  }
}

export async function decryptArchive(source: string, destination: string, passphrase: string) {
  const stat = await fsp.stat(source)
  if (stat.size < MAGIC.length + 4 + AUTH_TAG_BYTES) {
    throw new Error('备份文件过小或已损坏')
  }

  const file = await fsp.open(source, 'r')
  let key: Buffer | undefined
  try {
    const prefix = await readExactly(file, MAGIC.length + 4, 0)
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('不是受支持的 MoNexus 备份文件')
    }
    const headerLength = prefix.readUInt32BE(MAGIC.length)
    if (headerLength < 2 || headerLength > 65_536) throw new Error('备份包头部异常')

    const payloadStart = MAGIC.length + 4 + headerLength
    if (stat.size <= payloadStart + AUTH_TAG_BYTES) throw new Error('备份文件不完整')
    const rawHeader = await readExactly(file, headerLength, MAGIC.length + 4)
    const header = parseHeader(rawHeader)
    const tag = await readExactly(file, AUTH_TAG_BYTES, stat.size - AUTH_TAG_BYTES)
    key = await deriveKey(passphrase, Buffer.from(header.salt, 'base64'))
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
    decipher.setAuthTag(tag)

    await pipeline(
      fs.createReadStream(source, { start: payloadStart, end: stat.size - AUTH_TAG_BYTES - 1 }),
      decipher,
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    )
  } finally {
    key?.fill(0)
    await file.close()
  }
}

export async function sha256File(file: string) {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hash as unknown as NodeJS.WritableStream)
  return hash.digest('hex')
}

export async function runProgram(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on('data', chunk => output.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(output).toString('utf8'))
        return
      }
      const detail = Buffer.concat(errors).toString('utf8').trim().slice(0, 1000)
      reject(new Error(`${command} 执行失败${detail ? `: ${detail}` : ''}`))
    })
  })
}

async function deriveKey(passphrase: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, SCRYPT_OPTIONS, (err, key) => {
      if (err) reject(err)
      else resolve(Buffer.from(key))
    })
  })
}

function parseHeader(rawHeader: Buffer): EncryptedHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawHeader.toString('utf8'))
  } catch {
    throw new Error('备份包头部无法解析')
  }

  if (
    !parsed || typeof parsed !== 'object' ||
    (parsed as EncryptedHeader).formatVersion !== 1 ||
    (parsed as EncryptedHeader).encryption !== 'aes-256-gcm' ||
    (parsed as EncryptedHeader).kdf !== 'scrypt' ||
    typeof (parsed as EncryptedHeader).salt !== 'string' ||
    typeof (parsed as EncryptedHeader).iv !== 'string'
  ) {
    throw new Error('备份包格式不受支持')
  }

  const header = parsed as EncryptedHeader
  if (Buffer.from(header.salt, 'base64').length !== 16 || Buffer.from(header.iv, 'base64').length !== 12) {
    throw new Error('备份包加密参数异常')
  }
  return header
}

async function readExactly(file: fs.promises.FileHandle, length: number, position: number) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, position)
  if (bytesRead !== length) throw new Error('备份文件不完整')
  return buffer
}

async function assertNoLinks(directory: string) {
  const entries = await fsp.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    const stat = await fsp.lstat(fullPath)
    if (stat.isSymbolicLink()) throw new Error('备份包不能包含链接文件')
    if (stat.isDirectory()) await assertNoLinks(fullPath)
  }
}
