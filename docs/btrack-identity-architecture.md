# BTrack identity architecture

Ticket 11 adds a canonical TrackHash implementation without changing the
meaning of the current `scan-chart` APIs. The existing `parseChartFile`,
`calculateTrackHash`, and `scanChart` exports remain the compatibility path for
the pinned legacy implementation.

## Public boundary

New code chooses one concrete identity profile:

```ts
const legacy = frozenLegacy6142.parseSource(request)
const canonical = canonical20260801.parseSource(request)
```

Each profile accepts only its own parsed-track type. The profile returns one
identity result containing the physical BTrack bytes, TrackHash projection,
raw BLAKE3 digest, and unpadded base64url TrackHash. Legacy and canonical hash
strings, physical bytes, projection bytes, and digest bytes use distinct
nominal types.

The canonical profile also exposes one strict `readBTrack` operation. An
accepted result contains semantics and identity. A rejected result contains a
nonempty error list and cannot expose semantics, projection bytes, a digest,
or a hash.

The public profile objects hide the writer, section map, reader validation,
projector, and digest stages. Callers cannot hash raw or partially validated
BTrack bytes.

## Internal ownership

Source decoders retain a `sourceOrder` value until each identity profile has
resolved same-tick precedence. A private range-shift marker distinguishes an
omitted size from an explicit size. This distinction prevents an invalid
explicit size from receiving the omitted-size default.

The frozen legacy profile owns the released modifier boundaries, contiguous
`CHNF/20240320` writer, whole-file digest, and legacy string-form fixtures.
The existing compatibility exports keep their current behavior and ownership
semantics.

The canonical profile owns the Ticket 05 parser rules. It produces a separate
semantic model with five-fret range shifts and the canonical tap boundary.

The source parser also leaves every recognized range-shift marker in the
track's existing `textEvents` collection. `scan-chart` does not provide a
source-chart writer, so downstream writers remain responsible for re-emitting
those events unchanged. The parser tests cover preservation for both `.chart`
and MIDI input.

One `CHNF/20260801` format module owns the recognized section grammar, writer,
strict reader, and Ticket 03 projector. Its projector accepts only a private
validated BTrack value. This keeps the physical contract and the semantic hash
contract consistent while preventing invalid call sequences.

## Golden vectors

The committed vector manifest has three case types:

- accepted source vectors bind exact source bytes to legacy and canonical
  semantics, physical bytes, projections, digests, and hashes;
- accepted physical vectors bind canonical BTrack bytes to reader semantics
  and canonical identity;
- rejected physical vectors contain BTrack bytes and expected errors only.

Every artifact records its byte length and SHA-256 checksum. Vector IDs do not
change meaning. The generator writes a new draft outside the committed fixture
tree and refuses existing output paths. The verifier reads approved fixtures
without an update or write mode.

The suite records both the pinned checkout's unpadded legacy hash and the
published package's padded legacy string as fixture assertions. The Ticket 11
API does not expose a new padded-hash option.

## Delivery order

1. Characterize the existing parser, hasher, and scanner. Add explicit legacy
   wrappers without changing their bytes or defaults.
2. Implement the canonical section model, `CHNF/20260801` writer, strict
   reader, Ticket 03 projection, and physical vectors from authored semantics.
3. Implement canonical `.chart` parsing, range shifts, modifier boundaries,
   and exact tempo vectors.
4. Implement the equivalent MIDI path while retaining same-tick event order.
5. Add the immutable fixture package, draft generator, and read-only verifier.

SongHash remains Ticket 12 work. Release behavior, package adoption, the
corpus-scanner rollout, and dependent-system upgrades remain Ticket 13 work.

## Decision

This design uses concrete profile objects instead of a mode flag or a generic
profile parameter. It keeps identity choice visible, prevents cross-profile
mixing at compile time, and leaves the current public API stable during the
migration.
