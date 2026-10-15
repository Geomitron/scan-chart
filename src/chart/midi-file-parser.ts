import { MidiData, MidiEvent, MidiSetTempoEvent, MidiTextEvent, MidiTimeSignatureEvent } from '@geomitron/midi-file'

import { difficulties, Difficulty, getInstrumentType, Instrument, InstrumentType, instrumentTypes } from '../types'
import { midiTokensToMidiData, MidiTokens, readMidiTokens } from './midi-tokens'
import { DrumMixEvent, EventType, eventTypes, RawChartData, VocalTrackData } from './raw-types'
import { IniChartModifiers } from './types'
import { parseRules, ParseRules } from './parse-rules'
import { scanVocalTrack } from './lyric-parser'
import { toLowerInvariant } from '../shared/text'

// Union two phrase lists, dedup by tick (keep longest length), sort by tick.
function mergePhraseLists(a: { tick: number; length: number }[], b: { tick: number; length: number }[]): { tick: number; length: number }[] {
	const byTick = new Map<number, number>()
	for (const p of [...a, ...b]) {
		const existing = byTick.get(p.tick)
		if (existing === undefined || p.length > existing) byTick.set(p.tick, p.length)
	}
	return [...byTick.entries()]
		.sort((x, y) => x[0] - y[0])
		.map(([tick, length]) => ({ tick, length }))
}

type TrackName = (typeof trackNames)[number]
type VocalTrackName = 'PART VOCALS' | 'HARM1' | 'HARM2' | 'HARM3' | 'PART HARM1' | 'PART HARM2' | 'PART HARM3'
type InstrumentTrackName = Exclude<TrackName, VocalTrackName | 'EVENTS'>
const trackNames = [
	'T1 GEMS',
	'PART GUITAR',
	'PART GUITAR COOP',
	'PART RHYTHM',
	'PART BASS',
	'PART DRUMS',
	'PART DRUM',
	'PART KEYS',
	'PART GUITAR GHL',
	'PART GUITAR COOP GHL',
	'PART RHYTHM GHL',
	'PART BASS GHL',
	'PART KEYS GHL',
	'PART VOCALS',
	'HARM1',
	'HARM2',
	'HARM3',
	'PART HARM1',
	'PART HARM2',
	'PART HARM3',
	'EVENTS',
] as const
/** Clone Hero lowercases MIDI track names before matching them (MidReader.ReadMidiData). */
const trackNamesByLowercase = new Map<string, TrackName>(trackNames.map(name => [name.toLowerCase(), name]))

const vocalTrackNameMap: { [key in VocalTrackName]: string } = {
	'PART VOCALS': 'vocals',
	'HARM1': 'harmony1',
	'HARM2': 'harmony2',
	'HARM3': 'harmony3',
	'PART HARM1': 'harmony1',
	'PART HARM2': 'harmony2',
	'PART HARM3': 'harmony3',
} as const
/* eslint-disable @typescript-eslint/naming-convention */
const instrumentNameMap: { [key in InstrumentTrackName]: Instrument } = {
	'T1 GEMS': 'guitar',
	'PART GUITAR': 'guitar',
	'PART GUITAR COOP': 'guitarcoop',
	'PART RHYTHM': 'rhythm',
	'PART BASS': 'bass',
	'PART DRUMS': 'drums',
	'PART DRUM': 'drums',
	'PART KEYS': 'keys',
	'PART GUITAR GHL': 'guitarghl',
	'PART GUITAR COOP GHL': 'guitarcoopghl',
	'PART RHYTHM GHL': 'rhythmghl',
	'PART BASS GHL': 'bassghl',
	'PART KEYS GHL': 'keysghl',
} as const
/* eslint-enable @typescript-eslint/naming-convention */

/** The instrument a MIDI track name stands for, or `null` for a track that isn't an instrument's. */
export function midiTrackInstrument(trackName: string): Instrument | null {
	return Object.prototype.hasOwnProperty.call(instrumentNameMap, trackName) ? instrumentNameMap[trackName as InstrumentTrackName] : null
}

/** The instrument a MIDI track's name, as written in any letter case, stands for, or `null`. */
export function midiSourceTrackInstrument(sourceName: string): Instrument | null {
	const trackName = trackNamesByLowercase.get(toLowerInvariant(sourceName))
	return trackName === undefined ? null : midiTrackInstrument(trackName)
}

/** The tracks of a `.mid` file that Clone Hero's names make an instrument's, in file order, each with its name as written. */
export function midiInstrumentTracks(tokens: MidiTokens): { name: string; instrument: Instrument }[] {
	const tracks: { name: string; instrument: Instrument }[] = []
	// The first track is the conductor track. A track is named by its last name at tick 0.
	for (const chunk of tokens.chunks.filter(chunk => chunk.kind === 'track').slice(1)) {
		if (chunk.kind !== 'track') continue
		const names = chunk.events.filter(({ tick, event }) => tick === 0 && event.type === 'trackName').map(({ event }) => (event as { text: string }).text)
		const name = names[names.length - 1]
		const instrument = name === undefined ? null : midiSourceTrackInstrument(name)
		if (instrument !== null) tracks.push({ name, instrument })
	}
	return tracks
}

/** The instruments a `.mid` file has more than one track for, of which Clone Hero reads only the first. */
export function repeatedMidiInstruments(tokens: MidiTokens): Instrument[] {
	const trackCounts = new Map<Instrument, number>()
	for (const { instrument } of midiInstrumentTracks(tokens)) trackCounts.set(instrument, (trackCounts.get(instrument) ?? 0) + 1)
	return [...trackCounts].filter(([, count]) => count > 1).map(([instrument]) => instrument)
}

