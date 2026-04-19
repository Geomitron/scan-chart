import { MidiData, MidiEvent, MidiSetTempoEvent, MidiTextEvent, MidiTimeSignatureEvent, parseMidi } from 'midi-file'

import { difficulties, Difficulty, getInstrumentType, Instrument, InstrumentType, instrumentTypes } from 'src/interfaces'
import { EventType, eventTypes, IniChartModifiers, RawChartData, VocalTrackData } from './note-parsing-interfaces'
import { scanVocalTrack } from './lyric-parser'

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
	'PART KEYS',
	'PART GUITAR GHL',
	'PART GUITAR COOP GHL',
	'PART RHYTHM GHL',
	'PART BASS GHL',
	'PART VOCALS',
	'HARM1',
	'HARM2',
	'HARM3',
	'PART HARM1',
	'PART HARM2',
	'PART HARM3',
	'EVENTS',
] as const

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
	'PART KEYS': 'keys',
	'PART GUITAR GHL': 'guitarghl',
	'PART GUITAR COOP GHL': 'guitarcoopghl',
	'PART RHYTHM GHL': 'rhythmghl',
	'PART BASS GHL': 'bassghl',
} as const
/* eslint-enable @typescript-eslint/naming-convention */


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

interface TrackEventEnd {
	tick: number
	type: EventType
	// Necessary because .mid stores some additional modifiers and information using velocity
	velocity: number
	channel: number
	// Necessary because .mid stores track events as separate start and end events
	isStart: boolean
}

