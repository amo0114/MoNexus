import { describe, it, expect } from 'vitest'
import { validateImageStructure } from '../lib/imageStructure.js'

// Fixtures generated with Pillow (1x1 / 2x2 images). Kept inline so the
// suite has no filesystem dependency.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63606060600000000500017aa857500000000049454e44ae426082',
  'hex',
)
const PNG_WITH_TEXT = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d74455874436f6d6d656e740068656c6c6fe6ffae240000000d49444154789c636060f8ff1f00030201ffe6770bae0000000049454e44ae426082',
  'hex',
)
const JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb00430050373c463c32504641465a55505f78c882786e6e78f5afb991c8ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdb004301555a5a786978eb8282ebffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f008a8a28accec3ffd9',
  'hex',
)
const PROGRESSIVE_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb00430050373c463c32504641465a55505f78c882786e6e78f5afb991c8ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdb004301555a5a786978eb8282ebffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc20011080002000203012200021101031101ffc4001500010100000000000000000000000000000003ffc40014010100000000000000000000000000000000ffda000c03010002100310000001803fffc40014100100000000000000000000000000000000ffda00080101000105027fffc40014110100000000000000000000000000000000ffda0008010301013f017fffc40014110100000000000000000000000000000000ffda0008010201013f017fffc40014100100000000000000000000000000000000ffda0008010100063f027fffc40014100100000000000000000000000000000000ffda0008010100013f217fffda000c03010002000300000010f3ffc40014110100000000000000000000000000000000ffda0008010301013f107fffc40014110100000000000000000000000000000000ffda0008010201013f107fffc40014100100000000000000000000000000000000ffda0008010100013f107fffd9',
  'hex',
)
const GIF = Buffer.from('474946383761010001008000000000000000002c000000000100010000080400010404003b', 'hex')
const ANIMATED_GIF = Buffer.from(
  '4749463839610100010080000000000000000021ff0b4e45545343415045322e30030100000021f90400020000002c000000000100010000080400010404003b',
  'hex',
)
const WEBP = Buffer.from(
  '52494646340000005745425056503820280000009001009d012a0100010007409625a00274ba00039800fec0cffc5ad6e16961ffc2b5bd9ec0f27400',
  'hex',
)
const PAYLOAD = Buffer.from('<script>alert(1)</script>')

describe('validateImageStructure', () => {
  const valid: Array<[string, Buffer, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp']> = [
    ['png', PNG, 'image/png'],
    ['png with tEXt chunk', PNG_WITH_TEXT, 'image/png'],
    ['baseline jpeg', JPEG, 'image/jpeg'],
    ['progressive jpeg', PROGRESSIVE_JPEG, 'image/jpeg'],
    ['gif', GIF, 'image/gif'],
    ['animated gif with extensions', ANIMATED_GIF, 'image/gif'],
    ['webp', WEBP, 'image/webp'],
  ]

  for (const [name, buffer, mime] of valid) {
    it(`accepts a well-formed ${name}`, () => {
      expect(validateImageStructure(buffer, mime)).toBe(true)
    })

    it(`rejects a ${name} with bytes appended after its terminator`, () => {
      expect(validateImageStructure(Buffer.concat([buffer, PAYLOAD]), mime)).toBe(false)
    })

    it(`rejects a truncated ${name}`, () => {
      expect(validateImageStructure(buffer.subarray(0, buffer.length - 3), mime)).toBe(false)
    })
  }

  it('rejects a bare PNG signature followed by arbitrary bytes', () => {
    expect(validateImageStructure(Buffer.concat([PNG.subarray(0, 8), PAYLOAD]), 'image/png')).toBe(false)
  })

  it('rejects a PNG whose chunk length overruns the buffer', () => {
    const corrupt = Buffer.from(PNG)
    corrupt.writeUInt32BE(0x00ffffff, 33) // IDAT length
    expect(validateImageStructure(corrupt, 'image/png')).toBe(false)
  })

  it('rejects a JPEG whose EOI is followed by a fake second EOI', () => {
    expect(validateImageStructure(Buffer.concat([JPEG, PAYLOAD, Buffer.from([0xff, 0xd9])]), 'image/jpeg')).toBe(false)
  })

  it('rejects a WebP whose RIFF size does not cover the whole file', () => {
    expect(validateImageStructure(Buffer.concat([WEBP, Buffer.from([0x00, 0x00])]), 'image/webp')).toBe(false)
  })
})
