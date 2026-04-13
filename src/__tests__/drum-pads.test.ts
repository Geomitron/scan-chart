/**
 * Tests for drum pad parsing across 4-lane, 4-lane-pro, and 5-lane drum types.
 *
 * The scan-chart parser has subtle rules for mapping MIDI drum notes (96–101)
 * to the public `noteTypes` enum depending on drumType:
 *
 *   - 4-lane / 4-lane-pro: MIDI 100 → greenDrum (4th lane)
 *   - 5-lane:              MIDI 100 → greenDrum with `cymbal` flag (orange, 4th lane)
 *                          MIDI 101 → greenDrum with `tom` flag (5th lane) if the
 *                                     chord does NOT also contain MIDI 100
 *                                   → blueDrum with `tom` flag (5th lane) if the
 *                                     chord DOES contain MIDI 100 (hasOrangeAndGreen)
 *
 * The scan-chart public `noteTypes` enum only has 4 drum slots (kick, redDrum,
 * yellowDrum, blueDrum, greenDrum), so 5-lane drums are represented ambiguously
 * and must be disambiguated by the `tom`/`cymbal` flag plus chord co-occurrence.
 *
 * These tests document and lock in that behavior so it round-trips correctly
 * through consumers like chart-edit's writer.
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from 'midi-file'
import { parseChartFile } from '../chart/notes-parser'
import { noteTypes, noteFlags } from '../chart/note-parsing-interfaces'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMidi(ticksPerBeat: number, tracks: MidiData['tracks']): Uint8Array {
	const data: MidiData = {
		header: { format: 1, numTracks: tracks.length, ticksPerBeat },
		tracks,
	}
	return new Uint8Array(writeMidi(data))
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

type TimedEvent = { absTick: number; event: MidiData['tracks'][number][number] }

/** Build a PART DRUMS track with notes at absolute ticks (delta-times computed automatically). */
function drumsTrack(opts: {
	notes: { tick: number; noteNumber: number; length?: number; velocity?: number }[]
}): MidiData['tracks'][number] {
	const track: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
	]
	const timed: TimedEvent[] = []
	for (const n of opts.notes) {
		const len = n.length ?? 0
		timed.push({
			absTick: n.tick,
			event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: n.noteNumber, velocity: n.velocity ?? 100 },
		})
		timed.push({
			absTick: n.tick + (len || 1),
			event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: n.noteNumber, velocity: 0 },
		})
	}
	timed.sort((a, b) => a.absTick - b.absTick)
	let prev = 0
	for (const te of timed) {
		te.event.deltaTime = te.absTick - prev
		prev = te.absTick
		track.push(te.event)
	}
	track.push({ deltaTime: 0, type: 'endOfTrack' })
	return track
}

/** Parse a drums-only MIDI with the given ini modifiers and return the expert track. */
function parseDrumsExpert(midi: Uint8Array, modifiers: { pro_drums?: boolean; five_lane_drums?: boolean } = {}) {
	const parsed = parseChartFile(midi, 'mid', modifiers)
	return parsed.trackData.find(t => t.instrument === 'drums' && t.difficulty === 'expert')!
}

/** Return chord at tick as array of {type, flags} (sorted by type for stable assertions). */
function chordAt(track: ReturnType<typeof parseDrumsExpert>, tick: number) {
	const group = track.noteEventGroups.find(g => g[0]?.tick === tick)
	if (!group) return null
	return group
		.map(n => ({ type: n.type, flags: n.flags }))
		.sort((a, b) => a.type - b.type || a.flags - b.flags)
}

// Drum expert base: drumsDiffStarts.expert = 96
const KICK = 96
const RED = 97
const YELLOW = 98
const BLUE = 99
const ORANGE_OR_GREEN = 100 // 4-lane green / 5-lane orange
const FIVE_GREEN = 101

// ---------------------------------------------------------------------------
// 4-lane drums
// ---------------------------------------------------------------------------

