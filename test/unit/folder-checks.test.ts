import { describe, expect, it } from 'vitest'

import { audioNameRecommendations } from 'src/assets/scan-audio'
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

const named = (...names: string[]) => names.map(fileName => ({ fileName, data: new Uint8Array(1) }))

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

describe('files games don\'t read', () => {
	const unrecognized = async (files: SongFile[], options: ScanOptions = {}) =>
		(await issuesOf(files, ['unrecognizedFile'], options)).map(([, file]) => file)

	it('reports a file no game reads', async () => {
		expect(await issuesOf(named('notes.eof'), ['unrecognizedFile']))
			.toEqual([['unrecognizedFile', 'notes.eof', '"notes.eof" isn\'t read by the games. Remove it from the chart folder.']])
		expect(await unrecognized(named('ch.dat', 'banner.png', 'foo.aiff', 'readme.txt', 'song.ogg.sfk'))).toEqual(['ch.dat', 'banner.png', 'foo.aiff', 'readme.txt', 'song.ogg.sfk'])
	})

	it('accepts every file Clone Hero or YARG reads, in any letter case', async () => {
		expect(await unrecognized(named(
			'song.ogg', 'DRUMS.aiff', 'album.tga', 'highway.png', 'background1.jpg', 'my background.png', 'BG.png', 'bg_clean.gif',
			'video.webm', 'background_explicit.mov', 'bg.yarground', 'notes.midi', 'notes.txt', 'other song.sng', 'sub/video.mp4',
		))).toEqual([])
	})

	it('accepts the files song.ini\'s background, video and cover keys name, which YARG reads', async () => {
		const ini = encode('[song]\r\nname = Song\r\nvideo = My Clip.mov\r\ncover = front.webp\r\n')
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: ini }, ...named('my clip.mov', 'front.webp', 'back.webp')])
		expect(scanned.issues.filter(issue => issue.code === 'unrecognizedFile').map(issue => issue.file)).toEqual(['back.webp'])
	})

	it('leaves a misnamed chart, .ini or audio file to the issue that reports it', async () => {
		expect(await unrecognized(named('original.mid', 'song (1).ini', 'band.ogg', 'sub/song.opus'))).toEqual([])
	})

	it('reports YARG\'s clean and explicit stems as neither misnamed nor the song\'s audio', async () => {
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, ...named('song_clean.ogg', 'vocals_explicit.opus', 'band.ogg')])
		expect(scanned.issues.filter(issue => ['invalidAudio', 'unrecognizedFile', 'noAudio'].includes(issue.code)).map(issue => [issue.code, issue.file]))
			.toEqual([['invalidAudio', 'band.ogg'], ['noAudio', null]])
	})

	it('accepts the files extraFiles lists', async () => {
		expect(await unrecognized(named('CH.DAT', 'notes.eof', 'notes.backup.eof', 'readme.txt'), { extraFiles: ['ch.dat', /\.eof$/] })).toEqual(['readme.txt'])
	})

	it('always reports a file an operating system made, saying no program needs it', async () => {
		const files = named('desktop.ini', 'Thumbs.db', '.DS_Store', '__MACOSX/song.ini', '._album.png')
		expect(await unrecognized(files, { extraFiles: [/./] })).toEqual(['desktop.ini', 'Thumbs.db', '.DS_Store', '__MACOSX/song.ini', '._album.png'])
		expect((await issuesOf(named('Thumbs.db'), ['unrecognizedFile']))[0][2])
			.toBe('"Thumbs.db" is a file the operating system made, and no program needs it. Remove it from the chart folder.')
	})

	it('reports a file in a subfolder, except a video Clone Hero finds there', async () => {
		expect(await unrecognized(named('extras/readme.txt', 'extras/video.webm'))).toEqual(['extras/readme.txt'])
	})
})

describe('file name letter case', () => {
	it('reports an album art, background or video name that matches only in lowercase', async () => {
		expect(await issuesOf(named('Album.png', 'BACKGROUND.jpg', 'Video.webm', 'Highway.png', 'Song.ogg', 'BG.png'), ['fileNameCase'])).toEqual([
			['fileNameCase', 'Album.png', '"Album.png" should be named "album.png". Song folder file names are lowercase, and some games and tools find only lowercase names.'],
			['fileNameCase', 'BACKGROUND.jpg', '"BACKGROUND.jpg" should be named "background.jpg". Song folder file names are lowercase, and some games and tools find only lowercase names.'],
			['fileNameCase', 'Video.webm', '"Video.webm" should be named "video.webm". Song folder file names are lowercase, and some games and tools find only lowercase names.'],
			['fileNameCase', 'BG.png', '"BG.png" should be named "bg.png". Song folder file names are lowercase, and some games and tools find only lowercase names.'],
		])
	})
})

describe('folder size', () => {
	it('reports a folder over the 3 GB Chorus Encore scans', async () => {
		expect(await issuesOf([{ fileName: 'video.webm', data: { size: 2.9e9, read: () => Promise.reject(new Error('read')) } }], ['folderSize'])).toEqual([])
		expect(await issuesOf([{ fileName: 'video.webm', data: { size: 3.2e9, read: () => Promise.reject(new Error('read')) } }], ['folderSize'])).toEqual([[
			'folderSize', null, 'This chart\'s files total 3.2 GB. Chorus Encore scans charts only up to 3 GB, so also share a smaller version, such as one without the video background.',
		]])
	})
})

describe('audio names', () => {
	const codes = ['audioFormat', 'singleAudioName', 'discouragedAudio']

	it('recommends Opus audio', async () => {
		expect(await issuesOf(named('song.opus', 'guitar.ogg'), codes))
			.toEqual([['audioFormat', 'guitar.ogg', '"guitar.ogg" isn\'t Opus. .opus is the recommended audio format: it\'s the smallest at the same quality.']])
	})

	it('recommends naming a lone audio file "song", and accepts "guitar"', async () => {
		expect(await issuesOf(named('song.opus'), codes)).toEqual([])
		expect(await issuesOf(named('guitar.opus', 'preview.opus'), ['singleAudioName'])).toEqual([])
		expect(await issuesOf(named('drums.opus', 'crowd.opus'), ['singleAudioName']))
			.toEqual([['singleAudioName', 'drums.opus', 'This chart\'s only audio file is "drums.opus". The audio of a chart without stems is named "song".']])
		expect(await issuesOf(named('drums.opus', 'bass.opus'), ['singleAudioName'])).toEqual([])
	})

	it('discourages crowd and preview audio', async () => {
		expect(await issuesOf(named('song.opus', 'crowd.opus', 'preview.opus'), codes)).toEqual([
			['discouragedAudio', 'crowd.opus', '"crowd.opus" is discouraged by the charting guidelines.'],
			['discouragedAudio', 'preview.opus', '"preview.opus" is discouraged. Set "preview_start_time" in song.ini instead, so games play the preview from the song\'s audio.'],
		])
	})

	it('reads the names in any letter case', () => {
		const issues = audioNameRecommendations(named('Song.OPUS', 'CROWD.opus')).map(issue => [issue.folderIssue, issue.file])
		expect(issues).toEqual([['discouragedAudio', 'CROWD.opus']])
	})
})