const sysExDifficultyMap = ['easy', 'medium', 'hard', 'expert'] as const
const discoFlipDifficultyMap = ['easy', 'medium', 'hard', 'expert'] as const
const fiveFretDiffStarts = { easy: 59, medium: 71, hard: 83, expert: 95 }
const sixFretDiffStarts = { easy: 58, medium: 70, hard: 82, expert: 94 }
const drumsDiffStarts = { easy: 60, medium: 72, hard: 84, expert: 96 }
const midiDiscoFlipRegex = /^\s*\[?mix[ _]([0-3])[ _]drums([0-5])(d|dnoflip|easy|easynokick|)\]?\s*$/
const eventsBracketedSectionRegex = /^\[(?:section|prc)[ _](.*)\]$/
const eventsPlainSectionRegex = /^(?:section|prc)[ _](.*)$/
const eventsEndRegex = /^\[?end\]?$/
const eventsCodaRegex = /^\s*\[?coda\]?\s*$/
const eventsLyricRegex = /^\[?\s*lyric[ \t]/
const eventsPhraseStartRegex = /^\[?phrase_start\]?$/
const eventsPhraseEndRegex = /^\[?phrase_end\]?$/

export interface TrackEventEnd {
	tick: number
	type: EventType
	// Necessary because .mid stores some additional modifiers and information using velocity
	velocity: number
	channel: number
	// Necessary because .mid stores track events as separate start and end events
	isStart: boolean
	/** On difficulty notes: `true` if an `[ENABLE_CHART_DYNAMICS]` event came earlier in the MIDI track. */
	chartDynamics?: boolean
	/** The index in its MIDI track of the event this came from. */
	eventIndex: number
	/**
	 * On a Phase Shift SysEx event, its difficulty byte. A SysEx start and end pair only when the byte is the same, and
	 * never with a note, as Clone Hero keeps a stack for each SysEx phrase and difficulty (TrackChunk).
	 */
	sysExDifficulty?: number
}

// Necessary because .mid stores some additional modifiers and information using velocity
type MidiTrackEvent = RawChartData['trackData'][number]['trackEvents'][number] & {
	velocity: number
	channel: number
	chartDynamics?: boolean
}

/**
 * Parses `buffer` as a chart in the .mid format. Returns all the note data in `RawChartData`, but any
 * chart format rules that apply to both .chart and .mid have not been applied. This is a partial result
 * that can be produced by both the .chart and .mid formats so that the remaining chart rules can be parsed
 * without code duplication.
 *
 * Throws an exception if `buffer` could not be parsed as a chart in the .mid format.
 *
 * Note: these features of .mid are ignored (for now)
 * Versus phrase markers
 * Trill lanes
 * Tremolo lanes
 * [PART DRUMS_2X] (RBN)
 * Real Drums (Phase Shift)
 */
export function parseNotesFromMidi(data: Uint8Array, iniChartModifiers: IniChartModifiers, rules: ParseRules = parseRules.scanner): RawChartData {
	return applyMidiRules(classifyMidiFile(readMidiFile(data)), iniChartModifiers, rules)
}

/**
 * Reads a `.mid` file, with each event's `deltaTime` converted to its absolute tick.
 *
 * Throws an exception as `readMidiFileTokens` does.
 */
export function readMidiFile(data: Uint8Array): MidiData {
	return midiTokensToMidiData(readMidiFileTokens(data))
}

/**
 * Reads a `.mid` file as tokens that keep every byte of it.
 *
 * Throws an exception if the file isn't a format-1 MIDI file with ticks per beat and at least one track. A chunk
 * type other than `MTrk` among the tracks is rejected too, as it was when `.mid` files were read with `parseMidi`.
 */
export function readMidiFileTokens(data: Uint8Array): MidiTokens {
	return checkMidiFileTokens(readMidiTokens(data, 'reject'))
}

/**
 * Returns tokens read with unknown chunks kept, checked as `readMidiFileTokens` checks them. A file with an unknown
 * chunk is read again strictly, so it is rejected exactly as before.
 */
export function midiTokensForParsing(tokens: MidiTokens | null, data: Uint8Array): MidiTokens {
	if (tokens === null || tokens.chunks.some(chunk => chunk.kind === 'skipped' && chunk.id !== 'MTrk')) return readMidiFileTokens(data)
	return checkMidiFileTokens(tokens)
}

function checkMidiFileTokens(tokens: MidiTokens): MidiTokens {
	const { header } = tokens.header
	if (header.format !== 1) {
		throw `Invavlid .mid file: unsupported header format "${header.format}"`
	}

	if (!header.ticksPerBeat) {
		throw 'Invalid .mid file: resolution in ticks per SMPTE frame is not supported'
	}

	if (!tokens.chunks.some(chunk => chunk.kind === 'track')) {
		throw 'Invalid .mid file: no tracks detected'
	}

	return tokens
}

/** A `.mid` file's tracks and events, classified without a rule profile. */
export interface ClassifiedMidi {
	ticksPerBeat: number
	tempos: { tick: number; beatsPerMinute: number }[]
	timeSignatures: { tick: number; numerator: number; denominator: number }[]
	vocalTracks: { [part: string]: VocalTrackData }
	eventsScan: EventsScanResult
	instrumentTracks: { instrument: Instrument; instrumentType: InstrumentType; trackIndex: number; scan: TrackScanResult }[]
	unrecognizedMidiTracks: RawChartData['unrecognizedMidiTracks']
}

/** Classifies a read `.mid` file's tracks and events. No rule profile is involved. */
export function classifyMidiFile(midiFile: MidiData): ClassifiedMidi {
	checkPhaseShiftSysExStacks(midiFile)
	const { tracks, unrecognizedMidiTracks } = getTracks(midiFile)

	// Build vocalTracks from PART VOCALS and HARM1/HARM2/HARM3.
	// Separate note 105 (scoring phrases) from note 106 (static lyric / player-2
	// display phrases) at extraction time. This lets the writer round-trip HARM2/HARM3
	// without any pre-CopyDown stashing: HARM2/HARM3 emit staticLyricPhrases as
	// note 106 on their own track, HARM1 emits vocalPhrases as note 105, and CopyDown
	// on re-parse re-copies HARM1's vocalPhrases to HARM2/HARM3 — identical result.
	const vocalTracks: { [part: string]: VocalTrackData } = {}
	for (const track of tracks) {
		const partName = vocalTrackNameMap[track.trackName as VocalTrackName]
		if (partName && !vocalTracks[partName]) {
			// Single pass over the vocal track classifies all fields at once:
			// lyrics, textEvents (MoonText), note 105/106 phrases, pitched +
			// percussion notes, star power (116), range shifts (0), lyric
			// shifts (1). Consumed events (ENHANCED_OPENS, disco flip, etc.)
			// are dropped inside the classifier.
			//
			// YARG treats BOTH note 105 (LYRICS_PHRASE_1) and note 106
			// (LYRICS_PHRASE_2) as creating a `Vocals_StaticLyricPhrase` in
			// HARM2/HARM3's specialPhrases (plus `Vocals_ScoringPhrase` which
			// CopyDown later replaces from HARM1). Match that by unioning both
			// sets for harmony parts. For solo vocals and HARM1, the
			// static-lyric view is simply a duplicate of the note-phrase
			// (scoring) list per YARG's MoonSongLoader.Vocals.cs.
			const scanned = scanVocalTrack(track.trackEvents)
			const isHarmonyBacking = partName === 'harmony2' || partName === 'harmony3'
			vocalTracks[partName] = {
				lyrics: scanned.lyrics,
				vocalPhrases: scanned.phrases105,
				notes: scanned.notes,
				starPowerSections: scanned.starPower,
				rangeShifts: scanned.rangeShifts,
				lyricShifts: scanned.lyricShifts,
				staticLyricPhrases: isHarmonyBacking
					? mergePhraseLists(scanned.phrases105, scanned.phrases106)
					: scanned.phrases106,
				textEvents: scanned.textEvents,
				unrecognizedMidiEvents: scanned.unrecognizedMidiEvents,
			}
		}
	}

	// YARG CopyDownPhrases: HARM2/HARM3 get scoring phrases AND star power from HARM1.
	// This only touches vocalPhrases/starPowerSections — staticLyricPhrases are
	// extracted directly from note 106 on HARM2/HARM3 and are NOT touched here.
	// CopyDown is idempotent (re-parse → re-CopyDown produces the same result).
	if (vocalTracks.harmony1) {
		const harm1Phrases = vocalTracks.harmony1.vocalPhrases
		const harm1StarPower = vocalTracks.harmony1.starPowerSections
		if (vocalTracks.harmony2) {
			vocalTracks.harmony2.vocalPhrases = harm1Phrases.map(p => ({ ...p }))
			vocalTracks.harmony2.starPowerSections = harm1StarPower.map(p => ({ ...p }))
		}
		if (vocalTracks.harmony3) {
			vocalTracks.harmony3.vocalPhrases = harm1Phrases.map(p => ({ ...p }))
			vocalTracks.harmony3.starPowerSections = harm1StarPower.map(p => ({ ...p }))
			// HARM3 gets HARM2's staticLyricPhrases (matching YARG's CopyDownPhrases)
			if (vocalTracks.harmony2) {
				vocalTracks.harmony3.staticLyricPhrases = vocalTracks.harmony2.staticLyricPhrases.map(p => ({ ...p }))
			}
		}
	}

	// Classify each text-like event on the EVENTS track into one of:
	// sections, endEvents, codaEvents, or unrecognizedTextEvents (the remainder).
	// Non-text events (noteOn/Off, sysEx, channel events, etc.) go to
	// unrecognizedMidiEvents.
	const eventsScan = scanEventsTrack(tracks)
	const instrumentTracks = scanInstrumentTracks(tracks)

	return {
		ticksPerBeat: midiFile.header.ticksPerBeat!,
		tempos: extractTempos(midiFile.tracks[0]),
		timeSignatures: extractTimeSignatures(midiFile.tracks[0]),
		vocalTracks,
		eventsScan,
		instrumentTracks,
		unrecognizedMidiTracks,
	}
}

/**
 * Throws for a Phase Shift SysEx event Clone Hero's MIDI reader can't read. It pairs each one in a stack for its phrase
 * and difficulty, numbered phrase × 5 + difficulty (4 for all difficulties), and has 100 (TrackChunk), so a higher
 * number throws, on any track, with or without an end: HashScanTool fails to load a chart with phrase 19 and difficulty
 * 5, phrase 20 and difficulty 0 or 0xFF, or a tap with difficulty 200, and loads phrase 19 with difficulty 4. It reads
 * an event as Phase Shift SysEx when it is 8 bytes, `50 53 00 00 <difficulty> <phrase> <status> F7`.
 */
function checkPhaseShiftSysExStacks(midiFile: MidiData): void {
	for (const track of midiFile.tracks) {
		for (const event of track) {
			if (event.type !== 'sysEx' && event.type !== 'endSysEx') continue
			const { data } = event
			if (data.length !== 8 || data[0] !== 0x50 || data[1] !== 0x53 || data[2] !== 0x00 || data[3] !== 0x00 || data[7] !== 0xf7) continue
			const [difficulty, phrase] = [data[4], data[5]]
			if (phrase * 5 + (difficulty === 0xff ? 4 : difficulty) >= 100) {
				throw `Invalid .mid file: The Phase Shift SysEx event at tick ${event.deltaTime} has phrase ${phrase} and difficulty ${difficulty}, which Clone Hero can't read.`
			}
		}
	}
}

/**
 * Scans each instrument track of a read `.mid` file, as classification does, without reading the conductor track. A
 * malformed tempo or time signature, which makes classification throw, doesn't stop it.
 */
export function classifyMidiInstrumentTracks(midiFile: MidiData): ClassifiedMidi['instrumentTracks'] {
	return scanInstrumentTracks(getTracks(midiFile).tracks)
}

/**
 * Scans the track at `trackIndex` of a read `.mid` file as `classifyMidiInstrumentTracks` does, or returns `null` when
 * it isn't read as an instrument track. `events` are the track's events with each `deltaTime` replaced by its tick.
 */
export function classifyMidiInstrumentTrack(trackIndex: number, events: MidiEvent[]): ClassifiedMidi['instrumentTracks'][number] | null {
	const track = recognizedTrack(trackIndex, events, trackSourceName(events))
	return track === null ? null : scanInstrumentTracks([track])[0] ?? null
}

function scanInstrumentTracks(tracks: MidiSourceTrack[]): ClassifiedMidi['instrumentTracks'] {
	const instrumentTracks: ClassifiedMidi['instrumentTracks'] = []
	for (const t of tracks) {
		const instrument = instrumentNameMap[t.trackName as InstrumentTrackName]
		if (instrument === undefined) continue // vocal/EVENTS tracks handled elsewhere
		const instrumentType = getInstrumentType(instrument)
		instrumentTracks.push({ instrument, instrumentType, trackIndex: t.trackIndex, scan: scanInstrumentTrack(t.trackEvents, instrumentType, t.sourceName) })
	}
	return instrumentTracks
}

/**
 * Applies a rule profile to a classified `.mid` file. Returns all the note data in `RawChartData`; the rules
 * shared with .chart are applied when the notes are resolved. Leaves `classified` unchanged.
 *
 * `buildTrack` builds each instrument track that is read by calling `build`; a reparse can give back the tracks it built
 * before from the same track instead.
 */
export function applyMidiRules(
	classified: ClassifiedMidi,
	iniChartModifiers: IniChartModifiers,
	rules: ParseRules,
	buildTrack: MidiTrackBuilder = (_instrumentTrack, build) => build(),
): RawChartData {
	const { eventsScan } = classified
	const firstCodaTick = midiFirstCodaTick(eventsScan)

	return {
		chartTicksPerBeat: classified.ticksPerBeat,
		metadata: {}, // .mid does not have a mechanism for storing song metadata
		vocalTracks: classified.vocalTracks,
		tempos: classified.tempos,
		timeSignatures: classified.timeSignatures,
		unrecognizedSyncTrackEvents: [], // .chart-only

		sections: eventsScan.sections,
		endEvents: eventsScan.endEvents,
		unrecognizedEventsTrackTextEvents: eventsScan.unrecognizedTextEvents,
		unrecognizedEventsTrackMidiEvents: eventsScan.unrecognizedMidiEvents,
		unrecognizedMidiTracks: classified.unrecognizedMidiTracks,
		unrecognizedChartSections: [],
		trackData: buildMidiTrackData(classified.instrumentTracks, iniChartModifiers, firstCodaTick, rules, buildTrack),
		parseIssues: [...eventsScan.parseIssues],
	}
}

/** Builds one instrument track's classified tracks, one for each difficulty it allocates, as `build` does. */
export type MidiTrackBuilder = (
	instrumentTrack: ClassifiedMidi['instrumentTracks'][number],
	build: () => RawChartData['trackData'],
) => RawChartData['trackData']

/** The tick of the events track's first coda event, which a drum freestyle section's `isCoda` is read against. */
export function midiFirstCodaTick(eventsScan: EventsScanResult): number | null {
	return eventsScan.codaEvents[0]?.tick ?? null
}

function buildMidiTrackData(
	instrumentTracks: ClassifiedMidi['instrumentTracks'],
	iniChartModifiers: IniChartModifiers,
	firstCodaTick: number | null,
	rules: ParseRules,
	buildTrack: MidiTrackBuilder,
): RawChartData['trackData'] {
	const out: RawChartData['trackData'] = []
	const seenInstruments = new Set<Instrument>()

	for (const instrumentTrack of instrumentTracks) {
		const { instrument } = instrumentTrack
		// Clone Hero marks the instrument as seen even when its first track has no notes.
		if (rules.midiDuplicateInstrumentTracks === 'firstWins' && seenInstruments.has(instrument)) continue
		seenInstruments.add(instrument)
		const build = () => buildMidiInstrumentTrackData(instrumentTrack, iniChartModifiers, firstCodaTick, rules)
		for (const track of buildTrack(instrumentTrack, build)) out.push(track)
	}

	return out
}

/** The classified tracks of one instrument track that is read, one for each difficulty it allocates, in difficulty order. */
export function buildMidiInstrumentTrackData(
	{ instrument, instrumentType, scan }: ClassifiedMidi['instrumentTracks'][number],
	iniChartModifiers: IniChartModifiers,
	firstCodaTick: number | null,
	rules: ParseRules,
): RawChartData['trackData'] {
	const out: RawChartData['trackData'] = []
	const allocatesEmptyExpert = rules.midiTrackAllocation === 'difficultiesWithNotesAndExpert'
	const { eventEnds, textEvents, versusPhrases, animations, unrecognizedEvents: trackUnrecognized, drumMixes, unloadableSysEx } = scan
	if (unloadableSysEx !== null && (instrumentType === instrumentTypes.fiveFret || instrumentType === instrumentTypes.sixFret)) {
		const phrase = unloadableSysEx.type === eventTypes.forceTap ? 'tap' : 'open'
		throw `Invalid .mid file: The ${phrase} SysEx phrase at tick ${unloadableSysEx.tick} has difficulty ${unloadableSysEx.sysExDifficulty}, which isn't 0 to 3 or 255.`
	}
	// distributeInstrumentEvents adds to and sorts these lists, and a classification can be shared by profiles
	const distributed = distributeInstrumentEvents({
		all: [...eventEnds.all],
		expert: [...eventEnds.expert],
		hard: [...eventEnds.hard],
		medium: [...eventEnds.medium],
		easy: [...eventEnds.easy],
	}, allocatesEmptyExpert)
	const pairedEvents = getTrackEvents(distributed)
	const step1 = splitMidiModifierSustains(pairedEvents, instrumentType, rules)
	const step2 = fixLegacyGhStarPower(step1, instrumentType, iniChartModifiers)
	const trackDifficulties = fixFlexLaneLds(step2)

	for (const difficulty of difficulties) {
		const diffEvents = trackDifficulties[difficulty]
		if (diffEvents.length === 0 && !(allocatesEmptyExpert && difficulty === 'expert')) continue

		const result: RawChartData['trackData'][number] = {
			instrument,
			difficulty,
			starPowerSections: [],
			rejectedStarPowerSections: [],
			soloSections: [],
			flexLanes: [],
			drumFreestyleSections: [],
			trackEvents: [],
			textEvents,
			versusPhrases,
			animations,
			unrecognizedMidiEvents: trackUnrecognized,
			...(instrumentType === instrumentTypes.drums ? { drumMixes: drumMixes[difficulty] } : {}),
		}

		// Track "real content" flag inline so we don't need a second pass over
		// result.trackEvents to decide whether to keep this difficulty result.
		let hasRealTrackEvents = false
		for (const event of diffEvents) {
			switch (event.type) {
				case eventTypes.starPower:
					result.starPowerSections.push(event); break
				case eventTypes.rejectedStarPower:
					result.rejectedStarPowerSections.push(event); break
				case eventTypes.soloSection:
					result.soloSections.push(event); break
				case eventTypes.flexLaneSingle:
					result.flexLanes.push({ tick: event.tick, length: event.length, isDouble: false }); break
				case eventTypes.flexLaneDouble:
					result.flexLanes.push({ tick: event.tick, length: event.length, isDouble: true }); break
				case eventTypes.freestyleSection:
					result.drumFreestyleSections.push({
						tick: event.tick,
						length: event.length,
						isCoda: firstCodaTick === null ? false : event.tick >= firstCodaTick,
					}); break
				default:
					result.trackEvents.push(event)
					if (!hasRealTrackEvents && event.type !== eventTypes.enableChartDynamics) {
						hasRealTrackEvents = true
					}
			}
		}

		// Tracks with only global modifier events (e.g. [ENABLE_CHART_DYNAMICS])
		// and no notes are dropped so writer round-trip stays stable.
		if (allocatesEmptyExpert || hasRealTrackEvents || result.starPowerSections.length > 0 || result.soloSections.length > 0) {
			out.push(result)
		}
	}

	return out
}

function extractTempos(conductorTrack: MidiEvent[]): { tick: number; beatsPerMinute: number }[] {
	const tempos: { tick: number; beatsPerMinute: number }[] = []
	for (const e of conductorTrack) {
		if (e.type !== 'setTempo') continue
		tempos.push({
			tick: e.deltaTime,
			beatsPerMinute: 60000000 / (e as MidiSetTempoEvent).microsecondsPerBeat,
		})
	}
	// A tempo of 0 microseconds per beat is an infinite BPM, which Clone Hero refuses (Song.AddTempo), as a .chart's
	// tempo of 0 is refused.
	for (const tempo of tempos) {
		if (!Number.isFinite(tempo.beatsPerMinute)) {
			throw `Invalid .mid file: Tempo at tick ${tempo.tick} was zero.`
		}
	}
	if (!tempos[0] || tempos[0].tick !== 0) {
		tempos.unshift({ tick: 0, beatsPerMinute: 120 })
	}
	return tempos
}

function extractTimeSignatures(conductorTrack: MidiEvent[]): { tick: number; numerator: number; denominator: number }[] {
	const result: { tick: number; numerator: number; denominator: number }[] = []
	for (const e of conductorTrack) {
		if (e.type !== 'timeSignature') continue
		const ts = e as MidiTimeSignatureEvent
		result.push({ tick: e.deltaTime, numerator: ts.numerator, denominator: ts.denominator })
	}
	for (const ts of result) {
		if (ts.numerator === 0) {
			throw `Invalid .mid file: Time signature numerator at tick ${ts.tick} was zero.`
		}
	}
	for (const ts of result) {
		if (ts.denominator === 0) {
			throw `Invalid .mid file: Time signature denominator at tick ${ts.tick} was zero.`
		}
	}
	if (!result[0] || result[0].tick !== 0) {
		result.unshift({ tick: 0, numerator: 4, denominator: 4 })
	}
	return result
}

interface MidiSourceTrack {
	/** The index of the track in the file's MIDI tracks. */
	trackIndex: number
	trackName: TrackName
	/** The recognized track name as written in the file. */
	sourceName: string
	trackEvents: MidiEvent[]
}

/** The index of the track Clone Hero reads as the events track, or `null` when the file has none. */
export function findMidiEventsTrack(midiData: MidiData): number | null {
	return getTracks(midiData).tracks.find(track => track.trackName === 'EVENTS')?.trackIndex ?? null
}

export function isTextLikeEvent(event: MidiEvent): event is MidiTextEvent {
	return event.type === 'text' || event.type === 'lyrics' || event.type === 'marker' || event.type === 'cuePoint'
}

function getTracks(midiData: MidiData) {
	const tracks: MidiSourceTrack[] = []
	const unrecognizedMidiTracks: { trackName: string; events: MidiEvent[] }[] = []

	for (const [i, track] of midiData.tracks.entries()) {
		const sourceName = trackSourceName(track)
		const recognized = recognizedTrack(i, track, sourceName)
		if (recognized !== null) {
			tracks.push(recognized)
		} else if (i !== 0) {
			// Track 0 is the conductor track (tempo/timeSignature) and isn't a
			// musical track — skip it from unrecognized capture.
			unrecognizedMidiTracks.push({
				trackName: sourceName ?? '',
				events: track,
			})
		}
	}

	return { tracks, unrecognizedMidiTracks }
}

/**
 * A track is named by its LAST tick-0 trackName, as in Clone Hero, where each one replaces the previous (DryWetMidi
 * TrackChunk). Some real charts emit a bogus trackName before the real one, and keep their instrument:
 *
 *   [ENHANCED_OPENS] → PART BASS    (Culture Killer - Blindfolded Death)
 *   TEMPO TRACK      → PART DRUMS   (Periphery - Ji)
 *   <song title>     → PART DRUMS   (school food punishment)
 *
 * A real name followed by another one is lost, as it is in Clone Hero: "PART DRUMS" then "[ENABLE_CHART_DYNAMICS]"
 * (HEALTH - Isn't Everyone) is not a drums track.
 */
function trackSourceName(track: MidiEvent[]): string | null {
	let sourceName: string | null = null
	for (const event of track) {
		if (event.deltaTime !== 0) {
			break
		}
		if (event.type === 'trackName') {
			sourceName = event.text
		}
	}
	return sourceName
}

/** The track at index `i` as a recognized track, or `null` when it isn't one. Names are matched in any letter case. */
function recognizedTrack(i: number, track: MidiEvent[], sourceName: string | null): MidiSourceTrack | null {
	const trackName = sourceName === null ? undefined : trackNamesByLowercase.get(toLowerInvariant(sourceName))
	// Clone Hero reads track 0 only as the conductor track and, if it is named so, the events track.
	if (sourceName === null || trackName === undefined || (i === 0 && trackName !== 'EVENTS')) return null
	return { trackIndex: i, trackName, sourceName, trackEvents: track }
}

interface TrackScanResult {
	eventEnds: { [difficulty in Difficulty | 'all']: TrackEventEnd[] }
	textEvents: { tick: number; text: string }[]
	versusPhrases: { tick: number; length: number; isPlayer2: boolean }[]
	animations: { tick: number; length: number; noteNumber: number }[]
	/**
	 * MIDI events kept verbatim for writers: those the typed parser didn't consume, and on a drum track the events of each
	 * tom marker that covers no note (`withUncoveredTomMarkers`), which change no note but which Clone Hero 1.1 reads.
	 */
	unrecognizedEvents: MidiEvent[]
	/** Each difficulty's disco flip mix events, on a drum track. */
	drumMixes: { [difficulty in Difficulty]: DrumMixEvent[] }
	/**
	 * The start of the first tap or open SysEx phrase with a difficulty byte other than 0-3 or 0xFF that has an end.
	 * Clone Hero can't load a 5- or 6-fret track with one (Song.GetOrCreateTrack throws for its difficulty; HashScanTool
	 * fails to load such a tap or open with difficulty 4, 5 or 200), and YARG throws on one too. It loads such a phrase
	 * on a drum track, and a start with no end.
	 */
	unloadableSysEx: TrackEventEnd | null
}

/**
 * Scans a MIDI instrument track and produces:
 *   - note-shaped events grouped by difficulty (further processed by
 *     `distributeInstrumentEvents` / `getTrackEvents`)
 *   - data-carrying events that ride alongside the notes: `textEvents`,
 *     `versusPhrases` (notes 105/106), `animations` (notes 24-51 drums,
 *     40-59 fret).
 *
 * Versus phrases and animations live in the same MIDI event stream as the
 * playable notes, so they're emitted from this single iteration.
 */
function scanInstrumentTrack(
	events: MidiEvent[],
	instrumentType: InstrumentType,
	trackName: string,
): TrackScanResult {
	let enhancedOpens = false
	let chartDynamics = false
	const eeAll: TrackEventEnd[] = []
	const eeExpert: TrackEventEnd[] = []
	const eeHard: TrackEventEnd[] = []
	const eeMedium: TrackEventEnd[] = []
	const eeEasy: TrackEventEnd[] = []
	const eventEnds: { [difficulty in Difficulty | 'all']: TrackEventEnd[] } = {
		all: eeAll,
		expert: eeExpert,
		hard: eeHard,
		medium: eeMedium,
		easy: eeEasy,
	}
	const textEvents: { tick: number; text: string }[] = []
	// Versus phrase 105/106 pairing. Only these two note numbers ever appear,
	// so hold two scalars instead of a Map allocation.
	let versusStart105 = -1
	let versusStart106 = -1
	const versusPhrases: { tick: number; length: number; isPlayer2: boolean }[] = []
	const animStarts = new Map<number, number>() // noteNumber → startTick
	const animations: { tick: number; length: number; noteNumber: number }[] = []
	const animMin = instrumentType === instrumentTypes.drums ? 24 : 40
	const animMax = instrumentType === instrumentTypes.drums ? 51 : 59
	// Events the typed parser doesn't consume — preserved verbatim for round-trip.
	const unrecognizedEvents: MidiEvent[] = []
	const drumMixes: TrackScanResult['drumMixes'] = { expert: [], hard: [], medium: [], easy: [] }
	const otherDifficultySysEx: TrackEventEnd[] = []

	for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
		const event = events[eventIndex]
		const eventType = event.type
		// Hot path: note events are ~90% of a typical instrument track. Dispatch them
		// first so we don't fall through sysEx/text checks for every note event.
		if (eventType === 'noteOn' || eventType === 'noteOff') {
			// A noteOn with velocity 0 is semantically a noteOff for paired-start/end tracking,
			// but `isStart` tracks the literal MIDI event type (not velocity) to match original
			// downstream semantics.
			const isStart = eventType === 'noteOn'
			const velocity = event.velocity
			const isOff = !isStart || velocity === 0
			const nn = event.noteNumber
			const channel = event.channel
			let consumed = false

			// Collect versus phrase markers (notes 105/106). These don't overlap
			// with any note-shaped events, so we don't fall through.
			if (nn === 105) {
				if (!isOff) {
					if (versusStart105 === -1) versusStart105 = event.deltaTime
				} else if (versusStart105 !== -1) {
					versusPhrases.push({ tick: versusStart105, length: event.deltaTime - versusStart105, isPlayer2: false })
					versusStart105 = -1
				}
				continue
			}
			if (nn === 106) {
				if (!isOff) {
					if (versusStart106 === -1) versusStart106 = event.deltaTime
				} else if (versusStart106 !== -1) {
					versusPhrases.push({ tick: versusStart106, length: event.deltaTime - versusStart106, isPlayer2: true })
					versusStart106 = -1
				}
				continue
			}

			// Collect animation events (notes 24-51 drums, 40-59 fret). These
			// overlap with easy-difficulty playable notes (60-66), so the event
			// must also fall through to the difficulty-based dispatch below.
			if (nn >= animMin && nn <= animMax) {
				if (!isOff) {
					if (!animStarts.has(nn)) {
						animStarts.set(nn, event.deltaTime)
					}
				} else {
					const startTick = animStarts.get(nn)
					if (startTick !== undefined) {
						animations.push({ tick: startTick, length: event.deltaTime - startTick, noteNumber: nn })
						animStarts.delete(nn)
					}
				}
				consumed = true
				// fall through — animation note ranges overlap easy-difficulty notes
			}

			let diffArr: TrackEventEnd[]
			let difficulty: Difficulty | 'all'
			if (nn <= 66) { diffArr = eeEasy; difficulty = 'easy' }
			else if (nn <= 78) { diffArr = eeMedium; difficulty = 'medium' }
			else if (nn <= 90) { diffArr = eeHard; difficulty = 'hard' }
			else if (nn <= 102) { diffArr = eeExpert; difficulty = 'expert' }
			else { diffArr = eeAll; difficulty = 'all' }
			if (difficulty === 'all') {
				const type = getInstrumentEventType(nn)
				if (type !== null) {
					diffArr.push({
						tick: event.deltaTime,
						type,
						velocity,
						channel,
						isStart,
						eventIndex,
					})
					consumed = true
				}
			} else {
				const type =
					instrumentType === instrumentTypes.sixFret ? get6FretNoteType(nn, difficulty)
					: instrumentType === instrumentTypes.drums ? getDrumsNoteType(nn, difficulty)
					: instrumentType === instrumentTypes.fiveFret ? get5FretNoteType(nn, difficulty, enhancedOpens)
					: null
				if (type !== null) {
					diffArr.push({
						tick: event.deltaTime,
						type,
						velocity,
						channel,
						isStart,
						chartDynamics,
						eventIndex,
					})
					consumed = true
				}
			}

			if (!consumed) unrecognizedEvents.push(event)
			continue
		}
		// SysEx event (tap modifier or open)
		if (eventType === 'sysEx' || eventType === 'endSysEx') {
			// Phase Shift SysEx event header: 50 53 00 00 <diff> <type> <isStart>
			const isPhaseShiftHeader =
				event.data.length > 6 &&
				event.data[0] === 0x50 &&
				event.data[1] === 0x53 &&
				event.data[2] === 0x00 &&
				event.data[3] === 0x00
			const type =
				!isPhaseShiftHeader ? null
				: event.data[5] === 0x01 ? eventTypes.forceOpen
				: event.data[5] === 0x04 ? eventTypes.forceTap
				: null

			if (type !== null) {
				const d = event.data[4]
				const arr = d === 0xff ? eeAll
					: d === 0 ? eeEasy
					: d === 1 ? eeMedium
					: d === 2 ? eeHard
					: d === 3 ? eeExpert
					: otherDifficultySysEx
				arr.push({
					tick: event.deltaTime,
					type,
					channel: 1,
					velocity: 127,
					isStart: event.data[6] === 0x01,
					eventIndex,
					sysExDifficulty: d,
				})
			} else {
				unrecognizedEvents.push(event)
			}
		} else if (eventType === 'text') {
			let consumedAsNote = false
			if (instrumentType === instrumentTypes.drums) {
				const discoFlipMatch = midiDiscoFlipRegex.exec(event.text)
				if (discoFlipMatch) {
					const difficulty = sysExDifficultyMap[Number(discoFlipMatch[1])]
					const flag = discoFlipMatch[3] as 'd' | 'dnoflip' | 'easy' | 'easynokick' | ''
					// An `easy` or `easynokick` event sets no disco flip, and stays a text event.
					if (flag !== 'easy' && flag !== 'easynokick') {
						const eventType = flag === '' ? eventTypes.discoFlipOff : flag === 'd' ? eventTypes.discoFlipOn : eventTypes.discoNoFlipOn
						// Treat this like the other events that have a start and end, so it can be processed the same way later
						eventEnds[difficulty].push({ tick: event.deltaTime, type: eventType, velocity: 127, channel: 1, isStart: true, eventIndex })
						eventEnds[difficulty].push({ tick: event.deltaTime, type: eventType, velocity: 127, channel: 1, isStart: false, eventIndex })
						drumMixes[difficulty].push({ tick: event.deltaTime, configuration: Number(discoFlipMatch[2]), flag })
						consumedAsNote = true
					}
				}
			}

			if (event.text === 'ENHANCED_OPENS' || event.text === '[ENHANCED_OPENS]') {
				enhancedOpens = true
				consumedAsNote = true
			} else if (event.text === 'ENABLE_CHART_DYNAMICS' || event.text === '[ENABLE_CHART_DYNAMICS]') {
				// Treat this like the other events that have a start and end, so it can be processed the same way later
				eventEnds['all'].push({ tick: event.deltaTime, type: eventTypes.enableChartDynamics, channel: 1, isStart: true, velocity: 127, eventIndex })
				eventEnds['all'].push({ tick: event.deltaTime, type: eventTypes.enableChartDynamics, channel: 1, isStart: false, velocity: 127, eventIndex })
				chartDynamics = true
				consumedAsNote = true
			}

			if (!consumedAsNote) {
				// Skip tick-0 text events that duplicate the track name
				if (event.deltaTime === 0 && event.text === trackName) continue
				textEvents.push({ tick: event.deltaTime, text: event.text })
			}
		} else if (eventType === 'trackName' || eventType === 'endOfTrack') {
			// Trackname is the track identifier; endOfTrack is the MIDI marker.
			// Both are required structural events — writers re-emit them — so
			// they shouldn't appear in unrecognizedEvents.
		} else {
			// Any other event type (marker, lyrics, instrumentName, channel, etc.)
			// is preserved verbatim so writers can round-trip it.
			unrecognizedEvents.push(event)
		}
	}

	versusPhrases.sort((a, b) => a.tick - b.tick)
	animations.sort((a, b) => a.tick - b.tick)
	const unrecognized = instrumentType === instrumentTypes.drums ? withUncoveredTomMarkers(events, eventEnds, unrecognizedEvents) : unrecognizedEvents
	const unloadableSysEx = pairEventEnds(otherDifficultySysEx)[0]?.start ?? null
	return { eventEnds, textEvents, versusPhrases, animations, unrecognizedEvents: unrecognized, drumMixes, unloadableSysEx }
}

