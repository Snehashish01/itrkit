# Family ITR Workspace

A privacy-first browser workspace for coordinating multiple Indian individual income-tax returns for AY 2026-27. It combines a source-document vault, local coordinate-aware text extraction, content-based document classification, structured field extraction with cross-document reconciliation, an offline old-vs-new tax-regime estimate, filing checklists, and an evidence-aware conversation panel.

The app does not submit or e-verify returns. Return-form guidance, extracted amounts, and the tax estimate are preparation aids — not tax advice and not final filing values (the estimate models surcharge with marginal relief; 234C and a few edge cases remain simplified). Confirm the return in the current official Income Tax Department utility.

> **New here?** Follow the step-by-step [User Guide](USER_GUIDE.md) to set up your vault, add family members, import documents, and track filing progress. This README focuses on the privacy model, architecture, and operations.

## Implemented Features

- Multiple taxpayer workspaces using neutral aliases.
- Passphrase-locked AES-256-GCM encryption for checklists, documents, extracted text, fact candidates, and conversations in IndexedDB.
- PBKDF2-SHA-256 key derivation with a random 128-bit salt and 600,000 iterations; the non-extractable key exists only in memory while unlocked.
- AAD-bound record identity, ciphertext fingerprints, and an encrypted revisioned manifest detect record deletion, reassignment, swapping, and modification before unlock.
- Encrypted v2 full-vault export and authenticated, bounded restore, including documents and conversations.
- Local PDF text extraction with PDF.js; CSV and JSON text are also read locally.
- Content-first document classification by document signatures (AIS, TIS, Form 26AS, Form 16, CPC/ITR computation / prior-ITR JSON), with the Form 16 Part B computation fully parsed (gross salary, exemptions u/s 10, standard deduction, professional tax, house-property income/loss, gross total income, 80C, employer NPS, total income). AIS also yields **TCS** (Part B1), **rent** (Part B7), and **deterministic cautions** for Part B3 tax payments that belong to a prior assessment year; a prior-year ITR JSON seeds **carry-forward losses** from Schedule CFL.
- Structured field extraction with cross-document reconciliation that flags matches and mismatches for the same figure across AIS, TIS, Form 26AS, and Form 16.
- Conservative amount candidates linked to the source document and page, plus per-document caution banners (prior-year challan trap, 26AS overbooked status).
- An offline, deterministic old-vs-new regime tax estimate for AY 2026-27 — income, **TDS + TCS** credits, and **carry-forward losses** auto-seed from your documents; a **house-property schedule** (self-occupied / let-out / deemed, up to two for ITR-1 under G.S.R. 226(E)), deductions (incl. 80TTA auto-seeded and capped by surviving interest, plus 80EEA/80E/80EEB/80CCH), **exempt income (Schedule EI)**, capital gains, and a **filing month** are editable; shows tax payable or refund, **surcharge with marginal relief**, a rough **234B** estimate, brought-forward loss set-off and closing carry-forward, and the lower-tax regime. An **ITR-form recommendation** (ITR-1/2/3) and storable filing details (form, section, regime, filing outcome) accompany the estimate.
- A deterministic local assistant for evidence summaries, missing sources, ITR-form triage (incl. carry-forward/ITR-3 guidance), and next steps.
- An optional OpenAI-compatible BYO API mode with a configurable endpoint and model.
- Browser persistence status, local usage visibility, per-document deletion, and member-level cleanup.
- One-time migration from the previous `family-itr-organizer-v1` localStorage format.
- Manual lock, lock after 15 minutes of inactivity, lock when the page is hidden, BFCache-safe restoration, and key removal on page exit.

## Privacy Boundary

