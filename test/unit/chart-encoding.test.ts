import { describe, expect, it } from 'vitest'

import { chartAuthoredTracks } from 'src/chart/authored-view'
import { detectChartEncoding, encodeChartText } from 'src/chart/chart-encoding'
import { resolveChart } from 'src/gameplay-chart'
import { documentFiles, editSong, parseSongFiles } from 'src/song-document'
import { fileBytes } from 'src/song-files'

const chart = ['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}',
	'[Events]', '{', '  0 = E "section Café 🎸"', '}', '[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}', ''].join('\r\n')

describe('.chart encodings', () => {
	it('detects each byte order mark, checking UTF-32 before UTF-16', () => {
		const detect = (...bytes: number[]) => detectChartEncoding(Uint8Array.from(bytes))
		expect(detect(0x00, 0x00, 0xfe, 0xff, 0x41)).toEqual({ encoding: 'utf-32be', bomLength: 4 })
		expect(detect(0xff, 0xfe, 0x00, 0x00, 0x41)).toEqual({ encoding: 'utf-32le', bomLength: 4 })
		expect(detect(0xff, 0xfe, 0x41, 0x00)).toEqual({ encoding: 'utf-16le', bomLength: 2 })
		expect(detect(0xfe, 0xff, 0x00, 0x41)).toEqual({ encoding: 'utf-16be', bomLength: 2 })
		expect(detect(0xef, 0xbb, 0xbf, 0x41)).toEqual({ encoding: 'utf-8', bomLength: 3 })
		expect(detect(0x43, 0x61, 0x66, 0xc3, 0xa9)).toEqual({ encoding: 'utf-8', bomLength: 0 })
		expect(detect(0x43, 0x61, 0x66, 0xe9)).toEqual({ encoding: 'iso-8859-1', bomLength: 0 })
	})

	for (const [encoding, bom] of [['utf-32le', [0xff, 0xfe, 0x00, 0x00]], ['utf-32be', [0x00, 0x00, 0xfe, 0xff]], ['utf-16be', [0xfe, 0xff]]] as const) {
		it(`reads and edits a ${encoding} file, keeping its encoding`, () => {
			const song = parseSongFiles([{ fileName: 'notes.chart', data: Uint8Array.from([...bom, ...encodeChartText(chart, encoding)]) }])
			expect(resolveChart(song).sections.map(section => section.name)).toEqual(['Café 🎸'])
			const expert = chartAuthoredTracks(song.chart?.format === 'chart' ? song.chart.tokens : null!).find(track => track.sectionName === 'ExpertSingle')!
			const edited = editSong(song, batch => batch.setLength(expert.events[1], 96))
			const saved = fileBytes(documentFiles(edited)[0])
			expect([...saved.subarray(0, bom.length)]).toEqual([...bom])
			expect(saved.subarray(bom.length)).toEqual(encodeChartText(chart.replace('192 = N 1 0', '192 = N 1 96'), encoding))
		})
	}

	it('reads a file that isn\'t valid UTF-8 as ISO-8859-1, byte for byte, and refuses an edit it can\'t hold', () => {
		const latin1 = Uint8Array.from([...chart.replace(' 🎸', '')].map(char => char.charCodeAt(0)))
		const song = parseSongFiles([{ fileName: 'notes.chart', data: latin1 }])
		expect(resolveChart(song).sections.map(section => section.name)).toEqual(['Café'])
		expect(() => editSong(song, batch => batch.addTextEvent(768, 'section 🎸'))).toThrow('ISO-8859-1')
		const edited = editSong(song, batch => batch.addTextEvent(768, 'section Été'))
		expect(String.fromCharCode(...fileBytes(documentFiles(edited)[0]))).toContain('768 = E "section Été"')
	})
})
