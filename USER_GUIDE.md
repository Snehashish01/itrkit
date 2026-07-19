# Family ITR Workspace — User Guide

A step-by-step guide to preparing multiple Indian individual income-tax returns (AY 2026-27) with this private, browser-local app.

For the privacy and security architecture behind these steps, see [README.md](README.md).

---

## 1. What this app does

- Keeps one organized workspace per family member using **neutral aliases** (for example `P1` or `Parent A`).
- Stores your source documents **encrypted, inside your own browser** — nothing is uploaded to a server.
- Reads selectable text from PDF, CSV, and JSON files locally, classifies each document by its content, and extracts **labeled amounts** you must verify.
- **Cross-checks** the same figure across your AIS, TIS, Form 26AS, and Form 16 and flags matches or mismatches.
- Gives an **offline old-vs-new regime tax estimate** — income auto-fills from your documents, you add deductions and capital gains, and it shows tax payable or refund for each regime.
- Tracks a **source checklist** and a **filing progress** timeline for each person.
- Offers a guided **evidence assistant** that answers from the documents you stored, either fully offline or through your own AI provider key.

## What this app does **not** do

- It does **not** submit, file, or e-verify a return. You do that on the official portal.
- Its tax figure is an **offline estimate** for comparing the old and new regimes — helpful for planning, but **not** a final filing value and **not** tax advice (it simplifies surcharge and some edge cases). Always confirm in the official utility.
- It does **not** need your PAN, Aadhaar, bank details, portal password, or OTP. **Never enter them.**

> Always confirm eligibility, figures, and the correct ITR form in the official Income Tax Department utility before filing.

---

## 2. Before you begin

Requirements:

- A modern desktop or mobile browser (Chrome, Edge, or equivalent).
- Your source documents saved somewhere on your device (Form 16, AIS, TIS, Form 26AS, bank interest, prior-year ITR, and broker/mutual-fund reports if you have capital gains).

Recommended:

- Use a **private, patched device** and a browser profile you trust, with no untrusted extensions.
- Keep a separate, safe copy of your **original documents**. Browser storage can be cleared by the browser or the operating system.

---

## 3. Create your encrypted vault (first run)

The first time you open the app you will see **Encrypt this workspace**.

1. Enter a **Vault passphrase** (minimum 12 characters).
2. Re-enter it in **Confirm passphrase**.
3. Select **Encrypt workspace**.

This passphrase encrypts everything you store: aliases, documents, extracted text, and conversations.

> **There is no password reset and no recovery.** If you lose the passphrase, the vault and its backups cannot be opened. Store the passphrase in a password manager.

### Unlocking later

On return visits you will see **Unlock your workspace**. Enter your passphrase and select **Unlock vault**.

### Moving from another browser or device

On the setup or unlock screen, enter the passphrase for the backup and choose **Restore encrypted backup**, then select your `.itrvault` file. Restoring **replaces** everything currently in this browser, so confirm the prompt only if that is what you want. After a restore, unlock again to view the data.

---

## 4. Add a family member

1. Select **Add person** (or the **+** in the Returns sidebar).
2. Enter a **Neutral alias** — use initials or a label like `P1`, never a legal name.
3. Choose the **Income profile**:
   - **Salary or pension** (includes bank interest) — on by default.
   - **Indian capital gains** (shares or mutual funds) — turn on only if it applies.
4. Select **Add to organizer**.

The new person appears in the sidebar and opens their **return workspace**. Repeat for each family member. The overview band at the top shows totals for **People**, **In progress**, and **E-verified**.

> Tip: start with the simplest return (salary/pension only) before more complex ones.

---

## 5. Store documents in the device vault

Each person's workspace has a **Device document vault**.

1. Select **Add documents** (or the drop zone that reads “Store source documents locally”).
2. Choose one or more files.

Supported files: **PDF, JSON, CSV, XLSX, XLS, JPG, JPEG, PNG**, up to **25 MB each**.

What happens on import:

- The file is **encrypted and stored in this browser only**. Nothing is uploaded.
- A **SHA-256 fingerprint** is recorded so the app can detect later corruption.
- The file is **classified by its content** — the app reads document signatures in the text (AIS, TIS, Form 26AS, Form 16, prior-year computation). The filename is only a fallback. Review the label and fix the source if it looks wrong.
- For selectable-text **PDF, CSV, and JSON**, the app reads the text locally and extracts labeled amounts.

If a document can't be recognized by its content, a filename containing `form16`, `ais`, `tis`, `26as`, `interest`, `broker`/`pnl`, or `mutual`/`cam` helps the fallback classifier.

