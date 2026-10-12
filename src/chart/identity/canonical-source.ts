import { Difficulty, difficulties, Instrument } from '../../types'
import { calculateCanonicalChartDuration, CanonicalChartDuration } from '../chart-duration'
import { ChartSource, parseChartFileCanonicalIdentity, parseChartSource } from '../parse-chart-file'
import { parseRules } from '../parse-rules'
import type { IniChartModifiers } from '../types'
import type { SourceParseError, SourceParseRequest } from './public'
import { CanonicalTrackSemantics, createFiveFretRange } from './btrack-20260801'
import type { CanonicalTempoMap } from './tempo-map-hash'
import { identityTrackKey, IdentityTrackKey } from './track-key'

const canonicalParsedTrackToken: unique symbol = Symbol('canonicalParsedTrack')

const applicableInstruments: readonly Instrument[] = ['guitar', 'guitarcoop', 'rhythm', 'bass', 'keys']
const difficultyByCode: readonly Difficulty[] = ['easy', 'medium', 'hard', 'expert']

export interface CanonicalTrackKey {
	readonly instrument: Instrument
	readonly difficulty: Difficulty
}

interface RangeShiftSourceDetails {
	readonly instrument: Instrument
	readonly eventIndex: number
	readonly tick: number
	readonly text: string
}

export type RangeShiftSourceLocation =
	| RangeShiftSourceDetails & { readonly format: 'chart'; readonly containingDifficulty: Difficulty }
	| RangeShiftSourceDetails & { readonly format: 'mid'; readonly containingDifficulty: null }

export type CanonicalSourceNotice =
	| { readonly code: 'rangeShiftMalformed'; readonly source: RangeShiftSourceLocation }
	| { readonly code: 'rangeShiftDifficultyInvalid'; readonly source: RangeShiftSourceLocation; readonly declared: number }
	| {
		readonly code: 'rangeShiftDifficultyMismatch'
		readonly source: RangeShiftSourceLocation
		readonly declared: Difficulty
		readonly containing: Difficulty
	}
	| { readonly code: 'rangeShiftInstrumentInapplicable'; readonly source: RangeShiftSourceLocation }
	| {
		readonly code: 'rangeShiftOutOfBounds'
		readonly source: RangeShiftSourceLocation
		readonly position: number
		readonly size: number
	}

interface SourceRangeShiftMarker {
	readonly tick: number
	readonly instrument: Instrument
	readonly difficulty: Difficulty
	readonly position: number
	readonly size: { readonly kind: 'omitted' } | { readonly kind: 'explicit'; readonly value: number }
	readonly sourceOrder: number
}

export interface CanonicalParsedTrack {
	readonly profile: 'canonical-20260801'
	readonly key: CanonicalTrackKey
	readonly semantics: CanonicalTrackSemantics
	readonly [canonicalParsedTrackToken]: true
}

export interface CanonicalParsedChart {
	readonly profile: 'canonical-20260801'
	readonly sourceFormat: 'chart' | 'mid'
	readonly duration: CanonicalChartDuration
	/** The tempo map every track's semantics holds; Clone Hero's tempo map hash is calculated from it. */
	readonly tempoMap: CanonicalTempoMap
	readonly tracks: readonly CanonicalParsedTrack[]
}

