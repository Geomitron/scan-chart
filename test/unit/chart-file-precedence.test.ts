import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { File } from 'src/types'

const chartBytes = new TextEncoder().encode([
	'[Song]', '{', '  Resolution = 192', '}',
	'[SyncTrack]', '{', '  0 = B 120000', '}',
	'[ExpertSingle]', '{', '  0 = N 0 0', '}',
].join('\r\n'))

const midiBytes = new Uint8Array(writeMidi({
	header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
	tracks: [
		[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
		[
			{ deltaTime: 0, type: 'trackName', text: 'PART BASS' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		],
	] satisfies MidiData['tracks'],
}))

function parsedFormat(files: File[]) {
	return parseChartAndIni(files).parsedChart?.format
}

describe('chart file precedence', () => {
	it('uses notes.mid when a folder also has notes.chart, in either order', () => {
		const chart = { fileName: 'notes.chart', data: chartBytes }
		const midi = { fileName: 'notes.mid', data: midiBytes }
		expect(parsedFormat([chart, midi])).toBe('mid')
		expect(parsedFormat([midi, chart])).toBe('mid')
	})

	it('treats the notes file name in any letter case as Clone Hero does', () => {
		expect(parsedFormat([{ fileName: 'notes.chart', data: chartBytes }, { fileName: 'NOTES.MID', data: midiBytes }])).toBe('mid')
		expect(parsedFormat([{ fileName: 'other.mid', data: midiBytes }, { fileName: 'Notes.chart', data: chartBytes }])).toBe('chart')
	})
})
