import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createTarGz,
  decryptArchive,
  encryptArchive,
  extractTarGz,
} from './archive.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'monexus-portable-backup-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('portable backup archive', () => {
  it('encrypts, authenticates, decrypts, and extracts a portable archive', async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, 'source')
    const objects = path.join(source, 'objects')
    await fs.mkdir(objects, { recursive: true })

    const objectName = crypto.createHash('sha256').update('product-image.png').digest('hex')
    await fs.writeFile(path.join(source, 'database.dump'), 'postgres custom dump fixture')
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ formatVersion: 1 }))
    await fs.writeFile(path.join(objects, objectName), Buffer.from([1, 2, 3, 4]))

    const tarball = path.join(root, 'payload.tar.gz')
    const encrypted = path.join(root, 'portable.monexus-backup')
    const decrypted = path.join(root, 'restored.tar.gz')
    const extracted = path.join(root, 'extracted')
    await fs.mkdir(extracted)

    await createTarGz(source, tarball)
    await encryptArchive(tarball, encrypted, 'correct horse battery staple')
    await decryptArchive(encrypted, decrypted, 'correct horse battery staple')
    await extractTarGz(decrypted, extracted)

    await expect(fs.readFile(path.join(extracted, 'database.dump'), 'utf8'))
      .resolves.toBe('postgres custom dump fixture')
    await expect(fs.readFile(path.join(extracted, 'objects', objectName)))
      .resolves.toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('rejects a wrong passphrase without producing a usable decrypted archive', async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, 'source')
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'database.dump'), 'fixture')
    await fs.writeFile(path.join(source, 'manifest.json'), '{}')
    await fs.mkdir(path.join(source, 'objects'))

    const tarball = path.join(root, 'payload.tar.gz')
    const encrypted = path.join(root, 'portable.monexus-backup')
    const decrypted = path.join(root, 'wrong.tar.gz')
    await createTarGz(source, tarball)
    await encryptArchive(tarball, encrypted, 'a sufficiently long correct passphrase')

    await expect(decryptArchive(encrypted, decrypted, 'a sufficiently long wrong passphrase')).rejects.toThrow()
  })

  it('rejects a tar archive containing a symbolic link before extraction', async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, 'source')
    const extracted = path.join(root, 'extracted')
    await fs.mkdir(path.join(source, 'objects'), { recursive: true })
    await fs.writeFile(path.join(source, 'database.dump'), 'fixture')
    await fs.writeFile(path.join(source, 'manifest.json'), '{}')
    await fs.symlink('/etc/passwd', path.join(source, 'objects', 'linked-object'))
    await fs.mkdir(extracted)

    const tarball = path.join(root, 'linked.tar.gz')
    await createTarGz(source, tarball)

    await expect(extractTarGz(tarball, extracted)).rejects.toThrow('链接或特殊文件')
  })
})

describe('P5 v2 archives (delivery-objects/)', () => {
  it('extracts a v2 archive containing delivery objects (P0 regression: whitelist)', async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, 'source')
    await fs.mkdir(path.join(source, 'objects'), { recursive: true })
    await fs.mkdir(path.join(source, 'delivery-objects'), { recursive: true })

    const imageName = crypto.createHash('sha256').update('img-key').digest('hex')
    const deliveryName = crypto.createHash('sha256').update('delivery-key').digest('hex')
    await fs.writeFile(path.join(source, 'database.dump'), 'dump')
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ formatVersion: 2 }))
    await fs.writeFile(path.join(source, 'objects', imageName), Buffer.from('img'))
    await fs.writeFile(path.join(source, 'delivery-objects', deliveryName), Buffer.from('paid-bytes'))

    const tarball = path.join(root, 'payload.tar.gz')
    const extracted = path.join(root, 'extracted')
    await fs.mkdir(extracted)
    await createTarGz(source, tarball)
    await extractTarGz(tarball, extracted)

    await expect(fs.readFile(path.join(extracted, 'delivery-objects', deliveryName)))
      .resolves.toEqual(Buffer.from('paid-bytes'))
  })

  it('still rejects paths outside the whitelist', async () => {
    const root = await temporaryDirectory()
    const source = path.join(root, 'source')
    await fs.mkdir(path.join(source, 'delivery-objects'), { recursive: true })
    await fs.writeFile(path.join(source, 'database.dump'), 'dump')
    await fs.writeFile(path.join(source, 'manifest.json'), '{}')
    // 非法：delivery-objects 下的名字必须是 64 位十六进制。
    await fs.writeFile(path.join(source, 'delivery-objects', 'evil.sh'), 'nope')

    const tarball = path.join(root, 'payload.tar.gz')
    const extracted = path.join(root, 'extracted')
    await fs.mkdir(extracted)
    await createTarGz(source, tarball)
    await expect(extractTarGz(tarball, extracted)).rejects.toThrow('不允许的文件路径')
  })
})
