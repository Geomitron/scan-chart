import * as _ from 'lodash'

import { Difficulty, DrumType, drumTypes, getInstrumentType, Instrument, instrumentTypes } from 'src/interfaces'
import { parseNotesFromChart } from './chart-parser'
import { parseNotesFromMidi } from './midi-parser'
import {
	defaultIniChartModifiers,
	EventType,
	eventTypes,
	IniChartModifiers,
	NoteEvent,
	NormalizedLyricEvent,
	NormalizedVocalNote,
	NormalizedVocalPhrase,
	NormalizedVocalPart,
	NormalizedVocalTrack,
	lyricFlags,
	noteFlags,
	NoteType,
	noteTypes,
	RawChartData,
	VocalTrackData,
} from './note-parsing-interfaces'
import { parseLyricFlags, stripLyricSymbols } from './lyric-parser'

type TrackEvent = RawChartData['trackData'][number]['trackEvents'][number]
type UntimedNoteEvent = Omit<NoteEvent, 'msTime' | 'msLength'>

export type ParsedChart = ReturnType<typeof parseChartFile>

/**
 * Parses `buffer` as a chart in the .chart or .mid format.
 *
 * Throws an exception if `buffer` could not be parsed as a chart in the .chart or .mid format.
 */
export function parseChartFile(data: Uint8Array, format: 'chart' | 'mid', partialIniChartModifiers: Partial<IniChartModifiers> = {}) {
	const iniChartModifiers = Object.assign({}, defaultIniChartModifiers, partialIniChartModifiers) as IniChartModifiers
	const rawChartData = format === 'mid' ? parseNotesFromMidi(data, iniChartModifiers) : parseNotesFromChart(data)
	const timedTempos = getTimedTempos(rawChartData.tempos, rawChartData.chartTicksPerBeat)
	const drumTracks = rawChartData.trackData.filter(track => track.instrument === 'drums')
	const drumType =
		drumTracks.length === 0 ? null
		: iniChartModifiers.pro_drums ? drumTypes.fourLanePro
		: iniChartModifiers.five_lane_drums ? drumTypes.fiveLane
		: drumTracks.find(track => track.trackEvents.find(e => isCymbalOrTomMarker(e.type))) ? drumTypes.fourLanePro
		: drumTracks.find(track => track.trackEvents.find(e => e.type === eventTypes.fiveGreenDrum)) ? drumTypes.fiveLane
		: drumTypes.fourLane
	const hasForcedNotes = _.chain(rawChartData.trackData)
		.filter(track => track.instrument !== 'drums')
		.some(track =>
			_.some(track.trackEvents, e => {
				return e.type === eventTypes.forceUnnatural || e.type === eventTypes.forceHopo || e.type === eventTypes.forceStrum
			}),
		)
		.value()

	const normalizedVocalTracks = normalizeVocalTracks(rawChartData.vocalTracks, timedTempos, rawChartData.chartTicksPerBeat)
	// Evaluate trackData first — normalizedVocalTracks is used below for phrase-level hasLyrics check.
	const trackDataResult = _.chain(rawChartData.trackData)
			.map(track => {
				return {
				instrument: track.instrument,
				difficulty: track.difficulty,
				starPowerSections: _.chain(track.starPowerSections)
					.thru(events => setEventMsTimes(events, timedTempos, rawChartData.chartTicksPerBeat))
					.thru(events => sortAndFixInvalidEventOverlaps(events))
					.value(),
				rejectedStarPowerSections: _.chain(track.rejectedStarPowerSections)
					.thru(events => setEventMsTimes(events, timedTempos, rawChartData.chartTicksPerBeat))
					.value(),
				soloSections: _.chain(track.soloSections)
					.thru(events => setEventMsTimes(events, timedTempos, rawChartData.chartTicksPerBeat))
					.thru(events => sortAndFixInvalidEventOverlaps(events))
					.value(),
				flexLanes: _.chain(track.flexLanes)
					.thru(events => setEventMsTimes(events, timedTempos, rawChartData.chartTicksPerBeat))
					.thru(events => sortAndFixInvalidFlexLaneOverlaps(events))
					.value(),
				drumFreestyleSections: setEventMsTimes(track.drumFreestyleSections, timedTempos, rawChartData.chartTicksPerBeat),
				textEvents: setEventMsTimes(track.textEvents, timedTempos, rawChartData.chartTicksPerBeat),
				versusPhrases: setEventMsTimes(track.versusPhrases, timedTempos, rawChartData.chartTicksPerBeat),
				animations: setEventMsTimes(track.animations, timedTempos, rawChartData.chartTicksPerBeat),
				noteEventGroups: _.chain(track.trackEvents)
					.thru(events => trimSustains(events, iniChartModifiers.sustain_cutoff_threshold, rawChartData.chartTicksPerBeat, format))
					.groupBy(note => note.tick)
					.values()
					.thru(eventGroups =>
						track.instrument === 'drums' ?
							resolveDrumModifiers(eventGroups, drumType!, format)
						:	resolveFretModifiers(eventGroups, iniChartModifiers, rawChartData.chartTicksPerBeat, format),
					)
					.thru(noteGroups => snapChords(noteGroups, iniChartModifiers.chord_snap_threshold, track.instrument))
					.tap(noteGroups => sortAndFixInvalidNoteOverlaps(noteGroups))
					.thru(events => setEventGroupMsTimes(events, timedTempos, rawChartData.chartTicksPerBeat))
					.value(),
				}
			})
			.value()

	return {
		resolution: rawChartData.chartTicksPerBeat,
		drumType,
		metadata: rawChartData.metadata,
		// Check phrase-level lyrics to decide hasLyrics — raw lyric events that
		// get filtered (brackets, whitespace-only) should not count.
		hasLyrics: Object.values(normalizedVocalTracks.parts).some(p =>
			p.notePhrases.some(ph => ph.lyrics.length > 0)),
		hasVocals: Object.values(rawChartData.vocalTracks).some(v => v.vocalPhrases.length > 0),
		hasForcedNotes,
		parseIssues: rawChartData.parseIssues,
		vocalTracks: normalizedVocalTracks,
		endEvents: setEventMsTimes(rawChartData.endEvents, timedTempos, rawChartData.chartTicksPerBeat),
		unrecognizedEvents: setEventMsTimes(rawChartData.unrecognizedEvents, timedTempos, rawChartData.chartTicksPerBeat),
		tempos: timedTempos,
		timeSignatures: setEventMsTimes(rawChartData.timeSignatures, timedTempos, rawChartData.chartTicksPerBeat),
		sections: setEventMsTimes(rawChartData.sections, timedTempos, rawChartData.chartTicksPerBeat),
		trackData: trackDataResult,
	}
}

