import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Bot, Cloud, KeyRound, Laptop, Send, Settings2, Trash2 } from 'lucide-react'
import { documentItems } from '../domain/filing'
import type { DocumentKey, Member } from '../domain/filing'
import { reconcile, shortDocKind } from '../documents/reconcile'
import {
  appendConversationMessage,
  clearConversation,
  listConversation,
  listDocuments,
} from '../storage/vault'
import type { ConversationMessage, StoredDocument } from '../storage/vault'

type AssistantPanelProps = {
  member: Member
}

type RemoteConfig = {
  endpoint: string
  model: string
  apiKey: string
}

const defaultConfig: RemoteConfig = {
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4.1-mini',
  apiKey: '',
}

type ExtractedValue = { label: string; value: number; page: number; kind: DocumentKey }

function extractedValues(documents: StoredDocument[]): ExtractedValue[] {
  return documents.flatMap((document) => {
    const fields = document.analysis?.fields ?? []
    if (fields.length) {
      return fields.map((field) => ({
        label: field.label,
        value: field.value,
        page: field.page,
        kind: document.kind,
      }))
    }
    return (document.analysis?.facts ?? []).map((fact) => ({
      label: fact.label,
      value: fact.value,
      page: fact.pageNumber,
      kind: document.kind,
    }))
  })
}

function buildLocalAnswer(member: Member, documents: StoredDocument[], question: string) {
  const normalized = question.toLowerCase()
  const values = extractedValues(documents)
  const recon = reconcile(documents.map((document) => ({ kind: document.kind, fields: document.analysis?.fields })))
  const mismatches = recon.filter((entry) => entry.status === 'mismatch')
  const matches = recon.filter((entry) => entry.status === 'match')
  const missing = documentItems
    .filter(({ key, capitalGainsOnly }) => !member.documents[key] && (!capitalGainsOnly || member.capitalGains))
    .map(({ label }) => label)
  const sections: string[] = []
  const asksForEvidence = ['income', 'salary', 'tds', 'interest', 'dividend', 'summary', 'summarize'].some((term) =>
    normalized.includes(term),
  )
  const asksForMissing = ['missing', 'need', 'next', 'review', 'reconcile', 'match', 'differ'].some((term) =>
    normalized.includes(term),
  )
  const asksForForm = normalized.includes('itr') || normalized.includes('form')

  if (asksForEvidence) {
    sections.push(
      values.length === 0
        ? 'No amounts have been extracted yet. Add a selectable-text PDF (AIS, TIS, Form 26AS, Form 16), CSV or JSON, or review image and spreadsheet files manually.'
        : `I found ${values.length} extracted value${values.length === 1 ? '' : 's'}: ${values.map((value) => `${value.label} ₹${value.value.toLocaleString('en-IN')} (${shortDocKind(value.kind)}, page ${value.page})`).join('; ')}. Verify against the original documents before filing.`,
    )
  }
  if (mismatches.length > 0) {
    sections.push(
      `Figures that differ across documents — reconcile before filing: ${mismatches
        .map((entry) => `${entry.label} (${entry.sources.map((source) => `${shortDocKind(source.kind)} ₹${source.value.toLocaleString('en-IN')}`).join(' vs ')})`)
        .join('; ')}.`,
    )
  } else if (matches.length > 0 && (asksForEvidence || asksForMissing)) {
    sections.push(
      `Cross-checked and matching across sources: ${matches
        .map((entry) => `${entry.label} (${entry.sources.map((source) => shortDocKind(source.kind)).join(' + ')})`)
        .join('; ')}.`,
    )
  }
  if (asksForMissing) {
    sections.push(
      missing.length
        ? `Still missing from the checklist: ${missing.join(', ')}. Add the source files, then reconcile duplicated or conflicting amounts before choosing a regime.`
        : 'Every applicable source item is marked ready. Reconcile AIS, Form 26AS and source statements, then compare regimes in the official AY 2026-27 utility.',
    )
  }
  if (asksForForm) {
    sections.push(
      member.capitalGains
        ? 'This profile needs an ITR-2 review because capital gains are present. Use ITR-1 only if the exact AY 2026-27 eligibility rules and the narrow listed-equity LTCG exception are satisfied in the official utility.'
        : 'ITR-1 is the current working assumption, subject to every AY 2026-27 eligibility condition. Validate the final selection in the official utility.',
    )
  }
  if (sections.length > 0) return sections.join('\n\n')
  return `For ${member.alias}, I can summarize extracted amounts, cross-check them across AIS/TIS/26AS, identify missing evidence, or explain the next filing step. I do not infer unsupported values; final figures and eligibility must be checked in the official AY 2026-27 utility.`
}

