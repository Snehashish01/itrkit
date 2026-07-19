import { documentItems, isMember } from '../domain/filing'
import type { DocumentKey, Member } from '../domain/filing'
import type { DocumentAnalysis } from '../documents/extract'
import {
  createVaultSecurity,
  decryptBytes,
  decryptJson,
  deserializePayload,
  deserializeSecurity,
  encryptBytes,
  encryptJson,
  serializePayload,
  serializeSecurity,
  unlockVaultKey,
} from './crypto'
import type {
  EncryptedPayload,
  SerializedEncryptedPayload,
  SerializedVaultSecurity,
  VaultSecurity,
} from './crypto'

const databaseName = 'family-itr-vault'
const databaseVersion = 1
const legacyStorageKey = 'family-itr-organizer-v1'
const settingsStore = 'settings'
const membersKey = 'members'
const documentsStore = 'documents'
const conversationsStore = 'conversations'
const securityKey = 'security'
const manifestKey = 'manifest'
const membersContext = 'family-itr:members:v2'
const manifestContext = 'family-itr:manifest:v2'
const vaultLockName = 'family-itr-vault-write'

export type StoredDocument = {
  id: string
  memberId: string
  kind: DocumentKey
  name: string
  mediaType: string
  size: number
  addedAt: string
  sha256: string
  data: Blob
  analysis: DocumentAnalysis
}

export type StorageStatus = {
  usage: number
  quota: number
  persisted: boolean
}

export type ConversationMessage = {
  id: string
  memberId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  mode: 'local' | 'remote'
}

type EncryptedDocumentRecord = {
  version: 2
  id: string
  memberId: string
  metadata: EncryptedPayload
  data: EncryptedPayload
}

type EncryptedConversationRecord = {
  version: 2
  id: string
  memberId: string
  payload: EncryptedPayload
}

type EncryptedDocumentBackup = Omit<EncryptedDocumentRecord, 'metadata' | 'data'> & {
  metadata: SerializedEncryptedPayload
  data: SerializedEncryptedPayload
}

type EncryptedConversationBackup = Omit<EncryptedConversationRecord, 'payload'> & {
  payload: SerializedEncryptedPayload
}

type EncryptedVaultBackup = {
  format: 'family-itr-encrypted-v2'
  exportedAt: string
  security: SerializedVaultSecurity
  members: SerializedEncryptedPayload
  manifest: SerializedEncryptedPayload
  documents: EncryptedDocumentBackup[]
  conversations: EncryptedConversationBackup[]
}

type DocumentManifestRecord = {
  id: string
  memberId: string
  metadataDigest: string
  dataDigest: string
}

type ConversationManifestRecord = {
  id: string
  memberId: string
  payloadDigest: string
}

type VaultManifest = {
  version: 2
  revision: number
  membersDigest: string
  memberIds: string[]
  documents: DocumentManifestRecord[]
  conversations: ConversationManifestRecord[]
}

export type VaultState = 'setup' | 'locked' | 'unlocked'

let databasePromise: Promise<IDBDatabase> | null = null
let activeKey: CryptoKey | null = null
let activeRevision: number | null = null
let mutationQueue: Promise<void> = Promise.resolve()
const tabId = crypto.randomUUID()
const vaultChannel = typeof BroadcastChannel === 'undefined'
  ? null
  : new BroadcastChannel('family-itr-vault-events')

function invalidateLocalVault() {
  activeKey = null
  activeRevision = null
  window.dispatchEvent(new Event('family-itr-vault-invalidated'))
}

vaultChannel?.addEventListener('message', (event: MessageEvent<{ source: string; type: string }>) => {
  if (event.data?.source !== tabId && event.data?.type === 'invalidate') invalidateLocalVault()
})

function notifyOtherTabs() {
  vaultChannel?.postMessage({ source: tabId, type: 'invalidate' })
}

function requireCurrentRevision(manifest: VaultManifest) {
  if (activeRevision !== null && manifest.revision !== activeRevision) {
    invalidateLocalVault()
    throw new Error('This vault changed in another tab. Unlock it again before saving.')
  }
}

function commitRevision(manifest: VaultManifest) {
  activeRevision = manifest.revision
  notifyOtherTabs()
}

function serializeMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(async () => {
    if (navigator.locks) {
      return navigator.locks.request(vaultLockName, { mode: 'exclusive' }, task)
    }
    return task()
  })
  mutationQueue = run.then(() => undefined, () => undefined)
  return run
}

function recordContext(
  type: 'document-metadata' | 'document-data' | 'conversation',
  id: string,
  memberId: string,
) {
  return `family-itr:${type}:v2:${id}:${memberId}`
}

async function encryptedPayloadDigest(payload: EncryptedPayload) {
  const iv = new Uint8Array(payload.iv)
  const ciphertext = new Uint8Array(payload.ciphertext)
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength)
  combined.set(iv)
  combined.set(ciphertext, iv.byteLength)
  const digest = await crypto.subtle.digest('SHA-256', combined)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function documentManifestRecord(
  record: EncryptedDocumentRecord,
): Promise<DocumentManifestRecord> {
  return {
    id: record.id,
    memberId: record.memberId,
    metadataDigest: await encryptedPayloadDigest(record.metadata),
    dataDigest: await encryptedPayloadDigest(record.data),
  }
}

