import type { SongFile } from 'src/song-files'

/** Builders of the media files the checks read: only the headers they need. */

export const ascii = (text: string) => [...text].map(character => character.charCodeAt(0))

export function concat(...parts: (Uint8Array | number[])[]) {
	const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
	let at = 0
	for (const part of parts) {
		bytes.set(part, at)
		at += part.length
	}
	return bytes
}

export const le16 = (value: number) => [value & 255, (value >> 8) & 255]
export const le32 = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255]
export const be32 = (value: number) => [(value >>> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255]

/** An Ogg page holding `body`, with its granule position. */
export function oggPage(granule: number, body: Uint8Array, flags = 0) {
	const lacing = [...Array(Math.floor(body.length / 255)).fill(255), body.length % 255]
	return concat(ascii('OggS'), [0, flags], le32(granule), le32(0), le32(7), le32(0), le32(0), [lacing.length], lacing, body)
}

/** An Opus identification header on the first Ogg page. */
export const opusHead = (preSkip = 0) => oggPage(0, concat(ascii('OpusHead'), [1, 2], le16(preSkip), le32(48000), [0, 0, 0]), 2)

/** Ten seconds of Ogg Opus audio averaging about `kbps`, a little more for the pages' headers. */
export function opus(kbps: number) {
	const bytes = kbps * 1000 / 8 * 10
	const pages = Math.ceil(bytes / 60000)
	return concat(opusHead(), ...Array.from({ length: pages }, (_, page) => oggPage((page + 1) * 480000 / pages, new Uint8Array(bytes / pages))))
}

/** Ogg Vorbis audio of `seconds` at 44.1 kHz, whose header names a nominal bitrate. */
export function vorbis(nominalKbps: number, seconds = 10) {
	const id = concat([1], ascii('vorbis'), le32(0), [2], le32(44100), le32(0), le32(nominalKbps * 1000), le32(0), [0xb8, 1])
	return concat(oggPage(0, id, 2), oggPage(44100 * seconds, new Uint8Array(1000)))
}

/** A PNG file's signature and IHDR chunk: enough for its dimensions. */
export function png(width: number, height: number) {
	return concat([0x89, ...ascii('PNG'), 13, 10, 26, 10], be32(13), ascii('IHDR'), be32(width), be32(height), [8, 6, 0, 0, 0], be32(0), be32(0), ascii('IEND'), be32(0))
}

/** A JPEG file's start of frame: enough for its dimensions. */
export const jpeg = (width: number, height: number) =>
	new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])

/** An EBML element with a one-byte size. */
export const ebmlElement = (id: number[], data: Uint8Array | number[]) => concat(id, [0x80 | data.length], data)
export const webmHeader = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], ebmlElement([0x42, 0x82], ascii('webm')))
/** A Segment header of unknown size. */
export const webmSegment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
/** A Tracks element with one video track of `codec`. */
export const webmTracks = (codec: string) =>
	ebmlElement([0x16, 0x54, 0xae, 0x6b], ebmlElement([0xae], concat(ebmlElement([0x83], [1]), ebmlElement([0x86], ascii(codec)))))
/** A WebM file's header and tracks, with one video track of `codec`. */
export const webm = (codec: string) => concat(webmHeader, webmSegment, webmTracks(codec))

/** A file read as a byte source, the way a large file is, counting its reads in `reads.count`. */
export function byteSourceFile(fileName: string, bytes: Uint8Array, reads = { count: 0 }): SongFile {
	const blob = new Blob([bytes as Uint8Array<ArrayBuffer>])
	return {
		fileName,
		data: {
			size: blob.size,
			read: async (offset, length) => {
				reads.count++
				return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
			},
		},
	}
}
