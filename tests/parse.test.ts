// Deterministic unit checks for the offline pipeline: the coordinate-aware
// Form 16 parser, tax-input seeding, and the tax engine. Runs without a browser
// or a real PDF — synthetic layout rows (the same {x,y,str} shape pdf.js yields)
// drive `parseReport` directly, so the full Part B extraction is regression-safe.
//
// All figures below are SYNTHETIC round numbers chosen to exercise the parser
// and engine paths. They are not any real taxpayer's data.
//
// Run: node --experimental-strip-types --loader ./scripts/ts-ext-loader.mjs tests/parse.test.ts
import assert from 'node:assert/strict'
import { buildRows } from '../src/documents/layout.ts'
import type { ExtractedPage } from '../src/documents/layout.ts'
import { parseReport } from '../src/documents/reports.ts'
import type { FieldKey, ParsedField } from '../src/documents/reports.ts'
import type { StoredDocument } from '../src/storage/vault.ts'
import { seedTaxInputs } from '../src/tax/seed.ts'
import { compareRegimes, emptyTaxInputs, recommendItrForm } from '../src/tax/compute.ts'

type Item = { x: number; y: number; str: string }

function makePage(pageNumber: number, items: Item[]): ExtractedPage {
  const rows = buildRows(items)
  const text = rows.map((row) => row.cells.map((cell) => cell.text).join(' ')).join('\n')
  return { pageNumber, text, rows }
}

function byKey(fields: ParsedField[]): Map<FieldKey, number> {
  return new Map(fields.map((field) => [field.key, field.value]))
}

// --- 1. Form 16 Part B parser (full computation, incl. house-property loss) ---
// Mirrors a real TRACES Form 16: some values sit on the label row, some on the
// row just below it (the layout wraps the label above its section-number row).
const form16Items: Item[] = [
  { x: 58, y: 20, str: 'Total (Rs.)' },
  { x: 400, y: 20, str: '2500000.00' },
  { x: 480, y: 20, str: '280000.00' },
  { x: 560, y: 20, str: '280000.00' },
  { x: 58, y: 60, str: '1. Gross Salary' },
  { x: 58, y: 90, str: '(a) Salary as per provisions contained in section 17(1)' },
  { x: 520, y: 90, str: '2460000.00' },
  { x: 58, y: 120, str: '(d) Total' },
  { x: 520, y: 120, str: '2500000.00' },
  { x: 58, y: 160, str: 'Total amount of exemption claimed under section 10' },
  { x: 58, y: 185, str: '(i)' },
  { x: 520, y: 185, str: '600000.00' },
  { x: 58, y: 220, str: 'Standard deduction under section 16(ia)' },
  { x: 520, y: 220, str: '50000.00' },
  { x: 58, y: 250, str: 'Tax on employment under section 16(iii)' },
  { x: 520, y: 250, str: '2400.00' },
  { x: 58, y: 290, str: 'Income (or admissible loss) from house property' },
  { x: 58, y: 315, str: '(a)' },
  { x: 520, y: 315, str: '-200000.00' },
  { x: 58, y: 350, str: 'Gross total income (6+8)' },
  { x: 520, y: 350, str: '1647600.00' },
  { x: 58, y: 390, str: 'Total deduction under section 80C, 80CCC and 80CCD(1)' },
  { x: 440, y: 390, str: '600000.00' },
  { x: 560, y: 390, str: '150000.00' },
  { x: 58, y: 430, str: 'scheme under section 80CCD (2)' },
  { x: 440, y: 430, str: '0.00' },
  { x: 560, y: 430, str: '0.00' },
  { x: 58, y: 470, str: 'Total taxable income (9-11)' },
  { x: 520, y: 470, str: '1497600.00' },
]
const form16 = byKey(parseReport('form16', [makePage(1, form16Items)]))
assert.equal(form16.get('salaryPaidCredited'), 2500000, 'Form 16 Part A salary paid/credited')
assert.equal(form16.get('totalTdsSalary'), 280000, 'Form 16 Part A TDS')
assert.equal(form16.get('grossSalary'), 2500000, 'Form 16 gross salary 1(d)')
assert.equal(form16.get('exemptAllowances'), 600000, 'Form 16 exemptions u/s 10')
assert.equal(form16.get('standardDeduction'), 50000, 'Form 16 standard deduction')
assert.equal(form16.get('professionalTax'), 2400, 'Form 16 professional tax u/s 16(iii)')
assert.equal(form16.get('housePropertyIncome'), -200000, 'Form 16 house-property loss stays negative')
assert.equal(form16.get('grossTotalIncome'), 1647600, 'Form 16 gross total income')
assert.equal(form16.get('deduction80C'), 150000, 'Form 16 80C deductible amount (rightmost column)')
assert.equal(form16.get('deduction80CCD2'), 0, 'Form 16 employer NPS 80CCD(2)')
assert.equal(form16.get('totalIncome'), 1497600, 'Form 16 total taxable income')