const drumNoteEventTypes: EventType[] = [
	eventTypes.kick, eventTypes.kick2x, eventTypes.redDrum, eventTypes.yellowDrum, eventTypes.blueDrum, eventTypes.fiveOrangeFourGreenDrum, eventTypes.fiveGreenDrum,
]

/**
 * A drum track's unrecognized events, with the events of each tom marker that covers no drum note on any difficulty,
 * in track order. Such a marker changes no note and doesn't make the chart pro drums here, as in the canonical rules,
 * but Clone Hero 1.1 reads any tom marker as pro drums, so the `.mid` writer writes it back.
 */
function withUncoveredTomMarkers(events: MidiEvent[], eventEnds: TrackScanResult['eventEnds'], unrecognizedEvents: MidiEvent[]): MidiEvent[] {
	const tomMarkers = eventEnds.all.filter(end => end.type === eventTypes.yellowTomMarker || end.type === eventTypes.blueTomMarker || end.type === eventTypes.greenTomMarker)
	if (tomMarkers.length === 0) return unrecognizedEvents
	const noteTicks = difficulties
		.flatMap(difficulty => eventEnds[difficulty].filter(end => end.isStart && drumNoteEventTypes.includes(end.type)).map(end => end.tick))
		.sort((a, b) => a - b)
	const uncovered = new Set<number>()
	let next = 0
	// Pairs come in start order, so the first note at or after each start only moves forward.
	for (const { start, end } of pairEventEnds(tomMarkers)) {
		while (next < noteTicks.length && noteTicks[next] < start.tick) next++
		// A marker covers the notes from its start up to its end, or its own tick when it has no length.
		const covered = next < noteTicks.length && (noteTicks[next] < end.tick || noteTicks[next] === start.tick)
		if (!covered) uncovered.add(start.eventIndex).add(end.eventIndex)
	}
	if (uncovered.size === 0) return unrecognizedEvents
	const unrecognized = new Set(unrecognizedEvents)
	return events.filter((event, index) => unrecognized.has(event) || uncovered.has(index))
}