function evidencePacket(member: Member, documents: StoredDocument[]) {
  return {
    assessmentYear: '2026-27',
    profile: {
      salaryOrPension: member.salaryOrPension,
      capitalGains: member.capitalGains,
    },
    checklist: documentItems.map(({ key, label }) => ({ label, available: member.documents[key] })),
    candidates: extractedValues(documents).map((value) => ({
      documentType: value.kind,
      label: value.label,
      value: value.value,
      page: value.page,
    })),
    reconciliation: reconcile(documents.map((document) => ({ kind: document.kind, fields: document.analysis?.fields }))).map((entry) => ({
      field: entry.label,
      status: entry.status,
      values: entry.sources.map((source) => ({ source: shortDocKind(source.kind), value: source.value })),
    })),
  }
}

function endpointIsAllowed(endpoint: string) {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname)
  } catch {
    return false
  }
}

export function AssistantPanel({ member }: AssistantPanelProps) {
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [documents, setDocuments] = useState<StoredDocument[]>([])
  const [mode, setMode] = useState<'local' | 'remote'>('local')
  const [question, setQuestion] = useState('')
  const [remoteConfig, setRemoteConfig] = useState(defaultConfig)
  const [trustedEndpoint, setTrustedEndpoint] = useState(false)
  const [shareEvidence, setShareEvidence] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const transcript = useRef<HTMLDivElement>(null)
  const requestController = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([listConversation(member.id), listDocuments(member.id)])
      .then(([savedMessages, savedDocuments]) => {
        if (cancelled) return
        setMessages(savedMessages)
        setDocuments(savedDocuments)
      })
      .catch(() => {
        if (!cancelled) setError('The local assistant history could not be loaded.')
      })
    return () => {
      cancelled = true
      requestController.current?.abort()
    }
  }, [member])

  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight })
  }, [messages, busy])

  const askRemote = async (content: string) => {
    if (!endpointIsAllowed(remoteConfig.endpoint)) {
      throw new Error('Use an HTTPS endpoint, or a local endpoint on localhost.')
    }
    if (!remoteConfig.model.trim()) throw new Error('Enter the provider model name.')
    if (content.length > 4_000) throw new Error('Questions must be 4,000 characters or shorter.')
    if ((remoteConfig.apiKey || shareEvidence) && !trustedEndpoint) {
      throw new Error('Confirm that you trust this endpoint before sending a key or tax evidence.')
    }
    const context = shareEvidence
      ? `The user explicitly consented to sending this extracted evidence packet:\n${JSON.stringify(evidencePacket(member, documents))}`
      : 'No tax document evidence or prior conversation was shared. Answer only from the current question and general knowledge.'
    const controller = new AbortController()
    requestController.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 60_000)
    let result: unknown
    try {
      const response = await fetch(remoteConfig.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(remoteConfig.apiKey ? { Authorization: `Bearer ${remoteConfig.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: remoteConfig.model,
          temperature: 0.1,
          messages: [
            {
              role: 'system',
              content: `You are an Indian income-tax preparation assistant for AY 2026-27. Distinguish extracted evidence from assumptions, cite document type and page when supplied, never request PAN, Aadhaar, credentials or OTPs, and require official-utility validation. ${context}`,
            },
            { role: 'user', content },
          ],
        }),
      })
      if (!response.ok) throw new Error(`Provider request failed (${response.status}).`)
      const maximumResponseBytes = 50_000
      const contentLength = Number(response.headers.get('Content-Length') ?? 0)
      if (contentLength > maximumResponseBytes) throw new Error('The provider response is too large.')
      if (!response.body) throw new Error('The provider returned an empty response.')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let responseBytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        responseBytes += value.byteLength
        if (responseBytes > maximumResponseBytes) {
          await reader.cancel()
          throw new Error('The provider response is too large.')
        }
        chunks.push(value)
      }
      const responseText = new TextDecoder().decode(
        chunks.length === 1
          ? chunks[0]
          : Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
      )
      try {
        result = JSON.parse(responseText)
      } catch {
        throw new Error('The provider returned invalid JSON.')
      }
    } catch (requestError) {
      if (controller.signal.aborted) throw new Error('The provider request timed out or was cancelled.')
      throw requestError
    } finally {
      window.clearTimeout(timeout)
      requestController.current = null
    }
    const answer = (result as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('The provider returned no text response.')
    return answer.trim()
  }

  const submitQuestion = async (event: FormEvent) => {
    event.preventDefault()
    const content = question.trim()
    if (!content || busy) return
    setQuestion('')
    setError('')
    setBusy(true)
    try {
      const userMessage = await appendConversationMessage({
        memberId: member.id,
        role: 'user',
        content,
        mode,
      })
      setMessages((current) => [...current, userMessage])
      const answer = mode === 'local' ? buildLocalAnswer(member, documents, content) : await askRemote(content)
      const assistantMessage = await appendConversationMessage({
        memberId: member.id,
        role: 'assistant',
        content: answer,
        mode,
      })
      setMessages((current) => [...current, assistantMessage])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The assistant could not answer.')
    } finally {
      setBusy(false)
    }
  }

  const removeHistory = async () => {
    if (!window.confirm('Clear this person’s local conversation history?')) return
    await clearConversation(member.id)
    setMessages([])
  }

  const candidateCount = documents.flatMap((document) => document.analysis?.facts ?? []).length
  const endpointOrigin = (() => {
    try {
      return new URL(remoteConfig.endpoint).origin
    } catch {
      return 'the configured endpoint'
    }
  })()

  return (
    <section className="assistant-panel" aria-labelledby={`assistant-${member.id}`}>
      <div className="assistant-heading">
        <div>
          <span className="eyebrow">Guided preparation</span>
          <h3 id={`assistant-${member.id}`}>Evidence assistant</h3>
        </div>
        <div className="assistant-modes" aria-label="Assistant mode">
          <button className={mode === 'local' ? 'active' : ''} type="button" onClick={() => {
            setMode('local')
            setShareEvidence(false)
          }}>
            <Laptop size={15} /> Local
          </button>
          <button className={mode === 'remote' ? 'active' : ''} type="button" onClick={() => setMode('remote')}>
            <Cloud size={15} /> BYO API
          </button>
        </div>
        <button className="danger-icon" type="button" onClick={removeHistory} title="Clear conversation" aria-label="Clear conversation">
          <Trash2 size={16} />
        </button>
      </div>

      {mode === 'remote' && (
        <div className="remote-controls">
          <button type="button" onClick={() => setShowSettings((current) => !current)}>
            <Settings2 size={15} /> Provider settings
          </button>
          <label className="share-toggle">
            <input type="checkbox" checked={shareEvidence} onChange={(event) => setShareEvidence(event.target.checked)} />
            <span>Send {candidateCount} extracted candidate{candidateCount === 1 ? '' : 's'} with each question</span>
          </label>
          <p>Your question goes directly from this browser to the endpoint. Vercel never proxies it.</p>
          {showSettings && (
            <div className="provider-settings">
              <label>Endpoint<input value={remoteConfig.endpoint} onChange={(event) => {
                setRemoteConfig({ ...remoteConfig, endpoint: event.target.value, apiKey: '' })
                setTrustedEndpoint(false)
                setShareEvidence(false)
              }} /></label>
              <label>Model<input value={remoteConfig.model} onChange={(event) => setRemoteConfig({ ...remoteConfig, model: event.target.value })} /></label>
              <label>API key<input type="password" autoComplete="off" value={remoteConfig.apiKey} onChange={(event) => setRemoteConfig({ ...remoteConfig, apiKey: event.target.value })} /></label>
              <label className="endpoint-trust"><input type="checkbox" checked={trustedEndpoint} onChange={(event) => setTrustedEndpoint(event.target.checked)} /> I trust {endpointOrigin} to receive API keys or tax evidence</label>
              <span><KeyRound size={14} /> Credentials live in memory only and disappear on reload.</span>
            </div>
          )}
        </div>
      )}

      <div className="assistant-transcript" ref={transcript} aria-live="polite">
        {messages.length === 0 && (
          <div className="assistant-empty">
            <Bot size={22} />
            <p>Ask for an evidence summary, missing documents, likely ITR form, or the next filing step.</p>
          </div>
        )}
        {messages.map((message) => (
          <div className={`assistant-message ${message.role}`} key={message.id}>
            <span>{message.role === 'user' ? 'You' : message.mode === 'local' ? 'Local assistant' : 'Remote assistant'}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {busy && <div className="assistant-thinking">Checking the available evidence…</div>}
      </div>

      <form className="assistant-composer" onSubmit={submitQuestion}>
        <label className="visually-hidden" htmlFor={`question-${member.id}`}>Ask the evidence assistant</label>
        <textarea id={`question-${member.id}`} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about this return…" rows={2} maxLength={4000} />
        <button type="submit" disabled={!question.trim() || busy} aria-label="Send question" title="Send question"><Send size={17} /></button>
      </form>
      {error && <p className="assistant-error" role="alert">{error}</p>}
    </section>
  )
}