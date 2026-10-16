import { parseMidi, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { authoredTracks } from 'src/authored'
import { chartAuthoredTracks, midiAuthoredTracks } from 'src/chart/authored-view'
import { chartEventEdits, editChartLines } from 'src/chart/chart-edit'
import { chartSectionLines } from 'src/chart/chart-file-parser'
import { editSong, parseSongFiles, SongDocument } from 'src/song-document'
import { resolveChart } from 'src/gameplay-chart'
import { fileBytes } from 'src/song-files'
import { saveSong, songHashes, SongNormalization } from 'src/song-save'

import { midiFile, midiNote, midiText, trackTexts } from './helpers/midi-files'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const songIni = { fileName: 'song.ini', data: encode('[song]\r\nname = Test\r\nsong_length = 60000\r\n') }

function song(lines: string[], lineEnding = '\r\n') {
	return parseSongFiles([{ fileName: 'notes.chart', data: encode(lines.join(lineEnding) + lineEnding) }, songIni])
}
// [Song] agrees with song.ini, so the [Song] normalization has nothing to do.
const header = ['[Song]', '{', '  Resolution = 192', '  Name = "Test"', '  Length = 60', '}', '[SyncTrack]', '{', '  0 = B 120000', '}', '[Events]', '{', '}']

/** Lengthens Expert Guitar's note at tick 192. */
function lengthenExpertNote(original: SongDocument) {
	const tokens = original.chart?.format === 'chart' ? original.chart.tokens : null
	const expert = chartAuthoredTracks(tokens!).find(track => track.sectionName === 'ExpertSingle')!
	return editSong(original, batch => batch.setLength(expert.events.find(event => event.tick === 192)!, 96))
}

describe('saving (E7)', () => {
	it('gives back an unedited song byte for byte, even with nonstandard spelling', () => {
		const original = song([...header, '[ExpertSingle]', '{', '\t192 = N 1 0', '\t0 = N 0 0', '}'], '\n')
		const { files, report } = saveSong(original, original)
		expect(files[0].data).toEqual(original.files[0].data)
		expect(report.normalized).toEqual([])
	})

	it('saves an edited song that is already standard as edited, without calculating its hashes', () => {
		const original = song([...header, '[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}'])
		const edited = lengthenExpertNote(original)
		const { files, report } = saveSong(original, edited)
		expect(report).toEqual({ spentHashes: null, normalized: [], withheld: [] })
		expect(decode(fileBytes(files[0]))).toContain('192 = N 1 96\r\n')
	})

	it('normalizes an edited song where that changes no hash the edit didn\'t', () => {
		const original = song([
			...header,
			'[ExpertSingle]', '{', '\t0 = E "solo"', '\t0 = N 0 0', '\t192 = N 1 0', '\t384 = E "soloend"', '}',
			'[HardSingle]', '{', '\t192 = N 1 0', '\t0 = N 0 0', '\t0 = N 0 0', '}',
		], '\n')
		const { files, report } = saveSong(original, lengthenExpertNote(original))
		expect(report.spentHashes).toEqual(['canonical:guitar:expert', 'canonical:song'])
		expect(report.withheld).toEqual([])
		expect(decode(fileBytes(files[0]))).toBe([
			...header,
			'[ExpertSingle]', '{', '  0 = N 0 0', '  0 = E solo', '  192 = N 1 96', '  384 = E soloend', '}',
			'[HardSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}',
		].join('\r\n') + '\r\n')
	})

	it('leaves out a normalization that would change a hash the edit didn\'t, and keeps one that changes only spent hashes', () => {
		const original = song([...header, '[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}', '[HardSingle]', '{', '  0 = N 0 0', '}'])
		const edited = lengthenExpertNote(original)
		// Stand-ins that change notes: the one on Hard changes Hard's hashes, which the edit didn't spend.
		const addNote = (section: string, line: string): SongNormalization => ({
			kind: 'order',
			section,
			apply: current => {
				if (current.chart?.format !== 'chart') return current
				const { tokens } = current.chart
				const index = tokens.sections.findIndex(candidate => candidate.name === section)
				const lines = chartSectionLines(tokens, tokens.sections[index])
				const edited = editChartLines(tokens, [{ kind: 'insert', section: index, beforeLine: lines.length - 1, text: line }])
				return { ...current, chart: { ...current.chart, tokens: edited } }
			},
		})
		const { files, report } = saveSong(original, edited, () => [addNote('ExpertSingle', '384 = N 2 0'), addNote('HardSingle', '384 = N 2 0')])
		expect(report.normalized).toEqual([{ kind: 'order', section: 'ExpertSingle' }])
		expect(report.withheld).toEqual([{ kind: 'order', section: 'HardSingle', hashes: ['canonical:guitar:hard'] }])
		const saved = parseSongFiles(files)
		expect(songHashes(saved)?.get('canonical:guitar:hard')).toBe(songHashes(original)?.get('canonical:guitar:hard'))
		expect(decode(fileBytes(files[0]))).toContain('384 = N 2 0\r\n}\r\n[HardSingle]')
	})

	it('leaves a section with bytes that aren\'t valid in the file\'s encoding as written, and never rewrites those bytes', () => {
		const latin1 = (text: string) => Uint8Array.from([...text].map(char => char.charCodeAt(0)))
		const text = ['[Song]', '{', '\tName = "Café"', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '\t0 = E "lyric Café"', '}', '[ExpertSingle]', '{', '\t0 = N 0 0', '\t192 = N 1 0', '}'].join('\n') + '\n'
		// A UTF-8 byte order mark, then a byte (0xE9) that isn't valid UTF-8.
		const bom = [0xef, 0xbb, 0xbf]
		const original = parseSongFiles([{ fileName: 'notes.chart', data: Uint8Array.from([...bom, ...latin1(text)]) }, songIni])
		const { files } = saveSong(original, lengthenExpertNote(original))
		const saved = fileBytes(files[0])
		// The two sections holding the invalid byte keep it, and every line ending gets its carriage return.
		expect(saved.filter(byte => byte === 0xe9).length).toBe(2)
		expect(saved).toEqual(Uint8Array.from([...bom, ...latin1(text.replaceAll('\n', '\r\n').replace('\t0 = N 0 0\r\n\t192 = N 1 0', '  0 = N 0 0\r\n  192 = N 1 96'))]))

		const tokens = original.chart?.format === 'chart' ? original.chart.tokens : null
		const lyricLine = { tick: 0, source: { format: 'chart' as const, section: 2, line: 1 } }
		expect(() => chartEventEdits(tokens!, lyricLine, { tick: 96 })).toThrow('can only be removed')
	})

	it('keeps the first section of a repeated name, which a reader uses, and adds song events to the first [Events]', () => {
		const original = song([
			...header,
			'[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}',
			'[Events]', '{', '  0 = E "section Unread"', '}',
			'[ExpertSingle]', '{', '  0 = N 4 0', '}',
		])
		expect(resolveChart(original).sections).toEqual([])
		const edited = editSong(lengthenExpertNote(original), batch => batch.addTextEvent(384, 'section Verse'))
		const { files, report } = saveSong(original, edited)
		expect(report.normalized).toEqual([{ kind: 'repeatedSections', section: 'Events' }, { kind: 'repeatedSections', section: 'ExpertSingle' }])
		expect(report.withheld).toEqual([])
		expect(decode(fileBytes(files[0]))).toBe([
			...header.slice(0, -1), '  384 = E "section Verse"', '}',
			'[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 96', '}',
		].join('\r\n') + '\r\n')
	})

	it('removes a body written without a header, which repeats the name of the section before it, and only that body', () => {
		const original = song([...header.slice(0, 10), '{', '}', ...header.slice(10), '[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}'])
		const tokens = original.chart?.format === 'chart' ? original.chart.tokens : null
		expect(tokens?.sections.map(section => section.name)).toEqual(['Song', 'SyncTrack', 'SyncTrack', 'Events', 'ExpertSingle'])
		const { files, report } = saveSong(original, lengthenExpertNote(original))
		expect(report.normalized).toEqual([{ kind: 'repeatedSections', section: 'SyncTrack' }])
		expect(decode(fileBytes(files[0]))).toBe([...header, '[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 96', '}'].join('\r\n') + '\r\n')
	})

	it('reads a file without a byte order mark that isn\'t valid UTF-8 as ISO-8859-1, and saves it in ISO-8859-1', () => {
		const latin1 = (text: string) => Uint8Array.from([...text].map(char => char.charCodeAt(0)))
		const text = [...header.slice(0, -3), '[Events]', '{', '\t0 = E "section Café"', '}', '[ExpertSingle]', '{', '\t0 = N 0 0', '\t192 = N 1 0', '}'].join('\n') + '\n'
		const original = parseSongFiles([{ fileName: 'notes.chart', data: latin1(text) }, songIni])
		const tokens = original.chart?.format === 'chart' ? original.chart.tokens : null
		expect(tokens?.encoding).toBe('iso-8859-1')
		expect(resolveChart(original).sections.map(section => section.name)).toEqual(['Café'])
		const { files } = saveSong(original, lengthenExpertNote(original))
		const saved = String.fromCharCode(...fileBytes(files[0]))
		expect(saved).toContain('  0 = E "section Café"\r\n')
		expect(saved).toContain('  192 = N 1 96\r\n')
	})

	it('normalizes an edited .mid file: a track keeps only the last of its tick-0 names, which Clone Hero reads', () => {
		const midi = writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
			tracks: [
				[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
				[
					{ deltaTime: 0, type: 'trackName', text: 'TEMPO TRACK' },
					{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
					{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
					{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
					{ deltaTime: 0, type: 'endOfTrack' },
				],
			],
		})
		const original = parseSongFiles([{ fileName: 'notes.mid', data: new Uint8Array(midi) }, songIni])
		const [green] = original.chart?.format === 'mid' && original.chart.tokens ? midiAuthoredTracks(original.chart.tokens)[0].events : []
		const { files, report } = saveSong(original, editSong(original, batch => batch.setLength(green, 240)))
		expect(report.normalized).toEqual([{ kind: 'trackNames', section: 'PART GUITAR' }])
		const saved = parseSongFiles(files)
		const guitar = saved.chart?.format === 'mid' && saved.chart.tokens?.chunks[1]
		expect(guitar && guitar.kind === 'track' ? guitar.events.filter(({ event }) => event.type === 'trackName').map(({ event }) => event.type === 'trackName' && event.text) : []).toEqual(['PART GUITAR'])
		expect(saved.chart?.format === 'mid' && saved.chart.tokens ? midiAuthoredTracks(saved.chart.tokens)[0].events.map(event => event.length) : []).toEqual([240])
	})

	it('turns a d flip off before a dnoflip, in .chart and .mid, keeping every canonical hash', () => {
		const drums = ['[ExpertDrums]', '{', '  480 = N 1 0', '  480 = E mix 3 drums1d', '  700 = N 2 0', '  960 = N 1 0', '  960 = E mix 3 drums0dnoflip', '}']
		const chart = song([...header, '[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}', ...drums])
		const editedChart = lengthenExpertNote(chart)
		const savedChart = saveSong(chart, editedChart)
		expect(savedChart.report.normalized).toEqual([{ kind: 'noflipDuringFlip', section: 'ExpertDrums' }])
		expect(decode(fileBytes(savedChart.files[0]))).toContain('  700 = N 2 0\r\n  959 = E mix 3 drums1\r\n  960 = N 1 0\r\n  960 = E mix 3 drums0dnoflip\r\n')
		expect(songHashes(parseSongFiles(savedChart.files))).toEqual(songHashes(editedChart))

		const mid = parseSongFiles([{ fileName: 'notes.mid', data: midiFile([
			{ name: 'PART GUITAR', events: midiNote(0, 96, 240) },
			{ name: 'PART DRUMS', events: [midiText(480, '[mix 3 drums1d]'), ...midiNote(480, 97), ...midiNote(700, 98), midiText(960, '[mix 3 drums0dnoflip]'), ...midiNote(960, 97)] },
		]) }, songIni])
		const [guitar] = authoredTracks(mid.chart!)
		const editedMid = editSong(mid, batch => batch.setLength(guitar.events[0], 480))
		const savedMid = saveSong(mid, editedMid)
		expect(savedMid.report.normalized).toEqual([{ kind: 'noflipDuringFlip', section: 'PART DRUMS' }])
		expect(trackTexts(parseMidi(fileBytes(savedMid.files[0])).tracks[2])).toEqual([[480, '[mix 3 drums1d]'], [959, 'mix 3 drums1'], [960, '[mix 3 drums0dnoflip]']])
		expect(songHashes(parseSongFiles(savedMid.files))).toEqual(songHashes(editedMid))
	})

	it('removes .chart modifiers with no note to apply to, keeping every canonical hash', () => {
		const original = song([
			...header,
			'[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '  193 = N 5 0', '  384 = N 6 0', '  384 = E solo', '}',
			'[ExpertDrums]', '{', '  0 = N 2 0', '  0 = N 66 0', '  0 = N 35 0', '  0 = N 36 0', '  192 = N 1 0', '  192 = N 67 0', '}',
		])
		const edited = lengthenExpertNote(original)
		const { files, report } = saveSong(original, edited)
		expect(report.normalized).toEqual([{ kind: 'modifiersWithoutNotes', section: 'ExpertSingle' }, { kind: 'modifiersWithoutNotes', section: 'ExpertDrums' }])
		expect(decode(fileBytes(files[0]))).toContain([
			'[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 96', '  384 = E solo', '}',
			'[ExpertDrums]', '{', '  0 = N 2 0', '  0 = N 66 0', '  0 = N 35 0', '  192 = N 1 0', '}',
		].join('\r\n'))
		expect(songHashes(parseSongFiles(files))).toEqual(songHashes(edited))
	})

	it('removes a song.ini key a later line of the same key replaces, in any letter case', () => {
		const ini = { fileName: 'song.ini', data: encode('[song]\r\nname = Old\r\nName = Test\r\nsong_length = 60000\r\n; comment\r\n') }
		const original = parseSongFiles([{ fileName: 'notes.chart', data: encode([...header, '[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}'].join('\r\n') + '\r\n') }, ini])
		const { files, report } = saveSong(original, lengthenExpertNote(original))
		expect(report.normalized).toEqual([{ kind: 'duplicateKeys', section: 'song.ini' }])
		expect(decode(fileBytes(files[1]))).toBe('[song]\r\nName = Test\r\nsong_length = 60000\r\n; comment\r\n')
	})

	it('keeps the canonical TrackHashes and SongHash, not the legacy ones', () => {
		const hashes = songHashes(song([...header, '[ExpertSingle]', '{', '  0 = N 0 0', '}']))
		expect([...hashes!.keys()].sort()).toEqual(['canonical:guitar:expert', 'canonical:song'])
	})
})
