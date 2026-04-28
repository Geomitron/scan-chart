/**
 * Round-trip tests for the `.chart`/`.mid` preservation buckets that landed
 * after the writer stack was authored:
 *
 *   - `metadata.extraChartSongFields`   — unknown `[Song]` keys (.chart)
 *   - `unrecognizedSyncTrackEvents`     — non-B/TS `[SyncTrack]` lines (.chart)
 *   - `unrecognizedEventsTrackMidiEvents` — non-text MIDI events on the EVENTS
 *                                            track (e.g. RB practice-assist
 *                                            notes 24/25/26)
 *
 * All tests go through `parseChartAndIni` on the writer output and assert on
 * the resulting `ParsedChart` — no assertions about the raw serialized bytes.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyChart } from '../chart/create-chart'
import { writeChartFile } from '../chart/chart-writer'
import { writeMidiFile } from '../chart/midi-writer'
import { parseChartAndIni, type ParsedChart } from '../chart/parse-chart-and-ini'

function roundTripChart(chart: ParsedChart): ParsedChart {
	const bytes = new TextEncoder().encode(writeChartFile(chart))
	const result = parseChartAndIni([{ fileName: 'notes.chart', data: bytes }])
	if (!result.parsedChart) {
		throw new Error(`round-trip produced no parsedChart: ${JSON.stringify(result.chartFolderIssues)}`)
	}
	return result.parsedChart
}

function roundTripMidi(chart: ParsedChart): ParsedChart {
	const bytes = writeMidiFile(chart)
	const result = parseChartAndIni([{ fileName: 'notes.mid', data: bytes }])
	if (!result.parsedChart) {
		throw new Error(`round-trip produced no parsedChart: ${JSON.stringify(result.chartFolderIssues)}`)
	}
	return result.parsedChart
}

// ---------------------------------------------------------------------------
// metadata.extraChartSongFields
// ---------------------------------------------------------------------------

describe('writeChartFile round-trip: metadata.extraChartSongFields', () => {
	it('preserves Moonscraper / GHTCP legacy fields verbatim', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraChartSongFields = {
			Player2: 'bass',
			PreviewEnd: '0',
			MediaType: 'cd',
			MusicStream: 'song.ogg',
			GuitarStream: 'guitar.ogg',
			HoPo: '0',
		}
		const re = roundTripChart(chart)
		expect(re.metadata.extraChartSongFields).toEqual({
			Player2: 'bass',
			PreviewEnd: '0',
			MediaType: 'cd',
			MusicStream: 'song.ogg',
			GuitarStream: 'guitar.ogg',
			HoPo: '0',
		})
	})

	it('round-trips bare values cleanly (writer re-quotes per spec)', () => {
		// The parser strips enclosing quotes on read, so values stored in
		// `extraChartSongFields` are always bare. The writer re-applies quoting
		// from the spec's field-type table, so a bare-then-quoted-then-stripped
		// trip is lossless for the value content.
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraChartSongFields = {
			ArtistText: 'by',
			MusicStream: 'Some Song.ogg',
		}
		const re = roundTripChart(chart)
		expect(re.metadata.extraChartSongFields).toEqual({
			ArtistText: 'by',
			MusicStream: 'Some Song.ogg',
		})
	})

	it('emits MusicStream with the quotes Moonscraper expects', () => {
		// Pin the on-disk shape directly: re-writing must produce
		// `MusicStream = "song.ogg"` (quoted), not `MusicStream = song.ogg`.
		// Bare value in → quoted value out.
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraChartSongFields = { MusicStream: 'song.ogg' }
		const text = writeChartFile(chart)
		expect(text).toContain('MusicStream = "song.ogg"')
		expect(text).not.toMatch(/MusicStream = song\.ogg[^"]/)
	})

	it('emits Player2 unquoted (bare-string field per spec)', () => {
		// `Player2` is the lone `bare string` type in the [Song] section. The
		// writer must NOT quote it, even though it's a string-y value.
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraChartSongFields = { Player2: 'bass' }
		const text = writeChartFile(chart)
		expect(text).toContain('Player2 = bass')
		expect(text).not.toContain('Player2 = "bass"')
	})

	it('emits numeric-typed legacy fields unquoted', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraChartSongFields = { HoPo: '0', PreviewEnd: '180' }
		const text = writeChartFile(chart)
		expect(text).toContain('HoPo = 0')
		expect(text).toContain('PreviewEnd = 180')
		expect(text).not.toContain('HoPo = "0"')
	})

	it('quotes unknown string-shaped keys, leaves primitive-shaped keys bare', () => {
		// Forward-compat heuristic for keys outside the spec table: if the
		// value looks like a primitive literal (number / decimal / boolean),
		// emit bare; otherwise quote. Erring on the side of quoting matches
		// what readers (Moonscraper, scan-chart) accept and what authoring
		// tools mostly emit. The boolean case mirrors `OriginalArtist = false`
		// observed in the corpus.
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraChartSongFields = {
			MysteryString: 'hello',
			MysteryNumber: '42',
			MysteryDecimal: '-1.5',
			MysteryBool: 'false',
			OriginalArtist: 'false',
		}
		const text = writeChartFile(chart)
		expect(text).toContain('MysteryString = "hello"')
		expect(text).toContain('MysteryNumber = 42')
		expect(text).toContain('MysteryDecimal = -1.5')
		expect(text).toContain('MysteryBool = false')
		expect(text).toContain('OriginalArtist = false')
		expect(text).not.toContain('OriginalArtist = "false"')
	})

	it('preserves future / unknown keys the parser has never heard of', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraChartSongFields = { FutureField: 'future-value', Boss: '1' }
		expect(roundTripChart(chart).metadata.extraChartSongFields).toEqual({
			FutureField: 'future-value',
			Boss: '1',
		})
	})

	it('is still undefined when no extras are set', () => {
		const chart = createEmptyChart({ format: 'chart' })
		expect(roundTripChart(chart).metadata.extraChartSongFields).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// unrecognizedSyncTrackEvents
// ---------------------------------------------------------------------------

describe('writeChartFile round-trip: unrecognizedSyncTrackEvents', () => {
	it('preserves tempo anchors (A) verbatim', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.unrecognizedSyncTrackEvents.push(
			{ tick: 0, text: 'A 0' },
			{ tick: 3840, text: 'A 8805460' },
		)
		expect(roundTripChart(chart).unrecognizedSyncTrackEvents).toEqual([
			{ tick: 0, text: 'A 0' },
			{ tick: 3840, text: 'A 8805460' },
		])
	})

	it('preserves unknown / future SyncTrack event types verbatim', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.unrecognizedSyncTrackEvents.push({ tick: 1920, text: 'FUTURE 12 34 56' })
		expect(roundTripChart(chart).unrecognizedSyncTrackEvents).toEqual([
			{ tick: 1920, text: 'FUTURE 12 34 56' },
		])
	})

	it('does not disturb tempos or time signatures at the same tick', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.tempos.push({ tick: 960, beatsPerMinute: 150, msTime: 0 })
		chart.timeSignatures.push({ tick: 960, numerator: 3, denominator: 4, msTime: 0, msLength: 0 })
		chart.unrecognizedSyncTrackEvents.push({ tick: 960, text: 'A 12345' })
		const re = roundTripChart(chart)
		expect(re.tempos.find(t => t.tick === 960)?.beatsPerMinute).toBe(150)
		expect(re.timeSignatures.find(ts => ts.tick === 960)).toMatchObject({ numerator: 3, denominator: 4 })
		expect(re.unrecognizedSyncTrackEvents).toEqual([{ tick: 960, text: 'A 12345' }])
	})

	it('writing to .mid drops anchors (no MIDI equivalent)', () => {
		// Anchors are .chart-only. Round-tripping through .mid necessarily loses
		// them — the field is always [] on a .mid-parsed result. This test pins
		// that contract so a future writer change doesn't accidentally smuggle
		// anchors through as something else.
		const chart = createEmptyChart({ format: 'mid' })
		chart.unrecognizedSyncTrackEvents.push({ tick: 1920, text: 'A 12345' })
		expect(roundTripMidi(chart).unrecognizedSyncTrackEvents).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// unrecognizedEventsTrackMidiEvents
// ---------------------------------------------------------------------------

describe('writeMidiFile round-trip: unrecognizedEventsTrackMidiEvents', () => {
	it('preserves Rock Band practice-mode assist-sample notes (24/25/26)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		// deltaTime = absolute tick (per scan-chart's convertToAbsoluteTime).
		chart.unrecognizedEventsTrackMidiEvents.push(
			{ deltaTime: 0,   type: 'noteOn',  channel: 0, noteNumber: 24, velocity: 100 },
			{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 24, velocity: 0   },
			{ deltaTime: 960, type: 'noteOn',  channel: 0, noteNumber: 26, velocity: 100 },
			{ deltaTime: 1440, type: 'noteOff', channel: 0, noteNumber: 26, velocity: 0  },
		)
		const re = roundTripMidi(chart)
		// Compare just the shape that matters — tick + event kind + note number.
		const mapped = re.unrecognizedEventsTrackMidiEvents.map(e => ({
			tick: e.deltaTime,
			type: e.type,
			noteNumber: 'noteNumber' in e ? e.noteNumber : undefined,
		}))
		expect(mapped).toEqual([
			{ tick: 0,    type: 'noteOn',  noteNumber: 24 },
			{ tick: 480,  type: 'noteOff', noteNumber: 24 },
			{ tick: 960,  type: 'noteOn',  noteNumber: 26 },
			{ tick: 1440, type: 'noteOff', noteNumber: 26 },
		])
	})

	it('is empty when no source MIDI events were on the EVENTS track', () => {
		const chart = createEmptyChart({ format: 'mid' })
		expect(roundTripMidi(chart).unrecognizedEventsTrackMidiEvents).toEqual([])
	})

	it('writing to .chart drops MIDI EVENTS-track events (no .chart equivalent)', () => {
		// .chart has no concept of non-text events on its [Events] section;
		// these are a strict MIDI-source concept. Round-tripping through .chart
		// loses them — pin the contract.
		const chart = createEmptyChart({ format: 'chart' })
		chart.unrecognizedEventsTrackMidiEvents.push(
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 24, velocity: 100 },
		)
		expect(roundTripChart(chart).unrecognizedEventsTrackMidiEvents).toEqual([])
	})
})
