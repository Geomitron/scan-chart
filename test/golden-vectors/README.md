# BTrack golden vectors

Version 5 is the current canonical TrackHash and SongHash reference suite.
Run it with:

```text
npm run vectors:verify
```

See `suites/v5/README.md` for coverage, compatibility policy, and the changes
from version 4. Older suite directories remain immutable for audit history.

## Drafting the next suite

`cases.ts` holds the authored cases of the next suite, version 6. Like version 5,
the latest approved suite, it covers the canonical `canonical-20260801` profile
only and includes song vectors: a song folder in, the canonical SongHash out.
Both use manifest schema version 2; suites v1 and v2 use schema version 1, and
the verifier reads both.

```text
npm run vectors:generate -- --out <new-directory>
npm run vectors:verify -- --suite <draft-directory>
```

The generator refuses an existing directory and any path inside `suites/`.
Promoting a draft copies it into a new `suites/<version>/` directory and changes
`currentSuite` in `verify.ts`.
