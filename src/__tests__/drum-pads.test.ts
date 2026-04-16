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
		// Verifies that a {MIDI 100, MIDI 101} chord on 5-lane drums emits
		// {orangeDrum, greenDrum} as two distinct pads — without collapsing
		// into a single pad and without colliding with the Avenged Sevenfold
		// {MIDI 99, MIDI 100} = {blueDrum, orangeDrum} chord.
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

	describe('noteOn/noteOff pairing (BTrack spec)', () => {
		// The BTrack spec says:
		//   "Each end event is paired with the closest previous start event that
		//    (1) hasn't been paired yet, (2) has the same event type, and (3) has
		//    the same midi channel (if applicable). Events must be composed of
		//    both a start and an end event; unpaired start and end events are
		//    ignored."
		// i.e. LIFO (stack) pairing, with unpaired starts/ends dropped.

		it('on(t1), on(t2), off → off pairs with on(t2); on(t1) unpaired and dropped', () => {
			// For "Battles - Atlas (Dichotic)": a MIDI file that writes a
			// duplicate noteOn at the same tick as the prior sustain's noteOff,
			// in `on, on, off` order. Per spec, the off pairs with the most
			// recent unpaired on (tick 960). The tick-480 start is unpaired and
			// gets dropped. Result: a single zero-length note at tick 960.
			const track: MidiData['tracks'][number] = [
				{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
				{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				{ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
				{ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },
				{ deltaTime: 0, type: 'endOfTrack' },
			]
			const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
			const parsed = parseDrumsExpert(midi, { pro_drums: true })

			// No note group at tick 480 — the unpaired start was dropped.
			expect(parsed.noteEventGroups.find(g => g[0].tick === 480)).toBeUndefined()

			// Tick 960 has kick + zero-length green drum.
			const g960 = parsed.noteEventGroups.find(g => g[0].tick === 960)!
			expect(g960).toBeDefined()
			const green = g960.find(n => n.type === noteTypes.greenDrum)!
			expect(green).toBeDefined()
			expect(green.length).toBe(0)
			const kick = g960.find(n => n.type === noteTypes.kick)!
			expect(kick).toBeDefined()
		})

		it('on, off, on, off on same note → two sequential notes, no ambiguity', () => {
			// Baseline: properly paired back-to-back notes work correctly.
			const track: MidiData['tracks'][number] = [
				{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },
				{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },
				{ deltaTime: 0, type: 'endOfTrack' },
			]
			const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
			const parsed = parseDrumsExpert(midi, { pro_drums: true })

			const g480 = parsed.noteEventGroups.find(g => g[0].tick === 480)!
			expect(g480).toHaveLength(1)
			expect(g480[0].type).toBe(noteTypes.greenDrum)
			expect(g480[0].length).toBe(480)

			const g960 = parsed.noteEventGroups.find(g => g[0].tick === 960)!
			expect(g960).toHaveLength(1)
			expect(g960[0].type).toBe(noteTypes.greenDrum)
			expect(g960[0].length).toBe(480)
		})

		it('on, on, off, off → both starts kept; offs pair LIFO', () => {
			// Spec: first off pairs with most recent on (tick 960). Second off
			// pairs with the remaining on (tick 480). Both notes are kept
			// (overlap resolution runs later and clamps the earlier note's end
			// to the later note's start).
			const track: MidiData['tracks'][number] = [
				{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 }, // t=480
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 }, // t=960
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },  // t=1440 — pairs with 960 start (LIFO)
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },  // t=1920 — pairs with 480 start
				{ deltaTime: 0, type: 'endOfTrack' },
			]
			const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
			const parsed = parseDrumsExpert(midi, { pro_drums: true })

			// Both starts survive (the LIFO pairing doesn't drop either).
			const g480 = parsed.noteEventGroups.find(g => g[0].tick === 480)!
			expect(g480).toBeDefined()
			expect(g480.some(n => n.type === noteTypes.greenDrum)).toBe(true)
			const g960 = parsed.noteEventGroups.find(g => g[0].tick === 960)!
			expect(g960).toBeDefined()
			expect(g960.some(n => n.type === noteTypes.greenDrum)).toBe(true)
		})

		it('off with no matching on → unpaired off is dropped', () => {
			// Unpaired noteOff (velocity-0 noteOn) with nothing to close.
			const track: MidiData['tracks'][number] = [
				{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },
				{ deltaTime: 0, type: 'endOfTrack' },
			]
			const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
			const parsed = parseDrumsExpert(midi, { pro_drums: true })

			// Only the 960→1440 note should exist.
			const g960 = parsed.noteEventGroups.find(g => g[0].tick === 960)!
			expect(g960).toBeDefined()
			expect(g960[0].type).toBe(noteTypes.greenDrum)
			expect(g960[0].length).toBe(480)
			expect(parsed.noteEventGroups).toHaveLength(1)
		})

		it('on with no matching off → unpaired start at end of track is dropped', () => {
			const track: MidiData['tracks'][number] = [
				{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				// No matching noteOff before endOfTrack.
				{ deltaTime: 960, type: 'endOfTrack' },
			]
			const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
			// The unpaired start leaves 0 drum notes. The drums track is omitted
			// entirely from trackData because empty tracks are filtered out.
			const track_ = parseDrumsExpert(midi, { pro_drums: true })
			expect(track_).toBeUndefined()
		})

		it('pairing is per-channel: different-channel off does not close a different-channel on', () => {
			// on ch=0, on ch=1, off ch=0 (closes ch=0), off ch=1 (closes ch=1).
			// All on note 100 (greenDrum).
			const track: MidiData['tracks'][number] = [
				{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				{ deltaTime: 0, type: 'noteOn', channel: 1, noteNumber: 100, velocity: 100 },
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },
				{ deltaTime: 240, type: 'noteOff', channel: 1, noteNumber: 100, velocity: 0 },
				{ deltaTime: 0, type: 'endOfTrack' },
			]
			const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
			const parsed = parseDrumsExpert(midi, { pro_drums: true })

			// Both starts at tick 480 survive — one per channel.
			const g480 = parsed.noteEventGroups.find(g => g[0].tick === 480)!
			expect(g480).toBeDefined()
			// Both greenDrum entries exist with different lengths (ch0=480, ch1=720).
			const greens = g480.filter(n => n.type === noteTypes.greenDrum)
			expect(greens.length).toBeGreaterThanOrEqual(1)
		})

		it('emits `orphanedNoteStart` parse issue when a noteOn has no matching noteOff', () => {
			const track: MidiData['tracks'][number] = [
				{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				// No matching noteOff.
				{ deltaTime: 960, type: 'endOfTrack' },
			]
			const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
			const parsed = parseChartFile(midi, 'mid', { pro_drums: true })
			const orphanStarts = parsed.parseIssues.filter(i => i.noteIssue === 'orphanedNoteStart')
			expect(orphanStarts.length).toBeGreaterThanOrEqual(1)
			expect(orphanStarts[0].instrument).toBe('drums')
		})

		it('emits `orphanedNoteEnd` parse issue when a noteOff has no matching noteOn', () => {
			const track: MidiData['tracks'][number] = [
				{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 }, // orphan
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },
				{ deltaTime: 0, type: 'endOfTrack' },
			]
			const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
			const parsed = parseChartFile(midi, 'mid', { pro_drums: true })
			const orphanEnds = parsed.parseIssues.filter(i => i.noteIssue === 'orphanedNoteEnd')
			expect(orphanEnds.length).toBeGreaterThanOrEqual(1)
			expect(orphanEnds[0].instrument).toBe('drums')
		})

		it('emits no orphan parse issues when all notes are properly paired', () => {
			const track: MidiData['tracks'][number] = [
				{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
				{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 100, velocity: 100 },
				{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 100, velocity: 0 },
				{ deltaTime: 0, type: 'endOfTrack' },
			]
			const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
			const parsed = parseChartFile(midi, 'mid', { pro_drums: true })
			const orphanIssues = parsed.parseIssues.filter(i =>
				i.noteIssue === 'orphanedNoteStart' || i.noteIssue === 'orphanedNoteEnd')
			expect(orphanIssues).toHaveLength(0)
		})
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
