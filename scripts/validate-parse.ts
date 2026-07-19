// Dev-only: run the REAL document parser against a PDF and print parsed fields.
// Usage: node --experimental-strip-types scripts/validate-parse.ts <pdf-path>
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { buildRows, rowsToText } from '../src/documents/layout.ts'
import type { ExtractedPage } from '../src/documents/layout.ts'
import { classifyDocument, parseReport } from '../src/documents/reports.ts'

const filePath = process.argv[2]
if (!filePath) throw new Error('usage: node scripts/validate-parse.ts <pdf-path>')

const data = new Uint8Array(await readFile(filePath))
const pdf = await getDocument({ data }).promise
const pages: ExtractedPage[] = []
for (let n = 1; n <= pdf.numPages; n += 1) {
  const page = await pdf.getPage(n)
  const content = await page.getTextContent()
  const viewport = page.getViewport({ scale: 1 })
  const items: Array<{ x: number; y: number; str: string }> = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    items.push({ x: item.transform[4], y: viewport.height - item.transform[5], str: item.str })
  }
  const rows = buildRows(items)
  pages.push({ pageNumber: n, text: rowsToText(rows), rows })
}

let kind: ReturnType<typeof classifyDocument> = null
for (const p of pages) {
  const k = classifyDocument(p.text)
  if (k) {
    kind = k
    break
  }
}
const fields = kind ? parseReport(kind, pages) : []
console.log('kind:', kind)
for (const f of fields) {
  console.log(String(f.key).padEnd(22), String(f.value).padStart(12), `p${f.page}`, `conf ${f.confidence}`)
}
