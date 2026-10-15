import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { analyzeChart } from 'src/analyze-chart'
import { resolveChart } from 'src/gameplay-chart'
import { scanSongFolder } from 'src/scan-song-folder'
import { parseSongFiles } from 'src/song-document'
import { parseSongMetadata } from 'src/song-metadata'

import { midiFile, midiNote, midiText } from './helpers/midi-files'

const encode = (text: string) => new TextEncoder().encode(text)
const spelling = new Set(['unsortedChartLines', 'quotedChartTrackEvent', 'multipleMidiTrackNames', 'multipleMidiTracks', 'overlappingMidiNotes', 'duplicateIniKey', 'duplicateChartLine'])
const chartIssues = (expertLines: string[], styleNotes = false) => {
	const chart = ['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}', '[Events]', '{', '}',
		'[ExpertSingle]', '{', ...expertLines.map(line => `  ${line}`), '}', ''].join('\r\n')
	const { issues } = analyzeChart(resolveChart(parseSongFiles([{ fileName: 'notes.chart', data: encode(chart) }])), { styleNotes })
	return issues.filter(issue => spelling.has(issue.code)).map(({ code, instrument, difficulty, tick }) => ({ code, instrument, difficulty, tick }))
}
const midiFileIssues = (midi: Uint8Array) => {
	const { issues } = analyzeChart(resolveChart(parseSongFiles([{ fileName: 'notes.mid', data: midi }])))
	return issues.filter(issue => spelling.has(issue.code)).map(({ code, instrument, file, severity }) => ({ code, instrument, file, severity }))
}
const midiIssues = (guitarEvents: Parameters<typeof writeMidi>[0]['tracks'][number]) => midiFileIssues(new Uint8Array(writeMidi({
	header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
	tracks: [[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }], guitarEvents],
})))

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
		])).toEqual([{ code: 'multipleMidiTrackNames', instrument: 'guitar', file: null, severity: 'error' }])
		expect(midiIssues([
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 10, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		])).toEqual([{ code: 'overlappingMidiNotes', instrument: 'guitar', file: null, severity: 'error' }])
	})

	it('report a .mid file with more than one track for an instrument, of which Clone Hero reads only the first', () => {
		const tracks = (...names: string[]) => midiFile(names.map(name => ({ name, events: midiNote(0, 96, 10) })))
		// T1 GEMS is another name for guitar, matched in any letter case.
		expect(midiFileIssues(tracks('PART GUITAR', 'PART DRUMS', 't1 gems', 'PART BASS')))
			.toEqual([{ code: 'multipleMidiTracks', instrument: 'guitar', file: null, severity: 'error' }])
		expect(midiFileIssues(tracks('PART GUITAR', 'PART BASS'))).toEqual([])
	})

	it('report, as a warning, each difficulty\'s dnoflip mix event that comes while its d flip is on', () => {
		const noflips = (files: { fileName: string; data: Uint8Array }[]) => analyzeChart(resolveChart(parseSongFiles(files))).issues
			.filter(issue => issue.code === 'discoNoflipDuringFlip').map(({ instrument, difficulty, severity, message }) => ({ instrument, difficulty, severity, message }))
		const chart = (lines: string[]) => noflips([{ fileName: 'notes.chart', data: encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}',
			'[ExpertDrums]', '{', ...lines.map(line => `  ${line}`), '}', ''].join('\r\n')) }])
		const message = (first: string) => `${first} while a "d" disco flip is on. Clone Hero 1.1 keeps the flip on, and other programs start no-flip there. `
			+ 'Saving an edit turns the flip off on the tick before, unless a red or yellow note or the "d" event is on it.'
		const flip = ['480 = E mix 3 drums0d', '480 = N 1 0']
		expect(chart([...flip, '960 = E mix 3 drums0dnoflip', '960 = N 1 0', '1440 = E mix 3 drums0d', '1920 = E mix 3 drums0dnoflip'])).toEqual([{
			instrument: 'drums', difficulty: 'expert', severity: 'warning', message: message('2 "dnoflip" mix events, such as the one at tick 960, come'),
		}])
		// Turned off first, or on its tick, which readers read first, or in another difficulty, it's standard.
		expect(chart([...flip, '959 = E mix 3 drums0', '960 = E mix 3 drums0dnoflip', '960 = N 1 0'])).toEqual([])
		expect(chart([...flip, '960 = E mix 3 drums0dnoflip', '960 = E mix 3 drums0', '960 = N 1 0'])).toEqual([])
		expect(chart([...flip, '960 = E mix 2 drums0dnoflip', '960 = N 1 0'])).toEqual([])

		const mid = midiFile([{ name: 'PART DRUMS', events: [
			midiText(480, '[mix 3 drums0d]'), ...midiNote(480, 97), midiText(960, '[mix 3 drums0dnoflip]'), ...midiNote(960, 97),
			midiText(480, '[mix 1 drums0d]'), ...midiNote(480, 73), midiText(481, '[mix 1 drums0dnoflip]'), ...midiNote(481, 73),
		] }])
		expect(noflips([{ fileName: 'notes.mid', data: mid }])).toEqual([
			{ instrument: 'drums', difficulty: 'expert', severity: 'warning', message: message('The "dnoflip" mix event at tick 960 comes') },
			{ instrument: 'drums', difficulty: 'medium', severity: 'warning', message: message('The "dnoflip" mix event at tick 481 comes') },
		])
	})

	it('report, as a warning, the .chart modifiers with no note at their tick to apply to, for each section', () => {
		const modifiers = (sections: string[][]) => analyzeChart(resolveChart(parseSongFiles([{ fileName: 'notes.chart', data: encode([
			'[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}',
			...sections.flatMap(([name, ...lines]) => [`[${name}]`, '{', ...lines.map(line => `  ${line}`), '}']), '',
		].join('\r\n')) }]))).issues.filter(issue => issue.code === 'chartModifierWithoutNote')
			.map(({ instrument, difficulty, severity, message }) => ({ instrument, difficulty, severity, message }))
		const games = 'which games ignore. Saving an edit removes'
		// Forced and tap apply to every note at their tick.
		expect(modifiers([['ExpertSingle', '768 = N 0 0', '768 = N 5 0', '769 = N 5 0', '960 = N 6 0']])).toEqual([{ instrument: 'guitar', difficulty: 'expert', severity: 'warning',
			message: `2 lines, such as "769 = N 5 0", are modifiers with no note at their tick to apply to, ${games} them: move them to their notes' ticks first to keep what they meant.` }])
		// An accent, ghost or cymbal marker applies to its pad's note, and a flam to any drum note.
		const pro = ['768 = N 2 0', '768 = N 66 0']
		expect(modifiers([['HardDrums', ...pro, '768 = N 34 0', '960 = N 0 0', '960 = N 109 0', '1152 = N 1 0', '1152 = N 67 0', '1344 = N 109 0']])).toEqual([{
			instrument: 'drums', difficulty: 'hard', severity: 'warning',
			message: `3 lines, such as "768 = N 34 0", are modifiers with no note at their tick to apply to, ${games} them: move them to their notes' ticks first to keep what they meant.`,
		}])
		expect(modifiers([['ExpertDrums', ...pro], ['HardDrums', '768 = N 1 0', '768 = N 41 0']]).map(issue => issue.message)).toEqual([
			`The line "768 = N 41 0" is a modifier with no note at its tick to apply to, ${games} it: move it to its note's tick first to keep what it meant.`,
		])
		// A cymbal marker without its note still makes the chart pro, unless another one with its note does, and no N 5 decides.
		expect(modifiers([['ExpertDrums', '768 = N 1 0', '768 = N 66 0']])).toEqual([])
		expect(modifiers([['ExpertDrums', ...pro, '960 = N 1 0', '960 = N 67 0', '1152 = N 5 0']])).toEqual([])
		// A section with no notes isn't a track, and is reported as one. One out of tick order is left until saving sorts it.
		expect(modifiers([['ExpertSingle', '768 = N 0 0'], ['HardSingle', '768 = N 5 0']])).toEqual([])
		expect(modifiers([['ExpertSingle', '768 = N 0 0', '0 = N 0 0', '769 = N 5 0']])).toEqual([])
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
