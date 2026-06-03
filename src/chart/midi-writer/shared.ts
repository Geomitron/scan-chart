/**
 * Shared MIDI-writer plumbing: the absolute-tick event model, delta-time
 * finalization, note on/off emission, and small note-data helpers used by the
 * drum / fret / vocal / events emitters.
 */
import type { MidiEvent } from '@geomitron/midi-file'

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
export function finalizeMidiTrack(events: AbsoluteEvent[]): MidiEvent[] {
	const eventPriority = (e: MidiEvent): number => {
		switch (e.type) {
			case 'trackName': return 0
			case 'timeSignature': return 1
			case 'setTempo': return 2
			case 'noteOff': return 3
			case 'sysEx': case 'endSysEx': return 4
			case 'noteOn': return 5
			case 'text': case 'lyrics': return 6
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
): void {
	addNoteOnOffWithChannel(events, tick, length, noteNumber, velocity, 0, allowZeroLength)
}

export function addNoteOnOffWithChannel(
	events: AbsoluteEvent[],
	tick: number,
	length: number,
	noteNumber: number,
	velocity: number,
	channel: number,
	allowZeroLength = false,
): void {
	const effectiveLength = allowZeroLength ? length : Math.max(length, 1)
	if (allowZeroLength && effectiveLength === 0) {
		const onSeq = zeroLenSeq++
		const offSeq = zeroLenSeq++
		events.push({
			tick,
			seq: onSeq,
			event: noteOnEvent(noteNumber, velocity, channel),
		})
		events.push({
			tick,
			seq: offSeq,
			event: noteOffEvent(noteNumber, channel),
		})
		return
	}
	events.push({
		tick,
		event: noteOnEvent(noteNumber, velocity, channel),
	})
	events.push({
		tick: tick + effectiveLength,
		event: noteOffEvent(noteNumber, channel),
	})
}

/** Dedupe by (tick, length) — source may carry multi-difficulty duplicates. */
export function deduplicateSections<T extends { tick: number; length: number }>(sections: T[]): T[] {
	const seen = new Set<string>()
	const out: T[] = []
	for (const s of sections) {
		const key = `${s.tick}:${s.length}`
		if (!seen.has(key)) { seen.add(key); out.push(s) }
	}
	return out.sort((a, b) => a.tick - b.tick)
}

/**
 * Precompute length overrides to prevent scan-chart's `trimSustains` from
 * collapsing short-sustain note chains. When N same-type drum notes are
 * directly adjacent (tick[i] + length[i] === tick[i+1]), we attribute the
 * combined chain length to the first note and set subsequent ones to 0 so
 * the trim threshold doesn't bite.
 */
export function computeLengthOverrides(td: ParsedTrack): Map<string, number> {
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
		let i = 0
		while (i < notes.length) {
			let j = i
			let chainSum = notes[i].length
			while (j + 1 < notes.length
				&& notes[j].tick + notes[j].length === notes[j + 1].tick
				&& notes[j + 1].length > 0) {
				chainSum += notes[j + 1].length
				j++
			}
			if (j > i) {
				overrides.set(`${notes[i].tick}:${type}`, chainSum)
				for (let k = i + 1; k <= j; k++) overrides.set(`${notes[k].tick}:${type}`, 0)
			}
			i = j + 1
		}
	}
	return overrides
}
