# AGENTS.md — Family ITR Workspace

Guidance for AI coding agents working in this repo. For product/privacy detail see [README.md](README.md); for end-user flow see [USER_GUIDE.md](USER_GUIDE.md). Don't duplicate those — link to them.

## What this is

A **static, offline-first browser SPA** (React 19 + Vite, TypeScript) that helps prepare multiple Indian individual income-tax returns (AY 2026-27). **No backend, no database, no telemetry.** All data is encrypted in the browser (IndexedDB). Document analysis runs locally; an optional **bring-your-own (BYO) AI provider** can be called directly from the browser with explicit consent.

## Setup, run, validate

```powershell
npm install
npm run dev -- --host 127.0.0.1   # dev server at http://127.0.0.1:5173/
npm run build                     # tsc -b + vite build
npm run lint                      # oxlint (.oxlintrc.json)
npm run test:parse                # deterministic parser + tax-engine unit checks (no server)
npm run test:smoke                # Playwright + Edge e2e; REQUIRES dev server running
```

- **Windows path gotcha:** the workspace path contains `&`, which breaks npm-generated `.cmd` shims (e.g. `tsc`). Package scripts therefore call `node ./node_modules/...` directly — keep that pattern for any new script.
- TS project references: `tsconfig.app.json` (browser) and `tsconfig.node.json` (scripts/tests).

## Architecture map

