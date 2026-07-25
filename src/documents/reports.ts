// Content-based document classification and structured field extraction for
// Indian income-tax statements (AIS, TIS, Form 26AS, Form 16, prior ITR). Built
// from the real column layouts of these machine-generated PDFs.

import type { DocumentKey } from '../domain/filing'
import type { ExtractedPage } from './layout'
import { rightmostAmount, rightmostNumber, rowAmounts, rowLabel } from './layout'

export type FieldKey =
  | 'grossSalary'
  | 'salaryPaidCredited'
  | 'exemptAllowances'
  | 'standardDeduction'
  | 'professionalTax'
  | 'housePropertyIncome'
  | 'grossTotalIncome'
  | 'totalIncome'
  | 'interestSavings'
  | 'interestDeposit'
  | 'dividend'
  | 'rentReceived'
  | 'deduction80C'
  | 'deduction80CCD2'
  | 'totalTdsSalary'
  | 'totalTcs'
  | 'selfAssessmentTax'
  | 'totalTaxPaid'
  | 'bfSpecifiedBusinessLoss'
  | 'bfSpeculativeBusinessLoss'
  | 'bfLtcgLoss'
  | 'bfHpLoss'

export type ParsedField = {
  key: FieldKey
  label: string
  value: number
  page: number
  confidence: number
}

export const fieldLabels: Record<FieldKey, string> = {
  grossSalary: 'Gross salary',
  salaryPaidCredited: 'Salary paid / credited (u/s 192)',
  exemptAllowances: 'Exempt allowances u/s 10',
  standardDeduction: 'Standard deduction',
  professionalTax: 'Professional tax u/s 16(iii)',
  housePropertyIncome: 'House property income / loss',
  grossTotalIncome: 'Gross total income',
  totalIncome: 'Total income',
  interestSavings: 'Interest — savings bank',
  interestDeposit: 'Interest — deposits',
  dividend: 'Dividend',
  rentReceived: 'Rent received (AIS/TIS)',
  deduction80C: 'Deduction u/s 80C',
  deduction80CCD2: 'Employer NPS u/s 80CCD(2)',
  totalTdsSalary: 'TDS on salary',
  totalTcs: 'TCS collected',
  selfAssessmentTax: 'Self-assessment tax paid',
  totalTaxPaid: 'Total taxes paid',
  bfSpecifiedBusinessLoss: 'Brought-forward F&O / specified-business loss',
  bfSpeculativeBusinessLoss: 'Brought-forward speculative-business loss',
  bfLtcgLoss: 'Brought-forward LTCG loss',
  bfHpLoss: 'Brought-forward house-property loss',
}

const tanPattern = /^[A-Z]{4}[0-9]{5}[A-Z]$/
const infoCodePattern = /^(TDS|TCS|SFT|INF)-/i
const statusPattern = /^(Active|Final|Pending|Unmatch|Matched|Provisional)$/i
const financialYearPattern = /^\d{4}-\d{2}$/

