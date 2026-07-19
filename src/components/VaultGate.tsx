import { useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { FileKey2, LockKeyhole, Upload } from 'lucide-react'

type VaultGateProps = {
  mode: 'checking' | 'setup' | 'locked'
  busy: boolean
  error: string
  onSetup: (passphrase: string) => Promise<void>
  onUnlock: (passphrase: string) => Promise<void>
  onRestore: (file: File, passphrase: string) => Promise<void>
}

export function VaultGate({ mode, busy, error, onSetup, onUnlock, onRestore }: VaultGateProps) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [localError, setLocalError] = useState('')
  const restoreInput = useRef<HTMLInputElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLocalError('')
    if (mode === 'setup' && passphrase !== confirmation) {
      setLocalError('The passphrases do not match.')
      return
    }
    await (mode === 'setup' ? onSetup(passphrase) : onUnlock(passphrase))
    setPassphrase('')
    setConfirmation('')
  }

  const restore = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (passphrase.length < 12) {
      setLocalError('Enter the backup passphrase before restoring.')
      return
    }
    if (!window.confirm('Restore this backup and replace every record in this browser vault?')) return
    setLocalError('')
    await onRestore(file, passphrase)
  }

  if (mode === 'checking') {
    return (
      <main className="vault-gate">
        <LockKeyhole size={28} />
        <p>Opening the private browser vault…</p>
      </main>
    )
  }

  const setup = mode === 'setup'
  return (
    <main className="vault-gate">
      <section className="vault-gate-panel" aria-labelledby="vault-gate-title">
        <div className="vault-gate-mark" aria-hidden="true"><FileKey2 size={26} /></div>
        <span className="eyebrow">AY 2026-27 · private browser vault</span>
        <h1 id="vault-gate-title">{setup ? 'Encrypt this workspace' : 'Unlock your workspace'}</h1>
        <p>
          {setup
            ? 'Create a passphrase to encrypt aliases, documents, extracted evidence, and conversations before they are stored in this browser.'
            : 'Enter the vault passphrase. It is used only in this browser and is never stored or sent anywhere.'}
        </p>
        <form onSubmit={submit}>
          <label htmlFor="vault-passphrase">Vault passphrase</label>
          <input
            id="vault-passphrase"
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            minLength={12}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoFocus
            required
          />
          {setup && (
            <>
              <label htmlFor="vault-confirmation">Confirm passphrase</label>
              <input
                id="vault-confirmation"
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                required
              />
            </>
          )}
          <span className="vault-passphrase-note">
            Minimum 12 characters. There is no password reset; keep it in a password manager.
          </span>
          {(localError || error) && <p className="vault-gate-error" role="alert">{localError || error}</p>}
          <button className="primary-button" type="submit" disabled={busy || passphrase.length < 12}>
            <LockKeyhole size={17} /> {busy ? 'Working…' : setup ? 'Encrypt workspace' : 'Unlock vault'}
          </button>
        </form>
        <div className="vault-restore">
          <span>Moving from another browser?</span>
          <button
            type="button"
            onClick={() => restoreInput.current?.click()}
            disabled={busy || passphrase.length < 12}
          >
            <Upload size={15} /> Restore encrypted backup
          </button>
          <input
            ref={restoreInput}
            className="visually-hidden"
            type="file"
            accept="application/json,.itrvault"
            aria-label="Choose encrypted vault backup to restore"
            onChange={restore}
          />
        </div>
      </section>
    </main>
  )
}