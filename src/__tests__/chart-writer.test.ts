/**
 * Tests for writeChartFile: Song/SyncTrack/Events/unrecognized-sections emission.
 * Instrument-track tests land with the follow-up PR that ports serializeTrackSection.
 */

import { describe, expect, it } from 'vitest'

import { writeChartFile } from '../chart/chart-writer'
import { createEmptyChart } from '../chart/create-chart'
import { parseChartAndIni } from '../chart/parse-chart-and-ini'
import type { ParsedChart } from '../chart/parse-chart-and-ini'

function linesOf(out: string): string[] {
	return out.split('\r\n')
}

function sectionBody(out: string, header: string): string[] {
	const lines = linesOf(out)
	const start = lines.indexOf(header)
	if (start === -1) throw new Error(`section ${header} not found`)
	const open = lines.indexOf('{', start)
	const close = lines.indexOf('}', open)
	return lines.slice(open + 1, close)
}

function roundTripThroughParser(chart: ParsedChart): ReturnType<typeof parseChartAndIni> {
	const text = writeChartFile(chart)
	const bytes = new TextEncoder().encode(text)
	return parseChartAndIni([{ fileName: 'notes.chart', data: bytes }])
}

describe('writeChartFile: [Song] section', () => {
	it('emits just resolution when metadata is empty', () => {
		const chart = createEmptyChart({ resolution: 192 })
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toEqual(['  Resolution = 192'])
	})

	it('emits string metadata with quotes', () => {
		const chart = createEmptyChart()
		chart.metadata.name = 'My Song'
		chart.metadata.artist = 'Some Band'
		chart.metadata.charter = 'Me'
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toContain('  Name = "My Song"')
		expect(body).toContain('  Artist = "Some Band"')
		expect(body).toContain('  Charter = "Me"')
	})

	it('emits Year with the GHTCP-convention leading comma+space', () => {
		const chart = createEmptyChart()
		chart.metadata.year = '2024'
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toContain('  Year = ", 2024"')
	})

	it('emits Offset from chart_offset and PreviewStart as seconds when set', () => {
		const chart = createEmptyChart()
		chart.metadata.chart_offset = 250
		chart.metadata.preview_start_time = 30000
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toContain('  Offset = 0.25')
		expect(body).toContain('  PreviewStart = 30')
	})

	it('does not use ini `delay` for [Song] Offset (they are distinct fields)', () => {
		// `delay` is an ini-only property; games don't recognize it in [Song].
		// Set a high ini delay and no chart_offset — no Offset line should emit.
		const chart = createEmptyChart()
		chart.metadata.delay = 999
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body.join('\n')).not.toContain('Offset')
	})

	it('skips Offset when chart_offset is 0', () => {
		const chart = createEmptyChart()
		chart.metadata.chart_offset = 0
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body.join('\n')).not.toContain('Offset')
	})

	it('emits Difficulty from diff_guitar', () => {
		const chart = createEmptyChart()
		chart.metadata.diff_guitar = 5
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toContain('  Difficulty = 5')
	})

	it('round-trips metadata through parseChartAndIni', () => {
		const chart = createEmptyChart({ resolution: 480 })
		chart.metadata.name = 'Song'
		chart.metadata.artist = 'Artist'
		chart.metadata.album = 'Album'
		chart.metadata.genre = 'Rock'
		chart.metadata.year = '2024'
		chart.metadata.charter = 'Me'
		chart.metadata.chart_offset = 100
		chart.metadata.preview_start_time = 45000
		chart.metadata.diff_guitar = 4

		const re = roundTripThroughParser(chart)
		expect(re.parsedChart!.metadata).toMatchObject({
			name: 'Song',
			artist: 'Artist',
			album: 'Album',
			genre: 'Rock',
			year: '2024',
			charter: 'Me',
			chart_offset: 100,
			preview_start_time: 45000,
			diff_guitar: 4,
		})
		expect(re.parsedChart!.resolution).toBe(480)
	})
})