> Images (JPG/PNG) and spreadsheets (XLS/XLSX) are stored securely but are **not** text-extracted yet — review them yourself.

### Remove a document

Select the trash icon next to a document and confirm. When the **last** document of a type is removed, its checklist item is unchecked automatically.

---

## 6. Review extracted values and cross-document checks

When extraction finds labeled amounts (such as **Gross salary**, **Exempt allowances u/s 10**, **Standard deduction**, **House property income/loss**, **Total income**, **80C**, or **TDS**), they appear under **Extracted values · verify before filing**, each linked to its **document and page**. Form 16's Part B is read in full, so you can check each line against the certificate.

- Treat these as **pointers**, not final figures.
- **Verify** every value against the original document before using it.
- Common **PAN, TAN, Aadhaar, and email** patterns are redacted from the displayed source line.

When the same figure appears in more than one statement, a **Cross-document check** panel groups them and marks each as **Matches** or **Mismatch** — for example gross salary across AIS, TIS, and Form 16, or TDS across Form 26AS and Form 16. Investigate any mismatch before filing.

If nothing appears, the document may be a scan/image without selectable text, or an unsupported format — review it manually.

---

## 7. Compare tax regimes and estimate tax

Each workspace has a **Tax computation** panel that estimates tax for **AY 2026-27** under both the **old** and **new** regimes, side by side, and highlights the lower one.

- **Income auto-seeds from your documents.** Gross salary, exempt allowances (HRA etc.), professional tax, house-property income or loss, interest, dividend, 80C, employer NPS, and TDS fill in from the values extracted above.
- **Set the age band** (below 60, 60–80, 80+) — it changes the old-regime slabs and the 80TTA/80TTB cap.
- **Add what isn't in your documents:** capital gains (in the broker Tax P&L categories) and any remaining deductions. Your edits are saved and **override** the seeded values; income re-seeds from documents each time you open the vault.
- The statement shows, for each regime: gross total income, Chapter VI-A deductions, total income, tax, rebate u/s 87A, cess, total tax liability, taxes already paid, and finally **refund or payable**.

Two things to know:

- **Regime matters for deductions.** Most Chapter VI-A deductions (80C, 80D, 80TTA, HRA exemption, etc.) apply only in the **old** regime; the new regime allows very few (mainly the standard deduction and employer NPS u/s 80CCD(2)). So a deduction usually changes only the old-regime column.
- **80TTA / 80TTB.** 80TTA is auto-filled from your **savings-bank** interest (up to ₹10,000, old regime only). Fixed-deposit interest does not qualify for 80TTA. If the taxpayer is a **senior**, switch the age band and raise the field to claim **80TTB** (up to ₹50,000, including fixed-deposit interest).

> This is an estimate for planning and regime choice — not a filing value. Surcharge and some edge cases are simplified. Confirm every figure and your regime choice in the official AY 2026-27 utility before filing.

---

## 8. Work the source checklist

The **Source checklist** lists the records typically needed for the return:

- Form 16 / pension statement
- Annual Information Statement (AIS)
- Taxpayer Information Summary (TIS)
- Form 26AS
- Bank interest summary
- Prior-year ITR and computation
- Broker capital-gains report *(only when capital gains is enabled)*
- Mutual-fund capital-gains report *(only when capital gains is enabled)*

Items are ticked **automatically** when a matching document is stored in the vault. You can also tick or untick them manually to track items you are handling outside the app.

---

## 9. Ask the evidence assistant

Each workspace includes an **Evidence assistant** with two modes.

### Local mode (default, fully offline)

Select **Local**. This answers deterministically from the data already in your vault — no network request is made. Ask things like:

- “Summarize the income and TDS evidence.”
- “What documents are still missing?”
- “Which ITR form is likely?”
- “What is the next step?”

You can combine intents in one question (for example income summary **and** what still needs review). Conversations are stored **encrypted** and persist after reload.

Use the trash icon (**Clear conversation**) to delete a person's chat history.

### BYO API mode (your own AI provider)

Select **BYO API** to use an OpenAI-compatible provider with **your own key**. This sends data directly from your browser to the endpoint you configure.

1. Select **Provider settings**.
2. Enter the **Endpoint** (HTTPS, or a `localhost` address) and **Model** name.
3. Enter your **API key**.
4. Tick **I trust `<origin>` to receive API keys or tax evidence**.

Then type your question and select **Send question**.

What is and isn't sent:

- By default only your **typed question** is sent — no documents and no chat history.
- To include extracted amounts, tick **Send N extracted candidates with each question**. This sends only candidate **type, label, value, and page** — **never** the source-quote text.
- Changing the endpoint **clears** your API key, trust choice, and evidence consent. Switching to Local mode also turns evidence sharing off.