/** These apply to the entire instrument, not specific difficulties. */
export function getInstrumentEventType(note: number) {
	switch (note) {
		case 103:
			return eventTypes.soloSection
		case 104:
			return eventTypes.forceTap
		case 109:
			return eventTypes.forceFlam
		case 110:
			return eventTypes.yellowTomMarker
		case 111:
			return eventTypes.blueTomMarker
		case 112:
			return eventTypes.greenTomMarker
		case 116:
			return eventTypes.starPower
		case 120:
			return eventTypes.freestyleSection
		// Note: The official spec says all five need to be active to count as a drum fill, but some charts don't do this.
		// Most other popular parsers only check midi note 120 for better compatibility.
		// case 121:
		// 	return eventTypes.freestyleSection2
		// case 122:
		// 	return eventTypes.freestyleSection3
		// case 123:
		// 	return eventTypes.freestyleSection4
		// case 124:
		// 	return eventTypes.freestyleSection5
		case 126:
			return eventTypes.flexLaneSingle
		case 127:
			return eventTypes.flexLaneDouble
		default:
			return null
	}
}

export function get6FretNoteType(note: number, difficulty: Difficulty) {
	switch (note - sixFretDiffStarts[difficulty]) {
		case 0:
			return eventTypes.open // Not forceOpen
		case 1:
			return eventTypes.white1
		case 2:
			return eventTypes.white2
		case 3:
			return eventTypes.white3
		case 4:
			return eventTypes.black1
		case 5:
			return eventTypes.black2
		case 6:
			return eventTypes.black3
		case 7:
			return eventTypes.forceHopo
		case 8:
			return eventTypes.forceStrum
		default:
			return null
	}
}

