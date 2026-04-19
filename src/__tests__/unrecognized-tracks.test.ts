/**
 * Tests for the unrecognized-tracks fallback: whole MIDI tracks whose name
 * isn't in the recognized set, plus per-track unconsumed events on
 * recognized tracks. Both round-trip out verbatim.
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from 'midi-file'
import { parseNotesFromMidi } from '../chart/midi-parser'
import { parseNotesFromChart } from '../chart/chart-parser'
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

function buildChart(sections: Record<string, string[]>): Uint8Array {
	const lines: string[] = []
	for (const [name, content] of Object.entries(sections)) {
		lines.push(`[${name}]`)
		lines.push('{')
		for (const line of content) {
			lines.push(`  ${line}`)
		}
		lines.push('}')
	}
	return new TextEncoder().encode(lines.join('\r\n'))
}

// ---------------------------------------------------------------------------
// MIDI: whole unrecognized tracks
// ---------------------------------------------------------------------------

describe('MIDI: unrecognizedMidiTracks (whole-track fallback)', () => {
	it('captures a VENUE track verbatim as an unrecognized track', () => {
		const venue: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'VENUE' },
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'text', text: '[verse]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), venue])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.unrecognizedMidiTracks).toHaveLength(1)
		expect(result.unrecognizedMidiTracks[0].trackName).toBe('VENUE')
		// Stored events have absolute-tick deltaTimes (parser converts) and may
		// include meta:true flags from midi-file. Verify semantic content rather
		// than exact equality.
		const events = result.unrecognizedMidiTracks[0].events
		expect(events.find(e => e.type === 'trackName' && (e as { text: string }).text === 'VENUE')).toBeDefined()
		expect(events.find(e => e.type === 'noteOn' && (e as { noteNumber: number }).noteNumber === 96)).toBeDefined()
		expect(events.find(e => e.type === 'text' && (e as { text: string }).text === '[verse]')).toBeDefined()
	})

	it('captures Pro Guitar (PART REAL_GUITAR) as an unrecognized track', () => {
		const proGuitar: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART REAL_GUITAR' },
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 105 },
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), proGuitar])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.unrecognizedMidiTracks.map(t => t.trackName)).toContain('PART REAL_GUITAR')
		// PART REAL_GUITAR should NOT have produced any parsed trackData
		expect(result.trackData.find(t => t.instrument === 'guitar')).toBeUndefined()
	})

	it('PART REAL_DRUMS_PS is always unrecognized — even when PART DRUMS is also present', () => {
		const drums: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 97, velocity: 100 },
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 97, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const psDrums: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART REAL_DRUMS_PS' },
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 38, velocity: 100 },
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 38, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), drums, psDrums])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		// PART DRUMS parses normally
		expect(result.trackData.some(t => t.instrument === 'drums')).toBe(true)
		// PART REAL_DRUMS_PS lands as unrecognized — no parseIssue, no merge
		expect(result.unrecognizedMidiTracks.map(t => t.trackName)).toContain('PART REAL_DRUMS_PS')
		expect(result.parseIssues).toEqual([])
	})

	it('captures multiple unrecognized tracks in file order', () => {
		const venue: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'VENUE' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const beat: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'BEAT' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const custom: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART CUSTOM_FOO' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), venue, beat, custom])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.unrecognizedMidiTracks.map(t => t.trackName)).toEqual([
			'VENUE',
			'BEAT',
			'PART CUSTOM_FOO',
		])
	})

	it('does not include the conductor track (track 0) in unrecognizedTracks', () => {
		const midi = buildMidi(480, [tempoTrack()])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.unrecognizedMidiTracks).toEqual([])
	})

	it('does not include recognized tracks in unrecognizedTracks', () => {
		const guitar: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), guitar])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.unrecognizedMidiTracks).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// MIDI: per-track unrecognized events on recognized tracks
// ---------------------------------------------------------------------------

describe('MIDI: per-track unrecognizedMidiEvents on recognized tracks', () => {
	it('captures noteOn events outside the recognized note range', () => {
		const guitar: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			// Recognized: expert green (note 96)
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			// Unrecognized: note 200 outside any range
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 13, velocity: 50 },
			{ deltaTime: 60, type: 'noteOff', channel: 0, noteNumber: 13, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), guitar])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = result.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
		expect(track.unrecognizedMidiEvents.some(e => e.type === 'noteOn' && e.noteNumber === 13)).toBe(true)
		expect(track.unrecognizedMidiEvents.some(e => e.type === 'noteOff' && e.noteNumber === 13)).toBe(true)
	})

	it('captures non-Phase-Shift sysEx events', () => {
		const guitar: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			// Non-Phase-Shift sysEx (0x7E is universal non-realtime)
			{ deltaTime: 0, type: 'sysEx', data: [0x7E, 0x7F, 0x09, 0x01] },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), guitar])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = result.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
		expect(track.unrecognizedMidiEvents.some(e => e.type === 'sysEx')).toBe(true)
	})

	it('does NOT include events that the typed parser consumed', () => {
		const guitar: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			// Recognized: expert green (96)
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			// Recognized: text event
			{ deltaTime: 0, type: 'text', text: '[play]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), guitar])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = result.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
		expect(track.unrecognizedMidiEvents).toEqual([])
	})

	it('captures stray notes on a vocal track (outside recognized ranges)', () => {
		// Vocal tracks recognize: 0, 1, 105, 106, 116, 36-84, 96, 97.
		// Note 10 is outside all of these → unrecognized.
		const vocals: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART VOCALS' },
			// Recognized: phrase 105
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 105, velocity: 0 },
			// Unrecognized: note 10
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 10, velocity: 100 },
			{ deltaTime: 60, type: 'noteOff', channel: 0, noteNumber: 10, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), vocals])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.vocalTracks.vocals.unrecognizedMidiEvents.some(e => e.type === 'noteOn' && e.noteNumber === 10)).toBe(true)
		expect(result.vocalTracks.vocals.unrecognizedMidiEvents.some(e => e.type === 'noteOff' && e.noteNumber === 10)).toBe(true)
		// Recognized phrase not leaked into unrecognizedMidiEvents
		expect(result.vocalTracks.vocals.unrecognizedMidiEvents.every(e => !(e.type === 'noteOn' && e.noteNumber === 105))).toBe(true)
	})

	it('captures non-text, non-note events on a vocal track', () => {
		const vocals: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART VOCALS' },
			// A controller change — not handled by vocal scanner
			{ deltaTime: 480, type: 'controller', channel: 0, controllerType: 7, value: 127 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), vocals])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.vocalTracks.vocals.unrecognizedMidiEvents.some(e => e.type === 'controller')).toBe(true)
	})

	it('does NOT include lyric/textEvent/note-pair events the vocal scanner consumed', () => {
		const vocals: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART VOCALS' },
			// Consumed: lyric
			{ deltaTime: 480, type: 'lyrics', text: 'Hello' },
			// Consumed: bracketed control [play] → textEvent
			{ deltaTime: 0, type: 'text', text: '[play]' },
			// Consumed: phrase note
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 105, velocity: 0 },
			// Consumed: vocal note
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
			{ deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
			// Dropped (consumed elsewhere): ENHANCED_OPENS on vocal track
			{ deltaTime: 0, type: 'text', text: 'ENHANCED_OPENS' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), vocals])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.vocalTracks.vocals.unrecognizedMidiEvents).toEqual([])
	})

	it('.chart VocalTrackData.unrecognizedMidiEvents is always []', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: ['192 = E "lyric hi"', '192 = E "phrase_start"', '384 = E "phrase_end"'],
		})
		const result = parseNotesFromChart(chart)
		expect(result.vocalTracks.vocals.unrecognizedMidiEvents).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// .chart: unrecognizedSections
// ---------------------------------------------------------------------------

describe('.chart: unrecognizedSections', () => {
	it('captures sections that are not Song/SyncTrack/Events/track sections', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: ['192 = N 0 0'],
			CustomMetadata: ['line1', 'line2'],
			AnotherCustomSection: ['only_line'],
		})

		const result = parseNotesFromChart(chart)
		expect(result.unrecognizedChartSections.map(s => s.name).sort()).toEqual([
			'AnotherCustomSection',
			'CustomMetadata',
		])
		const meta = result.unrecognizedChartSections.find(s => s.name === 'CustomMetadata')!
		expect(meta.lines).toEqual(['line1', 'line2'])
	})

	it('returns [] when only standard sections are present', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: ['192 = N 0 0'],
		})

		const result = parseNotesFromChart(chart)
		expect(result.unrecognizedChartSections).toEqual([])
	})

	it('MIDI: unrecognizedSections is always [] (.chart-only field)', () => {
		const midi = buildMidi(480, [tempoTrack()])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.unrecognizedChartSections).toEqual([])
	})

	it('.chart: unrecognizedTracks is always [] (MIDI-only field)', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
		})
		const result = parseNotesFromChart(chart)
		expect(result.unrecognizedMidiTracks).toEqual([])
	})
})
