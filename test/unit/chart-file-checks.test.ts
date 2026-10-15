import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { scanSongFolder } from 'src/scan-song-folder'

const encode = (text: string) => new TextEncoder().encode(text)
const chartFile = (song: string[], sections: string[] = []) => encode(['[Song]', '{', '  Resolution = 192', ...song.map(line => `  ${line}`), '}',
	'[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}',
	'[ExpertSingle]', '{', '  768 = N 0 0', '}', ...sections].join('\r\n') + '\r\n')

type MidiTrack = MidiData['tracks'][number]

/** A `.mid` file with a 120 BPM conductor track and one track for each name, holding a note at each tick of `notes`. */
function midi(tracks: Record<string, readonly { tick: number; noteNumber: number }[]>): Uint8Array {
	const midiTracks = Object.entries(tracks).map(([name, notes]): MidiTrack => {
		const events: MidiTrack = [{ deltaTime: 0, type: 'trackName', text: name }]
		let previous = 0
		for (const { tick, noteNumber } of notes) {
			events.push({ deltaTime: tick - previous, type: 'noteOn', channel: 0, noteNumber, velocity: 100 })
			events.push({ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber, velocity: 0 })
			previous = tick + 10
		}
		return [...events, { deltaTime: 0, type: 'endOfTrack' }]
	})
	const conductor: MidiTrack = [{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }]
	return new Uint8Array(writeMidi({ header: { format: 1, numTracks: midiTracks.length + 1, ticksPerBeat: 480 }, tracks: [conductor, ...midiTracks] }))
}

async function chartIssues(chart: Uint8Array, code: string, { fileName = 'notes.chart', ini = '[song]\r\nname = Song\r\n' } = {}) {
	const scanned = await scanSongFolder([{ fileName, data: chart }, { fileName: 'song.ini', data: encode(ini) }])
	return scanned.issues.filter(issue => issue.code === code).map(issue => [issue.severity, issue.instrument, issue.difficulty, issue.message])
}

describe('the .chart Offset', () => {
	it('recommends an Offset of 0, keeping the notes in time with the audio another way', async () => {
		expect(await chartIssues(chartFile(['Offset = 0.5']), 'chartOffset')).toEqual([['recommendation', null, null,
			'The chart\'s [Song] Offset is 0.5 seconds. Set it to 0, and keep the notes in time with the audio instead: '
			+ 'start the audio 500 ms earlier, by removing its first 500 ms, or move every note 500 ms later.']])
		expect((await chartIssues(chartFile(['Offset = -0.2']), 'chartOffset'))[0][3])
			.toContain('add 200 ms of silence to the start of the audio, or move every note 200 ms earlier')
		expect(await chartIssues(chartFile(['Offset = 0']), 'chartOffset')).toEqual([])
	})

	it('says games ignore the Offset while song.ini sets delay', async () => {
		expect(await chartIssues(chartFile(['Offset = 0.5']), 'chartOffset', { ini: '[song]\r\ndelay = 100\r\n' })).toEqual([['recommendation', null, null,
			'The chart\'s [Song] Offset is 0.5 seconds, which games ignore while song.ini sets "delay". Set the Offset to 0.']])
	})
})

describe('tracks with no notes', () => {
	it('reports a .chart instrument section with no notes', async () => {
		const chart = chartFile([], ['[HardSingle]', '{', '  0 = S 2 192', '}', '[ExpertDrums]', '{', '}', '[ExpertDrums]', '{', '  768 = N 0 0', '}'])
		expect(await chartIssues(chart, 'emptyTrack')).toEqual([
			['warning', 'guitar', 'hard', 'The [HardSingle] section has no notes, so it isn\'t a track: games don\'t list it. Chart its notes, or remove it.'],
			['warning', 'drums', 'expert', 'The [ExpertDrums] section has no notes, so it isn\'t a track: games don\'t list it. Chart its notes, or remove it.'],
		])
	})

	it('reports a .mid instrument track with no notes, named as written', async () => {
		const chart = midi({ 'PART GUITAR': [{ tick: 1920, noteNumber: 96 }], 'part keys': [], 'PART VOCALS': [], 'PART BASS': [{ tick: 1920, noteNumber: 30 }] })
		expect(await chartIssues(chart, 'emptyTrack', { fileName: 'notes.mid' })).toEqual([
			['warning', 'keys', null, 'The "part keys" track has no notes, so games don\'t list it. Chart its notes, or remove it.'],
			['warning', 'bass', null, 'The "PART BASS" track has no notes, so games don\'t list it. Chart its notes, or remove it.'],
		])
	})

	it('doesn\'t report a practice section with no notes', async () => {
		const withSections = encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}',
			'[Events]', '{', '  0 = E "section Intro"', '  384 = E "section Gap"', '}', '[ExpertSingle]', '{', '  768 = N 0 0', '}'].join('\r\n') + '\r\n')
		expect(await chartIssues(withSections, 'emptyTrack')).toEqual([])
	})
})
