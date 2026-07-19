import { useEffect, useMemo, useState } from 'react'
import { Calculator, Scale, ShieldAlert } from 'lucide-react'
import type { Member } from '../domain/filing'
import { listDocuments } from '../storage/vault'
import type { StoredDocument } from '../storage/vault'
import { compareRegimes, emptyTaxInputs } from '../tax/compute'
import type { AgeBand, Regime, TaxInputs, TaxResult } from '../tax/compute'
import { seedTaxInputs } from '../tax/seed'

type TaxComputationPanelProps = {
  member: Member
  onInputsChange: (taxInputs: Partial<TaxInputs>) => void
}

type NumKey = Exclude<keyof TaxInputs, 'ageBand'>
type NumField = { key: NumKey; label: string }

const inr = (value: number) => {
  const rounded = Math.round(value) || 0 // normalise -0 → 0
  return `₹${rounded.toLocaleString('en-IN')}`
}

const incomeFields: NumField[] = [
  { key: 'grossSalary', label: 'Gross salary' },
  { key: 'exemptAllowances', label: 'Exempt allowances u/s 10 (old only)' },
  { key: 'professionalTax', label: 'Professional tax (old only)' },
  { key: 'housePropertyIncome', label: 'House property income / loss' },
  { key: 'interestIncome', label: 'Interest income' },
  { key: 'dividends', label: 'Dividends' },
  { key: 'otherIncome', label: 'Other income' },
]

const capitalGainsFields: NumField[] = [
  { key: 'stcgEquity111A', label: 'Equity STCG u/s 111A (20%)' },
  { key: 'ltcgEquity112A', label: 'Equity LTCG u/s 112A (12.5% over ₹1.25L)' },
  { key: 'stcgOther', label: 'Other / debt STCG (slab)' },
  { key: 'ltcgOther', label: 'Other LTCG (12.5%)' },
  { key: 'intradaySpeculative', label: 'Intraday — speculative (slab)' },
  { key: 'fnoBusiness', label: 'F&O — business (slab)' },
]

const deductionFields: NumField[] = [
  { key: 'ded80C', label: '80C (cap ₹1.5L)' },
  { key: 'ded80D', label: '80D health insurance' },
  { key: 'ded80CCD1B', label: '80CCD(1B) NPS (cap ₹50k)' },
  { key: 'ded80TTA', label: '80TTA / 80TTB interest' },
  { key: 'ded80GAndOther', label: '80G & other Chapter VI-A' },
  { key: 'ded80CCD2Employer', label: '80CCD(2) employer NPS (both regimes)' },
]

const taxesPaidFields: NumField[] = [
  { key: 'tdsTcs', label: 'TDS / TCS' },
  { key: 'advanceTax', label: 'Advance tax' },
  { key: 'selfAssessmentTax', label: 'Self-assessment tax' },
]

const statementRows: Array<{ label: string; pick: (result: TaxResult) => number; strong?: boolean }> = [
  { label: 'Gross total income', pick: (r) => r.grossTotalIncome },
  { label: 'Chapter VI-A deductions', pick: (r) => -r.chapterVIADeduction },
  { label: 'Total income', pick: (r) => r.totalIncome, strong: true },
  { label: 'Tax at slab rates', pick: (r) => r.slabTax },
  { label: 'Tax on special-rate gains', pick: (r) => r.specialTax },
  { label: 'Less: rebate u/s 87A', pick: (r) => -r.rebate87A },
  { label: 'Health & education cess', pick: (r) => r.cess },
  { label: 'Total tax liability', pick: (r) => r.totalTaxLiability, strong: true },
  { label: 'Less: taxes already paid', pick: (r) => -r.taxesPaid },
]

