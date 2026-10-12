import { ObjectValues } from '../shared/type-utils'
import { defaultMetadata } from '../ini/metadata'

/** The subset of `defaultMetadata` that influences chart parsing. */
export interface IniChartModifiers {
	song_length: number
	hopo_frequency: number
	eighthnote_hopo: boolean
	multiplier_note: number
	sustain_cutoff_threshold: number
	chord_snap_threshold: number
	five_lane_drums: boolean
	pro_drums: boolean
}

/**
 * Default `IniChartModifiers` — the parsing-relevant subset of
 * `defaultMetadata`. Used by `createEmptyChart` and as the fallback when a
 * caller parses a chart file without supplying ini modifiers.
 */
export const defaultIniChartModifiers: IniChartModifiers = {
	song_length: defaultMetadata.song_length,
	hopo_frequency: defaultMetadata.hopo_frequency,
	eighthnote_hopo: defaultMetadata.eighthnote_hopo,
	multiplier_note: defaultMetadata.multiplier_note,
	sustain_cutoff_threshold: defaultMetadata.sustain_cutoff_threshold,
	chord_snap_threshold: defaultMetadata.chord_snap_threshold,
	five_lane_drums: defaultMetadata.five_lane_drums,
	pro_drums: defaultMetadata.pro_drums,
}

/** A single note event in a chart's track. Note that more than one note event can occur at the same time. */
export interface NoteEvent {
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
export type NoteType = ObjectValues<typeof noteTypes>
export const noteTypes = {
	open: 1,
	green: 2,
	red: 3,
	yellow: 4,
	blue: 5,
	orange: 6,
	black1: 7,
	black2: 8,
	black3: 9,
	white1: 10,
	white2: 11,
	white3: 12,
	kick: 13,
	redDrum: 14,
	yellowDrum: 15,
	blueDrum: 16,
	greenDrum: 17,
} as const

export const noteFlags = {
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

export const lyricFlags = {
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

export interface LyricEvent {
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
export interface VocalNote {
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
export interface VocalPhrase {
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
export interface VocalPart {
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

/** Top-level vocals data containing every singer lane and shared track-level shift markers. */
export interface VocalTrack {
	/** Vocal parts keyed by canonical part name, such as `vocals` or `harmony1`. */
	parts: { [partName: string]: VocalPart }
	/** Shared range shift markers sourced from the lead vocals or first harmony part. */
	rangeShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	/** Shared lyric shift markers sourced from the lead vocals or first harmony part. */
	lyricShifts: { tick: number; msTime: number; length: number; msLength: number }[]
}

/** @deprecated Use {@link LyricEvent}. Kept as an alias for `@eliwhite/scan-chart` consumers. */
export type NormalizedLyricEvent = LyricEvent
/** @deprecated Use {@link VocalNote}. Kept as an alias for `@eliwhite/scan-chart` consumers. */
export type NormalizedVocalNote = VocalNote
/** @deprecated Use {@link VocalPhrase}. Kept as an alias for `@eliwhite/scan-chart` consumers. */
export type NormalizedVocalPhrase = VocalPhrase
/** @deprecated Use {@link VocalPart}. Kept as an alias for `@eliwhite/scan-chart` consumers. */
export type NormalizedVocalPart = VocalPart
/** @deprecated Use {@link VocalTrack}. Kept as an alias for `@eliwhite/scan-chart` consumers. */
export type NormalizedVocalTrack = VocalTrack