// Necessary because .mid stores some additional modifiers and information using velocity
type MidiTrackEvent = RawChartData['trackData'][number]['trackEvents'][number] & {
	velocity: number
	channel: number
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
export function parseNotesFromMidi(data: Uint8Array, iniChartModifiers: IniChartModifiers): RawChartData {
	const midiFile = parseMidi(data)
	if (midiFile.header.format !== 1) {
		throw `Invavlid .mid file: unsupported header format "${midiFile.header.format}"`
	}

	if (!midiFile.header.ticksPerBeat) {
		throw 'Invalid .mid file: resolution in ticks per SMPTE frame is not supported'
	}

	if (midiFile.tracks.length === 0) {
		throw 'Invalid .mid file: no tracks detected'
	}

	// Sets event.deltaTime to the number of ticks since the start of the track
	convertToAbsoluteTime(midiFile)

	const { tracks, unrecognizedMidiTracks } = getTracks(midiFile)
	const parseIssues: RawChartData['parseIssues'] = []

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
	// sections, endEvents, codaEvents, or unrecognizedEvents (the remainder).
	const eventsScan = scanEventsTrack(tracks)
	const firstCodaTick = eventsScan.codaEvents[0]?.tick ?? null

	return {
		chartTicksPerBeat: midiFile.header.ticksPerBeat,
		metadata: {}, // .mid does not have a mechanism for storing song metadata
		vocalTracks,
		tempos: extractTempos(midiFile.tracks[0]),
		timeSignatures: extractTimeSignatures(midiFile.tracks[0]),
		sections: eventsScan.sections,
		endEvents: eventsScan.endEvents,
		unrecognizedEvents: eventsScan.unrecognizedEvents,
		unrecognizedMidiTracks,
		unrecognizedChartSections: [],
		trackData: buildMidiTrackData(tracks, iniChartModifiers, firstCodaTick),
		parseIssues: [...parseIssues, ...eventsScan.parseIssues],
	}
}

function buildMidiTrackData(
	tracks: { trackName: TrackName; trackEvents: MidiEvent[] }[],
	iniChartModifiers: IniChartModifiers,
	firstCodaTick: number | null,
): RawChartData['trackData'] {
	const out: RawChartData['trackData'] = []

	for (const t of tracks) {
		const instrument = instrumentNameMap[t.trackName as InstrumentTrackName]
		if (instrument === undefined) continue // vocal/EVENTS tracks handled elsewhere
		const instrumentType = getInstrumentType(instrument)
		const { eventEnds, textEvents, versusPhrases, animations, unrecognizedEvents: trackUnrecognized } =
			scanInstrumentTrack(t.trackEvents, instrumentType, t.trackName)
		const distributed = distributeInstrumentEvents(eventEnds)
		const pairedEvents = getTrackEvents(distributed)
		const step1 = splitMidiModifierSustains(pairedEvents, instrumentType)
		const step2 = fixLegacyGhStarPower(step1, instrumentType, iniChartModifiers)
		const trackDifficulties = fixFlexLaneLds(step2)

		for (const difficulty of difficulties) {
			const diffEvents = trackDifficulties[difficulty]
			if (diffEvents.length === 0) continue // uncharted difficulty — no need to allocate/emit

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
			if (hasRealTrackEvents || result.starPowerSections.length > 0 || result.soloSections.length > 0) {
				out.push(result)
			}
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
	for (const tempo of tempos) {
		if (tempo.beatsPerMinute === 0) {
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

function convertToAbsoluteTime(midiData: MidiData) {
	for (const track of midiData.tracks) {
		let currentTick = 0
		for (const event of track) {
			currentTick += event.deltaTime
			event.deltaTime = currentTick
		}
	}
}

function getTracks(midiData: MidiData) {
	const tracks: { trackName: TrackName; trackEvents: MidiEvent[] }[] = []
	const unrecognizedMidiTracks: { trackName: string; events: MidiEvent[] }[] = []

	for (const [i, track] of midiData.tracks.entries()) {
		// We intentionally do NOT match YARG.Core's GetTrackName here, which
		// returns the FIRST tick-0 trackName even if it isn't a recognized
		// instrument. Some real charts (e.g. "Culture Killer - Blindfolded
		// Death", "Periphery - Ji", "school food punishment - close, down,
		// back to") emit a bogus leading trackName at tick 0 immediately
		// followed by the real instrument trackName, also at tick 0:
		//
		//   [ENHANCED_OPENS] → PART BASS    (Culture Killer)
		//   TEMPO TRACK      → PART DRUMS   (Periphery - Ji)
		//   <song title>     → PART DRUMS   (school food punishment)
		//
		// YARG drops these tracks; we keep them. Walk every tick-0 trackName
		// and accept the first one that matches a recognized instrument.
		// Capture the first tick-0 trackName for unrecognized-track
		// round-trip purposes regardless of whether anything matched.
		let firstTickZeroTrackName: string | null = null
		let recognizedTrackName: TrackName | null = null
		for (const event of track) {
			if (event.deltaTime !== 0) {
				break
			}
			if (event.type === 'trackName') {
				if (firstTickZeroTrackName === null) {
					firstTickZeroTrackName = event.text
				}
				if (recognizedTrackName === null && trackNames.includes(event.text as TrackName)) {
					recognizedTrackName = event.text as TrackName
				}
			}
		}

		if (recognizedTrackName !== null) {
			tracks.push({
				trackName: recognizedTrackName,
				trackEvents: track,
			})
		} else if (i !== 0) {
			// Track 0 is the conductor track (tempo/timeSignature) and isn't a
			// musical track — skip it from unrecognized capture.
			unrecognizedMidiTracks.push({
				trackName: firstTickZeroTrackName ?? '',
				events: track,
			})
		}
	}

	return { tracks, unrecognizedMidiTracks }
}

interface TrackScanResult {
	eventEnds: { [difficulty in Difficulty | 'all']: TrackEventEnd[] }
	textEvents: { tick: number; text: string }[]
	versusPhrases: { tick: number; length: number; isPlayer2: boolean }[]
	animations: { tick: number; length: number; noteNumber: number }[]
	/** MIDI events the typed parser didn't consume (verbatim). */
	unrecognizedEvents: MidiEvent[]
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

	for (const event of events) {
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
					: eeExpert
				arr.push({
					tick: event.deltaTime,
					type,
					channel: 1,
					velocity: 127,
					isStart: event.data[6] === 0x01,
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
					const eventType =
						flag === '' ? eventTypes.discoFlipOff
						: flag === 'd' ? eventTypes.discoFlipOn
						: flag === 'dnoflip' ? eventTypes.discoNoFlipOn
						: null
					if (eventType) {
						// Treat this like the other events that have a start and end, so it can be processed the same way later
						eventEnds[difficulty].push({ tick: event.deltaTime, type: eventType, velocity: 127, channel: 1, isStart: true })
						eventEnds[difficulty].push({ tick: event.deltaTime, type: eventType, velocity: 127, channel: 1, isStart: false })
						consumedAsNote = true
					}
				}
			}

			if (event.text === 'ENHANCED_OPENS' || event.text === '[ENHANCED_OPENS]') {
				enhancedOpens = true
				consumedAsNote = true
			} else if (event.text === 'ENABLE_CHART_DYNAMICS' || event.text === '[ENABLE_CHART_DYNAMICS]') {
				// Treat this like the other events that have a start and end, so it can be processed the same way later
				eventEnds['all'].push({ tick: event.deltaTime, type: eventTypes.enableChartDynamics, channel: 1, isStart: true, velocity: 127 })
				eventEnds['all'].push({ tick: event.deltaTime, type: eventTypes.enableChartDynamics, channel: 1, isStart: false, velocity: 127 })
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
	return { eventEnds, textEvents, versusPhrases, animations, unrecognizedEvents }
}

/** These apply to the entire instrument, not specific difficulties. */
function getInstrumentEventType(note: number) {
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

function get6FretNoteType(note: number, difficulty: Difficulty) {
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

function get5FretNoteType(note: number, difficulty: Difficulty, enhancedOpens: boolean) {
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

function getDrumsNoteType(note: number, difficulty: Difficulty) {
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
function distributeInstrumentEvents(eventEnds: { [difficulty in Difficulty | 'all']: TrackEventEnd[] }) {
	for (const instrumentEvent of eventEnds.all) {
		for (const difficulty of difficulties) {
			if (eventEnds[difficulty].length === 0) {
				continue // Skip adding modifiers to uncharted difficulties
			}
			eventEnds[difficulty].push({
				tick: instrumentEvent.tick,
				type: instrumentEvent.type,
				velocity: instrumentEvent.velocity,
				channel: instrumentEvent.channel,
				isStart: instrumentEvent.isStart,
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

function compareTickAscTypeDesc(a: TrackEventEnd, b: TrackEventEnd): number {
	if (a.tick !== b.tick) return a.tick - b.tick
	if (a.type < b.type) return 1
	if (a.type > b.type) return -1
	return 0
}

/**
 * Connects together start and end events to determine event lengths.
 */
function getTrackEvents(trackEventEnds: { [key in Difficulty]: TrackEventEnd[] }) {
	const trackEvents: { [key in Difficulty]: MidiTrackEvent[] } = { expert: [], hard: [], medium: [], easy: [] }

	for (const difficulty of difficulties) {
		// Lazy partial-event lists keyed by event type. Most types never appear on a
		// given difficulty, so only allocate a list when we see one.
		const partialTrackEventsMap: { [key: string]: MidiTrackEvent[] | undefined } = {}
		const out = trackEvents[difficulty]

		for (const trackEventEnd of trackEventEnds[difficulty]) {
			let partialTrackEvents = partialTrackEventsMap[trackEventEnd.type]
			if (trackEventEnd.isStart) {
				const partialTrackEvent: MidiTrackEvent = {
					tick: trackEventEnd.tick,
					length: -1, // Represents that this is a partial track event (an end event has not been found for this yet)
					type: trackEventEnd.type,
					velocity: trackEventEnd.velocity,
					channel: trackEventEnd.channel,
				}
				if (partialTrackEvents === undefined) {
					partialTrackEvents = []
					partialTrackEventsMap[trackEventEnd.type] = partialTrackEvents
				}
				partialTrackEvents.push(partialTrackEvent)
				out.push(partialTrackEvent)
			} else if (partialTrackEvents !== undefined && partialTrackEvents.length) {
				let partialTrackEventIndex = partialTrackEvents.length - 1
				while (partialTrackEventIndex >= 0 && partialTrackEvents[partialTrackEventIndex].channel !== trackEventEnd.channel) {
					partialTrackEventIndex-- // Find the most recent partial event on the same channel
				}
				if (partialTrackEventIndex >= 0) {
					const partialTrackEvent = partialTrackEvents[partialTrackEventIndex]
					partialTrackEvents.splice(partialTrackEventIndex, 1)
					partialTrackEvent.length = trackEventEnd.tick - partialTrackEvent.tick
				}
			}
		}

		// In-place filter: remove any remaining partial events whose length was never set.
		let write = 0
		for (let read = 0; read < out.length; read++) {
			if (out[read].length !== -1) {
				out[write++] = out[read]
			}
		}
		out.length = write
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
function splitMidiModifierSustains(events: { [key in Difficulty]: MidiTrackEvent[] }, instrumentType: InstrumentType) {
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
					const ended = m.length === 0 ? m.tick < eventTick : m.tick + m.length <= eventTick
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

				if (enableChartDynamics && instrumentType === instrumentTypes.drums && (event.velocity === 1 || event.velocity === 127)) {
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
function isTextLikeEvent(event: MidiEvent): event is MidiTextEvent {
	return event.type === 'text' || event.type === 'lyrics' || event.type === 'marker' || event.type === 'cuePoint'
}

interface EventsScanResult {
	sections: { tick: number; name: string }[]
	endEvents: { tick: number }[]
	codaEvents: { tick: number }[]
	/** All remaining text-like events not recognized as sections/endEvents/coda/lyrics/phrases.
	 *  Lyrics and phrase_start/phrase_end are extracted separately by the vocals path. */
	unrecognizedEvents: { tick: number; text: string }[]
	/** Issues raised while classifying EVENTS track text events (e.g. stray lyric/phrase
	 *  events that belong on PART VOCALS, not EVENTS). */
	parseIssues: RawChartData['parseIssues']
}

function scanEventsTrack(tracks: { trackName: TrackName; trackEvents: MidiEvent[] }[]): EventsScanResult {
	const result: EventsScanResult = {
		sections: [],
		endEvents: [],
		codaEvents: [],
		unrecognizedEvents: [],
		parseIssues: [],
	}
	const eventsTrack = tracks.find(t => t.trackName === 'EVENTS')
	if (!eventsTrack) return result

	for (const event of eventsTrack.trackEvents) {
		if (!isTextLikeEvent(event)) continue
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
		// then fall through to unrecognizedEvents so the value round-trips back
		// out — users can move it to PART VOCALS manually.
		if (eventsLyricRegex.test(text)) {
			result.parseIssues.push({ instrument: null, difficulty: null, noteIssue: 'invalidLyric' })
		} else if (eventsPhraseStartRegex.test(text)) {
			result.parseIssues.push({ instrument: null, difficulty: null, noteIssue: 'invalidPhraseStart' })
		} else if (eventsPhraseEndRegex.test(text)) {
			result.parseIssues.push({ instrument: null, difficulty: null, noteIssue: 'invalidPhraseEnd' })
		}

		result.unrecognizedEvents.push({ tick, text })
	}
	return result
}

