import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Download,
  ExternalLink,
  FileCheck2,
  FolderLock,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { DocumentVaultPanel } from './components/DocumentVaultPanel'
import { AssistantPanel } from './components/AssistantPanel'
import { TaxComputationPanel } from './components/TaxComputationPanel'
import { VaultGate } from './components/VaultGate'
import {
  documentItems,
  emptyDocuments,
  emptyStages,
  stageItems,
} from './domain/filing'
import type { DocumentKey, Member } from './domain/filing'
import {
  deleteMemberRecords,
  enableVaultEncryption,
  exportEncryptedBackup,
  getVaultState,
  loadMembers,
  lockVault,
  restoreEncryptedBackup,
  saveMembers,
  unlockVault,
} from './storage/vault'
import './App.css'

function memberProgress(member: Member) {
  const complete = stageItems.filter(({ key }) => member.stages[key]).length
  return Math.round((complete / stageItems.length) * 100)
}

function App() {
  const [members, setMembers] = useState<Member[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [vaultReady, setVaultReady] = useState(false)
  const [vaultView, setVaultView] = useState<'checking' | 'setup' | 'locked' | 'ready'>('checking')
  const [vaultBusy, setVaultBusy] = useState(false)
  const [vaultError, setVaultError] = useState('')
  const skipNextSave = useRef(true)
  const [showAddMember, setShowAddMember] = useState(false)
  const [alias, setAlias] = useState('')
  const [salaryOrPension, setSalaryOrPension] = useState(true)
  const [capitalGains, setCapitalGains] = useState(false)
  const [importError, setImportError] = useState('')

  const selectedMember = members.find(({ id }) => id === selectedId) ?? null
  const verifiedCount = members.filter(({ stages }) => stages.eVerified).length
  const inProgressCount = members.filter(
    (member) => memberProgress(member) > 0 && !member.stages.eVerified,
  ).length

  useEffect(() => {
    let cancelled = false
    getVaultState()
      .then((state) => {
        if (!cancelled) setVaultView(state === 'setup' ? 'setup' : 'locked')
      })
      .catch(() => {
        if (!cancelled) setVaultError('The private browser vault could not be opened.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!vaultReady || vaultView !== 'ready') return
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    saveMembers(members).catch(() => {
      setImportError('Changes could not be saved to the private browser vault.')
    })
  }, [members, vaultReady, vaultView])

  useEffect(() => {
    if (vaultView !== 'ready') return
    let timeout = window.setTimeout(() => undefined, 0)
    const lockAfterIdle = () => {
      lockVault()
      setVaultReady(false)
      setMembers([])
      setSelectedId(null)
      setVaultView('locked')
    }
    const reset = () => {
      window.clearTimeout(timeout)
      timeout = window.setTimeout(lockAfterIdle, 15 * 60 * 1000)
    }
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'scroll']
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }))
    reset()
    return () => {
      window.clearTimeout(timeout)
      events.forEach((event) => window.removeEventListener(event, reset))
    }
  }, [vaultView])

  useEffect(() => {
    const lockAndClear = () => {
      lockVault()
      setVaultReady(false)
      setMembers([])
      setSelectedId(null)
      setVaultView('locked')
    }
    const lockWhenHidden = () => {
      if (document.visibilityState === 'hidden') lockAndClear()
    }
    const lockAfterCacheRestore = (event: PageTransitionEvent) => {
      if (event.persisted) lockAndClear()
    }
    window.addEventListener('pagehide', lockAndClear)
    window.addEventListener('pageshow', lockAfterCacheRestore)
    document.addEventListener('visibilitychange', lockWhenHidden)
    return () => {
      window.removeEventListener('pagehide', lockAndClear)
      window.removeEventListener('pageshow', lockAfterCacheRestore)
      document.removeEventListener('visibilitychange', lockWhenHidden)
    }
  }, [])

  const openWorkspace = async () => {
    const savedMembers = await loadMembers()
    skipNextSave.current = true
    setMembers(savedMembers)
    setSelectedId(savedMembers[0]?.id ?? null)
    setVaultReady(true)
    setVaultView('ready')
    setVaultError('')
  }

  const setupVault = async (passphrase: string) => {
    setVaultBusy(true)
    setVaultError('')
    try {
      await enableVaultEncryption(passphrase)
      await openWorkspace()
    } catch (error) {
      setVaultError(error instanceof Error ? error.message : 'The vault could not be encrypted.')
    } finally {
      setVaultBusy(false)
    }
  }

  const unlockWorkspace = async (passphrase: string) => {
    setVaultBusy(true)
    setVaultError('')
    try {
      await unlockVault(passphrase)
      await openWorkspace()
    } catch (error) {
      setVaultError(error instanceof Error ? error.message : 'The vault could not be unlocked.')
    } finally {
      setVaultBusy(false)
    }
  }

  const lockWorkspace = () => {
    lockVault(true)
    setVaultReady(false)
    setMembers([])
    setSelectedId(null)
    setVaultView('locked')
  }

  useEffect(() => {
    const lockAfterInvalidation = () => {
      lockVault()
      setVaultReady(false)
      setMembers([])
      setSelectedId(null)
      setVaultView('locked')
    }
    window.addEventListener('family-itr-vault-invalidated', lockAfterInvalidation)
    return () => window.removeEventListener('family-itr-vault-invalidated', lockAfterInvalidation)
  }, [])

  const updateMember = (id: string, update: (member: Member) => Member) => {
    setMembers((current) =>
      current.map((member) => (member.id === id ? update(member) : member)),
    )
  }

  const addMember = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleanAlias = alias.trim()
    if (!cleanAlias) return

    const member: Member = {
      id: crypto.randomUUID(),
      alias: cleanAlias,
      salaryOrPension,
      capitalGains,
      documents: emptyDocuments(),
      stages: emptyStages(),
    }
    setMembers((current) => [...current, member])
    setSelectedId(member.id)
    setAlias('')
    setSalaryOrPension(true)
    setCapitalGains(false)
    setShowAddMember(false)
  }

  const removeMember = async (member: Member) => {
    if (!window.confirm(`Remove ${member.alias} and all of their checklist data?`)) return
    const remaining = members.filter(({ id }) => id !== member.id)
    try {
      await deleteMemberRecords(remaining, member.id)
      skipNextSave.current = true
      setMembers(remaining)
      if (selectedId === member.id) setSelectedId(remaining[0]?.id ?? null)
    } catch {
      lockWorkspace()
      setVaultError('The member could not be removed safely. Unlock the vault and try again.')
    }
  }

  const markDocumentStored = (memberId: string, kind: DocumentKey) => {
    updateMember(memberId, (member) => ({
      ...member,
      documents: { ...member.documents, [kind]: true },
    }))
  }

  const markLastDocumentRemoved = (memberId: string, kind: DocumentKey) => {
    updateMember(memberId, (member) => ({
      ...member,
      documents: { ...member.documents, [kind]: false },
    }))
  }

  const exportBackup = async () => {
    try {
      const blob = await exportEncryptedBackup()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `family-itr-vault-${new Date().toISOString().slice(0, 10)}.itrvault`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      setImportError('The encrypted vault backup could not be created.')
    }
  }

  const restoreFromGate = async (file: File, passphrase: string) => {
    setVaultBusy(true)
    setVaultError('')
    try {
      await restoreEncryptedBackup(file, passphrase)
      setVaultView('locked')
    } catch (error) {
      setVaultError(error instanceof Error ? error.message : 'The backup could not be restored.')
    } finally {
      setVaultBusy(false)
    }
  }

  if (vaultView !== 'ready') {
    return (
      <VaultGate
        mode={vaultView}
        busy={vaultBusy}
        error={vaultError}
        onSetup={setupVault}
        onUnlock={unlockWorkspace}
        onRestore={restoreFromGate}
      />
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <FileCheck2 size={20} />
        </div>
        <div className="brand-copy">
          <strong>Family ITR Organizer</strong>
          <span>AY 2026-27</span>
        </div>
        <div className="topbar-actions">
          <button className="icon-action" type="button" onClick={exportBackup} title="Export backup">
            <Download size={18} />
            <span>Export</span>
          </button>
          <button className="icon-action" type="button" onClick={lockWorkspace} title="Lock vault">
            <LockKeyhole size={18} />
            <span>Lock</span>
          </button>
        </div>
      </header>

      {importError && (
        <div className="toast error-toast" role="alert">
          <AlertTriangle size={18} />
          <span>{importError}</span>
          <button type="button" onClick={() => setImportError('')} aria-label="Dismiss message">
            <X size={17} />
          </button>
        </div>
      )}

      <main>
        <section className="overview-band">
          <div className="overview-heading">
            <span className="eyebrow">Filing year 2025-26</span>
            <h1>One clear view of every return.</h1>
            <p>Track preparation locally. File and e-verify only on the official portal.</p>
          </div>
          <div className="summary-grid" aria-label="Family filing summary">
            <div className="summary-item">
              <Users size={19} />
              <strong>{members.length}</strong>
              <span>People</span>
            </div>
            <div className="summary-item">
              <FolderLock size={19} />
              <strong>{inProgressCount}</strong>
              <span>In progress</span>
            </div>
            <div className="summary-item verified-summary">
              <ShieldCheck size={19} />
              <strong>{verifiedCount}</strong>
              <span>E-verified</span>
            </div>
          </div>
        </section>

        <div className="workspace">
          <aside className="member-sidebar">
            <div className="section-heading sidebar-heading">
              <div>
                <span className="eyebrow">Family</span>
                <h2>Returns</h2>
              </div>
              <button
                className="square-button"
                type="button"
                onClick={() => setShowAddMember(true)}
                aria-label="Add family member"
                title="Add family member"
              >
                <Plus size={19} />
              </button>
            </div>

            {members.length === 0 ? (
              <div className="sidebar-empty">
                <Users size={23} />
                <p>Add a neutral alias to begin.</p>
              </div>
            ) : (
              <nav className="member-list" aria-label="Family members">
                {members.map((member) => {
                  const progress = memberProgress(member)
                  return (
                    <button
                      className={`member-row ${member.id === selectedId ? 'active' : ''}`}
                      type="button"
                      key={member.id}
                      onClick={() => setSelectedId(member.id)}
                    >
                      <span className="avatar" aria-hidden="true">
                        {member.alias.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="member-row-copy">
                        <strong>{member.alias}</strong>
                        <span>{member.filingForm ?? (member.capitalGains ? 'Review for ITR-2' : 'Likely ITR-1')}</span>
                      </span>
                      <span className="row-progress">{progress}%</span>
                      <ChevronRight size={16} />
                    </button>
                  )
                })}
              </nav>
            )}

            <div className="privacy-note">
              <ShieldCheck size={18} />
              <p>
                Stored in this browser only. Never enter PAN, Aadhaar, bank details,
                passwords or OTPs.
              </p>
            </div>
          </aside>

          <section className="detail-panel">
            {!selectedMember ? (
              <div className="empty-state">
                <div className="empty-icon"><FileCheck2 size={30} /></div>
                <span className="eyebrow">No returns yet</span>
                <h2>Start with the simplest family member.</h2>
                <p>Use initials or a neutral label. This organizer never needs tax identifiers.</p>
                <button className="primary-button" type="button" onClick={() => setShowAddMember(true)}>
                  <Plus size={18} /> Add person
                </button>
              </div>
            ) : (
              <>
                <div className="detail-header">
                  <div>
                    <span className="eyebrow">Return workspace</span>
                    <h2>{selectedMember.alias}</h2>
                    <div className="profile-tags">
                      {selectedMember.salaryOrPension && <span>Salary / pension</span>}
                      {selectedMember.capitalGains && <span>Indian capital gains</span>}
                    </div>
                  </div>
                  <div className="detail-actions">
                    <div className="progress-ring" style={{ '--progress': `${memberProgress(selectedMember) * 3.6}deg` } as React.CSSProperties}>
                      <span>{memberProgress(selectedMember)}%</span>
                    </div>
                    <button
                      className="danger-icon"
                      type="button"
                      onClick={() => removeMember(selectedMember)}
                      aria-label={`Remove ${selectedMember.alias}`}
                      title="Remove person"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>

                <div className={`form-guidance ${selectedMember.filingForm === 'ITR-3' || selectedMember.capitalGains ? 'warning' : ''}`}>
                  {selectedMember.filingForm === 'ITR-3' || selectedMember.capitalGains ? (
                    <AlertTriangle size={20} />
                  ) : (
                    <CheckCircle2 size={20} />
                  )}
                  <div>
                    <strong>
                      {selectedMember.filingForm ??
                        (selectedMember.capitalGains ? 'Review for ITR-2' : 'Likely ITR-1')}
                    </strong>
                    <p>
                      {selectedMember.filingForm === 'ITR-3'
                        ? 'Business income or carry-forward losses require ITR-3 (Schedule BP/CFL). Confirm in the official utility.'
                        : selectedMember.filingForm === 'ITR-2' || selectedMember.capitalGains
                          ? 'Capital gains usually require ITR-2. Check the narrow AY 2026-27 ITR-1 listed-equity LTCG exception in the official utility.'
                          : 'Suitable only if every current ITR-1 eligibility condition is met. Confirm in the official utility.'}
                    </p>
                  </div>
                </div>

                <DocumentVaultPanel
                  memberId={selectedMember.id}
                  onDocumentStored={(kind) => markDocumentStored(selectedMember.id, kind)}
                  onLastDocumentRemoved={(kind) => markLastDocumentRemoved(selectedMember.id, kind)}
                />

                <TaxComputationPanel
                  key={`tax-${selectedMember.id}`}
                  member={selectedMember}
                  onInputsChange={(taxInputs) =>
                    updateMember(selectedMember.id, (member) => ({ ...member, taxInputs }))
                  }
                  onMetaChange={(meta) =>
                    updateMember(selectedMember.id, (member) => ({ ...member, ...meta }))
                  }
                />

                <AssistantPanel key={`assistant-${selectedMember.id}`} member={selectedMember} />

                <div className="detail-columns">
                  <section className="checklist-section">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">Evidence</span>
                        <h3>Source checklist</h3>
                      </div>
                    </div>
                    <div className="check-list">
                      {documentItems
                        .filter((item) => !item.capitalGainsOnly || selectedMember.capitalGains)
                        .map((item) => (
                          <label className="check-row compact" key={item.key}>
                            <input
                              type="checkbox"
                              checked={selectedMember.documents[item.key]}
                              onChange={(event) =>
                                updateMember(selectedMember.id, (member) => ({
                                  ...member,
                                  documents: {
                                    ...member.documents,
                                    [item.key]: event.target.checked,
                                  },
                                }))
                              }
                            />
                            <span className="custom-check"><Check size={14} /></span>
                            <span>{item.label}</span>
                          </label>
                        ))}
                    </div>
                    <p className="section-footnote">Checklist items are marked automatically when matching files are stored in the device vault.</p>
                  </section>

                  <section className="checklist-section filing-section">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">Workflow</span>
                        <h3>Filing progress</h3>
                      </div>
                    </div>
                    <div className="stage-list">
                      {stageItems.map((item, index) => (
                        <label className="stage-row" key={item.key}>
                          <input
                            type="checkbox"
                            checked={selectedMember.stages[item.key]}
                            onChange={(event) =>
                              updateMember(selectedMember.id, (member) => ({
                                ...member,
                                stages: { ...member.stages, [item.key]: event.target.checked },
                              }))
                            }
                          />
                          <span className="stage-marker">
                            {selectedMember.stages[item.key] ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                          </span>
                          <span className="stage-copy">
                            <strong>{item.label}</strong>
                            <span>{item.detail}</span>
                          </span>
                          <span className="stage-number">{String(index + 1).padStart(2, '0')}</span>
                        </label>
                      ))}
                    </div>
                  </section>
                </div>

                <div className="official-actions">
                  <div>
                    <strong>Ready for the official tools?</strong>
                    <span>Open links in a new tab and keep this checklist beside you.</span>
                  </div>
                  <a href="https://www.incometax.gov.in/iec/foportal/downloads/income-tax-returns" target="_blank" rel="noreferrer">
                    Offline utility <ExternalLink size={15} />
                  </a>
                  <a href="https://www.incometax.gov.in/iec/foportal/" target="_blank" rel="noreferrer">
                    E-Filing portal <ExternalLink size={15} />
                  </a>
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      {showAddMember && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowAddMember(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-person-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setShowAddMember(false)} aria-label="Close">
              <X size={19} />
            </button>
            <span className="eyebrow">New return</span>
            <h2 id="add-person-title">Add a family member</h2>
            <p className="modal-intro">Use initials or a neutral alias, never a legal name or tax identifier.</p>
            <form onSubmit={addMember}>
              <label className="field-label" htmlFor="alias">Neutral alias</label>
              <input
                id="alias"
                className="text-input"
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
                placeholder="Example: P1 or Parent A"
                maxLength={24}
                autoFocus
              />
              <fieldset>
                <legend>Income profile</legend>
                <label className="profile-option">
                  <input type="checkbox" checked={salaryOrPension} onChange={(event) => setSalaryOrPension(event.target.checked)} />
                  <span className="custom-check"><Check size={14} /></span>
                  <span><strong>Salary or pension</strong><small>Includes bank interest</small></span>
                </label>
                <label className="profile-option">
                  <input type="checkbox" checked={capitalGains} onChange={(event) => setCapitalGains(event.target.checked)} />
                  <span className="custom-check"><Check size={14} /></span>
                  <span><strong>Indian capital gains</strong><small>Shares or mutual funds</small></span>
                </label>
              </fieldset>
              <div className="modal-safety"><ShieldCheck size={17} /> Checklist state stays in this browser.</div>
              <button className="primary-button full-button" type="submit" disabled={!alias.trim()}>
                Add to organizer <Plus size={18} />
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
