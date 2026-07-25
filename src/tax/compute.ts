// Deterministic income-tax computation for AY 2026-27 (FY 2025-26).
// Estimator only — no rule is "invented"; every figure is transparent and the
// user can override inputs. This is NOT tax advice and NOT a filing value;
// always confirm in the official utility. Surcharge is computed with marginal
// relief (see notes); a few edge cases remain simplified and are flagged.
//
// This module is a LEAF: it imports nothing from the rest of the app, so it is
// cycle-free and unit-checkable in isolation.

export type Regime = 'old' | 'new'
export type AgeBand = 'below60' | 'senior' | 'superSenior'

export type ItrForm = 'ITR-1' | 'ITR-2' | 'ITR-3'

/** One house-property entry. `type` drives the net-income derivation. */
export type HouseProperty = {
  type: 'selfOccupied' | 'letOut' | 'deemed'
  grossRent: number // annual rent receivable (let-out/deemed); 0 for self-occupied
  municipalTax: number // local/municipal taxes actually paid in the year
  loanInterest: number // sec 24(b) interest on borrowed capital
}

/** Normalised inputs. Income fields are seeded from documents; deductions,
 * capital gains, house-property schedule, carry-forward losses and taxes paid
 * are user-entered (and override any seeded value). All amounts in INR. */
export type TaxInputs = {
  ageBand: AgeBand
  // Salary
  grossSalary: number
  exemptAllowances: number // sec 10 (HRA/LTA…) — old regime only
  professionalTax: number // sec 16(iii) — old regime only
  // House property — scalar (manual override / seeded from Form 16). Used only
  // when `houseProperties` is empty; otherwise the schedule drives net HP.
  housePropertyIncome: number // negative = loss; self-occupied interest capped at -2,00,000
  houseProperties: HouseProperty[]
  // Other sources
  interestIncome: number // savings + deposit interest
  dividends: number
  otherIncome: number
  // Capital gains / business (broker Tax P&L taxonomy)
  stcgEquity111A: number // listed equity/equity MF with STT → 20%
  ltcgEquity112A: number // listed equity/equity MF → 12.5% over ₹1.25L
  stcgOther: number // debt/other STCG → slab
  ltcgOther: number // other LTCG → 12.5%
  intradaySpeculative: number // equity intraday → slab (speculative business)
  fnoBusiness: number // F&O → slab (specified business u/s 43(5))
  // Brought-forward (carry-forward) losses from prior-year Schedule CFL
  bfSpecifiedBusinessLoss: number // F&O — set off against any income except salary
  bfSpeculativeBusinessLoss: number // intraday — set off against speculative income only
  bfLtcgLoss: number // LTCG — set off against LTCG only (sec 74)
  bfHpLoss: number // house property — set off against HP income only
  // Chapter VI-A (old regime unless noted)
  ded80C: number
  ded80D: number
  ded80CCD1B: number
  ded80TTA: number // savings-bank interest (capped by remaining interest + age cap)
  ded80GAndOther: number // 80G/80GG/80DD/80DDB/80U/80GGC etc. (enter eligible amount)
  ded80CCD2Employer: number // employer NPS — allowed in BOTH regimes
  ded80EEA: number // affordable-housing home-loan interest (cap ₹1.5L, separate from 80C)
  ded80E: number // education-loan interest (no statutory cap)
  ded80EEB: number // electric-vehicle loan interest (cap ₹1.5L)
  ded80CCH: number // Agniveer Corpus / new scheme (cap ₹1.5L)
  // Exempt income disclosed in Schedule EI (does NOT enter GTI)
  exemptIncome: number
  // Taxes already paid
  tdsTcs: number // TDS (salary + other) + TCS credits
  advanceTax: number
  selfAssessmentTax: number
  // Filing planning
  filingMonth: number // 1–12; month of self-assessment payment / filing (for 234B estimate)
}

export type BfBucket = { opening: number; setoff: number; closing: number }

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
  bfLossSetoff: number
  bfLossCarriedForward: number
  bfLossBreakdown: { specified: BfBucket; speculative: BfBucket; ltcg: BfBucket; hp: BfBucket }
  interest234BEstimate: number
  exemptIncome: number
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

/** Net income (or loss) for a single house property, per sec 22-24. */
function netHouseProperty(property: HouseProperty): number {
  if (property.type === 'selfOccupied') {
    return -Math.min(Math.max(0, property.loanInterest), 200000)
  }
  const nav = Math.max(0, property.grossRent - Math.max(0, property.municipalTax))
  const standardDeduction = round(0.3 * nav) // sec 24(a) — 30% of NAV
  return nav - standardDeduction - Math.max(0, property.loanInterest)
}

