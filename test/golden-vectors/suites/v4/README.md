# Canonical golden vectors v4

This suite fixes the input and output bytes of the canonical
`canonical-20260801` identity: the TrackHash of a `CHNF/20260801` BTrack and
the SongHash with preimage version `20260801`. `manifest.json` (schema
version 2) records stable vector IDs, provenance, byte lengths, SHA-256
checksums, raw BLAKE3 digests, TrackHashes, and SongHashes.

Version 4 supersedes version 3. It adds three rules the Clone Hero developers
and the community accepted in October 2026. Versions 1 to 3 remain in the
repository as immutable historical suites.

Run the verifier from a clean `scan-chart` checkout:

```text
npm run vectors:verify
```

The verifier checks every artifact checksum before it runs the scanner, the
parser, the writers, or the BTrack reader. It has no write or update mode.

## Changes from version 3

- **C16, tempo rounding.** The TrackHash projection and the canonical
  durations use each tempo rounded to 0.001 BPM, `.chart`'s own precision;
  BTrack files keep the exact tempo.
  - `source-midi-modifier-boundaries`, `source-midi-all-difficulty-tap-boundary`
    and `physical-all-sections` have tempos that aren't whole thousandths of a
    BPM. Their projection, raw digest and TrackHash change; their BTracks
    don't.
  - `song-tempo-rounding-chart` and `song-tempo-rounding-mid` are new: a
    `.chart` at `B 140000` and a `.mid` at 428571 microseconds per beat have
    equal TrackHashes and durations.
- **C17, kick dynamics.** After `[ENABLE_CHART_DYNAMICS]`, MIDI velocity on a
  kick adds no accent or ghost, and a BTrack with an accent or ghost on a kick
  is malformed. New: `source-midi-kick-dynamics-ignored` and
  `physical-reject-kick-dynamics`.
- **C18, flam in `.chart`.** `N 109` in a `.chart` drum section flams every
  drum note on its tick in that difficulty, kicks included, and its length is
  ignored. New: `source-chart-flam`, and `song-flam-chart` and `song-flam-mid`,
  a `.chart` and a `.mid` with equal TrackHashes.
- Every other version 3 vector is byte-identical to its version 3 artifacts.

## Coverage

- 44 source vectors: one notes file and resolved chart modifiers in; the
  semantics, diagnostics, BTrack, projection, digest, and TrackHash of one
  Track out. They cover range shifts, modifier boundaries, stored ranges,
  quoted events (C6), flex lanes (C7), chart dynamics (C8) and kick dynamics
  (C17), tom markers (C9), disco in `.chart` and `.mid`, pro and four-lane
  (C10), `.chart` flam (C18), the `TS N ` trailing space, five-lane drums, and
  six-fret notes.
- 41 song vectors: a song folder in, as raw file bytes; the selected notes
  file, the song.ini chart modifiers, the metadata before and after the
  SongHash writer resolves it, every member Track with its duration, the song
  duration, and the SongHash preimage, digest, and string out. They cover
  metadata (C1, C2), membership (C3), MIDI track names and track 0 (C4a-c),
  the notes-file choice (C5), song.ini chart modifiers (C11), durations (C12),
  six-fret keys, SongHash version `20260801` (C14), tempo rounding across
  formats (C16), and flam across formats (C18).
- 39 physical vectors: 8 accepted and 31 rejected BTracks. They cover every
  recognized section, physical layout, bounds, ordering, phrase pruning, note
  validation including kick dynamics (C17), overlapping and same-tick flex
  lanes (C7), and BTracks without a tempo or time-signature section (C13).

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
- Clone Hero: the branch with the C16, C17 and C18 changes passes all 124
  vectors. Owner reproduction is pending.

Use `OWNER_REPRODUCTION.md` for the comparison stages and response format.
