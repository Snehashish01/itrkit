import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const filePath = process.argv[2]
const outPath = process.argv[3]

if (!filePath) {
  throw new Error('Usage: node scripts/inspect-layout.mjs <pdf-path> [out-path]')
}

const data = new Uint8Array(await readFile(filePath))
const pdf = await getDocument({ data }).promise
const lines = []

for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  const viewport = page.getViewport({ scale: 1 })

  // Group text items into rows by y, then sort by x within a row.
  const rows = new Map()
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const x = Math.round(item.transform[4])
    const y = Math.round(viewport.height - item.transform[5])
    const yBand = Math.round(y / 4) * 4
    if (!rows.has(yBand)) rows.set(yBand, [])
    rows.get(yBand).push({ x, str: item.str })
  }

  lines.push(`\n===== PAGE ${pageNumber}/${pdf.numPages} (h=${Math.round(viewport.height)}) =====`)
  const sortedRows = [...rows.entries()].sort((a, b) => a[0] - b[0])
  for (const [y, items] of sortedRows) {
    items.sort((a, b) => a.x - b.x)
    const cells = items.map((it) => `[x=${it.x}] ${it.str}`).join('  |  ')
    lines.push(`y=${y}  ${cells}`)
  }
}

const output = lines.join('\n')
if (outPath) {
  await writeFile(outPath, output, 'utf8')
  console.log(`Wrote ${output.length} chars to ${outPath}`)
} else {
  console.log(output)
}
