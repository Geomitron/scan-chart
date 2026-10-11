import type { ParsedChartFile } from './parse-chart-file'
import type { Difficulty, Instrument } from '../types'
import { roundBpm, type CanonicalTrackSemantics } from './identity/btrack-20260801'
import {
	canonicalChartDurationMs,
	CanonicalChartDurationMs,
	trackDurationMs,
	TrackDurationMs,
} from './identity/duration-types'

export const canonicalChartDurationDefinition = 'strikecore-all-track-last-note-plus-one-beat-v1' as const
export const trackDurationDefinition = 'strikecore-selected-track-last-note-v1' as const

export interface CanonicalChartDuration {
	readonly definition: typeof canonicalChartDurationDefinition
	readonly durationMs: CanonicalChartDurationMs
	readonly contentLastTick: bigint
	readonly endTick: bigint
	readonly resolution: bigint
	readonly songSpeed: 1
}

export interface TrackDuration {
	readonly definition: typeof trackDurationDefinition
	readonly durationMs: TrackDurationMs
	readonly lastNoteEndTick: bigint
	readonly resolution: bigint
	readonly songSpeed: 1
	readonly minimumDurationMs: 1
}

export interface ParsedTrackDurationRequest {
	readonly chart: ParsedChartFile
	readonly instrument: Instrument
	readonly difficulty: Difficulty
}

interface AssignedTempo {
	readonly tick: bigint
	readonly beatsPerMinute: number
	readonly assignedTimeSeconds: number
}

interface DurationTempo {
	readonly tick: bigint
	readonly beatsPerMinute: number
}

function requireNonnegativeSafeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${field} must be a nonnegative safe integer`)
	}
	return value
}

function requirePositiveFinite(value: number, field: string): number {
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${field} must be positive and finite`)
	return value
}

function tickPeriodToTime(startTick: bigint, endTick: bigint, resolution: number, beatsPerMinute: number): number {
	return (Number(endTick - startTick) * 60) / (resolution * beatsPerMinute)
}

function assignedTempos(resolutionValue: number, tempos: readonly DurationTempo[], roundTempos: boolean): readonly AssignedTempo[] {
	const resolution = requirePositiveFinite(resolutionValue, 'resolution')
	const temposAtTick = new Map<bigint, number>()
	for (const tempo of tempos) {
		if (tempo.tick < BigInt(0)) throw new RangeError('tempo tick must be nonnegative')
		const tick = tempo.tick
		const beatsPerMinute = requirePositiveFinite(tempo.beatsPerMinute, 'tempo BPM')
		temposAtTick.set(tick, roundTempos ? roundBpm(beatsPerMinute) : beatsPerMinute)
	}
	if (!temposAtTick.has(BigInt(0))) temposAtTick.set(BigInt(0), 120)

	const ordered = [...temposAtTick]
		.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.map(([tick, beatsPerMinute]) => ({ tick, beatsPerMinute }))
	const result: AssignedTempo[] = []
	for (const tempo of ordered) {
		const previous = result[result.length - 1]
		const assignedTimeSeconds = previous === undefined
			? 0
			: previous.assignedTimeSeconds + tickPeriodToTime(
				previous.tick,
				tempo.tick,
				resolution,
				previous.beatsPerMinute,
			)
		result.push({ ...tempo, assignedTimeSeconds })
	}
	return result
}

function bitIncrement(value: number): number {
	if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) return value
	if (value === Number.NEGATIVE_INFINITY) return -Number.MAX_VALUE
	if (Object.is(value, -0)) return Number.MIN_VALUE

	const bytes = new ArrayBuffer(8)
	const view = new DataView(bytes)
	view.setFloat64(0, value, false)
	let bits = view.getBigUint64(0, false)
	bits = value < 0 ? bits - BigInt(1) : bits + BigInt(1)
	view.setBigUint64(0, bits, false)
	return view.getFloat64(0, false)
}

function tickPositionToTime(resolution: number, tempoSource: readonly DurationTempo[], position: bigint, roundTempos: boolean): number {
	const tempos = assignedTempos(resolution, tempoSource, roundTempos)
	let active = tempos[0]
	for (const tempo of tempos) {
		if (tempo.tick > position) break
		active = tempo
	}

	let time = active.assignedTimeSeconds + tickPeriodToTime(
		active.tick,
		position,
		resolution,
		active.beatsPerMinute,
	)
	for (let adjustment = 0; adjustment < 10_000; adjustment++) {
		const reversedTickLength = Math.trunc(
			((time - active.assignedTimeSeconds) * resolution * active.beatsPerMinute) / 60,
		)
		if (!Number.isFinite(reversedTickLength)) throw new RangeError('Tick-to-time conversion produced a non-finite tick')
		const reversedPosition = active.tick + BigInt(reversedTickLength)
		if (reversedPosition === position) return time
		time = bitIncrement(time)
	}
	throw new RangeError('Tick-to-time conversion did not converge')
}

