import { isByteSource, type SongFile } from '../song-files'

/** The kinds of file content told apart by their first bytes. */
export type ContentType = 'opus' | 'vorbis' | 'ogg' | 'mp3' | 'wav' | 'flac' | 'aiff' | 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'webm' | 'mp4' | 'avi'

/** The audio formats whose length is read from their headers. */
export interface AudioInfo {
	readonly format: 'opus' | 'vorbis' | 'mp3' | 'wav'
	readonly durationMs: number
	/** The average bitrate of the audio data, without the container's headers, in kilobits per second. */
	readonly averageKbps: number
	/** The bitrate a Vorbis header names, or `null`: it's what the encoder aimed for. */
	readonly nominalKbps: number | null
}

/** How much of a file's start and end is read at first. Headers that run further are read piece by piece. */
const WINDOW = 64 * 1024

/** The bytes from `offset`, up to `length`, read from a byte source or sliced from bytes. */
export async function readRange(file: SongFile, offset: number, length: number): Promise<Uint8Array> {
	const size = fileSize(file)
	const start = Math.max(0, Math.min(offset, size))
	const end = Math.max(start, Math.min(offset + length, size))
	return isByteSource(file.data) ? file.data.read(start, end - start) : file.data.subarray(start, end)
}

export function fileSize(file: SongFile) {
	return isByteSource(file.data) ? file.data.size : file.data.byteLength
}

const ascii = (bytes: Uint8Array, offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))

/** What a file holds, from its first bytes (at least the first 64), or `null` when they don't say. */
export function contentType(head: Uint8Array): ContentType | null {
	if (ascii(head, 0, 4) === 'OggS') {
		const packet = 27 + (head[26] ?? 0)
		if (ascii(head, packet, 8) === 'OpusHead') return 'opus'
		if (head[packet] === 1 && ascii(head, packet + 1, 6) === 'vorbis') return 'vorbis'
		return 'ogg'
	}
	if (ascii(head, 0, 3) === 'ID3' || isMpegFrameHeader(head, 0)) return 'mp3'
	if (ascii(head, 0, 4) === 'RIFF') {
		const kind = ascii(head, 8, 4)
		return kind === 'WAVE' ? 'wav' : kind === 'WEBP' ? 'webp' : kind === 'AVI ' ? 'avi' : null
	}
	if (ascii(head, 0, 4) === 'fLaC') return 'flac'
	if (ascii(head, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(head, 8, 4))) return 'aiff'
	if (head[0] === 0x89 && ascii(head, 1, 3) === 'PNG') return 'png'
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
	if (ascii(head, 0, 4) === 'GIF8') return 'gif'
	if (ascii(head, 0, 2) === 'BM') return 'bmp'
	if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm'
	if (ascii(head, 4, 4) === 'ftyp') return 'mp4'
	return null
}

/** An audio file's format, length and bitrate, read from its headers, or `null` when they can't be read. */
export async function readAudioInfo(file: SongFile): Promise<AudioInfo | null> {
	const head = await readRange(file, 0, WINDOW)
	const type = contentType(head)
	try {
		if (type === 'opus' || type === 'vorbis') return await readOggInfo(file, head, type)
		if (type === 'wav') return await readWavInfo(file, head)
		if (type === 'mp3') return await readMp3Info(file, head)
	} catch {
		return null
	}
	return null
}

// ---- Ogg: the codec header on the first page, and the granule position of the last page.

interface OggPage { offset: number; size: number; granule: number; serial: number }

/** The Ogg page header at `offset` in `bytes`, if one starts there and its segment table is in `bytes`. */
function oggPage(bytes: Uint8Array, offset: number, fileOffset: number): OggPage | null {
	if (offset + 27 > bytes.length || ascii(bytes, offset, 4) !== 'OggS' || bytes[offset + 4] !== 0) return null
	const segments = bytes[offset + 26]
	if (offset + 27 + segments > bytes.length) return null
	let body = 0
	for (let index = 0; index < segments; index++) body += bytes[offset + 27 + index]
	const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
	// A granule position of -1 means no packet ends on the page.
	const granule = view.getInt32(10, true) === -1 && view.getUint32(6, true) === 0xffffffff ? -1 : view.getUint32(10, true) * 2 ** 32 + view.getUint32(6, true)
	return { offset: fileOffset, size: 27 + segments + body, granule, serial: view.getUint32(14, true) }
}

