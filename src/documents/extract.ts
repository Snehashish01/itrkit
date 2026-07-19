import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { DocumentKey } from '../domain/filing'
import { buildRows, rowsToText } from './layout'
import type { ExtractedPage as LayoutPage } from './layout'
import { classifyDocument, parseReport } from './reports'
import type { ParsedField } from './reports'

const maximumPdfPages = 250
const maximumExtractedCharacters = 2_000_000
const maximumPageCharacters = 100_000
const maximumExtractionMilliseconds = 30_000

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw new Error('PDF extraction exceeded 30 seconds.')
  let timeout = 0
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error('PDF extraction exceeded 30 seconds.')),
          remaining,
        )
      }),
    ])
  } finally {
    window.clearTimeout(timeout)
  }
}

export type ExtractedPage = {
  pageNumber: number
  text: string
}

export type FactCandidate = {
  key: 'grossSalary' | 'standardDeduction' | 'totalIncome' | 'tds'
  label: string
  value: number
  pageNumber: number
  sourceQuote: string
}

export type DocumentAnalysis = {
  status: 'ready' | 'unsupported' | 'empty'
  kind: DocumentKey | null
  pages: ExtractedPage[]
  fields: ParsedField[]
  facts: FactCandidate[]
}

const factPatterns: Array<{
  key: FactCandidate['key']
  label: string
  pattern: RegExp
}> = [
  { key: 'grossSalary', label: 'Gross salary', pattern: /gross\s+(?:total\s+)?salary/i },
  { key: 'standardDeduction', label: 'Standard deduction', pattern: /standard\s+deduction/i },
  { key: 'totalIncome', label: 'Total income', pattern: /(?:total|taxable)\s+income/i },
  { key: 'tds', label: 'Tax deducted at source', pattern: /(?:tax\s+deducted\s+at\s+source|total\s+tds)/i },
]

function redactSensitiveText(value: string) {
  return value
    .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi, '[PAN REDACTED]')
    .replace(/\b[A-Z]{4}[0-9]{5}[A-Z]\b/gi, '[TAN REDACTED]')
    .replace(/\b[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}\b/g, '[AADHAAR REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]')
}

function parseAmount(textAfterLabel: string): number | null {
  if (/\b(?:u\/s|section|sr\.?\s*no|start\s+date|end\s+date)\b/i.test(textAfterLabel)) {
    return null
  }
  const matches = [...textAfterLabel.matchAll(/(?:₹|rs\.?\s*)?([0-9][0-9,]*(?:\.\d{1,2})?)/gi)]
  const monetaryMatch = matches.find((match) => {
    const raw = match[0]
    const digits = match[1]?.replace(/\D/g, '') ?? ''
    return /₹|rs\.?|,/i.test(raw) || digits.length >= 3
  })
  const value = monetaryMatch?.[1]
  if (!value) return null
  const amount = Number(value.replaceAll(',', ''))
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

function findFacts(pages: ExtractedPage[]): FactCandidate[] {
  const facts = new Map<FactCandidate['key'], FactCandidate>()
  for (const page of pages) {
    for (const rawLine of page.text.split('\n')) {
      const line = rawLine.trim().replace(/\s+/g, ' ')
      if (!line) continue
      for (const candidate of factPatterns) {
        if (facts.has(candidate.key) || !candidate.pattern.test(line)) continue
        const match = candidate.pattern.exec(line)
        if (!match) continue
        const value = parseAmount(line.slice(match.index + match[0].length))
        if (value === null) continue
        facts.set(candidate.key, {
          key: candidate.key,
          label: candidate.label,
          value,
          pageNumber: page.pageNumber,
          sourceQuote: redactSensitiveText(line.slice(0, 240)),
        })
      }
    }
  }
  return [...facts.values()]
}

async function extractPdf(file: File): Promise<LayoutPage[]> {
  const { GlobalWorkerOptions, getDocument } = await import('pdfjs-dist')
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const deadline = performance.now() + maximumExtractionMilliseconds
  try {
    const pdf = await beforeDeadline(loadingTask.promise, deadline)
    if (pdf.numPages > maximumPdfPages) {
      throw new Error(`PDFs may contain at most ${maximumPdfPages} pages.`)
    }
    const pages: LayoutPage[] = []
    let totalCharacters = 0
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (performance.now() > deadline) throw new Error('PDF extraction exceeded 30 seconds.')
      const page = await beforeDeadline(pdf.getPage(pageNumber), deadline)
      const viewport = page.getViewport({ scale: 1 })
      const content = await beforeDeadline(page.getTextContent(), deadline)
      const items: Array<{ x: number; y: number; str: string }> = []
      let pageCharacters = 0
      for (const item of content.items) {
        if (performance.now() > deadline) throw new Error('PDF extraction exceeded 30 seconds.')
        if (!('str' in item)) continue
        pageCharacters += item.str.length
        if (pageCharacters > maximumPageCharacters) {
          throw new Error('A PDF page contains too much extractable text.')
        }
        if (!item.str.trim()) continue
        items.push({
          x: item.transform[4],
          y: viewport.height - item.transform[5],
          str: item.str,
        })
      }
      const rows = buildRows(items)
      const text = rowsToText(rows)
      totalCharacters += text.length
      if (totalCharacters > maximumExtractedCharacters) {
        throw new Error('The document contains too much extractable text.')
      }
      pages.push({ pageNumber, text, rows })
    }
    return pages
  } finally {
    await loadingTask.destroy()
  }
}

export async function analyzeDocument(file: File): Promise<DocumentAnalysis> {
  const lowerName = file.name.toLowerCase()
  let pages: LayoutPage[]

  if (lowerName.endsWith('.pdf')) {
    pages = await extractPdf(file)
  } else if (lowerName.endsWith('.json') || lowerName.endsWith('.csv')) {
    if (file.size > maximumExtractedCharacters) {
      throw new Error('Text documents must be 2 MB or smaller for local extraction.')
    }
    pages = [{ pageNumber: 1, text: await file.text(), rows: [] }]
  } else {
    return { status: 'unsupported', kind: null, pages: [], fields: [], facts: [] }
  }

  const hasText = pages.some(({ text }) => text.trim())
  const storedPages: ExtractedPage[] = pages.map(({ pageNumber, text }) => ({ pageNumber, text }))
  // Classify on the first page that yields a signature. Some statements (e.g. a
  // CPC intimation) open with a non-English cover page, so page 1 alone is not
  // enough; scanning in order keeps AIS/TIS/26AS matching their own page-1 title.
  let kind: DocumentKey | null = null
  if (hasText) {
    for (const page of pages) {
      kind = classifyDocument(page.text)
      if (kind) break
    }
  }
  const fields = kind ? parseReport(kind, pages) : []
  return {
    status: hasText ? 'ready' : 'empty',
    kind,
    pages: storedPages,
    fields,
    facts: hasText ? findFacts(storedPages) : [],
  }
}