export function get5FretNoteType(note: number, difficulty: Difficulty, enhancedOpens: boolean) {
	switch (note - fiveFretDiffStarts[difficulty]) {
		case 0:
			return enhancedOpens ? eventTypes.open : null // Not forceOpen
		case 1:
			return eventTypes.green
		case 2:
			return eventTypes.red
		case 3:
			return eventTypes.yellow
		case 4:
			return eventTypes.blue
		case 5:
			return eventTypes.orange
		case 6:
			return eventTypes.forceHopo
		case 7:
			return eventTypes.forceStrum
		default:
			return null
	}
}

export function getDrumsNoteType(note: number, difficulty: Difficulty) {
	switch (note - drumsDiffStarts[difficulty]) {
		case -1:
			return eventTypes.kick2x
		case 0:
			return eventTypes.kick
		case 1:
			return eventTypes.redDrum
		case 2:
			return eventTypes.yellowDrum
		case 3:
			return eventTypes.blueDrum
		case 4:
			return eventTypes.fiveOrangeFourGreenDrum
		case 5:
			return eventTypes.fiveGreenDrum
		default:
			return null
	}
}

/**
 * Any Sysex modifiers with difficulty 0xFF are meant to apply to all charted difficulties.
 * Any instrument events above midi note 102 are meant to apply to all charted difficulties.
 * enableChartDynamics is meant to apply to all charted difficulties.
 * Distributes all of these to each difficulty in the instrument.
 */
