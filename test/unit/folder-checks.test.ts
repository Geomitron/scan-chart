import { describe, expect, it } from 'vitest'

import { scanSongFolder, type ScanOptions } from 'src/scan-song-folder'
import type { SongFile } from 'src/song-files'

const encode = (text: string) => new TextEncoder().encode(text)
const chart = encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}',
	'[ExpertSingle]', '{', '  768 = N 0 0', '}'].join('\r\n') + '\r\n')
const songIni = encode('[song]\r\nname = Song\r\nartist = Artist\r\n')

/** A PNG file's signature and IHDR chunk: enough for its dimensions. */
function png(width: number, height: number) {
	const bytes = new Uint8Array(45)
	const view = new DataView(bytes.buffer)
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	view.setUint32(8, 13)
	bytes.set(encode('IHDR'), 12)
	view.setUint32(16, width)
	view.setUint32(20, height)
	bytes.set([8, 6, 0, 0, 0], 24)
	bytes.set(encode('IEND'), 37)
	return bytes
}

/** The issues of a song folder with a chart, song.ini and `files`, as `[code, file, message]`, for the codes asked for. */
async function issuesOf(files: SongFile[], codes: readonly string[], options: ScanOptions = {}) {
	const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: songIni }, ...files], options)
	return scanned.issues.filter(issue => codes.includes(issue.code)).map(issue => [issue.code, issue.file, issue.message])
}

describe('album art', () => {
	const sizeCodes = ['albumArtSize', 'badAlbumArt']

	it('checks the album art names without reading the art', async () => {
		const unread = { size: 3, read: () => Promise.reject(new Error('read')) }
		expect(await issuesOf([], ['noAlbumArt', 'multipleAlbumArt'])).toEqual([['noAlbumArt', null, 'This chart doesn\'t have album art.']])
		expect(await issuesOf([{ fileName: 'album.png', data: unread }, { fileName: 'album.jpg', data: unread }], ['noAlbumArt', 'multipleAlbumArt']))
			.toEqual([['multipleAlbumArt', null, 'This chart has multiple album art files.']])
	})

	it('accepts a 512x512 square by default, and reports another size width first', async () => {
		expect(await issuesOf([{ fileName: 'album.png', data: png(512, 512) }], sizeCodes, { albumArt: true })).toEqual([])
		expect(await issuesOf([{ fileName: 'album.png', data: png(500, 500) }], sizeCodes, { albumArt: true }))
			.toEqual([['albumArtSize', 'album.png', 'This chart\'s album art is 500x500, and should be 512x512.']])
		expect(await issuesOf([{ fileName: 'album.png', data: png(600, 400) }], sizeCodes, { albumArt: true }))
			.toEqual([['albumArtSize', 'album.png', 'This chart\'s album art is 600x400, and should be 512x512.']])
	})

	it('accepts the sizes albumArtSizes lists', async () => {
		const options = { albumArt: true, albumArtSizes: [500, 512] }
		expect(await issuesOf([{ fileName: 'album.png', data: png(500, 500) }], sizeCodes, options)).toEqual([])
		expect(await issuesOf([{ fileName: 'album.png', data: png(256, 256) }], sizeCodes, options))
			.toEqual([['albumArtSize', 'album.png', 'This chart\'s album art is 256x256, and should be 500x500 or 512x512.']])
		expect(await issuesOf([{ fileName: 'album.png', data: png(256, 256) }], sizeCodes, { albumArt: true, albumArtSizes: [] })).toEqual([])
		expect(await issuesOf([{ fileName: 'album.png', data: png(256, 200) }], sizeCodes, { albumArt: true, albumArtSizes: [] }))
			.toEqual([['albumArtSize', 'album.png', 'This chart\'s album art is 256x200, and should be square.']])
	})
})