async function conversationManifestRecord(
  record: EncryptedConversationRecord,
): Promise<ConversationManifestRecord> {
  return {
    id: record.id,
    memberId: record.memberId,
    payloadDigest: await encryptedPayloadDigest(record.payload),
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Browser vault request failed.'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser vault transaction aborted.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser vault transaction failed.'))
  })
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(settingsStore)) {
        database.createObjectStore(settingsStore)
      }
      if (!database.objectStoreNames.contains(documentsStore)) {
        const documents = database.createObjectStore(documentsStore, { keyPath: 'id' })
        documents.createIndex('memberId', 'memberId')
      }
      if (!database.objectStoreNames.contains('facts')) {
        const facts = database.createObjectStore('facts', { keyPath: 'id' })
        facts.createIndex('memberId', 'memberId')
      }
      if (!database.objectStoreNames.contains(conversationsStore)) {
        const conversations = database.createObjectStore(conversationsStore, { keyPath: 'id' })
        conversations.createIndex('memberId', 'memberId')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      databasePromise = null
      reject(request.error ?? new Error('Could not open the browser vault.'))
    }
    request.onblocked = () => {
      databasePromise = null
      reject(new Error('Close other tabs using this app, then try again.'))
    }
  })

  return databasePromise
}

async function readSetting<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase()
  const transaction = database.transaction(settingsStore, 'readonly')
  const completed = transactionComplete(transaction)
  const value = await requestResult(transaction.objectStore(settingsStore).get(key))
  await completed
  return value as T | undefined
}

function requireKey() {
  if (!activeKey) throw new Error('The private browser vault is locked.')
  return activeKey
}

function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<EncryptedPayload>
  return payload.iv instanceof ArrayBuffer && payload.ciphertext instanceof ArrayBuffer
}

function isEncryptedDocument(value: unknown): value is EncryptedDocumentRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<EncryptedDocumentRecord>
  return (
    record.version === 2 &&
    typeof record.id === 'string' &&
    typeof record.memberId === 'string' &&
    isEncryptedPayload(record.metadata) &&
    isEncryptedPayload(record.data)
  )
}

function isEncryptedConversation(value: unknown): value is EncryptedConversationRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<EncryptedConversationRecord>
  return (
    record.version === 2 &&
    typeof record.id === 'string' &&
    typeof record.memberId === 'string' &&
    isEncryptedPayload(record.payload)
  )
}

function isLegacyEncryptedDocument(
  value: unknown,
): value is Omit<EncryptedDocumentRecord, 'version'> {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<EncryptedDocumentRecord>
  return (
    record.version === undefined &&
    typeof record.id === 'string' &&
    typeof record.memberId === 'string' &&
    isEncryptedPayload(record.metadata) &&
    isEncryptedPayload(record.data)
  )
}

function isLegacyEncryptedConversation(
  value: unknown,
): value is Omit<EncryptedConversationRecord, 'version'> {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<EncryptedConversationRecord>
  return (
    record.version === undefined &&
    typeof record.id === 'string' &&
    typeof record.memberId === 'string' &&
    isEncryptedPayload(record.payload)
  )
}

function isManifest(value: unknown): value is VaultManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<VaultManifest>
  const digestIsValid = (digest: unknown) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
  const documentRecordsAreValid = (records: unknown) =>
    Array.isArray(records) && records.every((value) => {
      const record = value as Partial<DocumentManifestRecord>
      return (
        !!record &&
        typeof record.id === 'string' &&
        typeof record.memberId === 'string' &&
        digestIsValid(record.metadataDigest) &&
        digestIsValid(record.dataDigest)
      )
    })
  const conversationRecordsAreValid = (records: unknown) =>
    Array.isArray(records) && records.every((value) => {
      const record = value as Partial<ConversationManifestRecord>
      return (
        !!record &&
        typeof record.id === 'string' &&
        typeof record.memberId === 'string' &&
        digestIsValid(record.payloadDigest)
      )
    })
  return (
    manifest.version === 2 &&
    Number.isSafeInteger(manifest.revision) &&
    digestIsValid(manifest.membersDigest) &&
    Array.isArray(manifest.memberIds) &&
    manifest.memberIds.every((id) => typeof id === 'string') &&
    documentRecordsAreValid(manifest.documents) &&
    conversationRecordsAreValid(manifest.conversations)
  )
}

async function readManifest(key: CryptoKey): Promise<VaultManifest> {
  const encrypted = await readSetting<EncryptedPayload>(manifestKey)
  if (!isEncryptedPayload(encrypted)) throw new Error('The encrypted vault manifest is missing.')
  const manifest = await decryptJson<unknown>(key, encrypted, manifestContext)
  if (!isManifest(manifest)) throw new Error('The encrypted vault manifest is invalid.')
  return manifest
}

function sameManifestRecords<T extends { id: string }>(expected: T[], actual: T[]) {
  const normalize = (records: T[]) => [...records].sort((left, right) => left.id.localeCompare(right.id))
  return JSON.stringify(normalize(expected)) === JSON.stringify(normalize(actual))
}

function isRoutingOnlyManifest(value: unknown): value is {
  version: 2
  revision: number
  memberIds: string[]
  documents: Array<{ id: string; memberId: string }>
  conversations: Array<{ id: string; memberId: string }>
} {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Record<string, unknown>
  const recordsAreRoutingOnly = (records: unknown) =>
    Array.isArray(records) && records.every(
      (record) =>
        !!record &&
        typeof record === 'object' &&
        typeof (record as { id?: unknown }).id === 'string' &&
        typeof (record as { memberId?: unknown }).memberId === 'string',
    )
  return (
    manifest.version === 2 &&
    Number.isSafeInteger(manifest.revision) &&
    Array.isArray(manifest.memberIds) &&
    manifest.memberIds.every((id) => typeof id === 'string') &&
    recordsAreRoutingOnly(manifest.documents) &&
    recordsAreRoutingOnly(manifest.conversations)
  )
}

export async function getVaultState(): Promise<VaultState> {
  const security = await readSetting<VaultSecurity>(securityKey)
  if (!security) return 'setup'
  return activeKey ? 'unlocked' : 'locked'
}

