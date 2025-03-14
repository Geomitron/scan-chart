# scan-chart

## 6.1.1

### Patch Changes

- 74f492e: Handle tracks with 0 notes in maxNps

## 6.1.0

### Minor Changes

- d782f39: Remove noStarPower issue on drums

## 6.0.0

### Major Changes

- 8d7263d: Changed tick in bchart to int64

## 5.0.0

### Major Changes

- 5952a81: Changed millibeatsPerMinute to beatsPerMinute, and increased .mid BPM precision

## 4.2.1

### Patch Changes

- e44502a: Update README

## 4.2.0

### Minor Changes

- cec4a6c: Make iniChartModifiers optional

## 4.1.5

### Patch Changes

- 6418ade: Fix interface name

## 4.1.4

### Patch Changes

- 3166de2: Fix noNotes bug

## 4.1.3

### Patch Changes

- 97ac4de: Remove node dependencies

## 4.1.2

### Patch Changes

- 5eed0b1: Export additional interfaces

## 4.1.1

### Patch Changes

- c85480f: Fix maxNps calculation
- e35e997: Fix pnpm build

## 4.1.0

### Minor Changes

- f318a0d: Add chord_snap_threshold

## 4.0.5

### Patch Changes

- f09f3d9: Prune unnecessary issues for short songs

## 4.0.4

### Patch Changes

- db01d18: Fix badSustainGap bug

## 4.0.3

### Patch Changes

- 95cf1c2: Fix image parsing

## 4.0.2

### Patch Changes

- 64325ec: Improve removeStyleTags

## 4.0.1

### Patch Changes

- 180cfcf: Fix capitalization and improve removeStyleTags

## 4.0.0

### Major Changes

- c99e3a3: Full rewrite of chart parsing and issue detection, adding missing functionality and fixing many bugs. Added a more sophisticated track hashing algorithm, which is designed to uniquely identify the features of the chart that impact difficulty and scoring, and ignore any other changes, which makes it suitable for use with leaderboards. Clone Hero's leaderboards use this same system. The scope of this package has also been limited to just expose functions that parse a single chart file. This allows the package to run in both Node.js and Browser contexts.

## 3.4.8

### Patch Changes

- 7fd4f7e: Allow no notes if there is a vocals track

## 3.4.7

### Patch Changes

- 02b3a09: Fix for some charts being incorrectly flagged as unplayable

## 3.4.6

### Patch Changes

- a5690bf: Fix for some charts being incorrectly flagged as playable

## 3.4.5

### Patch Changes

- 49dd04f: Fix open/tap/force modifiers in .mid parsing

## 3.4.4

### Patch Changes

- 8bfdb05: Improve performance

## 3.4.3

### Patch Changes

- c5e225e: Update dependencies

## 3.4.2

### Patch Changes

- d62a214: Ignore invalid track name meta events

## 3.4.1

### Patch Changes

- 49816d7: Fix vocals and sustains detection

## 3.4.0

### Minor Changes

- 3df1a89: Added drumType and related features

## 3.3.5

### Patch Changes

- a38f98c: Fix import
- ee16732: Internal refactor

## 3.3.4

### Patch Changes

- bb5a75b: Allow .jpeg extension

## 3.3.3

### Patch Changes

- bedff88: Fixed instruments array bug

## 3.3.2

### Patch Changes

- 04a1f62: Remove console log

## 3.3.1

### Patch Changes

- af91094: Allow more types of open chords

## 3.3.0

### Minor Changes

- 268c622: Added noNotesOnNonemptyTrack track issue

## 3.2.0

### Minor Changes

- fb44a5e: Add badVideo and multipleVideo issues, buxfixing

## 3.1.5

### Patch Changes

- c07e0c4: Bugfixing

## 3.1.4

### Patch Changes

- 354e68b: Add folder issues for audio

## 3.1.3

### Patch Changes

- f306f4a: Bugfixes

## 3.1.2

### Patch Changes

- bec6244: Bugfixes

## 3.1.1

### Patch Changes

- d118b0a: Update dependencies

## 3.1.0

### Minor Changes

- 6e969b3: Prevent scanning charts if they contain other charts in their files

## 3.0.0

### Major Changes

- 7347df3: Add guitarcoopghl and rhythmghl instruments

## 2.0.0

### Major Changes

- 5f29e5a: Improved ScannedChart interface

## 1.12.2

### Patch Changes

- c692e79: Update dependencies

## 1.12.1

### Patch Changes

- 7f40077: Update dependencies

## 1.12.0

### Minor Changes

- ebf0cec: Add diff_guitar_coop and extraInstrumentDiff

## 1.11.3

### Patch Changes

- e5fc801: Update dependencies

## 1.11.2

### Patch Changes

- 8e0ae35: Update dependencies

## 1.11.1

### Patch Changes

- c131d04: Update AlbumArt docs

## 1.11.0

### Minor Changes

- 9342058: Allow GB and RO chords on hard difficulty

## 1.10.0

### Minor Changes

- abb35a0: Add isSng

### Patch Changes

- 92356dd: Update chartPath for .sng files

## 1.9.0

### Minor Changes

- 4759cb7: Add onlyScanSng

## 1.8.1

### Patch Changes

- 1b266bb: Fix uncaught exception

## 1.8.0

### Minor Changes

- a621e99: Added hasRollLanes

## 1.7.1

### Patch Changes

- a752512: Update dependencies

## 1.7.0

### Minor Changes

- 9460c40: Use ReadableStream

## 1.6.1

### Patch Changes

- 1ba8dee: Fix .sng parsing

## 1.6.0

### Minor Changes

- bffcd8e: Add .sng support

### Patch Changes

- 52d0ed3: Fix dependencies

## 1.5.0

### Minor Changes

- 3ceaee6: Add chartMd5

## 1.4.0

### Minor Changes

- 88e1132: Add hasVideoBackground

## 1.3.0

### Minor Changes

- 50ded94: Add diff_vocals

## 1.2.0

### Minor Changes

- bef6a54: Add hasVocals

### Patch Changes

- f4a12e7: Update README

## 1.1.4

### Patch Changes

- 0b0b185: Fixed previous patch deployment

## 1.1.3

### Patch Changes

- 0f77cb5: Allow videos and audio files to be larger than 2 GiB

## 1.1.2

### Patch Changes

- d5f72aa: Remove unused dependencies

## 1.1.1

### Patch Changes

- 14da0ae: Remove unused dependencies

## 1.1.0

### Minor Changes

- bcfe8e3: Added README
