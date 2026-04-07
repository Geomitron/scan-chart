import * as _ from 'lodash'
import { MidiData, MidiEvent, MidiSetTempoEvent, MidiTextEvent, MidiTimeSignatureEvent, parseMidi } from 'midi-file'

import { difficulties, Difficulty, getInstrumentType, Instrument, InstrumentType, instrumentTypes } from 'src/interfaces'
import { EventType, eventTypes, IniChartModifiers, RawChartData, VocalTrackData } from './note-parsing-interfaces'
import { extractMidiLyrics, extractMidiVocalPhrases, extractMidiVocalNotes, extractMidiVocalStarPower, extractMidiRangeShifts, extractMidiLyricShifts } from './lyric-parser'

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
}

// Necessary because .mid stores some additional modifiers and information using velocity
type MidiTrackEvent = RawChartData['trackData'][number]['trackEvents'][number] & { velocity: number; channel: number }

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

	const tracks = getTracks(midiFile)

	// Build vocalTracks from PART VOCALS and HARM1/HARM2/HARM3
	const vocalTracks: { [part: string]: VocalTrackData } = {}
	for (const track of tracks) {
		const partName = vocalTrackNameMap[track.trackName as VocalTrackName]
		if (partName && !vocalTracks[partName]) {
			const events = track.trackEvents
			vocalTracks[partName] = {
				lyrics: extractMidiLyrics(events),
				vocalPhrases: extractMidiVocalPhrases(events),
				notes: extractMidiVocalNotes(events),
				starPowerSections: extractMidiVocalStarPower(events),
				rangeShifts: extractMidiRangeShifts(events),
				lyricShifts: extractMidiLyricShifts(events),
				staticLyricPhrases: [],
			}
		}
	}

	// YARG CopyDownPhrases: HARM2/HARM3 get scoring phrases AND star power from HARM1.
	// HARM2 keeps its own note-105 phrases as staticLyricPhrases (for lyric display),
	// then replaces vocalPhrases (scoring) and starPowerSections with HARM1's.
	// HARM3 clones HARM2's staticLyricPhrases and also gets HARM1's scoring/starpower.
	if (vocalTracks.harmony1) {
		const harm1Phrases = vocalTracks.harmony1.vocalPhrases
		const harm1StarPower = vocalTracks.harmony1.starPowerSections
		if (vocalTracks.harmony2) {
			vocalTracks.harmony2.staticLyricPhrases = vocalTracks.harmony2.vocalPhrases.map(p => ({ tick: p.tick, length: p.length }))
			vocalTracks.harmony2.vocalPhrases = harm1Phrases.map(p => ({ ...p }))
			vocalTracks.harmony2.starPowerSections = harm1StarPower.map(p => ({ ...p }))
		}
		if (vocalTracks.harmony3) {
			vocalTracks.harmony3.staticLyricPhrases = (vocalTracks.harmony2?.staticLyricPhrases ?? []).map(p => ({ ...p }))
			vocalTracks.harmony3.vocalPhrases = harm1Phrases.map(p => ({ ...p }))
			vocalTracks.harmony3.starPowerSections = harm1StarPower.map(p => ({ ...p }))
		}
	}

	const codaEvents =
		tracks
			.find(t => t.trackName === 'EVENTS')
			?.trackEvents.filter(e => isTextLikeEvent(e) && (e.text.trim() === 'coda' || e.text.trim() === '[coda]')) ?? []
	const firstCodaTick = codaEvents[0] ? codaEvents[0].deltaTime : null

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
		sections: _.chain(tracks)
			.find(t => t.trackName === 'EVENTS')
			.get('trackEvents')
			.filter((e): e is MidiTextEvent => isTextLikeEvent(e) && /^\[?(?:section|prc)[ _]([^\]]*)\]?$/.test(e.text))
			.map(e => ({
				tick: e.deltaTime,
				name: e.text.match(/^\[?(?:section|prc)[ _]([^\]]*)\]?$/)![1],
			}))
			.value(),
		endEvents: _.chain(tracks)
			.find(t => t.trackName === 'EVENTS')
			.get('trackEvents')
			.filter((e): e is MidiTextEvent => isTextLikeEvent(e) && /^\[?end\]?$/.test(e.text))
			.map(e => ({
				tick: e.deltaTime,
			}))
			.value(),
		globalEvents: extractGlobalEvents(tracks),
		trackData: _.chain(tracks)
			.filter(t => _.keys(instrumentNameMap).includes(t.trackName))
			.map(t => {
				const instrument = instrumentNameMap[t.trackName as InstrumentTrackName]
				const instrumentType = getInstrumentType(instrument)
				const isNewInstrument = instrumentType === instrumentTypes.proGuitar || instrumentType === instrumentTypes.proKeys || instrumentType === instrumentTypes.eliteDrums
				const trackDifficulties = _.chain(t.trackEvents)
					.thru(trackEvents => getTrackEventEnds(trackEvents, instrumentType))
					.thru(eventEnds => distributeInstrumentEvents(eventEnds, isNewInstrument)) // Removes 'all' difficulty
					.thru(eventEnds => getTrackEvents(eventEnds)) // Connects note ends together
					.thru(events => splitMidiModifierSustains(events, instrumentType))
					.thru(events => fixLegacyGhStarPower(events, instrumentType, iniChartModifiers))
					.thru(events => fixFlexLaneLds(events))
					.value()

				// Extract instrument-wide data (same for all difficulties)
				const { handMaps, strumMaps, characterStates } = extractTypedTextEvents(t.trackEvents)
				const textEvents = extractInstrumentTextEvents(t.trackEvents, instrumentType, t.trackName)
				const versusPhrases = extractVersusPhrases(t.trackEvents)
				const animations = extractAnimations(t.trackEvents, instrumentType)
				const proKeysRangeShifts = instrumentType === instrumentTypes.proKeys
					? extractMidiInstrumentNotePairs(t.trackEvents, n => n === 0 || n === 2 || n === 4 || n === 5 || n === 7 || n === 9)
					: []
				const rawNotesByDifficulty = isNewInstrument
					? extractRawNotes(t.trackEvents, instrumentType, proKeysDifficultyMap[t.trackName as string] as Difficulty | undefined)
					: null

				// Pro Keys: one MIDI track per difficulty; others: all 4 difficulties from one track
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
						rawNotes: rawNotesByDifficulty?.[difficulty] ?? [],
					}

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
			.filter(track =>
				track.trackEvents.length > 0
				|| track.rawNotes.length > 0
				|| track.starPowerSections.length > 0
				|| track.soloSections.length > 0,
			)
			.thru(tracks => copyDownProKeysPhrases(tracks))
			.value(),
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

function getTracks(midiData: MidiData) {
	const tracks: { trackName: TrackName; trackEvents: MidiEvent[] }[] = []

	for (const track of midiData.tracks) {
		let trackName: string | null = null
		for (const event of track) {
			if (event.deltaTime !== 0) {
				break
			}
			if (event.type === 'trackName' && trackNames.includes(event.text as TrackName)) {
				trackName = event.text
			}
		}

		if (trackName !== null) {
			tracks.push({
				trackName: trackName as TrackName,
				trackEvents: track,
			})
		}
	}

	return tracks
}

/** Gets the starting and ending notes for all midi events defined for the .mid chart spec. */
function getTrackEventEnds(events: MidiEvent[], instrumentType: InstrumentType) {
	let enhancedOpens = false
	const trackEventEnds: { [difficulty in Difficulty | 'all']: TrackEventEnd[] } = {
		all: [],
		expert: [],
		hard: [],
		medium: [],
		easy: [],
	}

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
					trackEventEnds[event.data[4] === 0xff ? 'all' : discoFlipDifficultyMap[event.data[4]]].push({
						tick: event.deltaTime,
						type,
						channel: 1,
						velocity: 127,
						isStart: event.data[6] === 0x01,
					})
				}
			}
		} else if (event.type === 'noteOn' || event.type === 'noteOff') {
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
					trackEventEnds[difficulty].push({
						tick: event.deltaTime,
						type,
						velocity: event.velocity,
						channel: event.channel,
						isStart: event.type === 'noteOn',
					})
				}
			} else {
				const type =
					instrumentType === instrumentTypes.sixFret ? get6FretNoteType(event.noteNumber, difficulty)
					: instrumentType === instrumentTypes.drums ? getDrumsNoteType(event.noteNumber, difficulty)
					: instrumentType === instrumentTypes.fiveFret ? get5FretNoteType(event.noteNumber, difficulty, enhancedOpens)
					: null // New instrument types: per-difficulty notes not parsed yet
				if (type !== null) {
					trackEventEnds[difficulty].push({
						tick: event.deltaTime,
						type,
						velocity: event.velocity,
						channel: event.channel,
						isStart: event.type === 'noteOn',
					})
				}
			}
		} else if (event.type === 'text') {
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
						trackEventEnds[difficulty].push({ tick: event.deltaTime, type: eventType, velocity: 127, channel: 1, isStart: true })
						trackEventEnds[difficulty].push({ tick: event.deltaTime, type: eventType, velocity: 127, channel: 1, isStart: false })
					}
				}
			}

			if (event.text === 'ENHANCED_OPENS' || event.text === '[ENHANCED_OPENS]') {
				enhancedOpens = true
			} else if (event.text === 'ENABLE_CHART_DYNAMICS' || event.text === '[ENABLE_CHART_DYNAMICS]') {
				// Treat this like the other events that have a start and end, so it can be processed the same way later
				trackEventEnds['all'].push({ tick: event.deltaTime, type: eventTypes.enableChartDynamics, channel: 1, isStart: true, velocity: 127 })
				trackEventEnds['all'].push({ tick: event.deltaTime, type: eventTypes.enableChartDynamics, channel: 1, isStart: false, velocity: 127 })
			}
		}
	}

	return trackEventEnds
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

