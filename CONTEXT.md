# scan-chart

A library that parses and scans rhythm-game chart folders (Clone Hero and similar), producing metadata, validation issues, and content hashes. This document defines the project-specific vocabulary used when discussing its tests and tooling.

## Language

### Test surfaces

**Unit test**:
An in-memory test under `test/unit/*.test.ts` (run via `npm test`) that builds synthetic chart/MIDI bytes and asserts parser behavior. Needs no files on disk.
_Avoid_: "regression test" for these.

**Corpus test**:
A test that runs a real on-disk library of chart folders through the scanner and compares the output against a reference. Distinguished from a unit test by its dependency on a **corpus**.
_Avoid_: "integration test", "regression test" (both ambiguous here).

**Corpus**:
A local library of real chart folders that a corpus test consumes. Not committed to the repo; supplied by the developer running the test.

### Corpus tests

**Differential scan**:
A corpus test that runs the *same* corpus through two *versions* of scan-chart — a fixed **baseline** and the working tree — and diffs their normalized output. Detects unintended changes in parsing/hashing between versions.
_Avoid_: "version compare", "old vs new".

**Reference parity**:
A corpus test that runs the corpus through scan-chart and through an external reference implementation (**HashScanTool**) and diffs per-track hashes. Detects divergence between scan-chart and the reference parser.
_Avoid_: "ch-compare", "hashscan test".

**Baseline**:
The fixed version of scan-chart a differential scan compares the working tree against (e.g. a released tag such as `v8.0.1`). Its scan output is expensive to produce and is cached, since it does not change between runs.
_Avoid_: "old", "old version".

**Working tree**:
The current, in-development version of scan-chart under `src/`, whose output changes as the developer edits code. The side of a differential scan that is re-scanned when it changes.
_Avoid_: "new", "HEAD" (HEAD is a specific baseline alias, not the working tree).

**HashScanTool**:
The external C# reference implementation that independently parses charts and emits per-track hashes, used as the reference in a reference parity test.

**btrack**:
The binary serialization of a single track that scan-chart hashes to produce a track hash. Both scan-chart and HashScanTool emit btracks in the same on-the-wire format, so a byte diff localizes a parser divergence.

**Snapshot**:
The normalized output of running a corpus through one version of scan-chart, written as one record per chart folder (NDJSON). The version-independent contract that a differential scan diffs; binary blobs are stripped and order-insensitive arrays are sorted so byte-equal snapshots mean semantically identical results.

**Adapter**:
Version-specific code that calls one version's scan-chart API and emits a **snapshot**. Each compared version has its own adapter because the public API differs between versions; the snapshot format is what they agree on.

**Manifest**:
The shared, sorted list of chart-folder paths within a corpus that every adapter scans, so both sides of a differential scan process an identical input set.

**Diff set**:
The charts that differ between the two compared snapshots. The cheap top-level report counts the entire diff set, but expensive per-chart artifacts are produced only for it, up to a configurable cap (a full-corpus diff signals a systemic change to fix before investigating rare cases).

**Investigation bundle**:
A self-contained per-chart directory generated for a member of the diff set, holding the copied input, the structured and human-readable diff, and the structural btrack delta. Designed to be handed off whole to another developer or an AI agent as a debugging starting point.

## Current Layout

- `src/`: production library code exported through `src/index.ts` and bundled into `dist/`.
- `test/unit/`: vitest unit tests run by `npm test`.
- `test/corpus/shared/`: manifest walking, file loading, snapshot normalization/IO, btrack decoding, and investigation bundle helpers.
- `test/corpus/differential/`: baseline-vs-working-tree corpus command run by `npm run corpus:diff -- --input <corpus>`.
- `test/corpus/reference-parity/`: scan-chart-vs-HashScanTool corpus command run by `npm run corpus:parity -- --input <corpus> --ch-bin <HashScanTool.exe>`.
- `test/corpus/reference-parity/hashes-cli.ts`: developer hash JSON helper exposed as `npm run test:cli`.
- `test/corpus/snapshots/`: ignored local output for manifests, snapshots, reports, caches, and investigation bundles.

## Relationships

- A **corpus test** consumes one **corpus**; both the **differential scan** and **reference parity** are corpus tests.
- A **differential scan** compares the **working tree** against one **baseline**.
- A **reference parity** test compares the **working tree** against **HashScanTool**.
- A **track hash** is the hash of a **btrack**; differing track hashes between two versions or implementations imply differing btrack bytes.
- Each compared version has one **adapter**; an adapter consumes the **manifest** and produces one **snapshot**.
- A **differential scan** diffs two **snapshots**; it never calls a scanner directly, so versions with incompatible APIs can still be compared.

## Reference

- Canonical chart-format specification scan-chart targets: https://thenathannator.github.io/GuitarGame_ChartFormats/ — the authority used to decide which parser is correct when a differential scan or reference parity diff is investigated.
