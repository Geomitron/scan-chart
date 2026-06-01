# Tests

`test/unit` contains in-memory vitest unit tests.

Run the library against a local chart folder or corpus and print the JSON output with:

```bash
$ npm run scan -- --input <chart-or-corpus>
```

`test/corpus` contains bring-your-own corpus tests:

- Differential scan: `npm run corpus:diff -- --input <corpus>`
- Reference parity: `npm run corpus:parity -- --input <corpus> --ch-bin <HashScanTool.exe>`

Corpus snapshots, reports, caches, and investigation bundles are written under `test/corpus/snapshots/`. The corpus and HashScanTool binary are local inputs and are not committed.

Vocabulary is defined in `../CONTEXT.md`.
