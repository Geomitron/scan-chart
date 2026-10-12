import type { ParsedChartFile } from './chart/parse-chart-file'
import type { IniChartModifiers, NoteType, VocalTrack } from './chart/types'
import { ObjectCache } from './shared/object-cache'
import { songContext } from './song-context'
import type { SongDocument } from './song-document'
import type { Difficulty, DrumType, Instrument } from './types'

/** A chart file's format: `chart` for the .chart text format, `mid` for MIDI. */
export type ChartFormat = 'chart' | 'mid'

/** The song.ini keys that change how notes are read, with Clone Hero's defaults where song.ini doesn't set one. */
export interface ChartParseSettings {
	readonly hopo_frequency: number
	readonly eighthnote_hopo: boolean
	readonly multiplier_note: number
	readonly sustain_cutoff_threshold: number
	readonly chord_snap_threshold: number
	readonly five_lane_drums: boolean
	readonly pro_drums: boolean
}

/** One lane or fret at one tick, with its sustain and its note modifiers. */
export interface Note {
	readonly tick: number
	readonly length: number
	/** The lane or fret: a value of `noteTypes`. */
	readonly type: NoteType
	/** The note modifiers: a bitmask of `noteFlags` (strum, HOPO, tap, cymbal, accent and so on). */
	readonly flags: number
	readonly msTime: number
	readonly msLength: number
}

/** A stretch of a track with a gameplay effect, such as a star power phrase or a solo. */
export interface Phrase {
	readonly tick: number
	readonly length: number
	readonly msTime: number
	readonly msLength: number
}

/** A roll lane (drums) or a trill or tremolo lane (five-fret). */
export interface FlexLane extends Phrase {
	readonly isDouble: boolean
}

/** A drum fill, which activates star power; a coda fill is the big rock ending. */
export interface DrumFill extends Phrase {
	readonly isCoda: boolean
}

export interface Tempo {
	readonly tick: number
	readonly msTime: number
	readonly beatsPerMinute: number
}

export interface TimeSignature {
	readonly tick: number
	readonly msTime: number
	readonly numerator: number
	readonly denominator: number
}

/** A practice section, such as "Verse 1". */
export interface Section {
	readonly tick: number
	readonly msTime: number
	readonly name: string
}

export interface TextEvent {
	readonly tick: number
	readonly msTime: number
	readonly text: string
}

/** One instrument at one difficulty, as Clone Hero plays it. */
export interface Track {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	/** The notes, grouped by tick: a note group is all the notes that start on the same tick. */
	readonly noteGroups: readonly (readonly Note[])[]
	readonly starPower: readonly Phrase[]
	readonly solos: readonly Phrase[]
	readonly flexLanes: readonly FlexLane[]
	readonly drumFills: readonly DrumFill[]
	readonly textEvents: readonly TextEvent[]
}

/**
 * A chart as Clone Hero plays it: every note resolved (HOPO or strum, tap, open, cymbal or tom, accent), sustains
 * trimmed, chords snapped, and times in milliseconds. It's read-only, and it's shared with the competitive hashes.
 */
export interface GameplayChart {
	readonly format: ChartFormat
	/** Ticks per quarter note. */
	readonly resolution: number
	readonly settings: ChartParseSettings
	/** The type of the drum tracks, or `null` when the chart has none. */
	readonly drumType: DrumType | null
	readonly tempos: readonly Tempo[]
	readonly timeSignatures: readonly TimeSignature[]
	readonly sections: readonly Section[]
	readonly endEvents: readonly { readonly tick: number; readonly msTime: number }[]
	readonly tracks: readonly Track[]
	/** The vocal parts, or `null` when no part has a phrase. */
	readonly vocals: VocalTrack | null
}

/** The chart file can't be read. The message says why. */
export class ChartReadError extends Error {
	override readonly name = 'ChartReadError'
}

/** What `analyzeChart` reads besides the gameplay chart: the parse it was made from, and the settings with song_length. */
export interface GameplayChartSource {
	readonly parsed: ParsedChartFile
	readonly settings: IniChartModifiers
	readonly format: ChartFormat
}

const sources = new ObjectCache<GameplayChart, GameplayChartSource>('gameplayChartSource')
const charts = new ObjectCache<ParsedChartFile, GameplayChart>('gameplayChart')

/** The chart of a song as Clone Hero plays it. Throws `ChartReadError` if the song has no chart or it can't be read. */
export function resolveChart(song: SongDocument): GameplayChart {
	const { chart, settings } = songContext(song)
	if (chart.kind === 'none') throw new ChartReadError('The song has no chart file.')
	if (chart.kind === 'failed') throw new ChartReadError(chart.error)
	let gameplay = charts.get(chart.parsed)
	if (gameplay === undefined) {
		gameplay = gameplayChart(chart.parsed, settings, chart.source.format)
		charts.set(chart.parsed, gameplay)
		sources.set(gameplay, { parsed: chart.parsed, settings, format: chart.source.format })
	}
	return gameplay
}

/** The parse a gameplay chart was made from, or `undefined` for a chart `resolveChart` didn't make. */
export function gameplayChartSource(chart: GameplayChart): GameplayChartSource | undefined {
	return sources.get(chart)
}

function gameplayChart(parsed: ParsedChartFile, settings: IniChartModifiers, format: ChartFormat): GameplayChart {
	const at = <T extends { tick: number; msTime: number }>(event: T) => ({ tick: event.tick, msTime: event.msTime })
	return {
		format,
		resolution: parsed.resolution,
		settings: {
			hopo_frequency: settings.hopo_frequency,
			eighthnote_hopo: settings.eighthnote_hopo,
			multiplier_note: settings.multiplier_note,
			sustain_cutoff_threshold: settings.sustain_cutoff_threshold,
			chord_snap_threshold: settings.chord_snap_threshold,
			five_lane_drums: settings.five_lane_drums,
			pro_drums: settings.pro_drums,
		},
		drumType: parsed.drumType,
		tempos: parsed.tempos,
		timeSignatures: parsed.timeSignatures.map(({ tick, msTime, numerator, denominator }) => ({ tick, msTime, numerator, denominator })),
		sections: parsed.sections.map(section => ({ ...at(section), name: section.name })),
		endEvents: parsed.endEvents.map(at),
		tracks: parsed.trackData.map(track => ({
			instrument: track.instrument,
			difficulty: track.difficulty,
			// Notes and phrases already have exactly their public fields, so they're shared with the parse.
			noteGroups: track.noteEventGroups,
			starPower: track.starPowerSections,
			solos: track.soloSections,
			flexLanes: track.flexLanes,
			drumFills: track.drumFreestyleSections,
			textEvents: track.textEvents.map(event => ({ ...at(event), text: event.text })),
		})),
		// A .chart file always has a vocals part, read from [Events], even with no lyrics in it.
		vocals: Object.values(parsed.vocalTracks.parts).some(part => part.notePhrases.length > 0 || part.staticLyricPhrases.length > 0)
			? parsed.vocalTracks
			: null,
	}
}
