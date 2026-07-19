// Deterministic income-tax computation for AY 2026-27 (FY 2025-26).
// Estimator only — no rule is "invented"; every figure is transparent and the
// user can override inputs. This is NOT tax advice and NOT a filing value;
// always confirm in the official utility. Surcharge is simplified (see notes).

export type Regime = 'old' | 'new'
export type AgeBand = 'below60' | 'senior' | 'superSenior'

/** Normalised inputs. Income fields are seeded from documents; deductions and
 * capital gains are user-entered. All amounts in INR. */
export type TaxInputs = {
  ageBand: AgeBand
  // Salary
  grossSalary: number
  exemptAllowances: number // sec 10 (HRA/LTA…) — old regime only
  professionalTax: number // sec 16(iii) — old regime only
  // House property (negative = loss; self-occupied interest capped at -2,00,000)
  housePropertyIncome: number
  // Other sources
  interestIncome: number
  dividends: number
  otherIncome: number
  // Capital gains / business (broker Tax P&L taxonomy)
  stcgEquity111A: number // listed equity/equity MF with STT → 20%
  ltcgEquity112A: number // listed equity/equity MF → 12.5% over ₹1.25L
  stcgOther: number // debt/other STCG → slab
  ltcgOther: number // other LTCG → 12.5%
  intradaySpeculative: number // equity intraday → slab (speculative business)
  fnoBusiness: number // F&O → slab (non-speculative business)
  // Chapter VI-A (old regime unless noted)
  ded80C: number
  ded80D: number
  ded80CCD1B: number
  ded80TTA: number
  ded80GAndOther: number
  ded80CCD2Employer: number // employer NPS — allowed in BOTH regimes
  // Taxes already paid
  tdsTcs: number
  advanceTax: number
  selfAssessmentTax: number
}

export type TaxResult = {
  regime: Regime
  standardDeduction: number
  salaryIncome: number
  housePropertyIncome: number
  otherSourcesIncome: number
  businessIncome: number
  slabIncome: number // normal income taxed at slab rates (pre-VIA)
  specialIncome: number // STCG 111A + taxable LTCG (shown in GTI)
  grossTotalIncome: number
  chapterVIADeduction: number
  totalIncome: number
  slabTax: number
  specialTax: number
  rebate87A: number
  surcharge: number
  cess: number
  totalTaxLiability: number
  taxesPaid: number
  balance: number // > 0 payable, < 0 refund
}

export type TaxComparison = {
  old: TaxResult
  new: TaxResult
  recommended: Regime
  saving: number // tax saved by choosing the recommended regime
}

type Slab = { upTo: number; rate: number }

const NEW_SLABS: Slab[] = [
  { upTo: 400000, rate: 0 },
  { upTo: 800000, rate: 0.05 },
  { upTo: 1200000, rate: 0.1 },
  { upTo: 1600000, rate: 0.15 },
  { upTo: 2000000, rate: 0.2 },
  { upTo: 2400000, rate: 0.25 },
  { upTo: Infinity, rate: 0.3 },
]

function oldSlabs(ageBand: AgeBand): Slab[] {
  const basic = ageBand === 'superSenior' ? 500000 : ageBand === 'senior' ? 300000 : 250000
  return [
    { upTo: basic, rate: 0 },
    { upTo: 500000, rate: 0.05 },
    { upTo: 1000000, rate: 0.2 },
    { upTo: Infinity, rate: 0.3 },
  ]
}

function slabTax(taxable: number, slabs: Slab[]): number {
  let tax = 0
  let previous = 0
  for (const slab of slabs) {
    if (taxable <= previous) break
    tax += (Math.min(taxable, slab.upTo) - previous) * slab.rate
    previous = slab.upTo
  }
  return tax
}

const round = (value: number) => Math.round(value)
const positive = (value: number) => Math.max(0, value)