// --- 2. Seeding tax inputs from reconciled fields (incl. 80TTA + TCS) ---------
const field = (key: FieldKey, value: number): ParsedField => ({
  key,
  label: key,
  value,
  page: 1,
  confidence: 0.9,
})
const documents = [
  {
    kind: 'form16',
    analysis: {
      fields: [
        field('grossSalary', 2500000),
        field('exemptAllowances', 600000),
        field('professionalTax', 2400),
        field('housePropertyIncome', -200000),
        field('deduction80C', 150000),
        field('deduction80CCD2', 0),
        field('totalTdsSalary', 280000),
        field('totalTcs', 8000),
      ],
    },
  },
  {
    kind: 'ais',
    analysis: {
      fields: [
        field('grossSalary', 2500000),
        field('interestSavings', 5000),
        field('interestDeposit', 40000),
        field('dividend', 1000),
      ],
    },
  },
] as unknown as StoredDocument[]
const seeded = seedTaxInputs(documents)
assert.equal(seeded.grossSalary, 2500000, 'seed gross salary')
assert.equal(seeded.exemptAllowances, 600000, 'seed exempt allowances')
assert.equal(seeded.professionalTax, 2400, 'seed professional tax')
assert.equal(seeded.housePropertyIncome, -200000, 'seed house-property loss')
assert.equal(seeded.interestIncome, 45000, 'seed interest = savings + deposits')
assert.equal(seeded.dividends, 1000, 'seed dividends')
assert.equal(seeded.ded80C, 150000, 'seed 80C')
assert.equal(seeded.ded80CCD2Employer, 0, 'seed employer NPS')
assert.equal(seeded.ded80TTA, 5000, 'seed 80TTA from savings-bank interest only (not deposits)')
assert.equal(seeded.tdsTcs, 288000, 'seed TDS + TCS (280000 salary TDS + 8000 TCS)')

// --- 3. Tax engine: old-vs-new comparison with full deductions ----------------
const full = {
  ...emptyTaxInputs(),
  grossSalary: 2500000,
  exemptAllowances: 600000,
  professionalTax: 2400,
  housePropertyIncome: -200000,
  interestIncome: 5000,
  ded80C: 150000,
  tdsTcs: 270000,
}
const comparison = compareRegimes(full)
assert.equal(comparison.old.totalIncome, 1502600, 'old total income')
assert.equal(comparison.old.totalTaxLiability, 273811, 'old total tax liability')
assert.equal(comparison.old.balance, 3811, 'old balance payable')
assert.equal(comparison.new.totalIncome, 2430000, 'new total income (house-property loss not set off)')
assert.equal(comparison.new.totalTaxLiability, 321360, 'new total tax liability')
assert.equal(comparison.recommended, 'old', 'old regime recommended once deductions apply')
assert.equal(comparison.saving, 47549, 'regime saving')

// New-regime rebate u/s 87A zeroes tax at total income ₹12L.
const rebateCase = compareRegimes({ ...emptyTaxInputs(), grossSalary: 1275000 })
assert.equal(rebateCase.new.totalIncome, 1200000, 'new total income at the ₹12L rebate ceiling')
assert.equal(rebateCase.new.totalTaxLiability, 0, 'new 87A rebate zeroes tax at ₹12L')
assert.equal(rebateCase.recommended, 'new', 'new regime wins under the 87A rebate')