type SurchargeBand = { from: number; rate: number }

const OLD_SURCHARGE_BANDS: SurchargeBand[] = [
  { from: 5000000, rate: 0.1 },
  { from: 10000000, rate: 0.15 },
  { from: 20000000, rate: 0.25 },
  { from: 50000000, rate: 0.37 },
]

const NEW_SURCHARGE_BANDS: SurchargeBand[] = [
  { from: 5000000, rate: 0.1 },
  { from: 10000000, rate: 0.15 },
  { from: 20000000, rate: 0.25 },
  { from: 50000000, rate: 0.25 }, // new regime caps surcharge at 25%
]

/** Surcharge with marginal relief at each threshold. `taxBase` is the
 * income-tax on which surcharge is levied (slab tax after rebate + special tax).
 * `specialIncome` lets us recompute the slab tax at the threshold income, and
 * `specialTax` is the (unchanged) special-rate tax included in that base. */
function surcharge(
  totalIncome: number,
  taxBase: number,
  regime: Regime,
  ageBand: AgeBand,
  specialIncome: number,
  specialTax: number,
): number {
  const bands = regime === 'new' ? NEW_SURCHARGE_BANDS : OLD_SURCHARGE_BANDS
  if (totalIncome <= bands[0].from) return 0
  const index = bands.findIndex((band, i) => totalIncome > band.from && (i === bands.length - 1 || totalIncome <= bands[i + 1].from))
  const band = bands[index]
  const fullSurcharge = band.rate * taxBase
  const prevRate = index > 0 ? bands[index - 1].rate : 0
  // Recompute the income-tax at the threshold income (no rebate applies > ₹12L).
  // Special-rate capital gains are unchanged when only normal income is scaled
  // to the threshold, so the special tax carries over as-is.
  const slabTaxableAtThreshold = positive(band.from - specialIncome)
  const baseTaxAtThreshold = slabTax(slabTaxableAtThreshold, regime === 'new' ? NEW_SLABS : oldSlabs(ageBand)) + specialTax
  const taxAtThreshold = baseTaxAtThreshold + prevRate * baseTaxAtThreshold
  const taxWithFullSurcharge = taxBase + fullSurcharge
  const marginalLimit = taxAtThreshold + (totalIncome - band.from)
  if (taxWithFullSurcharge > marginalLimit) {
    return Math.max(0, fullSurcharge - (taxWithFullSurcharge - marginalLimit))
  }
  return fullSurcharge
}