// ---------------------------------------------------------------------------
// Vocal track normalization
// ---------------------------------------------------------------------------

type TimedTempos = { tick: number; beatsPerMinute: number; msTime: number }[]

function normalizeVocalTracks(
	vocalTracks: { [part: string]: VocalTrackData },
	timedTempos: TimedTempos,
	resolution: number,
): NormalizedVocalTrack {
	const entries = Object.entries(vocalTracks)
	const parts: { [partName: string]: NormalizedVocalPart } = {}

	// Find the source part for track-level data (vocals or harmony1)
	const sourcePart = vocalTracks['vocals'] ?? vocalTracks['harmony1']

	for (const [partName, data] of entries) {
		parts[partName] = normalizeVocalPart(data, timedTempos, resolution, partName)
	}

	return {
		parts,
		rangeShifts: sourcePart
			? setEventMsTimes(sourcePart.rangeShifts, timedTempos, resolution)
			: [],
		lyricShifts: sourcePart
			? setEventMsTimes(sourcePart.lyricShifts, timedTempos, resolution)
			: [],
	}
}

function normalizeVocalPart(
	data: VocalTrackData,
	timedTempos: TimedTempos,
	resolution: number,
	partName: string,
): NormalizedVocalPart {
	const isPartVocals = partName === 'vocals'
	const isHarm2or3 = partName === 'harmony2' || partName === 'harmony3'

	// PART VOCALS: merge note 105 + 106 into a single phrase list with player
	// tags. Both create scoring + static lyric phrases in YARG.
	// Harmonies: keep 105 (scoring) and 106 (static lyric) separate for
	// lossless round-trip — the writer needs to emit them on their original
	// MIDI note numbers, and CopyDown relies on HARM1's vocalPhrases (105 only).
	let notePhrases: NormalizedVocalPhrase[]
	let staticLyricPhrases: NormalizedVocalPhrase[]

	if (isPartVocals) {
		// Merge 105 + 106 for PART VOCALS
		const mergedPhrases: { tick: number; length: number; _source: 105 | 106 }[] = []
		for (const p of data.vocalPhrases) {
			mergedPhrases.push({ tick: p.tick, length: p.length, _source: 105 })
		}
		for (const p of data.staticLyricPhrases) {
			mergedPhrases.push({ tick: p.tick, length: p.length, _source: 106 })
		}
		mergedPhrases.sort((a, b) => a.tick - b.tick)

		// Dedup same-tick phrases (keep longest), track source of survivor
		const dedupedPhrases: typeof mergedPhrases = []
		const phraseSourceByTick = new Map<number, 105 | 106>()
		for (const p of mergedPhrases) {
			const existing = dedupedPhrases.find(d => d.tick === p.tick)
			if (existing) {
				if (p.length > existing.length) {
					existing.length = p.length
					existing._source = p._source
				}
			} else {
				dedupedPhrases.push(p)
			}
			phraseSourceByTick.set(p.tick, dedupedPhrases.find(d => d.tick === p.tick)!._source)
		}

		notePhrases = groupIntoPhrases(dedupedPhrases, data, timedTempos, resolution)

		// Set player field
		for (const phrase of notePhrases) {
			const source = phraseSourceByTick.get(phrase.tick)
			phrase.player = source === 106 ? 2 : 1
		}

		// staticLyricPhrases = copy of notePhrases for PART VOCALS
		staticLyricPhrases = notePhrases.map(p => ({ ...p }))
	} else {
		// Harmonies: separate 105/106 for lossless round-trip
		notePhrases = groupIntoPhrases(data.vocalPhrases, data, timedTempos, resolution)
		staticLyricPhrases = data.staticLyricPhrases.length > 0
			? groupIntoPhrases(data.staticLyricPhrases, data, timedTempos, resolution)
			: []
	}

	return {
		notePhrases,
		staticLyricPhrases,
		starPowerSections: setEventMsTimes(data.starPowerSections, timedTempos, resolution),
		rangeShifts: setEventMsTimes(data.rangeShifts, timedTempos, resolution),
		lyricShifts: setEventMsTimes(data.lyricShifts, timedTempos, resolution),
		textEvents: setEventMsTimes(data.textEvents ?? [], timedTempos, resolution),
	}
}

