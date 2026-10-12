import { describe, expect, it } from 'vitest'

import { parseSong } from 'src/song-document'
import { byteSourceFromBlob, ByteSource, SongFile } from 'src/song-files'
import { parseSongMetadata, songMetadata } from 'src/song-metadata'

const encode = (text: string) => new TextEncoder().encode(text)
const chart = encode('[Song]\r\n{\r\n  Name = "Chart <b>Name</b>"\r\n  Artist = "Chart Artist"\r\n  Year = ", 2002"\r\n'
	+ '  Difficulty = 4\r\n  Offset = 0.5604\r\n  PreviewStart = 45.28\r\n  Resolution = 192\r\n}\r\n'
	+ '[SyncTrack]\r\n{\r\n  0 = B 120000\r\n}\r\n[ExpertSingle]\r\n{\r\n  0 = N 0 0\r\n}\r\n')
const ini = encode('[song]\r\nname = Ini Name\r\nartist = Ini Artist\r\ndelay = 100\r\n')

/** A byte source that records each read, so a test can check what was read. */
function recorded(bytes: Uint8Array): ByteSource & { reads: number } {
	const source = byteSourceFromBlob(new Blob([bytes]))
	const counted = { size: source.size, reads: 0, read: (offset: number, length: number) => { counted.reads++; return source.read(offset, length) } }
	return counted
}

describe('song files', () => {
	it('can be byte sources; parsing reads the chart and song.ini, and leaves the audio unread', async () => {
		const audio = recorded(new Uint8Array(1000))
		const files: SongFile[] = [
			{ fileName: 'notes.chart', data: recorded(chart) },
			{ fileName: 'song.ini', data: recorded(ini) },
			{ fileName: 'song.ogg', data: audio },
		]
		const song = await parseSong(files)
		expect(song.chart?.format === 'chart' && song.chart.tokens.bytes).toEqual(chart)
		expect(song.ini?.tokens.bytes).toEqual(ini)
		expect(audio.reads).toBe(0)
		expect(song.files[2].data).toBe(audio)
	})

	it('give Clone Hero\'s metadata: song.ini when there is one', async () => {
		const { metadata, issues } = await parseSongMetadata([
			{ fileName: 'notes.chart', data: chart },
			{ fileName: 'song.ini', data: byteSourceFromBlob(new Blob([ini])) },
		])
		expect(metadata).toMatchObject({ name: 'Ini Name', artist: 'Ini Artist', album: 'Unknown Album', delay: 100, diff_guitar: -1, chartOffsetMs: 561 })
		expect(issues.map(issue => [issue.scope, issue.code])).toEqual([['metadata', 'missingValue'], ['metadata', 'missingValue'], ['metadata', 'missingValue'], ['metadata', 'missingValue']])
	})

	it('give [Song]\'s metadata when there\'s no song.ini, cleaned as song.ini values are', async () => {
		const { metadata, issues } = await parseSongMetadata([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ogg', data: new Uint8Array(0) }])
		expect(metadata).toMatchObject({ name: 'Chart Name', artist: 'Chart Artist', year: '2002', diff_guitar: 4, preview_start_time: 45280, chartOffsetMs: 561 })
		expect(issues).toEqual([{ scope: 'folder', code: 'noMetadata', instrument: null, difficulty: null, tick: null, msTime: null, message: 'This chart doesn\'t have "song.ini".' }])
	})

	it('give a song document\'s metadata the same way', async () => {
		const song = await parseSong([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: ini }])
		expect(songMetadata(song)).toEqual((await parseSongMetadata([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: ini }])).metadata)
	})
})
