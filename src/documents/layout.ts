// Position-aware PDF layout extraction.
// Unlike naive flattening, this keeps each text run's x coordinate so that
// table columns (label vs amount) can be recovered from AIS / TIS / 26AS.

export type LayoutCell = {
  x: number
  text: string
}

export type LayoutRow = {
  y: number
  cells: LayoutCell[]
}

export type ExtractedPage = {
  pageNumber: number
  text: string
  rows: LayoutRow[]
}

/**
 * Group raw PDF.js text items (already converted to {x, y, str}) into rows by a
 * y-band, then sort each row's cells left-to-right. Adjacent runs with a tiny x
 * gap are merged so multi-run words stay intact.
 */
export function buildRows(
  items: Array<{ x: number; y: number; str: string }>,
  bandHeight = 4,
): LayoutRow[] {
  const bands = new Map<number, LayoutCell[]>()
  for (const item of items) {
    const text = item.str
    if (!text.trim()) continue
    const band = Math.round(item.y / bandHeight) * bandHeight
    if (!bands.has(band)) bands.set(band, [])
    bands.get(band)!.push({ x: Math.round(item.x), text })
  }

  const rows: LayoutRow[] = []
  for (const [y, cells] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
    cells.sort((a, b) => a.x - b.x)
    const merged: LayoutCell[] = []
    for (const cell of cells) {
      const previous = merged[merged.length - 1]
      // Merge runs that are visually contiguous (small horizontal gap).
      if (previous && cell.x - (previous.x + estimateWidth(previous.text)) < 6) {
        previous.text = `${previous.text}${cell.text}`
      } else {
        merged.push({ ...cell })
      }
    }
    rows.push({ y, cells: merged })
  }
  return rows
}

// Rough width estimate in PDF units for gap-based merging (~5px per char).
function estimateWidth(text: string) {
  return text.length * 5
}

/** Flatten rows back to newline-joined text for classification and context. */
export function rowsToText(rows: LayoutRow[]): string {
  return rows
    .map((row) => row.cells.map((cell) => cell.text).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

const amountPattern = /^-?(?:₹|rs\.?\s*)?[0-9][0-9,]*(?:\.\d{1,2})?$/i

/** True if a cell looks like a monetary amount (Indian grouping or plain decimals). */
export function isAmountCell(text: string): boolean {
  const trimmed = text.trim()
  if (!amountPattern.test(trimmed)) return false
  const digits = trimmed.replace(/\D/g, '')
  // Require either a thousands separator, a decimal, or 3+ digits to avoid Sr. No.
  return /[,.]/.test(trimmed) || digits.length >= 3
}

/** Parse an amount cell to a number. Handles "18,06,808", "1806808.00", "₹2,000". */
export function parseAmountCell(text: string): number | null {
  const cleaned = text.replace(/[₹,\s]/g, '').replace(/rs\.?/i, '')
  if (cleaned === '' || cleaned === '-') return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

/** Rightmost numeric amount in a row (the "value" column in these statements). */
export function rightmostAmount(row: LayoutRow): number | null {
  for (let index = row.cells.length - 1; index >= 0; index -= 1) {
    if (isAmountCell(row.cells[index].text)) {
      return parseAmountCell(row.cells[index].text)
    }
  }
  return null
}

/** All numeric amounts in a row, left-to-right. */
export function rowAmounts(row: LayoutRow): number[] {
  return row.cells
    .filter((cell) => isAmountCell(cell.text))
    .map((cell) => parseAmountCell(cell.text))
    .filter((value): value is number => value !== null)
}

/**
 * Rightmost numeric cell WITHOUT the 3-digit guard. Use only where the value
 * column is known to be the rightmost cell (e.g. AIS "AMOUNT" column), so small
 * amounts like sub-₹100 interest are not dropped.
 */
export function rightmostNumber(row: LayoutRow): number | null {
  for (let index = row.cells.length - 1; index >= 0; index -= 1) {
    if (amountPattern.test(row.cells[index].text.trim())) {
      return parseAmountCell(row.cells[index].text)
    }
  }
  return null
}

/** Concatenated non-amount label text of a row, lowercased. */
export function rowLabel(row: LayoutRow): string {
  return row.cells
    .filter((cell) => !isAmountCell(cell.text))
    .map((cell) => cell.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