describe('writeChartFile: [SyncTrack] section', () => {
	it('emits the default 120 BPM + 4/4 events for an empty chart', () => {
		const chart = createEmptyChart()
		const body = sectionBody(writeChartFile(chart), '[SyncTrack]')
		expect(body).toEqual(['  0 = TS 4', '  0 = B 120000'])
	})

	it('emits TS with denominator exponent when not 4/4', () => {
		const chart = createEmptyChart({ timeSignature: { numerator: 6, denominator: 8 } })
		const body = sectionBody(writeChartFile(chart), '[SyncTrack]')
		expect(body).toContain('  0 = TS 6 3')
	})

	it('sorts tempo and TS events by tick, TS before B at same tick', () => {
		const chart = createEmptyChart()
		chart.tempos.push({ tick: 960, beatsPerMinute: 150, msTime: 0 })
		chart.timeSignatures.push({ tick: 960, numerator: 3, denominator: 4, msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[SyncTrack]')
		const t960 = body.filter(l => l.startsWith('  960 = '))
		expect(t960).toEqual(['  960 = TS 3', '  960 = B 150000'])
	})

	it('emits BPM as millibeats (×1000)', () => {
		const chart = createEmptyChart({ bpm: 137.5 })
		const body = sectionBody(writeChartFile(chart), '[SyncTrack]')
		expect(body).toContain('  0 = B 137500')
	})

	it('round-trips tempos and time signatures', () => {
		const chart = createEmptyChart({ resolution: 480, bpm: 140 })
		chart.tempos.push({ tick: 1920, beatsPerMinute: 200, msTime: 0 })
		chart.timeSignatures.push({ tick: 3840, numerator: 7, denominator: 8, msTime: 0, msLength: 0 })
		const re = roundTripThroughParser(chart)
		const reChart = re.parsedChart!
		expect(reChart.tempos.map(t => ({ tick: t.tick, bpm: t.beatsPerMinute }))).toEqual([
			{ tick: 0, bpm: 140 },
			{ tick: 1920, bpm: 200 },
		])
		expect(reChart.timeSignatures.map(ts => ({ t: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
			{ t: 0, n: 4, d: 4 },
			{ t: 3840, n: 7, d: 8 },
		])
	})
})

describe('writeChartFile: [Events] section', () => {
	it('emits section markers wrapped in brackets (regex quirk)', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: 'Intro', msTime: 0, msLength: 0 })
		chart.sections.push({ tick: 1920, name: 'Verse 1', msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body).toContain('  0 = E "[section Intro]"')
		expect(body).toContain('  1920 = E "[section Verse 1]"')
	})

	it('emits end events', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 9600, msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body).toContain('  9600 = E "end"')
	})

	it('emits unrecognized global events verbatim when source is .chart', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.unrecognizedEvents.push({ tick: 0, text: 'music_start', msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body).toContain('  0 = E "music_start"')
	})

	it('strips bracket wrapping on unrecognized events sourced from .mid', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.unrecognizedEvents.push({ tick: 480, text: '[crowd_noclap]', msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body).toContain('  480 = E "crowd_noclap"')
	})

	it('skips duplicate end events in unrecognizedEvents', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 1000, msTime: 0, msLength: 0 })
		chart.unrecognizedEvents.push({ tick: 1000, text: 'end', msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body.filter(l => l.endsWith('"end"'))).toHaveLength(1)
	})

	it('round-trips section markers with special characters', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: '[BREAKDOWN]', msTime: 0, msLength: 0 })
		const re = roundTripThroughParser(chart)
		expect(re.parsedChart!.sections[0].name).toBe('[BREAKDOWN]')
	})
})

describe('writeChartFile: unrecognized chart sections', () => {
	it('re-emits unrecognized sections verbatim (indent added by writer)', () => {
		const chart = createEmptyChart()
		// Parser stores lines without indent (splitTrimmedNonEmptyLines strips it).
		chart.unrecognizedChartSections.push({
			name: 'MysteryBlock',
			lines: ['0 = B 100000', '480 = some_unknown_event'],
		})
		const out = writeChartFile(chart)
		expect(out).toContain('[MysteryBlock]\r\n{\r\n  0 = B 100000\r\n  480 = some_unknown_event\r\n}')
	})

	it('round-trips unrecognized sections through parseChartAndIni', () => {
		const chart = createEmptyChart()
		chart.unrecognizedChartSections.push({
			name: 'MysteryBlock',
			lines: ['0 = foo', '100 = bar'],
		})
		const re = roundTripThroughParser(chart)
		expect(re.parsedChart!.unrecognizedChartSections).toEqual([
			{ name: 'MysteryBlock', lines: ['0 = foo', '100 = bar'] },
		])
	})
})

describe('writeChartFile: output format', () => {
	it('uses CRLF line endings and terminates with newline', () => {
		const chart = createEmptyChart()
		const out = writeChartFile(chart)
		expect(out).toMatch(/\r\n$/)
		expect(out).toContain('[Song]\r\n{\r\n')
	})
})
