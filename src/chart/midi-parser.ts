import * as _ from 'lodash'
import { MidiData, MidiEvent, MidiSetTempoEvent, MidiTextEvent, MidiTimeSignatureEvent, parseMidi } from 'midi-file'

import { difficulties, Difficulty, getInstrumentType, Instrument, InstrumentType, instrumentTypes } from 'src/interfaces'
import { EventType, eventTypes, IniChartModifiers, RawChartData, VenueEvent, VocalTrackData } from './note-parsing-interfaces'
import { extractMidiLyrics, extractMidi105Phrases, extractMidi106Phrases, extractMidiVocalNotes, extractMidiVocalStarPower, extractMidiRangeShifts, extractMidiLyricShifts, extractMidiVocalTextEvents } from './lyric-parser'

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
type InstrumentTrackName = Exclude<TrackName, VocalTrackName | 'EVENTS' | 'VENUE' | 'BEAT'>
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
	'PART KEYS GHL',
	'PART REAL_GUITAR',
	'PART REAL_GUITAR_22',
	'PART REAL_BASS',
	'PART REAL_BASS_22',
	'PART REAL_KEYS_X',
	'PART REAL_KEYS_H',
	'PART REAL_KEYS_M',
	'PART REAL_KEYS_E',
	'PART ELITE_DRUMS',
	'PART REAL_DRUMS_PS',
	'VENUE',
	'BEAT',
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
	'PART KEYS GHL': 'keysghl',
	'PART REAL_GUITAR': 'proguitar',
	'PART REAL_GUITAR_22': 'proguitar22',
	'PART REAL_BASS': 'probass',
	'PART REAL_BASS_22': 'probass22',
	'PART REAL_KEYS_X': 'prokeys',
	'PART REAL_KEYS_H': 'prokeys',
	'PART REAL_KEYS_M': 'prokeys',
	'PART REAL_KEYS_E': 'prokeys',
	'PART ELITE_DRUMS': 'elitedrums',
	'PART REAL_DRUMS_PS': 'drums',
} as const
/* eslint-enable @typescript-eslint/naming-convention */

/** Pro Keys uses one MIDI track per difficulty instead of one track for all difficulties. */
const proKeysDifficultyMap: { [key: string]: Difficulty } = {
	'PART REAL_KEYS_X': 'expert',
	'PART REAL_KEYS_H': 'hard',
	'PART REAL_KEYS_M': 'medium',
	'PART REAL_KEYS_E': 'easy',
}


const sysExDifficultyMap = ['easy', 'medium', 'hard', 'expert'] as const
const discoFlipDifficultyMap = ['easy', 'medium', 'hard', 'expert'] as const
const fiveFretDiffStarts = { easy: 59, medium: 71, hard: 83, expert: 95 }
const sixFretDiffStarts = { easy: 58, medium: 70, hard: 82, expert: 94 }
const drumsDiffStarts = { easy: 60, medium: 72, hard: 84, expert: 96 }

interface TrackEventEnd {
	tick: number
	type: EventType
	// Necessary because .mid stores some additional modifiers and information using velocity
	velocity: number
	channel: number
	// Necessary because .mid stores track events as separate start and end events
	isStart: boolean
	/**
	 * Internal marker for Phase Shift SysEx-sourced forceTap events. YARG.Core
	 * treats SysEx-based taps as INCLUSIVE-end sustains (Phase Shift / Clone Hero
	 * behavior) while note-104-based taps are EXCLUSIVE-end (like all other
	 * note-based modifiers). scan-chart can't otherwise distinguish the two.
	 */
	_fromSysEx?: boolean
	/**
	 * Insertion index in the original MIDI file, used for stable tiebreaking
	 * when multiple events land on the same tick. YARG.Core processes modifier
	 * closures in file order, so the relative position of noteOff events at
	 * the same tick determines which force modifier wins a conflict.
	 */
	_seq?: number
}

