// Content-based document classification and structured field extraction for
// Indian income-tax statements (AIS, TIS, Form 26AS). Built from the real
// column layouts of these machine-generated PDFs.

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
  | 'deduction80C'
  | 'deduction80CCD2'
  | 'totalTdsSalary'
  | 'selfAssessmentTax'
  | 'totalTaxPaid'

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
  deduction80C: 'Deduction u/s 80C',
  deduction80CCD2: 'Employer NPS u/s 80CCD(2)',
  totalTdsSalary: 'TDS on salary',
  selfAssessmentTax: 'Self-assessment tax paid',
  totalTaxPaid: 'Total taxes paid',
}

const tanPattern = /^[A-Z]{4}[0-9]{5}[A-Z]$/

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
    /intimation u\/s 143/.test(value)
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
      }
    }
  }
  return [...fields.values()]
}

// AIS: sectioned tables with a right-aligned AMOUNT column.
function parseAis(pages: ExtractedPage[]): ParsedField[] {
  const fields = new Map<FieldKey, ParsedField>()
  for (const page of pages) {
    for (const row of page.rows) {
      const label = rowLabel(row).toLowerCase()
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
      }
    }
  }
  return [...fields.values()]
}

// Form 26AS PART-I: sum the deductor summary rows (each carries a TAN plus
// [Total Amount Paid/Credited, Total Tax Deducted, Total TDS Deposited]).
// Bounded to PART-I so PART-VI TCS collectors etc. are not swept in.
function parse26as(pages: ExtractedPage[]): ParsedField[] {
  let paidTotal = 0
  let tdsTotal = 0
  let found = false
  let sourcePage = 1
  let inPartI = false
  for (const page of pages) {
    for (const row of page.rows) {
      const label = rowLabel(row).toLowerCase()
      const partMatch = /\bpart[-\s]?([ivx]+)\b/.exec(label)
      if (partMatch) {
        inPartI = partMatch[1] === 'i'
        continue
      }
      if (!inPartI) continue
      const hasTan = row.cells.some((cell) => tanPattern.test(cell.text.trim()))
      if (!hasTan) continue
      const amounts = rowAmounts(row)
      if (amounts.length < 3) continue
      paidTotal += amounts[0]
      tdsTotal += amounts[amounts.length - 1]
      if (!found) {
        sourcePage = page.pageNumber
        found = true
      }
    }
  }
  if (!found) return []
  return [
    { key: 'salaryPaidCredited', label: fieldLabels.salaryPaidCredited, value: paidTotal, page: sourcePage, confidence: 0.9 },
    { key: 'totalTdsSalary', label: fieldLabels.totalTdsSalary, value: tdsTotal, page: sourcePage, confidence: 0.9 },
  ]
}

// ITR computation / CPC intimation u/s 143(1). Two value columns ("As provided
// by taxpayer" and "As computed u/s 143(1)"); we take the rightmost (as-computed)
// figure. Several summary labels sit one row *below* their amounts, so fall back
// to the previous row when the label row itself has none. Only computation-
// specific totals are emitted (not salary/interest) to avoid cross-year
// reconciliation false alarms when a prior-year return sits beside current AIS.
function parseComputation(pages: ExtractedPage[]): ParsedField[] {
  const fields = new Map<FieldKey, ParsedField>()
  for (const page of pages) {
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

// Form 16 (TRACES). Part A carries a "Total (Rs.)" row with
// [amount paid/credited, tax deducted, tax deposited]. Part B (Annexure) is a
// full salary computation: gross salary 1(d), exemptions u/s 10, deductions
// u/s 16 (standard deduction + professional tax), house-property income/loss,
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