function distributeInstrumentEvents(eventEnds: { [difficulty in Difficulty | 'all']: TrackEventEnd[] }, allocatesEmptyExpert: boolean) {
	for (const instrumentEvent of eventEnds.all) {
		for (const difficulty of difficulties) {
			if (eventEnds[difficulty].length === 0 && !(allocatesEmptyExpert && difficulty === 'expert')) {
				continue // Skip adding modifiers to uncharted difficulties
			}
			eventEnds[difficulty].push({
				tick: instrumentEvent.tick,
				type: instrumentEvent.type,
				velocity: instrumentEvent.velocity,
				channel: instrumentEvent.channel,
				isStart: instrumentEvent.isStart,
				eventIndex: instrumentEvent.eventIndex,
				...(instrumentEvent.sysExDifficulty === undefined ? {} : { sysExDifficulty: instrumentEvent.sysExDifficulty }),
			})
		}
	}

	return {
		expert: eventEnds.expert.sort(compareTickAscTypeDesc),
		hard: eventEnds.hard.sort(compareTickAscTypeDesc),
		medium: eventEnds.medium.sort(compareTickAscTypeDesc),
		easy: eventEnds.easy.sort(compareTickAscTypeDesc),
	}
}

export function compareTickAscTypeDesc(a: TrackEventEnd, b: TrackEventEnd): number {
	if (a.tick !== b.tick) return a.tick - b.tick
	if (a.type < b.type) return 1
	if (a.type > b.type) return -1
	return 0
}

