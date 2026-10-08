# BTrack golden vectors

Version 2 is the current BTrack, TrackHash, and source-parser reference suite.
Run it with:

```text
npm run vectors:verify
```

See `suites/v2/README.md` for coverage, compatibility policy, and the version 1
correction. Older suite directories remain immutable for audit history.

## Drafting the next suite

`cases.ts` holds the authored cases of the next suite, version 3, which covers
the canonical `canonical-20260801` profile only and adds song vectors: a song
folder in, the canonical SongHash out. It uses manifest schema version 2;
suites v1 and v2 use schema version 1, and the verifier reads both.

```text
npm run vectors:generate -- --out <new-directory>
npm run vectors:verify -- --suite <draft-directory>
```

The generator refuses an existing directory and any path inside `suites/`.
Promoting a draft copies it into a new `suites/<version>/` directory and changes
`currentSuite` in `verify.ts`.
