# Canonical golden vectors v3

This suite fixes the input and output bytes of the canonical
`canonical-20260801` identity: the TrackHash of a `CHNF/20260801` BTrack and
the SongHash with preimage version `20260801`. `manifest.json` (schema
version 2) records stable vector IDs, provenance, byte lengths, SHA-256
checksums, raw BLAKE3 digests, TrackHashes, and SongHashes.

Version 3 supersedes version 2 for the canonical profile. It drops the legacy
`1.1.0.6142` pipeline: that profile is no longer public, and Clone Hero checks
its fidelity against the shipped 6142 build. Versions 1 and 2 remain in the
repository as immutable historical suites.

Run the verifier from a clean `scan-chart` checkout:

```text
npm run vectors:verify
```

The verifier checks every artifact checksum before it runs the scanner, the
parser, the writers, or the BTrack reader. It has no write or update mode.

## Changes from version 2

- `source-chart-duplicate-overlap` is removed. Its lines were out of tick
  order, and malformed input is outside identity scope (C15).
  `source-chart-duplicate-overlap-sorted` covers the same duplicates and
  overlaps in tick order.
- `physical-reject-note-flag-combination`, `physical-reject-empty-star-power`,
  `physical-reject-empty-solo`, and `physical-reject-empty-flex` now carry
  tempo and time-signature sections. A BTrack may omit its tempo map (C13), so
  each fails only for its own rule. Their error output is unchanged.
- Every other version 2 vector is byte-identical to its version 2 canonical
  artifacts.

## Coverage

- 42 source vectors: one notes file and resolved chart modifiers in; the
  semantics, diagnostics, BTrack, projection, digest, and TrackHash of one
  Track out. They cover range shifts, modifier boundaries, stored ranges,
  quoted events (C6), flex lanes (C7), chart dynamics (C8), tom markers (C9),
  disco in `.chart` and `.mid`, pro and four-lane (C10), the `TS N ` trailing
  space, five-lane drums, and six-fret notes.
- 37 song vectors: a song folder in, as raw file bytes; the selected notes
  file, the song.ini chart modifiers, the metadata before and after the
  SongHash writer resolves it, every member Track with its duration, the song
  duration, and the SongHash preimage, digest, and string out. They cover
  metadata (C1, C2), membership (C3), MIDI track names and track 0 (C4a-c),
  the notes-file choice (C5), song.ini chart modifiers (C11), durations (C12),
  six-fret keys, and SongHash version `20260801` (C14).
- 38 physical vectors: 8 accepted and 30 rejected BTracks. They cover every
  recognized section, physical layout, bounds, ordering, phrase pruning, note
  validation, overlapping and same-tick flex lanes (C7), and BTracks without a
  tempo or time-signature section (C13).

A BTrack without a tempo map hashes only the sections it has. It does not
hash like a BTrack with explicit 120 BPM and 4/4 sections.

## Fixture policy

- A vector ID never changes meaning within a suite version.
- Do not regenerate an approved suite in place.
- To correct or change the contract, add a new suite version and record the
  reason.

All fixtures are minimal inputs authored for this repository and licensed
under the repository's MIT license. Each manifest entry states its purpose.
No chart archive or third-party song content is included.

## Reproduction status

- `scan-chart`: verify this suite before every change.
- Clone Hero game owner: reproduction pending.
- Clone Hero validator owner: reproduction pending.

Use `OWNER_REPRODUCTION.md` for the comparison stages and response format.
