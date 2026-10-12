import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { chartAuthoredTracks, midiAuthoredTracks } from 'src/chart/authored-view'
import { chartEventEdits, editChartLines } from 'src/chart/chart-edit'
import { chartSectionLines } from 'src/chart/chart-file-parser'
import { editSong, parseSong, SongDocument } from 'src/song-document'
import { saveSong, songHashes, SongNormalization } from 'src/song-save'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const songIni = { fileName: 'song.ini', data: encode('[song]\r\nname = Test\r\nsong_length = 60000\r\n') }

function song(lines: string[], lineEnding = '\r\n') {
	return parseSong([{ fileName: 'notes.chart', data: encode(lines.join(lineEnding) + lineEnding) }, songIni])
}
const header = ['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}', '[Events]', '{', '}']

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
		expect(decode(files[0].data)).toContain('192 = N 1 96\r\n')
	})

	it('normalizes an edited song where that changes no hash the edit didn\'t', () => {
		const original = song([
			...header,
			'[ExpertSingle]', '{', '\t0 = E "solo"', '\t0 = N 0 0', '\t192 = N 1 0', '\t384 = E "soloend"', '}',
			'[HardSingle]', '{', '\t192 = N 1 0', '\t0 = N 0 0', '\t0 = N 0 0', '}',
		], '\n')
		const { files, report } = saveSong(original, lengthenExpertNote(original))
		expect(report.spentHashes).toEqual(['canonical:guitar:expert', 'canonical:song', 'legacy:guitar:expert', 'legacy:song'])
		expect(report.withheld).toEqual([])
		expect(decode(files[0].data)).toBe([
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
		expect(report.withheld).toEqual([{ kind: 'order', section: 'HardSingle', hashes: ['canonical:guitar:hard', 'legacy:guitar:hard'] }])
		const saved = parseSong(files)
		expect(songHashes(saved)?.get('canonical:guitar:hard')).toBe(songHashes(original)?.get('canonical:guitar:hard'))
		expect(decode(files[0].data)).toContain('384 = N 2 0\r\n}\r\n[HardSingle]')
	})

	it('leaves a section with bytes that aren\'t valid UTF-8 as written, and never rewrites those bytes', () => {
		const latin1 = (text: string) => Uint8Array.from([...text].map(char => char.charCodeAt(0)))
		const text = ['[Song]', '{', '\tName = "Café"', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '\t0 = E "lyric Café"', '}', '[ExpertSingle]', '{', '\t0 = N 0 0', '\t192 = N 1 0', '}'].join('\n') + '\n'
		const original = parseSong([{ fileName: 'notes.chart', data: latin1(text) }, songIni])
		const { files } = saveSong(original, lengthenExpertNote(original))
		const saved = files[0].data
		// The two sections holding the invalid byte (0xE9) keep it, and every line ending gets its carriage return.
		expect(saved.filter(byte => byte === 0xe9).length).toBe(2)
		expect(saved).toEqual(latin1(text.replaceAll('\n', '\r\n').replace('\t0 = N 0 0\r\n\t192 = N 1 0', '  0 = N 0 0\r\n  192 = N 1 96')))

		const tokens = original.chart?.format === 'chart' ? original.chart.tokens : null
		const lyricLine = { tick: 0, source: { format: 'chart' as const, section: 2, line: 1 } }
		expect(() => chartEventEdits(tokens!, lyricLine, { tick: 96 })).toThrow('can only be removed')
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
		const original = parseSong([{ fileName: 'notes.mid', data: new Uint8Array(midi) }, songIni])
		const [green] = original.chart?.format === 'mid' && original.chart.tokens ? midiAuthoredTracks(original.chart.tokens)[0].events : []
		const { files, report } = saveSong(original, editSong(original, batch => batch.setLength(green, 240)))
		expect(report.normalized).toEqual([{ kind: 'trackNames', section: 'PART GUITAR' }])
		const saved = parseSong(files)
		const guitar = saved.chart?.format === 'mid' && saved.chart.tokens?.chunks[1]
		expect(guitar && guitar.kind === 'track' ? guitar.events.filter(({ event }) => event.type === 'trackName').map(({ event }) => event.type === 'trackName' && event.text) : []).toEqual(['PART GUITAR'])
		expect(saved.chart?.format === 'mid' && saved.chart.tokens ? midiAuthoredTracks(saved.chart.tokens)[0].events.map(event => event.length) : []).toEqual([240])
	})

	it('removes a song.ini key a later line of the same key replaces, in any letter case', () => {
		const ini = { fileName: 'song.ini', data: encode('[song]\r\nname = Old\r\nName = Test\r\nsong_length = 60000\r\n; comment\r\n') }
		const original = parseSong([{ fileName: 'notes.chart', data: encode([...header, '[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}'].join('\r\n') + '\r\n') }, ini])
		const { files, report } = saveSong(original, lengthenExpertNote(original))
		expect(report.normalized).toEqual([{ kind: 'duplicateKeys', section: 'song.ini' }])
		expect(decode(files[1].data)).toBe('[song]\r\nName = Test\r\nsong_length = 60000\r\n; comment\r\n')
	})

	it('hashes a song as the reference tool does: canonical and legacy TrackHashes and SongHashes', () => {
		const hashes = songHashes(song([...header, '[ExpertSingle]', '{', '  0 = N 0 0', '}']))
		expect([...hashes!.keys()].sort()).toEqual(['canonical:guitar:expert', 'canonical:song', 'legacy:guitar:expert', 'legacy:song'])
	})
})