// Necessary because .mid stores some additional modifiers and information using velocity
type MidiTrackEvent = RawChartData['trackData'][number]['trackEvents'][number] & {
	velocity: number
	channel: number
	_fromSysEx?: boolean
	/**
	 * Sequence number (MIDI file order) of the END event that closed this sustain.
	 * Used by resolveFretModifiers to match YARG's "last closure wins" behavior:
	 * when multiple force modifiers cover a note, pick the one with the largest
	 * `_endSeq`, matching YARG's MidReader forcingProcessList iteration order.
	 */
	_endSeq?: number
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

	const allTracks = getTracks(midiFile)
	const parseIssues: RawChartData['parseIssues'] = []

	// YARG/Moonscraper behavior: PART DRUMS is canonical; PART REAL_DRUMS_PS is a
	// fallback used only when PART DRUMS is absent. When both exist, drop the
	// fallback entirely (matches YARG's TrackOverrides dictionary, where
	// DRUMS_REAL_TRACK has overwrite=false so it's discarded once drums is loaded).
	const hasCanonicalDrums = allTracks.some(t => t.trackName === 'PART DRUMS')
	const hasFallbackDrums = allTracks.some(t => t.trackName === 'PART REAL_DRUMS_PS')
	const tracks = hasCanonicalDrums && hasFallbackDrums
		? allTracks.filter(t => t.trackName !== 'PART REAL_DRUMS_PS')
		: allTracks
	if (hasCanonicalDrums && hasFallbackDrums) {
		parseIssues.push({ instrument: 'drums', difficulty: null, noteIssue: 'duplicateDrumsTrack' })
	}

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
			const events = track.trackEvents
			// YARG treats BOTH note 105 (LYRICS_PHRASE_1) and note 106
			// (LYRICS_PHRASE_2) as creating a `Vocals_StaticLyricPhrase` in HARM2/
			// HARM3's specialPhrases (plus `Vocals_ScoringPhrase` which CopyDown
			// later replaces from HARM1). Match that by unioning both sets for
			// harmony parts. For solo vocals and HARM1, the static-lyric view is
			// simply a duplicate of the note-phrase (scoring) list per YARG's
			// MoonSongLoader.Vocals.cs.
			const phrases105 = extractMidi105Phrases(events)
			const phrases106 = extractMidi106Phrases(events)
			const isHarmonyBacking = partName === 'harmony2' || partName === 'harmony3'
			vocalTracks[partName] = {
				lyrics: extractMidiLyrics(events),
				vocalPhrases: phrases105,
				notes: extractMidiVocalNotes(events),
				starPowerSections: extractMidiVocalStarPower(events),
				rangeShifts: extractMidiRangeShifts(events),
				lyricShifts: extractMidiLyricShifts(events),
				staticLyricPhrases: isHarmonyBacking
					? mergePhraseLists(phrases105, phrases106)
					: phrases106,
				// Raw text events on the vocal track (stance, facial anim, etc.)
				// that YARG preserves as MoonText events. Required for round-trip
				// of vocal tracks that only have stance markers (no notes/lyrics).
				textEvents: extractMidiVocalTextEvents(events),
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
		tempos: _.chain(midiFile.tracks[0])
			.filter((e): e is MidiSetTempoEvent => e.type === 'setTempo')
			.map(e => ({
				tick: e.deltaTime,
				// Note that this operation is float64 division, and is impacted by floating point precision errors
				beatsPerMinute: 60000000 / e.microsecondsPerBeat,
			}))
			.tap(tempos => {
				const zeroTempo = tempos.find(tempo => tempo.beatsPerMinute === 0)
				if (zeroTempo) {
					throw `Invalid .mid file: Tempo at tick ${zeroTempo.tick} was zero.`
				}
				if (!tempos[0] || tempos[0].tick !== 0) {
					tempos.unshift({ tick: 0, beatsPerMinute: 120 })
				}
			})
			.value(),
		timeSignatures: _.chain(midiFile.tracks[0])
			.filter((e): e is MidiTimeSignatureEvent => e.type === 'timeSignature')
			.map(e => ({
				tick: e.deltaTime,
				numerator: e.numerator,
				denominator: e.denominator,
			}))
			.tap(timeSignatures => {
				const zeroTimeSignatureN = timeSignatures.find(timeSignature => timeSignature.numerator === 0)
				const zeroTimeSignatureD = timeSignatures.find(timeSignature => timeSignature.denominator === 0)
				if (zeroTimeSignatureN) {
					throw `Invalid .mid file: Time signature numerator at tick ${zeroTimeSignatureN.tick} was zero.`
				}
				if (zeroTimeSignatureD) {
					throw `Invalid .mid file: Time signature denominator at tick ${zeroTimeSignatureD.tick} was zero.`
				}
				if (!timeSignatures[0] || timeSignatures[0].tick !== 0) {
					timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 })
				}
			})
			.value(),
		sections: eventsScan.sections,
		endEvents: eventsScan.endEvents,
		unrecognizedEvents: eventsScan.unrecognizedEvents,
		venue: extractVenueEvents(tracks),
		beatTrack: extractBeatTrack(tracks),
		// trackData is evaluated before parseIssues (below) because the per-track
		// pairing pushes orphan-note issues into `parseIssues` during evaluation.
		trackData: _.chain(tracks)
			.filter(t => _.keys(instrumentNameMap).includes(t.trackName))
			.map(t => {
				const instrument = instrumentNameMap[t.trackName as InstrumentTrackName]
				const instrumentType = getInstrumentType(instrument)
				// Single scan pass extracts note-shaped events AND the
				// data-carrying ones (text, versus, animations, pro-instrument rawNotes,
				// Pro Keys range shifts).
				const { eventEnds, textEvents, versusPhrases, animations, rawNotesByDifficulty, proKeysRangeShifts } =
					scanInstrumentTrack(t.trackEvents, instrumentType, t.trackName)
				// Pro instruments (pro guitar/bass, pro keys, elite drums) don't use
				// the difficulty-range noteOn dispatch, so their 'all'-difficulty
				// modifiers need to be copied to every difficulty unconditionally.
				const forceDistribute = storesRawNotes(instrumentType)
				const distributed = distributeInstrumentEvents(eventEnds, forceDistribute) // Removes 'all' difficulty
				const { trackEvents: pairedEvents, orphans } = getTrackEvents(distributed) // Connects note ends together
				if (orphans.starts > 0) {
					parseIssues.push({ instrument, difficulty: null, noteIssue: 'orphanedNoteStart' })
				}
				if (orphans.ends > 0) {
					parseIssues.push({ instrument, difficulty: null, noteIssue: 'orphanedNoteEnd' })
				}
				const trackDifficulties = _.chain(pairedEvents)
					.thru(events => splitMidiModifierSustains(events, instrumentType))
					.thru(events => fixLegacyGhStarPower(events, instrumentType, iniChartModifiers))
					.thru(events => fixFlexLaneLds(events))
					.value()

				// Typed HandMap / StrumMap / CharacterState text events (same across difficulties).
				const { handMaps, strumMaps, characterStates } = extractTypedTextEvents(t.trackEvents)

				// Pro Keys uses one MIDI track per difficulty; other instruments
				// have all 4 difficulties on one track.
				const fixedDifficulty = proKeysDifficultyMap[t.trackName as string]
				const diffsToProcess = fixedDifficulty ? [fixedDifficulty] as Difficulty[] : difficulties

				return diffsToProcess.map(difficulty => {
					const result: RawChartData['trackData'][number] = {
						instrument,
						difficulty,
						starPowerSections: [],
						rejectedStarPowerSections: [],
						soloSections: [],
						glissandoSections: [],
						flexLanes: [],
						drumFreestyleSections: [],
						trackEvents: [],
						textEvents,
						handMaps,
						strumMaps,
						characterStates,
						versusPhrases,
						animations,
						proKeysRangeShifts,
						rawNotes: rawNotesByDifficulty[difficulty],
					}
					// Attach source track name (for cases like PART DRUMS + PART REAL_DRUMS_PS
					// both mapping to 'drums', or duplicate MIDI tracks with the same name)
					Object.defineProperty(result, '_sourceTrackName', {
						value: t.trackName,
						enumerable: false,
						writable: true,
						configurable: true,
					})

					for (const event of trackDifficulties[difficulty]) {
						if (event.type === eventTypes.starPower) {
							result.starPowerSections.push(event)
						} else if (event.type === eventTypes.rejectedStarPower) {
							result.rejectedStarPowerSections.push(event)
						} else if (event.type === eventTypes.soloSection) {
							result.soloSections.push(event)
						} else if (event.type === eventTypes.glissando) {
							result.glissandoSections.push({ tick: event.tick, length: event.length })
						} else if (event.type === eventTypes.flexLaneSingle || event.type === eventTypes.flexLaneDouble) {
							result.flexLanes.push({
								tick: event.tick,
								length: event.length,
								isDouble: event.type === eventTypes.flexLaneDouble,
							})
						} else if (event.type === eventTypes.freestyleSection) {
							result.drumFreestyleSections.push({
								tick: event.tick,
								length: event.length,
								isCoda: firstCodaTick === null ? false : event.tick >= firstCodaTick,
							})
						} else {
							result.trackEvents.push(event)
						}
					}

					return result
				})
			})
			.flatMap()
			.filter(track => {
				// A track must have "real" content — actual notes or scorable sections.
				// Tracks with only global modifier events (e.g. [ENABLE_CHART_DYNAMICS])
				// and no actual notes should be filtered out so that round-trip behavior
				// is stable (the writer doesn't need to emit placeholder text events).
				const hasRealTrackEvents = track.trackEvents.some(e =>
					e.type !== eventTypes.enableChartDynamics,
				)
				return hasRealTrackEvents
					|| track.rawNotes.length > 0
					|| track.starPowerSections.length > 0
					|| track.soloSections.length > 0
			})
			.thru(tracks => copyDownProKeysPhrases(tracks))
			.value(),
		// Evaluated AFTER trackData so orphan-note issues pushed during per-track
		// pairing are included.
		parseIssues: [...parseIssues, ...eventsScan.parseIssues],
	}
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

/**
 * Parse a MIDI text event as a section event, matching YARG's
 * TextEvents.NormalizeTextEvent → TryParseSectionEvent pipeline exactly.
 * Returns the section name, or null if the event isn't a section event.
 */
function parseMidiSectionEventText(rawText: string): string | null {
	// NormalizeTextEvent: if there's both `[` and `]`, take content between
	// the FIRST `[` and FIRST `]` (not a balanced pair!). Otherwise trim.
	let text = rawText
	const openIdx = text.indexOf('[')
	const closeIdx = text.indexOf(']')
	if (openIdx >= 0 && closeIdx >= 0 && openIdx <= closeIdx) {
		text = text.slice(openIdx + 1, closeIdx)
	}
	text = text.trim()

	// TryParseSectionEvent: strip "section" or "prc" prefix
	let name: string
	if (text.startsWith('section')) {
		name = text.slice('section'.length)
	} else if (text.startsWith('prc')) {
		name = text.slice('prc'.length)
	} else {
		return null
	}

	// TrimStart('_').Trim()
	while (name.length > 0 && name[0] === '_') name = name.slice(1)
	name = name.trim()

	if (name.length === 0) return null
	return name
}