/** Detect the document type from first-page text signatures. Null = unknown. */
export function classifyDocument(text: string): DocumentKey | null {
  const value = text.toLowerCase()
  if (/taxpayer information summary/.test(value)) return 'tis'
  if (/annual information statement/.test(value)) return 'ais'
  if (/annual tax statement/.test(value) || /form\s*(no\.?)?\s*26as/.test(value)) return 'form26as'
  if (/form\s*no\.?\s*16\b/.test(value) || /certificate under section 203/.test(value)) return 'form16'
  if (/interest from savings bank/.test(value) && /interest from deposit/.test(value)) return 'tis'
  if (
    /indian income tax return acknowledgement/.test(value) ||
    /\bitr-?v\b/.test(value) ||
    /computation of (total )?income/.test(value) ||
    /intimation u\/s 143/.test(value) ||
    /"schedulecfl"\s*:/i.test(value) ||
    /"itr[123]"\s*:\s*\{/.test(value)
  ) {
    return 'priorItr'
  }
  return null
}

function pushField(
  fields: Map<FieldKey, ParsedField>,
  key: FieldKey,
  value: number | null,
  page: number,
  confidence: number,
  allowNegative = false,
) {
  if (value === null) return
  if (!allowNegative && value < 0) return
  if (!fields.has(key)) fields.set(key, { key, label: fieldLabels[key], value, page, confidence })
}

function addAmount(
  fields: Map<FieldKey, ParsedField>,
  key: FieldKey,
  value: number | null,
  page: number,
  confidence: number,
) {
  if (value === null || value < 0) return
  const existing = fields.get(key)
  if (existing) {
    existing.value += value
  } else {
    fields.set(key, { key, label: fieldLabels[key], value, page, confidence })
  }
}

// TIS page-1 summary: "INFORMATION CATEGORY" -> "ACCEPTED BY TAXPAYER" (rightmost).
function parseTis(pages: ExtractedPage[]): ParsedField[] {
  const fields = new Map<FieldKey, ParsedField>()
  for (const page of pages) {
    for (const row of page.rows) {
      const label = rowLabel(row).toLowerCase()
      const amount = rightmostNumber(row)
      if (amount === null) continue
      if (/\bsalary\b/.test(label) && !/interest|tds/.test(label)) {
        pushField(fields, 'grossSalary', amount, page.pageNumber, 0.9)
      } else if (/interest from savings bank/.test(label)) {
        pushField(fields, 'interestSavings', amount, page.pageNumber, 0.9)
      } else if (/interest from deposit/.test(label)) {
        pushField(fields, 'interestDeposit', amount, page.pageNumber, 0.9)
      } else if (/dividend/.test(label)) {
        pushField(fields, 'dividend', amount, page.pageNumber, 0.9)
      } else if (/rent received|rent\/hra|rental/.test(label)) {
        pushField(fields, 'rentReceived', amount, page.pageNumber, 0.85)
      }
    }
  }
  return [...fields.values()]
}

// AIS: sectioned tables with a right-aligned AMOUNT column. The Part B1 table
// interleaves summary rows (info code + gross amount) with per-entry detail
// sub-tables (status + tax collected/deposited). We track the current info code
// so TCS detail rows can be summed without sweeping in TDS detail rows.
function parseAis(pages: ExtractedPage[]): ParsedField[] {
  const fields = new Map<FieldKey, ParsedField>()
  let currentCode: string | null = null
  for (const page of pages) {
    for (const row of page.rows) {
      const label = rowLabel(row).toLowerCase()
      const codeCell = row.cells.find((cell) => infoCodePattern.test(cell.text.trim()))
      if (codeCell) currentCode = codeCell.text.trim()
      const amount = rightmostNumber(row)
      if (amount === null) continue

      if (/gross salary u\/s 17\(1\)/.test(label) || /salary \(tds annexure ii\)/.test(label)) {
        pushField(fields, 'grossSalary', amount, page.pageNumber, 0.9)
      } else if (/salary received/.test(label) && /section 192/.test(label)) {
        pushField(fields, 'salaryPaidCredited', amount, page.pageNumber, 0.9)
      } else if (/sft-016/.test(label) && /saving/.test(label)) {
        addAmount(fields, 'interestSavings', amount, page.pageNumber, 0.85)
      } else if (/sft-016/.test(label) && /(term deposit|– term|deposit)/.test(label)) {
        addAmount(fields, 'interestDeposit', amount, page.pageNumber, 0.85)
      } else if (/dividend/.test(label)) {
        addAmount(fields, 'dividend', amount, page.pageNumber, 0.8)
      } else if (/rent received|rent\/hra|rental/.test(label)) {
        pushField(fields, 'rentReceived', amount, page.pageNumber, 0.85)
      }

      // TCS detail rows: a status cell + amounts, under a TCS- info code. The
      // rightmost amount is the TCS deposited (= the credit) for "Final"/"Active"
      // entries. The summary row above (which carries the code cell) is skipped
      // because it is handled by the gross-amount branch / has no status cell.
      if (currentCode && /^TCS-/i.test(currentCode)) {
        const hasStatus = row.cells.some((cell) => statusPattern.test(cell.text.trim()))
        const amounts = rowAmounts(row)
        if (hasStatus && amounts.length >= 2 && !codeCell) {
          addAmount(fields, 'totalTcs', rightmostNumber(row), page.pageNumber, 0.85)
        }
      }
    }
  }
  return [...fields.values()]
}

// Form 26AS. PART-I holds salary TDS (deductor rows with a TAN + [amount paid,
// tax deducted, TDS deposited]); PART-VI holds TCS (collector rows with a TAN +
// [amount paid, tax collected, TCS deposited]). Each part is gated so the other
// part's rows are never swept into the wrong total.
function parse26as(pages: ExtractedPage[]): ParsedField[] {
  const fields = new Map<FieldKey, ParsedField>()
  let paidTotal = 0
  let tdsTotal = 0
  let tcsTotal = 0
  let foundTds = false
  let foundTcs = false
  let tdsSourcePage = 1
  let tcsSourcePage = 1
  let currentPart: string | null = null
  for (const page of pages) {
    for (const row of page.rows) {
      const label = rowLabel(row).toLowerCase()
      const partMatch = /\bpart[-\s]?([ivx]+)\b/.exec(label)
      if (partMatch) {
        currentPart = partMatch[1]
        continue
      }
      const hasTan = row.cells.some((cell) => tanPattern.test(cell.text.trim()))
      if (!hasTan) continue
      const amounts = rowAmounts(row)
      if (amounts.length < 3) continue
      if (currentPart === 'i') {
        paidTotal += amounts[0]
        tdsTotal += amounts[amounts.length - 1]
        if (!foundTds) {
          tdsSourcePage = page.pageNumber
          foundTds = true
        }
      } else if (currentPart === 'vi') {
        tcsTotal += amounts[amounts.length - 1]
        if (!foundTcs) {
          tcsSourcePage = page.pageNumber
          foundTcs = true
        }
      }
    }
  }
  if (foundTds) {
    pushField(fields, 'salaryPaidCredited', paidTotal, tdsSourcePage, 0.9)
    pushField(fields, 'totalTdsSalary', tdsTotal, tdsSourcePage, 0.9)
  }
  if (foundTcs) pushField(fields, 'totalTcs', tcsTotal, tcsSourcePage, 0.9)
  return [...fields.values()]
}

// ITR computation / CPC intimation u/s 143(1). Two value columns ("As provided
// by taxpayer" and "As computed u/s 143(1)"); we take the rightmost (as-computed)
// figure. Several summary labels sit one row *below* their amounts, so fall back
// to the previous row when the label row itself has none. Only computation-
// specific totals are emitted (not salary/interest) to avoid cross-year
// reconciliation false alarms when a prior-year return sits beside current AIS.
//
// For a prior-year ITR filed as JSON (the e-filing portal export), the page
// text is the raw JSON: we parse ScheduleCFL.TotalLossCFSummary.LossSummaryDetail
// to recover the carry-forward losses that roll into the next assessment year.
function parseComputation(pages: ExtractedPage[]): ParsedField[] {
  const fields = new Map<FieldKey, ParsedField>()
  for (const page of pages) {
    // JSON CFL extraction (prior-year ITR export).
    const cfl = extractCflFromJson(page.text)
    if (cfl) {
      pushField(fields, 'bfSpecifiedBusinessLoss', cfl.busLossOthThanSpec, page.pageNumber, 0.9)
      pushField(fields, 'bfSpeculativeBusinessLoss', cfl.specBusLoss, page.pageNumber, 0.9)
      pushField(fields, 'bfLtcgLoss', cfl.ltcgLoss, page.pageNumber, 0.9)
      pushField(fields, 'bfHpLoss', cfl.hpLoss, page.pageNumber, 0.9)
    }

    for (let index = 0; index < page.rows.length; index += 1) {
      const label = rowLabel(page.rows[index]).toLowerCase()
      if (!label) continue
      const amount =
        rightmostAmount(page.rows[index]) ??
        (index > 0 ? rightmostAmount(page.rows[index - 1]) : null)
      if (amount === null) continue

      if (
        /total income after deductions/.test(label) ||
        (/\btotal income\b/.test(label) && !/gross total income/.test(label))
      ) {
        pushField(fields, 'totalIncome', amount, page.pageNumber, 0.9)
      } else if (/standard deduction/.test(label)) {
        pushField(fields, 'standardDeduction', amount, page.pageNumber, 0.9)
      } else if (/total taxes paid/.test(label)) {
        pushField(fields, 'totalTaxPaid', amount, page.pageNumber, 0.9)
      }
    }
  }
  return [...fields.values()]
}

type CflSummary = {
  busLossOthThanSpec: number
  specBusLoss: number
  ltcgLoss: number
  hpLoss: number
}

// Best-effort extraction of the carry-forward summary from a prior-year ITR
// JSON. Returns null if the text is not JSON or lacks the CFL summary. The
// "BusLossOthThanSpecLossCF" bucket is F&O (reclassified as "specified business"
// u/s 43(5) from AY 2026-27 by Finance Act 2025); the legacy label is retained
// by the portal, so we map it onto the specified-business-loss field.
function extractCflFromJson(text: string): CflSummary | null {
  if (!text || text.length < 2 || text[0] !== '{') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  // The portal export nests the schedules variously (root.ITR.ITR3, root.ITR1Form,
  // …). A bounded recursive search for the first ScheduleCFL object is robust
  // across these shapes without hard-coding the wrapper key.
  const scheduleCfl = findKey(parsed, 'ScheduleCFL', 4) as Record<string, unknown> | undefined
  if (!scheduleCfl) return null
  const summary = scheduleCfl.TotalLossCFSummary as Record<string, unknown> | undefined
  if (!summary) return null
  const detail = summary.LossSummaryDetail as Record<string, unknown> | undefined
  if (!detail) return null
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    busLossOthThanSpec: num(detail.BusLossOthThanSpecLossCF),
    specBusLoss: num(detail.LossFrmSpecBusCF),
    ltcgLoss: num(detail.TotalLTCGPTILossCF),
    hpLoss: num(detail.TotalHPPTILossCF),
  }
}