export function computeRegime(inputs: TaxInputs, regime: Regime): TaxResult {
  const standardDeduction = inputs.grossSalary > 0 ? (regime === 'new' ? 75000 : 50000) : 0
  const salaryHead = positive(
    inputs.grossSalary -
      standardDeduction -
      (regime === 'old' ? inputs.exemptAllowances + inputs.professionalTax : 0),
  )

  // House property — schedule wins when populated, else the scalar fallback.
  const rawHp =
    inputs.houseProperties && inputs.houseProperties.length > 0
      ? inputs.houseProperties.reduce((sum, p) => sum + netHouseProperty(p), 0)
      : Math.max(inputs.housePropertyIncome, -200000)

  // CYLA — current-year house-property loss sets off against salary (old regime
  // only; new regime sec 71(3A) bars the set-off and the loss carries forward,
  // which the engine drops from GTI but does not track as a CF bucket).
  let salaryAfterCyla = salaryHead
  let hpAfterCyla = rawHp
  if (regime === 'old' && hpAfterCyla < 0) {
    const setoff = Math.min(-hpAfterCyla, salaryAfterCyla)
    salaryAfterCyla -= setoff
    hpAfterCyla += setoff
  }

  // Current-year heads (post-CYLA, pre-BFLA).
  let interestHead = inputs.interestIncome
  let dividendHead = inputs.dividends
  let otherHead = inputs.otherIncome
  let speculativeHead = positive(inputs.intradaySpeculative)
  let fnoHead = inputs.fnoBusiness
  let stcgOtherHead = positive(inputs.stcgOther)
  let stcg111A = positive(inputs.stcgEquity111A)
  let ltcg112ATaxable = positive(inputs.ltcgEquity112A - 125000)
  let ltcgOtherTaxable = positive(inputs.ltcgOther)

  // BFLA — brought-forward (carry-forward) loss set-off, in statutory order.
  let bfSpecified = Math.max(0, inputs.bfSpecifiedBusinessLoss)
  let bfSpeculative = Math.max(0, inputs.bfSpeculativeBusinessLoss)
  let bfLtcg = Math.max(0, inputs.bfLtcgLoss)
  let bfHp = Math.max(0, inputs.bfHpLoss)
  const openingSpecified = bfSpecified
  const openingSpeculative = bfSpeculative
  const openingLtcg = bfLtcg
  const openingHp = bfHp

  // 1. Brought-forward speculative loss → current-year speculative income only.
  {
    const setoff = Math.min(bfSpeculative, speculativeHead)
    speculativeHead -= setoff
    bfSpeculative -= setoff
  }
  // 2. Brought-forward LTCG loss → current-year LTCG only (sec 74).
  {
    const ltcgIncome = ltcg112ATaxable + ltcgOtherTaxable
    let remaining = Math.min(bfLtcg, ltcgIncome)
    const reduceOther = Math.min(remaining, ltcgOtherTaxable)
    ltcgOtherTaxable -= reduceOther
    remaining -= reduceOther
    ltcg112ATaxable -= remaining
    bfLtcg -= Math.min(bfLtcg, ltcgIncome)
  }
  // 3. Brought-forward house-property loss → current-year HP income only.
  {
    const hpPos = Math.max(0, hpAfterCyla)
    const setoff = Math.min(bfHp, hpPos)
    hpAfterCyla -= setoff
    bfHp -= setoff
  }
  // 4. Brought-forward specified-business (F&O) loss → any income except salary
  // (sec 43(5)). Absorb other sources first (other, dividend, interest), then
  // business, then slab-rate STCG, then speculative, then special-rate gains.
  {
    const absorb = (cap: number) => {
      const setoff = Math.min(bfSpecified, Math.max(0, cap))
      bfSpecified -= setoff
      return cap - setoff
    }
    otherHead = absorb(otherHead)
    dividendHead = absorb(dividendHead)
    interestHead = absorb(interestHead)
    fnoHead = absorb(fnoHead)
    stcgOtherHead = absorb(stcgOtherHead)
    speculativeHead = absorb(speculativeHead)
    // Special-rate capital gains (set-off per sec 43(5) "any income except salary").
    let specialRemaining = stcg111A + ltcgOtherTaxable + ltcg112ATaxable
    const specialSetoff = Math.min(bfSpecified, specialRemaining)
    let rem = specialSetoff
    const r1 = Math.min(rem, ltcgOtherTaxable)
    ltcgOtherTaxable -= r1
    rem -= r1
    const r2 = Math.min(rem, ltcg112ATaxable)
    ltcg112ATaxable -= r2
    rem -= r2
    stcg111A -= Math.min(rem, stcg111A)
    bfSpecified -= specialSetoff
  }
  const interestRemaining = Math.max(0, interestHead)

  const slabIncome =
    salaryAfterCyla +
    Math.max(0, hpAfterCyla) +
    Math.max(0, interestHead) +
    Math.max(0, dividendHead) +
    Math.max(0, otherHead) +
    fnoHead +
    speculativeHead +
    stcgOtherHead
  const specialIncome = stcg111A + ltcg112ATaxable + ltcgOtherTaxable
  const grossTotalIncome = positive(slabIncome) + specialIncome

  // Chapter VI-A. 80TTA/80TTB are capped by the savings interest that survives
  // BFLA set-off (you cannot both set a loss against interest and deduct it).
  const ageInterestCap = inputs.ageBand === 'below60' ? 10000 : 50000
  const chapterVIADeduction =
    regime === 'new'
      ? inputs.ded80CCD2Employer
      : Math.min(inputs.ded80C, 150000) +
        inputs.ded80D +
        Math.min(inputs.ded80CCD1B, 50000) +
        Math.min(inputs.ded80TTA, interestRemaining, ageInterestCap) +
        inputs.ded80GAndOther +
        inputs.ded80CCD2Employer +
        Math.min(inputs.ded80EEA, 150000) +
        inputs.ded80E +
        Math.min(inputs.ded80EEB, 150000) +
        Math.min(inputs.ded80CCH, 150000)

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
  const surchargeAmount = surcharge(totalIncome, taxBeforeCess, regime, inputs.ageBand, specialIncome, specialTax)
  const cess = round(0.04 * (taxBeforeCess + surchargeAmount))
  const totalTaxLiability = round(taxBeforeCess + surchargeAmount + cess)
  const taxesPaid = inputs.tdsTcs + inputs.advanceTax + inputs.selfAssessmentTax
  const balance = round(totalTaxLiability - taxesPaid)

  // 234B interest — rough planning estimate only. Applies when advance tax was
  // nil and a balance is payable; computed at 1%/month from April to the
  // filing/payment month. The official utility's figure (which uses actual
  // payment dates) is authoritative; treat this as a conservative upper bound.
  let interest234BEstimate = 0
  if (balance > 0 && inputs.advanceTax === 0 && totalTaxLiability > 10000) {
    const months = Math.max(1, (inputs.filingMonth || 7) - 3)
    interest234BEstimate = round(balance * 0.01 * months)
  }

  const bfLossSetoff =
    openingSpecified - bfSpecified +
    (openingSpeculative - bfSpeculative) +
    (openingLtcg - bfLtcg) +
    (openingHp - bfHp)
  const bfLossCarriedForward = bfSpecified + bfSpeculative + bfLtcg + bfHp

  return {
    regime,
    standardDeduction,
    salaryIncome: salaryAfterCyla,
    housePropertyIncome: rawHp,
    otherSourcesIncome: Math.max(0, interestHead) + Math.max(0, dividendHead) + Math.max(0, otherHead),
    businessIncome: fnoHead + speculativeHead,
    slabIncome: positive(slabIncome),
    specialIncome,
    grossTotalIncome,
    chapterVIADeduction,
    totalIncome,
    slabTax: round(normalSlabTax),
    specialTax: round(specialTax),
    rebate87A: round(rebate87A),
    surcharge: round(surchargeAmount),
    cess,
    totalTaxLiability,
    taxesPaid,
    balance,
    bfLossSetoff,
    bfLossCarriedForward,
    bfLossBreakdown: {
      specified: { opening: openingSpecified, setoff: openingSpecified - bfSpecified, closing: bfSpecified },
      speculative: { opening: openingSpeculative, setoff: openingSpeculative - bfSpeculative, closing: bfSpeculative },
      ltcg: { opening: openingLtcg, setoff: openingLtcg - bfLtcg, closing: bfLtcg },
      hp: { opening: openingHp, setoff: openingHp - bfHp, closing: bfHp },
    },
    interest234BEstimate,
    exemptIncome: inputs.exemptIncome,
  }
}

