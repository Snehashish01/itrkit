import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import {
  Database,
  FileCheck2,
  FileLock2,
  HardDrive,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react'
import { documentItems } from '../domain/filing'
import type { DocumentKey } from '../domain/filing'
import { analyzeDocument } from '../documents/extract'
import { reconcile, shortDocKind } from '../documents/reconcile'
import {
  deleteDocument,
  getStorageStatus,
  listDocuments,
  requestPersistentStorage,
  storeDocument,
} from '../storage/vault'
import type { StorageStatus, StoredDocument } from '../storage/vault'

const maximumFileSize = 25 * 1024 * 1024
const acceptedExtensions = ['.pdf', '.json', '.csv', '.xlsx', '.xls', '.jpg', '.jpeg', '.png']

// Defense-in-depth: browsers report a declared MIME type in `file.type`. Some
// omit it for plain text formats (csv/json/xls), so an empty type is accepted,
// but a clearly-wrong declared type is rejected even when the extension looks
// fine — a renamed `malware.exe` saved as `x.pdf` should not slip through.
const acceptedMimeByExtension: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.json': ['application/json', 'text/plain', ''],
  '.csv': ['text/csv', 'text/plain', 'application/vnd.ms-excel', ''],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xls': ['application/vnd.ms-excel', ''],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
}

type DocumentVaultPanelProps = {
  memberId: string
  onDocumentStored: (kind: DocumentKey) => void
  onLastDocumentRemoved: (kind: DocumentKey) => void
}

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B'
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function inferDocumentKind(fileName: string): DocumentKey {
  const normalized = fileName.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized.includes('26as')) return 'form26as'
  if (normalized.includes('form16') || normalized.includes('formxvi')) return 'form16'
  if (normalized.includes('ais')) return 'ais'
  if (normalized.includes('tis')) return 'tis'
  if (normalized.includes('broker') || normalized.includes('pnl')) return 'brokerReport'
  if (normalized.includes('mutual') || normalized.includes('cam')) return 'mutualFundReport'
  if (normalized.includes('interest')) return 'bankInterest'
  return 'priorItr'
}

function extensionIsAllowed(file: File) {
  const lowerName = file.name.toLowerCase()
  const extension = acceptedExtensions.find((value) => lowerName.endsWith(value))
  if (!extension) return false
  const allowedMime = acceptedMimeByExtension[extension] ?? []
  return allowedMime.includes(file.type)
}

