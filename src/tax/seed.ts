// Seed tax-computation income fields from a member's reconciled documents.
// Only income figures that appear in the parsed statements are seeded; the user
// supplies deductions and capital gains (and can override any seeded value).

import type { StoredDocument } from '../storage/vault'
import { reconcile } from '../documents/reconcile'
import type { FieldKey } from '../documents/reports'
import type { TaxInputs } from './compute'

export function seedTaxInputs(documents: StoredDocument[]): Partial<TaxInputs> {
  const entries = reconcile(
    documents.map((document) => ({ kind: document.kind, fields: document.analysis?.fields })),
  )
  const byKey = new Map<FieldKey, number>()
  for (const entry of entries) byKey.set(entry.key, entry.value)
  const get = (key: FieldKey) => byKey.get(key) ?? 0

  const seed: Partial<TaxInputs> = {}
  if (byKey.has('grossSalary')) seed.grossSalary = get('grossSalary')
  else if (byKey.has('salaryPaidCredited')) seed.grossSalary = get('salaryPaidCredited')

  if (byKey.has('exemptAllowances')) seed.exemptAllowances = get('exemptAllowances')
  if (byKey.has('professionalTax')) seed.professionalTax = get('professionalTax')
  if (byKey.has('housePropertyIncome')) seed.housePropertyIncome = get('housePropertyIncome')

  const interest = get('interestSavings') + get('interestDeposit')
  if (interest > 0) seed.interestIncome = interest
  if (byKey.has('dividend')) seed.dividends = get('dividend')

  // 80TTA (old regime): deduction for savings-bank interest, capped by the tax
  // engine (₹10,000 below 60). Seniors' 80TTB (incl. deposit interest, ₹50,000)
  // is surfaced as a UI hint since the age band is applied after seeding.
  if (get('interestSavings') > 0) seed.ded80TTA = get('interestSavings')

  if (byKey.has('deduction80C')) seed.ded80C = get('deduction80C')
  if (byKey.has('deduction80CCD2')) seed.ded80CCD2Employer = get('deduction80CCD2')

  if (byKey.has('totalTdsSalary')) seed.tdsTcs = get('totalTdsSalary')
  if (byKey.has('selfAssessmentTax')) seed.selfAssessmentTax = get('selfAssessmentTax')
  return seed
}