/** Standard emptiness check for lyrics (matching YARG's IsNullOrWhiteSpace
 * on StripForVocals output). Symbol-only lyrics like "+" strip to empty
 * and are dropped. */
function isLyricKept(text: string): boolean {
	const stripped = stripLyricSymbols(text)
	return stripped.length > 0 && stripped.replace(/_/g, ' ').trim().length > 0
}

function groupIntoPhrases(
	phrases: { tick: number; length: number }[],
	data: VocalTrackData,
	timedTempos: TimedTempos,
	resolution: number,
): NormalizedVocalPhrase[] {
	// Dedup phrases by tick (both note 105 and 106 can create phrases at the same tick)
	const dedupedPhrases: typeof phrases = []
	const seenTicks = new Set<number>()
	for (const p of phrases) {
		if (!seenTicks.has(p.tick)) {
			seenTicks.add(p.tick)
			dedupedPhrases.push(p)
		}
	}
	const timedPhrases = setEventMsTimes(dedupedPhrases, timedTempos, resolution)

	// Sort lyrics by tick then by text (matching YARG's MoonText.InsertionCompareTo which
	// uses .NET string.Compare — culture-aware, case-insensitive). This affects
	// DeferredLyricJoinWorkaround and final lyricFlags when multiple lyrics share a tick.
	const sortedLyrics = [...data.lyrics].sort((a, b) => {
		if (a.tick !== b.tick) return a.tick - b.tick
		return a.text.localeCompare(b.text)
	})

	let noteIdx = 0
	/** Shared lyric index across all phrases (matching YARG's moonTextIndex pattern).
	 *  Lyrics from skipped phrases carry over to the next phrase with notes. */
	let lyricIdx = 0
	/** End tick of the last note chain (including pitch slide extensions). Used for carry-over check. */
	let carriedNoteEndTick = -1
	/** Whether any lyric note has been seen across all phrases (YARG's previousParentLyric).
	 *  Pitch slides can attach to the previous lyric note even across phrase boundaries. */
	let hasPreviousLyricNote = false

	const result: NormalizedVocalPhrase[] = []
	for (const phrase of timedPhrases) {
		const phraseEnd = phrase.tick + phrase.length

		// Collect raw notes within this phrase
		const rawNotes: typeof data.notes = []
		while (noteIdx < data.notes.length && data.notes[noteIdx].tick < phraseEnd) {
			if (data.notes[noteIdx].tick >= phrase.tick) {
				rawNotes.push(data.notes[noteIdx])
			}
			noteIdx++
		}

		// Check if a pitch slide from a previous phrase carries into this one
		const hasCarriedNote = carriedNoteEndTick >= phrase.tick

		const notes: NormalizedVocalNote[] = []
		const untimedLyrics: { tick: number; text: string; flags: number }[] = []

		// Pre-collect all lyrics within this phrase's tick range. This advances
		// lyricIdx to a consistent position (phraseEnd) regardless of which notes
		// exist, preventing lyricIdx divergence when pitch slide notes are dropped
		// on round-trip. Note processing uses a local iterator (phraseLyricIdx)
		// over this pre-collected list for flag detection.
		const phraseLyrics: { tick: number; text: string; flags: number }[] = []
		while (lyricIdx < sortedLyrics.length && sortedLyrics[lyricIdx].tick < phraseEnd) {
			const lyric = sortedLyrics[lyricIdx]
			lyricIdx++
			const text = lyric.text.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
			if (text.startsWith('[')) continue
			phraseLyrics.push({ tick: lyric.tick, text, flags: parseLyricFlags(text) })
		}
		if (rawNotes.length === 0) {
			// No-notes path (.chart format, empty phrases): add all phrase lyrics
			for (const pl of phraseLyrics) {
				if (isLyricKept(pl.text)) {
					untimedLyrics.push({ tick: pl.tick, text: pl.text, flags: pl.flags })
				}
			}
		}

		// Process notes, using phraseLyrics for flag detection
		let phraseLyricIdx = 0
		for (const note of rawNotes) {
			if (note.type === 'percussionHidden') continue
			if (note.type === 'percussion' && note.tick === phrase.tick && notes.length === 0) {
				continue
			}

			// Collect lyrics up to and including this note's tick (local iterator)
			let noteLyricFlags = 0
			while (phraseLyricIdx < phraseLyrics.length && phraseLyrics[phraseLyricIdx].tick <= note.tick) {
				let { tick, text, flags } = phraseLyrics[phraseLyricIdx]
				phraseLyricIdx++

				noteLyricFlags = flags

				// DeferredLyricJoinWorkaround: "+-" or "-+" merges the hyphen into
				// the previous lyric's flags. We update noteLyricFlags for pitch
				// slide detection but keep the original text "+-" for lossless
				// round-trip — changing it to "+" causes the workaround to trigger
				// differently on re-parse (state-dependent, not idempotent).
				// DeferredLyricJoinWorkaround: "+-" or "-+" merges the hyphen into the previous lyric
				if (untimedLyrics.length > 0 && (text === '+-' || text === '-+')) {
					const prev = untimedLyrics[untimedLyrics.length - 1]
					if ((prev.flags & (lyricFlags.joinWithNext | lyricFlags.hyphenateWithNext)) === 0) {
						untimedLyrics[untimedLyrics.length - 1] = {
							...prev,
							text: prev.text + '-',
							flags: prev.flags | lyricFlags.joinWithNext,
						}
						text = '+'
						flags = lyricFlags.pitchSlide
						noteLyricFlags = flags
					}
				}

				if (isLyricKept(text)) {
					untimedLyrics.push({ tick, text, flags })
				}
			}

			const isPitchSlide = (noteLyricFlags & lyricFlags.pitchSlide) !== 0

			if (isPitchSlide) {
				// Only skip if the pitchSlide lyric survived the emptiness filter.
				// Symbol-only "+" strips to empty and is filtered from output. If
				// filtered, the lyric won't exist on re-parse, so the note wouldn't
				// be detected as a pitch slide — keeping it ensures round-trip
				// consistency for Harmonix-authored charts.
				const lastStored = untimedLyrics.length > 0 ? untimedLyrics[untimedLyrics.length - 1] : null
				const slideMarkerKept = lastStored !== null && (lastStored.flags & lyricFlags.pitchSlide) !== 0
				if (slideMarkerKept) {
					const slideEnd = note.tick + note.length
					if (notes.length > 0) {
						continue
					}
					if (hasCarriedNote) {
						carriedNoteEndTick = Math.max(carriedNoteEndTick, slideEnd)
						continue
					}
					if (result.length === 0) {
						continue
					}
					if (hasPreviousLyricNote) {
						carriedNoteEndTick = Math.max(carriedNoteEndTick, slideEnd)
						continue
					}
				}
			}

			const timed = setEventMsTimes([note], timedTempos, resolution)[0]
			notes.push({
				tick: timed.tick,
				msTime: timed.msTime,
				length: timed.length,
				msLength: timed.msLength,
				// Keep original MIDI pitch for pitched notes (even nonPitched ones
				// marked by lyric flags like #/^/*). Consumers check the lyric's
				// nonPitched flag instead. Percussion always gets -1 (fixed MIDI note 96).
				pitch: note.type === 'percussion' ? -1 : note.pitch,
				type: note.type,
			})
			if (note.type === 'pitched') hasPreviousLyricNote = true
		}

		// Add remaining pre-collected lyrics after the last note (with-notes path only;
		// no-notes path already added all phraseLyrics above)
		while (rawNotes.length > 0 && phraseLyricIdx < phraseLyrics.length) {
			const { tick, text, flags } = phraseLyrics[phraseLyricIdx]
			phraseLyricIdx++
			if (isLyricKept(text)) {
				untimedLyrics.push({ tick, text, flags })
			}
		}

		// NOTE: Intentionally do NOT drop "empty" phrases (no notes, no lyrics, no carried
		// note). Keeping them preserves the full set of phrase boundaries so that writers
		// can round-trip the full MIDI state. Consumers wanting a YARG-compatible filtered
		// view can filter notePhrases themselves.

		// Track carry-over: only from notes that were added to the phrase (not pitch slide children).
		// YARG sets carriedNote at line 219-222, which only runs for notes that pass through
		// the pitch slide `continue` paths. Pitch slide children don't reach this code.
		for (const n of notes) {
			// Find the raw note to get the original length
			const raw = data.notes.find(r => r.tick === n.tick && r.type !== 'percussionHidden')
			if (raw && raw.tick + raw.length > phraseEnd) {
				carriedNoteEndTick = raw.tick + raw.length
			}
		}

		const isPercussion = notes.length > 0 && notes[0].type === 'percussion'

		result.push({
			tick: phrase.tick,
			msTime: phrase.msTime,
			length: phrase.length,
			msLength: phrase.msLength,
			isPercussion,
			notes,
			lyrics: setEventMsTimes(untimedLyrics, timedTempos, resolution),
		})
	}
	return result
}

