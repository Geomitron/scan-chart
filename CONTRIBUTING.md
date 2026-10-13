# Contributing to scan-chart

## Set up

1. Clone the repository.
2. Install Node 24.6 or later. The published package runs on Node 22.22, but the tests and tools need 24.6.
3. Run `npm install`.

## Run the tests

| Command | Runs |
|---|---|
| `npm test` | The unit tests, including the examples in `readme.md` |
| `npm run test:integration` | The tests that use the file system and the tools |
| `npm run lint` | The type checks of the source, the tests, and the tools |
| `npm run vectors:verify` | The golden vectors: charts with the BTracks, TrackHashes, and SongHashes every implementation must calculate |

`npm test` type-checks and runs every TypeScript block in `readme.md`, so an example that stops compiling or running fails the tests. A block marked `ts browser` is only type-checked.

## Compare scan-chart with a chart library

These commands need a local library of song folders, which isn't in the repository.

- **Against the published package:** `npm run corpus:diff -- --input <library>` scans the library with the working tree and with the published version, and lists every folder whose results differ.
- **Against Clone Hero:** `npm run corpus:parity -- --input <library> --ch-bin <HashScanTool.exe>` compares scan-chart's hashes with those of HashScanTool, which calculates hashes with Clone Hero's own code.
- **Hashes as JSON:** `npm run test:cli -- --inputFolder <library> --outputFolder <output>` writes each song's TrackHashes.

`tools/ch-identity` builds `ch-identity`, a standalone tool that writes the reference hashes and BTracks of a song or a library. Its [README](tools/ch-identity/README.md) explains how to build and run it.

## Change the golden vectors

The vectors are in `test/golden-vectors/suites`, one folder for each approved suite, and approved suites never change. The next suite is drafted from `test/golden-vectors/cases.ts` with `npm run vectors:generate -- --out <new-folder>`, and needs review before it's promoted, because Clone Hero and the leaderboards must calculate the same results. The [golden vectors README](test/golden-vectors/README.md) has the steps.

## Release a change

Run `npx changeset` before you commit a change that users will notice, and describe the change for the release notes. [changeset-usage.md](changeset-usage.md) lists the release steps.