/** Regex matching disco flip mix events that are consumed by the existing drum parsing logic. */
const discoFlipRegex = /^\s*\[?mix[ _][0-3][ _]drums[0-5](d|dnoflip|easy|easynokick|)\]?\s*$/

/**
 * Extract text events from a MIDI instrument track that aren't already consumed
 * by other parsing logic (disco flip, ENHANCED_OPENS, ENABLE_CHART_DYNAMICS).
 * Also filters tick-0 text events that duplicate the track name.
 */
function extractInstrumentTextEvents(events: MidiEvent[], instrumentType: InstrumentType, trackName: string): { tick: number; text: string }[] {
	const textEvents: { tick: number; text: string }[] = []
	for (const event of events) {
		if (event.type !== 'text') continue
		const text = (event as MidiTextEvent).text
		if (text === 'ENHANCED_OPENS' || text === '[ENHANCED_OPENS]') continue
		if (text === 'ENABLE_CHART_DYNAMICS' || text === '[ENABLE_CHART_DYNAMICS]') continue
		if (instrumentType === instrumentTypes.drums && discoFlipRegex.test(text)) continue
		// Skip tick-0 text events that duplicate the track name (same as vocal lyric filter)
		if (event.deltaTime === 0 && text === trackName) continue
		textEvents.push({ tick: event.deltaTime, text })
	}
	return textEvents
}

