import { Difficulty, Instrument } from 'src/interfaces'
import { ObjectValues } from 'src/utils'

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

export const defaultIniChartModifiers = {
	song_length: 0,
	hopo_frequency: 0,
	eighthnote_hopo: false,
	multiplier_note: 0,
	sustain_cutoff_threshold: -1,
	chord_snap_threshold: 0,
	five_lane_drums: false,
	pro_drums: false,
}

/**
 * This is the common format that both .mid and .chart parsers target, and is used by `parseChart()` to generate `ChartData`.
 *
 * The intention is that the .mid and .chart parsers do as little processing of the data as possible so that the shared
 * functionality can all happen in `parseChart()`. This means that "invalid" event configurations can exist in this data, such as:
 * - modifiers and phrases that contain zero notes
 * - multiple events of the same type on the same tick
 * - overlapping events of the same type
 * - drum tracks containing both 5-lane green and tom/cymbal modifiers
 */
export interface RawChartData {
	chartTicksPerBeat: number
	metadata: {
		name?: string
		artist?: string
		album?: string
		genre?: string
		year?: string
		charter?: string
		diff_guitar?: number
		delay?: number
		preview_start_time?: number
	}
	hasLyrics: boolean
	hasVocals: boolean
	lyrics: {
		tick: number
		length: number
		text: string
	}[]
	tempos: {
		tick: number
		/** double, rounded to 12 decimal places */
		beatsPerMinute: number
	}[]
	timeSignatures: {
		tick: number
		numerator: number
		denominator: number
	}[]
	sections: {
		tick: number
		name: string
	}[]
	endEvents: {
		tick: number
	}[]
	trackData: {
		instrument: Instrument
		difficulty: Difficulty
		starPowerSections: {
			tick: number
			/** Number of ticks */
			length: number
		}[]
		/** related to multiplier_note */
		rejectedStarPowerSections: {
			tick: number
			/** Number of ticks */
			length: number
		}[]
		soloSections: {
			tick: number
			/** Number of ticks */
			length: number
		}[]
		flexLanes: {
			tick: number
			/** Number of ticks */
			length: number
			isDouble: boolean
		}[]
		drumFreestyleSections: {
			tick: number
			/** Number of ticks */
			length: number
			/** If the freestyle section is a big rock ending instead of an activation lane */
			isCoda: boolean
		}[]
		/** Only contains notes and note modifiers. */
		trackEvents: {
			tick: number
			/**
			 * Number of ticks. For modifiers, this should be zero. In .mid, modifiers do have length,
			 * but the .mid parser normalizes this by inserting a zero-length modifier for every
			 * note that it applies to. (chords count as one note in this context)
			 */
			length: number
			type: EventType
		}[]
	}[]
}

export type EventType = ObjectValues<typeof eventTypes>
export const eventTypes = {
	starPower: 0,
	soloSection: 1, // .mid
	rejectedStarPower: 2, // .mid, related to multiplier_note
	soloSectionStart: 3, // .chart
	soloSectionEnd: 4, // .chart

	// 5 fret
	open: 5,
	green: 6,
	red: 7,
	yellow: 8,
	blue: 9,
	orange: 10,

	// 6 fret
	black1: 11,
	black2: 12,
	black3: 13,
	white1: 14,
	white2: 15,
	white3: 16,

	// Drums
	kick: 17,
	kick2x: 18,
	redDrum: 19,
	yellowDrum: 20,
	blueDrum: 21,
	fiveOrangeFourGreenDrum: 22,
	fiveGreenDrum: 23,
	flexLaneSingle: 24,
	flexLaneDouble: 25,
	freestyleSection: 26,

	// Modifiers
	forceOpen: 27, // .mid
	forceTap: 28,
	forceStrum: 29, // .mid
	forceHopo: 30, // .mid
	forceUnnatural: 31, // .chart
	forceFlam: 32,
	yellowTomMarker: 33, // .mid
	blueTomMarker: 34, // .mid
	greenTomMarker: 35, // .mid
	yellowCymbalMarker: 36, // .chart
	blueCymbalMarker: 37, // .chart
	greenCymbalMarker: 38, // .chart
	redGhost: 39,
	yellowGhost: 40,
	blueGhost: 41,
	fiveOrangeFourGreenGhost: 42,
	fiveGreenGhost: 43,
	kickGhost: 44,
	redAccent: 45,
	yellowAccent: 46,
	blueAccent: 47,
	fiveOrangeFourGreenAccent: 48,
	fiveGreenAccent: 49,
	kickAccent: 50,
	discoFlipOff: 51,
	discoFlipOn: 52,
	discoNoFlipOn: 53,

	// Toggle
	enableChartDynamics: 54,
} as const

/** A single event in a chart's track. Note that more than one event can occur at the same time. */
export interface NoteEvent {
	/** The chart tick of this event. */
	tick: number
	msTime: number
	/** Length of the event in ticks. Some events have a length of zero. */
	length: number
	msLength: number
	type: NoteType
	/** bitmask of `NoteFlag`. */
	flags: number
}

/** Note: specific values here are standardized; they are constants used in the track hash calculation. */
export type NoteType = ObjectValues<typeof noteTypes>
export const noteTypes = {
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
