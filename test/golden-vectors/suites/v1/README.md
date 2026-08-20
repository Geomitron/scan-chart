# BTrack and parser golden vectors v1

This suite fixes the input and output bytes for the frozen Clone Hero 1.1.0.6142
TrackHash path and the canonical `CHNF/20260801` path. `manifest.json` records
the contract version, stable vector IDs, provenance, byte lengths, SHA-256
checksums, raw BLAKE3 digests, and TrackHashes.

Run the verifier from a clean `scan-chart` checkout:

```text
npm run vectors:verify
```

The verifier checks every artifact checksum before it runs the parser or BTrack
reader. It has no write or update mode.

## Fixture policy

- A vector ID never changes meaning.
- Do not regenerate an approved suite in place.
- To correct or change the contract, add a new suite version and record the
  decision that requires it.
- `npm run vectors:generate -- --out <new-directory>` writes a new draft. The
  command refuses an existing directory and any path inside `suites/`.
- Promotion into `suites/` requires a reviewed patch. The generated artifacts
  are the expected values after promotion; the generator is not the oracle.

All v1 fixtures are minimal inputs authored for this repository and licensed
under the repository's MIT license. Each manifest entry states its purpose.
No chart archive or third-party song content is included.

## Coverage

The source vectors cover `.chart` and MIDI input, direct float64 tempo
conversion, same-tick tempo and time-signature precedence, range-shift source
forms, all five applicable instruments, default sizes, malformed and invalid
markers, same-tick precedence, later redundant markers, modifier boundaries,
stored-range end boundaries, duplicate pruning, and overlap correction. Each
source vector includes legacy and canonical semantics, physical bytes,
projection bytes, raw digests, and hash strings.

The physical vectors cover a Resolution-only file, every recognized section,
empty-section omission, an ignored unknown section, section and payload order,
overlapping physical ranges, phrase pruning, duplicate section IDs, a
zero-count optional section, negative signed range data, and trailing bytes.
Rejected vectors contain only physical bytes and expected reader errors.

## Reproduction status

- `scan-chart`: local verifier required before every change to this suite.
- Game owner: reproduction pending.
- Validator owner: reproduction pending.

Ticket 11 remains open until the game and validator owners either reproduce
the relevant vectors or record an actionable discrepancy.