/**
 * Extract note-on/note-off pairs from a MIDI track for the given note number filter.
 * Handles velocity-0 noteOn as noteOff, duplicate noteOn skip.
 * Events must already be in absolute time.
 */
function extractMidiInstrumentNotePairs(
	events: MidiEvent[],
	noteFilter: (noteNumber: number) => boolean,
): { tick: number; length: number; noteNumber: number }[] {
	const starts = new Map<number, number>()
	const results: { tick: number; length: number; noteNumber: number }[] = []

	for (const event of events) {
		if (event.type !== 'noteOn' && event.type !== 'noteOff') continue
		const noteNumber = (event as { noteNumber: number }).noteNumber
		if (noteNumber === undefined || !noteFilter(noteNumber)) continue

		const isOff = event.type === 'noteOff' || (event.type === 'noteOn' && (event as { velocity: number }).velocity === 0)
		if (!isOff) {
			if (!starts.has(noteNumber)) {
				starts.set(noteNumber, event.deltaTime)
			}
		} else {
			const startTick = starts.get(noteNumber)
			if (startTick !== undefined) {
				results.push({ tick: startTick, length: event.deltaTime - startTick, noteNumber })
				starts.delete(noteNumber)
			}
		}
	}

	results.sort((a, b) => a.tick - b.tick)
	return results
}

/**
 * Extract versus phrase markers (notes 105/106) from a MIDI instrument track.
 */
