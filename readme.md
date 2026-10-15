# scan-chart

scan-chart is a library to work with song folders for five fret games like Clone Hero, YARG, etc... It uses the standardized set of parsing rules that Clone Hero and YARG agree on.

This library can:

- parse just the song's metadata
- detect common chart problems
- extract generalized information and statistics about a chart
- calculate the hashes that Clone Hero's leaderboards use to tell charts apart
- edit a chart, save it, and convert it between `.chart` and `.mid`.

It is battle-tested by Chorus Encore and has been verified to match the byte-for-byte output of Clone Hero's parser. It can run in Node.js (22.22+) or in the browser.

## Install

```sh
npm install scan-chart
```

## Pass in a song folder

This library does not handle chart folder discovery or filesystem operations. You must do that yourself and pass its files to this library as an array of `SongFile`:

```ts
interface SongFile {
	readonly fileName: string
	readonly data: Uint8Array | ByteSource
}
```

`data` holds the file's bytes or a `ByteSource`, which reads the file on demand. scan-chart reads only the chart file, song.ini, and album art, and the headers of the other media files when you ask for their issues. Use a byte source for everything else, so the audio and video never have to fit in memory.

`fileName` is the file's name in the folder. If you pass the files of subfolders too, name each by its path, such as `__MACOSX/._song.ini`: games don't read them, so they're reported as files no game reads.

In Node, open each file as a `Blob` and wrap it with `byteSourceFromBlob`. The examples that follow use this `readSongFolder` function:

```ts
import { openAsBlob } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { byteSourceFromBlob, type SongFile } from 'scan-chart'

async function readSongFolder(folder: string): Promise<SongFile[]> {
	const entries = await readdir(folder, { withFileTypes: true })
	return Promise.all(entries.filter(entry => entry.isFile()).map(async entry => ({
		fileName: entry.name,
		data: byteSourceFromBlob(await openAsBlob(join(folder, entry.name))),
	})))
}
```

In a browser, a `File` is a `Blob`, so wrap the files from a folder picker the same way:

```ts browser
import { byteSourceFromBlob, type SongFile } from 'scan-chart'

function songFiles(input: HTMLInputElement): SongFile[] {
	return [...(input.files ?? [])].map(file => ({ fileName: file.name, data: byteSourceFromBlob(file) }))
}
```

## Show a song's metadata

To list songs, call `parseSongMetadata`. It reads song.ini and the `[Song]` section of a `.chart` file, but not the notes, so it takes a small fraction of a full scan:

```ts
import { parseSongMetadata } from 'scan-chart'

const { metadata, issues } = await parseSongMetadata(await readSongFolder('songs/Example Song'), { removeStyleTags: true })
console.log(`${metadata.artist} - ${metadata.name} (charted by ${metadata.charter})`)
for (const issue of issues) console.log(`${issue.code}: ${issue.message}`)
```

`metadata` holds what Clone Hero shows:

- The values come from song.ini when the song has one, and from the `.chart` `[Song]` section only when it doesn't.
- A value that isn't set is Clone Hero's default, such as `Unknown Artist`, or `-1` for a difficulty.
- Text is as the file writes it, including style tags such as `<b>` and `<color=#AEFFFF>`, which Clone Hero shows as formatting. To show plain text, pass `{ removeStyleTags: true }`, as the example does. `songMetadata` and `scanSongFolder` take the same option.
- The keys are song.ini's keys, so the guitar difficulty is `diff_guitar` and the song length is `song_length`, in milliseconds.

`issues` lists problems with the folder and its metadata, such as a missing song.ini or a misnamed chart file.

## Check a chart

To check a song in one call, use `scanSongFolder`. It returns the metadata, every issue, and the chart's statistics:

