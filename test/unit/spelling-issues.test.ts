import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { analyzeChart } from 'src/analyze-chart'
import { resolveChart } from 'src/gameplay-chart'
import { scanSongFolder } from 'src/scan-song-folder'
import { parseSongFiles } from 'src/song-document'
import { parseSongMetadata } from 'src/song-metadata'

const encode = (text: string) => new TextEncoder().encode(text)
const spelling = new Set(['unsortedChartLines', 'quotedChartTrackEvent', 'multipleMidiTrackNames', 'overlappingMidiNotes', 'duplicateIniKey', 'duplicateChartLine'])
const chartIssues = (expertLines: string[], styleNotes = false) => {
	const chart = ['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}', '[Events]', '{', '}',
		'[ExpertSingle]', '{', ...expertLines.map(line => `  ${line}`), '}', ''].join('\r\n')
	const { issues } = analyzeChart(resolveChart(parseSongFiles([{ fileName: 'notes.chart', data: encode(chart) }])), { styleNotes })
	return issues.filter(issue => spelling.has(issue.code)).map(({ code, instrument, difficulty, tick }) => ({ code, instrument, difficulty, tick }))
}
const midiIssues = (guitarEvents: Parameters<typeof writeMidi>[0]['tracks'][number]) => {
	const midi = writeMidi({
		header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
		tracks: [[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }], guitarEvents],
	})
	const { issues } = analyzeChart(resolveChart(parseSongFiles([{ fileName: 'notes.mid', data: new Uint8Array(midi) }])))
	return issues.filter(issue => spelling.has(issue.code)).map(({ code, instrument }) => ({ code, instrument }))
}

describe('nonstandard spelling issues', () => {
	it('report .chart lines out of tick order and quoted track events, for the section\'s track', () => {
		expect(chartIssues(['192 = N 1 0', '0 = N 0 0'])).toEqual([{ code: 'unsortedChartLines', instrument: 'guitar', difficulty: 'expert', tick: null }])
		expect(chartIssues(['0 = E "solo"', '0 = N 0 0', '192 = E soloend'])).toEqual([{ code: 'quotedChartTrackEvent', instrument: 'guitar', difficulty: 'expert', tick: null }])
		expect(chartIssues(['0 = N 0 0', '192 = N 1 0'])).toEqual([])
		// Clone Hero reads the lines of one tick in any order, so text before a note at its tick isn't an issue.
		expect(chartIssues(['0 = E solo', '0 = N 0 0', '192 = E soloend'])).toEqual([])
		const unsortedSync = ['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  768 = B 140000', '  0 = B 120000', '}', '[ExpertSingle]', '{', '  0 = N 0 0', '}', ''].join('\r\n')
		expect(analyzeChart(resolveChart(parseSongFiles([{ fileName: 'notes.chart', data: encode(unsortedSync) }]))).issues
			.filter(issue => spelling.has(issue.code)).map(({ code, instrument }) => ({ code, instrument }))).toEqual([{ code: 'unsortedChartLines', instrument: null }])
	})

	it('report a repeated .chart line only as a style note, when asked', () => {
		expect(chartIssues(['0 = N 0 0', '0 = N 0 0'])).toEqual([])
		expect(chartIssues(['0 = N 0 0', '0 = N 0 0'], true)).toEqual([{ code: 'duplicateChartLine', instrument: 'guitar', difficulty: 'expert', tick: null }])
	})

	it('report a .mid track with several names, or with a note that starts again before it ends', () => {
		expect(midiIssues([
			{ deltaTime: 0, type: 'trackName', text: 'gtr' },
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		])).toEqual([{ code: 'multipleMidiTrackNames', instrument: 'guitar' }])
		expect(midiIssues([
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 10, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		])).toEqual([{ code: 'overlappingMidiNotes', instrument: 'guitar' }])
	})

	it('report a song.ini key set twice, in the song.ini Clone Hero reads', async () => {
		const chart = { fileName: 'notes.chart', data: encode('[Song]\r\n{\r\n  Resolution = 192\r\n}\r\n[ExpertSingle]\r\n{\r\n  0 = N 0 0\r\n}\r\n') }
		const twice = { fileName: 'song.ini', data: encode('[song]\r\nname = A\r\nName = B\r\n') }
		const codes = (issues: readonly { code: string }[]) => issues.map(issue => issue.code).filter(code => spelling.has(code))
		expect(codes((await scanSongFolder([chart, twice])).issues)).toEqual(['duplicateIniKey'])
		expect(codes((await parseSongMetadata([chart, twice])).issues)).toEqual(['duplicateIniKey'])
		expect(codes((await parseSongMetadata([chart, { fileName: 'other.ini', data: twice.data }])).issues)).toEqual([])
	})
})
