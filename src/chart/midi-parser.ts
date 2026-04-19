import * as _ from 'lodash'
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
		trackData: _.chain(tracks)
			.filter(t => _.keys(instrumentNameMap).includes(t.trackName))
			.map(t => {
				const instrument = instrumentNameMap[t.trackName as InstrumentTrackName]
				const instrumentType = getInstrumentType(instrument)
				// Single scan pass extracts note-shaped events AND the
				// data-carrying ones (text, versus, animations), plus the
				// unrecognized events for round-trip preservation.
				const { eventEnds, textEvents, versusPhrases, animations, unrecognizedEvents: trackUnrecognized } =
					scanInstrumentTrack(t.trackEvents, instrumentType, t.trackName)
				const distributed = distributeInstrumentEvents(eventEnds) // Removes 'all' difficulty
				const pairedEvents = getTrackEvents(distributed) // Connects note ends together
				const trackDifficulties = _.chain(pairedEvents)
					.thru(events => splitMidiModifierSustains(events, instrumentType))
					.thru(events => fixLegacyGhStarPower(events, instrumentType, iniChartModifiers))
					.thru(events => fixFlexLaneLds(events))
					.value()

				return difficulties.map(difficulty => {
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
						// All difficulties on a single MIDI track share the same
						// per-track unrecognized events (the writer only emits one
						// MIDI track, so storing them once is fine — the writer
						// reads from any difficulty).
						unrecognizedMidiEvents: trackUnrecognized,
					}

					for (const event of trackDifficulties[difficulty]) {
						if (event.type === eventTypes.starPower) {
							result.starPowerSections.push(event)
						} else if (event.type === eventTypes.rejectedStarPower) {
							result.rejectedStarPowerSections.push(event)
						} else if (event.type === eventTypes.soloSection) {
							result.soloSections.push(event)
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
					|| track.starPowerSections.length > 0
					|| track.soloSections.length > 0
			})
			.value(),
		parseIssues: [...parseIssues, ...eventsScan.parseIssues],
	}
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
	// Events the typed parser doesn't consume — preserved verbatim for round-trip.
	const unrecognizedEvents: MidiEvent[] = []

	for (const event of events) {
		// SysEx event (tap modifier or open)
		if (event.type === 'sysEx' || event.type === 'endSysEx') {
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
				eventEnds[event.data[4] === 0xff ? 'all' : discoFlipDifficultyMap[event.data[4]]].push({
					tick: event.deltaTime,
					type,
					channel: 1,
					velocity: 127,
					isStart: event.data[6] === 0x01,
				})
			} else {
				unrecognizedEvents.push(event)
			}
		} else if (event.type === 'noteOn' || event.type === 'noteOff') {
			const isOff = event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)
			let consumed = false

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
				consumed = true
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
				const type = getInstrumentEventType(event.noteNumber)
				if (type !== null) {
					eventEnds[difficulty].push({
						tick: event.deltaTime,
						type,
						velocity: event.velocity,
						channel: event.channel,
						isStart: event.type === 'noteOn',
					})
					consumed = true
				}
			} else {
				const type =
					instrumentType === instrumentTypes.sixFret ? get6FretNoteType(event.noteNumber, difficulty)
					: instrumentType === instrumentTypes.drums ? getDrumsNoteType(event.noteNumber, difficulty)
					: instrumentType === instrumentTypes.fiveFret ? get5FretNoteType(event.noteNumber, difficulty, enhancedOpens)
					: null
				if (type !== null) {
					eventEnds[difficulty].push({
						tick: event.deltaTime,
						type,
						velocity: event.velocity,
						channel: event.channel,
						isStart: event.type === 'noteOn',
					})
					consumed = true
				}
			}

			if (!consumed) unrecognizedEvents.push(event)
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
		} else if (event.type === 'trackName' || event.type === 'endOfTrack') {
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
 */
function getTrackEvents(trackEventEnds: { [key in Difficulty]: TrackEventEnd[] }) {
	const trackEvents: { [key in Difficulty]: MidiTrackEvent[] } = { expert: [], hard: [], medium: [], easy: [] }

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
				}
				partialTrackEvents.push(partialTrackEvent)
				trackEvents[difficulty].push(partialTrackEvent)
			} else if (partialTrackEvents.length) {
				let partialTrackEventIndex = partialTrackEvents.length - 1
				while (partialTrackEventIndex >= 0 && partialTrackEvents[partialTrackEventIndex].channel !== trackEventEnd.channel) {
					partialTrackEventIndex-- // Find the most recent partial event on the same channel
				}
				if (partialTrackEventIndex >= 0) {
					const partialTrackEvent = _.pullAt(partialTrackEvents, partialTrackEventIndex)[0]
					partialTrackEvent.length = trackEventEnd.tick - partialTrackEvent.tick
				}
			}
		}

		_.remove(trackEvents[difficulty], e => e.length === -1) // Remove all remaining partial events
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

			_.remove(activeModifiers, m => (m.length === 0 ? m.tick + m.length < event.tick : m.tick + m.length <= event.tick))

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
		const bracketedSection = /^\[(?:section|prc)[ _](.*)\]$/.exec(text)
		const plainSection = !bracketedSection && /^(?:section|prc)[ _](.*)$/.exec(text)
		if (bracketedSection || plainSection) {
			const name = (bracketedSection ?? plainSection as RegExpExecArray)[1]
			result.sections.push({ tick, name })
			continue
		}
		if (/^\[?end\]?$/.test(text)) {
			result.endEvents.push({ tick })
			continue
		}
		if (/^\s*\[?coda\]?\s*$/.test(text)) {
			result.codaEvents.push({ tick })
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
	return result
}

