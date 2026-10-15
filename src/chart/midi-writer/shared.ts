/**
 * Shared MIDI-writer plumbing: the absolute-tick event model, delta-time
 * finalization, note on/off emission, and small note-data helpers used by the
 * drum / fret / vocal / events emitters.
 */
import type { MidiEvent } from '@geomitron/midi-file'

import type { Difficulty } from '../../types'
import type { NoteType } from '../types'
import type { ParsedChart } from '../parse-chart-and-ini'

export type ParsedTrack = ParsedChart['trackData'][number]

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------
//
// midi-file's `MidiEvent` is a wide discriminated union, so constructing a
// specific variant from an object literal requires a cast. These builders
// localize that cast to one spot per event kind and remove the repeated
// `{ deltaTime: 0, meta: true, type: ... }` boilerplate at call sites.

/** Meta text event (`FF 01`). */
export const metaTextEvent = (text: string): MidiEvent => ({ deltaTime: 0, meta: true, type: 'text', text } as MidiEvent)
/** Meta track-name event (`FF 03`). */
export const trackNameEvent = (text: string): MidiEvent => ({ deltaTime: 0, meta: true, type: 'trackName', text } as MidiEvent)
/** Meta lyric event (`FF 05`). */
export const lyricsEvent = (text: string): MidiEvent => ({ deltaTime: 0, meta: true, type: 'lyrics', text } as MidiEvent)
/** Channel `noteOn`. */
export const noteOnEvent = (noteNumber: number, velocity: number, channel = 0): MidiEvent =>
	({ deltaTime: 0, channel, type: 'noteOn', noteNumber, velocity } as MidiEvent)
/** Channel `noteOff` (velocity 0). */
export const noteOffEvent = (noteNumber: number, channel = 0): MidiEvent =>
	({ deltaTime: 0, channel, type: 'noteOff', noteNumber, velocity: 0 } as MidiEvent)

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A MIDI event tagged with its absolute tick (for sort-then-delta finalization). */
export interface AbsoluteEvent {
	tick: number
	event: MidiEvent
	/** Stable sort tiebreaker — preserves source ordering within the same tick. */
	seq?: number
	/** On a note-on, its note-off, when the two were written together. */
	pairOff?: AbsoluteEvent
	/** On a note-on, that it's a gameplay note written at zero length, which `stretchUnsustainedNotes` may lengthen. */
	unsustained?: true
}

/**
 * How the encoder writes what 8.x's writer wrote differently (r4 Q4 and Q5). Each defaults to 8.x's behavior, which
 * the same-format round trip tests keep.
 */