async function readOggInfo(file: SongFile, head: Uint8Array, format: 'opus' | 'vorbis'): Promise<AudioInfo | null> {
	const size = fileSize(file)
	const first = oggPage(head, 0, 0)
	if (first === null) return null
	const packet = head.subarray(27 + head[26])
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
	// Opus counts granules at 48 kHz, after the pre-skip; Vorbis at its sample rate.
	const preSkip = format === 'opus' ? view.getUint16(10, true) : 0
	const rate = format === 'opus' ? 48000 : view.getUint32(12, true)
	const nominal = format === 'vorbis' ? view.getInt32(20, true) : 0

	// The headers end at the first page with a granule position: the comment header can hold cover art.
	let audioStart = 0
	for (let offset = 0, pages = 0; offset < size && pages < 10000; pages++) {
		const bytes = offset + 282 <= head.length ? head.subarray(offset) : await readRange(file, offset, 282)
		const page = oggPage(bytes, 0, offset)
		if (page === null) return null
		if (page.serial === first.serial && page.granule > 0) {
			audioStart = offset
			break
		}
		offset += page.size
	}

	// The last page of the stream: search back from the end for a page header.
	let last: OggPage | null = null
	for (let window = WINDOW; last === null && window <= 4 * 1024 * 1024; window *= 4) {
		const start = Math.max(0, size - window)
		const tail = await readRange(file, start, size - start)
		for (let offset = tail.length - 27; offset >= 0 && last === null; offset--) {
			const page = tail[offset] === 0x4f ? oggPage(tail, offset, start + offset) : null
			if (page !== null && page.serial === first.serial && page.granule > 0) last = page
		}
		if (start === 0) break
	}
	if (last === null || rate <= 0) return null
	const seconds = (last.granule - preSkip) / rate
	if (!(seconds > 0)) return null
	return {
		format,
		durationMs: seconds * 1000,
		averageKbps: (size - audioStart) * 8 / seconds / 1000,
		nominalKbps: nominal > 0 ? nominal / 1000 : null,
	}
}

// ---- WAV: the byte rate in the fmt chunk, and the data chunk's size.

async function readWavInfo(file: SongFile, head: Uint8Array): Promise<AudioInfo | null> {
	const size = fileSize(file)
	let byteRate = 0
	for (let offset = 12, chunks = 0; offset + 8 <= size && chunks < 1000; chunks++) {
		const header = offset + 24 <= head.length ? head.subarray(offset, offset + 24) : await readRange(file, offset, 24)
		const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
		const id = ascii(header, 0, 4)
		const length = view.getUint32(4, true)
		if (id === 'fmt ' && header.length >= 20) byteRate = view.getUint32(16, true)
		if (id === 'data') {
			if (byteRate <= 0) return null
			// A data size written before recording ended can be too large, or 0.
			const dataBytes = length === 0 || offset + 8 + length > size ? size - offset - 8 : length
			const seconds = dataBytes / byteRate
			return { format: 'wav', durationMs: seconds * 1000, averageKbps: byteRate * 8 / 1000, nominalKbps: null }
		}
		// Chunks are padded to an even length.
		offset += 8 + length + (length % 2)
	}
	return null
}

// ---- MP3: the first frame's header, then a Xing, Info or VBRI frame count, or else a constant bitrate.

const mpegBitrates = {
	v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
	v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
	v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
	v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
	v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}

interface MpegFrame { version: 1 | 2 | 25; layer: 1 | 2 | 3; kbps: number; sampleRate: number; samples: number; length: number; mono: boolean }

function isMpegFrameHeader(bytes: Uint8Array, offset: number) {
	return mpegFrame(bytes, offset) !== null
}

