---
description: "Use when editing the offline document analysis pipeline under src/documents/ — PDF layout extraction, content classification, or structured field parsing. Covers coordinate-aware parsing, dual number formats, confidence, and hard caps."
applyTo: "src/documents/**"
---
# Document Analysis Pipeline

Deterministic, offline, content-first. **No AI calls here.** Full context in [AGENTS.md](../../AGENTS.md).

- **Keep coordinates.** Parse from `ExtractedPage.rows` (position-aware) via `layout.ts` helpers (`buildRows`, `rowLabel`, `rowAmounts`, `rightmostAmount`, `rightmostNumber`). Never revert to flattened single-line regex for tables — that was the original bug (AIS/TIS/26AS are tables, so labels and amounts sit in separate cells).
- **Classify by content first** (`classifyDocument` signatures). The filename heuristic is only a fallback when `kind` is `null`.
- **Handle both number formats:** `18,06,808` (Indian grouping) and `1806808.00` (dot decimal, no separators).
- **Allow genuine negatives.** Real losses (e.g. house-property loss in Form 16) must survive — pass `allowNegative` to `pushField`; never clamp them to 0.
- **Never invent values.** Ambiguous or low-confidence → omit (surface for human review), never auto-fill. Every `ParsedField` carries a `confidence`.
- **Respect the hard caps** in `extract.ts`: 250 pages / 2,000,000 chars / 30s; the pdf.js worker stays lazy-loaded via dynamic `import('pdfjs-dist')`.
- **Keep `redactSensitiveText`.** Never log document text, PAN, Aadhaar, name, or OTP.
- Adding a new type? Use the `add-document-parser` skill. If you change `DocumentAnalysis`/`ParsedField`, update `isDocumentMetadata` in `src/storage/vault.ts` (new fields **optional**). A new reconciling `FieldKey` goes in `fieldOrder` (`reconcile.ts`); a tax-seeding key is mapped in `seed.ts`.
- Validate: `npm run build`, `npm run lint`, `npm run test:parse` (unit), `npm run test:smoke`; regress a parser end-to-end against a real PDF with `node --experimental-strip-types --loader ./scripts/ts-ext-loader.mjs scripts/validate-parse.ts <pdf>`.