function getTimedTempos(
	tempos: { tick: number; beatsPerMinute: number }[],
	chartTicksPerBeat: number,
): { tick: number; beatsPerMinute: number; msTime: number }[] {
	const newTempos: { tick: number; beatsPerMinute: number; msTime: number }[] = [{ tick: 0, beatsPerMinute: 120, msTime: 0 }]

	for (const tempo of tempos) {
		const newTempo = tempo as { tick: number; beatsPerMinute: number; msTime: number }
		const lastTempo = newTempos[newTempos.length - 1]

		newTempo.msTime = lastTempo.msTime + ((tempo.tick - lastTempo.tick) * 60000) / (lastTempo.beatsPerMinute * chartTicksPerBeat)
		newTempos.push(newTempo)
	}

	if (newTempos[1] && newTempos[1].tick === 0) {
		newTempos.shift()
	}
	return newTempos
}

function isCymbalOrTomMarker(type: EventType) {
	switch (type) {
		case eventTypes.yellowCymbalMarker:
		case eventTypes.blueCymbalMarker:
		case eventTypes.greenCymbalMarker:
		case eventTypes.yellowTomMarker:
		case eventTypes.blueTomMarker:
		case eventTypes.greenTomMarker:
			return true
		default:
			return false
	}
}

function setEventGroupMsTimes<T extends { tick: number; length?: number }>(
	events: T[][],
	tempos: { tick: number; beatsPerMinute: number; msTime: number }[],
	chartTicksPerBeat: number,
) {
	return setEventOrEventGroupMsTimes(events, tempos, chartTicksPerBeat) as (T & { msTime: number; msLength: number })[][]
}
function setEventMsTimes<T extends { tick: number; length?: number }>(
	events: T[],
	tempos: { tick: number; beatsPerMinute: number; msTime: number }[],
	chartTicksPerBeat: number,
) {
	return setEventOrEventGroupMsTimes(events, tempos, chartTicksPerBeat) as (T & { msTime: number; msLength: number })[]
}
function setEventOrEventGroupMsTimes<T extends { tick: number; length?: number }>(
	events: T[] | T[][],
	tempos: { tick: number; beatsPerMinute: number; msTime: number }[],
	chartTicksPerBeat: number,
) {
	let lastTempoIndex = 0

	const processNextEvent = (event: T) => {
		while (tempos[lastTempoIndex + 1] && tempos[lastTempoIndex + 1].tick <= event.tick) {
			lastTempoIndex++
		}

		const lastTempo = tempos[lastTempoIndex]
		const newEvent = event as T & { msTime: number; msLength: number }

		newEvent.msTime = lastTempo.msTime + ((event.tick - lastTempo.tick) * 60000) / (lastTempo.beatsPerMinute * chartTicksPerBeat)

		if (event.length) {
			let endTempoIndex = lastTempoIndex
			while (tempos[endTempoIndex + 1] && tempos[endTempoIndex + 1].tick <= event.tick + event.length) {
				endTempoIndex++
			}
			const endTempo = tempos[endTempoIndex]
			newEvent.msLength =
				// eslint-disable-next-line max-len
				endTempo.msTime - newEvent.msTime + ((event.tick + event.length - endTempo.tick) * 60000) / (endTempo.beatsPerMinute * chartTicksPerBeat)
		} else {
			newEvent.msLength = 0
		}
	}

	if (Array.isArray(events[0])) {
		for (const eventGroup of events as T[][]) {
			for (const event of eventGroup) {
				processNextEvent(event)
			}
		}
	} else {
		for (const event of events as T[]) {
			processNextEvent(event)
		}
	}
	return events as (T & { msTime: number; msLength: number })[][] | (T & { msTime: number; msLength: number })[]
}