describe('MIDI: 4-lane drums pad mapping', () => {
	it('maps kick/red/yellow/blue/green to the 5 canonical noteTypes', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					{ tick: 480, noteNumber: KICK },
					{ tick: 960, noteNumber: RED },
					{ tick: 1440, noteNumber: YELLOW },
					{ tick: 1920, noteNumber: BLUE },
					{ tick: 2400, noteNumber: ORANGE_OR_GREEN },
				],
			}),
		])
		const track = parseDrumsExpert(midi) // no ini → default detection

		expect(chordAt(track, 480)).toEqual([{ type: noteTypes.kick, flags: noteFlags.none }])
		expect(chordAt(track, 960)).toEqual([{ type: noteTypes.redDrum, flags: noteFlags.tom }])
		expect(chordAt(track, 1440)).toEqual([{ type: noteTypes.yellowDrum, flags: noteFlags.tom }])
		expect(chordAt(track, 1920)).toEqual([{ type: noteTypes.blueDrum, flags: noteFlags.tom }])
		expect(chordAt(track, 2400)).toEqual([{ type: noteTypes.greenDrum, flags: noteFlags.tom }])
	})

	it('treats all non-kick drums as tom (no tom markers present)', () => {
		// 4-lane (pro_drums=false, no cymbal markers) marks every pad as tom.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					{ tick: 480, noteNumber: YELLOW },
					{ tick: 960, noteNumber: BLUE },
					{ tick: 1440, noteNumber: ORANGE_OR_GREEN },
				],
			}),
		])
		const track = parseDrumsExpert(midi)
		expect(chordAt(track, 480)).toEqual([{ type: noteTypes.yellowDrum, flags: noteFlags.tom }])
		expect(chordAt(track, 960)).toEqual([{ type: noteTypes.blueDrum, flags: noteFlags.tom }])
		expect(chordAt(track, 1440)).toEqual([{ type: noteTypes.greenDrum, flags: noteFlags.tom }])
	})
})

// ---------------------------------------------------------------------------
// 4-lane-pro drums
// ---------------------------------------------------------------------------

describe('MIDI: 4-lane-pro drums pad mapping', () => {
	it('marks yellow/blue/green as cymbal by default, tom with marker', () => {
		// Yellow tom marker = MIDI 110, blue = 111, green = 112. Without a
		// marker, yellow/blue/green default to cymbal in 4-lane-pro.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					// Unmarked yellow/blue/green → cymbal
					{ tick: 480, noteNumber: YELLOW },
					{ tick: 480, noteNumber: BLUE },
					{ tick: 480, noteNumber: ORANGE_OR_GREEN },
					// Marked yellow → tom (using a sustained yellowTomMarker)
					{ tick: 960, noteNumber: YELLOW },
					{ tick: 960, noteNumber: 110, length: 120 },
				],
			}),
		])
		const track = parseDrumsExpert(midi, { pro_drums: true })

		const chord480 = chordAt(track, 480)!
		expect(chord480).toContainEqual({ type: noteTypes.yellowDrum, flags: noteFlags.cymbal })
		expect(chord480).toContainEqual({ type: noteTypes.blueDrum, flags: noteFlags.cymbal })
		// In 4-lane-pro MIDI, green (MIDI 100) is also cymbal by default — only
		// becomes tom if a greenTomMarker range covers it.
		expect(chord480).toContainEqual({ type: noteTypes.greenDrum, flags: noteFlags.cymbal })

		// Yellow-tom-marker: the 110 note range covers the yellow at 960.
		expect(chordAt(track, 960)).toEqual([{ type: noteTypes.yellowDrum, flags: noteFlags.tom }])
	})
})

// ---------------------------------------------------------------------------
// 5-lane drums — the interesting cases
// ---------------------------------------------------------------------------