/** A start event and the end event it was paired with. */
export interface PairedEventEnds {
	readonly start: TrackEventEnd
	readonly end: TrackEventEnd
}

/**
 * Pairs each start event with an end event of its type, the most recent unpaired start on the same channel (and, for a
 * SysEx event, of the same SysEx difficulty), in start order. A start with no end is left out.
 */
export function pairEventEnds(ends: readonly TrackEventEnd[]): PairedEventEnds[] {
	const pairs: { start: TrackEventEnd; end: TrackEventEnd | null }[] = []
	// Lazy lists of unpaired starts keyed by event type. Most types never appear, so only allocate one when seen.
	const unpairedByType: { [key: string]: { start: TrackEventEnd; end: TrackEventEnd | null }[] | undefined } = {}
	for (const end of ends) {
		let unpaired = unpairedByType[end.type]
		if (end.isStart) {
			const pair = { start: end, end: null }
			if (unpaired === undefined) {
				unpaired = []
				unpairedByType[end.type] = unpaired
			}
			unpaired.push(pair)
			pairs.push(pair)
		} else if (unpaired !== undefined && unpaired.length) {
			let index = unpaired.length - 1
			while (index >= 0 && (unpaired[index].start.channel !== end.channel || unpaired[index].start.sysExDifficulty !== end.sysExDifficulty)) {
				index-- // Find the most recent unpaired start on the same channel
			}
			if (index >= 0) {
				unpaired[index].end = end
				unpaired.splice(index, 1)
			}
		}
	}
	return pairs.filter((pair): pair is PairedEventEnds => pair.end !== null)
}

/**
 * Connects together start and end events to determine event lengths.
 */
function getTrackEvents(trackEventEnds: { [key in Difficulty]: TrackEventEnd[] }) {
	const trackEvents: { [key in Difficulty]: MidiTrackEvent[] } = { expert: [], hard: [], medium: [], easy: [] }
	for (const difficulty of difficulties) {
		trackEvents[difficulty] = pairEventEnds(trackEventEnds[difficulty]).map(({ start, end }) => ({
			tick: start.tick,
			length: end.tick - start.tick,
			type: start.type,
			velocity: start.velocity,
			channel: start.channel,
			chartDynamics: start.chartDynamics,
		}))
	}
	return trackEvents
}

/**
 * These event types are modifier sustains that apply to all notes active during them:
 * - forceOpen
 * - forceTap
 * - forceStrum
 * - forceHopo
 * - forceFlam
 * - yellowTomMarker
 * - blueTomMarker
 * - greenTomMarker
 *
 * Splits these modifiers into zero-length modifier events on each unique note tick under them,
 * to mimic how .chart stores modifier events.
 * (Note: The ending tick of the modifier phrase is excluded)
 *
 * There are more "modifiers" like this, but these are the ones that are midi-specific.
 * Code to handle the remaining modifiers is shared between the .mid and .chart parsers later.
 */
function splitMidiModifierSustains(
	events: { [key in Difficulty]: MidiTrackEvent[] },
	instrumentType: InstrumentType,
	rules: ParseRules,
) {
	let enableChartDynamics = false
	const t = eventTypes
	const modifierSustains: EventType[] =
		instrumentType === instrumentTypes.drums ?
			[t.forceFlam, t.yellowTomMarker, t.blueTomMarker, t.greenTomMarker]
		:	[t.forceOpen, t.forceTap, t.forceStrum, t.forceHopo]
	const modifiableNotes: EventType[] =
		instrumentType === instrumentTypes.fiveFret ? [t.open, t.green, t.red, t.yellow, t.blue, t.orange]
		: instrumentType === instrumentTypes.sixFret ? [t.open, t.black3, t.black2, t.black1, t.white3, t.white2, t.white1]
		: [t.kick, t.kick2x, t.redDrum, t.yellowDrum, t.blueDrum, t.fiveOrangeFourGreenDrum, t.fiveGreenDrum]

	const newEvents: { [key in Difficulty]: MidiTrackEvent[] } = { expert: [], hard: [], medium: [], easy: [] }

	for (const difficulty of difficulties) {
		let hasNotes = false
		const activeModifiers: MidiTrackEvent[] = []
		/**
		 * A map of the last zero-length modifiers to be added to `newEvents`.
		 * used to check that duplicates are not added at the same tick.
		 */
		const latestInsertedModifiers: Partial<{ [key in EventType]: MidiTrackEvent }> = {}

		for (const event of events[difficulty]) {
			if (event.type === eventTypes.enableChartDynamics) {
				enableChartDynamics = true
				continue
			}

			// In-place removal of ended modifiers. Zero-length modifiers die when
			// event.tick passes them; nonzero die when event.tick reaches their end.
			if (activeModifiers.length > 0) {
				const eventTick = event.tick
				let w = 0
				for (let r = 0; r < activeModifiers.length; r++) {
					const m = activeModifiers[r]
					const ended =
						m.length === 0 ? m.tick < eventTick
						: rules.midiTapEnd === 'inclusive' && m.type === eventTypes.forceTap ? m.tick + m.length < eventTick
						: m.tick + m.length <= eventTick
					if (!ended) activeModifiers[w++] = m
				}
				activeModifiers.length = w
			}

			if (modifierSustains.includes(event.type)) {
				activeModifiers.push(event)
				continue // Don't add modifier sustain to final result
			}

			if (modifiableNotes.includes(event.type)) {
				hasNotes = true
				// Add all currently active modifiers to event, if those modifiers haven't been added here already
				for (const activeModifier of activeModifiers) {
					const latestInsertedModifier = latestInsertedModifiers[activeModifier.type]
					if (!latestInsertedModifier || latestInsertedModifier.tick < event.tick) {
						const newInsertedModifier: MidiTrackEvent = {
							tick: event.tick,
							length: 0,
							type: activeModifier.type,
							velocity: activeModifier.velocity,
							channel: activeModifier.channel,
						}
						latestInsertedModifiers[activeModifier.type] = newInsertedModifier
						newEvents[difficulty].push(newInsertedModifier)
					}
				}

				const dynamics = rules.midiChartDynamics === 'fromEvent' ? event.chartDynamics === true : enableChartDynamics
				const isKick = event.type === eventTypes.kick || event.type === eventTypes.kick2x
				if (dynamics && instrumentType === instrumentTypes.drums && (event.velocity === 1 || event.velocity === 127)
					&& !(isKick && rules.midiKickDynamics === 'ignored')) {
					newEvents[difficulty].push({
						tick: event.tick,
						length: 0,
						velocity: 127,
						channel: event.channel,
						type: event.velocity === 1 ? getDrumGhostNoteType(event.type)! : getDrumAccentNoteType(event.type)!,
					})
				}
			}

			newEvents[difficulty].push(event)
		}

		// Ensure that modifiers and other events are not copied into uncharted difficulties
		if (!hasNotes) {
			newEvents[difficulty] = []
		}
	}

	return newEvents
}