Safety limits: questions are capped at **4,000 characters**, requests time out after **60 seconds**, responses are capped, and redirects are refused. Your key stays in memory only and disappears on reload.

> The remote provider may log or retain what you send under its own terms. Keep sensitive evidence in **Local** mode.

---

## 10. Track filing progress

The **Filing progress** timeline records the steps you complete, in order:

1. **Documents ready** — all relevant source records collected.
2. **AIS and tax credits reconciled** — differences against Form 16, 26AS, and reports explained.
3. **Tax regimes compared** — old vs new regime checked for this person.
4. **Draft return reviewed** — income, deductions, gains, tax paid, and refund reviewed.
5. **Official utility validated** — the AY 2026-27 utility reports no blocking errors.
6. **Taxpayer approved** — the family member personally reviewed the final preview.
7. **Return submitted** — submitted in the taxpayer's own portal account.
8. **E-verified** — acknowledgement confirms successful e-verification.

Tick each stage as you complete it. The ring next to the person's name shows overall progress.

---

## 11. File on the official portal

This app prepares; the official portal files. When you are ready, use the links in **Ready for the official tools?**:

- **Offline utility** — the AY 2026-27 Common Offline Utility download.
- **E-Filing portal** — the Income Tax Department e-filing site.

Each taxpayer must submit and e-verify from **their own** portal account. Enter portal credentials and OTPs only on the official site — never in this app.

---

## 12. Back up and restore your vault

Because everything lives in your browser, keep your own backup.

### Export

Select **Export** in the top bar to download an encrypted `.itrvault` file. It contains your data **still encrypted** with your passphrase — store it somewhere safe.

### Restore

On the **Unlock/Encrypt** screen, enter the backup's passphrase, choose **Restore encrypted backup**, pick the `.itrvault` file, and confirm. Restore **replaces** the current browser vault, then returns you to the unlock screen.

The app rejects backups that are wrong-format, tampered with, truncated, or opened with the wrong passphrase — a failed restore leaves your current vault unchanged.

### Protect against eviction

In the document vault, select **Protect storage** to request persistent browser storage. This reduces the chance the browser clears your data, but is **not** a substitute for your own backups.

---

## 13. Locking and security behavior

- **Lock** in the top bar locks the vault immediately (and locks it in other open tabs of the same site).
- The vault **auto-locks after 15 minutes** of inactivity.
- It also locks when the **tab is hidden**, on page exit, and when restored from the back/forward cache.
- After locking, you must re-enter your passphrase to continue.

Encryption protects **stored** data and **exported backups**. It does **not** protect an already-unlocked session against a compromised browser, a malicious extension, or device malware. Use a trusted device and lock the vault when you step away.

---

## 14. Remove data

- **Remove a document:** trash icon on the document, then confirm.
- **Remove a person:** the trash icon in the return header removes the person **and** all of their documents and conversations together.

Deletions are permanent within the vault. If you need the data later, export a backup first.

---

## 15. Troubleshooting

| Problem | What to do |
| --- | --- |
| Forgot the passphrase | There is no recovery. You must start a new vault (existing data is unrecoverable). Prevent this by saving the passphrase in a password manager. |
| A document shows no extracted values | It may be a scanned image or an unsupported/large PDF. Enter the figures manually after reviewing the source. |
| A document was classified as the wrong type | Classification reads the document's **content**, not the filename. If it's still wrong, the text layout may be unusual — verify the extracted values against the source and enter any figures manually. |
| “Storage may be cleared by the browser” | Select **Protect storage**, and keep an exported `.itrvault` backup. |
| BYO API request fails | Confirm the endpoint is HTTPS, the model name is correct, the trust box is ticked, and your key is valid. Requests time out after 60 seconds. |
| Another tab suddenly locked | Expected: locking or restoring in one tab locks the others for safety. Unlock again. |
| Restore did nothing | The backup was invalid, tampered, truncated, or the passphrase was wrong. Your current vault is left unchanged. |

---

## 16. Safety checklist

- Use **neutral aliases**, never legal names.
- **Never** enter PAN, Aadhaar, bank details, portal passwords, or OTPs in this app.
- Keep independent copies of your **original documents** and a current `.itrvault` **backup**.
- Reconcile every **extracted amount** against its source before filing.
- Do final **validation and filing** only in the official utility and portal.
- If you use **BYO API**, remember the provider receives what you send; prefer **Local** mode for sensitive evidence.

For deeper detail on the encryption model, threat boundaries, and deployment, see [README.md](README.md).
