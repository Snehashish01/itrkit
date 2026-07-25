import type { ItrForm, Regime, TaxInputs } from '../tax/compute'

export type FilingSection = '139(1)' | '139(5)' | '139(3)'

export type FilingStage =
  | 'documentsReady'
  | 'aisReconciled'
  | 'regimeCompared'
  | 'draftReviewed'
  | 'utilityValidated'
  | 'taxpayerApproved'
  | 'submitted'
  | 'eVerified'

export type DocumentKey =
  | 'form16'
  | 'ais'
  | 'tis'
  | 'form26as'
  | 'bankInterest'
  | 'priorItr'
  | 'brokerReport'
  | 'mutualFundReport'

export type Member = {
  id: string
  alias: string
  salaryOrPension: boolean
  capitalGains: boolean
  documents: Record<DocumentKey, boolean>
  stages: Record<FilingStage, boolean>
  taxInputs?: Partial<TaxInputs>
  // Filing-decision + outcome metadata (all optional for backward compatibility
  // with members stored before these fields existed). The engine recommends a
  // form/regime; the user's choice is stored here.
  filingForm?: ItrForm
  filingSection?: FilingSection
  chosenRegime?: Regime
  filedAt?: string // ISO date the return was submitted, if filed
  acknowledgementNo?: string // ITR-V / acknowledgement number, if filed
  selfAssessmentChallan?: string // e-Pay Tax challan reference, if paid
}

export const documentItems: Array<{
  key: DocumentKey
  label: string
  capitalGainsOnly?: boolean
}> = [
  { key: 'form16', label: 'Form 16 / pension statement' },
  { key: 'ais', label: 'Annual Information Statement (AIS)' },
  { key: 'tis', label: 'Taxpayer Information Summary (TIS)' },
  { key: 'form26as', label: 'Form 26AS' },
  { key: 'bankInterest', label: 'Bank interest summary' },
  { key: 'priorItr', label: 'Prior-year ITR and computation' },
  { key: 'brokerReport', label: 'Broker capital-gains report', capitalGainsOnly: true },
  {
    key: 'mutualFundReport',
    label: 'Mutual-fund capital-gains report',
    capitalGainsOnly: true,
  },
]

export const stageItems: Array<{ key: FilingStage; label: string; detail: string }> = [
  {
    key: 'documentsReady',
    label: 'Documents ready',
    detail: 'All relevant source records have been collected.',
  },
  {
    key: 'aisReconciled',
    label: 'AIS and tax credits reconciled',
    detail: 'Differences against Form 16, 26AS and reports are explained.',
  },
  {
    key: 'regimeCompared',
    label: 'Tax regimes compared',
    detail: 'Old and new regime outcomes were checked for this person.',
  },
  {
    key: 'draftReviewed',
    label: 'Draft return reviewed',
    detail: 'Income, deductions, gains, tax paid and refund were reviewed.',
  },
  {
    key: 'utilityValidated',
    label: 'Official utility validated',
    detail: 'The AY 2026-27 utility reports no blocking errors.',
  },
  {
    key: 'taxpayerApproved',
    label: 'Taxpayer approved',
    detail: 'The family member reviewed the final preview personally.',
  },
  {
    key: 'submitted',
    label: 'Return submitted',
    detail: 'Submission was completed in the taxpayer’s own portal account.',
  },
  {
    key: 'eVerified',
    label: 'E-verified',
    detail: 'Acknowledgement confirms successful e-verification.',
  },
]

export const emptyDocuments = (): Record<DocumentKey, boolean> => ({
  form16: false,
  ais: false,
  tis: false,
  form26as: false,
  bankInterest: false,
  priorItr: false,
  brokerReport: false,
  mutualFundReport: false,
})

export const emptyStages = (): Record<FilingStage, boolean> => ({
  documentsReady: false,
  aisReconciled: false,
  regimeCompared: false,
  draftReviewed: false,
  utilityValidated: false,
  taxpayerApproved: false,
  submitted: false,
  eVerified: false,
})

const documentKeys = documentItems.map(({ key }) => key)
const filingStages = stageItems.map(({ key }) => key)

const itrForms: ItrForm[] = ['ITR-1', 'ITR-2', 'ITR-3']
const filingSections: FilingSection[] = ['139(1)', '139(5)', '139(3)']
const regimes: Regime[] = ['old', 'new']
const optionalString = (value: unknown) => value === undefined || typeof value === 'string'

export function isMember(value: unknown): value is Member {
  if (!value || typeof value !== 'object') return false
  const member = value as Partial<Member>
  return (
    typeof member.id === 'string' &&
    typeof member.alias === 'string' &&
    typeof member.salaryOrPension === 'boolean' &&
    typeof member.capitalGains === 'boolean' &&
    !!member.documents &&
    documentKeys.every((key) => typeof member.documents?.[key] === 'boolean') &&
    !!member.stages &&
    filingStages.every((key) => typeof member.stages?.[key] === 'boolean') &&
    (member.taxInputs === undefined ||
      (typeof member.taxInputs === 'object' && member.taxInputs !== null)) &&
    (member.filingForm === undefined || itrForms.includes(member.filingForm)) &&
    (member.filingSection === undefined || filingSections.includes(member.filingSection)) &&
    (member.chosenRegime === undefined || regimes.includes(member.chosenRegime)) &&
    optionalString(member.filedAt) &&
    optionalString(member.acknowledgementNo) &&
    optionalString(member.selfAssessmentChallan)
  )
}