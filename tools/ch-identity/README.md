# ch-identity

`ch-identity` generates frozen-legacy and canonical SongHash, TrackHash, and BTrack reference artifacts from Clone Hero song folders.

## Requirements

- Node.js 24.6 or later on Windows, macOS, or Linux
- A song folder or library directory that contains `notes.chart` or `notes.mid`

The release bundle is standalone. It does not need a scan-chart checkout, npm install, game files, audio decoders, or BASS.

## Generate reference artifacts

```powershell
node ch-identity.cjs generate C:\path\to\song-or-library --out C:\path\to\output
```

The output directory may be missing or empty. The tool refuses files and non-empty directories, then publishes the completed output atomically. For a library, it processes each song folder independently and records failures in the top-level `manifest.json`.

Canonical duration is derived from the complete chart at song speed 1.0. The tool finds the latest regular-note end across all instruments and difficulties, adds one beat, converts that tick through the complete tempo map, and rounds up once to milliseconds. Audio, `song_length`, vocal-note collections, and chart events do not affect canonical duration.

Each Track also records its own duration at song speed 1.0. Track duration runs from chart time zero to that Track's latest regular-note end, uses the complete tempo map, does not add a beat, rounds up to milliseconds, and has a one-millisecond minimum. This is the trusted time scale for labeling the Track's existing 50 validation-graph buckets; it does not change or regenerate those buckets.

The frozen legacy SongHash needs the historical duration used by released clients. The tool uses a nonzero `song_length` from `song.ini` for that profile. If it is absent, the manifest reports the legacy SongHash as unavailable while still generating both generations of TrackHash and BTrack and the canonical SongHash.

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