export function compareRegimes(inputs: TaxInputs): TaxComparison {
  const oldResult = computeRegime(inputs, 'old')
  const newResult = computeRegime(inputs, 'new')
  const recommended = newResult.totalTaxLiability <= oldResult.totalTaxLiability ? 'new' : 'old'
  const saving = Math.abs(oldResult.totalTaxLiability - newResult.totalTaxLiability)
  return { old: oldResult, new: newResult, recommended, saving }
}

/** Recommend an ITR form from the inputs (advisory; the user can override).
 * ITR-3 is required to carry forward business losses (Schedule BP/CFL). ITR-2
 * covers capital gains; ITR-1 covers salary + one/two house properties + interest
 * (G.S.R. 226(E) widened ITR-1 to two house properties for AY 2026-27). */
export function recommendItrForm(inputs: TaxInputs): ItrForm {
  const hasBusiness =
    inputs.fnoBusiness !== 0 ||
    inputs.intradaySpeculative !== 0 ||
    inputs.bfSpecifiedBusinessLoss > 0 ||
    inputs.bfSpeculativeBusinessLoss > 0
  if (hasBusiness) return 'ITR-3'
  const hasCapitalGains =
    inputs.stcgEquity111A > 0 ||
    inputs.ltcgEquity112A > 0 ||
    inputs.stcgOther > 0 ||
    inputs.ltcgOther > 0 ||
    inputs.bfLtcgLoss > 0
  if (hasCapitalGains) return 'ITR-2'
  return 'ITR-1'
}

export const emptyTaxInputs = (): TaxInputs => ({
  ageBand: 'below60',
  grossSalary: 0,
  exemptAllowances: 0,
  professionalTax: 0,
  housePropertyIncome: 0,
  houseProperties: [],
  interestIncome: 0,
  dividends: 0,
  otherIncome: 0,
  stcgEquity111A: 0,
  ltcgEquity112A: 0,
  stcgOther: 0,
  ltcgOther: 0,
  intradaySpeculative: 0,
  fnoBusiness: 0,
  bfSpecifiedBusinessLoss: 0,
  bfSpeculativeBusinessLoss: 0,
  bfLtcgLoss: 0,
  bfHpLoss: 0,
  ded80C: 0,
  ded80D: 0,
  ded80CCD1B: 0,
  ded80TTA: 0,
  ded80GAndOther: 0,
  ded80CCD2Employer: 0,
  ded80EEA: 0,
  ded80E: 0,
  ded80EEB: 0,
  ded80CCH: 0,
  exemptIncome: 0,
  tdsTcs: 0,
  advanceTax: 0,
  selfAssessmentTax: 0,
  filingMonth: 7,
})