- Vercel serves static application files only. There are no server functions and no tax database.
- Files, extracted text, checklists, and local conversations remain encrypted in the current browser profile.
- The passphrase is never stored. There is no reset or recovery mechanism; losing it makes the vault and its backups unreadable.
- Opaque record IDs, member-routing tokens, record counts, and ciphertext sizes remain visible to the browser profile while locked; names, document metadata/content, facts, and message text remain encrypted.
- The authenticated manifest detects partial rollback, deletion, reassignment, swapping, and modification. A fully consistent replay of an entire older browser snapshot cannot be detected without an external signed freshness service or platform monotonic counter; this app is not a tamper-proof audit ledger.
- Encryption protects stored data and exported backups, but not an unlocked app against a compromised browser, malicious extension, operating-system malware, screen capture, or a future compromised application deployment. Use a private, patched device and browser profile.
- Browser storage is quota-managed and device-specific. Request persistent storage in the app and retain an independent encrypted backup of original records.
- BYO API mode sends the typed question directly from the browser to the configured provider. Vercel does not proxy the request.
- Extracted evidence is excluded from remote requests by default. Enabling the evidence toggle sends only candidate type, label, value, and page; source quotes are never sent.
- Remote requests never replay prior conversation history. Key-bearing custom origins require explicit trust, and changing the endpoint clears the in-memory key and trust decision.
- Questions are limited to 4,000 characters; provider requests time out after 60 seconds and responses are streamed with a 50 KB cap.
- Common PAN, TAN, Aadhaar, and email patterns are redacted from extracted source quotes before local display.
- API endpoint, model, and key are held in React memory only. They are not written to IndexedDB or localStorage and disappear on reload.
- The remote provider may log or retain requests under its own terms. Use local mode for evidence that must not leave the device.
- Never enter portal passwords, OTPs, Aadhaar, or other authentication secrets. Use neutral aliases rather than legal names.

## Supported Imports

PDF, JSON, CSV, XLSX, XLS, JPG, JPEG, and PNG files up to 25 MB can be stored. Text extraction currently supports selectable-text PDFs, JSON, and CSV. Images and spreadsheets are stored locally for manual review; OCR and spreadsheet parsing are not yet implemented.

Document classification is **content-first** — it reads document signatures from the text, and the filename is only a fallback — but the result should still be reviewed. Extracted amounts are structured fields, reconciled across documents where the same figure appears in more than one statement; they remain preparation aids and must be verified against the original source. The tax estimate is deterministic and offline; surcharge (with marginal relief) and 234B are modelled, while 234C and a few edge cases remain simplified. PDF analysis is limited to 250 pages, two million extracted characters, and 30 seconds; larger or pathological documents are rejected.

## Using The App

See the [User Guide](USER_GUIDE.md) for the full walkthrough. In short:

1. Create an encrypted vault with a passphrase of at least 12 characters (there is no recovery — save it in a password manager).
2. Add each family member with a neutral alias and income profile.
3. Import source documents into the per-person device vault; review the content-based classification and the extracted, reconciled values.
4. Review the offline old-vs-new **tax regime** estimate — income auto-seeds from your documents; add deductions and capital gains to see tax payable or refund for each regime.
5. Work the source checklist and ask the local (offline) or BYO API assistant.
6. Track the filing-progress timeline, then submit and e-verify on the official portal.
7. Export a `.itrvault` backup regularly and lock the vault when stepping away.

## Run Locally

Requirements: Node.js, npm, and Microsoft Edge for the browser smoke test.

```powershell
npm install
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`.

## Validation

`test:parse` is a fast, deterministic unit check that needs no server. The Edge smoke test needs the development server running on port 5173:

```powershell
npm run lint
npm run build
npm run test:parse
npm run test:smoke
```

`test:parse` asserts the Form 16 Part B extraction, tax-input seeding (including 80TTA), and the old/new regime computation against known values. The Edge smoke test verifies mandatory encryption, authenticated manifests, ciphertext tamper rejection, wrong-passphrase behavior, mobile layout, local extraction, the tax computation panel, multi-intent local answers, identifier redaction, encrypted conversation persistence, deletion consistency, provider-origin trust, minimized BYO API payloads, memory-only credentials, wrong/truncated backup non-mutation, complete v2 restore, cross-tab invalidation, and no unexpected outbound requests.

## Deploy To Vercel

Import this folder as a Vite project or run the Vercel CLI. Use:

- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

Do not add server functions for documents, prompts, API keys, or tax facts. The included `vercel.json` adds browser security headers while allowing direct HTTPS connections for user-selected BYO API providers.

## Official Resources

- E-Filing portal: https://www.incometax.gov.in/iec/foportal/
- AY 2026-27 return downloads and Common Offline Utility: https://www.incometax.gov.in/iec/foportal/downloads/income-tax-returns

Escalate foreign assets, non-resident status, derivatives, unlisted shares, prior losses, notices, missing cost basis, or unexplained AIS differences to a qualified professional.
