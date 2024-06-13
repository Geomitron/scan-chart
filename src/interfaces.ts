import { ObjectValues } from './utils'

export interface ScannedChart {
	/** An MD5 hash of the names and binary contents of every file in the chart. */
	md5: string
	/** A blake3 hash of just the chart file and the .ini modifiers that impact chart parsing. If this changes, the in-game score is reset. */
	chartHash: string
	/** If the chart is able to be played in-game. This is `false` if `notesData` is `undefined`. */
	playable: boolean

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

export interface AlbumArt {
	/** The binary buffer of the album art image, in the .jpg format (quality 75%), resized to 512x512. */
	data: Uint8Array
	/** The MD5 hash of `data`. */
	md5: string
}

export interface NotesData {
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
	/** The number of individual notes in the chart. Does not include star power, solo markers, or ativation lanes. */
	noteCounts: {
		instrument: Instrument
		difficulty: Difficulty
		count: number
	}[]
	/** The one-second region in each track where the notes-per-second is highest. */
	maxNps: {
		instrument: Instrument
		difficulty: Difficulty
		/** Time of the end of the high NPS region in milliseconds. Rounded to 3 decimal places. */
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
	}[]
	/** MD5 hash of the chart's tempo map, including BPM markers and time signature markers. */
	tempoMapHash: string
	/** The number of BPM markers in the chart. */
	tempoMarkerCount: number
	/**
	 * The amount of time between the chart's first and last notes in milliseconds. Rounded to 3 decimal places.
	 * If there are multiple tracks, the first note is the earliest first note across all the tracks,
	 * and the last note is the latest last note across all the tracks.
	 */
	effectiveLength: number
}

export type Instrument = (typeof instruments)[number]
export const instruments = [
	'guitar', // Lead Guitar
	'guitarcoop', // Co-op Guitar
	'rhythm', // Rhythm Guitar
	'bass', // Bass Guitar
	'drums', // Drums
	'keys', // Keys
	'guitarghl', // GHL (6-fret) Lead Guitar
	'guitarcoopghl', // GHL (6-fret) Co-op Guitar
	'rhythmghl', // GHL (6-fret) Rhythm Guitar
	'bassghl', // GHL (6-fret) Bass Guitar
] as const

export type InstrumentType = ObjectValues<typeof instrumentTypes>
export const instrumentTypes = {
	sixFret: 0,
	fiveFret: 1,
	drums: 2,
} as const
export function getInstrumentType(instrument: Instrument) {
	if (instrument === 'drums') {
		return instrumentTypes.drums
	} else if (instrument === 'guitarghl' || instrument === 'guitarcoopghl' || instrument === 'rhythmghl' || instrument === 'bassghl') {
		return instrumentTypes.sixFret
	} else {
		return instrumentTypes.fiveFret
	}
}

export type DrumType = ObjectValues<typeof drumTypes>
export const drumTypes = {
	fourLane: 0,
	fourLanePro: 1,
	fiveLane: 2,
} as const

export type Difficulty = (typeof difficulties)[number]
export const difficulties = ['expert', 'hard', 'medium', 'easy'] as const

export type ChartIssueType =
	| 'misalignedTimeSignature' // This time signature marker doesn't appear at the start of a measure
	| 'noNotes' // This chart has no notes
	| 'noExpert' // One of this chart's instruments has Easy, Medium, or Hard charted but not Expert
	| 'difficultyNotReduced' // The notes of this difficulty are identical to the notes of a higher difficulty
	| 'isDefaultBPM' // This chart has only one 120 BPM marker and only one 4/4 time signature
	| 'noSections' // This chart has no sections
	| 'badEndEvent' // This end event is in an invalid location and will be ignored by most games
	| 'smallLeadingSilence' // This track has a note that is less than 2000ms after the start of the track
	| 'noStarPower' // This track has no star power (not included if there are fewer than 50 notes or the song is less than a minute)
	| 'emptyStarPower' // This star power phrase does not apply to any notes
	| 'badStarPower' // This star power is being ignored due to the .ini "multiplier_note" setting
	| 'emptySoloSection' // This solo section does not contain any notes
	| 'noDrumActivationLanes' // This track has no activation lanes (not included if there are fewer than 50 notes or the song is less than a minute)
	| 'emptyFlexLane' // This flex lane does not apply to any notes
	| 'difficultyForbiddenNote' // This is a note or drum lane that isn't allowed on the track's difficulty
	| 'invalidChord' // The use of this type of chord is strongly discouraged
	| 'brokenNote' // This note is so close to the previous note that this was likely a charting mistake
	| 'badSustainGap' // This note is not far enough ahead of the previous sustain
	| 'babySustain' // The sustain on this note is too short

export type FolderIssueType =
	| 'noMetadata' // This chart doesn't have "song.ini"
	| 'invalidIni' // .ini file is not named "song.ini"
	| 'invalidMetadata' // "song.ini" doesn't have a "[Song]" section
	| 'badIniLine' // This line in "song.ini" couldn't be parsed
	| 'multipleIniFiles' // This chart has multiple .ini files
	| 'noAlbumArt' // This chart doesn't have album art
	| 'albumArtSize' // This chart's album art is not 500x500 or 512x512
	| 'badAlbumArt' // This chart's album art couldn't be parsed
	| 'multipleAlbumArt' // This chart has multiple album art files
	| 'noAudio' // This chart doesn't have an audio file
	| 'invalidAudio' // Audio file is not a valid audio stem name
	| 'badAudio' // This chart's audio couldn't be parsed
	| 'multipleAudio' // This chart has multiple audio files of the same stem
	| 'noChart' // This chart doesn't have "notes.chart"/"notes.mid"
	| 'invalidChart' // .chart/.mid file is not named "notes.chart"/"notes.mid"
	| 'badChart' // This chart's .chart/.mid file couldn't be parsed
	| 'multipleChart' // This chart has multiple .chart/.mid files
	| 'badVideo' // This chart has a video background that will not work on Linux
	| 'multipleVideo' // This chart has multiple video background files

export type MetadataIssueType =
	| 'missingValue' // Metadata is missing a required value
	| 'invalidValue' // Metadata property was set to an unsupported value
	| 'extraValue' // Metadata contains a property that should not be included