// --- 4. Carry-forward set-off (old regime) -------------------------------------
// A specified (F&O) loss + speculative + LTCG brought forward. The specified
// loss absorbs the savings interest; 80TTA is capped by the interest that
// survives (zero), so it does not double-count. Net result is a refund.
const cf = compareRegimes({
  ...emptyTaxInputs(),
  grossSalary: 2500000,
  exemptAllowances: 600000,
  professionalTax: 2400,
  housePropertyIncome: -200000,
  interestIncome: 5000,
  ded80C: 150000,
  ded80TTA: 5000,
  tdsTcs: 288000, // salary TDS 280000 + TCS 8000
  bfSpecifiedBusinessLoss: 1100000,
  bfSpeculativeBusinessLoss: 800,
  bfLtcgLoss: 4000,
})
assert.equal(cf.old.totalIncome, 1497600, 'old total income (interest absorbed, 80TTA capped to 0)')
assert.equal(cf.old.totalTaxLiability, 272251, 'old total tax liability')
assert.equal(cf.old.balance, -15749, 'old balance = refund (TDS+TCS exceeds liability)')
assert.equal(cf.old.bfLossSetoff, 5000, 'BF specified loss set off 5,000 against interest')
assert.equal(cf.old.bfLossCarriedForward, 1099800, 'BF carried forward (1095000 + 800 + 4000)')
assert.equal(cf.old.bfLossBreakdown.specified.closing, 1095000, 'specified loss closing CF')
assert.equal(cf.old.bfLossBreakdown.speculative.closing, 800, 'speculative loss untouched')
assert.equal(cf.old.bfLossBreakdown.ltcg.closing, 4000, 'LTCG loss untouched')

// --- 5. Let-out house-property schedule (new regime) -------------------------
const letOut = compareRegimes({
  ...emptyTaxInputs(),
  houseProperties: [{ type: 'letOut', grossRent: 600000, municipalTax: 25000, loanInterest: 0 }],
  interestIncome: 6000,
})
assert.equal(letOut.new.housePropertyIncome, 402500, 'let-out HP income (30% std deduction rounded)')
assert.equal(letOut.new.totalIncome, 408500, 'new total income (HP + savings interest)')
assert.equal(letOut.new.totalTaxLiability, 0, '87A rebate zeroes the small slab tax')
assert.equal(letOut.new.balance, 0, 'nil balance')

// --- 6. Surcharge with marginal relief ----------------------------------------
const surchargeCase = compareRegimes({ ...emptyTaxInputs(), grossSalary: 6000000 })
assert.equal(surchargeCase.new.surcharge, 135750, '10% surcharge on ₹59.25L total income')
assert.equal(surchargeCase.new.totalTaxLiability, 1552980, 'surcharge + cess liability')
const marginalReliefCase = compareRegimes({ ...emptyTaxInputs(), grossSalary: 5100000 })
assert.equal(marginalReliefCase.new.surcharge, 17500, 'marginal relief caps surcharge just over ₹50L')
const oldSurcharge = compareRegimes({ ...emptyTaxInputs(), grossSalary: 6000000 })
assert.equal(oldSurcharge.old.surcharge, 159750, 'old-regime 10% surcharge on ₹59.5L total income')

// --- 7. ITR-form recommendation -------------------------------------------------
assert.equal(recommendItrForm(emptyTaxInputs()), 'ITR-1', 'no business/CG → ITR-1')
assert.equal(recommendItrForm({ ...emptyTaxInputs(), fnoBusiness: 1000 }), 'ITR-3', 'F&O → ITR-3')
assert.equal(recommendItrForm({ ...emptyTaxInputs(), bfSpecifiedBusinessLoss: 1000 }), 'ITR-3', 'BF loss → ITR-3')
assert.equal(recommendItrForm({ ...emptyTaxInputs(), ltcgEquity112A: 1000 }), 'ITR-2', 'LTCG → ITR-2')
assert.equal(recommendItrForm({ ...emptyTaxInputs(), stcgOther: 1000 }), 'ITR-2', 'STCG → ITR-2')

console.log('Parser + seed + tax-engine unit tests passed.')