```ts
import { scanSongFolder } from 'scan-chart'

const scanned = await scanSongFolder(await readSongFolder('songs/Example Song'))
if (!scanned.playable) console.log('Clone Hero can\'t play this song: it needs a readable chart and an audio file.')
for (const issue of scanned.issues) {
	const where = issue.instrument === null ? '' : ` (${issue.instrument} ${issue.difficulty ?? ''})`
	console.log(`${issue.scope} ${issue.code}${where}: ${issue.message}`)
}
for (const { instrument, difficulty, count } of scanned.stats?.noteCounts ?? []) {
	console.log(`${instrument} ${difficulty}: ${count} notes`)
}
```

The work that costs more is off by default. Turn it on with the second argument:

| Option | Adds | Result field |
|---|---|---|
| `competitiveHashes: true` | The leaderboard hashes. Pass `{ btracks: true }` to also get each track's BTrack. | `competitive` |
| `fileHashes: true` | MD5 of the whole folder, a hash of the chart and its parse settings, and MD5 of the album art | `fileHashes` |
| `albumArt: true` | The album art file, as written, and the issues found decoding it | `albumArt` |
| `mediaIssues: true` | The issues found reading the audio, image and video files, such as an audio bitrate or the album art's size. It reads each audio and video file's headers, and the album art and background images whole | `issues` |
| `styleNotes: true` | Style notes: what every program reads the same way, such as a nonstandard spelling or a song.ini line that changes nothing | `issues` |
| `metadataStyle: true` | Guesses about the metadata's style, such as credits joined with "and", which can be wrong | `issues` |

A result field you didn't ask for is `null`.

These options adjust what's reported:

- `albumArtSizes` lists the album art sizes `albumArt` and `mediaIssues` accept, as the side of a square in pixels. It's `[512]` by default, so art that isn't 512x512 is reported.
- `extraFiles` lists the files your game reads that Clone Hero and YARG don't, as names or regular expressions, so they aren't reported as files no game reads (`unrecognizedFile`). Files an operating system made, such as `desktop.ini`, are reported anyway.
- `extraIniKeys` lists the song.ini tags your game reads that Clone Hero and YARG don't, as names or regular expressions, so they aren't reported as tags no game reads (`unknownIniTag`).

### Read the issues

Every issue has the same shape, whatever it's about:

```ts
interface Issue {
	readonly scope: 'folder' | 'metadata' | 'chart'
	readonly code: IssueCode // for example 'noStarPower' or 'unsortedChartLines'
	readonly severity: 'error' | 'warning' | 'recommendation'
	readonly instrument: Instrument | null // null when it's about more than one instrument
	readonly difficulty: Difficulty | null
	readonly tick: number | null // where in the chart, or null for a whole track or file
	readonly msTime: number | null
	readonly file: string | null // the file it's about, as named in the folder, or null for a chart issue
	readonly message: string
}
```

`file` names the file a folder or metadata issue is about, such as a misnamed audio file, or the song.ini a metadata issue is in. It's `null` for a chart issue, and for an issue about no one file, such as a missing chart.

The severity says how much an issue matters:

- **`error`:** a game can't read the file, or games read it differently.
- **`warning`:** games read it alike, but it's probably a mistake, such as a sustain that ends less than 40 ms before the next note.
- **`recommendation`:** it works, but doesn't follow a charting recommendation, such as a sustain gap of at least 60 ms. A check with a recommendation reports a sustain gap from 40 to 60 ms at this severity, and one under 40 ms as a warning.

Some issues are about how a file is written rather than what it plays. They come in two kinds:

- **Compatibility issues** are on by default. They describe spellings that Clone Hero or another program reads differently, or can't read at all. For example, Clone Hero refuses a `.chart` file whose tick numbers go backwards (`unsortedChartLines`).
- **Style notes** are off by default. They describe spellings that every program reads the same way, such as a `.chart` line written twice (`duplicateChartLine`). In song.ini, they're tags out of the standard order (`iniTagOrder`), `-1` numbers and blank text values (`blankIniValue`), and lines that change nothing, such as `delay = 0` (`defaultIniValue`). A blank number is reported without them, as `blankIniNumber`, since Clone Hero reads it as not set and YARG as 0.

A chart can list the issues it means to have in song.ini, as codes separated by commas:

```ini
ignored_issues = discouragedAudio, albumArtSize
```

`scanSongFolder` moves the issues of those codes from `issues` to `ignoredIssues`. Only warnings and recommendations can be ignored: an error stays in `issues`. A listed code that isn't an issue code, or is an error's, is reported as `invalidValue`.

### Check it step by step

`scanSongFolder` runs three steps. Call them yourself when you want the notes as well as the issues:

```ts
import { analyzeChart, parseSong, resolveChart } from 'scan-chart'

const song = await parseSong(await readSongFolder('songs/Example Song'))
const chart = resolveChart(song)
for (const track of chart.tracks) {
	console.log(`${track.instrument} ${track.difficulty}: ${track.noteGroups.length} notes and chords, ${track.starPower.length} star power phrases`)
}
const { issues, stats } = analyzeChart(chart)
console.log(`${issues.length} issues, ${stats.tempoMarkerCount} tempo markers`)
```

- `parseSong` reads the files into a `SongDocument`: the chart file and song.ini as they're written.
- `resolveChart` gives the chart as Clone Hero plays it: tempos, time signatures, practice sections, and each track's notes, with their times in milliseconds. It throws `ChartReadError` if the song has no chart or Clone Hero can't read it.
- `analyzeChart` finds the chart's issues and calculates its statistics.

## Calculate competitive hashes

Clone Hero's leaderboards compare scores only when they were played on the same chart. These hashes decide that:

- a **TrackHash** for each instrument and difficulty;
- a **SongHash** for the whole song;
- a **tempo map hash**.

They're in the `scan-chart/competitive` entry point:

```ts
import { calculateCompetitiveHashes } from 'scan-chart/competitive'
import { parseSong } from 'scan-chart'

const hashes = calculateCompetitiveHashes(await parseSong(await readSongFolder('songs/Example Song')))
if (hashes.accepted) {
	console.log(`SongHash ${hashes.songHash}, ${hashes.songDurationMs} ms`)
	for (const track of hashes.tracks) console.log(`${track.instrument} ${track.difficulty}: ${track.trackHash}`)
} else {
	console.log(`No hashes: ${hashes.reason}`)
}
```

A chart that the hash rules reject has no hashes, and `reason` says why. To also get each track's BTrack, the binary file its TrackHash is calculated from, pass `{ btracks: true }` as the second argument.

The same entry point exports the specification the hashes are defined by. `canonical20260801` defines the hashes Clone Hero uses now, and `frozenLegacy6142` the hashes Clone Hero 1.1 calculated. `songBundle20251010` calculates both kinds at once.

## Edit and save a song

### Find what to edit

`authoredTracks` lists a chart's tracks as the file writes them, with each event's position, length, and type:

```ts
import { authoredTracks, parseSong } from 'scan-chart'

const song = await parseSong(await readSongFolder('songs/Example Song'))
if (song.chart === null) throw new Error('The folder has no chart file')
for (const track of authoredTracks(song.chart)) {
	console.log(`${track.instrument} ${track.difficulty ?? 'all difficulties'}: ${track.events.length} events${track.isRead ? '' : ' (Clone Hero ignores this one)'}`)
}
```

- A `.chart` file has a track for each instrument and difficulty. A `.mid` file has one track for each instrument, holding every difficulty, so its `difficulty` is `null`.
- An event is a note, a note modifier such as `forceTap`, or a phrase such as `starPower`. Its `type` is a name.
- `authoredSongEvents` gives the tempo markers, time signatures, and text events, such as practice sections.

### Make edits

`editSong` applies a batch of edits and returns a new song. The song you pass in doesn't change, so to undo, keep the earlier song:

```ts
import { authoredTracks, editSong, parseSong } from 'scan-chart'

const song = await parseSong(await readSongFolder('songs/Example Song'))
const expert = authoredTracks(song.chart!).find(track => track.instrument === 'guitar' && track.difficulty === 'expert' && track.isRead)
if (expert === undefined) throw new Error('No Expert guitar track')

const edited = editSong(song, batch => {
	batch.setLength(expert.events[0], 96)
	batch.addEvent(expert, 768, 'red', 0)
	batch.addTextEvent(768, 'section Chorus')
	batch.setMetadata('loading_phrase', 'Watch out for the chorus')
})
```