function getTracks(midiData: MidiData) {
	const tracks: { trackName: TrackName; trackEvents: MidiEvent[] }[] = []

	for (const track of midiData.tracks) {
		// Match YARG.Core's MidiExtensions.GetTrackName: return the FIRST
		// `SequenceTrackName` event (FF 03) seen at tick 0, even if it
		// doesn't match any recognized instrument track. The early `break`
		// below ensures we don't continue scanning for a "better" name.
		// Some charts (e.g. "Culture Killer - Blindfolded Death") have a
		// bogus leading trackname like `[ENHANCED_OPENS]` followed by the
		// real `PART BASS` — YARG honors the first and skips the track.
		let trackName: string | null = null
		for (const event of track) {
			if (event.deltaTime !== 0) {
				break
			}
			if (event.type === 'trackName') {
				trackName = event.text
				break
			}
		}

		if (trackName !== null && trackNames.includes(trackName as TrackName)) {
			tracks.push({
				trackName: trackName as TrackName,
				trackEvents: track,
			})
		}
	}

	return tracks
}

interface TrackScanResult {
	eventEnds: { [difficulty in Difficulty | 'all']: TrackEventEnd[] }
	textEvents: { tick: number; text: string }[]
	versusPhrases: { tick: number; length: number; isPlayer2: boolean }[]
	animations: { tick: number; length: number; noteNumber: number }[]
	/** Per-difficulty raw MIDI notes, populated for instrument types that store
	 *  raw notes (pro guitar/bass, pro keys, elite drums). Empty otherwise. */
	rawNotesByDifficulty: { [key in Difficulty]: RawNote[] }
	/** Pro Keys range shift markers (notes 0, 2, 4, 5, 7, 9). Empty for other instruments. */
	proKeysRangeShifts: { tick: number; length: number; noteNumber: number }[]
}

