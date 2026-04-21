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

	it('preserves quoted string values including inner spaces', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraChartSongFields = {
			ArtistText: '"by"',
			MusicStream: '"Some Song.ogg"',
		}
		const re = roundTripChart(chart)
		expect(re.metadata.extraChartSongFields).toEqual({
			// The parser strips one layer of enclosing quotes on read. What matters
			// is that the key survives and the value round-trips: re-writing the
			// stripped form re-adds no quotes, so the next parse sees it unquoted.
			ArtistText: 'by',
			MusicStream: 'Some Song.ogg',
		})
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