export function TaxComputationPanel({ member, onInputsChange }: TaxComputationPanelProps) {
  const [documents, setDocuments] = useState<StoredDocument[]>([])

  useEffect(() => {
    let cancelled = false
    listDocuments(member.id)
      .then((savedDocuments) => {
        if (!cancelled) setDocuments(savedDocuments)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [member])

  const seeded = useMemo(() => seedTaxInputs(documents), [documents])
  const inputs: TaxInputs = { ...emptyTaxInputs(), ...seeded, ...member.taxInputs }
  const comparison = compareRegimes(inputs)

  const setField = (key: NumKey, value: number) =>
    onInputsChange({ ...member.taxInputs, [key]: value })
  const setAge = (ageBand: AgeBand) => onInputsChange({ ...member.taxInputs, ageBand })

  const renderInputs = (fields: NumField[]) =>
    fields.map((field) => (
      <label className="tax-input" key={field.key}>
        <span>{field.label}</span>
        <input
          type="number"
          inputMode="numeric"
          value={String(inputs[field.key] ?? 0)}
          onChange={(event) => setField(field.key, Number(event.target.value) || 0)}
        />
      </label>
    ))

  const balanceLabel = (result: TaxResult) => {
    if (result.balance > 0) return `Payable ${inr(result.balance)}`
    if (result.balance < 0) return `Refund ${inr(-result.balance)}`
    return 'Nil'
  }

  const regimeHeader = (regime: Regime, result: TaxResult) => (
    <th className={comparison.recommended === regime ? 'recommended' : ''}>
      {regime === 'new' ? 'New regime' : 'Old regime'}
      {comparison.recommended === regime && <em> · lower</em>}
      <small>{inr(result.totalTaxLiability)}</small>
    </th>
  )

  return (
    <section className="tax-panel" aria-labelledby={`tax-${member.id}`}>
      <div className="tax-heading">
        <div>
          <span className="eyebrow">Offline estimate · AY 2026-27</span>
          <h3 id={`tax-${member.id}`}>
            <Calculator size={18} /> Tax computation
          </h3>
        </div>
        <label className="tax-age">
          Age band
          <select value={inputs.ageBand} onChange={(event) => setAge(event.target.value as AgeBand)}>
            <option value="below60">Below 60</option>
            <option value="senior">60 to 80</option>
            <option value="superSenior">80 and above</option>
          </select>
        </label>
      </div>

      <div className={`tax-recommendation ${comparison.recommended}`}>
        <Scale size={17} />
        <p>
          {comparison.saving > 0 ? (
            <>
              <strong>{comparison.recommended === 'new' ? 'New' : 'Old'} regime</strong> is lower by{' '}
              <strong>{inr(comparison.saving)}</strong> on these figures.
            </>
          ) : (
            <>Both regimes give the same tax on these figures.</>
          )}
        </p>
      </div>

      <div className="tax-statement">
        <table>
          <thead>
            <tr>
              <th>Particulars</th>
              {regimeHeader('old', comparison.old)}
              {regimeHeader('new', comparison.new)}
            </tr>
          </thead>
          <tbody>
            {statementRows.map((row) => (
              <tr key={row.label} className={row.strong ? 'strong' : ''}>
                <td>{row.label}</td>
                <td className={comparison.recommended === 'old' ? 'recommended' : ''}>
                  {inr(row.pick(comparison.old))}
                </td>
                <td className={comparison.recommended === 'new' ? 'recommended' : ''}>
                  {inr(row.pick(comparison.new))}
                </td>
              </tr>
            ))}
            <tr className="balance">
              <td>Refund / payable</td>
              <td className={comparison.recommended === 'old' ? 'recommended' : ''}>
                {balanceLabel(comparison.old)}
              </td>
              <td className={comparison.recommended === 'new' ? 'recommended' : ''}>
                {balanceLabel(comparison.new)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <details className="tax-editor" open>
        <summary>Income, capital gains, deductions &amp; taxes paid</summary>
        <p className="tax-hint">
          Income is seeded from your documents where available. Edit any value to override; capital
          gains and deductions are entered here. All figures stay encrypted on this device.
        </p>
        <div className="tax-group">
          <span className="eyebrow">Income</span>
          <div className="tax-grid">{renderInputs(incomeFields)}</div>
        </div>
        <div className="tax-group">
          <span className="eyebrow">Capital gains &amp; business (broker Tax P&amp;L)</span>
          <div className="tax-grid">{renderInputs(capitalGainsFields)}</div>
        </div>
        <div className="tax-group">
          <span className="eyebrow">Deductions (old regime, except 80CCD(2))</span>
          <div className="tax-grid">{renderInputs(deductionFields)}</div>
          <p className="tax-hint">
            80TTA is seeded from your savings-bank interest (capped at ₹10,000, old regime only).
            Seniors may instead claim 80TTB up to ₹50,000 including fixed-deposit interest — raise
            the field if eligible.
          </p>
        </div>
        <div className="tax-group">
          <span className="eyebrow">Taxes already paid</span>
          <div className="tax-grid">{renderInputs(taxesPaidFields)}</div>
        </div>
      </details>

      <p className="tax-disclaimer">
        <ShieldAlert size={14} /> Estimate only — surcharge and marginal-relief edge cases are
        simplified. Not tax advice. Confirm every figure and your regime choice in the official
        AY 2026-27 utility before filing.
      </p>
    </section>
  )
}
