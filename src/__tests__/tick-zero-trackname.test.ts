/**
 * Tests for the MIDI track-name discovery in `getTracks`. Some charts emit
 * multiple `trackName` events at tick 0 — typically a bogus or descriptive
 * name first (e.g. `[ENHANCED_OPENS]`, `TEMPO TRACK`, the song title)
 * followed by the real instrument name (e.g. `PART BASS`). YARG.Core takes
 * only the first tick-0 trackName and drops the track if it isn't a known
 * instrument; scan-chart intentionally does NOT match that behavior. We
 * walk all tick-0 trackName events and accept the first one that matches a
 * known instrument so these charts stay playable.
 *
 * Real-world charts that hit this path:
 *   - "Culture Killer - Blindfolded Death" (PART BASS, PART GUITAR)
 *   - "Periphery - Ji" (PART DRUMS)
 *   - "school food punishment - close, down, back to" (PART DRUMS)
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from 'midi-file'
import { parseNotesFromMidi } from '../chart/midi-parser'
import { defaultIniChartModifiers } from '../chart/note-parsing-interfaces'

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

/** Build an instrument track whose tick-0 events start with `leadingNames`
 *  (zero or more trackName events) followed by a single noteOn/noteOff pair. */
function trackWithLeadingNames(
	leadingNames: string[],
	noteNumber: number,
	noteLength = 480,
): MidiData['tracks'][number] {
	const events: MidiData['tracks'][number] = []
	for (const text of leadingNames) {
		events.push({ deltaTime: 0, type: 'trackName', text })
	}
	events.push({ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber, velocity: 100 })
	events.push({ deltaTime: noteLength, type: 'noteOff', channel: 0, noteNumber, velocity: 0 })
	events.push({ deltaTime: 0, type: 'endOfTrack' })
	return events
}

describe('MIDI: tick-0 trackName resolution', () => {
	it('accepts a recognized instrument trackName even when a bogus name comes first at tick 0', () => {
		// PART BASS expert kick is MIDI note 95. (Same difficulty layout as guitar.)
		const bass = trackWithLeadingNames(['[ENHANCED_OPENS]', 'PART BASS'], 96)
		const midi = buildMidi(480, [tempoTrack(), bass])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)

		const bassTracks = result.trackData.filter(t => t.instrument === 'bass')
		expect(bassTracks.length).toBeGreaterThan(0)
		expect(result.unrecognizedMidiTracks).toHaveLength(0)
	})

	it('accepts PART DRUMS even when a descriptive name (e.g. song title) comes first at tick 0', () => {
		// PART DRUMS expert red drum is MIDI note 97.
		const drums = trackWithLeadingNames(['school food punishment - close, down, back to', 'PART DRUMS'], 97)
		const midi = buildMidi(480, [tempoTrack(), drums])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)

		const drumTracks = result.trackData.filter(t => t.instrument === 'drums')
		expect(drumTracks.length).toBeGreaterThan(0)
		expect(result.unrecognizedMidiTracks).toHaveLength(0)
	})

	it('takes the first MATCHING name when multiple recognized names appear at tick 0', () => {
		// If two known instrument names somehow appear at tick 0 on the same
		// track, the first one wins. (Pathological but well-defined.)
		const ambiguous = trackWithLeadingNames(['PART BASS', 'PART GUITAR'], 96)
		const midi = buildMidi(480, [tempoTrack(), ambiguous])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)

		expect(result.trackData.some(t => t.instrument === 'bass')).toBe(true)
		expect(result.trackData.some(t => t.instrument === 'guitar')).toBe(false)
	})

	it('captures the first tick-0 trackName as unrecognized when no known instrument matches', () => {
		// VENUE isn't a recognized instrument track, so it's stored verbatim
		// in unrecognizedMidiTracks for round-trip. The captured trackName
		// should be the first one we saw at tick 0.
		const venue: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'CUSTOM VENUE LEAD' },
			{ deltaTime: 0, type: 'trackName', text: 'VENUE' },
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), venue])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)

		expect(result.trackData).toHaveLength(0)
		expect(result.unrecognizedMidiTracks).toHaveLength(1)
		expect(result.unrecognizedMidiTracks[0].trackName).toBe('CUSTOM VENUE LEAD')
	})

	it('ignores trackName events past tick 0', () => {
		// Only tick-0 trackNames count. A trackName event later in the file
		// must not be picked up.
		const malformed: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'NOT_A_REAL_NAME' },
			{ deltaTime: 1, type: 'trackName', text: 'PART BASS' },
			{ deltaTime: 480, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), malformed])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)

		expect(result.trackData.some(t => t.instrument === 'bass')).toBe(false)
		expect(result.unrecognizedMidiTracks).toHaveLength(1)
		expect(result.unrecognizedMidiTracks[0].trackName).toBe('NOT_A_REAL_NAME')
	})
})