function trimSustains(
	trackEvents: { tick: number; length: number; type: EventType }[],
	sustain_cutoff_threshold: number,
	chartTicksPerBeat: number,
	format: 'chart' | 'mid',
) {
	const sustainThresholdTicks =
		sustain_cutoff_threshold !== -1 ? sustain_cutoff_threshold
		: format === 'mid' ? Math.floor(chartTicksPerBeat / 3) + 1
		: 0

	if (sustainThresholdTicks > 0) {
		for (const event of trackEvents) {
			if (event.length <= sustainThresholdTicks) {
				event.length = 0
			}
		}
	}

	return trackEvents
}

function resolveDrumModifiers(trackEventGroups: TrackEvent[][], drumType: DrumType, format: 'chart' | 'mid'): UntimedNoteEvent[][] {
	const noteEventGroups: UntimedNoteEvent[][] = []
	const discoFlipEventTypes = [eventTypes.discoFlipOff, eventTypes.discoFlipOn, eventTypes.discoNoFlipOn] as const

	let activeDiscoFlip: (typeof discoFlipEventTypes)[number] = eventTypes.discoFlipOff
	for (const events of trackEventGroups) {
		const notes = events.filter(e => isDrumNote(e.type) && !isKickNote(e.type))
		const kicks = events.filter(e => isKickNote(e.type))
		const modifiers = events.filter(e => !isDrumNote(e.type)).map(m => m.type)
		const discoFlipModifier = _.chain(modifiers)
			.filter(e => discoFlipEventTypes.includes(e as (typeof discoFlipEventTypes)[number]))
			.min()
			.value()
		if (discoFlipModifier) {
			activeDiscoFlip = discoFlipModifier as 51 | 52 | 53 // Set before checked for this event (start inclusive, end exclusive)
		}
		if (notes.length + kicks.length === 0) {
			continue // Skip any event groups with only modifiers
		}

		const noteEventGroup: UntimedNoteEvent[] = []

		const flamFlag = modifiers.find(e => e === eventTypes.forceFlam) ? noteFlags.flam : noteFlags.none
		for (const kick of kicks) {
			const kickTypeFlag = kick.type === eventTypes.kick ? noteFlags.none : noteFlags.doubleKick
			noteEventGroup.push({
				tick: kick.tick,
				length: kick.length,
				type: noteTypes.kick,
				flags: flamFlag | kickTypeFlag | getGhostOrAccentFlags(kick.type, modifiers),
			})
		}

		const hasOrangeAndGreen =
			!!notes.find(e => e.type === eventTypes.fiveGreenDrum) && !!notes.find(e => e.type === eventTypes.fiveOrangeFourGreenDrum)

		for (const note of notes) {
			const type = getDrumNoteTypeFromEventType(note.type, hasOrangeAndGreen)!
			const canBeDisco = type === noteTypes.redDrum || type === noteTypes.yellowDrum
			const discoFlag =
				!canBeDisco || activeDiscoFlip === eventTypes.discoFlipOff ? noteFlags.none
				: activeDiscoFlip === eventTypes.discoFlipOn ? noteFlags.disco
				: noteFlags.discoNoflip
			const baseFlags = flamFlag | discoFlag
			noteEventGroup.push({
				tick: note.tick,
				length: note.length,
				type,
				flags: baseFlags | getTomOrCymbalFlags(note.type, modifiers, drumType, format) | getGhostOrAccentFlags(note.type, modifiers),
			})
		}

		noteEventGroups.push(noteEventGroup)
	}

	return noteEventGroups
}