async function enableVaultEncryptionInternal(passphrase: string): Promise<void> {
  if (passphrase.length < 12) throw new Error('Use a passphrase with at least 12 characters.')
  if (await readSetting<VaultSecurity>(securityKey)) {
    throw new Error('Vault encryption is already configured.')
  }

  const database = await openDatabase()
  const readTransaction = database.transaction(
    [settingsStore, documentsStore, conversationsStore],
    'readonly',
  )
  const readCompleted = transactionComplete(readTransaction)
  const settings = readTransaction.objectStore(settingsStore)
  const [savedMembers, savedDocuments, savedConversations] = await Promise.all([
    requestResult(settings.get(membersKey)) as Promise<unknown>,
    requestResult(readTransaction.objectStore(documentsStore).getAll()) as Promise<unknown[]>,
    requestResult(readTransaction.objectStore(conversationsStore).getAll()) as Promise<unknown[]>,
  ])
  await readCompleted

  const members = Array.isArray(savedMembers)
    ? savedMembers.filter(isMember)
    : readLegacyMembers()
  if (savedMembers !== undefined && (!Array.isArray(savedMembers) || members.length !== savedMembers.length)) {
    throw new Error('Existing member data is invalid; encryption was not changed.')
  }
  const documents = savedDocuments.filter(
    (value): value is StoredDocument =>
      !!value && typeof value === 'object' && 'data' in value && !isEncryptedDocument(value),
  )
  const conversations = savedConversations.filter(
    (value): value is ConversationMessage =>
      !!value && typeof value === 'object' && 'content' in value && !isEncryptedConversation(value),
  )
  if (documents.length !== savedDocuments.length || conversations.length !== savedConversations.length) {
    throw new Error('Existing vault records have an unexpected format; encryption was not changed.')
  }

  const { key, security } = await createVaultSecurity(passphrase)
  const encryptedMembers = await encryptJson(key, members, membersContext)
  const encryptedDocuments = await Promise.all(
    documents.map(async (document): Promise<EncryptedDocumentRecord> => {
      const { id, memberId, data, ...metadata } = document
      return {
        version: 2,
        id,
        memberId,
        metadata: await encryptJson(
          key,
          metadata,
          recordContext('document-metadata', id, memberId),
        ),
        data: await encryptBytes(
          key,
          await data.arrayBuffer(),
          recordContext('document-data', id, memberId),
        ),
      }
    }),
  )
  const encryptedConversations = await Promise.all(
    conversations.map(async ({ id, memberId, ...message }): Promise<EncryptedConversationRecord> => ({
      version: 2,
      id,
      memberId,
      payload: await encryptJson(key, message, recordContext('conversation', id, memberId)),
    })),
  )
  const manifest: VaultManifest = {
    version: 2,
    revision: 1,
    membersDigest: await encryptedPayloadDigest(encryptedMembers),
    memberIds: members.map(({ id }) => id),
    documents: await Promise.all(encryptedDocuments.map(documentManifestRecord)),
    conversations: await Promise.all(encryptedConversations.map(conversationManifestRecord)),
  }
  const encryptedManifest = await encryptJson(key, manifest, manifestContext)

  const writeTransaction = database.transaction(
    [settingsStore, documentsStore, conversationsStore],
    'readwrite',
  )
  const writeCompleted = transactionComplete(writeTransaction)
  writeTransaction.objectStore(settingsStore).put(encryptedMembers, membersKey)
  writeTransaction.objectStore(settingsStore).put(security, securityKey)
  writeTransaction.objectStore(settingsStore).put(encryptedManifest, manifestKey)
  const documentStore = writeTransaction.objectStore(documentsStore)
  documentStore.clear()
  encryptedDocuments.forEach((record) => documentStore.put(record))
  const conversationStore = writeTransaction.objectStore(conversationsStore)
  conversationStore.clear()
  encryptedConversations.forEach((record) => conversationStore.put(record))
  await writeCompleted
  localStorage.removeItem(legacyStorageKey)
  activeKey = key
  activeRevision = manifest.revision
}

export async function enableVaultEncryption(passphrase: string): Promise<void> {
  await serializeMutation(() => enableVaultEncryptionInternal(passphrase))
  notifyOtherTabs()
}

