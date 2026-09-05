# BTrack and parser golden vectors v2

This suite fixes the input and output bytes for the frozen Clone Hero
`1.1.0.6142` TrackHash path and the canonical `CHNF/20260801` path.
`manifest.json` records stable vector IDs, provenance, byte lengths, SHA-256
checksums, raw BLAKE3 digests, and TrackHashes.

Version 2 supersedes version 1. Version 1 incorrectly treated a drum-freestyle
range without notes as invalid. The governing format preserves every
drum-freestyle range, so version 2 accepts that physical input and retains the
empty freestyle range from the source boundary case. Version 1 remains in the
repository as an immutable historical suite and must not be used as the
current reference.

Run the verifier from a clean `scan-chart` checkout:

```text
npm run vectors:verify
```

The verifier checks every artifact checksum before it runs the parser or the
BTrack reader. It has no write or update mode.

## Fixture policy

- A vector ID never changes meaning within a suite version.
- Do not regenerate an approved suite in place.
- To correct or change the contract, add a new suite version and record the
  reason.
- `npm run vectors:generate -- --out <new-directory>` writes a new draft. The
  command refuses an existing directory and any path inside `suites/`.
- Promotion into `suites/` requires review. Generated artifacts become the
  expected values only after promotion; the generator is not the oracle.

All fixtures are minimal inputs authored for this repository and licensed
under the repository's MIT license. Each manifest entry states its purpose.
No chart archive or third-party song content is included.

## Coverage

The 10 source vectors cover `.chart` and MIDI input, direct `float64` tempo
conversion, same-tick precedence, range shifts, modifier boundaries, stored
range boundaries, duplicate pruning, overlap correction, and both identity
profiles.

The 32 physical vectors cover four accepted canonical BTracks and 28 rejected
inputs. They exercise every recognized section, unknown sections, physical
layout, bounds, ordering, phrase pruning, note validation, and the rule that
drum-freestyle ranges are never pruned for containing no notes.

## Reproduction status

- `scan-chart`: verify this suite before every change.
- Clone Hero game owner: reproduction pending.
- Clone Hero validator owner: reproduction pending.

Use `OWNER_REPRODUCTION.md` for the comparison stages and response format.