function isDrumNote(eventType: EventType) {
	switch (eventType) {
		case eventTypes.kick:
		case eventTypes.kick2x:
		case eventTypes.redDrum:
		case eventTypes.yellowDrum:
		case eventTypes.blueDrum:
		case eventTypes.fiveOrangeFourGreenDrum:
		case eventTypes.fiveGreenDrum:
			return true
		default:
			return false
	}
}

function isKickNote(eventType: EventType) {
	switch (eventType) {
		case eventTypes.kick:
		case eventTypes.kick2x:
			return true
		default:
			return false
	}
}

function getDrumNoteTypeFromEventType(eventType: EventType, hasOrangeAndGreen: boolean): NoteType | null {
	switch (eventType) {
		case eventTypes.redDrum:
			return noteTypes.redDrum
		case eventTypes.yellowDrum:
			return noteTypes.yellowDrum
		case eventTypes.blueDrum:
			return noteTypes.blueDrum
		case eventTypes.fiveOrangeFourGreenDrum:
			return noteTypes.greenDrum
		case eventTypes.fiveGreenDrum:
			return hasOrangeAndGreen ? noteTypes.blueDrum : noteTypes.greenDrum
		default:
			return null
	}
}

function getTomOrCymbalFlags(eventType: EventType, modifiers: EventType[], drumType: DrumType, format: 'chart' | 'mid') {
	switch (drumType) {
		case drumTypes.fourLane:
			return noteFlags.tom
		case drumTypes.fourLanePro:
			switch (format) {
				case 'mid':
					switch (eventType) {
						case eventTypes.redDrum:
							return noteFlags.tom
						case eventTypes.yellowDrum:
							return modifiers.includes(eventTypes.yellowTomMarker) ? noteFlags.tom : noteFlags.cymbal
						case eventTypes.blueDrum:
							return modifiers.includes(eventTypes.blueTomMarker) ? noteFlags.tom : noteFlags.cymbal
						case eventTypes.fiveOrangeFourGreenDrum:
							return modifiers.includes(eventTypes.greenTomMarker) ? noteFlags.tom : noteFlags.cymbal
						case eventTypes.fiveGreenDrum:
							return noteFlags.tom
						default:
							return noteFlags.none
					}
				case 'chart':
					switch (eventType) {
						case eventTypes.redDrum:
							return noteFlags.tom
						case eventTypes.yellowDrum:
							return modifiers.includes(eventTypes.yellowCymbalMarker) ? noteFlags.cymbal : noteFlags.tom
						case eventTypes.blueDrum:
							return modifiers.includes(eventTypes.blueCymbalMarker) ? noteFlags.cymbal : noteFlags.tom
						case eventTypes.fiveOrangeFourGreenDrum:
							return modifiers.includes(eventTypes.greenCymbalMarker) ? noteFlags.cymbal : noteFlags.tom
						case eventTypes.fiveGreenDrum:
							return noteFlags.tom
						default:
							return noteFlags.none
					}
				default:
					return noteFlags.none
			}
		case drumTypes.fiveLane:
			switch (eventType) {
				case eventTypes.redDrum:
					return noteFlags.tom
				case eventTypes.yellowDrum:
					return noteFlags.cymbal
				case eventTypes.blueDrum:
					return noteFlags.tom
				case eventTypes.fiveOrangeFourGreenDrum:
					return noteFlags.cymbal
				case eventTypes.fiveGreenDrum:
					return noteFlags.tom
				default:
					return noteFlags.none
			}
		default:
			return noteFlags.none
	}
}

