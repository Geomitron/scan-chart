import { defaultMetadata } from '../ini/metadata'
import { ObjectValues } from '../shared/type-utils'

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
 * Projection of the 8 `song.ini` fields that influence chart parsing, with
 * defaults derived from {@link defaultMetadata}.
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

/** A single event in a chart's track. Note that more than one event can occur at the same time. */
export interface NoteEvent {
	tick: number
	msTime: number
	length: number
	msLength: number
	type: NoteType
	/** bitmask of `noteFlags`. */
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

export const noteTypeCount = Math.max(...Object.values(noteTypes)) + 1

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

export interface NormalizedLyricEvent {
	tick: number
	msTime: number
	text: string
	flags: number
}

export interface NormalizedVocalNote {
	tick: number
	msTime: number
	length: number
	msLength: number
	pitch: number
	type: 'pitched' | 'percussion'
}

export interface NormalizedVocalPhrase {
	tick: number
	msTime: number
	length: number
	msLength: number
	isPercussion: boolean
	player?: 1 | 2
	notes: NormalizedVocalNote[]
	lyrics: NormalizedLyricEvent[]
}

export interface NormalizedVocalPart {
	notePhrases: NormalizedVocalPhrase[]
	staticLyricPhrases: NormalizedVocalPhrase[]
	starPowerSections: { tick: number; msTime: number; length: number; msLength: number }[]
	rangeShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	lyricShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	textEvents: { tick: number; msTime: number; text: string }[]
}

export interface NormalizedVocalTrack {
	parts: { [partName: string]: NormalizedVocalPart }
	rangeShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	lyricShifts: { tick: number; msTime: number; length: number; msLength: number }[]
}
