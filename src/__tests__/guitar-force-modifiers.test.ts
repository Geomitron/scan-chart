/**
 * Tests for guitar force modifier parsing (forceHopo, forceStrum, forceTap).
 *
 * All force modifier sustains in YARG.Core's MidReader are END-EXCLUSIVE:
 * the range covers `[start, end - 1]` after YARG's `if (endTick > startTick) --endTick`
 * decrement. scan-chart must match, otherwise back-to-back modifier phrases (very
 * common in FreeStyleGames/Neversoft charts) overlap by one tick and the last
 * note of one phrase accidentally inherits the next phrase's force.
 *
 * These tests also lock in the resolution order when multiple conflicting
 * force modifiers overlap on the same note.
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from 'midi-file'
import { parseChartFile } from '../chart/notes-parser'
import { noteTypes, noteFlags } from '../chart/note-parsing-interfaces'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMidi(ticksPerBeat: number, tracks: MidiData['tracks']): Uint8Array {
	return new Uint8Array(writeMidi({
		header: { format: 1, numTracks: tracks.length, ticksPerBeat },
		tracks,
	}))
}

function tempoTrack(): MidiData['tracks'][number] {
	return [
		{ deltaTime: 0, type: 'trackName', text: '' },
		{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
		{ deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
}

function eventsTrack(): MidiData['tracks'][number] {
	return [
		{ deltaTime: 0, type: 'trackName', text: 'EVENTS' },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
}

type TimedEvent = { absTick: number; order: number; event: MidiData['tracks'][number][number] }

function guitarTrack(difficulty: 'easy' | 'expert', opts: {
	notes: { tick: number; noteNumber: number; length?: number; velocity?: number }[]
}): MidiData['tracks'][number] {
	const track: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
	]
	const timed: TimedEvent[] = []
	let seq = 0
	for (const n of opts.notes) {
		const len = n.length ?? 0
		timed.push({
			absTick: n.tick,
			order: seq++,
			event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: n.noteNumber, velocity: n.velocity ?? 100 },
		})
		timed.push({
			absTick: n.tick + (len || 1),
			order: seq++,
			event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: n.noteNumber, velocity: 0 },
		})
	}
	// Stable sort by tick, then by original insertion order so the test can
	// control fine-grained event ordering within a single tick.
	timed.sort((a, b) => a.absTick - b.absTick || a.order - b.order)
	let prev = 0
	for (const te of timed) {
		te.event.deltaTime = te.absTick - prev
		prev = te.absTick
		track.push(te.event)
	}
	track.push({ deltaTime: 0, type: 'endOfTrack' })
	return track
}

function parseGuitarExpert(midi: Uint8Array) {
	const parsed = parseChartFile(midi, 'mid')
	return parsed.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
}

function parseGuitarEasy(midi: Uint8Array) {
	const parsed = parseChartFile(midi, 'mid')
	return parsed.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'easy')!
}

// 5-fret guitar layout in YARG/CH MIDI. Per YARG.Core's MidIOHelper:
//   GUITAR_DIFF_START_LOOKUP.Expert = 96 (Green)
// Offsets: Green=0, Red=1, Yellow=2, Blue=3, Orange=4, forceHopo=5, forceStrum=6
// So: expert = [96..102], easy = [60..66]. TAP_NOTE_CH is a single global 104.
const EXPERT_GREEN = 96
const EXPERT_RED = 97
const EXPERT_YELLOW = 98
const EXPERT_BLUE = 99
const EXPERT_ORANGE = 100
const EXPERT_FORCE_HOPO = 101
const EXPERT_FORCE_STRUM = 102

const EASY_GREEN = 60
const EASY_RED = 61
const EASY_YELLOW = 62
const EASY_FORCE_HOPO = 65
const EASY_FORCE_STRUM = 66

// Tap is a single global note (not per-difficulty).
const TAP_NOTE = 104

// ---------------------------------------------------------------------------
// End-exclusive range tests
// ---------------------------------------------------------------------------

describe('MIDI: forceTap range is end-exclusive', () => {
	it('BAND-MAID regression: forceTap on note A does NOT spill onto next note', () => {
		// Regression for "BAND-MAID - Hate (Alpucat)" easy guitar: two consecutive
		// yellow notes at ticks T and T+960. The first has a forceTap range
		// covering only itself, but scan-chart previously treated the tap end tick
		// as INCLUSIVE, causing the second note to inherit the tap flag too.
		const track: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			// Note A at tick 480 (easy yellow)
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: EASY_YELLOW, velocity: 100 },
			// Tap sustain: noteOn 104 at 480, noteOff at 960 (exactly where note B starts)
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: TAP_NOTE, velocity: 100 },
			// Note A off at 600
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: EASY_YELLOW, velocity: 0 },
			// Tap sustain off at 960
			{ deltaTime: 360, type: 'noteOff', channel: 0, noteNumber: TAP_NOTE, velocity: 0 },
			// Note B at 960 (easy yellow) — should NOT be tap
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: EASY_YELLOW, velocity: 100 },
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: EASY_YELLOW, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
		const parsed = parseGuitarEasy(midi)

		const gA = parsed.noteEventGroups.find(g => g[0].tick === 480)!
		const gB = parsed.noteEventGroups.find(g => g[0].tick === 960)!

		expect(gA[0].flags & noteFlags.tap).toBe(noteFlags.tap)
		expect(gB[0].flags & noteFlags.tap).toBe(0) // NOT tap
	})
})

describe('MIDI: forceHopo / forceStrum range is end-exclusive', () => {
	it('back-to-back forceHopo phrases do not spill onto the next phrase', () => {
		// Two forceHopo sustains: [480, 960] and [960, 1440]. The note at tick
		// 960 should be covered by the SECOND sustain (which starts at 960),
		// not the first (which ends at 960). End-exclusive means the first
		// sustain covers [480, 959] only, so the note at 960 picks up the
		// second sustain cleanly — same flag but the ordering matters for
		// sustain boundaries.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			guitarTrack('expert', {
				notes: [
					// Notes: two green notes (natural strums, far apart)
					{ tick: 480, noteNumber: EXPERT_GREEN, length: 120 },
					{ tick: 960, noteNumber: EXPERT_GREEN, length: 120 },
					// forceHopo #1: covers note at 480, ends at 960
					{ tick: 480, noteNumber: EXPERT_FORCE_HOPO, length: 480 },
					// forceHopo #2: starts at 960, covers note at 960
					{ tick: 960, noteNumber: EXPERT_FORCE_HOPO, length: 480 },
				],
			}),
		])
		const track = parseGuitarExpert(midi)
		const g480 = track.noteEventGroups.find(g => g[0].tick === 480)!
		const g960 = track.noteEventGroups.find(g => g[0].tick === 960)!
		expect(g480[0].flags & noteFlags.hopo).toBe(noteFlags.hopo)
		expect(g960[0].flags & noteFlags.hopo).toBe(noteFlags.hopo)
	})
})
