import { defaultMetadata } from '../ini/metadata'
import type { Instrument } from '../types'
import { cloneClassifiedTrack } from './chart-reparse'
import { TokensCache } from './edit-history'
import {
	applyMidiRules,
	buildMidiInstrumentTrackData,
	classifyMidiFile,
	classifyMidiInstrumentTrack,
	ClassifiedMidi,
	midiFirstCodaTick,
	midiTokensForParsing,
} from './midi-file-parser'
import { changedTrackChunks, midiTokensToMidiData, MidiTokens, midiTrackBodies, MidiTrackChunk, midiTrackEvents, midiTrackIndex } from './midi-tokens'
import {
	chartDrumType,
	isTrackAllocated,
	parseChartSource,
	ParsedChartFile,
	resolveChartData,
	ResolvedTrack,
	resolveTrack,
	TrackResolutionContext,
} from './parse-chart-file'
import type { ParseRules } from './parse-rules'
import type { RawChartData } from './raw-types'
import type { IniChartModifiers } from './types'

type ClassifiedTrack = RawChartData['trackData'][number]

/** What a parse of a `.mid` file keeps, so a parse of an edited version can reuse the track chunks the edit didn't change. */
interface MidiParseMemo {
	/** The rule profile and settings it was parsed with; another parse reuses it only with the same. */
	readonly key: string
	/** Each chunk's body, or `null` for a skipped chunk. */
	readonly bodies: readonly (Uint8Array | null)[]
	/** The instrument of each chunk read as an instrument track, by chunk index, a later track of an instrument included. */
	readonly instruments: ReadonlyMap<number, Instrument>
	/** The classified tracks of each instrument chunk that is read, one for each difficulty, kept unresolved, in file order. */
	readonly classified: ReadonlyMap<number, readonly ClassifiedTrack[]>
	/** Each resolved track, by chunk and difficulty, with the resolution and drum type it was resolved with. */
	readonly resolved: ReadonlyMap<string, { readonly context: string; readonly track: ResolvedTrack }>
	/** The tick of the first coda event, which classifying an instrument track reads. */
	readonly firstCodaTick: number | null
	readonly parsed: ParsedChartFile
}

const memos = new TokensCache<MidiParseMemo, MidiTokens>()

/**
 * Parses a tokenized `.mid` file with a rule profile, exactly as `parseChartSource` does. When the tokens were made by
 * editing tokens already parsed with the same rules and settings, an instrument track chunk the edit didn't change
 * keeps its earlier classification, and keeps its resolved tracks too when the tempo map, resolution and drum type are
 * unchanged. When the edit changed only instrument track chunks, and none of them is read as another instrument, the
 * rest of the earlier result is kept too. Kept parts are shared with the earlier result, so treat both as read-only.
 *
 * Throws an exception exactly as parsing the file's bytes would.
 */
export function parseMidiTokens(tokens: MidiTokens, partialIniChartModifiers: Partial<IniChartModifiers>, rules: ParseRules): ParsedChartFile {
	const iniChartModifiers = Object.assign({}, defaultMetadata, partialIniChartModifiers) as IniChartModifiers
	const key = `${rules.profile}|${JSON.stringify(iniChartModifiers)}`
	const own = memos.get(tokens)
	if (own?.key === key) return own.parsed
	// A file with an unknown chunk is read again strictly to be rejected as parsing its bytes rejects it.
	if (midiTokensForParsing(tokens, tokens.data) !== tokens) return parseChartSource({ format: 'mid', bytes: tokens.data, tokens }, partialIniChartModifiers, rules)
	const earlier = memos.original(tokens)
	const memo = parseReusing(tokens, iniChartModifiers, rules, key, earlier?.key === key ? earlier : undefined)
	memos.set(tokens, memo)
	return memo.parsed
}