- `setTick`, `setLength`, and `remove` change events, tempo markers, time signatures, and text events.
- `setTempo`, `setTimeSignature`, and `setText` change their values. `addTempo`, `addTimeSignature`, and `addTextEvent` add new ones.
- `addEvent` adds a note, a modifier, or a phrase. In a `.mid` track, say which difficulty it's for: `{ scope: 'expert' }`. An event that means nothing on the instrument, such as a tap on drums, throws a `RangeError`.
- `addTrack` adds a track for an instrument and difficulty, and returns it, so `addEvent` can fill it in the same batch. It throws a `RangeError` if Clone Hero already reads events for that instrument and difficulty.
- `setMetadata` sets a song.ini value, or removes it with `null`. A song without song.ini gets one, holding the `[Song]` values Clone Hero read, so only your edit reads differently.

### Save the song

`serializeSong` returns a save plan: every file of the folder, and a report of what saving did. The files you didn't change are still byte sources, read only when you write them. Write the files to a new folder:

```ts
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { editSong, parseSong, serializeSong, writeSavePlanFile } from 'scan-chart'

const song = await parseSong(await readSongFolder('songs/Example Song'))
const edited = editSong(song, batch => batch.setMetadata('genre', 'Rock'))
const plan = serializeSong(edited)
console.log(`Rewrote ${plan.report.normalized.length} nonstandard spellings`)

const output = 'songs/Example Song (edited)'
await mkdir(output, { recursive: true })
for (const file of plan.files) {
	await writeSavePlanFile(file, Writable.toWeb(createWriteStream(join(output, file.fileName))))
}
```

Don't write a save plan over the folder it came from. A file you didn't change is copied from the original while it's written, so writing it over itself would destroy it.

In a browser, `savePlanToBlobs` gives each file as a `Blob`, ready to download.

The report says what saving changed beyond your edits:

- `normalized` lists the nonstandard spellings saving rewrote, such as lines out of tick order or missing Windows line endings.
- `withheld` lists the ones it left alone, because rewriting them would change a TrackHash or the SongHash that your edits didn't change. The hashes Clone Hero 1.1 calculated aren't kept: a rewrite may change them.
- `spentHashes` lists the TrackHashes and SongHash your edits changed.

If you didn't edit the song, its save plan holds every file byte for byte, and nothing is normalized.

### Fix issues

`fixIssues` fixes the issues it can: it scans the song, makes each fix where the scan reports its issue, and returns a new song with a report. Save the fixed song like an edited one:

```ts
import { fixIssues, parseSong, serializeSong } from 'scan-chart'

const song = await parseSong(await readSongFolder('songs/Example Song'))
const { song: fixed, report } = await fixIssues(song)
console.log(`${report.fixed.length} fixes, ${report.renamed.length} files renamed`)
for (const { code, file, description } of report.fixed) console.log(`${code} in ${file}: ${description}`)
for (const { code, reason } of report.skipped) console.log(`${code} not fixed: ${reason}`)
const plan = serializeSong(fixed)
```

