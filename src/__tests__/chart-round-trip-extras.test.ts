/**
 * Tests for round-trip preservation fields that catch `.chart` data which
 * doesn't map to a typed ParsedChart field:
 *
 *   - `metadata.extraChartSongFields` — unknown `[Song]` keys (Moonscraper /
 *     GHTCP deprecated fields, audio-stream filenames, `Player2`, `HoPo`,
 *     `PreviewEnd`, `MediaType`, …)
 *   - `unrecognizedSyncTrackEvents` — `[SyncTrack]` lines that aren't tempo (`B`)
 *     or time signature (`TS`); today this is primarily tempo anchors (`A`),
 *     but the bucket is type-agnostic so future SyncTrack event types survive.
 *
 * `.mid` populates neither field — both are a `.chart`-only round-trip aid.
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from '@geomitron/midi-file'
import { parseNotesFromChart } from '../chart/chart-parser'
import { parseNotesFromMidi } from '../chart/midi-parser'
import { defaultIniChartModifiers } from '../chart/note-parsing-interfaces'

function buildChart(sections: Record<string, string[]>): Uint8Array {
	const lines: string[] = []
	for (const [name, content] of Object.entries(sections)) {
		lines.push(`[${name}]`)
		lines.push('{')
		for (const line of content) lines.push(`  ${line}`)
		lines.push('}')
	}
	return new TextEncoder().encode(lines.join('\r\n'))
}

function tempoTrack(): MidiData['tracks'][number] {
	return [
		{ deltaTime: 0, type: 'trackName', text: '' },
		{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
		{ deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
}

function buildMidi(ticksPerBeat: number, tracks: MidiData['tracks']): Uint8Array {
	return new Uint8Array(writeMidi({ header: { format: 1, numTracks: tracks.length, ticksPerBeat }, tracks }))
}

// ---------------------------------------------------------------------------
// metadata.extraChartSongFields
// ---------------------------------------------------------------------------

describe('.chart [Song] unknown-key preservation (metadata.extraChartSongFields)', () => {
	it('captures Moonscraper / GHTCP legacy fields verbatim', () => {
		const chart = buildChart({
			Song: [
				'Resolution = 192',
				'Name = "Test"',
				'Artist = "Me"',
				'Player2 = bass',
				'PreviewEnd = 0',
				'MediaType = "cd"',
				'MusicStream = "song.ogg"',
				'GuitarStream = "guitar.ogg"',
				'HoPo = 0',
			],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
		})
		const r = parseNotesFromChart(chart)
		// Known typed fields still populate.
		expect(r.metadata.name).toBe('Test')
		expect(r.metadata.artist).toBe('Me')
		// Everything else lands in the preservation bag, with quotes stripped.
		// The writer re-applies quoting per the spec's field-type table on emit.
		expect(r.metadata.extraChartSongFields).toEqual({
			Player2: 'bass',
			PreviewEnd: '0',
			MediaType: 'cd',
			MusicStream: 'song.ogg',
			GuitarStream: 'guitar.ogg',
			HoPo: '0',
		})
	})

	it('is omitted when [Song] has no unknown keys', () => {
		const chart = buildChart({
			Song: ['Resolution = 192', 'Name = "Test"'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
		})
		const r = parseNotesFromChart(chart)
		expect(r.metadata.extraChartSongFields).toBeUndefined()
	})

	it('preserves keys from authoring tools that scan-chart has never heard of', () => {
		const chart = buildChart({
			Song: ['Resolution = 192', 'Name = "Test"', 'FutureField = "future-value"', 'Boss = "1"'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
		})
		const r = parseNotesFromChart(chart)
		expect(r.metadata.extraChartSongFields).toEqual({ FutureField: 'future-value', Boss: '1' })
	})

	it('does not consume claimed keys (Resolution / Name / Artist / etc.)', () => {
		const chart = buildChart({
			Song: [
				'Resolution = 192',
				'Name = "Test"',
				'Artist = "A"',
				'Album = "Al"',
				'Genre = "G"',
				'Year = ", 2020"',
				'Charter = "C"',
				'Difficulty = 3',
				'Offset = 0',
				'PreviewStart = 10',
			],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
		})
		const r = parseNotesFromChart(chart)
		expect(r.metadata.extraChartSongFields).toBeUndefined()
	})

	it('.mid does not populate extraChartSongFields (field is .chart-only)', () => {
		const midi = buildMidi(480, [tempoTrack()])
		const r = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(r.metadata.extraChartSongFields).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// unrecognizedSyncTrackEvents
// ---------------------------------------------------------------------------

describe('.chart [SyncTrack] unknown-event preservation (unrecognizedSyncTrackEvents)', () => {
	it('preserves tempo anchors (A) verbatim', () => {
		const chart = buildChart({
			Song: ['Resolution = 192', 'Name = "T"'],
			SyncTrack: [
				'0 = B 120000',
				'0 = A 0',
				'0 = TS 4',
				'3840 = A 8805460',
				'3840 = B 122000',
			],
			Events: [],
		})
		const r = parseNotesFromChart(chart)
		expect(r.unrecognizedSyncTrackEvents).toEqual([
			{ tick: 0, text: 'A 0' },
			{ tick: 3840, text: 'A 8805460' },
		])
		// Tempos and time sigs still populated normally.
		expect(r.tempos.length).toBe(2)
		expect(r.timeSignatures.length).toBe(1)
	})

	it('preserves future / unrecognized SyncTrack event types verbatim', () => {
		// Forward-compat: an event type scan-chart doesn't know about today
		// should still come out unchanged on write.
		const chart = buildChart({
			Song: ['Resolution = 192', 'Name = "T"'],
			SyncTrack: [
				'0 = B 120000',
				'0 = TS 4',
				'1920 = FUTURE 12 34 56',
			],
			Events: [],
		})
		const r = parseNotesFromChart(chart)
		expect(r.unrecognizedSyncTrackEvents).toEqual([{ tick: 1920, text: 'FUTURE 12 34 56' }])
	})

	it('is empty when [SyncTrack] only has tempos and time signatures', () => {
		const chart = buildChart({
			Song: ['Resolution = 192', 'Name = "T"'],
			SyncTrack: ['0 = B 120000', '0 = TS 4', '1920 = B 130000'],
			Events: [],
		})
		const r = parseNotesFromChart(chart)
		expect(r.unrecognizedSyncTrackEvents).toEqual([])
	})

	it('.mid does not populate unrecognizedSyncTrackEvents (field is .chart-only)', () => {
		const midi = buildMidi(480, [tempoTrack()])
		const r = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(r.unrecognizedSyncTrackEvents).toEqual([])
	})
})
