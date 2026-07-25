import { useEffect, useMemo, useState } from 'react'
import { Calculator, Scale, ShieldAlert, Plus, Trash2, AlertTriangle } from 'lucide-react'
import type { Member } from '../domain/filing'
import type { FilingSection } from '../domain/filing'
import { listDocuments } from '../storage/vault'
import type { StoredDocument } from '../storage/vault'
import { compareRegimes, emptyTaxInputs, recommendItrForm } from '../tax/compute'
import type { AgeBand, HouseProperty, ItrForm, Regime, TaxInputs, TaxResult } from '../tax/compute'
import { seedTaxInputs } from '../tax/seed'

type TaxComputationPanelProps = {
  member: Member
  onInputsChange: (taxInputs: Partial<TaxInputs>) => void
  onMetaChange: (meta: Partial<Member>) => void
}

type NumKey = Exclude<keyof TaxInputs, 'ageBand' | 'houseProperties'>
type NumField = { key: NumKey; label: string }
type MemberMeta = Pick<Member, 'filingForm' | 'filingSection' | 'chosenRegime' | 'filedAt' | 'acknowledgementNo' | 'selfAssessmentChallan'>

const inr = (value: number) => {
  const rounded = Math.round(value) || 0 // normalise -0 → 0
  return `₹${rounded.toLocaleString('en-IN')}`
}

const incomeFields: NumField[] = [
  { key: 'grossSalary', label: 'Gross salary' },
  { key: 'exemptAllowances', label: 'Exempt allowances u/s 10 (old only)' },
  { key: 'professionalTax', label: 'Professional tax (old only)' },
  { key: 'housePropertyIncome', label: 'House property income / loss (manual)' },
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
  { key: 'fnoBusiness', label: 'F&O — specified business (slab)' },
]

const deductionFields: NumField[] = [
  { key: 'ded80C', label: '80C (cap ₹1.5L)' },
  { key: 'ded80D', label: '80D health insurance' },
  { key: 'ded80CCD1B', label: '80CCD(1B) NPS (cap ₹50k)' },
  { key: 'ded80CCD2Employer', label: '80CCD(2) employer NPS (both regimes)' },
  { key: 'ded80TTA', label: '80TTA / 80TTB interest' },
  { key: 'ded80EEA', label: '80EEA home-loan interest (cap ₹1.5L)' },
  { key: 'ded80E', label: '80E education-loan interest' },
  { key: 'ded80EEB', label: '80EEB EV loan (cap ₹1.5L)' },
  { key: 'ded80CCH', label: '80CCH (cap ₹1.5L)' },
  { key: 'ded80GAndOther', label: '80G / 80DD / 80DDB / 80U / 80GGC' },
]

const taxesPaidFields: NumField[] = [
  { key: 'tdsTcs', label: 'TDS / TCS credits' },
  { key: 'advanceTax', label: 'Advance tax' },
  { key: 'selfAssessmentTax', label: 'Self-assessment tax' },
]

const bfLossFields: NumField[] = [
  { key: 'bfSpecifiedBusinessLoss', label: 'F&O / specified business (sec 43(5))' },
  { key: 'bfSpeculativeBusinessLoss', label: 'Speculative business (intraday)' },
  { key: 'bfLtcgLoss', label: 'LTCG loss (sec 74)' },
  { key: 'bfHpLoss', label: 'House-property loss' },
]

function netHp(property: HouseProperty): number {
  if (property.type === 'selfOccupied') return -Math.min(Math.max(0, property.loanInterest), 200000)
  const nav = Math.max(0, property.grossRent - Math.max(0, property.municipalTax))
  return nav - Math.round(0.3 * nav) - Math.max(0, property.loanInterest)
}

