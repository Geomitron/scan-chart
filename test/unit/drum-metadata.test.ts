import { describe, expect, it } from 'vitest'

import { parseChartFile } from 'src/chart/parse-chart-file'
import { scanIni } from 'src/ini/scan-ini'
import { drumTypes, File } from 'src/types'

const chart = new TextEncoder().encode([
	'[Song]',
	'{',
	'  Resolution = 192',
	'}',
	'[SyncTrack]',
	'{',
	'  0 = B 120000',
	'  0 = TS 4',
	'}',
	'[Events]',
	'{',
	'}',
	'[ExpertDrums]',
	'{',
	'  0 = N 0 0',
	'}',
].join('\r\n'))

function scanDrumMetadata(...values: string[]) {
	const data = new TextEncoder().encode(['[Song]', 'name = Test', 'artist = Test', 'charter = Test', ...values].join('\r\n'))
	return scanIni([{ fileName: 'song.ini', data } satisfies File])
}

describe('drum metadata', () => {
	it('preserves pro_drums and selects four-lane pro drums', () => {
		const result = scanDrumMetadata('pro_drums = True')

		expect(result.metadata).toMatchObject({ pro_drums: true, five_lane_drums: false })
		expect(parseChartFile(chart, 'chart', result.metadata!).drumType).toBe(drumTypes.fourLanePro)
	})

	it('accepts the lowercase boolean spelling supported by Clone Hero and YARG', () => {
		const result = scanDrumMetadata('pro_drums = true')

		expect(result.metadata).toMatchObject({ pro_drums: true, five_lane_drums: false })
		expect(parseChartFile(chart, 'chart', result.metadata!).drumType).toBe(drumTypes.fourLanePro)
	})

	it('preserves five_lane_drums and selects five-lane drums', () => {
		const result = scanDrumMetadata('five_lane_drums = 1')

		expect(result.metadata).toMatchObject({ pro_drums: false, five_lane_drums: true })
		expect(parseChartFile(chart, 'chart', result.metadata!).drumType).toBe(drumTypes.fiveLane)
	})

	it('preserves and diagnoses conflicting flags while giving five-lane drums semantic precedence', () => {
		const result = scanDrumMetadata('pro_drums = True', 'five_lane_drums = 1')

		expect(result.metadata).toMatchObject({ pro_drums: true, five_lane_drums: true })
		expect(result.metadataIssues).toContainEqual({
			metadataIssue: 'invalidValue',
			description: 'Metadata contains both the "pro_drums" and "five_lane_drums" properties, which is not supported.',
		})
		expect(parseChartFile(chart, 'chart', result.metadata!).drumType).toBe(drumTypes.fiveLane)
	})
})
