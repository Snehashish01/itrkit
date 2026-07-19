---
name: add-document-parser
description: 'Add or fix support for an Indian income-tax document type (AIS, TIS, Form 26AS, Form 16, ITR/computation, broker or mutual-fund statements) in the offline analysis pipeline. Use when a document is misclassified, extracts no values, or a new statement type must be parsed. Covers layout inspection, content-based classification, structured field parsing, and validation.'
argument-hint: '<document type or sample file to support>'
---

# Add a Document Parser

Extends the offline, content-first analysis pipeline in `src/documents/`. See [AGENTS.md](../../../AGENTS.md) for the architecture map and invariants.

## When to Use
- A statement is classified as the wrong `DocumentKey` (or falls back to `priorItr`).
- A document extracts 0 structured `fields` even though it has selectable text.
- A brand-new statement type must be parsed into `ParsedField`s.

## Before You Start
- Put a **real** sample PDF under `private-input/` (gitignored — never commit or echo its contents/PII).
- Parsing is deterministic and coordinate-aware. Do **not** add AI calls here.

## Procedure

1. **Inspect the real layout.** Dump row/column coordinates:
   ```powershell
   node ./scripts/inspect-layout.mjs '.\private-input\<sample>.pdf' '.\artifacts\layout-<type>.txt'
   ```
   Open the output in `artifacts/` (gitignored). Note each row's y-band and the x of the label column vs the amount column(s).

2. **Add a classification signature** in `src/documents/reports.ts` → `classifyDocument`. Match a stable first-page phrase (e.g. `annual tax statement`, `certificate under section 203`) and return the `DocumentKey`. Content-first; the filename heuristic (`inferDocumentKind` in `DocumentVaultPanel.tsx`) is only a fallback when `kind` is `null`.

3. **Add any new `FieldKey`** in `src/documents/reports.ts` (the `FieldKey` union + `fieldLabels`). Reuse existing keys when the meaning matches: `grossSalary`, `salaryPaidCredited`, `exemptAllowances`, `standardDeduction`, `professionalTax`, `housePropertyIncome`, `grossTotalIncome`, `totalIncome`, `interestSavings`, `interestDeposit`, `dividend`, `deduction80C`, `deduction80CCD2`, `totalTdsSalary`, `selfAssessmentTax`. A new key that should reconcile across documents goes in `fieldOrder` (`reconcile.ts`); a key that feeds the tax estimate is mapped in `seed.ts`.

4. **Write the parser** and wire it into `parseReport(kind, pages)`. Work from `ExtractedPage.rows` using the `layout.ts` helpers — `rowLabel(row)`, `rowAmounts(row)`, `rightmostAmount(row)`, and `rightmostNumber(row)` (no 3-digit guard, for right-aligned value columns). Emit `ParsedField { key, label, value, page, confidence }`. Handle **both** number formats: `18,06,808` (Indian grouping) and `1806808.00` (dot decimal, no separators). Some statements wrap a label above its value — look on the same row first, then the adjacent row. For genuine losses (e.g. house property), pass `allowNegative` to `pushField` so the negative is not dropped.

5. **Never invent values.** If a row is ambiguous or below confidence, omit it (it surfaces for manual review) rather than guessing.

6. **If you changed the `DocumentAnalysis`/`ParsedField` shape**, update the `isDocumentMetadata` validator in `src/storage/vault.ts` — keep new fields **optional** (backward compat) or stored-document reads throw. See the `vault-schema` instructions.

7. **Validate:**
   ```powershell
   npm run build
   npm run lint
   npm run test:parse   # deterministic parser + tax-engine unit checks (no server)
   npm run test:smoke   # dev server must be running: npm run dev -- --host 127.0.0.1
   ```
   Run the parser end-to-end against the real sample and check every field:
   ```powershell
   node --experimental-strip-types --loader ./scripts/ts-ext-loader.mjs scripts/validate-parse.ts '.\private-input\<sample>.pdf'
   ```
   Then live-check: import the sample into a member and confirm `kind` and each field value match the source exactly. Extend a fixture assertion in `tests/smoke.mjs` for the new type.

## Done When
- The document classifies by content, its key values extract and match the source, `build` / `lint` / `test:parse` / `test:smoke` pass, and no PII is committed.