export function computeRegime(inputs: TaxInputs, regime: Regime): TaxResult {
  const standardDeduction = inputs.grossSalary > 0 ? (regime === 'new' ? 75000 : 50000) : 0
  const salaryIncome = positive(
    inputs.grossSalary -
      standardDeduction -
      (regime === 'old' ? inputs.exemptAllowances + inputs.professionalTax : 0),
  )
  const cappedHouseProperty = Math.max(inputs.housePropertyIncome, -200000)
  // New regime (sec 115BAC): a house-property loss cannot be set off against
  // other heads, so only positive house-property income is counted.
  const housePropertyIncome = regime === 'new' ? positive(cappedHouseProperty) : cappedHouseProperty
  const otherSourcesIncome = inputs.interestIncome + inputs.dividends + inputs.otherIncome
  const businessIncome = inputs.intradaySpeculative + inputs.fnoBusiness

  // Normal (slab-taxed) income, including slab-rate capital gains.
  const slabIncome =
    salaryIncome + housePropertyIncome + otherSourcesIncome + businessIncome + positive(inputs.stcgOther)

  // Special-rate incomes.
  const stcg111A = positive(inputs.stcgEquity111A)
  const ltcg112ATaxable = positive(inputs.ltcgEquity112A - 125000)
  const ltcgOtherTaxable = positive(inputs.ltcgOther)
  const specialIncome = stcg111A + ltcg112ATaxable + ltcgOtherTaxable

  const grossTotalIncome = positive(slabIncome) + specialIncome

  const chapterVIADeduction =
    regime === 'new'
      ? inputs.ded80CCD2Employer
      : Math.min(inputs.ded80C, 150000) +
        inputs.ded80D +
        Math.min(inputs.ded80CCD1B, 50000) +
        Math.min(inputs.ded80TTA, inputs.ageBand === 'below60' ? 10000 : 50000) +
        inputs.ded80GAndOther +
        inputs.ded80CCD2Employer

  // Deductions reduce normal income only (never special-rate CG).
  const slabTaxable = positive(positive(slabIncome) - chapterVIADeduction)
  const totalIncome = slabTaxable + specialIncome

  const slabs = regime === 'new' ? NEW_SLABS : oldSlabs(inputs.ageBand)
  const normalSlabTax = slabTax(slabTaxable, slabs)
  const specialTax = 0.2 * stcg111A + 0.125 * ltcg112ATaxable + 0.125 * ltcgOtherTaxable

  // Rebate u/s 87A (against normal slab tax only; income threshold on total income).
  let rebate87A = 0
  if (regime === 'new' && totalIncome <= 1200000) rebate87A = Math.min(normalSlabTax, 60000)
  if (regime === 'old' && totalIncome <= 500000) rebate87A = Math.min(normalSlabTax, 12500)

  let slabTaxAfterRebate = positive(normalSlabTax - rebate87A)
  // New-regime marginal relief just above ₹12L.
  if (regime === 'new' && totalIncome > 1200000) {
    const excessOverThreshold = totalIncome - 1200000
    if (slabTaxAfterRebate > excessOverThreshold) slabTaxAfterRebate = excessOverThreshold
  }

  const taxBeforeCess = slabTaxAfterRebate + specialTax
  // Surcharge: simplified to 0 (applies above ₹50L total income; verify separately).
  const surcharge = 0
  const cess = round(0.04 * (taxBeforeCess + surcharge))
  const totalTaxLiability = round(taxBeforeCess + surcharge + cess)
  const taxesPaid = inputs.tdsTcs + inputs.advanceTax + inputs.selfAssessmentTax
  const balance = round(totalTaxLiability - taxesPaid)

  return {
    regime,
    standardDeduction,
    salaryIncome,
    housePropertyIncome,
    otherSourcesIncome,
    businessIncome,
    slabIncome: positive(slabIncome),
    specialIncome,
    grossTotalIncome,
    chapterVIADeduction,
    totalIncome,
    slabTax: round(normalSlabTax),
    specialTax: round(specialTax),
    rebate87A: round(rebate87A),
    surcharge,
    cess,
    totalTaxLiability,
    taxesPaid,
    balance,
  }
}

export function compareRegimes(inputs: TaxInputs): TaxComparison {
  const oldResult = computeRegime(inputs, 'old')
  const newResult = computeRegime(inputs, 'new')
  const recommended = newResult.totalTaxLiability <= oldResult.totalTaxLiability ? 'new' : 'old'
  const saving = Math.abs(oldResult.totalTaxLiability - newResult.totalTaxLiability)
  return { old: oldResult, new: newResult, recommended, saving }
}

export const emptyTaxInputs = (): TaxInputs => ({
  ageBand: 'below60',
  grossSalary: 0,
  exemptAllowances: 0,
  professionalTax: 0,
  housePropertyIncome: 0,
  interestIncome: 0,
  dividends: 0,
  otherIncome: 0,
  stcgEquity111A: 0,
  ltcgEquity112A: 0,
  stcgOther: 0,
  ltcgOther: 0,
  intradaySpeculative: 0,
  fnoBusiness: 0,
  ded80C: 0,
  ded80D: 0,
  ded80CCD1B: 0,
  ded80TTA: 0,
  ded80GAndOther: 0,
  ded80CCD2Employer: 0,
  tdsTcs: 0,
  advanceTax: 0,
  selfAssessmentTax: 0,
})
