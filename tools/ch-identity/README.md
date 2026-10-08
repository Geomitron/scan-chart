# ch-identity 0.3.0

`ch-identity` generates frozen-legacy and canonical SongHash, TrackHash, and BTrack reference artifacts from Clone Hero song folders.

## Requirements

- Node.js 24.6 or later on Windows, macOS, or Linux
- A song folder or library directory that contains `notes.chart` or `notes.mid`. When a folder has both, the tool uses `notes.mid`, as Clone Hero does.

The release bundle is standalone. It does not need a scan-chart checkout, npm install, game files, audio decoders, or BASS.

## Generate reference artifacts

```powershell
node ch-identity.cjs generate C:\path\to\song-or-library --out C:\path\to\output
```

The output directory may be missing or empty. The tool refuses files and non-empty directories, then publishes the completed output atomically. For a library, it processes each song folder independently and records failures in the top-level `manifest.json`.

Canonical `songDurationMs` is derived from the complete chart at song speed 1.0. The tool finds the latest regular-note end across all instruments and difficulties, adds one quarter-note in ticks, converts that tick through the complete tempo map, and rounds up once to milliseconds. This mirrors CH's `Song.GetLastTick()` and `Song.TickPositionToTime()`: tempo changes during the added beat count; time signature does not change its tick length. Audio, `song_length`, vocal-note collections, and chart events do not affect canonical duration.

Each Track also records its own duration at song speed 1.0. Track duration runs from chart time zero to that Track's latest regular-note end, uses the complete tempo map, does not add a beat, rounds up to milliseconds, and has a one-millisecond minimum. This is the trusted time scale for labeling the Track's existing 50 validation-graph buckets; it does not change or regenerate those buckets.

Legacy length follows CH's `Cache.TryUpdateChartMetadata` order: a nonzero signed-int32 `song_length`, then non-crowd audio length, then chart length. This bundle does not include BASS. If the INI length is missing, zero, or invalid and a supported audio stem is present, it reports `audioLengthUnavailable` while still generating both TrackHash/BTrack profiles and canonical SongHash. Without supported audio stems, it uses CH's chart fallback and records `chart-fallback`. Supported stems and extensions match CH; crowd and preview audio do not determine legacy length.

INI section names and keys are lowercased, and the last duplicate key wins in both profiles. Decoding matches CH's BOM detection for UTF-8/16/32, strict UTF-8 without a BOM, and ISO-8859-1 fallback for invalid BOM-less UTF-8. BOM-less UTF-16/32 is not guessed; its embedded NULs can prevent recognition of `song_length`. Malformed BOM-tagged Unicode is rejected. Canonical duration remains independent of INI length.

Legacy identity retains noteless MIDI tracks, including the Expert track CH creates for each recognized instrument. Canonical identity includes only tracks with at least one note, in both formats, and reads only the first MIDI track of each instrument. MIDI track names match in any letter case in both profiles.

The canonical SongHash takes the metadata Clone Hero puts on the song: the `[song]` values of a loaded song.ini, otherwise the `.chart [Song]` values read as CH reads them. It then treats "0" and "-1" as unset, strips style tags, lowercases the icon, clears an icon that equals the charter, and writes wire version 20260801. The legacy SongHash header keeps the scanner's metadata and version 20251010. The manifest records both profiles' metadata.

Each song manifest records both Song-duration profiles, each Track duration, input checksums, hash profiles, notices, and checksums for every artifact. It also records the source-tree SHA-256 used to build the tool, so a dirty build remains identifiable.

## Inspect a canonical BTrack

```powershell
node ch-identity.cjs inspect-btrack C:\path\to\track.btrack --out C:\path\to\output
```

This command validates a `CHNF/20260801` BTrack and writes its parsed semantics, Track duration, TrackHash projection, raw digest, base64url TrackHash, and provenance manifest.

## Compare manifests

```powershell
node ch-identity.cjs compare reference\manifest.json candidate\manifest.json
```

The command exits with code 0 for an exact match, 1 for differences, and 2 for invalid input or a tool failure.

## Verify the bundle

```powershell
node ch-identity.cjs self-test
node ch-identity.cjs provenance
```

The self-test reproduces a pinned production SongHash and runs a complete
folder-to-artifacts scan with distinct historical and canonical durations. The
provenance command prints the scan-chart commit, dirty state, source-tree
checksum, and calculation profiles embedded during the build.

Before use, verify the files against `SHA256SUMS`.
