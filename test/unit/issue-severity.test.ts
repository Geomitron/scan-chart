import { describe, expect, it } from 'vitest'

import { analyzeChart } from 'src/analyze-chart'
import { resolveChart } from 'src/gameplay-chart'
import { issueSeverities } from 'src/issues'
import { scanSongFolder } from 'src/scan-song-folder'
import { parseSongFiles } from 'src/song-document'

const encode = (text: string) => new TextEncoder().encode(text)
const songIni = { fileName: 'song.ini', data: encode('[song]\r\nname = Test\r\n') }
// At 120 BPM and resolution 192, a tick is 500 / 192 ms, about 2.6 ms.
const chartIssues = (expertLines: string[], syncTrack = ['0 = TS 4', '0 = B 120000']) => {
	const chart = ['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', ...syncTrack.map(line => `  ${line}`), '}', '[Events]', '{', '}',
		'[ExpertSingle]', '{', ...expertLines.map(line => `  ${line}`), '}', ''].join('\r\n')
	const { issues } = analyzeChart(resolveChart(parseSongFiles([{ fileName: 'notes.chart', data: encode(chart) }, songIni])))
	return issues.filter(issue => ['smallLeadingSilence', 'badSustainGap', 'babySustain'].includes(issue.code)).map(({ code, severity, tick }) => ({ code, severity, tick }))
}

describe('issue severity', () => {
	it('gives every issue a severity', async () => {
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: encode('[Song]\r\n{\r\n  Resolution = 192\r\n}\r\n[SyncTrack]\r\n{\r\n  0 = B 120000\r\n}\r\n') }])
		expect(scanned.issues.length).toBeGreaterThan(0)
		for (const issue of scanned.issues) expect(issue.severity).toBe(issueSeverities[issue.code])
	})

	it('reports a first note before 1 second as a warning, and before 2 seconds as a recommendation', () => {
		expect(chartIssues(['192 = N 0 0'])).toEqual([{ code: 'smallLeadingSilence', severity: 'warning', tick: null }])
		expect(chartIssues(['576 = N 0 0'])).toEqual([{ code: 'smallLeadingSilence', severity: 'recommendation', tick: null }])
		expect(chartIssues(['768 = N 0 0'])).toEqual([])
	})

	it('accepts two measures of the starting tempo when those are shorter than 2 seconds', () => {
		// At 300 BPM in 4/4, two measures are 1600 ms: a first note at 1625 ms needs nothing more.
		expect(chartIssues(['1560 = N 0 0'], ['0 = TS 4', '0 = B 300000'])).toEqual([])
		expect(chartIssues(['1440 = N 0 0'], ['0 = TS 4', '0 = B 300000'])).toEqual([{ code: 'smallLeadingSilence', severity: 'recommendation', tick: null }])
	})

	it('reports a sustain gap under 40 ms as a warning, and under 60 ms as a recommendation', () => {
		// The sustain ends at tick 960. 11 ticks is about 29 ms, 19 ticks about 49 ms, and 24 ticks about 63 ms.
		expect(chartIssues(['768 = N 0 192', '971 = N 1 0'])).toEqual([{ code: 'badSustainGap', severity: 'warning', tick: 971 }])
		expect(chartIssues(['768 = N 0 192', '979 = N 1 0'])).toEqual([{ code: 'badSustainGap', severity: 'recommendation', tick: 979 }])
		expect(chartIssues(['768 = N 0 192', '984 = N 1 0'])).toEqual([])
	})

	it('reports a sustain under 100 ms as a warning, and under 200 ms as a recommendation', () => {
		// 31 ticks is about 81 ms, 58 ticks about 151 ms, and 77 ticks about 201 ms.
		expect(chartIssues(['768 = N 0 31', '1536 = N 1 0'])).toEqual([{ code: 'babySustain', severity: 'warning', tick: 768 }])
		expect(chartIssues(['768 = N 0 58', '1536 = N 1 0'])).toEqual([{ code: 'babySustain', severity: 'recommendation', tick: 768 }])
		expect(chartIssues(['768 = N 0 77', '1536 = N 1 0'])).toEqual([])
	})
})
