import { describe, expect, it } from 'vitest'

import { contentType, readAudioInfo, readWebmVideoCodec } from 'src/assets/media-headers'

import { ascii, be32, byteSourceFile as file, concat, ebmlElement, le16, le32, oggPage, opusHead, vorbis, webmHeader, webmSegment, webmTracks } from './helpers/media-files'

describe('media headers', () => {
	it('tells content apart by its first bytes', () => {
		expect(contentType(opusHead(312))).toBe('opus')
		expect(contentType(concat(ascii('ID3'), [4, 0, 0, 0, 0, 0, 0]))).toBe('mp3')
		expect(contentType(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3')
		expect(contentType(concat(ascii('RIFF'), le32(0), ascii('WAVE')))).toBe('wav')
		expect(contentType(new Uint8Array([0x89, ...ascii('PNG'), 13, 10, 26, 10]))).toBe('png')
		expect(contentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
		expect(contentType(concat(ascii('fLaC')))).toBe('flac')
		expect(contentType(new Uint8Array([1, 2, 3, 4]))).toBeNull()
	})

	it('reads an Ogg Opus file\'s length after its pre-skip, and its bitrate without the headers', async () => {
		const tags = oggPage(0, concat(ascii('OpusTags'), new Uint8Array(5000)))
		// 10 seconds of audio in four pages of 25,126 bytes.
		const audio = [1, 2, 3, 4].map(page => oggPage(312 + page * 120000, new Uint8Array(25000)))
		const info = await readAudioInfo(file('song.opus', concat(opusHead(312), tags, ...audio)))
		expect(info).toEqual({ format: 'opus', durationMs: 10000, averageKbps: 80.4032, nominalKbps: null })
	})

	it('reads an Ogg Vorbis file\'s length and nominal bitrate', async () => {
		expect(await readAudioInfo(file('song.ogg', vorbis(192, 5)))).toMatchObject({ format: 'vorbis', durationMs: 5000, nominalKbps: 192 })
	})

	it('reads a WAV file\'s length from its data chunk, past other chunks', async () => {
		const fmt = concat(ascii('fmt '), le32(16), le16(1), le16(2), le32(44100), le32(176400), le16(4), le16(16))
		const bytes = concat(ascii('RIFF'), le32(0), ascii('WAVE'), fmt, ascii('LIST'), le32(3), [1, 2, 3, 0], ascii('data'), le32(176400 * 2), new Uint8Array(176400 * 2))
		expect(await readAudioInfo(file('song.wav', bytes))).toMatchObject({ format: 'wav', durationMs: 2000 })
	})

	it('estimates a constant-bitrate MP3 file\'s length from its size, after an ID3 tag', async () => {
		// MPEG-1 layer III at 128 kbps and 44.1 kHz: 417-byte frames.
		const frame = concat([0xff, 0xfb, 0x90, 0x00], new Uint8Array(413))
		const bytes = concat(ascii('ID3'), [4, 0, 0, 0, 0, 0, 20], new Uint8Array(20), ...Array(100).fill(frame))
		const info = await readAudioInfo(file('song.mp3', bytes))
		expect(info).toMatchObject({ format: 'mp3', durationMs: 41700 * 8 / 128, nominalKbps: null })
		expect(info?.averageKbps).toBeCloseTo(128, 9)
	})

	it('reads a variable-bitrate MP3 file\'s length from its Xing frame count', async () => {
		const xing = concat([0xff, 0xfb, 0x90, 0x00], new Uint8Array(32), ascii('Xing'), be32(1), be32(1000), new Uint8Array(413 - 44))
		const frame = concat([0xff, 0xfb, 0x90, 0x00], new Uint8Array(413))
		const info = await readAudioInfo(file('song.mp3', concat(xing, frame, frame)))
		expect(info?.durationMs).toBeCloseTo(1000 * 1152 / 44100 * 1000, 6)
	})

	it('reads a WebM file\'s video codec, finding the tracks through the seek head', async () => {
		const tracks = webmTracks('V_VP9')
		const cluster = ebmlElement([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(20))
		const seekHeadFor = (position: number) => ebmlElement([0x11, 0x4d, 0x9b, 0x74],
			ebmlElement([0x4d, 0xbb], concat(ebmlElement([0x53, 0xab], [0x16, 0x54, 0xae, 0x6b]), ebmlElement([0x53, 0xac], [position]))))
		expect(await readWebmVideoCodec(file('video.webm', concat(webmHeader, webmSegment, tracks, cluster)))).toBe('V_VP9')
		const seekHead = seekHeadFor(seekHeadFor(0).length + cluster.length)
		expect(await readWebmVideoCodec(file('video.webm', concat(webmHeader, webmSegment, seekHead, cluster, tracks)))).toBe('V_VP9')
	})
})
