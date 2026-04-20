/**
 * Tests for `ChartDocument` + `writeChartFolder` — the orchestrator that
 * glues writeChartFile/writeMidiFile + writeIniFile + passthrough assets
 * into a flat file list suitable for zip/sng packaging.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyChart } from '../chart/create-chart'
import { writeChartFolder } from '../chart/chart-document'
import { parseChartAndIni } from '../chart/parse-chart-and-ini'

function textOf(data: Uint8Array): string {
	return new TextDecoder().decode(data)
}

function findFile(files: { fileName: string; data: Uint8Array }[], name: string) {
	return files.find(f => f.fileName === name)
}

describe('writeChartFolder: format selection', () => {
	it('emits notes.chart + song.ini for a .chart document', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.name = 'Test Song'
		const out = writeChartFolder({ parsedChart: chart, assets: [] })
		expect(findFile(out, 'notes.chart')).toBeDefined()
		expect(findFile(out, 'notes.mid')).toBeUndefined()
		expect(findFile(out, 'song.ini')).toBeDefined()
	})

	it('emits notes.mid + song.ini for a .mid document', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.metadata.name = 'Test Song'
		const out = writeChartFolder({ parsedChart: chart, assets: [] })
		expect(findFile(out, 'notes.mid')).toBeDefined()
		expect(findFile(out, 'notes.chart')).toBeUndefined()
		expect(findFile(out, 'song.ini')).toBeDefined()
	})
})

describe('writeChartFolder: ini content', () => {
	it('writes parsedChart.metadata to song.ini', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.name = 'My Song'
		chart.metadata.artist = 'My Artist'
		const out = writeChartFolder({ parsedChart: chart, assets: [] })
		const iniText = textOf(findFile(out, 'song.ini')!.data)
		expect(iniText).toContain('name = My Song')
		expect(iniText).toContain('artist = My Artist')
	})

	it('does NOT leak chart_offset into song.ini ([Song]-only field)', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.chart_offset = 250
		const out = writeChartFolder({ parsedChart: chart, assets: [] })
		const iniText = textOf(findFile(out, 'song.ini')!.data)
		expect(iniText).not.toContain('chart_offset')
	})

	it('preserves extraIniFields for unknown ini keys', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.metadata.extraIniFields = { custom_field: 'custom_value' }
		const out = writeChartFolder({ parsedChart: chart, assets: [] })
		const iniText = textOf(findFile(out, 'song.ini')!.data)
		expect(iniText).toContain('custom_field = custom_value')
	})
})

describe('writeChartFolder: assets passthrough', () => {
	it('passes audio/image assets through verbatim', () => {
		const chart = createEmptyChart({ format: 'chart' })
		const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53]) // "OggS"
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
		const out = writeChartFolder({
			parsedChart: chart,
			assets: [
				{ fileName: 'song.ogg', data: ogg },
				{ fileName: 'album.png', data: png },
			],
		})
		expect(findFile(out, 'song.ogg')!.data).toBe(ogg)
		expect(findFile(out, 'album.png')!.data).toBe(png)
	})

	it('emits chart file BEFORE ini BEFORE assets', () => {
		const chart = createEmptyChart({ format: 'chart' })
		const out = writeChartFolder({
			parsedChart: chart,
			assets: [{ fileName: 'song.ogg', data: new Uint8Array(4) }],
		})
		const names = out.map(f => f.fileName)
		expect(names[0]).toBe('notes.chart')
		expect(names[1]).toBe('song.ini')
		expect(names[2]).toBe('song.ogg')
	})
})

describe('writeChartFolder: round-trip via parseChartAndIni', () => {
	it('.chart folder round-trips through parseChartAndIni with metadata intact', () => {
		const chart = createEmptyChart({ format: 'chart', resolution: 480 })
		chart.metadata.name = 'Round Trip'
		chart.metadata.artist = 'Tester'
		chart.metadata.pro_drums = true

		const out = writeChartFolder({ parsedChart: chart, assets: [] })
		const re = parseChartAndIni(out)

		expect(re.parsedChart).not.toBeNull()
		expect(re.parsedChart!.metadata.name).toBe('Round Trip')
		expect(re.parsedChart!.metadata.artist).toBe('Tester')
		expect(re.parsedChart!.metadata.pro_drums).toBe(true)
		expect(re.hasIni).toBe(true)
	})

	it('.mid folder round-trips with metadata AND assets preserved', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		chart.metadata.name = 'Midi Song'
		const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00])

		const out = writeChartFolder({
			parsedChart: chart,
			assets: [{ fileName: 'song.ogg', data: ogg }],
		})
		const re = parseChartAndIni(out)

		expect(re.parsedChart!.format).toBe('mid')
		expect(re.parsedChart!.metadata.name).toBe('Midi Song')
		// Asset survives as a file in the output set (parseChartAndIni doesn't
		// surface assets on its result — but we can still find it in `out`).
		expect(findFile(out, 'song.ogg')!.data).toBe(ogg)
	})
})