// Breadth-first search for the first object holding `targetKey`, bounded so a
// pathological structure cannot recurse forever.
function findKey(node: unknown, targetKey: string, maxDepth: number): unknown {
  if (maxDepth < 0 || !node || typeof node !== 'object') return undefined
  const queue: Array<{ value: Record<string, unknown>; depth: number }> = [
    { value: node as Record<string, unknown>, depth: 0 },
  ]
  while (queue.length > 0) {
    const { value, depth } = queue.shift()!
    if (depth > maxDepth) continue
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, targetKey)) {
      return value[targetKey]
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push({ value: child as Record<string, unknown>, depth: depth + 1 })
    }
  }
  return undefined
}

// Warnings surfaced to the user (deterministic, no sensitive identifiers).
//   • AIS Part B3 tax payments whose Financial Year is not the current FY belong
//     to a prior assessment year and must NOT be claimed this year.
//   • Form 26AS Part I entries with an overbooked/unmatched booking status flag
//     a deductor-side issue; the aggregate TDS may still be claimed.
export function parseWarnings(kind: DocumentKey, pages: ExtractedPage[]): string[] {
  const warnings: string[] = []
  if (kind === 'ais') {
    let inPartB3 = false
    for (const page of pages) {
      for (const row of page.rows) {
        const label = rowLabel(row).toLowerCase()
        if (/part b3/.test(label)) {
          inPartB3 = true
          continue
        }
        if (inPartB3 && /^part b\d|^part a\d|no transactions present/.test(label)) {
          if (/no transactions present/.test(label)) inPartB3 = false
          if (/^part /.test(label)) inPartB3 = false
          continue
        }
        if (!inPartB3) continue
        const fyCell = row.cells.find((cell) => financialYearPattern.test(cell.text.trim()))
        if (!fyCell) continue
        const fy = fyCell.text.trim()
        if (fy === '2025-26') continue // current-year payment is legitimately claimable
        const minorHead =
          row.cells.find((cell) => /^(self|advance)$/i.test(cell.text.trim()))?.text.trim() ?? 'tax'
        const taxAmount = rowAmounts(row)[0]
        const amountText = typeof taxAmount === 'number' ? ` (₹${taxAmount.toLocaleString('en-IN')})` : ''
        warnings.push(
          `AIS Part B3 contains a ${minorHead.toLowerCase()} tax payment for FY ${fy}${amountText} — this belongs to a prior assessment year and must not be claimed for AY 2026-27.`,
        )
      }
    }
  } else if (kind === 'form26as') {
    let inPartI = false
    let inPartIDetail = false
    for (const page of pages) {
      for (const row of page.rows) {
        const label = rowLabel(row).toLowerCase()
        const partMatch = /\bpart[-\s]?([ivx]+)\b/.exec(label)
        if (partMatch) {
          inPartI = partMatch[1] === 'i'
          inPartIDetail = false
          continue
        }
        if (!inPartI) continue
        if (/status of booking/.test(label)) {
          inPartIDetail = true
          continue
        }
        if (!inPartIDetail) continue
        const statusCell = row.cells.find((cell) => /^[FOUP]$/.test(cell.text.trim()))
        if (!statusCell) continue
        const status = statusCell.text.trim()
        if (status === 'O' || status === 'U') {
          warnings.push(
            `Form 26AS Part I has a TDS entry with booking status “${status}”. The deductor must correct this with OLTAS; you may still claim the aggregate TDS, but expect a possible mismatch in the utility.`,
          )
        }
      }
    }
  }
  return warnings
}