export interface MidiWriteOptions {
	/** Each instrument's phrases from its Expert track, or its hardest when it has none, rather than every difficulty's. */
	readonly phrasesFromExpert?: boolean
	/** Zero-length phrases at zero length, rather than widened to a tick. */
	readonly zeroLengthPhrases?: boolean
	/**
	 * The sustain cutoff the file will be read with. An unsustained note is then written as long as it can be and still
	 * read as unsustained: the cutoff, or a tick before the next note of its pitch.
	 */
	readonly sustainCutoff?: number
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Sort events by absolute tick (with a type-priority tiebreaker) and convert
 * to delta-time encoding. Appends an `endOfTrack` meta event.
 *
 * Sort priority at the same tick: trackName → timeSignature → setTempo →
 * noteOff → sysEx → noteOn → text/lyrics → other → endOfTrack. This matches
 * Clone Hero's expected event ordering. Events with an explicit `seq` tag
 * sort AFTER untagged events at the same tick (so instrument-track emitters
 * can sequence paired events deterministically via `seq`).
 */
const modeEvents = new Set(['[ENABLE_CHART_DYNAMICS]', 'ENABLE_CHART_DYNAMICS', '[ENHANCED_OPENS]', 'ENHANCED_OPENS'])

export function finalizeMidiTrack(events: AbsoluteEvent[]): MidiEvent[] {
	const eventPriority = (e: MidiEvent): number => {
		switch (e.type) {
			case 'trackName': return 0
			case 'timeSignature': return 1
			case 'setTempo': return 2
			case 'noteOff': return 3
			case 'sysEx': case 'endSysEx': return 4
			case 'noteOn': return 5
			// A track's mode events apply only to the notes after them, so they follow the track name.
			case 'text': return modeEvents.has(e.text) ? 0.5 : 6
			case 'lyrics': return 6
			case 'endOfTrack': return 8
			default: return 7
		}
	}
	events.sort((a, b) => {
		if (a.tick !== b.tick) return a.tick - b.tick
		const aHasSeq = a.seq !== undefined
		const bHasSeq = b.seq !== undefined
		if (!aHasSeq && !bHasSeq) return eventPriority(a.event) - eventPriority(b.event)
		if (!aHasSeq) return -1
		if (!bHasSeq) return 1
		return (a.seq as number) - (b.seq as number)
	})

	let prevTick = 0
	const midiEvents: MidiEvent[] = []
	for (const { tick, event } of events) {
		event.deltaTime = tick - prevTick
		prevTick = tick
		midiEvents.push(event)
	}

	midiEvents.push({ deltaTime: 0, meta: true, type: 'endOfTrack' } as MidiEvent)
	return midiEvents
}

// ---------------------------------------------------------------------------
// Shared note / section helpers
// ---------------------------------------------------------------------------

/**
 * Monotonic counter used to seq-number zero-length noteOn/noteOff pairs so
 * their ordering survives `finalizeMidiTrack`'s event-priority sort. Without
 * explicit seq, the sort places noteOff BEFORE noteOn (noteOff has lower
 * priority), producing a bogus zero-length sequence that scan-chart re-parses
 * into extended sustains.
 */
let zeroLenSeq = 1_000_000

export function addNoteOnOff(
	events: AbsoluteEvent[],
	tick: number,
	length: number,
	noteNumber: number,
	velocity: number,
	allowZeroLength = false,
	unsustained = false,
): void {
	addNoteOnOffWithChannel(events, tick, length, noteNumber, velocity, 0, allowZeroLength, unsustained)
}

export function addNoteOnOffWithChannel(
	events: AbsoluteEvent[],
	tick: number,
	length: number,
	noteNumber: number,
	velocity: number,
	channel: number,
	allowZeroLength = false,
	unsustained = false,
): void {
	const effectiveLength = allowZeroLength ? length : Math.max(length, 1)
	if (allowZeroLength && effectiveLength === 0) {
		const off: AbsoluteEvent = { tick, seq: zeroLenSeq + 1, event: noteOffEvent(noteNumber, channel) }
		events.push({ tick, seq: zeroLenSeq, event: noteOnEvent(noteNumber, velocity, channel), pairOff: off, ...(unsustained ? { unsustained: true as const } : {}) })
		events.push(off)
		zeroLenSeq += 2
		return
	}
	const off: AbsoluteEvent = { tick: tick + effectiveLength, event: noteOffEvent(noteNumber, channel) }
	events.push({ tick, event: noteOnEvent(noteNumber, velocity, channel), pairOff: off })
	events.push(off)
}

/**
 * Lengthens each gameplay note written at zero length to the longest length still read as unsustained (r4 Q5): the
 * sustain cutoff, or a tick before the next note of its pitch. A note inside a sustain of its pitch is a zero-length
 * link of back-to-back sustains (`computeLengthOverrides`), and stays at zero length.
 */
export function stretchUnsustainedNotes(events: AbsoluteEvent[], cutoff: number): void {
	const notesByPitch = new Map<number, AbsoluteEvent[]>()
	for (const event of events) {
		if (event.event.type !== 'noteOn' || event.pairOff === undefined) continue
		const pitch = event.event.channel * 128 + event.event.noteNumber
		const notes = notesByPitch.get(pitch)
		if (notes === undefined) notesByPitch.set(pitch, [event])
		else notes.push(event)
	}
	for (const notes of notesByPitch.values()) {
		notes.sort((a, b) => a.tick - b.tick)
		let coveredUntil = -1
		notes.forEach((note, index) => {
			const isLink = coveredUntil > note.tick
			coveredUntil = Math.max(coveredUntil, note.pairOff!.tick)
			if (!note.unsustained || isLink) return
			const next = notes.slice(index + 1).find(other => other.tick > note.tick)
			const length = Math.min(cutoff, (next?.tick ?? Infinity) - note.tick - 1)
			if (length <= 0) return
			note.pairOff!.tick = note.tick + length
			// Once the note-off is on a later tick, it sorts like any other.
			delete note.pairOff!.seq
			coveredUntil = Math.max(coveredUntil, note.pairOff!.tick)
		})
	}
}

/** The first sequence number of verbatim events, after every other one. */
const verbatimSeq = 4_000_000_000

/**
 * Adds events kept verbatim, each at its tick (its `deltaTime`), in their order, after the events written from the
 * chart at that tick. A note-off that ends a note begun at an earlier tick, paired as Clone Hero pairs them (the latest
 * open note of its pitch and channel), instead sorts with the other note-offs, before any note-on of its tick.
 */
export function addVerbatimEvents(events: AbsoluteEvent[], verbatim: readonly MidiEvent[]): void {
	const openNoteTicks = new Map<number, number[]>()
	verbatim.forEach((source, index) => {
		const tick = source.deltaTime
		const event = { ...source, deltaTime: 0 } as MidiEvent
		if (event.type === 'noteOn' || event.type === 'noteOff') {
			const pitch = event.channel * 128 + event.noteNumber
			const openTicks = openNoteTicks.get(pitch) ?? []
			openNoteTicks.set(pitch, openTicks)
			if (event.type === 'noteOn' && event.velocity > 0) {
				openTicks.push(tick)
			} else if (openTicks.length > 0 && openTicks.pop()! < tick) {
				events.push({ tick, event })
				return
			}
		}
		events.push({ tick, seq: verbatimSeq + index, event })
	})
}

/**
 * Adds an instrument's lanes (126 single, 127 double) from its difficulty tracks. A lane on several difficulties is
 * written once, with the velocity of the easiest of them, which the reader turns back into the difficulties it applies
 * to (`fixFlexLaneLds`). Written with `addNoteOnOff`, a lane that ends where another of its number starts ends first.
 */
export function addFlexLanes(events: AbsoluteEvent[], tracks: readonly ParsedTrack[]): void {
	const velocities = new Map<string, number>()
	for (const track of tracks) {
		for (const lane of track.flexLanes) {
			const key = `${lane.tick}:${lane.length}:${lane.isDouble ? 127 : 126}`
			const velocity = laneVelocities[track.difficulty]
			const existing = velocities.get(key)
			if (existing === undefined || velocity < existing) velocities.set(key, velocity)
		}
	}
	for (const [key, velocity] of velocities) {
		const [tick, length, noteNumber] = key.split(':').map(Number)
		addNoteOnOff(events, tick, length, noteNumber, velocity, true)
	}
}

/** The lane velocity each difficulty writes, within the range the reader keeps for it. */
const laneVelocities: Record<Difficulty, number> = { easy: 25, medium: 35, hard: 45, expert: 100 }

/** Adds an instrument track's versus phrases: player 1's on note 105 and player 2's on 106. A zero-length one is kept. */
export function addVersusPhrases(events: AbsoluteEvent[], versusPhrases: ParsedTrack['versusPhrases']): void {
	for (const phrase of versusPhrases) addNoteOnOff(events, phrase.tick, phrase.length, phrase.isPlayer2 ? 106 : 105, 100, true)
}

/** The phrases a MIDI track holds for an instrument, from its difficulty tracks, as `options` asks (r4 Q4). */
export function instrumentSections<T extends { tick: number; length: number }>(
	tracks: readonly { difficulty: string }[],
	perDifficulty: readonly (readonly T[])[],
	options: MidiWriteOptions,
): T[] {
	if (!options.phrasesFromExpert) return mergeDifficultySections(perDifficulty)
	const index = ['expert', 'hard', 'medium', 'easy'].map(difficulty => tracks.findIndex(track => track.difficulty === difficulty)).find(found => found !== -1)
	return index === undefined ? [] : mergeDifficultySections([perDifficulty[index] ?? []])
}

/**
 * Merges each difficulty's phrases into the one list a MIDI track holds for the instrument. A phrase on several
 * difficulties is written once, and a phrase a difficulty has twice is written twice, so it reads back twice.
 */
export function mergeDifficultySections<T extends { tick: number; length: number }>(perDifficulty: readonly (readonly T[])[]): T[] {
	const merged = new Map<string, { section: T; count: number }>()
	for (const sections of perDifficulty) {
		const counts = new Map<string, number>()
		for (const section of sections) {
			const key = `${section.tick}:${section.length}`
			const count = (counts.get(key) ?? 0) + 1
			counts.set(key, count)
			const entry = merged.get(key)
			if (entry === undefined) merged.set(key, { section, count })
			else entry.count = Math.max(entry.count, count)
		}
	}
	return [...merged.values()].flatMap(({ section, count }) => Array<T>(count).fill(section)).sort((a, b) => a.tick - b.tick)
}

/**
 * The sustain cutoff the written file will be read with: `options.sustainCutoff`, or else the chart's song.ini setting,
 * or `.mid`'s default when it sets none.
 */
export function computeSustainCutoff(chart: ParsedChart, options: MidiWriteOptions): number {
	if (options.sustainCutoff !== undefined) return options.sustainCutoff
	const setCutoff = chart.iniChartModifiers.sustain_cutoff_threshold
	return setCutoff >= 0 ? setCutoff : Math.floor(chart.resolution / 3) + 1
}

/**
 * Length overrides for runs of back-to-back notes of one type (`tick[i] + length[i] === tick[i + 1]`) that the sustain
 * cutoff would otherwise cut. Each note is written with its own note-off, before the next note-on, except in a run
 * where a sustain is at or below `cutoff`, which the overlap step left and which would read back as no sustain: that
 * run is written as its first note sustained over the whole run, with each later note a zero-length link, so the
 * overlap step gives every note its length back.
 */
export function computeLengthOverrides(td: ParsedTrack, cutoff: number): Map<string, number> {
	const overrides = new Map<string, number>()
	const byType = new Map<NoteType, { tick: number; length: number }[]>()
	for (const g of td.noteEventGroups) {
		for (const n of g) {
			let arr = byType.get(n.type)
			if (!arr) { arr = []; byType.set(n.type, arr) }
			arr.push({ tick: n.tick, length: n.length })
		}
	}
	for (const [type, notes] of byType) {
		notes.sort((a, b) => a.tick - b.tick)
		const isCut = (length: number) => length > 0 && length <= cutoff
		let i = 0
		while (i < notes.length) {
			let j = i
			let chainSum = notes[i].length
			let anyCut = isCut(notes[i].length)
			while (j + 1 < notes.length
				&& notes[j].tick + notes[j].length === notes[j + 1].tick
				&& notes[j + 1].length > 0) {
				chainSum += notes[j + 1].length
				j++
				anyCut ||= isCut(notes[j].length)
			}
			if (j > i && anyCut && chainSum > cutoff) {
				overrides.set(`${notes[i].tick}:${type}`, chainSum)
				for (let k = i + 1; k <= j; k++) overrides.set(`${notes[k].tick}:${type}`, 0)
			}
			i = j + 1
		}
	}
	return overrides
}