async function upgradeAuthenticatedStorage(key: CryptoKey): Promise<VaultManifest> {
  const existingManifest = await readSetting<EncryptedPayload>(manifestKey)
  if (existingManifest !== undefined) {
    if (!isEncryptedPayload(existingManifest)) throw new Error('The vault manifest is invalid.')
    const decodedManifest = await decryptJson<unknown>(key, existingManifest, manifestContext)
    if (!isManifest(decodedManifest) && !isRoutingOnlyManifest(decodedManifest)) {
      throw new Error('The vault manifest is invalid.')
    }
    const database = await openDatabase()
    const transaction = database.transaction(
      [settingsStore, documentsStore, conversationsStore],
      'readonly',
    )
    const completed = transactionComplete(transaction)
    const [savedMembers, rawDocuments, rawConversations] = await Promise.all([
      requestResult(transaction.objectStore(settingsStore).get(membersKey)) as Promise<unknown>,
      requestResult(transaction.objectStore(documentsStore).getAll()) as Promise<unknown[]>,
      requestResult(transaction.objectStore(conversationsStore).getAll()) as Promise<unknown[]>,
    ])
    await completed
    if (
      !isEncryptedPayload(savedMembers) ||
      !rawDocuments.every(isEncryptedDocument) ||
      !rawConversations.every(isEncryptedConversation)
    ) {
      throw new Error('The vault contains invalid encrypted records.')
    }
    const documentEntries = await Promise.all(
      (rawDocuments as EncryptedDocumentRecord[]).map(documentManifestRecord),
    )
    const conversationEntries = await Promise.all(
      (rawConversations as EncryptedConversationRecord[]).map(conversationManifestRecord),
    )
    if (isManifest(decodedManifest)) {
      if (decodedManifest.membersDigest !== await encryptedPayloadDigest(savedMembers)) {
        throw new Error('Member state does not match the authenticated manifest.')
      }
      if (
        !sameManifestRecords(decodedManifest.documents, documentEntries) ||
        !sameManifestRecords(decodedManifest.conversations, conversationEntries)
      ) {
        throw new Error('Vault records do not match the authenticated manifest.')
      }
    }
    if (!isManifest(decodedManifest)) {
      const oldRoutes = (records: Array<{ id: string; memberId: string }>) =>
        records.map(({ id, memberId }) => `${id}:${memberId}`).sort()
      if (
        JSON.stringify(oldRoutes(decodedManifest.documents)) !==
          JSON.stringify(oldRoutes(rawDocuments as EncryptedDocumentRecord[])) ||
        JSON.stringify(oldRoutes(decodedManifest.conversations)) !==
          JSON.stringify(oldRoutes(rawConversations as EncryptedConversationRecord[]))
      ) {
        throw new Error('Vault routes do not match the authenticated legacy manifest.')
      }
      const upgradedManifest: VaultManifest = {
        version: 2,
        revision: decodedManifest.revision + 1,
        membersDigest: await encryptedPayloadDigest(savedMembers),
        memberIds: decodedManifest.memberIds,
        documents: documentEntries,
        conversations: conversationEntries,
      }
      const encryptedManifest = await encryptJson(key, upgradedManifest, manifestContext)
      const writeTransaction = database.transaction(settingsStore, 'readwrite')
      const writeCompleted = transactionComplete(writeTransaction)
      writeTransaction.objectStore(settingsStore).put(encryptedManifest, manifestKey)
      await writeCompleted
      notifyOtherTabs()
      return upgradedManifest
    }
    return decodedManifest
  }

  const database = await openDatabase()
  const readTransaction = database.transaction(
    [settingsStore, documentsStore, conversationsStore],
    'readonly',
  )
  const readCompleted = transactionComplete(readTransaction)
  const [savedMembers, rawDocuments, rawConversations] = await Promise.all([
    requestResult(readTransaction.objectStore(settingsStore).get(membersKey)) as Promise<unknown>,
    requestResult(readTransaction.objectStore(documentsStore).getAll()) as Promise<unknown[]>,
    requestResult(readTransaction.objectStore(conversationsStore).getAll()) as Promise<unknown[]>,
  ])
  await readCompleted
  if (!isEncryptedPayload(savedMembers)) throw new Error('Encrypted member data is missing.')
  if (!rawDocuments.every(isLegacyEncryptedDocument) || !rawConversations.every(isLegacyEncryptedConversation)) {
    throw new Error('The vault contains mixed or unsupported encrypted records.')
  }

  const members = await decryptJson<unknown>(key, savedMembers)
  if (!Array.isArray(members) || !members.every(isMember)) {
    throw new Error('Encrypted member data is invalid.')
  }
  const documents = await Promise.all(
    rawDocuments.map(async ({ id, memberId, metadata, data }): Promise<EncryptedDocumentRecord> => {
      const decryptedMetadata = await decryptJson<unknown>(key, metadata)
      const decryptedData = await decryptBytes(key, data)
      return {
        version: 2,
        id,
        memberId,
        metadata: await encryptJson(
          key,
          decryptedMetadata,
          recordContext('document-metadata', id, memberId),
        ),
        data: await encryptBytes(
          key,
          decryptedData,
          recordContext('document-data', id, memberId),
        ),
      }
    }),
  )
  const conversations = await Promise.all(
    rawConversations.map(async ({ id, memberId, payload }): Promise<EncryptedConversationRecord> => ({
      version: 2,
      id,
      memberId,
      payload: await encryptJson(
        key,
        await decryptJson(key, payload),
        recordContext('conversation', id, memberId),
      ),
    })),
  )
  const manifest: VaultManifest = {
    version: 2,
    revision: 1,
    membersDigest: '',
    memberIds: members.map(({ id }) => id),
    documents: await Promise.all(documents.map(documentManifestRecord)),
    conversations: await Promise.all(conversations.map(conversationManifestRecord)),
  }
  const encryptedMembers = await encryptJson(key, members, membersContext)
  manifest.membersDigest = await encryptedPayloadDigest(encryptedMembers)
  const finalEncryptedManifest = await encryptJson(key, manifest, manifestContext)

  const writeTransaction = database.transaction(
    [settingsStore, documentsStore, conversationsStore],
    'readwrite',
  )
  const writeCompleted = transactionComplete(writeTransaction)
  const settings = writeTransaction.objectStore(settingsStore)
  settings.put(encryptedMembers, membersKey)
  settings.put(finalEncryptedManifest, manifestKey)
  const documentStore = writeTransaction.objectStore(documentsStore)
  documentStore.clear()
  documents.forEach((record) => documentStore.put(record))
  const conversationStore = writeTransaction.objectStore(conversationsStore)
  conversationStore.clear()
  conversations.forEach((record) => conversationStore.put(record))
  await writeCompleted
  notifyOtherTabs()
  return manifest
}

export async function unlockVault(passphrase: string): Promise<void> {
  const security = await readSetting<VaultSecurity>(securityKey)
  if (!security) throw new Error('Vault encryption has not been configured.')
  let key: CryptoKey
  try {
    key = await unlockVaultKey(passphrase, security)
  } catch {
    activeKey = null
    throw new Error('Incorrect vault passphrase.')
  }
  try {
    const manifest = await serializeMutation(() => upgradeAuthenticatedStorage(key))
    activeKey = key
    activeRevision = manifest.revision
  } catch (error) {
    activeKey = null
    const detail = error instanceof Error ? ` ${error.message}` : ''
    throw new Error(`The vault could not be upgraded safely. No records were changed.${detail}`)
  }
}

export function lockVault(notify = false) {
  activeKey = null
  activeRevision = null
  if (notify) notifyOtherTabs()
}

function readLegacyMembers(): Member[] {
  const value = localStorage.getItem(legacyStorageKey)
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Legacy organizer data is not valid JSON; it was not changed.')
  }
  if (!Array.isArray(parsed) || !parsed.every(isMember)) {
    throw new Error('Legacy organizer data contains invalid records; it was not changed.')
  }
  return parsed
}

