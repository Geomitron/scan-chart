# Owner reproduction guide

The current suite is version 4. Its `manifest.json` SHA-256 is:

```text
825c7f535676562ff0ac08f730811066e38c0f0480ea6e4a49ef1b774496e7fa
```

Pin the scan-chart commit used for the comparison. Do not regenerate expected
artifacts. Verify every fixture length and SHA-256 from the manifest before
comparing component output.

## Source parser and writer

Run the canonical parser and writer against all 44 `source-accepted`
vectors, with the vector's resolved `modifiers`. For the target instrument and
difficulty, compare in this order and report the first stage that differs:
parsed semantics, diagnostics, physical BTrack, projection, raw digest, and
TrackHash.

## Song folders and SongHash

Treat the `files` of each of the 41 `song-accepted` vectors as one song
folder. Compare in this order:

1. the notes file the folder is read from;
2. the chart modifiers read from song.ini;
3. the metadata held on the song (`metadata.selected`), then the metadata the
   SongHash writer resolves (`metadata.resolved`);
4. the SongHash members, in order, and for each member its semantics, physical
   BTrack, projection, raw digest, TrackHash, last note end tick, and track
   duration;
5. the song duration;
6. the SongHash preimage, raw digest, and SongHash.

## BTrack reader and TrackHash

Run the canonical reader against all 39 physical vectors:

- the 8 `btrack-accepted` vectors must match semantics, projection bytes, raw
  digest, and TrackHash; and
- the 31 `btrack-rejected` vectors must fail without returning partial
  semantics or identity.

Internal error names can differ. Report the corresponding manifest error
category.

## Alignment rules

1. C1: `.chart [Song]` metadata is read and resolved as Clone Hero does, and
   is used only when no song.ini `[song]` section loads.
2. C2: every trim uses the .NET whitespace set, which includes U+0085 and
   excludes U+FEFF.
3. C3: a Track is a SongHash member only if it has a note after parsing.
4. C4: MIDI track names match in any letter case (with the `part drum`
   alias), the first track of an instrument wins, the last tick-0 track
   name names a track, and track 0 is never an instrument.
5. C5: a folder with both notes files is read from `notes.mid`.
6. C6: quoted `.chart` track events read like unquoted ones.
7. C7: flex lanes may overlap; same-tick lanes of one type keep the longest,
   and single comes before double.
8. C8: `[ENABLE_CHART_DYNAMICS]` applies from the event onward on every
   difficulty, including a same-tick note only when the event comes first.
9. C9: a MIDI tom marker makes a chart pro drums only if it covers a note.
10. C10: the latest mix event wins; on a shared tick off > `d` > `dnoflip`.
11. C11: song.ini chart modifiers parse like `int.TryParse` and `TryGetBool`.
12. C12: durations are taken at song speed 1.0 through the full tempo map.
13. C13: a BTrack may omit its tempo and time-signature sections, and then
    hashes only the sections it has.
14. C14: the canonical SongHash preimage has version `20260801`.
15. C16: the TrackHash projection and the canonical durations use each tempo
    rounded to 0.001 BPM, `floor(bpm * 1000 + 0.5) / 1000`; BTrack files keep
    the exact tempo.
16. C17: after `[ENABLE_CHART_DYNAMICS]`, MIDI velocity on a kick adds no
    accent or ghost, and a BTrack with an accent or ghost on a kick is
    malformed.
17. C18: `N 109` in a `.chart` drum section flams every drum note on its tick
    in that difficulty, kicks included, whatever its length.

Record `agree`, `disagree`, or `not applicable` for each rule. For a
disagreement, identify the vector or a minimal counterexample, the first stage
that differs, and the preferred rule.

## Response format

```text
Component: <game, validator, or library>
Component revision: <commit or immutable build ID>
Suite: v4
Manifest SHA-256: 825c7f535676562ff0ac08f730811066e38c0f0480ea6e4a49ef1b774496e7fa

Alignment rules:
1: agree | disagree | not applicable - <brief reason if needed>
...
17: agree | disagree | not applicable - <brief reason if needed>

Reproduction: passed | discrepancy
Passed vectors: <count>/<required count>
Discrepancies:
- <vector ID> - <first differing stage> - expected <checksum/hash>, observed <checksum/hash>
```