export function DocumentVaultPanel({
  memberId,
  onDocumentStored,
  onLastDocumentRemoved,
}: DocumentVaultPanelProps) {
  const [documents, setDocuments] = useState<StoredDocument[]>([])
  const [storage, setStorage] = useState<StorageStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = async () => {
    const [savedDocuments, storageStatus] = await Promise.all([
      listDocuments(memberId),
      getStorageStatus(),
    ])
    setDocuments(savedDocuments)
    setStorage(storageStatus)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([listDocuments(memberId), getStorageStatus()])
      .then(([savedDocuments, storageStatus]) => {
        if (cancelled) return
        setDocuments(savedDocuments)
        setStorage(storageStatus)
      })
      .catch(() => {
        if (!cancelled) setMessage('The document vault could not be opened.')
      })
    return () => {
      cancelled = true
    }
  }, [memberId])

  const importDocuments = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return

    setBusy(true)
    setMessage('')
    try {
      for (const file of files) {
        if (!extensionIsAllowed(file)) {
          throw new Error(`${file.name}: unsupported file type.`)
        }
        if (file.size > maximumFileSize) {
          throw new Error(`${file.name}: file is larger than 25 MB.`)
        }
        const analysis = await analyzeDocument(file)
        const kind = analysis.kind ?? inferDocumentKind(file.name)
        await storeDocument(memberId, kind, file, analysis)
        onDocumentStored(kind)
      }
      await refresh()
      setMessage(`${files.length} document${files.length === 1 ? '' : 's'} stored on this device.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The documents could not be stored.')
    } finally {
      setBusy(false)
    }
  }

  const removeDocument = async (document: StoredDocument) => {
    if (!window.confirm(`Remove ${document.name} from this browser?`)) return
    await deleteDocument(document.id)
    if (!documents.some(({ id, kind }) => id !== document.id && kind === document.kind)) {
      onLastDocumentRemoved(document.kind)
    }
    await refresh()
  }

  const makePersistent = async () => {
    const granted = await requestPersistentStorage()
    await refresh()
    setMessage(
      granted
        ? 'Persistent browser storage is enabled.'
        : 'The browser did not grant persistent storage. Keep an external backup.',
    )
  }

  const usagePercent = storage?.quota
    ? Math.min(100, Math.round((storage.usage / storage.quota) * 100))
    : 0

  const recon = useMemo(
    () =>
      reconcile(
        documents.map((document) => ({ kind: document.kind, fields: document.analysis?.fields })),
      ).filter((entry) => entry.sources.length >= 2),
    [documents],
  )

  return (
    <section className="vault-panel" aria-labelledby={`vault-${memberId}`}>
      <div className="vault-heading">
        <div>
          <span className="eyebrow">Private evidence</span>
          <h3 id={`vault-${memberId}`}>Device document vault</h3>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          <Upload size={16} /> {busy ? 'Storing...' : 'Add documents'}
        </button>
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          multiple
          accept={acceptedExtensions.join(',')}
          onChange={importDocuments}
        />
      </div>

      <div className="vault-safety">
        <FileLock2 size={18} />
        <p>
          Files stay in this browser profile. Nothing is uploaded to Vercel or an AI provider.
          Browser storage is device-specific, so retain your own encrypted backup.
        </p>
      </div>

      {documents.length === 0 ? (
        <button className="vault-dropzone" type="button" onClick={() => fileInput.current?.click()}>
          <Database size={24} />
          <strong>Store source documents locally</strong>
          <span>PDF, JSON, CSV, Excel or image · 25 MB maximum per file</span>
        </button>
      ) : (
        <div className="vault-document-list">
          {documents.map((document) => (
            <div className="vault-document" key={document.id}>
              <FileCheck2 size={19} />
              <span className="vault-document-name">
                <strong>{document.name}</strong>
                <span>
                  {documentItems.find(({ key }) => key === document.kind)?.label} · {formatBytes(document.size)} · SHA-256 {document.sha256.slice(0, 8)}…
                </span>
                <span className={`analysis-status ${document.analysis?.status ?? 'unsupported'}`}>
                  {document.analysis?.status === 'ready'
                    ? `${document.analysis.pages.length} page${document.analysis.pages.length === 1 ? '' : 's'} read locally · ${document.analysis.fields?.length || document.analysis.facts.length} value${(document.analysis.fields?.length || document.analysis.facts.length) === 1 ? '' : 's'} extracted`
                    : document.analysis?.status === 'empty'
                      ? 'No selectable text found · review manually'
                      : 'Stored only · this format needs manual review'}
                </span>
              </span>
              <button
                className="danger-icon"
                type="button"
                onClick={() => removeDocument(document)}
                aria-label={`Remove ${document.name}`}
                title="Remove document"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {documents.some((document) => document.analysis?.fields?.length) && (
        <div className="fact-candidates">
          <span className="eyebrow">Extracted values · verify before filing</span>
          {documents.flatMap((document) =>
            (document.analysis?.fields ?? []).map((field) => (
              <div className="fact-candidate" key={`${document.id}-${field.key}`}>
                <span>
                  <strong>{field.label}</strong>
                  <small>
                    {documentItems.find(({ key }) => key === document.kind)?.label} · page {field.page}
                  </small>
                </span>
                <strong>₹{field.value.toLocaleString('en-IN')}</strong>
              </div>
            )),
          )}
        </div>
      )}

      {recon.length > 0 && (
        <div className="recon-panel">
          <span className="eyebrow">Cross-document check</span>
          {recon.map((entry) => (
            <div className={`recon-row ${entry.status}`} key={entry.key}>
              <span className="recon-field">
                <strong>{entry.label}</strong>
                <small>{entry.sources.map((source) => shortDocKind(source.kind)).join(' · ')}</small>
              </span>
              {entry.status === 'match' ? (
                <strong>₹{entry.value.toLocaleString('en-IN')}</strong>
              ) : (
                <span className="recon-values">
                  {entry.sources.map((source) => (
                    <span key={`${entry.key}-${source.kind}`}>
                      {shortDocKind(source.kind)} ₹{source.value.toLocaleString('en-IN')}
                    </span>
                  ))}
                </span>
              )}
              <span className="recon-flag">{entry.status === 'match' ? 'Matches' : 'Differs'}</span>
            </div>
          ))}
        </div>
      )}

      {documents.some(
        (document) => !document.analysis?.fields?.length && document.analysis?.facts.length,
      ) && (
        <div className="fact-candidates">
          <span className="eyebrow">Evidence candidates · verify before filing</span>
          {documents
            .filter((document) => !document.analysis?.fields?.length)
            .flatMap((document) =>
              (document.analysis?.facts ?? []).map((fact) => (
                <div className="fact-candidate" key={`${document.id}-${fact.key}`}>
                  <span>
                    <strong>{fact.label}</strong>
                    <small>{document.name} · page {fact.pageNumber}</small>
                  </span>
                  <strong>₹{fact.value.toLocaleString('en-IN')}</strong>
                  <blockquote title={fact.sourceQuote}>{fact.sourceQuote}</blockquote>
                </div>
              )),
            )}
        </div>
      )}

      <div className="vault-storage">
        <HardDrive size={17} />
        <div>
          <strong>{storage ? `${formatBytes(storage.usage)} used locally` : 'Checking local storage'}</strong>
          <span>{storage?.persisted ? 'Persistent storage enabled' : 'Storage may be cleared by the browser'}</span>
          <span className="storage-meter"><i style={{ width: `${usagePercent}%` }} /></span>
        </div>
        {!storage?.persisted && (
          <button type="button" onClick={makePersistent}>
            <ShieldCheck size={15} /> Protect storage
          </button>
        )}
      </div>
      {message && <p className="vault-message" role="status">{message}</p>}
    </section>
  )
}