- `issueFixes` lists the codes `fixIssues` fixes, and what each fix does to the TrackHashes and the SongHash: `keepsHashes` keeps them; `mayChangeHashes` keeps them on some songs, such as unquoting a loading phrase, and changes them on others, such as unquoting a song name, which the SongHash reads; `changesHashes` changes them.
- By default, it makes only the fixes that keep every hash: each `keepsHashes` fix, and each `mayChangeHashes` fix where it keeps them. Pass `changeHashes: true` to make the others too, such as shortening each sustain that ends too close to the next note, and removing each sustain that's too short. `sustainGapMs` and `minSustainMs` set how close and how short: 60 and 200 milliseconds by default, as the charting guidelines recommend.
- Some fixes rewrite the chart so it plays the same without an older song.ini tag: the notes `hopo_frequency` or `eighthnote_hopo` change are forced, and `multiplier_note = 103`'s star power moves to note 116. Each fix meant to keep how the song plays is checked by reading the result back: if a note, a phrase or a hash would change, it isn't made.
- `codes` limits it to some codes. It doesn't fix a code song.ini's `ignored_issues` lists.
- scan-chart has no image codec, so to resize square album art, pass `resizeImage`: a function that resizes an image to a square of the given side with your app's image library, such as sharp or a canvas, and returns a PNG or JPEG image. `albumArtSizes` gives the sizes it accepts, as for `scanSongFolder`, and art is resized to the first.
- It reads the media files as `mediaIssues` does: the audio files' headers, which also give the `song_length` it writes, and the album art and background images whole.
- The report lists each fix made, each issue left and why, the files renamed, and each hash that changed. A renamed file has its new name in the song's files: when you write the song back to its folder, remove the old file.

### Convert between `.chart` and `.mid`

`convertChart` gives a new song in the other format, and a report read back from the result:

```ts
import { convertChart, parseSong } from 'scan-chart'

const song = await parseSong(await readSongFolder('songs/Example Song'))
const { song: converted, report } = convertChart(song, 'mid')
for (const track of report.tracks) {
	if (!track.kept) console.log(`${track.instrument} ${track.difficulty} changes: ${track.causes.join(', ')}`)
}
for (const { content, count } of report.dropped) console.log(`Left out: ${count} ${content}`)
for (const { key, value } of report.settings) console.log(`song.ini: ${key} = ${value}`)
```

Save `converted` like any other song. Converting writes only the song.ini settings the new format needs:

- **To `.mid`:** a `.mid` file holds one set of star power and solos for each instrument, so they come from the Expert track. `sustain_cutoff_threshold` is written only when `.mid` would otherwise shorten a sustain. `multiplier_note` is written only when a solo would otherwise read as star power.
- **To `.chart`:** vocal pitches, harmonies, and MIDI-only tracks such as the venue are left out. Lyrics and vocal phrases are kept.

A tempo below 3.58 BPM or a time signature over 255 doesn't fit in a `.mid` file, and converting throws `ConversionError`. To write the nearest value instead, pass `{ force: true }`. A resolution over 32767 ticks per beat has no nearest value, so that chart can't be converted to `.mid`.

### Start a new song

`createSong` makes a song with one tempo marker and one time signature, and a song.ini that holds the metadata you give it. Add its tracks with `addTrack`:

```ts
import { createSong, editSong } from 'scan-chart'

const song = createSong({ format: 'chart', metadata: { name: 'New Song', artist: 'New Band', charter: 'You' } })
const charted = editSong(song, batch => {
	const expert = batch.addTrack('guitar', 'expert')
	batch.addEvent(expert, 0, 'green', 0)
	batch.addEvent(expert, 192, 'red', 96)
	batch.addTextEvent(0, 'section Intro')
})
```

The resolution is 192 ticks per beat for `.chart` and 480 for `.mid`, unless you pass `resolution`. Save the new song like any other.

## Handle errors

| Error | Thrown when |
|---|---|
| `ChartReadError` | `resolveChart` or `convertChart` gets a song with no chart, or with a chart Clone Hero can't read. |
| `ConversionError` | `convertChart` meets a value the new format can't hold. Its `limits` list each value. |
| `RangeError` | An edit doesn't fit the chart: an event the instrument can't use, a value song.ini can't hold, or an edit to a song.ini that isn't UTF-8. |

`parseSong`, `parseSongMetadata`, and `scanSongFolder` don't throw for a malformed chart or song.ini. They report it as an issue.

## Learn more

- [Release notes](CHANGELOG.md), including how to move from scan-chart 8.
- [Contributing](CONTRIBUTING.md): running the tests and the tools that compare scan-chart with Clone Hero.
