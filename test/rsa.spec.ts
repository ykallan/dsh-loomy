import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { publicKeyFromDer, rsaEncrypt } from '../src/rsa.ts'

/**
 * 密码的 RSA 加密：上游给裸 DER 公钥（SPKI 或 PKCS#1），我们用 PKCS#1 v1.5 加密。
 *
 * 这两个用例自造密钥对再解回来 —— 不打任何上游。
 */

function keypair(): { spkiB64: string; pkcs1B64: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    spkiB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    pkcs1B64: publicKey.export({ format: 'der', type: 'pkcs1' }).toString('base64'),
    privateKey,
  }
}

describe('rsaEncrypt', () => {
  it('round-trips a password through a SubjectPublicKeyInfo key', () => {
    const { spkiB64, privateKey } = keypair()
    const encrypted = rsaEncrypt(spkiB64, 'p@ssw0rd-中文')
    const decrypted = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(encrypted, 'base64'),
    )
    expect(decrypted.toString('utf8')).toBe('p@ssw0rd-中文')
  })

  it('also accepts a bare PKCS#1 public key', () => {
    const { pkcs1B64, privateKey } = keypair()
    const encrypted = rsaEncrypt(pkcs1B64, 'another-password')
    const decrypted = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(encrypted, 'base64'),
    )
    expect(decrypted.toString('utf8')).toBe('another-password')
  })

  it('refuses a password that does not fit the modulus', () => {
    const { spkiB64 } = keypair()
    expect(() => rsaEncrypt(spkiB64, 'x'.repeat(1000))).toThrow(/too long/)
  })

  it('reports an unparseable key instead of throwing something opaque', () => {
    expect(() => publicKeyFromDer(Buffer.from('not a der key').toString('base64'))).toThrow(/could not parse/)
  })

  it('rejects an empty public key', () => {
    expect(() => publicKeyFromDer('   ')).toThrow(/empty public key/)
  })
})
