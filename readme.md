This package scans charts for rhythm games like Clone Hero and produces useful metadata about them.

`parseChartFile` has been designed to produce the exact same result as Clone Hero.
This has been validated on 40,000 charts, including some that were deliberately designed to test parsing edge cases.

# Testing

Before running tests, you need the following:

- Locally clone the repository
- Install NodeJS >= v24.6.0
- Run `npm i`

To run tests, use:

```bash
$ npx tsx src/test.ts
```

Note: running this will print usage information. Add command line arguments to this to specify testing parameters.

# API

```ts
/**
 * Parses a chart folder's `notes.{mid,chart}` and `song.ini` into a `ParsedChart`.
 * No hashing or audio/image scanning.
 */
function parseChartAndIni(files: { fileName: string; data: Uint8Array }[]): ParseChartAndIniResult

/**
 * Validates, hashes, and asset-scans the parsed chart folder. Pair with
 * `parseChartAndIni()` to get the input.
 */
function scanChart(files: { fileName: string; data: Uint8Array }[], parseResult: ParseChartAndIniResult, config?: ScanChartConfig): ScannedChart

function parseChartFile(data: Uint8Array, format: 'chart' | 'mid', iniChartModifiers: IniChartModifiers): ParsedChart
function calculateTrackHash(parsedChart: ParsedChart, instrument: Instrument, difficulty: Difficulty): { hash: string, btrack: Uint8Array }

interface ScanChartConfig {
	/**
	 * Set this to false to skip calculating `ScannedChart.md5`. It will be set to 'md5 calculation skipped' instead.
	 *
	 * Default: `true`.
	 */
	includeMd5?: boolean

	/**
	 * Set this to true to calculate `ScannedChart.notesData.trackHashes[].btrack`. Otherwise, it will have the value `null`.
	 *
	 * Default: `false`.
	 */
	includeBTrack?: boolean

	/**
	 * Set this to false to skip parsing `ScannedChart.albumArt`. It will be set to `null` instead.
	 *
	 * Default: `true`.
	 */
	includeAlbumArt?: boolean
}

interface ParseChartAndIniResult {
	/** The parsed chart, or `null` if a chart file could not be found or could not be parsed. Inspect `chartFolderIssues` for the reason. */
	parsedChart: ParsedChart | null
	/** `true` if the folder contains a parseable `song.ini`. */
	hasIni: boolean
	/** Folder-level issues from chart file discovery and parsing (`noChart`, `invalidChart`, `multipleChart`, `badChart`). */
	chartFolderIssues: { folderIssue: FolderIssueType; description: string }[]
	/** The metadata parsed from `song.ini`, or `null` if no ini was present. */
	iniMetadata: { /* same shape as defaultMetadata */ } | null
	/** Folder-level issues from ini scanning (`noMetadata`, `invalidIni`, `invalidMetadata`, `badIniLine`, `multipleIniFiles`). */
	iniFolderIssues: { folderIssue: FolderIssueType; description: string }[]
	/** Validation issues with ini values. */
	iniMetadataIssues: { metadataIssue: MetadataIssueType; description: string }[]
}

interface ScannedChart {
	/** An MD5 hash of the names and binary contents of every file in the chart. */
	md5: string
	/** A blake3 hash of just the chart file and the .ini modifiers that impact chart parsing. If this changes, the in-game score is reset. */
	chartHash: string
	/** If the chart is able to be played in-game. This is `false` if `notesData` is `null`. */
	playable: boolean

	/** Metadata read from the chart's song.ini or .chart [Song] section. */
	metadata: ScannedChartMetadata

	/** The chart's album art, or `null` if there is no album art. */
	albumArt: AlbumArt | null
	/** Data describing properties of the .chart or .mid file, or `null` if the .chart or .mid file doesn't exist or couldn't be parsed. */
	notesData: NotesData | null
	/** Issues with the chart files. */
	folderIssues: { folderIssue: FolderIssueType; description: string }[]
	/** Issues with the chart's metadata. */
	metadataIssues: { metadataIssue: MetadataIssueType; description: string }[]
	/** `true` if the chart has a video background. */
	hasVideoBackground: boolean
}

interface ScannedChartMetadata {
	/** The song name. */
	name?: string
	/** The song artist. */
	artist?: string
	/** The song album. */
	album?: string
	/** The song genre. */
	genre?: string
	/** The song year. */
	year?: string
	/** The chart's charter(s). */
	charter?: string
	/** The length of the chart's audio, in milliseconds. If there are stems, this is the length of the longest stem. */
	song_length?: number
	/** The difficulty rating of the chart as a whole. Usually an integer between 0 and 6 (inclusive) */
	diff_band?: number
	/** The difficulty rating of the lead guitar chart. Usually an integer between 0 and 6 (inclusive) */
	diff_guitar?: number
	/** The difficulty rating of the co-op guitar chart. Usually an integer between 0 and 6 (inclusive) */
	diff_guitar_coop?: number
	/** The difficulty rating of the rhythm guitar chart. Usually an integer between 0 and 6 (inclusive) */
	diff_rhythm?: number
	/** The difficulty rating of the bass guitar chart. Usually an integer between 0 and 6 (inclusive) */
	diff_bass?: number
	/** The difficulty rating of the drums chart. Usually an integer between 0 and 6 (inclusive) */
	diff_drums?: number
	/** The difficulty rating of the Phase Shift "real drums" chart. Usually an integer between 0 and 6 (inclusive) */
	diff_drums_real?: number
	/** The difficulty rating of the keys chart. Usually an integer between 0 and 6 (inclusive) */
	diff_keys?: number
	/** The difficulty rating of the GHL (6-fret) lead guitar chart. Usually an integer between 0 and 6 (inclusive) */
	diff_guitarghl?: number
	/** The difficulty rating of the GHL (6-fret) co-op guitar chart. Usually an integer between 0 and 6 (inclusive) */
	diff_guitar_coop_ghl?: number
	/** The difficulty rating of the GHL (6-fret) rhythm guitar chart. Usually an integer between 0 and 6 (inclusive) */
	diff_rhythm_ghl?: number
	/** The difficulty rating of the GHL (6-fret) bass guitar chart. Usually an integer between 0 and 6 (inclusive) */
	diff_bassghl?: number
	/** The difficulty rating of the vocals chart. Usually an integer between 0 and 6 (inclusive) */
	diff_vocals?: number
	/** The number of milliseconds into the song where the chart's audio preview should start playing. */
	preview_start_time?: number
	/** The name of the icon to be displayed on the chart. Usually represents a charter or setlist. */
	icon?: string
	/** A text phrase that will be displayed before the chart begins. */
	loading_phrase?: string
	/** The ordinal position of the song on the album. This is `undefined` if it's not on an album. */
	album_track?: number
	/** The ordinal position of the chart in its setlist. This is `undefined` if it's not on a setlist. */
	playlist_track?: number
	/** `true` if the chart is a modchart. This only affects how the chart is filtered and displayed, and doesn't impact gameplay. */
	modchart?: boolean
	/** The amount of time the game should delay the start of the track in milliseconds. */
	delay?: number
	/** The amount of time the game should delay the start of the track in seconds. */
	chart_offset?: number
	/** Overrides the default HOPO threshold with a specified value in ticks. Only applies to .mid charts. */
	hopo_frequency?: number
	/** Sets the HOPO threshold to be a 1/8th step. Only applies to .mid charts. */
	eighthnote_hopo?: boolean
	/** Overrides the .mid note number for Star Power on 5-Fret Guitar. Valid values are 103 and 116. Only applies to .mid charts. */
	multiplier_note?: number
	/**
	 * For .mid charts, setting this causes any sustains shorter than the threshold (in number of ticks) to be reduced to length 0.
	 * By default, this happens to .mid sustains shorter than 1/12 step.
	 */
	sustain_cutoff_threshold?: number
	/**
	 * Notes at or closer than this threshold (in number of ticks) will be merged into a chord.
	 * All note and modifier ticks are set to the tick of the earliest merged note.
	 * All note sustains are set to the length of the shortest merged note.
	 */
	chord_snap_threshold?: number
	/**
	 * The amount of time that should be skipped from the beginning of the video background in milliseconds.
	 * A negative value will delay the start of the video by that many milliseconds.
	 */
	video_start_time?: number
	/** `true` if the "drums" track should be interpreted as 5-lane drums. */
	five_lane_drums?: boolean
	/** `true` if the "drums" track should be interpreted as 4-lane pro drums. */
	pro_drums?: boolean
	/**
	 * `true` if the chart's end events should be used to end the chart early. Most games will ignore this,
	 * and instead use end events if and only if they are between the last note and the end of the audio.
	 */
	end_events?: boolean
}

interface AlbumArt {
	/** The binary buffer of the album art image, in the .jpg format (quality 75%), resized to 512x512. */
	data: Uint8Array
	/** The MD5 hash of `data`. */
	md5: string
}

interface NotesData {
	/** The list of instruments that contain more than zero notes. */
	instruments: Instrument[]
	/** The type of drums that are charted. `null` if drums are not charted. */
	drumType: DrumType | null
	/** If a solo section event occurs in any track. */
	hasSoloSections: boolean
	/** If the chart contains any lyric events. */
	hasLyrics: boolean
	/** If the chart contains a "vocals" track. */
	hasVocals: boolean
	/** If a forced note event occurs in any track. */
	hasForcedNotes: boolean
	/** If a tap note event occurs in any track. */
	hasTapNotes: boolean
	/** If an open note event occurs in any track. */
	hasOpenNotes: boolean
	/** If a 2xKick event occurs in any "drums" track. */
	has2xKick: boolean
	/** If a single or double roll lane event occurs in any "drums" track, or a trill or tremolo lane event occurs in any 5-fret track. */
	hasFlexLanes: boolean
	/** Issues detected in the chart file. */
	chartIssues: {
		/** `null` if the issue applies to all instruments. */
		instrument: Instrument | null
		/** `null` if the issue applies to all difficulties. */
		difficulty: Difficulty | null
		noteIssue: ChartIssueType
		description: string
	}[]
	/** The number of individual notes in the chart. Does not include star power, solo markers, or activation lanes. */
	noteCounts: {
		instrument: Instrument
		difficulty: Difficulty
		count: number
	}[]
	/** The one-second region in each track where the notes-per-second is highest. */
	maxNps: {
		instrument: Instrument
		difficulty: Difficulty
		/** Time of the first note in the high NPS region, in milliseconds. Rounded to 3 decimal places. */
		time: number
		/** The notes-per-second in this region. */
		nps: number
	}[]
	/**
	 * Hashes of each track. This is specifically designed to change if and only if the chart changes in a way that impacts scoring or difficulty.
	 * This means it is useful for games to use this to determine which charts should share the same leaderboard.
	 *
	 * Detailed information on how this is calculated can be found here: https://drive.google.com/open?id=1AfZMSc687C1PZCoAWKQDhdAExV7Pt45t6adz71szd3U
	 */
	trackHashes: {
		instrument: Instrument
		difficulty: Difficulty
		hash: string
		/** The full btrack data for this track. `hash` is derived from this. `null` if `ScanChartConfig.includeBTrack` is `false`. */
		btrack: Uint8Array<ArrayBuffer> | null
	}[]
	/** MD5 hash of the chart's tempo map, including BPM markers and time signature markers. */
	tempoMapHash: string
	/** The number of BPM markers in the chart. */
	tempoMarkerCount: number
	/**
	 * The amount of time between the chart's first and last note starts in milliseconds. Rounded to 3 decimal places.
	 * If there are multiple tracks, the first note start is the earliest first note across all the tracks,
	 * and the last note start is the latest last note across all the tracks.
	 */
	effectiveLength: number
}

type Instrument = (typeof instruments)[number]
const instruments = [
	'guitar',        // Lead Guitar
	'guitarcoop',    // Co-op Guitar
	'rhythm',        // Rhythm Guitar
	'bass',          // Bass Guitar
	'drums',         // Drums
	'keys',          // Keys
	'guitarghl',     // GHL (6-fret) Lead Guitar
	'guitarcoopghl', // GHL (6-fret) Co-op Guitar
	'rhythmghl',     // GHL (6-fret) Rhythm Guitar
	'bassghl',       // GHL (6-fret) Bass Guitar
] as const

type InstrumentType = ObjectValues<typeof instrumentTypes>
const instrumentTypes = {
	sixFret: 0,
	fiveFret: 1,
	drums: 2,
} as const

type DrumType = ObjectValues<typeof drumTypes>
const drumTypes = {
	fourLane: 0,
	fourLanePro: 1,
	fiveLane: 2,
} as const

type Difficulty = (typeof difficulties)[number]
const difficulties = [
	'expert',
	'hard',
	'medium',
	'easy',
] as const

type ChartIssueType =
	| 'misalignedTimeSignature' // This time signature marker doesn't appear at the start of a measure
	| 'noNotes'                 // This chart has no notes
	| 'noExpert'                // One of this chart's instruments has Easy, Medium, or Hard charted but not Expert
	| 'difficultyNotReduced'    // The notes of this difficulty are identical to the notes of a higher difficulty
	| 'isDefaultBPM'            // This chart has only one 120 BPM marker and only one 4/4 time signature
	| 'noSections'              // This chart has no sections
	| 'badEndEvent'             // This end event is in an invalid location and will be ignored by most games
	| 'smallLeadingSilence'     // This track has a note that is less than 2000ms after the start of the track
	| 'noStarPower'             // This track has no star power (not included if there are fewer than 50 notes or the song is less than a minute)
	| 'emptyStarPower'          // This star power phrase does not apply to any notes
	| 'badStarPower'            // This star power is being ignored due to the .ini "multiplier_note" setting
	| 'emptySoloSection'        // This solo section does not contain any notes
	| 'noDrumActivationLanes'   // This track has no activation lanes (not included if there are fewer than 50 notes or the song is less than a minute)
	| 'emptyFlexLane'           // This flex lane does not apply to any notes
	| 'difficultyForbiddenNote' // This is a note or drum lane that isn't allowed on the track's difficulty
	| 'invalidChord'            // The use of this type of chord is strongly discouraged
	| 'brokenNote'              // This note is so close to the previous note that this was likely a charting mistake
	| 'badSustainGap'           // This note is not far enough ahead of the previous sustain
	| 'babySustain'             // The sustain on this note is too short
	| 'invalidLyric'            // A lyric event was found on the EVENTS track in a .mid chart and will not be displayed
	| 'invalidPhraseStart'      // A phrase_start text event was found on the EVENTS track in a .mid chart
	| 'invalidPhraseEnd'        // A phrase_end text event was found on the EVENTS track in a .mid chart

type FolderIssueType =
	| 'noMetadata'              // This chart doesn't have "song.ini"
	| 'invalidIni'              // .ini file is not named "song.ini"
	| 'invalidMetadata'         // "song.ini" doesn't have a "[Song]" section
	| 'badIniLine'              // This line in "song.ini" couldn't be parsed
	| 'multipleIniFiles'        // This chart has multiple .ini files
	| 'noAlbumArt'              // This chart doesn't have album art
	| 'albumArtSize'            // This chart's album art is not 500x500 or 512x512
	| 'badAlbumArt'             // This chart's album art couldn't be parsed
	| 'multipleAlbumArt'        // This chart has multiple album art files
	| 'noAudio'                 // This chart doesn't have an audio file
	| 'invalidAudio'            // Audio file is not a valid audio stem name
	| 'badAudio'                // This chart's audio couldn't be parsed
	| 'multipleAudio'           // This chart has multiple audio files of the same stem
	| 'noChart'                 // This chart doesn't have "notes.chart"/"notes.mid"
	| 'invalidChart'            // .chart/.mid file is not named "notes.chart"/"notes.mid"
	| 'badChart'                // This chart's .chart/.mid file couldn't be parsed
	| 'multipleChart'           // This chart has multiple .chart/.mid files
	| 'badVideo'                // This chart has a video background that will not work on Linux
	| 'multipleVideo'           // This chart has multiple video background files

type MetadataIssueType =
	| 'missingValue'            // Metadata is missing a required value
	| 'invalidValue'            // Metadata property was set to an unsupported value
	| 'extraValue'              // Metadata contains a property that should not be included

interface ParsedChart {
	/**
	 * The raw bytes of the source chart file. Needed by `scanChart` to compute
	 * `chartHash`, which is `blake3(chartBytes ++ ini-modifier name/value pairs)`.
	 */
	chartBytes: Uint8Array
	/** The format the chart was parsed from. */
	format: 'chart' | 'mid'
	/** The fully-resolved ini modifiers that influenced parsing. */
	iniChartModifiers: IniChartModifiers
	resolution: number
	drumType: DrumType | null
	metadata: {
			name: string | undefined
			artist: string | undefined
			album: string | undefined
			genre: string | undefined
			year: string | undefined
			charter: string | undefined
			diff_guitar: number | undefined
			delay: number | undefined
			preview_start_time: number | undefined
	}
	parseIssues: { instrument: Instrument | null; difficulty: Difficulty | null; noteIssue: ChartIssueType }[]
	vocalTracks: VocalTrack
	endEvents: {
			tick: number
			msTime: number
			msLength: number
	}[]
	tempos: {
			tick: number
			beatsPerMinute: number
			msTime: number
	}[]
	timeSignatures: {
			tick: number
			numerator: number
			denominator: number
			msTime: number
			msLength: number
	}[]
	sections: {
			tick: number
			name: string
			msTime: number
			msLength: number
	}[]
	trackData: {
		noteEventGroups: NoteEvent[][]
		instrument: Instrument
		difficulty: Difficulty
		starPowerSections: {
				tick: number
				length: number
				msTime: number
				msLength: number
		}[]
		rejectedStarPowerSections: {
				tick: number
				length: number
				msTime: number
				msLength: number
		}[]
		soloSections: {
				tick: number
				length: number
				msTime: number
				msLength: number
		}[]
		flexLanes: {
				tick: number
				length: number
				isDouble: boolean
				msTime: number
				msLength: number
		}[]
		drumFreestyleSections: {
				tick: number
				length: number
				isCoda: boolean
				msTime: number
				msLength: number
		}[]
	}
}

/** A single note event in a chart's track. Note that more than one note event can occur at the same time. */
interface NoteEvent {
	/** Tick position where the note event begins. */
	tick: number
	/** Time where the note event begins, in ms. */
	msTime: number
	/** Length of the note event, in ticks. */
	length: number
	/** Length of the note event, in ms. */
	msLength: number
	/** The type of the note. (green, open, redDrum, kick, etc...) */
	type: NoteType
	/** bitmask of `noteFlags`, which define the modifiers that apply to this note event. (strum, tap, cymbal, accent, etc...) */
	flags: number
}

/** Note: specific values here are standardized; they are constants used in the track hash calculation. */
type NoteType = ObjectValues<typeof noteTypes>
const noteTypes = {
	// 5 fret
	open: 1,
	green: 2,
	red: 3,
	yellow: 4,
	blue: 5,
	orange: 6,

	// 6 fret
	black1: 7,
	black2: 8,
	black3: 9,
	white1: 10,
	white2: 11,
	white3: 12,

	// Drums
	kick: 13,
	redDrum: 14,
	yellowDrum: 15,
	blueDrum: 16,
	greenDrum: 17,
} as const

/** Note: specific values here are standardized; they are constants used in the track hash calculation. */
const noteFlags = {
	none: 0,
	strum: 1,
	hopo: 2,
	tap: 4,
	doubleKick: 8,
	tom: 16,
	cymbal: 32,
	discoNoflip: 64,
	disco: 128,
	flam: 256,
	ghost: 512,
	accent: 1024,
} as const

const lyricFlags = {
	none: 0,
	joinWithNext: 1,
	nonPitched: 2,
	lenientScoring: 4,
	pitchSlide: 16,
	harmonyHidden: 32,
	staticShift: 64,
	rangeShift: 128,
	hyphenateWithNext: 256,
} as const

interface LyricEvent {
	/** Tick position of the lyric event. */
	tick: number
	/** Time of the lyric event, in ms. */
	msTime: number
	/** The text content of the lyric event. Often will be a single lyric syllable. */
	text: string
	/** bitmask of `lyricFlags`, which define the modifiers that apply to this lyric event. (nonPitched, lenientScoring, hyphenateWithNext, etc...) */
	flags: number
}

/** A single timed vocal event inside a vocal phrase, either a sung pitch target or vocals percussion cue. */
interface VocalNote {
	/** Tick position where the vocal note begins. */
	tick: number
	/** Time where the vocal note begins, in ms. */
	msTime: number
	/** Length of the vocal note, in ticks. */
	length: number
	/** Length of the vocal note, in ms. */
	msLength: number
	/** The MIDI note number for the vocal pitch of this note. */
	pitch: number
	/** Whether this note is a sung pitch note (MIDI 36-84) or vocals percussion cue (MIDI 96/97). */
	type: 'pitched' | 'percussion'
}

/**
 * A range created by a vocals phrase marker, used during gameplay to decide
 * which pitch/percussion notes and lyric syllables belong to the same sung line.
 * The game scores and displays vocals phrase-by-phrase as playback crosses
 * these ranges instead of treating every note as an unrelated standalone event.
 */
interface VocalPhrase {
	/** Tick position where the vocal phrase begins. */
	tick: number
	/** Time where the vocal phrase begins, in ms. */
	msTime: number
	/** Length of the vocal phrase, in ticks. */
	length: number
	/** Length of the vocal phrase, in ms. */
	msLength: number
	/** Whether every note in this phrase is a vocals percussion cue. */
	isPercussion: boolean
	/** Lead-vocals singer assigned to this phrase in two-player modes; omitted for harmony phrases. */
	player?: 1 | 2
	/** All vocal note events contained inside this phrase range. */
	notes: VocalNote[]
	/** All lyric events contained inside this phrase range. */
	lyrics: LyricEvent[]
}

/** Data for one singer lane, such as lead vocals or a single harmony part. */
interface VocalPart {
	/** Vocal phrases that group the notes and lyrics sung and scored together. */
	notePhrases: VocalPhrase[]
	/** Vocal phrases that group lyrics for fixed-position static lyric display. */
	staticLyricPhrases: VocalPhrase[]
	/** Star Power phrase ranges available to this vocal part. */
	starPowerSections: { tick: number; msTime: number; length: number; msLength: number }[]
	/** Range shift markers for this part's vocals note display. */
	rangeShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	/** Lyric shift markers for this part's static lyric display. */
	lyricShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	/** Raw vocal text events for this part, excluding parsed lyric syllables. */
	textEvents: { tick: number; msTime: number; text: string }[]
}

/** Top-level normalized vocals data containing every singer lane and shared track-level shift markers. */
interface VocalTrack {
	/** Vocal parts keyed by canonical part name, such as `vocals` or `harmony1`. */
	parts: { [partName: string]: VocalPart }
	/** Shared range shift markers sourced from the lead vocals or first harmony part. */
	rangeShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	/** Shared lyric shift markers sourced from the lead vocals or first harmony part. */
	lyricShifts: { tick: number; msTime: number; length: number; msLength: number }[]
}

interface IniChartModifiers {
	song_length: number               // Default: 0
	hopo_frequency: number            // Default: 0
	eighthnote_hopo: boolean          // Default: false
	multiplier_note: number           // Default: 0
	sustain_cutoff_threshold: number  // Default: -1
	chord_snap_threshold: number      // Default: 0
	five_lane_drums: boolean          // Default: false
	pro_drums: boolean                // Default: false
}
```