export type CanonicalParseOutcome =
	| {
		readonly kind: 'accepted'
		readonly chart: CanonicalParsedChart
		readonly notices: readonly CanonicalSourceNotice[]
	}
	| {
		readonly kind: 'rejected'
		readonly errors: readonly [SourceParseError, ...SourceParseError[]]
	}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function toBigInt(value: number, field: string): bigint {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${field} must be a nonnegative safe integer`)
	}
	return BigInt(value)
}

function lastAtEachTick<T extends { readonly tick: number }>(values: readonly T[]): readonly T[] {
	const byTick = new Map<number, T>()
	for (const value of values) byTick.set(value.tick, value)
	return [...byTick.values()].sort((left, right) => left.tick - right.tick)
}

function defaultRangeSize(difficulty: Difficulty): number {
	if (difficulty === 'easy') return 3
	if (difficulty === 'medium') return 4
	return 5
}

function parseMarkerText(format: 'chart' | 'mid', text: string): readonly [number, number, number | undefined] | null {
	const expression = format === 'chart'
		? /^ld_range_shift ([+-]?\d+) ([+-]?\d+)(?: ([+-]?\d+))?$/
		: /^\[ld_range_shift ([+-]?\d+) ([+-]?\d+)(?: ([+-]?\d+))?\]$/
	const match = expression.exec(text)
	if (!match) return null
	return [Number(match[1]), Number(match[2]), match[3] === undefined ? undefined : Number(match[3])]
}

function looksLikeMarker(format: 'chart' | 'mid', text: string): boolean {
	return format === 'chart' ? text.startsWith('ld_range_shift') : text.startsWith('[ld_range_shift')
}

function collectRangeShifts(
	format: 'chart' | 'mid',
	tracks: ReturnType<typeof parseChartFileCanonicalIdentity>['trackData'],
): { readonly byTrack: ReadonlyMap<IdentityTrackKey, readonly SourceRangeShiftMarker[]>; readonly notices: readonly CanonicalSourceNotice[] } {
	const notices: CanonicalSourceNotice[] = []
	const markers = new Map<IdentityTrackKey, SourceRangeShiftMarker[]>()
	let sourceOrder = 0

	const seenMidiTextStreams = new Set<typeof tracks[number]['textEvents']>()
	const sourceTracks = format === 'mid'
		? tracks.filter(track => {
			if (seenMidiTextStreams.has(track.textEvents)) return false
			seenMidiTextStreams.add(track.textEvents)
			return true
		})
		: tracks

	for (const track of sourceTracks) {
		for (let eventIndex = 0; eventIndex < track.textEvents.length; eventIndex++) {
			const event = track.textEvents[eventIndex]
			if (!looksLikeMarker(format, event.text)) continue
			const sourceDetails: RangeShiftSourceDetails = {
				instrument: track.instrument,
				eventIndex,
				tick: event.tick,
				text: event.text,
			}
			const source: RangeShiftSourceLocation = format === 'chart'
				? { ...sourceDetails, format: 'chart', containingDifficulty: track.difficulty }
				: { ...sourceDetails, format: 'mid', containingDifficulty: null }
			const values = parseMarkerText(format, event.text)
			if (!values || values.some(value => value !== undefined && !Number.isSafeInteger(value))) {
				notices.push({ code: 'rangeShiftMalformed', source })
				continue
			}
			const [difficultyCode, position, explicitSize] = values
			const difficulty = difficultyByCode[difficultyCode]
			if (!difficulty) {
				notices.push({ code: 'rangeShiftDifficultyInvalid', source, declared: difficultyCode })
				continue
			}
			if (!applicableInstruments.includes(track.instrument)) {
				notices.push({ code: 'rangeShiftInstrumentInapplicable', source })
				continue
			}
			if (format === 'chart' && difficulty !== track.difficulty) {
				notices.push({
					code: 'rangeShiftDifficultyMismatch',
					source,
					declared: difficulty,
					containing: track.difficulty,
				})
				continue
			}
			const size = explicitSize ?? defaultRangeSize(difficulty)
			if (position < 1 || position > 5 || size < 1 || size > 5 || position + size > 6) {
				notices.push({ code: 'rangeShiftOutOfBounds', source, position, size })
				continue
			}

			const key = identityTrackKey(track.instrument, difficulty)
			const current = markers.get(key) ?? []
			current.push({
				tick: event.tick,
				instrument: track.instrument,
				difficulty,
				position,
				size: explicitSize === undefined ? { kind: 'omitted' } : { kind: 'explicit', value: explicitSize },
				sourceOrder: sourceOrder++,
			})
			markers.set(key, current)
		}
	}

	const canonical = new Map<IdentityTrackKey, readonly SourceRangeShiftMarker[]>()
	for (const [key, values] of markers) {
		const lastAtTick = new Map<number, SourceRangeShiftMarker>()
		for (const value of values.sort((left, right) => left.tick - right.tick || left.sourceOrder - right.sourceOrder)) {
			lastAtTick.set(value.tick, value)
		}
		canonical.set(key, [...lastAtTick.values()].sort((left, right) => left.tick - right.tick))
	}
	return { byTrack: canonical, notices }
}

function buildTempoMap(parsed: ReturnType<typeof parseChartFileCanonicalIdentity>): CanonicalTempoMap {
	return {
		tempos: lastAtEachTick(parsed.tempos).map(tempo => ({
			tick: toBigInt(tempo.tick, 'tempo tick'),
			beatsPerMinute: tempo.beatsPerMinute,
		})),
		timeSignatures: lastAtEachTick(parsed.timeSignatures).map(signature => ({
			tick: toBigInt(signature.tick, 'time signature tick'),
			numerator: signature.numerator,
			denominator: signature.denominator,
		})),
	}
}

function buildSemantics(
	parsed: ReturnType<typeof parseChartFileCanonicalIdentity>,
	{ tempos, timeSignatures }: CanonicalTempoMap,
	track: ReturnType<typeof parseChartFileCanonicalIdentity>['trackData'][number],
	rangeShifts: readonly SourceRangeShiftMarker[],
): CanonicalTrackSemantics {
	const notes = track.noteEventGroups.flat()
	const containsNote = (range: { tick: number; length: number }, inclusiveEnd: boolean) => notes.some(note =>
		note.tick >= range.tick && (inclusiveEnd
			? note.tick <= range.tick + range.length
			: note.tick < range.tick + (range.length || 1)),
	)
	const starPower = track.starPowerSections.filter(range => containsNote(range, false))
	const solos = track.soloSections.filter(range => containsNote(range, false))
	const flexLanes = track.flexLanes.filter(range => containsNote(range, true))
	const drumFreestyle = track.drumFreestyleSections

	return {
		resolution: parsed.resolution,
		tempos,
		timeSignatures,
		starPower: starPower.map(range => ({ tick: toBigInt(range.tick, 'star power tick'), length: toBigInt(range.length, 'star power length') })),
		solos: solos.map(range => ({ tick: toBigInt(range.tick, 'solo tick'), length: toBigInt(range.length, 'solo length') })),
		flexLanes: flexLanes.map(range => ({
			tick: toBigInt(range.tick, 'flex lane tick'),
			length: toBigInt(range.length, 'flex lane length'),
			isDouble: range.isDouble,
		})),
		drumFreestyle: drumFreestyle.map(range => ({
			tick: toBigInt(range.tick, 'drum freestyle tick'),
			length: toBigInt(range.length, 'drum freestyle length'),
			isCoda: range.isCoda,
		})),
		rangeShifts: rangeShifts.map(marker => {
			const size = marker.size.kind === 'omitted' ? defaultRangeSize(marker.difficulty) : marker.size.value
			const range = createFiveFretRange(marker.position, size)
			if (!range) throw new Error('Validated range-shift marker became invalid')
			return { tick: toBigInt(marker.tick, 'range shift tick'), ...range }
		}),
		notes: notes.map(note => ({
			tick: toBigInt(note.tick, 'note tick'),
			length: toBigInt(note.length, 'note length'),
			type: note.type,
			flags: note.flags,
		})),
	}
}

export function parseCanonicalSource(request: SourceParseRequest): CanonicalParseOutcome {
	return canonicalOutcome(request.source.format, () => parseChartFileCanonicalIdentity(
		request.source.bytes.slice(),
		request.source.format,
		request.modifiers,
	))
}

/** Parses an already tokenized chart, such as a song document's, with the canonical rules. */
export function parseCanonicalChartSource(source: ChartSource, modifiers: Partial<IniChartModifiers>): CanonicalParseOutcome {
	return canonicalOutcome(source.format, () => parseChartSource(source, modifiers, parseRules.canonical20260801))
}

function canonicalOutcome(format: 'chart' | 'mid', parse: () => ReturnType<typeof parseChartFileCanonicalIdentity>): CanonicalParseOutcome {
	try {
		const parsed = parse()
		const ranges = collectRangeShifts(format, parsed.trackData)
		const tempoMap = buildTempoMap(parsed)
		const tracks = parsed.trackData.map(track => ({
			profile: 'canonical-20260801' as const,
			key: { instrument: track.instrument, difficulty: track.difficulty },
			semantics: buildSemantics(parsed, tempoMap, track, ranges.byTrack.get(identityTrackKey(track.instrument, track.difficulty)) ?? []),
			[canonicalParsedTrackToken]: true as const,
		}))
		return {
			kind: 'accepted',
			chart: {
				profile: 'canonical-20260801',
				sourceFormat: format,
				duration: calculateCanonicalChartDuration(parsed),
				tempoMap,
				tracks,
			},
			notices: ranges.notices,
		}
	} catch (error: unknown) {
		return {
			kind: 'rejected',
			errors: [{ code: 'sourceParseFailed', message: describeError(error) }],
		}
	}
}
