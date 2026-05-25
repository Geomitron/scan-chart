import type { MidiEvent } from '@geomitron/midi-file'

import { defaultMetadata } from '../ini/metadata'
import { Difficulty, Instrument, NotesData } from '../types'
import { ObjectValues } from '../shared/type-utils'

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

/**
 * Common intermediate format that both .mid and .chart parsers target before
 * normalization in `parseChartFile`.
 */
export interface RawChartData {
	chartTicksPerBeat: number
	metadata: Partial<typeof defaultMetadata> & {
		extraIniFields?: { [key: string]: string }
		extraChartSongFields?: { [key: string]: string }
		chart_offset?: number
	}
	vocalTracks: {
		[part: string]: VocalTrackData
	}
	tempos: {
		tick: number
		beatsPerMinute: number
	}[]
	timeSignatures: {
		tick: number
		numerator: number
		denominator: number
	}[]
	unrecognizedSyncTrackEvents: {
		tick: number
		text: string
	}[]
	sections: {
		tick: number
		name: string
	}[]
	endEvents: {
		tick: number
	}[]
	unrecognizedEventsTrackTextEvents: {
		tick: number
		text: string
	}[]
	unrecognizedEventsTrackMidiEvents: MidiEvent[]
	parseIssues: Omit<NotesData['chartIssues'][number], 'description'>[]
	unrecognizedMidiTracks: { trackName: string; events: MidiEvent[] }[]
	unrecognizedChartSections: { name: string; lines: string[] }[]
	trackData: {
		instrument: Instrument
		difficulty: Difficulty
		starPowerSections: { tick: number; length: number }[]
		rejectedStarPowerSections: { tick: number; length: number }[]
		soloSections: { tick: number; length: number }[]
		flexLanes: { tick: number; length: number; isDouble: boolean }[]
		drumFreestyleSections: { tick: number; length: number; isCoda: boolean }[]
		trackEvents: { tick: number; length: number; type: EventType }[]
		textEvents: { tick: number; text: string }[]
		versusPhrases: { tick: number; length: number; isPlayer2: boolean }[]
		animations: { tick: number; length: number; noteNumber: number }[]
		unrecognizedMidiEvents: MidiEvent[]
	}[]
}

export interface VocalTrackData {
	lyrics: { tick: number; length: number; text: string }[]
	vocalPhrases: { tick: number; length: number }[]
	notes: import('./lyric-parser').VocalNote[]
	starPowerSections: { tick: number; length: number }[]
	rangeShifts: { tick: number; length: number }[]
	lyricShifts: { tick: number; length: number }[]
	staticLyricPhrases: { tick: number; length: number }[]
	textEvents: { tick: number; text: string }[]
	unrecognizedMidiEvents: MidiEvent[]
}
