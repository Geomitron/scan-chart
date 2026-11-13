# Canonical golden vectors v6

This suite fixes the input and output bytes of the canonical
`canonical-20260801` identity: the TrackHash of a `CHNF/20260801` BTrack and
the SongHash with preimage version `20260801`. `manifest.json` (schema
version 2) records stable vector IDs, provenance, byte lengths, SHA-256
checksums, raw BLAKE3 digests, TrackHashes, and SongHashes.

Version 6 supersedes version 5. It adds the C20 readings, by which the
canonical profile reads forms of a notes file as Clone Hero reads them, and
keeps a UTF-8 byte order mark in `.mid` text. Versions 1 to 5 remain in the
repository as immutable historical suites.

Run the verifier from a clean `scan-chart` checkout:

```text
npm run vectors:verify
```

The verifier checks every artifact checksum before it runs the scanner, the
parser, the writers, or the BTrack reader. It has no write or update mode.

## Changes from version 5

Every version 5 vector is byte-identical to its version 5 artifacts. The 18
new source vectors are:

- **C20 (R2, R10), mix events.** Clone Hero's reading of a mix event's
  spelling. `source-chart-mix-two-spaces-and-drumsd`,
  `source-chart-mix-letter-configuration`, `source-midi-mix-leading-zero`,
  `source-midi-mix-configuration-6` and `source-midi-mix-flag-dx` have one
  TrackHash. `source-midi-mix-leading-space` has a mix event that starts with
  a space, which sets nothing.
- **C20 (R13), ENHANCED_OPENS in any letter case.**
  `source-midi-enhanced-opens-capitals`,
  `source-midi-enhanced-opens-lowercase` and
  `source-midi-enhanced-opens-mixed-case-bare` have one TrackHash.
- **C20 (R15), every MTrk chunk.** `source-midi-track-count-right`,
  `source-midi-track-count-short` and `source-midi-track-count-zero` have one
  TrackHash.
- **C20 (R16), events after the end of track.**
  `source-midi-events-after-end-of-track` has the TrackHash of
  `source-midi-green-before-end-of-track`.
- **C20 (R12), Phase Shift SysEx length.** `source-midi-sysex-8-byte-tap`
  taps its notes. `source-midi-sysex-7-byte-tap` and
  `source-midi-sysex-9-byte-tap` set nothing and have one TrackHash.
- **A UTF-8 byte order mark in `.mid` text.**
  `source-midi-text-byte-order-mark` has a byte order mark before
  `[ENHANCED_OPENS]`, which is then not the ENHANCED_OPENS event.

## Coverage

- 66 source vectors: one notes file and resolved chart modifiers in; the
  semantics, diagnostics, BTrack, projection, digest, and TrackHash of one
  Track out. They cover range shifts, modifier boundaries and tap ends (C22),
  stored ranges, quoted events (C6), flex lanes (C7), chart dynamics (C8) and
  kick dynamics (C17), tom markers (C9), disco in `.chart` and `.mid`, pro
  and four-lane (C10), mix event spellings (C20), `.chart` flam (C18), the
  `TS N ` trailing space, ENHANCED_OPENS in any letter case, MIDI track
  counts, events after the end of track, Phase Shift SysEx lengths and the
  byte order mark in `.mid` text (C20), five-lane drums, and six-fret notes.
- 47 song vectors: a song folder in, as raw file bytes; the selected notes
  file, the song.ini chart modifiers, the metadata before and after the
  SongHash writer resolves it, every member Track with its duration, the song
  duration, and the SongHash preimage, digest, and string out. They cover
  metadata (C1, C2), membership (C3), MIDI track names and track 0 (C4a-c),
  the notes-file choice (C5), song.ini chart modifiers (C11) and their older
  names (C21), durations (C12), six-fret keys, SongHash version `20260801`
  (C14), tempo rounding across formats (C16), and flam across formats (C18).
- 39 physical vectors: 8 accepted and 31 rejected BTracks. They cover every
  recognized section, physical layout, bounds, ordering, phrase pruning, note
  validation including kick dynamics (C17), overlapping and same-tick flex
  lanes (C7), and BTracks without a tempo or time-signature section (C13).

A BTrack without a tempo map hashes only the sections it has. It does not
hash like a BTrack with explicit 120 BPM and 4/4 sections.

The suite has accepted source vectors only, so the `.mid` files every profile
refuses (a SysEx value other than 00 or 01, a file that ends inside an event,
a time-signature exponent of 8 or more) are covered by the unit tests.

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
- Clone Hero: the C20 vectors and the byte order mark vector are still to be
  checked. Owner reproduction is pending.

Use `OWNER_REPRODUCTION.md` for the comparison stages and response format.