/** The MPEG audio frame header at `offset`, or `null` when there isn't a valid one. */
function mpegFrame(bytes: Uint8Array, offset: number): MpegFrame | null {
	if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null
	const versionBits = (bytes[offset + 1] >> 3) & 3
	const layerBits = (bytes[offset + 1] >> 1) & 3
	const bitrateIndex = bytes[offset + 2] >> 4
	const rateIndex = (bytes[offset + 2] >> 2) & 3
	if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null
	const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25
	const layer = (4 - layerBits) as 1 | 2 | 3
	const kbps = (version === 1 ? [mpegBitrates.v1l1, mpegBitrates.v1l2, mpegBitrates.v1l3] : [mpegBitrates.v2l1, mpegBitrates.v2l23, mpegBitrates.v2l23])[layer - 1][bitrateIndex]
	const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 1 ? 1 : version === 2 ? 2 : 4)
	const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152
	const padding = (bytes[offset + 2] >> 1) & 1
	const length = layer === 1 ? (Math.floor(12000 * kbps / sampleRate) + padding) * 4 : Math.floor(samples / 8 * kbps * 1000 / sampleRate) + padding
	return { version, layer, kbps, sampleRate, samples, length, mono: bytes[offset + 3] >> 6 === 3 }
}

async function readMp3Info(file: SongFile, head: Uint8Array): Promise<AudioInfo | null> {
	const size = fileSize(file)
	// Skip any ID3v2 tags, whose sizes are syncsafe integers.
	let start = 0
	for (let tags = 0; tags < 10; tags++) {
		const header = start + 10 <= head.length ? head.subarray(start, start + 10) : await readRange(file, start, 10)
		if (ascii(header, 0, 3) !== 'ID3') break
		start += 10 + ((header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9]) + (header[5] & 0x10 ? 10 : 0)
	}
	// The first frame header that a second one follows.
	const bytes = start + WINDOW <= head.length ? head.subarray(start) : await readRange(file, start, WINDOW)
	let at = -1
	let frame: MpegFrame | null = null
	for (let offset = 0; offset + 4 <= bytes.length && at === -1; offset++) {
		frame = mpegFrame(bytes, offset)
		const next = frame === null ? null : mpegFrame(bytes, offset + frame.length)
		if (frame !== null && (next !== null || offset + frame.length >= bytes.length) && (next === null || next.sampleRate === frame.sampleRate)) at = offset
	}
	if (frame === null || at === -1) return null
	const view = new DataView(bytes.buffer, bytes.byteOffset + at)
	const sideInfo = frame.version === 1 ? (frame.mono ? 17 : 32) : (frame.mono ? 9 : 17)
	let frames = 0
	const tag = ascii(bytes, at + 4 + sideInfo, 4)
	if ((tag === 'Xing' || tag === 'Info') && view.getUint32(4 + sideInfo + 4) & 1) frames = view.getUint32(4 + sideInfo + 8)
	else if (ascii(bytes, at + 36, 4) === 'VBRI') frames = view.getUint32(36 + 14)
	// An ID3v1 tag takes the last 128 bytes.
	const end = ascii(await readRange(file, size - 128, 3), 0, 3) === 'TAG' ? size - 128 : size
	const audioBytes = end - start - at
	const seconds = frames > 0 ? frames * frame.samples / frame.sampleRate : audioBytes * 8 / (frame.kbps * 1000)
	if (!(seconds > 0)) return null
	return { format: 'mp3', durationMs: seconds * 1000, averageKbps: audioBytes * 8 / seconds / 1000, nominalKbps: null }
}

// ---- WebM: the video track's codec ID, in the Tracks element of the Segment.

const ebml = { segment: 0x18538067, seekHead: 0x114d9b74, seek: 0x4dbb, seekId: 0x53ab, seekPosition: 0x53ac, tracks: 0x1654ae6b, cluster: 0x1f43b675,
	trackEntry: 0xae, trackType: 0x83, codecId: 0x86 }

