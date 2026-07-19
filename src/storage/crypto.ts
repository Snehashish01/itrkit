const encoder = new TextEncoder()
const decoder = new TextDecoder()
const verifierText = 'family-itr-vault-verifier-v1'

export type EncryptedPayload = {
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
}

export type VaultSecurity = {
  version: 1
  algorithm: 'AES-GCM'
  kdf: 'PBKDF2-SHA-256'
  iterations: number
  salt: ArrayBuffer
  verifier: EncryptedPayload
}

export type SerializedEncryptedPayload = {
  iv: string
  ciphertext: string
}

export type SerializedVaultSecurity = Omit<VaultSecurity, 'salt' | 'verifier'> & {
  salt: string
  verifier: SerializedEncryptedPayload
}

const iterations = 600_000

function bytesToBase64(value: ArrayBuffer) {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

async function deriveKey(passphrase: string, salt: ArrayBuffer, rounds: number) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function additionalData(value?: string) {
  return value ? encoder.encode(value) : undefined
}

function aesGcmParameters(iv: Uint8Array<ArrayBuffer>, authenticatedContext?: string) {
  const authenticatedData = additionalData(authenticatedContext)
  return authenticatedData
    ? { name: 'AES-GCM' as const, iv, additionalData: authenticatedData }
    : { name: 'AES-GCM' as const, iv }
}

export async function encryptBytes(
  key: CryptoKey,
  value: BufferSource,
  authenticatedContext?: string,
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  return {
    iv: iv.buffer,
    ciphertext: await crypto.subtle.encrypt(
      aesGcmParameters(iv, authenticatedContext),
      key,
      value,
    ),
  }
}

export async function decryptBytes(
  key: CryptoKey,
  payload: EncryptedPayload,
  authenticatedContext?: string,
) {
  return crypto.subtle.decrypt(
    aesGcmParameters(new Uint8Array(payload.iv), authenticatedContext),
    key,
    payload.ciphertext,
  )
}

export async function encryptJson(key: CryptoKey, value: unknown, authenticatedContext?: string) {
  return encryptBytes(key, encoder.encode(JSON.stringify(value)), authenticatedContext)
}

export async function decryptJson<T>(
  key: CryptoKey,
  payload: EncryptedPayload,
  authenticatedContext?: string,
): Promise<T> {
  return JSON.parse(
    decoder.decode(await decryptBytes(key, payload, authenticatedContext)),
  ) as T
}

export async function createVaultSecurity(passphrase: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)).buffer
  const key = await deriveKey(passphrase, salt, iterations)
  const security: VaultSecurity = {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA-256',
    iterations,
    salt,
    verifier: await encryptBytes(key, encoder.encode(verifierText)),
  }
  return { key, security }
}

export async function unlockVaultKey(passphrase: string, security: VaultSecurity) {
  const key = await deriveKey(passphrase, security.salt, security.iterations)
  const verifier = decoder.decode(await decryptBytes(key, security.verifier))
  if (verifier !== verifierText) throw new Error('Incorrect vault passphrase.')
  return key
}

export function serializePayload(payload: EncryptedPayload): SerializedEncryptedPayload {
  return {
    iv: bytesToBase64(payload.iv),
    ciphertext: bytesToBase64(payload.ciphertext),
  }
}

export function deserializePayload(payload: SerializedEncryptedPayload): EncryptedPayload {
  return {
    iv: base64ToBytes(payload.iv),
    ciphertext: base64ToBytes(payload.ciphertext),
  }
}

export function serializeSecurity(security: VaultSecurity): SerializedVaultSecurity {
  return {
    ...security,
    salt: bytesToBase64(security.salt),
    verifier: serializePayload(security.verifier),
  }
}

export function deserializeSecurity(security: SerializedVaultSecurity): VaultSecurity {
  return {
    ...security,
    salt: base64ToBytes(security.salt),
    verifier: deserializePayload(security.verifier),
  }
}