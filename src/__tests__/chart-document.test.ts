/**
 * Round-trip tests for writeChartFolder.
 *
 * Tests go through parseChartAndIni on the folder output: build a
 * ParsedChart (+ optional assets), write to a file list, re-parse,
 * and assert on the resulting ParsedChart. No assertions about file
 * order, raw ini text contents, or which filename the writer chose —
 * those are implementation details of the orchestrator.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyChart } from '../chart/create-chart'
import { writeChartFolder } from '../chart/chart-document'
import { parseChartAndIni, type ParsedChart } from '../chart/parse-chart-and-ini'

function roundTrip(
	chart: ParsedChart,
	assets: { fileName: string; data: Uint8Array }[] = [],
): { parsedChart: ParsedChart; files: { fileName: string; data: Uint8Array }[] } {
	const files = writeChartFolder({ parsedChart: chart, assets })
	const result = parseChartAndIni(files)
	if (!result.parsedChart) {
		throw new Error(`round-trip produced no parsedChart: ${JSON.stringify(result.chartFolderIssues)}`)
	}
	return { parsedChart: result.parsedChart, files }
}

describe('writeChartFolder round-trip: format selection', () => {
	it('round-trips a .chart document to format="chart"', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.name = 'Test Song'
		const re = roundTrip(chart).parsedChart
		expect(re.format).toBe('chart')
	})

	it('round-trips a .mid document to format="mid"', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.metadata.name = 'Test Song'
		const re = roundTrip(chart).parsedChart
		expect(re.format).toBe('mid')
	})
})

describe('writeChartFolder round-trip: ini content', () => {
	it('preserves basic string metadata', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.name = 'My Song'
		chart.metadata.artist = 'My Artist'
		const re = roundTrip(chart).parsedChart
		expect(re.metadata.name).toBe('My Song')
		expect(re.metadata.artist).toBe('My Artist')
	})

	it('preserves extraIniFields for unknown ini keys', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraIniFields = { custom_field: 'custom_value' }
		const re = roundTrip(chart).parsedChart
		expect(re.metadata.extraIniFields).toMatchObject({ custom_field: 'custom_value' })
	})

	it('does not round-trip chart_offset via the ini path (it belongs in [Song])', () => {
		// chart_offset is a [Song]-only field. Writing a .chart document with
		// chart_offset must round-trip it intact, and the ini must NOT carry a
		// competing value that would confuse the parse.
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.chart_offset = 250
		const re = roundTrip(chart).parsedChart
		expect(re.metadata.chart_offset).toBe(250)
	})
})

describe('writeChartFolder round-trip: assets passthrough', () => {
	it('passes audio/image assets through verbatim', () => {
		const chart = createEmptyChart({ format: 'chart' })
		const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53])
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
		const { files } = roundTrip(chart, [
			{ fileName: 'song.ogg', data: ogg },
			{ fileName: 'album.png', data: png },
		])
		const oggFile = files.find(f => f.fileName === 'song.ogg')
		const pngFile = files.find(f => f.fileName === 'album.png')
		expect(oggFile?.data).toBe(ogg)
		expect(pngFile?.data).toBe(png)
	})
})

describe('writeChartFolder round-trip: complete folder', () => {
	it('.chart folder preserves metadata and chart identity', () => {
		const chart = createEmptyChart({ format: 'chart', resolution: 480 })
		chart.metadata.name = 'Round Trip'
		chart.metadata.artist = 'Tester'
		chart.metadata.pro_drums = true
		const re = roundTrip(chart).parsedChart
		expect(re.format).toBe('chart')
		expect(re.resolution).toBe(480)
		expect(re.metadata.name).toBe('Round Trip')
		expect(re.metadata.artist).toBe('Tester')
		expect(re.metadata.pro_drums).toBe(true)
	})

	it('.mid folder preserves metadata and passes assets through', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		chart.metadata.name = 'Midi Song'
		const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00])
		const { parsedChart, files } = roundTrip(chart, [{ fileName: 'song.ogg', data: ogg }])
		expect(parsedChart.format).toBe('mid')
		expect(parsedChart.metadata.name).toBe('Midi Song')
		expect(files.find(f => f.fileName === 'song.ogg')?.data).toBe(ogg)
	})

	it('overwrites stale notes.chart / notes.mid / song.ini entries in assets', () => {
		// Common caller pattern: pass the full file list from parseChartAndIni as
		// `assets` without filtering. The writer should emit its own fresh chart
		// + ini and drop the stale ones — no duplicates, no cross-format leaks.
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.name = 'Fresh'
		const staleChart = new TextEncoder().encode('[Song]\r\n{\r\n  Name = "Stale"\r\n}\r\n')
		const staleMid = new Uint8Array([0x4d, 0x54, 0x68, 0x64]) // 'MThd'
		const staleIni = new TextEncoder().encode('[song]\r\nname = Stale\r\n')
		const cover = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
		const { parsedChart, files } = roundTrip(chart, [
			{ fileName: 'notes.chart', data: staleChart },
			{ fileName: 'NOTES.MID', data: staleMid }, // case-insensitive
			{ fileName: 'song.ini', data: staleIni },
			{ fileName: 'album.png', data: cover },
		])
		// Exactly one of each chart file survives — the freshly-serialized one.
		const chartFiles = files.filter(f => /^notes\.(chart|mid)$/i.test(f.fileName))
		const iniFiles = files.filter(f => f.fileName.toLowerCase() === 'song.ini')
		expect(chartFiles).toHaveLength(1)
		expect(chartFiles[0].fileName).toBe('notes.chart')
		expect(chartFiles[0].data).not.toBe(staleChart)
		expect(iniFiles).toHaveLength(1)
		expect(iniFiles[0].data).not.toBe(staleIni)
		// Non-chart assets untouched.
		expect(files.find(f => f.fileName === 'album.png')?.data).toBe(cover)
		// Re-parse sees the fresh metadata, not the stale.
		expect(parsedChart.metadata.name).toBe('Fresh')
	})
})