/** An EBML element's ID and data size at `offset`, or `null`. An unknown size is -1. */
function ebmlElement(bytes: Uint8Array, offset: number): { id: number; size: number; headerLength: number } | null {
	const idLength = vintLength(bytes[offset])
	if (idLength === 0 || idLength > 4 || offset + idLength >= bytes.length) return null
	let id = 0
	for (let index = 0; index < idLength; index++) id = id * 256 + bytes[offset + index]
	const sizeLength = vintLength(bytes[offset + idLength])
	if (sizeLength === 0 || offset + idLength + sizeLength > bytes.length) return null
	let size = bytes[offset + idLength] & (0xff >> sizeLength)
	let unknown = size === 0xff >> sizeLength
	for (let index = 1; index < sizeLength; index++) {
		size = size * 256 + bytes[offset + idLength + index]
		unknown = unknown && bytes[offset + idLength + index] === 0xff
	}
	return { id, size: unknown ? -1 : size, headerLength: idLength + sizeLength }
}

function vintLength(first: number | undefined) {
	if (first === undefined || first === 0) return 0
	let length = 1
	while (!(first & (0x80 >> (length - 1)))) length++
	return length
}

/** The elements inside `bytes`, in order. */
function* ebmlChildren(bytes: Uint8Array) {
	for (let offset = 0; offset < bytes.length;) {
		const element = ebmlElement(bytes, offset)
		if (element === null || element.size < 0) return
		yield { ...element, data: bytes.subarray(offset + element.headerLength, offset + element.headerLength + element.size) }
		offset += element.headerLength + element.size
	}
}

const ebmlUint = (bytes: Uint8Array) => bytes.reduce((value, byte) => value * 256 + byte, 0)

/** A WebM file's video codec ID, such as `V_VP8`, or `null` when it can't be read. */
export async function readWebmVideoCodec(file: SongFile): Promise<string | null> {
	const size = fileSize(file)
	const head = await readRange(file, 0, WINDOW)
	const header = ebmlElement(head, 0)
	if (header === null || header.size < 0) return null
	const segment = ebmlElement(head, header.headerLength + header.size)
	if (segment === null || segment.id !== ebml.segment) return null
	const segmentStart = header.headerLength + header.size + segment.headerLength
	let tracksAt = -1
	for (let offset = segmentStart, elements = 0; offset < size && elements < 1000 && tracksAt === -1; elements++) {
		const element = ebmlElement(await readRange(file, offset, 12), 0)
		if (element === null || element.size < 0) return null
		if (element.id === ebml.tracks) tracksAt = offset
		if (element.id === ebml.seekHead) {
			// The seek head says where Tracks is, relative to the segment's data.
			for (const seek of ebmlChildren(await readRange(file, offset + element.headerLength, element.size))) {
				if (seek.id !== ebml.seek) continue
				const fields = [...ebmlChildren(seek.data)]
				const id = fields.find(field => field.id === ebml.seekId)
				const position = fields.find(field => field.id === ebml.seekPosition)
				if (id !== undefined && position !== undefined && ebmlUint(id.data) === ebml.tracks) tracksAt = segmentStart + ebmlUint(position.data)
			}
		}
		if (element.id === ebml.cluster && tracksAt === -1) return null
		offset += element.headerLength + element.size
	}
	if (tracksAt === -1) return null
	const tracks = ebmlElement(await readRange(file, tracksAt, 12), 0)
	if (tracks === null || tracks.id !== ebml.tracks || tracks.size < 0) return null
	const codecs = [...ebmlChildren(await readRange(file, tracksAt + tracks.headerLength, tracks.size))]
		.filter(entry => entry.id === ebml.trackEntry)
		.map(entry => {
			const fields = [...ebmlChildren(entry.data)]
			const type = fields.find(field => field.id === ebml.trackType)
			const codec = fields.find(field => field.id === ebml.codecId)
			return { video: type !== undefined && ebmlUint(type.data) === 1, codec: codec === undefined ? null : ascii(codec.data, 0, codec.data.length).replace(/\0+$/, '') }
		})
	return codecs.find(track => track.video)?.codec ?? null
}