function getGhostOrAccentFlags(eventType: EventType, modifiers: EventType[]) {
	switch (eventType) {
		case eventTypes.redDrum:
			return (
				modifiers.includes(eventTypes.redAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.redGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.yellowDrum:
			return (
				modifiers.includes(eventTypes.yellowAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.yellowGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.blueDrum:
			return (
				modifiers.includes(eventTypes.blueAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.blueGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.fiveOrangeFourGreenDrum:
			return (
				modifiers.includes(eventTypes.fiveOrangeFourGreenAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.fiveOrangeFourGreenGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.fiveGreenDrum:
			return (
				modifiers.includes(eventTypes.fiveGreenAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.fiveGreenGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.kick:
			return (
				modifiers.includes(eventTypes.kickAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.kickGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		case eventTypes.kick2x:
			return (
				modifiers.includes(eventTypes.kickAccent) ? noteFlags.accent
				: modifiers.includes(eventTypes.kickGhost) ? noteFlags.ghost
				: noteFlags.none
			)
		default:
			return noteFlags.none
	}
}

function resolveFretModifiers(
	trackEventGroups: TrackEvent[][],
	iniChartModifiers: IniChartModifiers,
	chartTicksPerBeat: number,
	format: 'chart' | 'mid',
): UntimedNoteEvent[][] {
	const hopoThresholdTicks =
		iniChartModifiers.hopo_frequency ||
		(iniChartModifiers.eighthnote_hopo ?
			Math.floor(1 + chartTicksPerBeat / 2)
		:	Math.floor(format === 'mid' ? 1 + chartTicksPerBeat / 3 : (65 / 192) * chartTicksPerBeat))

	const noteEventGroups: UntimedNoteEvent[][] = []

	let lastNotes: TrackEvent[] | null = null
	// trackEventGroups only contain notes and note modifiers
	for (let i = 0; i < trackEventGroups.length; i++) {
		const events = trackEventGroups[i]
		if (events.some(n => n.type === eventTypes.forceOpen)) {
			// Apply open modifier
			// Note: it's not possible for a forceOpen event to generate without there also being at least one playable note here
			const longestEvent = _.maxBy(
				events.filter(e => isFretNote(e.type)),
				e => e.length,
			)!
			_.remove(events, e => isFretNote(e.type) || e.type === eventTypes.forceOpen)
			longestEvent.type = eventTypes.open
			events.push(longestEvent)
		}
		const notes = events.filter(e => isFretNote(e.type))
		if (!notes.length) {
			continue // Skip any event groups with only modifiers
		}

		const isNaturalHopo =
			!!lastNotes &&
			notes[0].tick - lastNotes[0].tick <= hopoThresholdTicks &&
			!isFretChord(notes) &&
			!isSameFretNote(events, lastNotes) &&
			// This .mid exception is due to compatibility concerns with older games that primarily use .mid
			!(format === 'mid' && isFretChord(lastNotes) && isInFretNote(notes, lastNotes))
		const hasForceUnnatural = !!events.find(n => n.type === eventTypes.forceUnnatural)
		const forceResult =
			events.find(n => n.type === eventTypes.forceTap) ? noteFlags.tap
			: events.find(n => n.type === eventTypes.forceHopo) ? noteFlags.hopo
			: events.find(n => n.type === eventTypes.forceStrum) ? noteFlags.strum
			: (hasForceUnnatural && isNaturalHopo) || (!hasForceUnnatural && !isNaturalHopo) ? noteFlags.strum
			: noteFlags.hopo
		noteEventGroups.push(
			notes.map(n => ({
				tick: n.tick,
				length: n.length,
				type: getFretNoteTypeFromEventType(n.type)!, // Should be the only event types at this point
				flags: forceResult,
			})),
		)

		lastNotes = notes
	}

	return noteEventGroups
}

function isFretNote(type: EventType) {
	switch (type) {
		case eventTypes.open:
		case eventTypes.green:
		case eventTypes.red:
		case eventTypes.yellow:
		case eventTypes.blue:
		case eventTypes.orange:
		case eventTypes.black3:
		case eventTypes.black2:
		case eventTypes.black1:
		case eventTypes.white3:
		case eventTypes.white2:
		case eventTypes.white1:
			return true
		default:
			return false
	}
}

function isSameFretNote(note1: TrackEvent[], note2: TrackEvent[]) {
	for (const n1 of note1) {
		if (!isFretNote(n1.type)) {
			continue
		}

		for (const n2 of note2) {
			if (!isFretNote(n2.type)) {
				continue
			}

			if (n1.type !== n2.type) {
				return false
			}
		}
	}

	for (const n2 of note2) {
		if (!isFretNote(n2.type)) {
			continue
		}

		for (const n1 of note1) {
			if (!isFretNote(n1.type)) {
				continue
			}

			if (n2.type !== n1.type) {
				return false
			}
		}
	}

	return true
}

function isFretChord(note: TrackEvent[]) {
	let firstNoteType: EventType | null = null
	for (const n of note) {
		if (isFretNote(n.type)) {
			if (firstNoteType === null) {
				firstNoteType = n.type
			} else if (firstNoteType !== n.type) {
				return true
			}
		}
	}
	return false
}

function isInFretNote(inNote: TrackEvent[], outerNote: TrackEvent[]) {
	return (
		_.differenceBy(
			inNote.filter(n => isFretNote(n.type)),
			outerNote.filter(n => isFretNote(n.type)),
			note => note.type,
		).length === 0
	)
}

function getFretNoteTypeFromEventType(eventType: EventType): NoteType | null {
	switch (eventType) {
		case eventTypes.open:
			return noteTypes.open
		case eventTypes.green:
			return noteTypes.green
		case eventTypes.red:
			return noteTypes.red
		case eventTypes.yellow:
			return noteTypes.yellow
		case eventTypes.blue:
			return noteTypes.blue
		case eventTypes.orange:
			return noteTypes.orange
		case eventTypes.black3:
			return noteTypes.black3
		case eventTypes.black2:
			return noteTypes.black2
		case eventTypes.black1:
			return noteTypes.black1
		case eventTypes.white3:
			return noteTypes.white3
		case eventTypes.white2:
			return noteTypes.white2
		case eventTypes.white1:
			return noteTypes.white1
		default:
			return null
	}
}

function snapChords(noteGroups: UntimedNoteEvent[][], chord_snap_threshold: number, instrument: Instrument) {
	if (chord_snap_threshold <= 0 || noteGroups.length === 0) {
		return noteGroups
	}

	const newNoteGroups: UntimedNoteEvent[][] = [noteGroups[0]]

	for (let i = 1; i < noteGroups.length; i++) {
		const noteGroup = noteGroups[i]
		const lastNoteGroup = _.last(newNoteGroups)!

		if (noteGroup[0].tick - lastNoteGroup[0].tick >= chord_snap_threshold) {
			newNoteGroups.push(noteGroup)
		} else {
			// Resolve flag differences between the note groups
			if (instrument === 'drums') {
				for (const note of noteGroup) {
					if (note.type === noteTypes.kick) {
						const lastKickFlags = lastNoteGroup.find(n => n.type === noteTypes.kick)?.flags ?? null
						note.flags = lastKickFlags === null ? note.flags : lastKickFlags
					} else if (note.type === noteTypes.redDrum) {
						const lastRedDrumFlags = lastNoteGroup.find(n => n.type === noteTypes.redDrum)?.flags ?? null
						note.flags = lastRedDrumFlags === null ? note.flags : lastRedDrumFlags
					} else if (note.type === noteTypes.yellowDrum) {
						const lastYellowDrumFlags = lastNoteGroup.find(n => n.type === noteTypes.yellowDrum)?.flags ?? null
						note.flags = lastYellowDrumFlags === null ? note.flags : lastYellowDrumFlags
					} else if (note.type === noteTypes.blueDrum) {
						const lastBlueDrumFlags = lastNoteGroup.find(n => n.type === noteTypes.blueDrum)?.flags ?? null
						note.flags = lastBlueDrumFlags === null ? note.flags : lastBlueDrumFlags
					} else if (note.type === noteTypes.greenDrum) {
						const lastGreenDrumFlags = lastNoteGroup.find(n => n.type === noteTypes.greenDrum)?.flags ?? null
						note.flags = lastGreenDrumFlags === null ? note.flags : lastGreenDrumFlags
					}

					// Handle edge case with resolving disco and discoNoflip modifier differences on red and yellow drum notes
					if (note.type === noteTypes.redDrum || note.type === noteTypes.yellowDrum) {
						const lastRedDrumFlags = lastNoteGroup.find(n => n.type === noteTypes.redDrum)?.flags ?? null
						const lastYellowDrumFlags = lastNoteGroup.find(n => n.type === noteTypes.yellowDrum)?.flags ?? null
						if (lastRedDrumFlags !== null || lastYellowDrumFlags !== null) {
							const discoNoteFlags = noteFlags.disco | noteFlags.discoNoflip
							const lastDiscoEventFlags = ((lastRedDrumFlags ?? 0) | (lastYellowDrumFlags ?? 0)) & discoNoteFlags
							note.flags &= ~discoNoteFlags
							note.flags |= lastDiscoEventFlags
						}
					}
				}
			} else {
				const lastNoteGroupFlags = lastNoteGroup[0].flags
				noteGroup.forEach(n => (n.flags = lastNoteGroupFlags))
			}

			// Snap notes to previous note group (this can cause stacked notes, but that's resolved later)
			for (const note of noteGroup) {
				note.tick = lastNoteGroup[0].tick
				lastNoteGroup.push(note)
			}
		}
	}

	return newNoteGroups
}

function sortAndFixInvalidFlexLaneOverlaps(events: { tick: number; length: number; isDouble: boolean; msTime: number; msLength: number }[]) {
	events.sort((a, b) => {
		if (a.tick !== b.tick) {
			return a.tick - b.tick
		}
		if (a.isDouble !== b.isDouble) {
			return (a.isDouble ? 1 : 0) - (b.isDouble ? 1 : 0) // false first
		}
		return b.length - a.length // length descending (longest lane is kept for duplicates)
	})
	let removedEvents: { tick: number; length: number; isDouble: boolean; msTime: number; msLength: number }[] | null = null
	for (let i = 1; i < events.length; i++) {
		if (events[i].tick === events[i - 1].tick && events[i].isDouble === events[i - 1].isDouble) {
			;(removedEvents ??= []).push(events[i])
		}
	}

	if (removedEvents) {
		_.pullAll(events, removedEvents)
	}

	return events
}

function sortAndFixInvalidEventOverlaps(events: { tick: number; length: number; msTime: number; msLength: number }[]) {
	events.sort((a, b) => a.tick - b.tick || b.length - a.length) // Longest event is kept for duplicates
	let removedEvents: { tick: number; length: number; msTime: number; msLength: number }[] | null = null
	for (let i = 1; i < events.length; i++) {
		if (events[i].tick === events[i - 1].tick) {
			;(removedEvents ??= []).push(events[i])
		}
	}

	if (removedEvents) {
		_.pullAll(events, removedEvents)
	}

	let previousEvent: { tick: number; length: number; msTime: number; msLength: number } | null = null
	for (const event of events) {
		if (previousEvent && previousEvent.tick + previousEvent.length > event.tick) {
			event.length = Math.max(event.length, previousEvent.length - (event.tick - previousEvent.tick))
			event.msLength = Math.max(event.msLength, previousEvent.msLength - (event.msTime - previousEvent.msTime))
			previousEvent.length = event.tick - previousEvent.tick
			previousEvent.msLength = event.msTime - previousEvent.msTime
		}
		previousEvent = event
	}

	return events
}

function sortAndFixInvalidNoteOverlaps(noteGroups: UntimedNoteEvent[][]) {
	for (const noteGroup of noteGroups) {
		noteGroup.sort((a, b) => a.type - b.type || b.length - a.length || b.flags - a.flags) // Longest sustain is kept for duplicates
		let removedNotes: UntimedNoteEvent[] | null = null
		for (let i = 1; i < noteGroup.length; i++) {
			if (noteGroup[i].type === noteGroup[i - 1].type) {
				;(removedNotes ??= []).push(noteGroup[i])
			}
		}

		if (removedNotes) {
			_.pullAll(noteGroup, removedNotes)
		}
	}

	const previousNotesOfType = new Map<NoteType, UntimedNoteEvent>()
	for (const noteGroup of noteGroups) {
		for (const note of noteGroup) {
			const previousNoteOfType = previousNotesOfType.get(note.type)
			previousNotesOfType.set(note.type, note)
			if (previousNoteOfType && previousNoteOfType.tick + previousNoteOfType.length > note.tick) {
				note.length = Math.max(note.length, previousNoteOfType.length - (note.tick - previousNoteOfType.tick))
				previousNoteOfType.length = note.tick - previousNoteOfType.tick
			}
		}
	}
}
