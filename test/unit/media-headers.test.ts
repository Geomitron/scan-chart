import { describe, expect, it } from 'vitest'

import { contentType, readAudioInfo, readWebmVideoCodec } from 'src/assets/media-headers'
import { byteSourceFromBlob } from 'src/song-files'

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
/** A file as a byte source, so it's read the way a large file is. */
const file = (fileName: string, bytes: Uint8Array) => ({ fileName, data: byteSourceFromBlob(new Blob([bytes as Uint8Array<ArrayBuffer>])) })

/** An Ogg page holding `body`, with its granule position. */
function oggPage(granule: number, body: Uint8Array, flags = 0) {
	const lacing = [...Array(Math.floor(body.length / 255)).fill(255), body.length % 255]
	return concat(ascii('OggS'), [0, flags], le32(granule), le32(0), le32(7), le32(0), le32(0), [lacing.length], lacing, body)
}

describe('media headers', () => {
	it('tells content apart by its first bytes', () => {
		const opus = oggPage(0, concat(ascii('OpusHead'), [1, 2], le16(312), le32(48000), [0, 0, 0]), 2)
		expect(contentType(opus)).toBe('opus')
		expect(contentType(concat(ascii('ID3'), [4, 0, 0, 0, 0, 0, 0]))).toBe('mp3')
		expect(contentType(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3')
		expect(contentType(concat(ascii('RIFF'), le32(0), ascii('WAVE')))).toBe('wav')
		expect(contentType(new Uint8Array([0x89, ...ascii('PNG'), 13, 10, 26, 10]))).toBe('png')
		expect(contentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
		expect(contentType(concat(ascii('fLaC')))).toBe('flac')
		expect(contentType(new Uint8Array([1, 2, 3, 4]))).toBeNull()
	})

	it('reads an Ogg Opus file\'s length after its pre-skip, and its bitrate without the headers', async () => {
		const head = oggPage(0, concat(ascii('OpusHead'), [1, 2], le16(312), le32(48000), [0, 0, 0]), 2)
		const tags = oggPage(0, concat(ascii('OpusTags'), new Uint8Array(5000)))
		// 10 seconds of audio in four pages.
		const audio = [1, 2, 3, 4].map(page => oggPage(312 + page * 120000, new Uint8Array(25000)))
		const info = await readAudioInfo(file('song.opus', concat(head, tags, ...audio)))
		const audioBytes = audio.reduce((total, page) => total + page.length, 0)
		expect(info).toEqual({ format: 'opus', durationMs: 10000, averageKbps: audioBytes * 8 / 10 / 1000, nominalKbps: null })
	})

	it('reads an Ogg Vorbis file\'s length and nominal bitrate', async () => {
		const id = concat([1], ascii('vorbis'), le32(0), [2], le32(44100), le32(0), le32(192000), le32(0), [0xb8, 1])
		const bytes = concat(oggPage(0, id, 2), oggPage(44100 * 5, new Uint8Array(1000)))
		expect(await readAudioInfo(file('song.ogg', bytes))).toMatchObject({ format: 'vorbis', durationMs: 5000, nominalKbps: 192 })
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
		const element = (id: number[], data: Uint8Array | number[]) => concat(id, [0x80 | data.length], data)
		const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], ascii('webm')))
		const tracks = element([0x16, 0x54, 0xae, 0x6b], element([0xae], concat(element([0x83], [1]), element([0x86], ascii('V_VP9')))))
		const cluster = element([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(20))
		const seekHeadFor = (position: number) =>
			element([0x11, 0x4d, 0x9b, 0x74], element([0x4d, 0xbb], concat(element([0x53, 0xab], [0x16, 0x54, 0xae, 0x6b]), element([0x53, 0xac], [position]))))
		const unknownSize = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
		expect(await readWebmVideoCodec(file('video.webm', concat(header, unknownSize, tracks, cluster)))).toBe('V_VP9')
		const seekHead = seekHeadFor(seekHeadFor(0).length + cluster.length)
		expect(await readWebmVideoCodec(file('video.webm', concat(header, unknownSize, seekHead, cluster, tracks)))).toBe('V_VP9')
	})
})
