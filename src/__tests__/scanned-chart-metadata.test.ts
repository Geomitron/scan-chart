import { describe, expect, it } from 'vitest'

import { parseChartAndIni } from '../chart/parse-chart-and-ini'
import { scanChart } from '../scan-chart'
import { File } from '../types'

function buildChart(body: string): File[] {
	return [{ fileName: 'notes.chart', data: new TextEncoder().encode(body) }]
}

describe('scanChart metadata output', () => {
	it('nests metadata-derived properties under metadata', () => {
		const body = [
			'[Song]', '{',
			'  Resolution = 480',
			'  Name = "Nested"',
			'  Artist = "Scanner"',
			'  Charter = "Geo"',
			'  Offset = 1.5',
			'}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '}',
			'[ExpertSingle]', '{', '  0 = N 0 0', '}',
		].join('\r\n')
		const files = buildChart(body)

		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false, includeBTrack: false })
		const flatScanned = scanned as unknown as Record<string, unknown>

		expect(scanned.metadata.name).toBe('Nested')
		expect(scanned.metadata.artist).toBe('Scanner')
		expect(scanned.metadata.charter).toBe('Geo')
		expect(scanned.metadata.chart_offset).toBe(1500)
		expect(flatScanned.name).toBeUndefined()
		expect(flatScanned.artist).toBeUndefined()
		expect(flatScanned.charter).toBeUndefined()
		expect(flatScanned.chart_offset).toBeUndefined()
	})
})