describe('MIDI: 5-lane drums pad mapping', () => {
	// The bug that motivated these tests: chord with MIDI 100 (orange) +
	// MIDI 101 (5L green) collapses to `greenDrum + blueDrum`, not two greens.
	// Consumers must be able to re-derive the MIDI note from the chord shape.

	it('MIDI 100 alone → orangeDrum with cymbal flag (4th pad)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({ notes: [{ tick: 480, noteNumber: ORANGE_OR_GREEN }] }),
		])
		const track = parseDrumsExpert(midi, { five_lane_drums: true })
		// In 5-lane, MIDI 100 is the orange pad (4th lane). The tom/cymbal
		// flag is cosmetic in 5-lane — pads don't have tom/cymbal semantics.
		expect(chordAt(track, 480)).toEqual([{ type: noteTypes.orangeDrum, flags: noteFlags.cymbal }])
	})

	it('MIDI 101 alone → greenDrum with tom flag (5th pad)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({ notes: [{ tick: 480, noteNumber: FIVE_GREEN }] }),
		])
		const track = parseDrumsExpert(midi, { five_lane_drums: true })
		// In 5-lane, MIDI 101 is the green pad (5th lane). Always greenDrum,
		// regardless of what else is in the chord.
		expect(chordAt(track, 480)).toEqual([{ type: noteTypes.greenDrum, flags: noteFlags.tom }])
	})

	it('MIDI 99 alone → blueDrum with tom flag (blue pad)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({ notes: [{ tick: 480, noteNumber: BLUE }] }),
		])
		const track = parseDrumsExpert(midi, { five_lane_drums: true })
		expect(chordAt(track, 480)).toEqual([{ type: noteTypes.blueDrum, flags: noteFlags.tom }])
	})

	it('MIDI 99 + 101 chord (blue + 5L green, no orange) → blueDrum + greenDrum', () => {
		// Blue + 5L-green chord. With the new noteType split, the output is
		// unambiguous — no dependence on chord composition.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					{ tick: 480, noteNumber: BLUE },
					{ tick: 480, noteNumber: FIVE_GREEN },
				],
			}),
		])
		const track = parseDrumsExpert(midi, { five_lane_drums: true })
		expect(chordAt(track, 480)).toEqual([
			{ type: noteTypes.blueDrum, flags: noteFlags.tom },
			{ type: noteTypes.greenDrum, flags: noteFlags.tom },
		])
	})

	it('MIDI 99 + 100 chord (blue + orange) → blueDrum + orangeDrum (Avenged Sevenfold regression)', () => {
		// Avenged Sevenfold - Scream (Neversoft) has this chord pattern.
		// Before the orangeDrum split, scan-chart mapped MIDI 100 to greenDrum
		// and could not distinguish {MIDI 99 + MIDI 100} from {MIDI 100 + MIDI 101}.
		// Now the output is {blueDrum, orangeDrum} — cleanly distinct from
		// {orangeDrum, greenDrum} (which would be the Ben Harper chord).
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					{ tick: 480, noteNumber: BLUE },
					{ tick: 480, noteNumber: ORANGE_OR_GREEN },
				],
			}),
		])
		const track = parseDrumsExpert(midi, { five_lane_drums: true })
		expect(chordAt(track, 480)).toEqual([
			{ type: noteTypes.blueDrum, flags: noteFlags.tom },
			{ type: noteTypes.orangeDrum, flags: noteFlags.cymbal },
		])
	})

	it('MIDI 100 + 101 chord (orange + 5L green, no blue) → orangeDrum + greenDrum (Ben Harper regression)', () => {
		// Ben Harper - Number with No Name (Neversoft) activator chord.
		// Previously collapsed into {greenDrum(cymbal), blueDrum(tom)} via the
		// hasOrangeAndGreen rule. Now output is {orangeDrum, greenDrum} — no
		// collision with the Avenged Sevenfold {blueDrum, orangeDrum} chord.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					{ tick: 480, noteNumber: ORANGE_OR_GREEN },
					{ tick: 480, noteNumber: FIVE_GREEN },
				],
			}),
		])
		const track = parseDrumsExpert(midi, { five_lane_drums: true })
		// Sorted by type asc: greenDrum (17) before orangeDrum (18)
		expect(chordAt(track, 480)).toEqual([
			{ type: noteTypes.greenDrum, flags: noteFlags.tom },
			{ type: noteTypes.orangeDrum, flags: noteFlags.cymbal },
		])
	})

	it('star-power activator chord with kick + orange + 5L green (Ben Harper full regression)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					{ tick: 480, noteNumber: KICK },
					{ tick: 480, noteNumber: ORANGE_OR_GREEN },
					{ tick: 480, noteNumber: FIVE_GREEN },
				],
			}),
		])
		const track = parseDrumsExpert(midi, { five_lane_drums: true })
		// Sorted by type asc: kick(13) < greenDrum(17) < orangeDrum(18)
		expect(chordAt(track, 480)).toEqual([
			{ type: noteTypes.kick, flags: noteFlags.none },
			{ type: noteTypes.greenDrum, flags: noteFlags.tom },
			{ type: noteTypes.orangeDrum, flags: noteFlags.cymbal },
		])
	})

	it('full 5-lane chord with all 5 pads at distinct ticks', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					{ tick: 480, noteNumber: RED },
					{ tick: 960, noteNumber: YELLOW },
					{ tick: 1440, noteNumber: BLUE },
					{ tick: 1920, noteNumber: ORANGE_OR_GREEN }, // 5L orange
					{ tick: 2400, noteNumber: FIVE_GREEN }, // 5L green
				],
			}),
		])
		const track = parseDrumsExpert(midi, { five_lane_drums: true })
		expect(chordAt(track, 480)).toEqual([{ type: noteTypes.redDrum, flags: noteFlags.tom }])
		expect(chordAt(track, 960)).toEqual([{ type: noteTypes.yellowDrum, flags: noteFlags.cymbal }])
		expect(chordAt(track, 1440)).toEqual([{ type: noteTypes.blueDrum, flags: noteFlags.tom }])
		expect(chordAt(track, 1920)).toEqual([{ type: noteTypes.orangeDrum, flags: noteFlags.cymbal }])
		expect(chordAt(track, 2400)).toEqual([{ type: noteTypes.greenDrum, flags: noteFlags.tom }])
	})

	it('detects 5-lane automatically when MIDI 101 is present (no ini hint)', () => {
		// Without five_lane_drums or pro_drums in the ini, scan-chart falls
		// through to "5-lane if any fiveGreenDrum event exists". This test
		// locks in that auto-detection path.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					{ tick: 480, noteNumber: YELLOW },
					{ tick: 960, noteNumber: FIVE_GREEN },
				],
			}),
		])
		const track = parseDrumsExpert(midi)
		// In 5-lane mode, yellow is cymbal.
		expect(chordAt(track, 480)).toEqual([{ type: noteTypes.yellowDrum, flags: noteFlags.cymbal }])
		// fiveGreenDrum alone → greenDrum + tom.
		expect(chordAt(track, 960)).toEqual([{ type: noteTypes.greenDrum, flags: noteFlags.tom }])
	})

	it('duplicate noteOn while sustain is already open is dropped (Battles regression)', () => {
		// Regression for "Battles - Atlas (Dichotic)" — a MIDI file with
		// back-to-back sustained drum notes writes the new noteOn BEFORE the
		// previous sustain's noteOff at the same tick. YARG.Core's MidReader
		// drops the duplicate noteOn (TryFindMatchingNote), and scan-chart
		// must match: otherwise a phantom note appears at the tick where the
		// sustain ends.
		//
		// We craft: kick at tick 960, green (MIDI 100) sustained 480→960,
		// then a *new* noteOn 100 at tick 960 before the noteOff 100.
		const track: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
			// Previous sustain started at tick 480
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
			// At tick 960: noteOn (duplicate), then noteOff (closes the 480 sustain)
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
			{ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
		const parsed = parseDrumsExpert(midi, { pro_drums: true })

		// Tick 480 → the sustained green closed at 960
		const g480 = parsed.noteEventGroups.find(g => g[0].tick === 480)!
		expect(g480).toHaveLength(1)
		expect(g480[0].type).toBe(noteTypes.greenDrum)
		expect(g480[0].length).toBe(480)

		// Tick 960 → kick only (the duplicate noteOn 100 was dropped). Without
		// the dedup fix, scan-chart would emit a phantom green drum here.
		const g960 = parsed.noteEventGroups.find(g => g[0].tick === 960)!
		expect(g960).toHaveLength(1)
		expect(g960[0].type).toBe(noteTypes.kick)
	})

	it('prefers ini pro_drums over automatic 5-lane detection', () => {
		// If both ini says pro_drums=true AND chart has fiveGreenDrum events,
		// the ini wins and we get 4-lane-pro semantics (no 5th lane).
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			drumsTrack({
				notes: [
					{ tick: 480, noteNumber: YELLOW },
					{ tick: 960, noteNumber: FIVE_GREEN },
				],
			}),
		])
		const track = parseDrumsExpert(midi, { pro_drums: true })
		// In 4-lane-pro, unmarked yellow is cymbal.
		expect(chordAt(track, 480)).toEqual([{ type: noteTypes.yellowDrum, flags: noteFlags.cymbal }])
		// fiveGreenDrum in 4-lane-pro still maps to greenDrum with tom flag.
		expect(chordAt(track, 960)).toEqual([{ type: noteTypes.greenDrum, flags: noteFlags.tom }])
	})
})