export function TaxComputationPanel({ member, onInputsChange, onMetaChange }: TaxComputationPanelProps) {
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
  const rentReceived = useMemo(
    () =>
      documents
        .flatMap((document) => document.analysis?.fields ?? [])
        .find((field) => field.key === 'rentReceived')?.value ?? 0,
    [documents],
  )
  const inputs: TaxInputs = { ...emptyTaxInputs(), ...seeded, ...member.taxInputs }
  const comparison = compareRegimes(inputs)
  const recommendedForm = recommendItrForm(inputs)
  const scheduleActive = inputs.houseProperties.length > 0

  const setField = (key: NumKey, value: number) =>
    onInputsChange({ ...member.taxInputs, [key]: value })
  const setAge = (ageBand: AgeBand) => onInputsChange({ ...member.taxInputs, ageBand })
  const setMeta = (patch: Partial<MemberMeta>) => onMetaChange(patch)

  const setProperty = (index: number, patch: Partial<HouseProperty>) => {
    const next = inputs.houseProperties.map((property, i) => (i === index ? { ...property, ...patch } : property))
    onInputsChange({ ...member.taxInputs, houseProperties: next })
  }
  const addProperty = (preset?: HouseProperty) => {
    const next = [...inputs.houseProperties, preset ?? { type: 'letOut', grossRent: 0, municipalTax: 0, loanInterest: 0 }]
    onInputsChange({ ...member.taxInputs, houseProperties: next })
  }
  const removeProperty = (index: number) => {
    const next = inputs.houseProperties.filter((_, i) => i !== index)
    onInputsChange({ ...member.taxInputs, houseProperties: next })
  }

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

  const chosenForm: ItrForm = member.filingForm ?? recommendedForm
  const chosenRegime: Regime = member.chosenRegime ?? comparison.recommended

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

      <div className="filing-details">
        <div className="filing-meta-grid">
          <label className="tax-input">
            <span>ITR form</span>
            <select value={chosenForm} onChange={(event) => setMeta({ filingForm: event.target.value as ItrForm })}>
              <option value="ITR-1">ITR-1 (SAHAJ)</option>
              <option value="ITR-2">ITR-2</option>
              <option value="ITR-3">ITR-3 (business)</option>
            </select>
          </label>
          <label className="tax-input">
            <span>Filing section</span>
            <select
              value={member.filingSection ?? '139(1)'}
              onChange={(event) => setMeta({ filingSection: event.target.value as FilingSection })}
            >
              <option value="139(1)">139(1) — original</option>
              <option value="139(5)">139(5) — revised</option>
              <option value="139(3)">139(3) — belated</option>
            </select>
          </label>
          <label className="tax-input">
            <span>Tax regime</span>
            <select value={chosenRegime} onChange={(event) => setMeta({ chosenRegime: event.target.value as Regime })}>
              <option value="new">New (115BAC(1A))</option>
              <option value="old">Old (115BAC)</option>
            </select>
          </label>
          <label className="tax-input">
            <span>Self-assessment payment month</span>
            <select
              value={String(inputs.filingMonth ?? 7)}
              onChange={(event) => setField('filingMonth', Number(event.target.value))}
            >
              {[4, 5, 6, 7, 8, 9, 10, 11, 12].map((month) => (
                <option key={month} value={month}>
                  {new Date(2026, month - 1, 1).toLocaleString('en-IN', { month: 'long' })}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="tax-hint">
          Recommended form: <strong>{recommendedForm}</strong>
          {recommendedForm === 'ITR-3' && ' (business income or carry-forward losses require Schedule BP/CFL).'}
          {recommendedForm === 'ITR-2' && ' (capital gains).'}
          {recommendedForm === 'ITR-1' && ' (salary + up to two house properties + interest).'}
          {' '}You can override; confirm eligibility in the official utility.
        </p>
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

      {comparison.old.interest234BEstimate > 0 && (
        <div className="warning-banner" role="status">
          <AlertTriangle size={15} />
          <p>
            Interest u/s 234B may apply (~{inr(comparison.old.interest234BEstimate)} old / {inr(comparison.new.interest234BEstimate)} new
            estimate). Pay self-assessment tax before filing to minimise it; the official utility computes the exact amount.
          </p>
        </div>
      )}

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
            {([
              { label: 'Gross total income', pick: (r: TaxResult) => r.grossTotalIncome },
              { label: 'Brought-forward loss set-off', pick: (r: TaxResult) => -r.bfLossSetoff, hide: (r: TaxResult) => r.bfLossSetoff === 0 },
              { label: 'Chapter VI-A deductions', pick: (r: TaxResult) => -r.chapterVIADeduction },
              { label: 'Total income', pick: (r: TaxResult) => r.totalIncome, strong: true },
              { label: 'Tax at slab rates', pick: (r: TaxResult) => r.slabTax },
              { label: 'Tax on special-rate gains', pick: (r: TaxResult) => r.specialTax, hide: (r: TaxResult) => r.specialTax === 0 },
              { label: 'Less: rebate u/s 87A', pick: (r: TaxResult) => -r.rebate87A, hide: (r: TaxResult) => r.rebate87A === 0 },
              { label: 'Surcharge', pick: (r: TaxResult) => r.surcharge, hide: (r: TaxResult) => r.surcharge === 0 },
              { label: 'Health & education cess', pick: (r: TaxResult) => r.cess },
              { label: 'Total tax liability', pick: (r: TaxResult) => r.totalTaxLiability, strong: true },
              { label: 'Less: taxes already paid', pick: (r: TaxResult) => -r.taxesPaid },
            ] as Array<{ label: string; pick: (r: TaxResult) => number; strong?: boolean; hide?: (r: TaxResult) => boolean }>)
              .filter((row) => (row.hide ? !(row.hide(comparison.old) && row.hide(comparison.new)) : true))
              .map((row) => (
                <tr key={row.label} className={row.strong ? 'strong' : ''}>
                  <td>{row.label}</td>
                  <td className={comparison.recommended === 'old' ? 'recommended' : ''}>{inr(row.pick(comparison.old))}</td>
                  <td className={comparison.recommended === 'new' ? 'recommended' : ''}>{inr(row.pick(comparison.new))}</td>
                </tr>
              ))}
            <tr className="balance">
              <td>Refund / payable</td>
              <td className={comparison.recommended === 'old' ? 'recommended' : ''}>{balanceLabel(comparison.old)}</td>
              <td className={comparison.recommended === 'new' ? 'recommended' : ''}>{balanceLabel(comparison.new)}</td>
            </tr>
            {inputs.exemptIncome > 0 && (
              <tr className="memo">
                <td>Exempt income (Schedule EI, memo)</td>
                <td>{inr(inputs.exemptIncome)}</td>
                <td>{inr(inputs.exemptIncome)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <details className="tax-editor" open>
        <summary>House property, income, capital gains, losses &amp; taxes paid</summary>
        <p className="tax-hint">
          Income is seeded from your documents where available. Edit any value to override. All figures stay encrypted on
          this device.
        </p>

        <div className="tax-group">
          <div className="group-header">
            <span className="eyebrow">House property (schedule)</span>
            {rentReceived > 0 && !scheduleActive && (
              <button type="button" className="tax-property-add" onClick={() => addProperty({ type: 'letOut', grossRent: rentReceived, municipalTax: 0, loanInterest: 0 })}>
                <Plus size={13} /> Use AIS rent {inr(rentReceived)}
              </button>
            )}
            {scheduleActive && inputs.houseProperties.length < 2 && (
              <button type="button" className="tax-property-add" onClick={() => addProperty()}>
                <Plus size={13} /> Add property
              </button>
            )}
          </div>
          {scheduleActive ? (
            <div className="tax-properties">
              {inputs.houseProperties.map((property, index) => (
                <div className="tax-property" key={index}>
                  <label className="tax-input tax-property-type">
                    <span>Type</span>
                    <select
                      value={property.type}
                      onChange={(event) => setProperty(index, { type: event.target.value as HouseProperty['type'] })}
                    >
                      <option value="selfOccupied">Self-occupied</option>
                      <option value="letOut">Let-out</option>
                      <option value="deemed">Deemed let-out</option>
                    </select>
                  </label>
                  <label className="tax-input">
                    <span>Gross rent / annual value</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={String(property.grossRent)}
                      onChange={(event) => setProperty(index, { grossRent: Number(event.target.value) || 0 })}
                      disabled={property.type === 'selfOccupied'}
                    />
                  </label>
                  <label className="tax-input">
                    <span>Municipal taxes paid</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={String(property.municipalTax)}
                      onChange={(event) => setProperty(index, { municipalTax: Number(event.target.value) || 0 })}
                      disabled={property.type === 'selfOccupied'}
                    />
                  </label>
                  <label className="tax-input">
                    <span>Home-loan interest u/s 24(b)</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={String(property.loanInterest)}
                      onChange={(event) => setProperty(index, { loanInterest: Number(event.target.value) || 0 })}
                    />
                  </label>
                  <span className="tax-property-net">Net {inr(netHp(property))}</span>
                  <button type="button" className="danger-icon tax-property-remove" onClick={() => removeProperty(index)} aria-label="Remove property">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <p className="tax-hint">
                The schedule drives house-property income; the manual field below is ignored while a property is listed. ITR-1
                allows up to two house properties for AY 2026-27 (G.S.R. 226(E)).
              </p>
            </div>
          ) : (
            <p className="tax-hint">
              No house-property schedule entered. Add a property above, or use the manual “House property income / loss” field
              under Income (seeded from Form 16 where available).
            </p>
          )}
        </div>

        <div className="tax-group">
          <span className="eyebrow">Income</span>
          <div className="tax-grid">{renderInputs(incomeFields)}</div>
        </div>
        <div className="tax-group">
          <span className="eyebrow">Capital gains &amp; business (broker Tax P&amp;L)</span>
          <div className="tax-grid">{renderInputs(capitalGainsFields)}</div>
        </div>
        <div className="tax-group">
          <span className="eyebrow">Brought-forward (carry-forward) losses</span>
          <div className="tax-grid">{renderInputs(bfLossFields)}</div>
          {(comparison.old.bfLossSetoff > 0 || comparison.old.bfLossCarriedForward > 0) && (
            <div className="bf-loss-summary">
              <span>
                Set off this year: <strong>{inr(comparison.old.bfLossSetoff)}</strong> (old) · {inr(comparison.new.bfLossSetoff)} (new)
              </span>
              <span>
                Carried forward: <strong>{inr(comparison.old.bfLossCarriedForward)}</strong> (old) · {inr(comparison.new.bfLossCarriedForward)} (new)
              </span>
            </div>
          )}
          <p className="tax-hint">
            Brought-forward losses from a prior-year ITR’s Schedule CFL are seeded automatically when you import the prior
            ITR JSON. ITR-3 is required to keep carry-forward alive (Schedule BP/CFL).
          </p>
        </div>
        <div className="tax-group">
          <span className="eyebrow">Deductions (old regime, except 80CCD(2))</span>
          <div className="tax-grid">{renderInputs(deductionFields)}</div>
          <p className="tax-hint">
            80TTA is seeded from savings-bank interest and capped at ₹10,000 (₹50,000 for 80TTB if 60+), reduced by any
            interest absorbed by a brought-forward loss. 80DD/80DDB/80U/80G/80GGC go in the combined field — enter the
            eligible amount.
          </p>
        </div>
        <div className="tax-group">
          <span className="eyebrow">Exempt income (Schedule EI)</span>
          <div className="tax-grid">
            <label className="tax-input">
              <span>Exempt income (e.g. PPF u/s 10(15))</span>
              <input
                type="number"
                inputMode="numeric"
                value={String(inputs.exemptIncome ?? 0)}
                onChange={(event) => setField('exemptIncome', Number(event.target.value) || 0)}
              />
            </label>
          </div>
          <p className="tax-hint">Declared in Schedule EI for AIS-consistency; it does not enter gross total income or tax.</p>
        </div>
        <div className="tax-group">
          <span className="eyebrow">Taxes already paid</span>
          <div className="tax-grid">{renderInputs(taxesPaidFields)}</div>
          <p className="tax-hint">
            TDS / TCS is seeded from Form 16, AIS and Form 26AS (salary TDS + TCS). Watch the document warnings for any
            AIS Part B3 prior-year challan that must not be claimed.
          </p>
        </div>

        <div className="tax-group">
          <span className="eyebrow">Filing outcome (optional)</span>
          <div className="tax-grid">
            <label className="tax-input">
              <span>Date filed</span>
              <input
                type="date"
                value={member.filedAt ?? ''}
                onChange={(event) => setMeta({ filedAt: event.target.value })}
              />
            </label>
            <label className="tax-input">
              <span>Acknowledgement no.</span>
              <input
                type="text"
                value={member.acknowledgementNo ?? ''}
                onChange={(event) => setMeta({ acknowledgementNo: event.target.value })}
                maxLength={40}
              />
            </label>
            <label className="tax-input">
              <span>Self-assessment challan ref</span>
              <input
                type="text"
                value={member.selfAssessmentChallan ?? ''}
                onChange={(event) => setMeta({ selfAssessmentChallan: event.target.value })}
                maxLength={40}
              />
            </label>
          </div>
        </div>
      </details>

      <p className="tax-disclaimer">
        <ShieldAlert size={14} /> Estimate only — surcharge (with marginal relief) and 234B interest are modelled but
        simplified; 234C is not. Not tax advice. Confirm every figure and your regime/form choice in the official AY
        2026-27 utility before filing.
      </p>
    </section>
  )
}