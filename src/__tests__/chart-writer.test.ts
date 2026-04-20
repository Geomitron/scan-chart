/**
 * Round-trip tests for writeChartFile: Song / SyncTrack / Events / unrecognized
 * sections. Instrument-track tests land with the follow-up PR that ports
 * serializeTrackSection.
 *
 * All tests exercise the writer only through parseChartAndIni: build a
 * ParsedChart, write it out, re-parse, and assert on the resulting
 * ParsedChart. No assertions about the serialized .chart text (CRLF,
 * quoting, field order, section ordering) — the parser is the source of
 * truth for observable behavior.
 */

import { describe, expect, it } from 'vitest'

import { writeChartFile } from '../chart/chart-writer'
import { createEmptyChart } from '../chart/create-chart'
import { parseChartAndIni, type ParsedChart } from '../chart/parse-chart-and-ini'

function roundTrip(chart: ParsedChart): ParsedChart {
	const bytes = new TextEncoder().encode(writeChartFile(chart))
	const result = parseChartAndIni([{ fileName: 'notes.chart', data: bytes }])
	if (!result.parsedChart) {
		throw new Error(`round-trip produced no parsedChart: ${JSON.stringify(result.chartFolderIssues)}`)
	}
	return result.parsedChart
}

describe('writeChartFile round-trip: [Song] metadata', () => {
	it('preserves chart resolution', () => {
		const re = roundTrip(createEmptyChart({ resolution: 192 }))
		expect(re.resolution).toBe(192)
	})

	it('preserves string metadata fields', () => {
		const chart = createEmptyChart()
		chart.metadata.name = 'My Song'
		chart.metadata.artist = 'Some Band'
		chart.metadata.album = 'Greatest Hits'
		chart.metadata.charter = 'Me'
		chart.metadata.genre = 'Rock'
		chart.metadata.year = '2024'
		const re = roundTrip(chart)
		expect(re.metadata).toMatchObject({
			name: 'My Song',
			artist: 'Some Band',
			album: 'Greatest Hits',
			charter: 'Me',
			genre: 'Rock',
			year: '2024',
		})
	})

	it('preserves chart_offset', () => {
		const chart = createEmptyChart()
		chart.metadata.chart_offset = 250
		expect(roundTrip(chart).metadata.chart_offset).toBe(250)
	})

	it('preserves preview_start_time', () => {
		const chart = createEmptyChart()
		chart.metadata.preview_start_time = 30000
		expect(roundTrip(chart).metadata.preview_start_time).toBe(30000)
	})

	it('preserves diff_* difficulty fields', () => {
		const chart = createEmptyChart()
		chart.metadata.diff_guitar = 5
		expect(roundTrip(chart).metadata.diff_guitar).toBe(5)
	})

	it('does not leak ini `delay` into chart_offset', () => {
		// delay is ini-only; writing a chart with no chart_offset and a `delay`
		// value must not surface as chart_offset after round-trip.
		const chart = createEmptyChart()
		chart.metadata.delay = 999
		expect(roundTrip(chart).metadata.chart_offset).toBeUndefined()
	})

	it('does not emit a chart_offset for the value 0', () => {
		// 0 is the default in-game behavior; the writer skips it so we don't
		// round-trip 0 as a meaningful Offset.
		const chart = createEmptyChart()
		chart.metadata.chart_offset = 0
		expect(roundTrip(chart).metadata.chart_offset).toBeUndefined()
	})
})

