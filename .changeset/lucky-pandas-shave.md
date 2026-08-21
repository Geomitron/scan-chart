---
'scan-chart': patch
---

Fix `hasVocals` treating a lyrics-only chart as a vocals chart

`notesData.hasVocals` was derived from `notePhrases.length > 0`, but a phrase is
only a range marker — lyrics live inside phrases that need not hold any vocal
note. Every chart that ships lyrics therefore reported `hasVocals: true` and
raised a spurious `Metadata is missing a "diff_vocals" value.` issue. This was
guaranteed for the `.chart` format, which cannot encode a vocal note at all.

`hasVocals` now requires a vocal note inside a phrase. `hasLyrics` is unchanged,
and the `noNotes` check still accepts a lyrics-only vocal phrase as content.

Note the other side of this: a lyrics-only chart that *sets* `diff_vocals` now
reports `Metadata contains "diff_vocals", but vocals are not charted.` where it
previously reported nothing.
