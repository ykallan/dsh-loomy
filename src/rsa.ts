/**
 * 密码的 RSA 加密（账号服务 `byPwd` 路径）。
 *
 * 上游 `getPuKey` 给的是**裸 DER 的 RSA 公钥**（base64）。客户端用 RSA/PKCS#1 v1.5
 * 加密密码再提交，服务端私钥解出来对照。这里不手写大数运算 —— `node:crypto` 的
 * `publicEncrypt` + `RSA_PKCS1_PADDING` 就是同一件事。
 *
 * 两个坑：
 *
 * 1. DER 可能是 SubjectPublicKeyInfo（`30 30 … 03 … 02`），也可能是裸 PKCS#1
 *    （`30 … 02 … 02`）。两种都试，不要假定。
 * 2. 密码长度超过 `k - 11` 字节时 PKCS#1 v1.5 直接失败 —— 错误要说人话，别把
 *    `data too large for key size` 丢给用户。
 *
 * @module dsh-loomy/rsa
 */

import { constants, createPublicKey, publicEncrypt, type KeyObject } from 'node:crypto'

/** 一条看起来像 base64 但缺 padding 的公钥也接受（Node 的 base64 解码会忽略尾部）。 */
function decodeBase64(value: string): Buffer {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('the account service returned an empty public key')
  return Buffer.from(trimmed, 'base64')
}

/** 把 base64 DER 变成可用的公钥对象；SPKI / PKCS#1 都试。 */
export function publicKeyFromDer(derBase64: string): KeyObject {
  const der = decodeBase64(derBase64)
  const attempts: { type: 'spki' | 'pkcs1'; error?: unknown }[] = [
    { type: 'spki' },
    { type: 'pkcs1' },
  ]
  let lastError: unknown
  for (const attempt of attempts) {
    try {
      return createPublicKey({ key: der, format: 'der', type: attempt.type })
    } catch (error: unknown) {
      lastError = error
    }
  }
  throw new Error(
    `could not parse the RSA public key from the account service (${
      lastError instanceof Error ? lastError.message : String(lastError)
    })`,
  )
}

/** 按 PKCS#1 v1.5 加密明文（密码），返回 base64 密文。 */
export function rsaEncrypt(derBase64: string, plaintext: string): string {
  const key = publicKeyFromDer(derBase64)
  const details = key.asymmetricKeyDetails
  const modulusBytes = details?.modulusLength === undefined ? 0 : Math.ceil(details.modulusLength / 8)
  const message = Buffer.from(plaintext, 'utf8')
  if (modulusBytes > 0 && message.length > modulusBytes - 11) {
    throw new Error(
      `the password is too long for the account service's RSA-${String(details?.modulusLength ?? 0)} key `
      + `(at most ${String(modulusBytes - 11)} bytes)`,
    )
  }
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    message,
  ).toString('base64')
}