describe('writeChartFile round-trip: [SyncTrack]', () => {
	it('preserves the default tempo and time signature on an empty chart', () => {
		const re = roundTrip(createEmptyChart())
		expect(re.tempos.map(t => ({ tick: t.tick, bpm: t.beatsPerMinute }))).toEqual([{ tick: 0, bpm: 120 }])
		expect(re.timeSignatures.map(ts => ({ tick: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
			{ tick: 0, n: 4, d: 4 },
		])
	})

	it('preserves non-4/4 time signatures', () => {
		const chart = createEmptyChart({ timeSignature: { numerator: 6, denominator: 8 } })
		expect(roundTrip(chart).timeSignatures[0]).toMatchObject({ numerator: 6, denominator: 8 })
	})

	it('preserves multiple tempo changes', () => {
		const chart = createEmptyChart({ bpm: 140 })
		chart.tempos.push({ tick: 1920, beatsPerMinute: 200, msTime: 0 })
		const re = roundTrip(chart)
		expect(re.tempos.map(t => ({ tick: t.tick, bpm: t.beatsPerMinute }))).toEqual([
			{ tick: 0, bpm: 140 },
			{ tick: 1920, bpm: 200 },
		])
	})

	it('preserves multiple time-signature changes', () => {
		const chart = createEmptyChart()
		chart.timeSignatures.push({ tick: 3840, numerator: 7, denominator: 8, msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.timeSignatures.map(ts => ({ t: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
			{ t: 0, n: 4, d: 4 },
			{ t: 3840, n: 7, d: 8 },
		])
	})

	it('preserves fractional BPM', () => {
		const chart = createEmptyChart({ bpm: 137.5 })
		expect(roundTrip(chart).tempos[0].beatsPerMinute).toBe(137.5)
	})

	it('preserves tempo + TS events that share a tick', () => {
		const chart = createEmptyChart()
		chart.tempos.push({ tick: 960, beatsPerMinute: 150, msTime: 0 })
		chart.timeSignatures.push({ tick: 960, numerator: 3, denominator: 4, msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.tempos.find(t => t.tick === 960)?.beatsPerMinute).toBe(150)
		expect(re.timeSignatures.find(ts => ts.tick === 960)).toMatchObject({ numerator: 3, denominator: 4 })
	})
})

describe('writeChartFile round-trip: [Events]', () => {
	it('preserves sections at the right ticks with correct names', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: 'Intro', msTime: 0, msLength: 0 })
		chart.sections.push({ tick: 1920, name: 'Verse 1', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.sections.map(s => ({ tick: s.tick, name: s.name }))).toEqual([
			{ tick: 0, name: 'Intro' },
			{ tick: 1920, name: 'Verse 1' },
		])
	})

	it('preserves section names with special characters', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: '[BREAKDOWN]', msTime: 0, msLength: 0 })
		expect(roundTrip(chart).sections[0].name).toBe('[BREAKDOWN]')
	})

	it('preserves end events', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 9600, msTime: 0, msLength: 0 })
		expect(roundTrip(chart).endEvents.map(e => e.tick)).toEqual([9600])
	})

	it('preserves unrecognized global events', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.unrecognizedEventsTrackTextEvents.push({ tick: 0, text: 'music_start', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.unrecognizedEventsTrackTextEvents.map(e => ({ tick: e.tick, text: e.text }))).toEqual([
			{ tick: 0, text: 'music_start' },
		])
	})

	it('does not duplicate an end event that also appears in unrecognizedEventsTrackTextEvents', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 1000, msTime: 0, msLength: 0 })
		chart.unrecognizedEventsTrackTextEvents.push({ tick: 1000, text: 'end', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.endEvents.map(e => e.tick)).toEqual([1000])
		expect(re.unrecognizedEventsTrackTextEvents.filter(e => e.text === 'end')).toHaveLength(0)
	})
})

describe('writeChartFile round-trip: unrecognized chart sections', () => {
	it('preserves unrecognized sections with arbitrary content', () => {
		const chart = createEmptyChart()
		chart.unrecognizedChartSections.push({
			name: 'MysteryBlock',
			lines: ['0 = foo', '100 = bar'],
		})
		expect(roundTrip(chart).unrecognizedChartSections).toEqual([
			{ name: 'MysteryBlock', lines: ['0 = foo', '100 = bar'] },
		])
	})
})
