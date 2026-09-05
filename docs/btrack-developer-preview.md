# BTrack developer preview

This branch is a reference implementation for the frozen Clone Hero
`1.1.0.6142` identity path and the proposed canonical `CHNF/20260801` BTrack
and TrackHash path. It is suitable for developing and testing another parser,
BTrack writer, reader, or TrackHash implementation.

The canonical BTrack and TrackHash implementation has a fixed 42-vector suite.
Clone Hero's game and validation-server owners have not yet reproduced that
suite, so treat this branch as a developer preview rather than a released
cross-game standard. The SongHash and duration APIs are less mature: their
independent multi-track golden vectors are still pending.

## Prepare the reference checkout

Use Node.js 24.6 or later.

```text
git clone https://github.com/Geomitron/scan-chart.git
cd scan-chart
git switch yarg-btrack-20260801-preview
npm ci
npm run vectors:verify
```

`vectors:verify` checks all fixture checksums before it runs the parser or the
canonical BTrack reader. It does not rewrite approved fixtures.

## Compare a source parser and BTrack writer

Use the `source-accepted` entries in
`test/golden-vectors/suites/v1/manifest.json`. For each entry:

1. Parse the referenced `source.chart` or `source.mid`.
2. Compare your parsed Track with the profile's `semantics.json`.
3. Compare your serialized bytes with `physical.btrack`.
4. Compare your TrackHash input with `projection.bin`.
5. BLAKE3-hash the projection and compare the raw `digest.bin` and the
   unpadded base64url TrackHash in the manifest.

The first differing stage identifies whether the problem is source parsing,
BTrack serialization, TrackHash projection, hashing, or string encoding. The
suite includes both legacy and canonical output for source cases where both
profiles apply.

## Compare a BTrack reader

Run every `btrack-accepted` and `btrack-rejected` entry in the manifest through
your canonical reader. Accepted inputs must match `semantics.json`,
`projection.bin`, `digest.bin`, and the manifest TrackHash. Rejected inputs
must fail without returning partial semantics or a hash. Internal error names
can differ.

## Generate reference artifacts from song folders

Build the standalone tool:

```text
npm run identity:build
node dist/ch-identity/ch-identity.cjs self-test
```

Generate both identity profiles for one song folder or a library:

```text
node dist/ch-identity/ch-identity.cjs generate <song-or-library> --out <new-output-directory>
```

The output contains physical BTracks, TrackHash projections, raw digests,
hash strings, parsed canonical semantics, SongHash preimages, and checksummed
manifests. To validate one canonical BTrack produced by another implementation,
run:

```text
node dist/ch-identity/ch-identity.cjs inspect-btrack <file.btrack> --out <new-output-directory>
```

The tool refuses a non-empty output directory. See
`tools/ch-identity/README.md` for the output schema and the manifest comparison
command.

## Current limits

- This branch is not an npm release. Build it from the branch, and pin the
  commit that produced your comparison results.
- The canonical physical format is `CHNF/20260801`. TrackHash uses the
  canonical semantic projection, not the physical file bytes. The projection
  excludes the magic, physical version, offsets, lengths, and unknown sections.
- The canonical reader requires the strict physical layout. It rejects gaps,
  overlaps, reordered payloads, trailing bytes, empty optional sections, and
  malformed recognized data.
- BTrack represents already-parsed Track semantics. Source parsing rules still
  affect the BTrack and TrackHash. Record intentional YARG parsing differences
  instead of forcing them to match silently.
- Frozen legacy SongHash needs the historical duration used by the released
  client. The folder tool reads a nonzero `song_length` from `song.ini`. If the
  value is unavailable, the tool still produces both TrackHash/BTrack profiles
  and canonical SongHash, and marks legacy SongHash unavailable.
- Canonical SongHash, canonical Song duration, and per-Track duration are
  implemented, but their independent normative vectors and Clone Hero owner
  sign-off remain pending. Use them for integration work, not permanent
  production identity, until that gate closes.
