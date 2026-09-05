# Owner reproduction guide

The current suite is version 2. Its `manifest.json` SHA-256 is:

```text
27da66939adb498e1c9dd7312c85583e3fee30e94fabceab8b8cbdd75612e4a8
```

Pin the scan-chart commit used for the comparison. Do not regenerate expected
artifacts. Verify every fixture length and SHA-256 from the manifest before
comparing component output.

## Source parser and writer

Run the implementation against all 10 `source-accepted` vectors. For the
target instrument and difficulty in each entry, compare:

- parsed semantics and diagnostics;
- legacy physical BTrack, projection, raw digest, and TrackHash; and
- canonical physical BTrack, projection, raw digest, and TrackHash.

Compare stages in that order. Report the first stage that differs.

Review these rules:

1. Taps include both endpoints. Open, forced-strum, and forced-HOPO modifiers
   include the start and exclude the end.
2. `.chart` range shifts use `E "ld_range_shift D P"` or
   `E "ld_range_shift D P S"`. MIDI range shifts use text events
   `[ld_range_shift D P]` or `[ld_range_shift D P S]`. Source order breaks
   same-tick ties.
3. Range shifts apply only to five-fret Guitar, Bass, Rhythm, Guitar Co-op, and
   Keys. Invalid markers produce a diagnostic and do not affect identity.
4. Section 8 stores valid shifts as a little-endian count followed by `int64`
   tick, position, and size records. The last valid same-tick marker wins, and
   later redundant records remain.
5. Star power and solos exclude their end tick. Flex lanes and drum freestyle
   include their end tick. Drum-freestyle ranges are never pruned for
   containing no notes.
6. MIDI tempo is `Float64(60000000) / Float64(microsecondsPerQuarter)`. Chart
   tempo is `Float64(milliBpm) / Float64(1000)`, with no decimal intermediate.

Record `agree`, `disagree`, or `not applicable` for each rule. For a
disagreement, identify the vector or a minimal counterexample, the first stage
that differs, and the preferred rule.

## BTrack reader and TrackHash

Run the canonical reader against all 32 physical vectors:

- the 4 `btrack-accepted` vectors must match semantics, projection bytes, raw
  digest, and TrackHash; and
- the 28 `btrack-rejected` vectors must fail without returning partial
  semantics or identity.

Internal error names can differ. Report the corresponding manifest error
category.

## Response format

```text
Component: <game, validator, or library>
Component revision: <commit or immutable build ID>
Suite: v2
Manifest SHA-256: 27da66939adb498e1c9dd7312c85583e3fee30e94fabceab8b8cbdd75612e4a8

Alignment rules:
1: agree | disagree | not applicable - <brief reason if needed>
2: agree | disagree | not applicable - <brief reason if needed>
3: agree | disagree | not applicable - <brief reason if needed>
4: agree | disagree | not applicable - <brief reason if needed>
5: agree | disagree | not applicable - <brief reason if needed>
6: agree | disagree | not applicable - <brief reason if needed>

Reproduction: passed | discrepancy
Passed vectors: <count>/<required count>
Discrepancies:
- <vector ID> - <first differing stage> - expected <checksum/hash>, observed <checksum/hash>
```

Do not send credentials, private source, full replay data, or proprietary build
artifacts. Checksums, hash strings, small byte offsets, and minimal authored
counterexamples are sufficient.