function parsedTempos(chart: ParsedChartFile): readonly DurationTempo[] {
	return chart.tempos.map(tempo => ({
		tick: BigInt(requireNonnegativeSafeInteger(tempo.tick, 'tempo tick')),
		beatsPerMinute: tempo.beatsPerMinute,
	}))
}

function canonicalTempos(semantics: CanonicalTrackSemantics): readonly DurationTempo[] {
	return semantics.tempos.map(tempo => ({
		tick: tempo.tick,
		beatsPerMinute: tempo.beatsPerMinute,
	}))
}

function createTrackDuration(
	resolutionValue: number,
	tempos: readonly DurationTempo[],
	lastNoteEndTick: bigint,
): TrackDuration {
	const resolution = requireNonnegativeSafeInteger(resolutionValue, 'resolution')
	if (resolution === 0) throw new RangeError('resolution must be greater than zero')
	if (lastNoteEndTick < BigInt(0)) throw new RangeError('last note end tick must be nonnegative')
	const roundedDurationMs = Math.max(1, Math.ceil(tickPositionToTime(resolution, tempos, lastNoteEndTick, true) * 1000))
	requireNonnegativeSafeInteger(roundedDurationMs, 'track duration')
	return {
		definition: trackDurationDefinition,
		durationMs: trackDurationMs(BigInt(roundedDurationMs)),
		lastNoteEndTick,
		resolution: BigInt(resolution),
		songSpeed: 1,
		minimumDurationMs: 1,
	}
}

/** Calculates the trusted graph/display duration for one parsed source Track. */
export function calculateParsedTrackDuration(request: ParsedTrackDurationRequest): TrackDuration {
	const track = request.chart.trackData.find(candidate =>
		candidate.instrument === request.instrument && candidate.difficulty === request.difficulty)
	if (!track) throw new RangeError(`Track not found: ${request.instrument} ${request.difficulty}`)
	let lastNoteEndTick = BigInt(0)
	for (const note of track.noteEventGroups.flat()) {
		const tick = requireNonnegativeSafeInteger(note.tick, 'note tick')
		const length = requireNonnegativeSafeInteger(note.length, 'note length')
		const endTick = tick + length
		requireNonnegativeSafeInteger(endTick, 'note end tick')
		lastNoteEndTick = lastNoteEndTick > BigInt(endTick) ? lastNoteEndTick : BigInt(endTick)
	}
	return createTrackDuration(request.chart.resolution, parsedTempos(request.chart), lastNoteEndTick)
}

/** Calculates the same duration directly from trusted canonical BTrack semantics. */
export function calculateCanonicalTrackDuration(semantics: CanonicalTrackSemantics): TrackDuration {
	let lastNoteEndTick = BigInt(0)
	for (const note of semantics.notes) {
		if (note.tick < BigInt(0) || note.length < BigInt(0)) {
			throw new RangeError('canonical note tick and length must be nonnegative')
		}
		const endTick = note.tick + note.length
		lastNoteEndTick = lastNoteEndTick > endTick ? lastNoteEndTick : endTick
	}
	return createTrackDuration(semantics.resolution, canonicalTempos(semantics), lastNoteEndTick)
}

/**
 * Mirrors StrikeCore `Song.GetLastTick()` and `Song.TickPositionToTime()` at
 * song speed 1.0. Only regular notes in `Track.Notes` contribute to the last
 * tick; vocal-note collections and chart events do not.
 */
export function calculateCanonicalChartDuration(chart: ParsedChartFile): CanonicalChartDuration {
	return chartDuration(chart, true)
}

/**
 * The chart-length fallback of the frozen legacy SongHash: the same duration with exact tempos, because Clone Hero
 * 1.1.0.6142 didn't round them.
 */
export function calculateLegacyChartFallbackDurationMs(chart: ParsedChartFile): bigint {
	return chartDuration(chart, false).durationMs
}

function chartDuration(chart: ParsedChartFile, roundTempos: boolean): CanonicalChartDuration {
	const resolution = requireNonnegativeSafeInteger(chart.resolution, 'resolution')
	if (resolution === 0) throw new RangeError('resolution must be greater than zero')
	let contentLastTick = 0
	for (const track of chart.trackData) {
		for (const note of track.noteEventGroups.flat()) {
			const tick = requireNonnegativeSafeInteger(note.tick, 'note tick')
			const length = requireNonnegativeSafeInteger(note.length, 'note length')
			const endTick = tick + length
			requireNonnegativeSafeInteger(endTick, 'note end tick')
			contentLastTick = Math.max(contentLastTick, endTick)
		}
	}
	const endTick = contentLastTick + resolution
	requireNonnegativeSafeInteger(endTick, 'duration end tick')
	const durationMs = Math.ceil(tickPositionToTime(resolution, parsedTempos(chart), BigInt(endTick), roundTempos) * 1000)
	requireNonnegativeSafeInteger(durationMs, 'canonical chart duration')
	return {
		definition: canonicalChartDurationDefinition,
		durationMs: canonicalChartDurationMs(BigInt(durationMs)),
		contentLastTick: BigInt(contentLastTick),
		endTick: BigInt(endTick),
		resolution: BigInt(resolution),
		songSpeed: 1,
	}
}