function parseReusing(
	tokens: MidiTokens,
	iniChartModifiers: IniChartModifiers,
	rules: ParseRules,
	key: string,
	earlier: MidiParseMemo | undefined,
): MidiParseMemo {
	const bodies = midiTrackBodies(tokens)
	const changed = earlier ? changedTrackChunks(earlier.bodies, bodies) : null
	const trackChunks = bodies.flatMap((body, chunk) => body === null ? [] : [chunk])
	// The tempo map is read from the first track.
	const temposUnchanged = changed !== null && !changed.has(trackChunks[0])

	const classified = new Map<number, readonly ClassifiedTrack[]>()
	const chunkOf = new WeakMap<ClassifiedTrack, number>()
	const unchanged = new WeakSet<ClassifiedTrack>()
	const buildTrack = (chunk: number, firstCodaTick: number | null, build: () => ClassifiedTrack[]) => {
		const kept = earlier?.classified.get(chunk)
		let tracks: ClassifiedTrack[]
		if (kept !== undefined && changed !== null && !changed.has(chunk) && earlier!.firstCodaTick === firstCodaTick) {
			classified.set(chunk, kept)
			// A shallow copy keeps `kept` intact until the track is resolved again, which copies it deeply first.
			tracks = kept.map(track => ({ ...track }))
			for (const track of tracks) unchanged.add(track)
		} else {
			tracks = build()
			classified.set(chunk, tracks.map(cloneClassifiedTrack))
		}
		for (const track of tracks) chunkOf.set(track, chunk)
		return tracks
	}

	const resolved = new Map<string, { context: string; track: ResolvedTrack }>()
	const resolveOne = (track: ClassifiedTrack, context: TrackResolutionContext) => {
		const name = `${chunkOf.get(track)!}|${track.difficulty}`
		// Only drum tracks are resolved with the drum type.
		const contextKey = `${context.resolution}|${track.instrument === 'drums' ? context.drumType : ''}`
		const kept = temposUnchanged ? earlier?.resolved.get(name) : undefined
		const result = !unchanged.has(track) ? resolveTrack(track, context)
			: kept?.context === contextKey ? kept.track
			: resolveTrack(cloneClassifiedTrack(track), context)
		resolved.set(name, { context: contextKey, track: result })
		return result
	}

	// When only instrument track chunks changed, each still read as the same instrument, everything parsed from the other
	// chunks is unchanged: only the tracks and the drum type, which the drum tracks decide, are parsed again.
	const rescanned = earlier && changed && rescanInstrumentChunks(tokens, changed, earlier.instruments)
	if (rescanned) {
		const { firstCodaTick } = earlier!
		const trackData: ClassifiedTrack[] = []
		for (const chunk of earlier!.classified.keys()) {
			const build = () => buildMidiInstrumentTrackData(rescanned.get(chunk)!, iniChartModifiers, firstCodaTick, rules)
			for (const track of buildTrack(chunk, firstCodaTick, build)) trackData.push(track)
		}
		const { tempos, resolution } = earlier!.parsed
		const drumType = chartDrumType(trackData, iniChartModifiers)
		const context: TrackResolutionContext = { timedTempos: tempos, drumType, iniChartModifiers, resolution, format: 'mid', proDrumsGreenPair: rules.proDrumsGreenPair }
		const resolvedTracks = trackData.map(track => resolveOne(track, context))
		const parsed = { ...earlier!.parsed, drumType, trackData: resolvedTracks.filter(track => isTrackAllocated(track.noteEventGroups, 'mid', rules)) }
		return { key, bodies, instruments: earlier!.instruments, classified, resolved, firstCodaTick, parsed }
	}

	const classifiedMidi = classifyMidiFile(midiTokensToMidiData(tokens))
	const instruments = new Map(classifiedMidi.instrumentTracks.map(({ trackIndex, instrument }) => [trackChunks[trackIndex], instrument]))
	const firstCodaTick = midiFirstCodaTick(classifiedMidi.eventsScan)
	const raw = applyMidiRules(classifiedMidi, iniChartModifiers, rules, (instrumentTrack, build) =>
		buildTrack(trackChunks[instrumentTrack.trackIndex], firstCodaTick, build))
	const parsed = resolveChartData(raw, 'mid', iniChartModifiers, rules, resolveOne)
	return { key, bodies, instruments, classified, resolved, firstCodaTick, parsed }
}

/**
 * Scans each changed chunk again as an instrument track. Returns `null` unless every changed chunk was an instrument
 * track and is still read as the same instrument.
 */
function rescanInstrumentChunks(
	tokens: MidiTokens,
	changed: ReadonlySet<number>,
	instruments: ReadonlyMap<number, Instrument>,
): Map<number, ClassifiedMidi['instrumentTracks'][number]> | null {
	const rescanned = new Map<number, ClassifiedMidi['instrumentTracks'][number]>()
	for (const chunk of changed) {
		const instrument = instruments.get(chunk)
		if (instrument === undefined) return null
		const scanned = classifyMidiInstrumentTrack(midiTrackIndex(tokens, chunk), midiTrackEvents(tokens.chunks[chunk] as MidiTrackChunk))
		if (scanned?.instrument !== instrument) return null
		rescanned.set(chunk, scanned)
	}
	return rescanned
}