// Form 16 (TRACES). Part A carries a "Total (Rs.)" row with
// [amount paid/credited, tax deducted, tax deposited]. Part B (Annexure) is a
// full salary computation: gross salary 1(d), exemptions u/s 10, deductions u/s
// 16 (standard deduction + professional tax), house-property income/loss,
// gross total income, Chapter VI-A deductions, and total taxable income.
// Labels frequently wrap across rows with the value on the row just below, so
// each amount is looked up on the same row first, then the adjacent rows.
function parseForm16(pages: ExtractedPage[]): ParsedField[] {
  const fields = new Map<FieldKey, ParsedField>()
  let inGrossSalary = false
  for (const page of pages) {
    for (let index = 0; index < page.rows.length; index += 1) {
      const row = page.rows[index]
      const label = rowLabel(row).toLowerCase()
      if (!label) continue
      const amounts = rowAmounts(row)
      // Amount on this row, else the row just below (wrapped label), else above.
      const nearAmount =
        rightmostAmount(row) ??
        (index + 1 < page.rows.length ? rightmostAmount(page.rows[index + 1]) : null) ??
        (index > 0 ? rightmostAmount(page.rows[index - 1]) : null)

      // Part A summary row: amount paid/credited and tax deducted.
      if (/^total \(rs/.test(label) && amounts.length >= 3) {
        pushField(fields, 'salaryPaidCredited', amounts[0], page.pageNumber, 0.9)
        pushField(fields, 'totalTdsSalary', amounts[amounts.length - 1], page.pageNumber, 0.9)
        continue
      }

      // Part B section 1: capture the "(d) Total" of gross salary 1(a)+1(b)+1(c).
      if (/gross salary/.test(label) && !/gross total income/.test(label)) inGrossSalary = true
      if (inGrossSalary && /\btotal\b/.test(label) && rightmostAmount(row) !== null) {
        pushField(fields, 'grossSalary', rightmostAmount(row), page.pageNumber, 0.85)
        inGrossSalary = false
        continue
      }

      if (/total amount of exemption claimed under section 10/.test(label)) {
        pushField(fields, 'exemptAllowances', nearAmount, page.pageNumber, 0.9)
      } else if (/standard deduction under section 16/.test(label)) {
        pushField(fields, 'standardDeduction', nearAmount, page.pageNumber, 0.9)
      } else if (/tax on employment under section 16/.test(label)) {
        pushField(fields, 'professionalTax', nearAmount, page.pageNumber, 0.9)
      } else if (/from house property/.test(label)) {
        pushField(fields, 'housePropertyIncome', nearAmount, page.pageNumber, 0.85, true)
      } else if (/gross total income/.test(label)) {
        pushField(fields, 'grossTotalIncome', nearAmount, page.pageNumber, 0.9)
      } else if (/total deduction under section 80c/.test(label)) {
        pushField(fields, 'deduction80C', rightmostAmount(row), page.pageNumber, 0.9)
      } else if (/scheme under section 80ccd \(2\)/.test(label)) {
        pushField(fields, 'deduction80CCD2', rightmostAmount(row), page.pageNumber, 0.85)
      } else if (/total taxable income/.test(label)) {
        pushField(fields, 'totalIncome', nearAmount, page.pageNumber, 0.9)
      }
    }
  }
  return [...fields.values()]
}

/** Parse structured fields for a known document kind. Unknown kinds → []. */
export function parseReport(kind: DocumentKey, pages: ExtractedPage[]): ParsedField[] {
  switch (kind) {
    case 'tis':
      return parseTis(pages)
    case 'ais':
      return parseAis(pages)
    case 'form26as':
      return parse26as(pages)
    case 'form16':
      return parseForm16(pages)
    case 'priorItr':
      return parseComputation(pages)
    default:
      return []
  }
}