/**
 * Scans a MIDI instrument track and produces:
 *   - note-shaped events grouped by difficulty (further processed by
 *     `distributeInstrumentEvents` / `getTrackEvents`)
 *   - data-carrying events that ride alongside the notes: `textEvents`,
 *     `versusPhrases` (notes 105/106), `animations` (notes 24-51 drums,
 *     40-59 fret), and for pro instruments: `rawNotesByDifficulty` and
 *     `proKeysRangeShifts`
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
	const eventEnds: { [difficulty in Difficulty | 'all']: TrackEventEnd[] } = {
		all: [],
		expert: [],
		hard: [],
		medium: [],
		easy: [],
	}
	const textEvents: { tick: number; text: string }[] = []
	// Versus phrase + animation collectors need note-on/note-off pairing.
	const versusStarts = new Map<number, number>() // noteNumber → startTick
	const versusPhrases: { tick: number; length: number; isPlayer2: boolean }[] = []
	const animStarts = new Map<number, number>() // noteNumber → startTick
	const animations: { tick: number; length: number; noteNumber: number }[] = []
	const animationFilter = instrumentType === instrumentTypes.drums
		? (n: number) => n >= 24 && n <= 51
		: (n: number) => n >= 40 && n <= 59
	// Raw notes + pro keys range shifts (pro guitar/bass, pro keys, elite drums).
	const collectRawNotes = storesRawNotes(instrumentType)
	const fixedRawNoteDifficulty = proKeysDifficultyMap[trackName]
	const rawStarts = new Map<string, { tick: number; noteNumber: number; velocity: number; channel: number }>() // keyed by noteNumber+channel
	const rawNotesByDifficulty: { [key in Difficulty]: RawNote[] } = { expert: [], hard: [], medium: [], easy: [] }
	const rangeShiftStarts = new Map<number, number>() // noteNumber → startTick
	const proKeysRangeShifts: { tick: number; length: number; noteNumber: number }[] = []
	const isProKeys = instrumentType === instrumentTypes.proKeys
	// Monotonically increasing counter used to tag each event with its MIDI
	// file position. We use this for stable tiebreaks in force-modifier
	// conflict resolution (matching YARG's forcingProcessList order).
	let seq = 0

	for (const event of events) {
		// SysEx event (tap modifier or open)
		if ((event.type === 'sysEx' || event.type === 'endSysEx') && event.data.length > 6) {
			if (event.data[0] === 0x50 && event.data[1] === 0x53 && event.data[2] === 0x00 && event.data[3] === 0x00) {
				// Phase Shift SysEx event
				const type =
					event.data[5] === 0x01 ? eventTypes.forceOpen
					: event.data[5] === 0x04 ? eventTypes.forceTap
					: null

				if (type !== null) {
					eventEnds[event.data[4] === 0xff ? 'all' : discoFlipDifficultyMap[event.data[4]]].push({
						tick: event.deltaTime,
						type,
						channel: 1,
						velocity: 127,
						isStart: event.data[6] === 0x01,
						// Mark SysEx-sourced taps so splitMidiModifierSustains can
						// treat them with inclusive-end (matching YARG's Phase Shift
						// SysEx handling, which skips the endTick decrement).
						_fromSysEx: type === eventTypes.forceTap,
						_seq: seq++,
					})
				}
			}
		} else if (event.type === 'noteOn' || event.type === 'noteOff') {
			const isOff = event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)

			// Collect per-difficulty raw MIDI notes for pro guitar/bass, pro keys,
			// and elite drums. These instruments store notes verbatim with
			// velocity+channel (matching YARG.Core) rather than being dispatched
			// through the difficulty-range noteOn logic below.
			if (collectRawNotes) {
				const key = `${event.noteNumber}:${event.channel}`
				if (!isOff) {
					if (!rawStarts.has(key)) {
						rawStarts.set(key, { tick: event.deltaTime, noteNumber: event.noteNumber, velocity: event.velocity, channel: event.channel })
					}
				} else {
					const start = rawStarts.get(key)
					if (start) {
						const diff = getRawNoteDifficulty(event.noteNumber, instrumentType, fixedRawNoteDifficulty)
						if (diff) {
							rawNotesByDifficulty[diff].push({
								tick: start.tick,
								length: event.deltaTime - start.tick,
								noteNumber: start.noteNumber,
								velocity: start.velocity,
								channel: start.channel,
							})
						}
						rawStarts.delete(key)
					}
				}
			}

			// Pro Keys range shift markers (notes 0, 2, 4, 5, 7, 9 — no overlap
			// with Pro Keys playable notes 48-72, so exclusive).
			if (isProKeys && (event.noteNumber === 0 || event.noteNumber === 2 || event.noteNumber === 4
				|| event.noteNumber === 5 || event.noteNumber === 7 || event.noteNumber === 9)) {
				if (!isOff) {
					if (!rangeShiftStarts.has(event.noteNumber)) {
						rangeShiftStarts.set(event.noteNumber, event.deltaTime)
					}
				} else {
					const startTick = rangeShiftStarts.get(event.noteNumber)
					if (startTick !== undefined) {
						proKeysRangeShifts.push({ tick: startTick, length: event.deltaTime - startTick, noteNumber: event.noteNumber })
						rangeShiftStarts.delete(event.noteNumber)
					}
				}
				continue
			}

			// Collect versus phrase markers (notes 105/106). These don't overlap
			// with any note-shaped events, so we don't fall through.
			if (event.noteNumber === 105 || event.noteNumber === 106) {
				if (!isOff) {
					if (!versusStarts.has(event.noteNumber)) {
						versusStarts.set(event.noteNumber, event.deltaTime)
					}
				} else {
					const startTick = versusStarts.get(event.noteNumber)
					if (startTick !== undefined) {
						versusPhrases.push({ tick: startTick, length: event.deltaTime - startTick, isPlayer2: event.noteNumber === 106 })
						versusStarts.delete(event.noteNumber)
					}
				}
				continue
			}

			// Collect animation events (notes 24-51 drums, 40-59 fret). These
			// overlap with easy-difficulty playable notes (60-66), so the event
			// must also fall through to the difficulty-based dispatch below.
			if (animationFilter(event.noteNumber)) {
				if (!isOff) {
					if (!animStarts.has(event.noteNumber)) {
						animStarts.set(event.noteNumber, event.deltaTime)
					}
				} else {
					const startTick = animStarts.get(event.noteNumber)
					if (startTick !== undefined) {
						animations.push({ tick: startTick, length: event.deltaTime - startTick, noteNumber: event.noteNumber })
						animStarts.delete(event.noteNumber)
					}
				}
				// fall through — animation note ranges overlap easy-difficulty notes
			}

			const difficulty =
				event.noteNumber <= 66 ? 'easy'
				: event.noteNumber <= 78 ? 'medium'
				: event.noteNumber <= 90 ? 'hard'
				: event.noteNumber <= 102 ? 'expert'
				: 'all'
			if (difficulty === 'all') {
				// Instrument-wide event (solo marker, star power, etc...) (applies to all difficulties)
				const type = getInstrumentEventType(event.noteNumber, instrumentType)
				if (type !== null) {
					eventEnds[difficulty].push({
						tick: event.deltaTime,
						type,
						velocity: event.velocity,
						channel: event.channel,
						isStart: event.type === 'noteOn',
						_seq: seq++,
					})
				}
			} else {
				const type =
					instrumentType === instrumentTypes.sixFret ? get6FretNoteType(event.noteNumber, difficulty)
					: instrumentType === instrumentTypes.drums ? getDrumsNoteType(event.noteNumber, difficulty)
					: instrumentType === instrumentTypes.fiveFret ? get5FretNoteType(event.noteNumber, difficulty, enhancedOpens)
					: null // New instrument types: per-difficulty notes not parsed yet
				if (type !== null) {
					eventEnds[difficulty].push({
						tick: event.deltaTime,
						type,
						velocity: event.velocity,
						channel: event.channel,
						isStart: event.type === 'noteOn',
						_seq: seq++,
					})
				}
			}
		} else if (event.type === 'text') {
			let consumedAsNote = false
			if (instrumentType === instrumentTypes.drums) {
				const discoFlipMatch = event.text.match(/^\s*\[?mix[ _]([0-3])[ _]drums([0-5])(d|dnoflip|easy|easynokick|)\]?\s*$/)
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
		}
	}

	versusPhrases.sort((a, b) => a.tick - b.tick)
	animations.sort((a, b) => a.tick - b.tick)
	proKeysRangeShifts.sort((a, b) => a.tick - b.tick)
	for (const diff of difficulties) {
		rawNotesByDifficulty[diff].sort((a, b) => a.tick - b.tick || a.noteNumber - b.noteNumber)
	}
	return { eventEnds, textEvents, versusPhrases, animations, rawNotesByDifficulty, proKeysRangeShifts }
}

/** These apply to the entire instrument, not specific difficulties. */
function getInstrumentEventType(note: number, instrumentType: InstrumentType) {
	switch (note) {
		case 103:
			// Solo on standard instruments and elite drums. NOT solo on pro guitar/bass/keys (they use 115).
			if (instrumentType === instrumentTypes.proGuitar || instrumentType === instrumentTypes.proKeys) return null
			return eventTypes.soloSection
		case 115:
			// Solo on pro guitar/bass and pro keys only
			if (instrumentType === instrumentTypes.proGuitar || instrumentType === instrumentTypes.proKeys) {
				return eventTypes.soloSection
			}
			return null
		case 104:
			// forceTap on standard fret instruments only
			if (instrumentType === instrumentTypes.fiveFret || instrumentType === instrumentTypes.sixFret) {
				return eventTypes.forceTap
			}
			return null
		case 109:
			// forceFlam on standard drums only
			if (instrumentType === instrumentTypes.drums) return eventTypes.forceFlam
			return null
		case 110:
			if (instrumentType === instrumentTypes.drums) return eventTypes.yellowTomMarker
			return null
		case 111:
			if (instrumentType === instrumentTypes.drums) return eventTypes.blueTomMarker
			return null
		case 112:
			if (instrumentType === instrumentTypes.drums) return eventTypes.greenTomMarker
			return null
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
			// Pro Keys: glissando. All others: tremolo/single roll lane.
			return instrumentType === instrumentTypes.proKeys ? eventTypes.glissando : eventTypes.flexLaneSingle
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
function distributeInstrumentEvents(eventEnds: { [difficulty in Difficulty | 'all']: TrackEventEnd[] }, forceDistribute = false) {
	for (const instrumentEvent of eventEnds.all) {
		for (const difficulty of difficulties) {
			if (!forceDistribute && eventEnds[difficulty].length === 0) {
				continue // Skip adding modifiers to uncharted difficulties
			}
			eventEnds[difficulty].push(_.clone(instrumentEvent))
		}
	}

	return {
		expert: _.orderBy(eventEnds.expert, ['tick', 'type'], ['asc', 'desc']),
		hard: _.orderBy(eventEnds.hard, ['tick', 'type'], ['asc', 'desc']),
		medium: _.orderBy(eventEnds.medium, ['tick', 'type'], ['asc', 'desc']),
		easy: _.orderBy(eventEnds.easy, ['tick', 'type'], ['asc', 'desc']),
	}
}

/**
 * Connects together start and end events to determine event lengths.
 *
 * Returns `trackEvents` plus an `orphans` summary — unpaired noteOn starts
 * (dropped at the end) and unpaired noteOff ends (dropped when no matching
 * start is found). The caller surfaces these as chart issues.
 */
function getTrackEvents(trackEventEnds: { [key in Difficulty]: TrackEventEnd[] }): {
	trackEvents: { [key in Difficulty]: MidiTrackEvent[] }
	orphans: { starts: number; ends: number }
} {
	const trackEvents: { [key in Difficulty]: MidiTrackEvent[] } = { expert: [], hard: [], medium: [], easy: [] }
	let orphanEnds = 0

	for (const difficulty of difficulties) {
		const partialTrackEventsMap = _.chain(eventTypes)
			.values()
			.map(k => [k, []])
			.fromPairs()
			.value() as { [key in EventType]: MidiTrackEvent[] }

		for (const trackEventEnd of trackEventEnds[difficulty]) {
			const partialTrackEvents = partialTrackEventsMap[trackEventEnd.type]
			if (trackEventEnd.isStart) {
				const partialTrackEvent: MidiTrackEvent = {
					tick: trackEventEnd.tick,
					length: -1, // Represents that this is a partial track event (an end event has not been found for this yet)
					type: trackEventEnd.type,
					velocity: trackEventEnd.velocity,
					channel: trackEventEnd.channel,
					_fromSysEx: trackEventEnd._fromSysEx,
				}
				partialTrackEvents.push(partialTrackEvent)
				trackEvents[difficulty].push(partialTrackEvent)
			} else {
				// Pair end events with the closest previous (most recent) matching
				// start — LIFO ordering per the BTrack spec: "Each end event is
				// paired with the closest previous start event."
				let partialTrackEventIndex = partialTrackEvents.length - 1
				while (partialTrackEventIndex >= 0 && partialTrackEvents[partialTrackEventIndex].channel !== trackEventEnd.channel) {
					partialTrackEventIndex--
				}
				if (partialTrackEventIndex >= 0) {
					const partialTrackEvent = _.pullAt(partialTrackEvents, partialTrackEventIndex)[0]
					partialTrackEvent.length = trackEventEnd.tick - partialTrackEvent.tick
					// Tag the paired event with the MIDI file position of the
					// END event that closed it — resolveFretModifiers uses this
					// to match YARG's "last closure wins" ordering for overlapping
					// force modifiers.
					partialTrackEvent._endSeq = trackEventEnd._seq
				} else {
					// No matching start event for this end — spec says drop it.
					orphanEnds++
				}
			}
		}
	}

	// Count unpaired starts (still length === -1) before dropping them.
	let orphanStarts = 0
	for (const difficulty of difficulties) {
		for (const ev of trackEvents[difficulty]) {
			if (ev.length === -1) orphanStarts++
		}
		_.remove(trackEvents[difficulty], e => e.length === -1) // Remove all remaining partial events
	}

	return { trackEvents, orphans: { starts: orphanStarts, ends: orphanEnds } }
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
	// New instrument types have no per-difficulty notes to modify; return as-is
	if (instrumentType === instrumentTypes.proGuitar || instrumentType === instrumentTypes.proKeys || instrumentType === instrumentTypes.eliteDrums) {
		return events
	}
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

			_.remove(activeModifiers, m => {
				const end = m.tick + m.length
				// Most modifier sustains exclude their last tick, matching YARG.Core's
				// `if (endTick > startTick) --endTick` in ProcessNoteOnEventAsGuitarForcedType.
				// SysEx-sourced forceTap is the exception: YARG's
				if (m.length === 0) return end < event.tick
				return end <= event.tick
			})

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
							// Propagate the original sustain's end-event file position
							// so resolveFretModifiers can use it to pick the "winning"
							// modifier when multiple overlap on the same note.
							_endSeq: activeModifier._endSeq,
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
	_.remove(
		events['easy'],
		e => (e.type === eventTypes.flexLaneSingle || e.type === eventTypes.flexLaneDouble) && (e.velocity < 21 || e.velocity > 30),
	)
	_.remove(
		events['medium'],
		e => (e.type === eventTypes.flexLaneSingle || e.type === eventTypes.flexLaneDouble) && (e.velocity < 21 || e.velocity > 40),
	)
	_.remove(
		events['hard'],
		e => (e.type === eventTypes.flexLaneSingle || e.type === eventTypes.flexLaneDouble) && (e.velocity < 21 || e.velocity > 50),
	)

	return events
}

export type RawNote = { tick: number; length: number; noteNumber: number; velocity: number; channel: number }

/**
 * Instruments that store per-difficulty raw MIDI notes (pro guitar/bass, pro keys,
 * elite drums) instead of the standard difficulty-range noteOn dispatch.
 */
function storesRawNotes(instrumentType: InstrumentType): boolean {
	return instrumentType === instrumentTypes.proGuitar
		|| instrumentType === instrumentTypes.proKeys
		|| instrumentType === instrumentTypes.eliteDrums
}

/**
 * Determine which difficulty a raw MIDI note belongs to. Pro guitar/bass uses
 * per-difficulty note ranges; pro keys has one MIDI track per difficulty; elite
 * drums uses per-difficulty offsets.
 */
function getRawNoteDifficulty(
	noteNumber: number,
	instrumentType: InstrumentType,
	fixedDifficulty?: Difficulty,
): Difficulty | null {
	if (instrumentType === instrumentTypes.proGuitar) {
		// Pro Guitar/Bass: 6 strings + per-difficulty modifiers
		// Easy=24-34, Medium=48-58, Hard=72-82, Expert=96-108
		if (noteNumber >= 24 && noteNumber <= 34) return 'easy'
		if (noteNumber >= 48 && noteNumber <= 58) return 'medium'
		if (noteNumber >= 72 && noteNumber <= 82) return 'hard'
		if (noteNumber >= 96 && noteNumber <= 108) return 'expert'
		// Root note markers (4-18) apply to all difficulties — store on expert
		if (noteNumber >= 4 && noteNumber <= 18) return 'expert'
		return null
	}

	if (instrumentType === instrumentTypes.proKeys) {
		// Pro Keys: notes 48-72 (25 keys). Each track is one difficulty.
		if (noteNumber >= 48 && noteNumber <= 72) return fixedDifficulty ?? 'expert'
		return null
	}

	if (instrumentType === instrumentTypes.eliteDrums) {
		// Elite Drums: base offsets Easy=2, Medium=26, Hard=50, Expert=74
		// 10 pads (offset -2 to +8) + modifiers (offset +13, +14, +16)
		if (noteNumber >= 0 && noteNumber <= 18) return 'easy'
		if (noteNumber >= 24 && noteNumber <= 42) return 'medium'
		if (noteNumber >= 48 && noteNumber <= 66) return 'hard'
		if (noteNumber >= 72 && noteNumber <= 90) return 'expert'
		return null
	}

	return null
}

const handMapLookup: { [key: string]: RawChartData['trackData'][number]['handMaps'][number]['type'] } = {
	'HandMap_Default': 'default', 'HandMap_NoChords': 'noChords', 'HandMap_AllChords': 'allChords',
	'HandMap_AllBend': 'allBend', 'HandMap_Solo': 'solo', 'HandMap_DropD': 'dropD',
	'HandMap_DropD2': 'dropD2', 'HandMap_Chord_C': 'chordC', 'HandMap_Chord_D': 'chordD',
	'HandMap_Chord_A': 'chordA',
}
const strumMapLookup: { [key: string]: RawChartData['trackData'][number]['strumMaps'][number]['type'] } = {
	'StrumMap_Default': 'default', 'StrumMap_Pick': 'pick', 'StrumMap_SlapBass': 'slapBass',
}
const characterStateLookup: { [key: string]: RawChartData['trackData'][number]['characterStates'][number]['type'] } = {
	'idle': 'idle', 'idle_intense': 'idleIntense', 'idle_realtime': 'idleRealtime',
	'play': 'play', 'play_solo': 'playSolo', 'intense': 'intense', 'mellow': 'mellow',
}

/**
 * Extract HandMap, StrumMap, and CharacterState events from text events on instrument tracks.
 * These are text events that YARG interprets into typed animation objects.
 * YARG strips brackets before matching, so we normalize here.
 */
function extractTypedTextEvents(events: MidiEvent[]) {
	const handMaps: RawChartData['trackData'][number]['handMaps'] = []
	const strumMaps: RawChartData['trackData'][number]['strumMaps'] = []
	const characterStates: RawChartData['trackData'][number]['characterStates'] = []

	for (const event of events) {
		if (!isTextLikeEvent(event)) continue
		let text = event.text
		// YARG's NormalizeTextEvent strips brackets
		if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
		text = text.trim()

		// HandMap: "map HandMap_*"
		const handMapMatch = /^map (HandMap_\w+)$/.exec(text)
		if (handMapMatch) {
			const type = handMapLookup[handMapMatch[1]]
			if (type) handMaps.push({ tick: event.deltaTime, type })
			continue
		}

		// StrumMap: "map StrumMap_*"
		const strumMapMatch = /^map (StrumMap_\w+)$/.exec(text)
		if (strumMapMatch) {
			const type = strumMapLookup[strumMapMatch[1]]
			if (type) strumMaps.push({ tick: event.deltaTime, type })
			continue
		}

		// CharacterState: bare text matching known states
		const charState = characterStateLookup[text]
		if (charState) {
			characterStates.push({ tick: event.deltaTime, type: charState })
		}
	}

	// Deterministic ordering for same-tick events so round-trip is stable
	// regardless of whether the original file stored them as 'text' vs
	// 'lyrics' meta events (the writer re-serializes characterStates as
	// lyrics, so push-order from the original file isn't preserved).
	handMaps.sort((a, b) => a.tick - b.tick || a.type.localeCompare(b.type))
	strumMaps.sort((a, b) => a.tick - b.tick || a.type.localeCompare(b.type))
	characterStates.sort((a, b) => a.tick - b.tick || a.type.localeCompare(b.type))

	return { handMaps, strumMaps, characterStates }
}

/**
 * YARG copies star power and solo sections from the Pro Keys expert track to all other
 * Pro Keys difficulties (each Pro Keys difficulty is a separate MIDI track, but star power
 * and solo are only charted on the expert track).
 */
function copyDownProKeysPhrases(tracks: RawChartData['trackData']): RawChartData['trackData'] {
	const expertProKeys = tracks.find(t => t.instrument === 'prokeys' && t.difficulty === 'expert')
	if (!expertProKeys) return tracks

	for (const track of tracks) {
		if (track.instrument !== 'prokeys' || track.difficulty === 'expert') continue
		if (track.starPowerSections.length === 0 && expertProKeys.starPowerSections.length > 0) {
			track.starPowerSections = expertProKeys.starPowerSections.map(p => ({ ...p }))
		}
		if (track.soloSections.length === 0 && expertProKeys.soloSections.length > 0) {
			track.soloSections = expertProKeys.soloSections.map(p => ({ ...p }))
		}
		// Range shifts are charted per-difficulty, but if missing, copy from expert
		if (track.proKeysRangeShifts.length === 0 && expertProKeys.proKeysRangeShifts.length > 0) {
			track.proKeysRangeShifts = expertProKeys.proKeysRangeShifts.map(p => ({ ...p }))
		}
	}
	return tracks
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
	/** All remaining text-like events not recognized as sections/endEvents/lyrics/phrases.
	 *  Coda events are included here as well (for consumer visibility) in addition to
	 *  codaEvents. Lyrics and phrase_start/phrase_end are extracted separately by the
	 *  vocals path. */
	unrecognizedEvents: { tick: number; text: string }[]
	/** Issues raised while classifying EVENTS track text events (e.g. stray lyric/phrase
	 *  events that belong on PART VOCALS, not EVENTS). */
	parseIssues: RawChartData['parseIssues']
}

/**
 * Single-pass scan of the EVENTS track that classifies each text-like event
 * into one of {section, endEvent, coda, lyric, phrase, unrecognized}. Lyrics
 * and phrase_start/phrase_end are consumed by the vocal parsing path — we
 * don't re-emit them here. Everything else that matches a recognized pattern
 * goes into its typed array; all remaining text-like events fall through to
 * `unrecognizedEvents`.
 *
 * Reads from all text-like event types (text, lyrics, marker, cuePoint),
 * matching YARG.Core's MoonText behavior.
 */
function scanEventsTrack(tracks: { trackName: TrackName; trackEvents: MidiEvent[] }[]): EventsScanResult {
	const result: EventsScanResult = {
		sections: [],
		endEvents: [],
		codaEvents: [],
		unrecognizedEvents: [],
		parseIssues: [],
	}
	// YARG iterates ALL chunks with trackName === 'EVENTS' in file order,
	// accumulating into one MoonSong. Merge events from every EVENTS track
	// before classifying. Also skip the first event of each track (YARG's
	// `for (int i = 1; ...)` loop, which drops any event before the trackName).
	const eventsTracks = tracks.filter(t => t.trackName === 'EVENTS')
	if (eventsTracks.length === 0) return result

	for (const eventsTrack of eventsTracks) {
		const evs = eventsTrack.trackEvents
		for (let i = 1; i < evs.length; i++) {
			const event = evs[i]
			if (!isTextLikeEvent(event)) continue
			const text = event.text
			const tick = event.deltaTime

			// Sections use YARG-compatible normalization (matches parseMidiSectionEventText:
			// content between FIRST `[` and FIRST `]`, then strip 'section' / 'prc' prefix).
			const sectionName = parseMidiSectionEventText(text)
			if (sectionName !== null) {
				result.sections.push({ tick, name: sectionName })
				continue
			}
			if (/^\[?end\]?$/.test(text)) {
				result.endEvents.push({ tick })
				continue
			}
			if (/^\s*\[?coda\]?\s*$/.test(text)) {
				result.codaEvents.push({ tick })
				// Coda is also exposed in unrecognizedEvents for consumer visibility
				// (matching YARG/MoonSong behavior where coda appears in globalEvents).
				result.unrecognizedEvents.push({ tick, text })
				continue
			}
			// Lyrics and phrase markers belong on PART VOCALS in .mid charts, not on
			// the EVENTS track. Game engines silently drop them when they show up
			// here. Record a parse issue so consumers can surface the misplacement,
			// then fall through to unrecognizedEvents so the value round-trips back
			// out — users can move it to PART VOCALS manually.
			if (/^\[?\s*lyric[ \t]/.test(text)) {
				result.parseIssues.push({ instrument: null, difficulty: null, noteIssue: 'invalidLyric' })
			} else if (/^\[?phrase_start\]?$/.test(text)) {
				result.parseIssues.push({ instrument: null, difficulty: null, noteIssue: 'invalidPhraseStart' })
			} else if (/^\[?phrase_end\]?$/.test(text)) {
				result.parseIssues.push({ instrument: null, difficulty: null, noteIssue: 'invalidPhraseEnd' })
			}

			result.unrecognizedEvents.push({ tick, text })
		}
	}
	// Sort sections by (tick, name) and unrecognizedEvents by (tick, text) so
	// multi-EVENTS-track charts produce the same ordering as YARG's
	// MoonText.InsertionCompareTo sorted inserts.
	result.sections.sort((a, b) => a.tick - b.tick || a.name.localeCompare(b.name))
	result.unrecognizedEvents.sort((a, b) => a.tick - b.tick || a.text.localeCompare(b.text))
	return result
}

// ---------------------------------------------------------------------------
// VENUE track parsing
// ---------------------------------------------------------------------------

/** VENUE MIDI note → event. */
const venueNoteLookup: { [note: number]: VenueEvent | undefined } = {
	// Post-processing (96-110)
	96: { tick: 0, type: 'postProcessing', name: 'default' },
	97: { tick: 0, type: 'postProcessing', name: 'polarized_black_white' },
	98: { tick: 0, type: 'postProcessing', name: 'grainy_film' },
	99: { tick: 0, type: 'postProcessing', name: 'sepiatone' },
	100: { tick: 0, type: 'postProcessing', name: 'silvertone' },
	101: { tick: 0, type: 'postProcessing', name: 'photonegative' },
	102: { tick: 0, type: 'postProcessing', name: 'choppy_black_white' },
	103: { tick: 0, type: 'postProcessing', name: 'bloom' },
	104: { tick: 0, type: 'postProcessing', name: 'desaturated_red' },
	105: { tick: 0, type: 'postProcessing', name: 'mirror' },
	106: { tick: 0, type: 'postProcessing', name: 'scanlines_blue' },
	107: { tick: 0, type: 'postProcessing', name: 'scanlines' },
	108: { tick: 0, type: 'postProcessing', name: 'scanlines_black_white' },
	109: { tick: 0, type: 'postProcessing', name: 'scanlines_security' },
	110: { tick: 0, type: 'postProcessing', name: 'trails_long' },
	// Singalong (85-87)
	85: { tick: 0, type: 'singalong', name: 'bass' },
	86: { tick: 0, type: 'singalong', name: 'drums' },
	87: { tick: 0, type: 'singalong', name: 'guitar' },
	// Camera cut constraints (70-73)
	70: { tick: 0, type: 'cameraCutConstraint', name: 'no_behind' },
	71: { tick: 0, type: 'cameraCutConstraint', name: 'only_far' },
	72: { tick: 0, type: 'cameraCutConstraint', name: 'only_close' },
	73: { tick: 0, type: 'cameraCutConstraint', name: 'no_close' },
	// Camera cuts (60-64)
	60: { tick: 0, type: 'cameraCut', name: 'random' },
	61: { tick: 0, type: 'cameraCut', name: 'directed_bass' },
	62: { tick: 0, type: 'cameraCut', name: 'directed_drums' },
	63: { tick: 0, type: 'cameraCut', name: 'directed_guitar' },
	64: { tick: 0, type: 'cameraCut', name: 'directed_vocals' },
	// Lighting keyframes (48-50)
	48: { tick: 0, type: 'lighting', name: 'next' },
	49: { tick: 0, type: 'lighting', name: 'previous' },
	50: { tick: 0, type: 'lighting', name: 'first' },
	// Spotlights (37-41)
	37: { tick: 0, type: 'spotlight', name: 'bass' },
	38: { tick: 0, type: 'spotlight', name: 'drums' },
	39: { tick: 0, type: 'spotlight', name: 'guitar' },
	40: { tick: 0, type: 'spotlight', name: 'vocals' },
	41: { tick: 0, type: 'spotlight', name: 'keys' },
}

/** VENUE text events: lighting presets via "lighting (TYPE)". */
const venueLightingLookup: { [key: string]: string } = {
	'': 'default', 'chorus': 'chorus', 'dischord': 'dischord',
	'manual_cool': 'cool_manual', 'manual_warm': 'warm_manual', 'stomp': 'stomp',
	'verse': 'verse', 'blackout_fast': 'blackout_fast', 'blackout_slow': 'blackout_slow',
	'blackout_spot': 'blackout_spotlight', 'bre': 'big_rock_ending',
	'flare_fast': 'flare_fast', 'flare_slow': 'flare_slow', 'frenzy': 'frenzy',
	'harmony': 'harmony', 'intro': 'intro', 'loop_cool': 'cool_automatic',
	'loop_warm': 'warm_automatic', 'searchlights': 'searchlights',
	'silhouettes': 'silhouettes', 'silhouettes_spot': 'silhouettes_spotlight',
	'strobe_fast': 'strobe_fast', 'strobe_slow': 'strobe_slow', 'sweep': 'sweep',
}

/** VENUE text events: post-processing effects via "[xxx.pp]". */
const venuePostProcessingLookup: { [key: string]: string } = {
	'bloom.pp': 'bloom', 'bright.pp': 'bright', 'clean_trails.pp': 'trails',
	'contrast_a.pp': 'polarized_black_white', 'desat_blue.pp': 'desaturated_blue',
	'desat_posterize_trails.pp': 'trails_desaturated', 'film_contrast.pp': 'contrast',
	'film_b+w.pp': 'black_white', 'film_sepia_ink.pp': 'sepiatone',
	'film_silvertone.pp': 'silvertone', 'film_contrast_red.pp': 'contrast_red',
	'film_contrast_green.pp': 'contrast_green', 'film_contrast_blue.pp': 'contrast_blue',
	'film_16mm.pp': 'grainy_film', 'film_blue_filter.pp': 'scanlines_blue',
	'flicker_trails.pp': 'trails_flickery', 'horror_movie_special.pp': 'photonegative_red_black',
	'photocopy.pp': 'choppy_black_white', 'photo_negative.pp': 'photonegative',
	'posterize.pp': 'posterize', 'ProFilm_a.pp': 'default', 'ProFilm_b.pp': 'desaturated_red',
	'ProFilm_mirror_a.pp': 'mirror', 'ProFilm_psychedelic_blue_red.pp': 'polarized_red_blue',
	'shitty_tv.pp': 'grainy_chromatic_abberation', 'space_woosh.pp': 'trails_spacey',
	'video_a.pp': 'scanlines', 'video_bw.pp': 'scanlines_black_white',
	'video_security.pp': 'scanlines_security', 'video_trails.pp': 'trails_long',
}

/** VENUE text events: directed camera cuts via "[directed_*]". */
const venueDirectedCutLookup: { [key: string]: string } = {
	'directed_guitar': 'directed_guitar', 'directed_bass': 'directed_bass',
	'directed_drums': 'directed_drums', 'directed_vocals': 'directed_vocals',
	'directed_stagedive': 'directed_stagedive', 'directed_crowdsurf': 'directed_crowdsurf',
	'directed_all': 'directed_all', 'directed_bre': 'directed_bre',
	'directed_brej': 'directed_brej', 'directed_guitar_cam': 'directed_guitar_cam',
	'directed_bass_cam': 'directed_bass_cam', 'directed_drums_kd': 'directed_drums_kd',
	'directed_drums_lt': 'directed_drums_lt', 'directed_drums_np': 'directed_drums_np',
	'directed_crowd_g': 'directed_crowd_g', 'directed_crowd_b': 'directed_crowd_b',
	'directed_crowd_pnt': 'directed_crowd_pnt', 'directed_duo_drums': 'directed_duo_drums',
	'directed_guitar_cls': 'directed_guitar_cls', 'directed_bass_cls': 'directed_bass_cls',
	'directed_vocals_cam': 'directed_vocals_cam', 'directed_vocals_cls': 'directed_vocals_cls',
	'directed_all_cam': 'directed_all_cam', 'directed_all_lt': 'directed_all_lt',
	'directed_all_yeah': 'directed_all_yeah', 'directed_guitar_np': 'directed_guitar_np',
	'directed_bass_np': 'directed_bass_np', 'directed_vocals_np': 'directed_vocals_np',
	'directed_drums_pnt': 'directed_drums_pnt',
}

/** VENUE text events: RBN2 coop camera cuts via "[coop_*_*]". */
const venueCoopCutLookup: { [key: string]: string } = {
	'all_behind': 'all_behind', 'all_far': 'all_far', 'all_near': 'all_near',
	'front_behind': 'front_behind', 'front_near': 'front_near',
	'd_behind': 'd_behind', 'd_near': 'd_near',
	'v_behind': 'v_behind', 'v_near': 'v_near',
	'b_behind': 'b_behind', 'b_near': 'b_near',
	'g_behind': 'g_behind', 'g_near': 'g_near',
	'k_behind': 'k_behind', 'k_near': 'k_near',
	'd_closeup_hand': 'd_closeup_hand', 'd_closeup_head': 'd_closeup_head',
	'v_closeup': 'v_closeup',
	'b_closeup_hand': 'b_closeup_hand', 'b_closeup_head': 'b_closeup_head',
	'g_closeup_hand': 'g_closeup_hand', 'g_closeup_head': 'g_closeup_head',
	'k_closeup_hand': 'k_closeup_hand', 'k_closeup_head': 'k_closeup_head',
	'dv_near': 'dv_near', 'bd_near': 'bd_near', 'dg_near': 'dg_near',
	'bv_behind': 'bv_behind', 'bv_near': 'bv_near',
	'gv_behind': 'gv_behind', 'gv_near': 'gv_near',
	'kv_behind': 'kv_behind', 'kv_near': 'kv_near',
	'bg_behind': 'bg_behind', 'bg_near': 'bg_near',
	'bk_behind': 'bk_behind', 'bk_near': 'bk_near',
	'gk_behind': 'gk_behind', 'gk_near': 'gk_near',
}

/** Standalone venue text events (direct text → event mapping). */
const venueStandaloneTextLookup: { [key: string]: VenueEvent | undefined } = {
	'first': { tick: 0, type: 'lighting', name: 'first' },
	'next': { tick: 0, type: 'lighting', name: 'next' },
	'prev': { tick: 0, type: 'lighting', name: 'previous' },
	'verse': { tick: 0, type: 'lighting', name: 'verse' },
	'chorus': { tick: 0, type: 'lighting', name: 'chorus' },
	'bonusfx': { tick: 0, type: 'stageEffect', name: 'bonus_fx' },
	'bonusfx_optional': { tick: 0, type: 'stageEffect', name: 'optional bonus_fx' },
	'FogOn': { tick: 0, type: 'stageEffect', name: 'fog_on' },
	'FogOff': { tick: 0, type: 'stageEffect', name: 'fog_off' },
}

/**
 * Extract all venue events from the VENUE MIDI track.
 * Handles both note-based events and text-based events.
 */
function extractVenueEvents(tracks: { trackName: TrackName; trackEvents: MidiEvent[] }[]): VenueEvent[] {
	const venueTrack = tracks.find(t => t.trackName === 'VENUE')
	if (!venueTrack) return []

	const events: VenueEvent[] = []
	// Match YARG's ReadVenueEvents: note-based events are only emitted when
	// a matching noteOff arrives (`new MoonVenue(type, text, startTick,
	// endTick - startTick)`). Unpaired noteOns are silently dropped. Track
	// unpaired noteOns in a queue keyed by note number — when a noteOff
	// arrives for the same note, pop the earliest matching noteOn and emit
	// a venue event with the computed length.
	const unpairedNotes: { noteNumber: number; tick: number }[] = []

	// Match YARG's ReadVenueEvents: skip the FIRST event regardless of type
	// (YARG iterates `for (int i = 1; ...)` and assumes the first event is
	// the track name). Some charts have a spurious text event at index 0
	// BEFORE the real trackName event — we must skip it to match YARG.
	let skipFirst = true
	for (const event of venueTrack.trackEvents) {
		if (skipFirst) {
			skipFirst = false
			continue
		}
		// Note events: queue noteOns, emit on noteOff.
		const isNoteOn = event.type === 'noteOn' && (event as { velocity: number }).velocity > 0
		const isNoteOff = event.type === 'noteOff' || (event.type === 'noteOn' && (event as { velocity: number }).velocity === 0)
		if (isNoteOn) {
			const noteNumber = (event as { noteNumber: number }).noteNumber
			// Duplicate noteOn: YARG logs a debug message but still adds
			// the new note to the queue. We do the same.
			unpairedNotes.push({ noteNumber, tick: event.deltaTime })
			continue
		}
		if (isNoteOff) {
			const noteNumber = (event as { noteNumber: number }).noteNumber
			// Find the earliest unpaired noteOn with the same note number.
			const idx = unpairedNotes.findIndex(n => n.noteNumber === noteNumber)
			if (idx >= 0) {
				const start = unpairedNotes[idx]
				unpairedNotes.splice(idx, 1)
				const template = venueNoteLookup[noteNumber]
				if (template) {
					events.push({
						tick: start.tick,
						type: template.type,
						name: template.name,
						length: event.deltaTime - start.tick,
					})
				}
			}
			continue
		}

		// Text-based events
		if (isTextLikeEvent(event)) {
			let text = event.text
			// YARG's NormalizeTextEvent: if the text contains `[` and `]`,
			// return the content between them (trimmed). Otherwise return
			// the trimmed text. The brackets don't have to wrap the entire
			// string — "[verse] " (trailing space) yields "verse".
			const openIdx = text.indexOf('[')
			const closeIdx = text.indexOf(']')
			if (openIdx >= 0 && closeIdx >= 0 && openIdx <= closeIdx) {
				text = text.slice(openIdx + 1, closeIdx)
			}
			text = text.trim()

			// Lighting: "lighting (TYPE)"
			// YARG falls back to "default" for any lighting type not in its
			// conversion lookup (including `default` and empty string).
			const lightingMatch = /^lighting\s+\((.*)\)$/.exec(text)
			if (lightingMatch) {
				const name = venueLightingLookup[lightingMatch[1]] ?? 'default'
				events.push({ tick: event.deltaTime, type: 'lighting', name })
				continue
			}

			// Post-processing: "*.pp". YARG's lookup falls through to the
			// Unknown-type bucket for any `.pp` text not in its conversion
			// lookup, so we match that by letting unrecognized `.pp` values
			// fall through to the unknown-text handler at the end.
			if (text.endsWith('.pp')) {
				const name = venuePostProcessingLookup[text]
				if (name) {
					events.push({ tick: event.deltaTime, type: 'postProcessing', name })
					continue
				}
				// Unknown .pp: fall through to the Unknown handler below.
			}

			// Directed camera cuts: "directed_*". YARG's regex `(directed_\w+)`
			// has no anchors — it matches the FIRST occurrence of a directed_*
			// token anywhere in the text (e.g. "do_directed_cut directed_bass"
			// matches `directed_cut` first). Any directed_* token not in the
			// lookup falls back to "default" in YARG. For unrecognized values
			// we store the full bracket-stripped text as `name` so the writer
			// can re-emit it verbatim for round-trip fidelity.
			const directedMatch = /(directed_\w+)/.exec(text)
			if (directedMatch) {
				const name = venueDirectedCutLookup[directedMatch[1]] ?? text
				events.push({ tick: event.deltaTime, type: 'cameraCut', name })
				continue
			}

			// Coop camera cuts: "coop_*_*". YARG's regex captures the tail
			// after `coop_` and falls back to "default" for unknown values.
			// For unrecognized values we store the full text as `name`.
			const coopMatch = /^coop_(\w+_\w+)$/.exec(text)
			if (coopMatch) {
				const name = venueCoopCutLookup[coopMatch[1]] ?? text
				events.push({ tick: event.deltaTime, type: 'cameraCut', name })
				continue
			}

			// Standalone text events
			const standalone = venueStandaloneTextLookup[text]
			if (standalone) {
				events.push({ tick: event.deltaTime, type: standalone.type, name: standalone.name })
				continue
			}

			// Unknown text event — YARG preserves these as `Unknown`-typed
			// MoonVenue events. The name stores the full bracket-stripped text
			// so the writer can re-emit it verbatim.
			events.push({ tick: event.deltaTime, type: 'unknown', name: text })
		}
	}

	events.sort((a, b) => a.tick - b.tick)
	return events
}

/**
 * Extract BEAT-track events. Matches YARG.Core's `ReadSongBeats`:
 * - skip the first event (track name)
 * - MIDI note 12 = measure beat (BeatlineType.Measure)
 * - MIDI note 13 = strong beat (BeatlineType.Strong)
 * - MIDI note 14 = weak beat (BeatlineType.Weak)
 */
function extractBeatTrack(
	tracks: { trackName: TrackName; trackEvents: MidiEvent[] }[],
): { tick: number; type: 'measure' | 'strong' | 'weak' }[] | undefined {
	const beatTrack = tracks.find(t => t.trackName === 'BEAT')
	if (!beatTrack) return undefined

	const out: { tick: number; type: 'measure' | 'strong' | 'weak' }[] = []
	let skipFirst = true
	for (const event of beatTrack.trackEvents) {
		// YARG skips the first event (the track name) before parsing beat notes.
		if (skipFirst) {
			skipFirst = false
			continue
		}
		if (event.type !== 'noteOn' || (event as { velocity: number }).velocity === 0) continue
		const noteNumber = (event as { noteNumber: number }).noteNumber
		let type: 'measure' | 'strong' | 'weak' | null = null
		if (noteNumber === 12) type = 'measure'
		else if (noteNumber === 13) type = 'strong'
		else if (noteNumber === 14) type = 'weak'
		if (type === null) continue
		out.push({ tick: event.deltaTime, type })
	}
	// Sort beat notes by tick so output is deterministic regardless of file
	// order. Some charts (e.g. "Old Man's Child - Black Seeds on Virgin Soil")
	// store BEAT notes out of order, which causes setEventMsTimes to compute
	// wrong msTimes via its forward-only rolling tempo index when a tempo
	// change coincides with one of the beat positions.
	out.sort((a, b) => a.tick - b.tick)
	// Treat an empty BEAT track the same as a missing one — round-trip
	// consumers don't write empty BEAT tracks, so returning `[]` would
	// break the round-trip diff. Example: "Creed - Torn".
	return out.length > 0 ? out : undefined
}

