import { beforeEach, describe, expect, it } from 'vitest'

import { scanSongFolder, type ScanOptions } from 'src/scan-song-folder'
import type { SongFile } from 'src/song-files'

import { byteSourceFile, jpeg, opus, png, vorbis, webm } from './helpers/media-files'

const encode = (text: string) => new TextEncoder().encode(text)

const chart = encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}',
	'[ExpertSingle]', '{', '  768 = N 0 0', '}'].join('\r\n') + '\r\n')
const reads = { count: 0 }
beforeEach(() => {
	reads.count = 0
})
const file = (fileName: string, bytes: Uint8Array) => byteSourceFile(fileName, bytes, reads)
async function mediaIssues(files: SongFile[], codes: readonly string[], options: ScanOptions = { mediaIssues: true }, ini = '[song]\r\nname = Song\r\n') {
	const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: encode(ini) }, ...files], options)
	return scanned.issues.filter(issue => codes.includes(issue.code)).map(issue => [issue.code, issue.file, issue.message])
}

describe('media checks', () => {
	it('read nothing unless mediaIssues asks for them', async () => {
		const files = [file('song.ogg', opus(120)), file('album.png', jpeg(500, 500)), file('background.jpg', jpeg(800, 450)), file('video.webm', webm('V_VP9'))]
		expect(await mediaIssues(files, ['extensionMismatch', 'audioBitrate', 'albumArtSize', 'backgroundSize', 'videoCodec'], {})).toEqual([])
		expect(reads.count).toBe(0)
	})

	it('report an extension that doesn\'t match the content, and an .ogg file of Opus audio only for that', async () => {
		const files = [file('song.ogg', opus(80)), file('album.png', jpeg(512, 512)), file('guitar.mp3', vorbis(256))]
		expect(await mediaIssues(files, ['extensionMismatch', 'audioFormat'])).toEqual([
			['audioFormat', 'guitar.mp3', '"guitar.mp3" isn\'t Opus. .opus is the recommended audio format: it\'s the smallest at the same quality.'],
			['extensionMismatch', 'song.ogg', '"song.ogg" holds Opus audio. Rename it to "song.opus".'],
			['extensionMismatch', 'guitar.mp3', '"guitar.mp3" holds Ogg Vorbis audio. Rename it to "guitar.ogg".'],
			['extensionMismatch', 'album.png', '"album.png" holds a JPEG image. Rename it to "album.jpg".'],
		])
	})

	it('report an Opus file above 100 kbps, and a lone one below 60', async () => {
		expect(await mediaIssues([file('song.opus', opus(120))], ['audioBitrate']))
			.toEqual([['audioBitrate', 'song.opus', '"song.opus" averages 121 kbps. Opus audio should be about 80 kbps.']])
		expect(await mediaIssues([file('song.opus', opus(40))], ['audioBitrate']))
			.toEqual([['audioBitrate', 'song.opus', '"song.opus" averages 40 kbps. Opus audio should be about 80 kbps.']])
		// A quiet stem averages less than it was encoded at.
		expect(await mediaIssues([file('song.opus', opus(80)), file('drums.opus', opus(40))], ['audioBitrate'])).toEqual([])
	})

	it('report Ogg Vorbis encoded outside 192 to 320 kbps', async () => {
		expect(await mediaIssues([file('song.ogg', vorbis(128))], ['audioBitrate']))
			.toEqual([['audioBitrate', 'song.ogg', '"song.ogg" is encoded at 128 kbps. Ogg Vorbis audio should be 192 to 320 kbps.']])
		expect(await mediaIssues([file('song.ogg', vorbis(256))], ['audioBitrate'])).toEqual([])
	})

	it('report a song_length more than a second from the longest audio file', async () => {
		const files = [file('song.opus', opus(80)), file('guitar.ogg', vorbis(256, 12)), file('preview.ogg', vorbis(256, 30))]
		expect(await mediaIssues(files, ['songLengthMismatch'], { mediaIssues: true }, '[song]\r\nsong_length = 10000\r\n')).toEqual([['songLengthMismatch', 'song.ini',
			'The "song_length" value is 10000, but the longest audio file is 12000 ms long. Set song_length to the longest audio file\'s length.']])
		expect(await mediaIssues(files, ['songLengthMismatch'], { mediaIssues: true }, '[song]\r\nsong_length = 12500\r\n')).toEqual([])
	})

	it('report album art and background images by their size', async () => {
		const files = [file('album.png', png(500, 500)), file('background.jpg', jpeg(800, 450)), file('background2.jpg', jpeg(1920, 1080))]
		expect(await mediaIssues(files, ['albumArtSize', 'backgroundSize'])).toEqual([
			['albumArtSize', 'album.png', 'This chart\'s album art is 500x500, and should be 512x512.'],
			['backgroundSize', 'background.jpg', '"background.jpg" is 800x450. Background images should be at least 1280x720.'],
		])
	})

	it('warn about a .webm video a game reads that isn\'t VP8, in any letter case, and in a subfolder', async () => {
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, file('video.webm', webm('V_VP9'))], { mediaIssues: true })
		expect(scanned.issues.filter(issue => issue.code === 'videoCodec').map(issue => [issue.severity, issue.message]))
			.toEqual([['warning', '"video.webm" uses the VP9 codec. Clone Hero plays only VP8 in a .webm file: re-encode it with VP8.']])
		expect(await mediaIssues([file('video.webm', webm('V_VP8'))], ['videoCodec'])).toEqual([])
		const names = ['Video.WEBM', 'bg_clean.webm', 'background.webm', 'extras/video.webm', 'other.webm', 'extras/bg.webm']
		expect((await mediaIssues(names.map(name => file(name, webm('V_AV1'))), ['videoCodec'])).map(([, name]) => name))
			.toEqual(['Video.WEBM', 'bg_clean.webm', 'background.webm', 'extras/video.webm'])
	})
})
