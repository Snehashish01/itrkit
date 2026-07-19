---
description: "Use when editing the encrypted browser vault or storage layer under src/storage/ — IndexedDB records, the DocumentAnalysis/StoredDocument shape, encryption, or backups. Covers the validator backward-compat rule and persistence invariants."
applyTo: "src/storage/**"
---
# Vault & Storage Invariants

All persistence goes through `vault.ts`. Full context in [AGENTS.md](../../AGENTS.md).

- **Validator gate:** any change to `DocumentAnalysis` or `StoredDocument` MUST update `isDocumentMetadata` in `vault.ts`. Add new fields as **optional** — already-stored documents lack them and reads will throw otherwise.
- **Members too:** new `Member` fields (e.g. `taxInputs`) MUST be **optional** in `isMember` (`src/domain/filing.ts`), or already-stored members are filtered out on load.
- **Persist only through `vault.ts`.** Members, documents, and conversations are encrypted (AES-256-GCM, PBKDF2 600k), AAD-bound, and tracked by an encrypted revisioned manifest with ciphertext fingerprints. Don't bypass it or write plaintext.
- **No backend, no telemetry, no server functions.** Static deploy only.
- **Mutations** run through the serialized queue + Web Locks with active-revision checks and atomic IndexedDB transactions; invalidation is broadcast to same-origin tabs. Preserve this ordering.
- **Never persist or log** PAN, Aadhaar, name, OTP, or API keys. Keys are memory-only.
- **Backups:** encrypted v2 export + authenticated, bounded restore. Don't weaken restore validation (envelope version, manifest match, size caps).
- Validate: `npm run build`, `npm run lint`, `npm run test:smoke`.