function getDrumGhostNoteType(note: EventType) {
	switch (note) {
		case eventTypes.redDrum:
			return eventTypes.redGhost
		case eventTypes.yellowDrum:
			return eventTypes.yellowGhost
		case eventTypes.blueDrum:
			return eventTypes.blueGhost
		case eventTypes.fiveOrangeFourGreenDrum:
			return eventTypes.fiveOrangeFourGreenGhost
		case eventTypes.fiveGreenDrum:
			return eventTypes.fiveGreenGhost
		case eventTypes.kick:
			return eventTypes.kickGhost
		case eventTypes.kick2x:
			return eventTypes.kickGhost
	}
}

function getDrumAccentNoteType(note: EventType) {
	switch (note) {
		case eventTypes.redDrum:
			return eventTypes.redAccent
		case eventTypes.yellowDrum:
			return eventTypes.yellowAccent
		case eventTypes.blueDrum:
			return eventTypes.blueAccent
		case eventTypes.fiveOrangeFourGreenDrum:
			return eventTypes.fiveOrangeFourGreenAccent
		case eventTypes.fiveGreenDrum:
			return eventTypes.fiveGreenAccent
		case eventTypes.kick:
			return eventTypes.kickAccent
		case eventTypes.kick2x:
			return eventTypes.kickAccent
	}
}

function fixLegacyGhStarPower(
	events: { [key in Difficulty]: MidiTrackEvent[] },
	instrumentType: InstrumentType,
	iniChartModifiers: IniChartModifiers,
) {
	if ((instrumentType === instrumentTypes.fiveFret || instrumentType === instrumentTypes.sixFret) && iniChartModifiers.multiplier_note !== 116) {
		for (const difficulty of difficulties) {
			const starPowerSections: MidiTrackEvent[] = []
			const soloSections: MidiTrackEvent[] = []

			for (const event of events[difficulty]) {
				if (event.type === eventTypes.starPower) {
					starPowerSections.push(event)
				} else if (event.type === eventTypes.soloSection) {
					soloSections.push(event)
				}
			}

			if (iniChartModifiers.multiplier_note === 103 || (!starPowerSections.length && soloSections.length > 1)) {
				for (const soloSection of soloSections) {
					soloSection.type = eventTypes.starPower // GH1 and GH2 star power
				}
				for (const starPowerSection of starPowerSections) {
					starPowerSection.type = eventTypes.rejectedStarPower // These should not exist; later this is used to generate issues
				}
			}
		}
	}
	return events
}

function fixFlexLaneLds(events: { [key in Difficulty]: MidiTrackEvent[] }) {
	filterFlexLaneVelocity(events.easy, 30)
	filterFlexLaneVelocity(events.medium, 40)
	filterFlexLaneVelocity(events.hard, 50)
	return events
}

function filterFlexLaneVelocity(arr: MidiTrackEvent[], maxVelocity: number): void {
	let w = 0
	for (let r = 0; r < arr.length; r++) {
		const e = arr[r]
		const isFlex = e.type === eventTypes.flexLaneSingle || e.type === eventTypes.flexLaneDouble
		if (!(isFlex && (e.velocity < 21 || e.velocity > maxVelocity))) {
			arr[w++] = e
		}
	}
	arr.length = w
}


/**
 * YARG/MoonSong reads text-like events from multiple MIDI meta event types:
 * text (FF 01), lyrics (FF 05), marker (FF 06), cuePoint (FF 07).
 * trackName (FF 03) and instrumentName (FF 04) are excluded.
 */
interface EventsScanResult {
	sections: { tick: number; name: string }[]
	endEvents: { tick: number }[]
	codaEvents: { tick: number }[]
	/** Text-like events on the EVENTS track not recognized as
	 *  sections/endEvents/coda/lyrics/phrases. Becomes
	 *  `RawChartData.unrecognizedEventsTrackTextEvents`. */
	unrecognizedTextEvents: { tick: number; text: string }[]
	/** Non-text-like MIDI events on the EVENTS track (e.g. RB practice-assist
	 *  notes 24/25/26, or stray channel/sysex/meta events). Stored verbatim for
	 *  round-trip. Becomes `RawChartData.unrecognizedEventsTrackMidiEvents`. */
	unrecognizedMidiEvents: MidiEvent[]
	/** Issues raised while classifying EVENTS track text events (e.g. stray lyric/phrase
	 *  events that belong on PART VOCALS, not EVENTS). */
	parseIssues: RawChartData['parseIssues']
}

function scanEventsTrack(tracks: MidiSourceTrack[]): EventsScanResult {
	const result: EventsScanResult = {
		sections: [],
		endEvents: [],
		codaEvents: [],
		unrecognizedTextEvents: [],
		unrecognizedMidiEvents: [],
		parseIssues: [],
	}
	const eventsTrack = tracks.find(t => t.trackName === 'EVENTS')
	if (!eventsTrack) return result

	for (const event of eventsTrack.trackEvents) {
		if (!isTextLikeEvent(event)) {
			// Structural events (trackName / endOfTrack) are re-emitted by
			// writers independently; everything else (noteOn/Off, sysEx,
			// setTempo, channel events, etc.) is preserved verbatim so
			// round-trip writers can re-emit it. Notes 24/25/26 here are the
			// Rock Band practice-mode assist samples documented in the spec.
			if (event.type !== 'trackName' && event.type !== 'endOfTrack') {
				result.unrecognizedMidiEvents.push(event)
			}
			continue
		}
		const text = event.text
		const tick = event.deltaTime

		// Accept either `[section NAME]` (bracketed form — outer brackets are
		// stripped) or `section NAME` (plain form — everything after the prefix
		// is the name). Brackets must match as a pair: a trailing `]` is not
		// stripped unless the text also started with `[`. This preserves section
		// names that legitimately end in `]` (e.g. `section <b>…</b> [credits]`).
		const bracketedSection = eventsBracketedSectionRegex.exec(text)
		const plainSection = !bracketedSection && eventsPlainSectionRegex.exec(text)
		if (bracketedSection || plainSection) {
			const name = (bracketedSection ?? plainSection as RegExpExecArray)[1]
			result.sections.push({ tick, name })
			continue
		}
		if (eventsEndRegex.test(text)) {
			result.endEvents.push({ tick })
			continue
		}
		if (eventsCodaRegex.test(text)) {
			result.codaEvents.push({ tick })
			continue
		}
		// Lyrics and phrase markers belong on PART VOCALS in .mid charts, not on
		// the EVENTS track. Game engines silently drop them when they show up
		// here. Record a parse issue so consumers can surface the misplacement,
		// then fall through to the text-events bucket so the value round-trips
		// back out — users can move it to PART VOCALS manually.
		if (eventsLyricRegex.test(text)) {
			result.parseIssues.push({ instrument: null, difficulty: null, noteIssue: 'invalidLyric' })
		} else if (eventsPhraseStartRegex.test(text)) {
			result.parseIssues.push({ instrument: null, difficulty: null, noteIssue: 'invalidPhraseStart' })
		} else if (eventsPhraseEndRegex.test(text)) {
			result.parseIssues.push({ instrument: null, difficulty: null, noteIssue: 'invalidPhraseEnd' })
		}

		result.unrecognizedTextEvents.push({ tick, text })
	}
	return result
}

