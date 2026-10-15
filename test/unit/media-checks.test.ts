import { describe, expect, it } from 'vitest'

import { scanSongFolder, type ScanOptions } from 'src/scan-song-folder'
import type { SongFile } from 'src/song-files'

const encode = (text: string) => new TextEncoder().encode(text)
const ascii = (text: string) => [...text].map(character => character.charCodeAt(0))
const concat = (...parts: (Uint8Array | number[])[]) => {
	const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
	let at = 0
	for (const part of parts) {
		bytes.set(part, at)
		at += part.length
	}
	return bytes
}
const le32 = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255]
const le16 = (value: number) => [value & 255, (value >> 8) & 255]
const be32 = (value: number) => [(value >>> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255]

function oggPage(granule: number, body: Uint8Array, flags = 0) {
	const lacing = [...Array(Math.floor(body.length / 255)).fill(255), body.length % 255]
	return concat(ascii('OggS'), [0, flags], le32(granule), le32(0), le32(7), le32(0), le32(0), [lacing.length], lacing, body)
}
/** Ten seconds of Ogg Opus audio averaging about `kbps`. */
function opus(kbps: number) {
	const head = oggPage(0, concat(ascii('OpusHead'), [1, 2], le16(0), le32(48000), [0, 0, 0]), 2)
	const bytes = kbps * 1000 / 8 * 10
	const pages = Math.ceil(bytes / 60000)
	return concat(head, ...Array.from({ length: pages }, (_, page) => oggPage((page + 1) * 480000 / pages, new Uint8Array(bytes / pages))))
}
/** Ogg Vorbis audio of `seconds`, whose header names a nominal bitrate. */
function vorbis(nominalKbps: number, seconds = 10) {
	const id = concat([1], ascii('vorbis'), le32(0), [2], le32(44100), le32(0), le32(nominalKbps * 1000), le32(0), [0xb8, 1])
	return concat(oggPage(0, id, 2), oggPage(44100 * seconds, new Uint8Array(1000)))
}
function png(width: number, height: number) {
	return concat([0x89, ...ascii('PNG'), 13, 10, 26, 10], be32(13), ascii('IHDR'), be32(width), be32(height), [8, 6, 0, 0, 0], be32(0), be32(0), ascii('IEND'), be32(0))
}
const jpeg = (width: number, height: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])
function webm(codec: string) {
	const element = (id: number[], data: Uint8Array | number[]) => concat(id, [0x80 | data.length], data)
	const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], ascii('webm')))
	const tracks = element([0x16, 0x54, 0xae, 0x6b], element([0xae], concat(element([0x83], [1]), element([0x86], ascii(codec)))))
	return concat(header, [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], tracks)
}

const chart = encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}',
	'[ExpertSingle]', '{', '  768 = N 0 0', '}'].join('\r\n') + '\r\n')
/** A file as a byte source that counts its reads. */
let reads = 0
const file = (fileName: string, bytes: Uint8Array): SongFile => {
	const blob = new Blob([bytes as Uint8Array<ArrayBuffer>])
	return { fileName, data: { size: blob.size, read: async (offset, length) => (reads++, new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())) } }
}
async function mediaIssues(files: SongFile[], codes: readonly string[], options: ScanOptions = { mediaIssues: true }, ini = '[song]\r\nname = Song\r\n') {
	const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: encode(ini) }, ...files], options)
	return scanned.issues.filter(issue => codes.includes(issue.code)).map(issue => [issue.code, issue.file, issue.message])
}

describe('media checks', () => {
	it('read nothing unless mediaIssues asks for them', async () => {
		reads = 0
		const files = [file('song.ogg', opus(120)), file('album.png', jpeg(500, 500)), file('background.jpg', jpeg(800, 450)), file('video.webm', webm('V_VP9'))]
		expect(await mediaIssues(files, ['extensionMismatch', 'audioBitrate', 'albumArtSize', 'backgroundSize', 'videoCodec'], {})).toEqual([])
		expect(reads).toBe(0)
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

	it('warn about a .webm video that isn\'t VP8', async () => {
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, file('video.webm', webm('V_VP9'))], { mediaIssues: true })
		expect(scanned.issues.filter(issue => issue.code === 'videoCodec').map(issue => [issue.severity, issue.message]))
			.toEqual([['warning', '"video.webm" uses the VP9 codec, which Clone Hero can\'t play. Re-encode it with VP8.']])
		expect(await mediaIssues([file('video.webm', webm('V_VP8'))], ['videoCodec'])).toEqual([])
	})
})
