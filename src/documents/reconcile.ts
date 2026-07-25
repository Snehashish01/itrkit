// Cross-document reconciliation. The parsers emit a shared FieldKey per value,
// so the same figure reported by different statements (e.g. gross salary in AIS
// and TIS, or salary paid/credited in AIS and Form 26AS) groups together and can
// be checked for agreement — deterministically, offline.

import type { DocumentKey } from '../domain/filing'
import type { FieldKey, ParsedField } from './reports'
import { fieldLabels } from './reports'

export type ReconSource = { kind: DocumentKey; value: number; page: number }

export type ReconEntry = {
  key: FieldKey
  label: string
  status: 'match' | 'mismatch' | 'single'
  value: number
  sources: ReconSource[]
}

const fieldOrder: FieldKey[] = [
  'grossSalary',
  'salaryPaidCredited',
  'exemptAllowances',
  'standardDeduction',
  'professionalTax',
  'housePropertyIncome',
  'rentReceived',
  'grossTotalIncome',
  'totalIncome',
  'interestSavings',
  'interestDeposit',
  'dividend',
  'deduction80C',
  'deduction80CCD2',
  'totalTdsSalary',
  'totalTcs',
  'selfAssessmentTax',
  'totalTaxPaid',
  'bfSpecifiedBusinessLoss',
  'bfSpeculativeBusinessLoss',
  'bfLtcgLoss',
  'bfHpLoss',
]

const shortKinds: Partial<Record<DocumentKey, string>> = {
  ais: 'AIS',
  tis: 'TIS',
  form26as: '26AS',
  form16: 'Form 16',
  bankInterest: 'Bank',
  priorItr: 'Prior ITR',
  brokerReport: 'Broker',
  mutualFundReport: 'MF',
}

export function shortDocKind(kind: DocumentKey): string {
  return shortKinds[kind] ?? kind
}

export function reconcile(
  documents: Array<{ kind: DocumentKey; fields?: ParsedField[] }>,
): ReconEntry[] {
  const groups = new Map<FieldKey, ReconSource[]>()
  for (const doc of documents) {
    for (const field of doc.fields ?? []) {
      const list = groups.get(field.key) ?? []
      list.push({ kind: doc.kind, value: field.value, page: field.page })
      groups.set(field.key, list)
    }
  }

  const entries: ReconEntry[] = []
  for (const key of fieldOrder) {
    const sources = groups.get(key)
    if (!sources || sources.length === 0) continue
    const first = sources[0].value
    const allEqual = sources.every((source) => source.value === first)
    entries.push({
      key,
      label: fieldLabels[key],
      status: sources.length === 1 ? 'single' : allEqual ? 'match' : 'mismatch',
      value: first,
      sources,
    })
  }
  return entries
}