- `src/main.tsx`, `src/App.tsx` — app shell, vault gate, per-member workspace, and lifecycle **auto-lock** wiring.
- `src/domain/filing.ts` — **source of truth** for `Member` (incl. optional `taxInputs`), `DocumentKey`, `documentItems`, `stageItems`. Add document/checklist types here.
- `src/documents/` — the local analysis pipeline (see below).
- `src/tax/` — deterministic **offline tax engine** (see below): `compute.ts` (old/new regime slabs, rebate 87A, cess for AY 2026-27) and `seed.ts` (derives income `TaxInputs` from a member's reconciled document fields).
- `src/storage/vault.ts` + `src/storage/crypto.ts` — encrypted IndexedDB vault and AES-GCM/PBKDF2 primitives. **All** persistence goes through `vault.ts`.
- `src/components/` — `VaultGate.tsx` (passphrase), `DocumentVaultPanel.tsx` (import/classify/show fields), `TaxComputationPanel.tsx` (regime comparison + editable statement), `AssistantPanel.tsx` (local + BYO API assistant).
- `scripts/inspect-layout.mjs` — dev tool that dumps a PDF's row/column layout (grouped by y-band, cells sorted by x). Use it to design/adjust parsers against real documents.
- `scripts/validate-parse.ts` — runs the **real** `classifyDocument` + `parseReport` against a PDF and prints the extracted `ParsedField`s. Run: `node --experimental-strip-types --loader ./scripts/ts-ext-loader.mjs scripts/validate-parse.ts <pdf>`. Use it to verify/regress parsers end-to-end against real documents.
- `tests/smoke.mjs` — end-to-end behavior + security regressions (encryption, tamper rejection, parsing, BYO API consent).
- `private-input/` and `artifacts/` are **gitignored** (real PII documents and layout dumps). Never commit or echo their contents.

## Document analysis pipeline (`src/documents/`)

Content-first, coordinate-aware, deterministic. No AI required to parse the core government statements.

1. `layout.ts` — **position-aware extraction**. Keeps each PDF.js text run's `x`/`y` so table columns survive. Exports `buildRows`, `rowsToText`, `rowLabel`, `rowAmounts`, `rightmostAmount`, and `rightmostNumber` (small-amount-safe, for right-aligned value columns). `ExtractedPage = { pageNumber, text, rows }`.
2. `reports.ts` — `classifyDocument(pageText): DocumentKey | null` via document **signatures** (e.g. "Taxpayer Information Summary", "Annual Information Statement", "Annual Tax Statement"/"Form 26AS", "FORM NO. 16"/"Certificate under section 203", "Intimation u/s 143"). `parseReport(kind, pages)` runs per-type parsers (TIS, AIS, 26AS, Form 16, and a CPC/ITR **computation** parser for `priorItr`) → `ParsedField[]`. The **Form 16 parser reads the full Part B computation** — gross salary 1(d), exemptions u/s 10, standard deduction + professional tax u/s 16, house-property income/**loss** (negative, `allowNegative`), gross total income, 80C, employer NPS 80CCD(2), and total taxable income — so the app shows the document as-is for the user to verify (it never guesses missing detail).
3. `reconcile.ts` — `reconcile(documents)` groups the same `FieldKey` across a member's documents and flags `match` / `mismatch` / `single`. `shortDocKind` maps `DocumentKey` → short code (AIS, TIS, 26AS…).
4. `extract.ts` — `analyzeDocument(file): Promise<DocumentAnalysis>`. Builds rows, **classifies across pages in order (first signature wins — a CPC intimation's page 1 can be a non-English cover)**, parses, and returns structured `fields` plus legacy `facts`. Hard caps: **250 pages / 2,000,000 chars / 30s**; pdf.js worker is lazy-loaded via dynamic `import('pdfjs-dist')`.

Design notes that must be preserved:
- **Number formats differ:** 26AS uses `1806808.00` (dot decimal, no separators); AIS/TIS use `18,06,808` (Indian grouping). The parser handles both.
- Classification is **content-first**; `inferDocumentKind(filename)` in `DocumentVaultPanel.tsx` is only a fallback when `kind` is `null`.
- To add a new document type: add its signature to `classifyDocument`, a parser to `parseReport`, and any new `FieldKey` to `reports.ts` (and to `fieldOrder` in `reconcile.ts` + `seed.ts` if it feeds the tax engine). Validate with `scripts/inspect-layout.mjs` (design) and `scripts/validate-parse.ts` (end-to-end).

## Tax computation (`src/tax/`)

Deterministic, offline, estimate-only. Leaf module (no imports from the rest of the app), so it stays cycle-free and unit-checkable.

- `compute.ts` — `compareRegimes(inputs)` runs `computeRegime` for both `'old'` and `'new'` (AY 2026-27 / FY 2025-26). Encodes: new slabs (nil ≤₹4L … 30% >₹24L) and age-banded old slabs; standard deduction (new ₹75k / old ₹50k); Chapter VI-A (old-regime deductions incl. 80EEA/80E/80EEB/80CCH, plus 80CCD(2) in both; 80TTA/80TTB capped by surviving interest after BFLA); special rates (STCG 111A 20%, LTCG 112A 12.5% over ₹1.25L, other LTCG 12.5%); rebate 87A (new: total income ≤₹12L with marginal relief; old: ≤₹5L); **surcharge with marginal relief at ₹50L/₹1cr/₹2cr/₹5cr** (new regime caps at 25%); 4% cess. Also: a **house-property schedule** (`houseProperties[]`), **brought-forward losses** (sec 43(5) specified F&O → non-salary; speculative → speculative; LTCG → LTCG; HP → HP) with closing carry-forward in `TaxResult`, a rough **234B** estimate, and `recommendItrForm(inputs)`. 234C and a few edge cases remain simplified. Never a filing value.
- `seed.ts` — `seedTaxInputs(documents)` reconciles a member's documents and maps matched `FieldKey`s onto income + deduction inputs (grossSalary; exempt allowances u/s 10; professional tax; house-property income/loss; interest = savings+deposits; dividend; 80C; 80TTA from savings-bank interest (engine-capped); employer NPS 80CCD(2); TDS; self-assessment). Capital gains and any remaining deductions are user-entered.
- `TaxComputationPanel.tsx` merges `{ ...emptyTaxInputs(), ...seedTaxInputs(docs), ...member.taxInputs }` — income auto-seeds live from documents; **user overrides win** and persist. All capital-gains heads render even at zero.

## AI provider integration (BYO API) — the contract

Everything an external OpenAI-compatible provider needs lives in `src/components/AssistantPanel.tsx` (`askRemote`). The app calls the provider **directly from the browser** — there is no server proxy.

- **Request:** `POST <endpoint>` (default `https://api.openai.com/v1/chat/completions`), JSON body:
  ```json
  { "model": "<user model>", "temperature": 0.1,
    "messages": [ { "role": "system", "content": "…tax-assistant system prompt + optional evidence…" },
                  { "role": "user", "content": "<question>" } ] }
  ```
  Header `Authorization: Bearer <key>` only when a key is set. Any provider that accepts this shape works.
- **Two modes:** `local` (default, fully offline, deterministic `buildLocalAnswer`) and `remote` (BYO API).

**Privacy invariants — do not weaken when editing the assistant:**
- Evidence is **excluded by default**. Only when the user ticks `shareEvidence` is `evidencePacket(member, documents)` attached — and it contains only: assessment year, profile booleans, checklist availability, and candidate `{ documentType, label, value, page }`. **Never** send source quotes, raw document text, PAN/Aadhaar/OTP, or prior conversation history.
- Key-bearing **or** evidence-sharing requests require `trustedEndpoint`. Changing the endpoint clears key, trust, and consent.
- Endpoint must be **HTTPS or localhost**; `redirect: 'error'`; question ≤ 4,000 chars; response ≤ 50 KB; 60s abort timeout; API key is **memory-only** (never persisted).
- Known TODO: `evidencePacket` still reads legacy `document.analysis.facts`; extending it to structured `fields` is fine **as long as the same minimization rules hold**.

## Data schemas external tools/providers can rely on

- `DocumentAnalysis` (`src/documents/extract.ts`): `{ status: 'ready'|'unsupported'|'empty', kind: DocumentKey|null, pages: {pageNumber,text}[], fields: ParsedField[], facts: FactCandidate[] }`.
- `ParsedField` (`src/documents/reports.ts`): `{ key: FieldKey, label, value: number, page, confidence }`. `FieldKey` ∈ `grossSalary | salaryPaidCredited | exemptAllowances | standardDeduction | professionalTax | housePropertyIncome | grossTotalIncome | totalIncome | interestSavings | interestDeposit | dividend | deduction80C | deduction80CCD2 | totalTdsSalary | selfAssessmentTax | totalTaxPaid`. `housePropertyIncome` may be **negative** (loss).
- `StoredDocument` (`src/storage/vault.ts`): `{ id, memberId, kind, name, mediaType, size, addedAt, sha256, data: Blob, analysis: DocumentAnalysis }`.
- `TaxInputs` (`src/tax/compute.ts`): normalised, all-INR inputs — `ageBand`, salary/other-source income, the broker-taxonomy capital-gains heads, Chapter VI-A deductions, and taxes paid. `emptyTaxInputs()` is the zero baseline.
- `TaxResult` / `TaxComparison` (`src/tax/compute.ts`): per-regime breakdown (`grossTotalIncome`, `chapterVIADeduction`, `totalIncome`, `slabTax`, `specialTax`, `rebate87A`, `cess`, `totalTaxLiability`, `taxesPaid`, `balance` — `>0` payable, `<0` refund) plus `{ old, new, recommended, saving }`.
- `Member.taxInputs` (`src/domain/filing.ts`): **optional** `Partial<TaxInputs>` — only user overrides are stored; income re-seeds from documents on load.

## Hard invariants (never break)

- **No backend / no server functions** for documents, prompts, keys, or tax facts. Static deploy only; keep `vercel.json` security headers/CSP.
- **Persist only through `vault.ts`.** If you add a field to `DocumentAnalysis`/`StoredDocument`, you **must** update the `isDocumentMetadata` validator in `vault.ts` — keep new fields **optional** for backward compatibility, or reads of already-stored documents will throw. Same rule for `Member`: new fields (e.g. `taxInputs`) must stay optional in `isMember` (`filing.ts`), or already-stored members get filtered out on load.
- Keep PDF caps and `redactSensitiveText`. Never log or persist PAN, Aadhaar, name, OTP, or API keys.
- Deterministic parsing must **never invent values**; low confidence → surface for human review, never auto-fill. Tax figures are an **estimate only** (surcharge modelled with marginal relief; 234C and a few edge cases simplified) — never a filing value. **Never automate filing.**

## Roadmap — high-value next steps

Tracked here so any agent can pick them up. Keep the hard invariants (offline, deterministic, estimate-only, never auto-file) when implementing.

- **Broker Tax P&L importer** — parse the Zerodha (and similar) `.xlsx`/`.csv` Tax P&L into the capital-gains heads (`stcgEquity111A`, `ltcgEquity112A`, `stcgOther`, `ltcgOther`, `intradaySpeculative`, `fnoBusiness`) the way salary already auto-seeds. Add a parser + `FieldKey`s + `seed.ts` mapping.
- **ITR prefill JSON import** — read the portal's downloaded prefill JSON to cross-check parsed figures (offline, read-only).
- **Advance-tax & interest u/s 234C** — quarterly shortfall interest estimate (234B is now a rough estimate; 234C is not).
- **What-if regime slider / exportable one-page statement** — printable/PDF computation summary for the taxpayer's records.
- **Surcharge marginal-relief edge cases** — the modelled marginal relief covers the standard thresholds; verify against the official utility for incomes sitting exactly on a threshold with mixed capital gains.

## Gotchas

- The vault **auto-locks** on `visibilitychange`→hidden, 15-min idle, and `pagehide`. During headless/CDP automation the page reports hidden, so it locks between steps — re-unlock with the passphrase. Manual lock is broadcast to all same-origin tabs.
- Backward compat: documents stored before the structured-field parser have `analysis` without `fields`/`kind`; they still read (validator treats those as optional) but show 0 extracted values until re-imported.
- Validate every change with `npm run build`, `npm run lint`, `npm run test:parse` (fast, no server), and `npm run test:smoke` (dev server up). `tests/parse.test.ts` locks in the Form 16 extraction, seeding, and regime math; `tests/smoke.mjs` asserts exact UI/console/network behavior — update them alongside schema or copy changes.
