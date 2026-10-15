/**
 * Tests for round-trip preservation fields that catch `.chart` data which
 * doesn't map to a typed ParsedChart field:
 *
 *   - `metadata.extraChartSongFields` — unknown `[Song]` keys (Moonscraper /
 *     GHTCP deprecated fields, audio-stream filenames, `Player2`, `HoPo`,
 *     `GuitarVolume`, `MediaType`, …)
 *   - `unrecognizedSyncTrackEvents` — `[SyncTrack]` lines that aren't tempo (`B`)
 *     or time signature (`TS`); today this is primarily tempo anchors (`A`),
 *     but the bucket is type-agnostic so future SyncTrack event types survive.
 *
 * `.mid` populates neither field — both are a `.chart`-only round-trip aid.
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from '@geomitron/midi-file'
import { parseNotesFromChart } from 'src/chart/chart-file-parser'
import { parseNotesFromMidi } from 'src/chart/midi-file-parser'
import { parseChartFile } from 'src/chart/parse-chart-file'
import { defaultMetadata } from 'src/ini/metadata'

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
				'GuitarVolume = 0',
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
		// Everything else lands in the preservation bag, values unchanged.
		expect(r.metadata.extraChartSongFields).toEqual({
			Player2: 'bass',
			GuitarVolume: '0',
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

	it('reads [Events] text as Clone Hero does: trimmed, then without one pair of brackets', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [
				'0 = E " [section Intro ] "',
				'192 = E "section_Verse_1"',
				'384 = E "prc  chorus"',
				'384 = E "section Chorus"',
				'576 = E "section <b>Solo</b> [credits]"',
				'768 = E "section "',
				'768 = E "sectionX"',
				'960 = E "[coda]"',
				'1152 = E "[end"',
				'1344 = E "crowd_clap "',
			],
			ExpertDrums: ['0 = N 0 0', '960 = S 64 192'],
		})
		const r = parseNotesFromChart(chart)
		// A tick holds one section, so the later one replaces the earlier one. An empty name isn't a section.
		expect(r.sections.map(({ tick, name }) => [tick, name])).toEqual([[0, 'Intro'], [192, 'Verse_1'], [384, 'Chorus'], [576, '<b>Solo</b> [credits]']])
		expect(r.endEvents.map(event => event.tick)).toEqual([1152])
		expect(r.trackData.find(track => track.instrument === 'drums')?.drumFreestyleSections).toEqual([{ tick: 960, length: 192, isCoda: true }])
		// Text that isn't an event a reader knows is kept as written.
		expect(r.unrecognizedEventsTrackTextEvents).toEqual([{ tick: 768, text: 'section ' }, { tick: 768, text: 'sectionX' }, { tick: 1344, text: 'crowd_clap ' }])
	})

	it('.mid does not populate extraChartSongFields (field is .chart-only)', () => {
		const midi = buildMidi(480, [tempoTrack()])
		const r = parseNotesFromMidi(midi, defaultMetadata)
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
		const r = parseNotesFromMidi(midi, defaultMetadata)
		expect(r.unrecognizedSyncTrackEvents).toEqual([])
	})
})

describe('parseChartFile unrecognized preservation bucket', () => {
	it('groups top-level unrecognized chart data under one object', () => {
		const chart = buildChart({
			Song: ['Resolution = 192', 'Name = "T"'],
			SyncTrack: ['0 = B 120000', '0 = TS 4', '192 = FUTURE 12 34 56'],
			Events: ['192 = E "crowd_normal"'],
			CustomMetadata: ['FutureField = "future-value"'],
		})
		const r = parseChartFile(chart, 'chart')

		expect(r.unrecognized).toEqual({
			eventsTrackTextEvents: [{ tick: 192, text: 'crowd_normal', msTime: 500, msLength: 0 }],
			eventsTrackMidiEvents: [],
			midiTracks: [],
			chartSections: [{ name: 'CustomMetadata', lines: ['FutureField = "future-value"'] }],
			syncTrackEvents: [{ tick: 192, text: 'FUTURE 12 34 56' }],
		})
		expect((r as { unrecognizedSyncTrackEvents?: unknown }).unrecognizedSyncTrackEvents).toBeUndefined()
	})
})
