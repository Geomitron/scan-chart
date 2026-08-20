# Owner reproduction guide

Ticket 11 closes only after the game and validator owners independently
reproduce the bytes their components own and review the parser-alignment
decisions. Running the `scan-chart` verifier alone does not satisfy this gate.

## Pinned suite

- Reference implementation commit: `480365a`
- Manifest: `manifest.json`
- Manifest SHA-256:
  `63e823b11d67ad5a753b79b0ea64fbced805ce07b148fc208b8423b34ec88a0d`
- Contract: legacy Clone Hero `1.1.0.6142`, canonical physical
  `CHNF/20260801`, Ticket 03 map-first projection, Ticket 05 parser rules

Do not regenerate expected artifacts. Verify each fixture's length and SHA-256
from the manifest before comparing component output.

## Game owner

Run the game implementation against all 10 `source-accepted` vectors. For the
target instrument and difficulty in each manifest entry, compare:

- parsed semantics and diagnostics;
- legacy physical BTrack, projection, raw digest, and TrackHash; and
- canonical physical BTrack, projection, raw digest, and TrackHash.

The required source vector IDs are:

```text
source-chart-minimal-unaffected
source-chart-range-shifts-tempo
source-chart-range-shifts-guitar
source-chart-range-shifts-bass
source-chart-range-shifts-rhythm
source-chart-range-shifts-guitar-coop
source-midi-modifier-boundaries
source-midi-all-difficulty-tap-boundary
source-chart-duplicate-overlap
source-chart-stored-range-boundaries
```

Review these six decisions:

1. Taps include both endpoints. Open, forced-strum, and forced-HOPO modifiers
   include the start and exclude the end.
2. `.chart` range shifts use either `E "ld_range_shift D P"` or
   `E "ld_range_shift D P S"`. MIDI range shifts use either `FF 01` text
   `[ld_range_shift D P]` or `[ld_range_shift D P S]`. Source order breaks
   same-tick ties.
3. Range shifts apply only to five-fret Guitar, Bass, Rhythm, Guitar Co-op, and
   Keys. Invalid markers produce a diagnostic and do not affect identity.
4. Section 8 stores valid shifts as a little-endian count followed by `int64`
   tick, position, and size records. The last valid same-tick marker wins, and
   later redundant records remain.
5. A range shift changes visual guidance at its tick. With **No Range Shifts**,
   the first valid marker sets the destination range. Later marked intervals
   transpose by the position difference. Open notes stay open. The game removes
   unmappable or out-of-range fretted notes. If the first valid marker follows
   the first playable note, compression does nothing.
6. MIDI tempo is `Float64(60000000) / Float64(microsecondsPerQuarter)`. Chart
   tempo is `Float64(milliBpm) / Float64(1000)`, with no decimal intermediate.

Record `agree`, `disagree`, or `not applicable` for each decision. For a
disagreement, identify the vector or a minimal counterexample, the first stage
that differs, and the preferred rule.

## Validator owner

Run the validator's canonical BTrack reader and TrackHash implementation
against all 32 physical vectors:

- the 3 `btrack-accepted` vectors must be accepted and match projection bytes,
  raw digest, and TrackHash exactly; and
- the 29 `btrack-rejected` vectors must be rejected. Internal error names may
  differ, but report the corresponding manifest error category.

The validator does not parse source charts. Mark source parsing, gameplay, and
source tempo conversion decisions as `not applicable` with that reason. Review
and agree or disagree with the physical range-shift records and exact semantic
projection it does consume.

## Response format

Return one non-secret report per component:

```text
Component: game | validator
Component revision: <commit or immutable build ID>
Suite reference commit: 480365a
Manifest SHA-256: 63e823b11d67ad5a753b79b0ea64fbced805ce07b148fc208b8423b34ec88a0d

Alignment decisions:
1: agree | disagree | not applicable — <brief reason if needed>
2: agree | disagree | not applicable — <brief reason if needed>
3: agree | disagree | not applicable — <brief reason if needed>
4: agree | disagree | not applicable — <brief reason if needed>
5: agree | disagree | not applicable — <brief reason if needed>
6: agree | disagree | not applicable — <brief reason if needed>

Reproduction: passed | discrepancy
Passed vectors: <count>/<required count>
Discrepancies:
- <vector ID> — <first differing stage> — expected <checksum/hash>, observed <checksum/hash>
```

Do not send credentials, private source, full replay data, or proprietary build
artifacts. Checksums, hash strings, small byte offsets, and minimal authored
counterexamples are sufficient. Ticket 11 records the report or routes each
discrepancy back to an agent before either component ships.