function extractVersusPhrases(events: MidiEvent[]): { tick: number; length: number; isPlayer2: boolean }[] {
	return extractMidiInstrumentNotePairs(events, n => n === 105 || n === 106)
		.map(p => ({ tick: p.tick, length: p.length, isPlayer2: p.noteNumber === 106 }))
}

/**
 * Extract animation note events from a MIDI instrument track.
 * Guitar/bass/keys: left hand positions (notes 40-59)
 * Drums: pad animations (notes 24-51)
 */
type RawNote = { tick: number; length: number; noteNumber: number; velocity: number; channel: number }

/**
 * Extract raw MIDI note pairs for new instruments, grouped by difficulty.
 * Handles instrument-specific difficulty ranges and note layouts.
 */
function extractRawNotes(
	events: MidiEvent[],
	instrumentType: InstrumentType,
	fixedDifficulty?: Difficulty,
): { [key in Difficulty]: RawNote[] } {
	const result: { [key in Difficulty]: RawNote[] } = { expert: [], hard: [], medium: [], easy: [] }

	// Collect all noteOn/noteOff events
	const starts = new Map<string, { tick: number; noteNumber: number; velocity: number; channel: number }>()
	for (const event of events) {
		if (event.type !== 'noteOn' && event.type !== 'noteOff') continue
		const { noteNumber, velocity, channel } = event as { noteNumber: number; velocity: number; channel: number }
		if (noteNumber === undefined) continue

		const isOff = event.type === 'noteOff' || (event.type === 'noteOn' && velocity === 0)
		// Key by noteNumber+channel to handle multi-channel pro guitar
		const key = `${noteNumber}:${channel}`

		if (!isOff) {
			if (!starts.has(key)) {
				starts.set(key, { tick: event.deltaTime, noteNumber, velocity, channel })
			}
		} else {
			const start = starts.get(key)
			if (start) {
				const diff = getNoteRawDifficulty(noteNumber, instrumentType, fixedDifficulty)
				if (diff) {
					result[diff].push({
						tick: start.tick,
						length: event.deltaTime - start.tick,
						noteNumber: start.noteNumber,
						velocity: start.velocity,
						channel: start.channel,
					})
				}
				starts.delete(key)
			}
		}
	}

	for (const diff of difficulties) {
		result[diff].sort((a, b) => a.tick - b.tick || a.noteNumber - b.noteNumber)
	}
	return result
}

/** Determine which difficulty a MIDI note belongs to for a new instrument. */
function getNoteRawDifficulty(
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

	return { handMaps, strumMaps, characterStates }
}

function extractAnimations(events: MidiEvent[], instrumentType: InstrumentType): { tick: number; length: number; noteNumber: number }[] {
	if (instrumentType === instrumentTypes.drums) {
		return extractMidiInstrumentNotePairs(events, n => n >= 24 && n <= 51)
	}
	return extractMidiInstrumentNotePairs(events, n => n >= 40 && n <= 59)
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

/** Patterns for events already extracted into dedicated fields. */
const sectionRegex = /^\[?(?:section|prc)[ _]/
const endRegex = /^\[?end\]?$/
const lyricRegex = /^\[?\s*lyric[ \t]/
const phraseStartRegex = /^\[?phrase_start\]?$/
const phraseEndRegex = /^\[?phrase_end\]?$/

/**
 * Extract global text events from EVENTS track, excluding events already
 * extracted into sections, endEvents, vocalTracks (lyrics, phrase_start/end), and coda.
 * Reads from all text-like event types (text, lyrics, marker, cuePoint).
 */
function extractGlobalEvents(tracks: { trackName: TrackName; trackEvents: MidiEvent[] }[]): { tick: number; text: string }[] {
	const eventsTrack = tracks.find(t => t.trackName === 'EVENTS')
	if (!eventsTrack) return []

	const globalEvents: { tick: number; text: string }[] = []
	for (const event of eventsTrack.trackEvents) {
		if (!isTextLikeEvent(event)) continue
		const text = event.text
		if (sectionRegex.test(text)) continue
		if (endRegex.test(text)) continue
		if (lyricRegex.test(text)) continue
		if (phraseStartRegex.test(text)) continue
		if (phraseEndRegex.test(text)) continue
		globalEvents.push({ tick: event.deltaTime, text })
	}
	return globalEvents
}