export async function loadMembers(): Promise<Member[]> {
  const key = requireKey()
  const database = await openDatabase()
  const transaction = database.transaction(settingsStore, 'readonly')
  const completed = transactionComplete(transaction)
  const saved: unknown = await requestResult(transaction.objectStore(settingsStore).get(membersKey))
  await completed
  if (!isEncryptedPayload(saved)) throw new Error('Encrypted member data is missing or invalid.')
  const members = await decryptJson<unknown>(key, saved, membersContext)
  if (!Array.isArray(members) || !members.every(isMember)) {
    throw new Error('Encrypted member data is invalid.')
  }
  const manifest = await readManifest(key)
  requireCurrentRevision(manifest)
  if (manifest.membersDigest !== await encryptedPayloadDigest(saved)) {
    throw new Error('Member state does not match the authenticated vault manifest.')
  }
  const memberIds = members.map(({ id }) => id).sort()
  if (JSON.stringify(memberIds) !== JSON.stringify([...manifest.memberIds].sort())) {
    throw new Error('The member list does not match the authenticated vault manifest.')
  }
  return members
}

export async function saveMembers(members: Member[]): Promise<void> {
  return serializeMutation(async () => {
    const key = requireKey()
    const manifest = await readManifest(key)
    requireCurrentRevision(manifest)
    const encryptedMembers = await encryptJson(key, members, membersContext)
    const nextManifest: VaultManifest = {
      ...manifest,
      revision: manifest.revision + 1,
      membersDigest: await encryptedPayloadDigest(encryptedMembers),
      memberIds: members.map(({ id }) => id),
    }
    const encryptedManifest = await encryptJson(key, nextManifest, manifestContext)
    const database = await openDatabase()
    const transaction = database.transaction(settingsStore, 'readwrite')
    const completed = transactionComplete(transaction)
    const settings = transaction.objectStore(settingsStore)
    settings.put(encryptedMembers, membersKey)
    settings.put(encryptedManifest, manifestKey)
    await completed
    commitRevision(nextManifest)
  })
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Bytes(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function storeDocument(
  memberId: string,
  kind: DocumentKey,
  file: File,
  analysis: DocumentAnalysis,
): Promise<StoredDocument> {
  const document: StoredDocument = {
    id: crypto.randomUUID(),
    memberId,
    kind,
    name: file.name,
    mediaType: file.type || 'application/octet-stream',
    size: file.size,
    addedAt: new Date().toISOString(),
    sha256: await sha256(file),
    data: file,
    analysis,
  }
  await serializeMutation(async () => {
    const key = requireKey()
    const manifest = await readManifest(key)
    requireCurrentRevision(manifest)
    if (!manifest.memberIds.includes(memberId)) throw new Error('The selected member is not in the vault.')
    const { id, memberId: savedMemberId, data, ...metadata } = document
    const encrypted: EncryptedDocumentRecord = {
      version: 2,
      id,
      memberId: savedMemberId,
      metadata: await encryptJson(
        key,
        metadata,
        recordContext('document-metadata', id, savedMemberId),
      ),
      data: await encryptBytes(
        key,
        await data.arrayBuffer(),
        recordContext('document-data', id, savedMemberId),
      ),
    }
    const nextManifest: VaultManifest = {
      ...manifest,
      revision: manifest.revision + 1,
      documents: [...manifest.documents, await documentManifestRecord(encrypted)],
    }
    const encryptedManifest = await encryptJson(key, nextManifest, manifestContext)
    const database = await openDatabase()
    const transaction = database.transaction([settingsStore, documentsStore], 'readwrite')
    const completed = transactionComplete(transaction)
    transaction.objectStore(documentsStore).add(encrypted)
    transaction.objectStore(settingsStore).put(encryptedManifest, manifestKey)
    await completed
    commitRevision(nextManifest)
  })
  return document
}

export async function listDocuments(memberId: string): Promise<StoredDocument[]> {
  const key = requireKey()
  const manifest = await readManifest(key)
  requireCurrentRevision(manifest)
  const database = await openDatabase()
  const transaction = database.transaction(documentsStore, 'readonly')
  const completed = transactionComplete(transaction)
  const rawRecords = await requestResult(transaction.objectStore(documentsStore).getAll()) as unknown[]
  await completed
  if (!rawRecords.every(isEncryptedDocument)) throw new Error('The vault contains invalid document records.')
  const records = rawRecords as EncryptedDocumentRecord[]
  if (!sameManifestRecords(manifest.documents, await Promise.all(records.map(documentManifestRecord)))) {
    throw new Error('Stored documents do not match the authenticated vault manifest.')
  }
  const documents = await Promise.all(
    records.filter((record) => record.memberId === memberId).map(async ({ id, memberId: savedMemberId, metadata, data }) => {
      const savedMetadata = await decryptJson<Omit<StoredDocument, 'id' | 'memberId' | 'data'>>(
        key,
        metadata,
        recordContext('document-metadata', id, savedMemberId),
      )
      if (!isDocumentMetadata(savedMetadata)) {
        throw new Error('A stored document has invalid authenticated metadata.')
      }
      const decryptedData = await decryptBytes(
        key,
        data,
        recordContext('document-data', id, savedMemberId),
      )
      if (await sha256Bytes(decryptedData) !== savedMetadata.sha256) {
        throw new Error('A stored document failed its integrity check.')
      }
      return {
        id,
        memberId: savedMemberId,
        ...savedMetadata,
        data: new Blob([decryptedData], { type: savedMetadata.mediaType }),
      }
    }),
  )
  return documents.sort((left, right) => right.addedAt.localeCompare(left.addedAt))
}

export async function deleteDocument(id: string): Promise<void> {
  return serializeMutation(async () => {
    const key = requireKey()
    const manifest = await readManifest(key)
    requireCurrentRevision(manifest)
    if (!manifest.documents.some((record) => record.id === id)) return
    const nextManifest: VaultManifest = {
      ...manifest,
      revision: manifest.revision + 1,
      documents: manifest.documents.filter((record) => record.id !== id),
    }
    const encryptedManifest = await encryptJson(key, nextManifest, manifestContext)
    const database = await openDatabase()
    const transaction = database.transaction([settingsStore, documentsStore], 'readwrite')
    const completed = transactionComplete(transaction)
    transaction.objectStore(documentsStore).delete(id)
    transaction.objectStore(settingsStore).put(encryptedManifest, manifestKey)
    await completed
    commitRevision(nextManifest)
  })
}

export async function deleteMemberDocuments(memberId: string): Promise<void> {
  return serializeMutation(async () => {
    const key = requireKey()
    const manifest = await readManifest(key)
    requireCurrentRevision(manifest)
    const removed = manifest.documents.filter((record) => record.memberId === memberId)
    if (removed.length === 0) return
    const nextManifest: VaultManifest = {
      ...manifest,
      revision: manifest.revision + 1,
      documents: manifest.documents.filter((record) => record.memberId !== memberId),
    }
    const encryptedManifest = await encryptJson(key, nextManifest, manifestContext)
    const database = await openDatabase()
    const transaction = database.transaction([settingsStore, documentsStore], 'readwrite')
    const completed = transactionComplete(transaction)
    const store = transaction.objectStore(documentsStore)
    removed.forEach(({ id }) => store.delete(id))
    transaction.objectStore(settingsStore).put(encryptedManifest, manifestKey)
    await completed
    commitRevision(nextManifest)
  })
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const estimate = await navigator.storage?.estimate()
  const persisted = (await navigator.storage?.persisted?.()) ?? false
  return {
    usage: estimate?.usage ?? 0,
    quota: estimate?.quota ?? 0,
    persisted,
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false
}

export async function listConversation(memberId: string): Promise<ConversationMessage[]> {
  const key = requireKey()
  const manifest = await readManifest(key)
  requireCurrentRevision(manifest)
  const database = await openDatabase()
  const transaction = database.transaction(conversationsStore, 'readonly')
  const completed = transactionComplete(transaction)
  const rawRecords = await requestResult(transaction.objectStore(conversationsStore).getAll()) as unknown[]
  await completed
  if (!rawRecords.every(isEncryptedConversation)) {
    throw new Error('The vault contains invalid conversation records.')
  }
  const records = rawRecords as EncryptedConversationRecord[]
  if (
    !sameManifestRecords(
      manifest.conversations,
      await Promise.all(records.map(conversationManifestRecord)),
    )
  ) {
    throw new Error('Stored conversations do not match the authenticated vault manifest.')
  }
  const messages = await Promise.all(
    records.filter((record) => record.memberId === memberId).map(async ({ id, memberId: savedMemberId, payload }) => {
      const message = await decryptJson<Omit<ConversationMessage, 'id' | 'memberId'>>(
        key,
        payload,
        recordContext('conversation', id, savedMemberId),
      )
      if (!isConversationPayload(message)) {
        throw new Error('A stored conversation message has invalid authenticated data.')
      }
      return { id, memberId: savedMemberId, ...message }
    }),
  )
  return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export async function appendConversationMessage(
  message: Omit<ConversationMessage, 'id' | 'createdAt'>,
): Promise<ConversationMessage> {
  const saved: ConversationMessage = {
    ...message,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }
  await serializeMutation(async () => {
    const key = requireKey()
    const manifest = await readManifest(key)
    requireCurrentRevision(manifest)
    const { id, memberId, ...messagePayload } = saved
    const encrypted: EncryptedConversationRecord = {
      version: 2,
      id,
      memberId,
      payload: await encryptJson(
        key,
        messagePayload,
        recordContext('conversation', id, memberId),
      ),
    }
    const nextManifest: VaultManifest = {
      ...manifest,
      revision: manifest.revision + 1,
      conversations: [...manifest.conversations, await conversationManifestRecord(encrypted)],
    }
    const encryptedManifest = await encryptJson(key, nextManifest, manifestContext)
    const database = await openDatabase()
    const transaction = database.transaction([settingsStore, conversationsStore], 'readwrite')
    const completed = transactionComplete(transaction)
    transaction.objectStore(conversationsStore).add(encrypted)
    transaction.objectStore(settingsStore).put(encryptedManifest, manifestKey)
    await completed
    commitRevision(nextManifest)
  })
  return saved
}

export async function clearConversation(memberId: string): Promise<void> {
  return serializeMutation(async () => {
    const key = requireKey()
    const manifest = await readManifest(key)
    requireCurrentRevision(manifest)
    const removed = manifest.conversations.filter((record) => record.memberId === memberId)
    if (removed.length === 0) return
    const nextManifest: VaultManifest = {
      ...manifest,
      revision: manifest.revision + 1,
      conversations: manifest.conversations.filter((record) => record.memberId !== memberId),
    }
    const encryptedManifest = await encryptJson(key, nextManifest, manifestContext)
    const database = await openDatabase()
    const transaction = database.transaction([settingsStore, conversationsStore], 'readwrite')
    const completed = transactionComplete(transaction)
    const store = transaction.objectStore(conversationsStore)
    removed.forEach(({ id }) => store.delete(id))
    transaction.objectStore(settingsStore).put(encryptedManifest, manifestKey)
    await completed
    commitRevision(nextManifest)
  })
}

export async function deleteMemberRecords(members: Member[], memberId: string): Promise<void> {
  return serializeMutation(async () => {
    const key = requireKey()
    const manifest = await readManifest(key)
    requireCurrentRevision(manifest)
    const removedDocuments = manifest.documents.filter((record) => record.memberId === memberId)
    const removedConversations = manifest.conversations.filter(
      (record) => record.memberId === memberId,
    )
    const encryptedMembers = await encryptJson(key, members, membersContext)
    const nextManifest: VaultManifest = {
      ...manifest,
      revision: manifest.revision + 1,
      membersDigest: await encryptedPayloadDigest(encryptedMembers),
      memberIds: members.map(({ id }) => id),
      documents: manifest.documents.filter((record) => record.memberId !== memberId),
      conversations: manifest.conversations.filter((record) => record.memberId !== memberId),
    }
    const encryptedManifest = await encryptJson(key, nextManifest, manifestContext)
    const database = await openDatabase()
    const transaction = database.transaction(
      [settingsStore, documentsStore, conversationsStore],
      'readwrite',
    )
    const completed = transactionComplete(transaction)
    const settings = transaction.objectStore(settingsStore)
    settings.put(encryptedMembers, membersKey)
    settings.put(encryptedManifest, manifestKey)
    const documentStore = transaction.objectStore(documentsStore)
    removedDocuments.forEach(({ id }) => documentStore.delete(id))
    const conversationStore = transaction.objectStore(conversationsStore)
    removedConversations.forEach(({ id }) => conversationStore.delete(id))
    await completed
    commitRevision(nextManifest)
  })
}

export async function exportEncryptedBackup(): Promise<Blob> {
  return serializeMutation(async () => {
    const key = requireKey()
    const database = await openDatabase()
    const transaction = database.transaction(
      [settingsStore, documentsStore, conversationsStore],
      'readonly',
    )
    const completed = transactionComplete(transaction)
    const settings = transaction.objectStore(settingsStore)
    const [security, members, encryptedManifest, rawDocuments, rawConversations] = await Promise.all([
      requestResult(settings.get(securityKey)) as Promise<unknown>,
      requestResult(settings.get(membersKey)) as Promise<unknown>,
      requestResult(settings.get(manifestKey)) as Promise<unknown>,
      requestResult(transaction.objectStore(documentsStore).getAll()) as Promise<unknown[]>,
      requestResult(transaction.objectStore(conversationsStore).getAll()) as Promise<unknown[]>,
    ])
    await completed
    if (
      !security ||
      !isEncryptedPayload(members) ||
      !isEncryptedPayload(encryptedManifest) ||
      !rawDocuments.every(isEncryptedDocument) ||
      !rawConversations.every(isEncryptedConversation)
    ) {
      throw new Error('The encrypted vault is incomplete.')
    }
    const manifest = await decryptJson<unknown>(key, encryptedManifest, manifestContext)
    if (!isManifest(manifest)) throw new Error('The encrypted vault manifest is invalid.')
    requireCurrentRevision(manifest)
    if (manifest.membersDigest !== await encryptedPayloadDigest(members)) {
      throw new Error('Member state does not match the authenticated manifest.')
    }
    const documents = rawDocuments as EncryptedDocumentRecord[]
    const conversations = rawConversations as EncryptedConversationRecord[]
    if (
      !sameManifestRecords(
        manifest.documents,
        await Promise.all(documents.map(documentManifestRecord)),
      ) ||
      !sameManifestRecords(
        manifest.conversations,
        await Promise.all(conversations.map(conversationManifestRecord)),
      )
    ) {
      throw new Error('Vault records do not match the authenticated manifest.')
    }

    const backup: EncryptedVaultBackup = {
      format: 'family-itr-encrypted-v2',
      exportedAt: new Date().toISOString(),
      security: serializeSecurity(security as VaultSecurity),
      members: serializePayload(members),
      manifest: serializePayload(encryptedManifest),
      documents: documents.map(({ metadata, data, ...record }) => ({
        ...record,
        metadata: serializePayload(metadata),
        data: serializePayload(data),
      })),
      conversations: conversations.map(({ payload, ...record }) => ({
        ...record,
        payload: serializePayload(payload),
      })),
    }
    return new Blob([JSON.stringify(backup)], { type: 'application/json' })
  })
}

export async function restoreEncryptedBackup(file: File, passphrase: string): Promise<void> {
  if (file.size > 100 * 1024 * 1024) throw new Error('Encrypted backups must be 100 MB or smaller.')
  const parsed: unknown = JSON.parse(await file.text())
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid encrypted backup.')
  const backup = parsed as Partial<EncryptedVaultBackup>
  if (
    backup.format !== 'family-itr-encrypted-v2' ||
    !backup.security ||
    !backup.members ||
    !backup.manifest ||
    !Array.isArray(backup.documents) ||
    !Array.isArray(backup.conversations) ||
    backup.documents.length > 500 ||
    backup.conversations.length > 10_000
  ) {
    throw new Error('Invalid encrypted backup.')
  }

  const payloadSizeIsAllowed = (payload: SerializedEncryptedPayload, maximum: number) =>
    typeof payload?.iv === 'string' &&
    payload.iv.length <= 32 &&
    typeof payload?.ciphertext === 'string' &&
    payload.ciphertext.length <= maximum
  if (
    !payloadSizeIsAllowed(backup.members, 5 * 1024 * 1024) ||
    !payloadSizeIsAllowed(backup.manifest, 5 * 1024 * 1024) ||
    backup.documents.some(
      ({ metadata, data }) =>
        !payloadSizeIsAllowed(metadata, 8 * 1024 * 1024) ||
        !payloadSizeIsAllowed(data, 35 * 1024 * 1024),
    ) ||
    backup.conversations.some(({ payload }) => !payloadSizeIsAllowed(payload, 100_000))
  ) {
    throw new Error('The encrypted backup exceeds safe record limits.')
  }

  const security = deserializeSecurity(backup.security)
  if (
    security.version !== 1 ||
    security.algorithm !== 'AES-GCM' ||
    security.kdf !== 'PBKDF2-SHA-256' ||
    security.iterations < 100_000 ||
    security.iterations > 1_000_000 ||
    security.salt.byteLength !== 16
  ) {
    throw new Error('The encrypted backup uses unsupported security settings.')
  }
  const members = deserializePayload(backup.members)
  const encryptedManifest = deserializePayload(backup.manifest)
  const documents: EncryptedDocumentRecord[] = backup.documents.map(
    ({ metadata, data, ...record }) => ({
      ...record,
      metadata: deserializePayload(metadata),
      data: deserializePayload(data),
    }),
  )
  const conversations: EncryptedConversationRecord[] = backup.conversations.map(
    ({ payload, ...record }) => ({ ...record, payload: deserializePayload(payload) }),
  )
  if (!documents.every(isEncryptedDocument) || !conversations.every(isEncryptedConversation)) {
    throw new Error('The encrypted backup contains invalid record envelopes.')
  }

  let backupKey: CryptoKey
  try {
    backupKey = await unlockVaultKey(passphrase, security)
  } catch {
    throw new Error('Incorrect backup passphrase.')
  }
  const decodedMembers = await decryptJson<unknown>(backupKey, members, membersContext)
  if (!Array.isArray(decodedMembers) || !decodedMembers.every(isMember)) {
    throw new Error('The encrypted backup contains invalid member data.')
  }
  const manifest = await decryptJson<unknown>(backupKey, encryptedManifest, manifestContext)
  if (!isManifest(manifest)) throw new Error('The encrypted backup manifest is invalid.')
  if (manifest.membersDigest !== await encryptedPayloadDigest(members)) {
    throw new Error('The encrypted member state does not match the backup manifest.')
  }
  const memberIds = new Set(decodedMembers.map(({ id }) => id))
  const recordIds = [...documents, ...conversations].map(({ id }) => id)
  if (new Set(recordIds).size !== recordIds.length) {
    throw new Error('The encrypted backup contains duplicate record IDs.')
  }
  if ([...documents, ...conversations].some(({ memberId }) => !memberIds.has(memberId))) {
    throw new Error('The encrypted backup contains records for an unknown member.')
  }
  if (
    JSON.stringify([...memberIds].sort()) !== JSON.stringify([...manifest.memberIds].sort()) ||
    !sameManifestRecords(
      manifest.documents,
      await Promise.all(documents.map(documentManifestRecord)),
    ) ||
    !sameManifestRecords(
      manifest.conversations,
      await Promise.all(conversations.map(conversationManifestRecord)),
    )
  ) {
    throw new Error('The backup records do not match the authenticated manifest.')
  }
  try {
    for (const { id, memberId, metadata, data } of documents) {
      const decodedMetadata = await decryptJson<unknown>(
        backupKey,
        metadata,
        recordContext('document-metadata', id, memberId),
      )
      if (!isDocumentMetadata(decodedMetadata)) throw new Error('Invalid document metadata.')
      const decodedData = await decryptBytes(
        backupKey,
        data,
        recordContext('document-data', id, memberId),
      )
      if (
        decodedData.byteLength !== decodedMetadata.size ||
        await sha256Bytes(decodedData) !== decodedMetadata.sha256
      ) {
        throw new Error('Document integrity check failed.')
      }
    }
    for (const { id, memberId, payload } of conversations) {
      const decodedMessage = await decryptJson<unknown>(
        backupKey,
        payload,
        recordContext('conversation', id, memberId),
      )
      if (!isConversationPayload(decodedMessage)) throw new Error('Invalid conversation data.')
    }
  } catch {
    throw new Error('The encrypted backup is damaged or has been modified.')
  }

  await serializeMutation(async () => {
    const database = await openDatabase()
    const transaction = database.transaction(
      [settingsStore, documentsStore, conversationsStore],
      'readwrite',
    )
    const completed = transactionComplete(transaction)
    const settings = transaction.objectStore(settingsStore)
    settings.put(security, securityKey)
    settings.put(members, membersKey)
    settings.put(encryptedManifest, manifestKey)
    const documentStore = transaction.objectStore(documentsStore)
    documentStore.clear()
    documents.forEach((record) => documentStore.put(record))
    const conversationStore = transaction.objectStore(conversationsStore)
    conversationStore.clear()
    conversations.forEach((record) => conversationStore.put(record))
    await completed
  })
  invalidateLocalVault()
  notifyOtherTabs()
}

function isDocumentMetadata(
  value: unknown,
): value is Omit<StoredDocument, 'id' | 'memberId' | 'data'> {
  if (!value || typeof value !== 'object') return false
  const metadata = value as Partial<Omit<StoredDocument, 'id' | 'memberId' | 'data'>>
  return (
    documentItems.some(({ key }) => key === metadata.kind) &&
    typeof metadata.name === 'string' &&
    metadata.name.length <= 255 &&
    typeof metadata.mediaType === 'string' &&
    typeof metadata.size === 'number' &&
    metadata.size >= 0 &&
    metadata.size <= 25 * 1024 * 1024 &&
    typeof metadata.addedAt === 'string' &&
    typeof metadata.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(metadata.sha256) &&
    !!metadata.analysis &&
    ['ready', 'unsupported', 'empty'].includes(metadata.analysis.status) &&
    Array.isArray(metadata.analysis.pages) &&
    metadata.analysis.pages.every(
      (page) =>
        Number.isSafeInteger(page.pageNumber) &&
        page.pageNumber > 0 &&
        typeof page.text === 'string',
    ) &&
    Array.isArray(metadata.analysis.facts) &&
    (metadata.analysis.fields === undefined || Array.isArray(metadata.analysis.fields)) &&
    (metadata.analysis.kind === undefined ||
      metadata.analysis.kind === null ||
      documentItems.some(({ key }) => key === metadata.analysis?.kind))
  )
}

function isConversationPayload(
  value: unknown,
): value is Omit<ConversationMessage, 'id' | 'memberId'> {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<Omit<ConversationMessage, 'id' | 'memberId'>>
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.length <= 50_000 &&
    typeof message.createdAt === 'string' &&
    (message.mode === 'local' || message.mode === 'remote')
  )
}