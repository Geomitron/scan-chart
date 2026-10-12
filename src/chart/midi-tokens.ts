import type { MidiData, MidiEvent, MidiHeader, MidiSmpteOffsetEvent } from '@geomitron/midi-file'

/**
 * A `.mid` file read as tokens that cover every byte of it: the header chunk, every later chunk in file order, and
 * any bytes after the last chunk. Every offset indexes into `data`.
 *
 * The header, the chunks and the trailing bytes tile the file in that order. An unedited file serializes back byte
 * for byte, and a changed track chunk can be re-encoded on its own while every other chunk is copied.
 */
export interface MidiTokens {
	/** The file the tokens were read from. */
	data: Uint8Array
	header: MidiHeaderChunk
	/** The chunks after the header, in file order. */
	chunks: MidiChunk[]
	/** Offset of the bytes after the last chunk, which run to the end of `data`. */
	trailingStart: number
}

/**
 * Where a chunk's parts lie in the file. The last chunk of a truncated file can be cut short anywhere, so its id,
 * length field or body can be shorter than four bytes, four bytes and `length` bytes.
 */
export interface MidiChunkFrame {
	/** The chunk type, decoded from its id bytes as `parseMidi` decodes them. */
	id: string
	/** The body length the length field declares, as `parseMidi` reads it: `NaN` when the file ends inside the field. */
	length: number
	/** Offset of the id, the chunk's first byte. */
	start: number
	/** Offset of the 4-byte length field. */
	lengthStart: number
	/** Offset of the body. */
	bodyStart: number
	/** Offset after the chunk's last byte. */
	end: number
}

/** The `MThd` chunk that starts the file. */
export interface MidiHeaderChunk extends MidiChunkFrame {
	/** The format, track count and time division, decoded as `parseMidi` decodes them. */
	header: MidiHeader
}

/** An `MTrk` chunk within the header's track count, decoded into events. */
export interface MidiTrackChunk extends MidiChunkFrame {
	kind: 'track'
	events: MidiEventToken[]
}

/**
 * A chunk kept as bytes and not decoded: a chunk type other than `MTrk`, which the MIDI specification says readers
 * skip, or an `MTrk` chunk past the header's track count, which `parseMidi` never reads.
 */
export interface MidiSkippedChunk extends MidiChunkFrame {
	kind: 'skipped'
}

export type MidiChunk = MidiTrackChunk | MidiSkippedChunk

/** One event of a track chunk: its delta time, its status byte unless it uses running status, and its data bytes. */
export interface MidiEventToken {
	/** Offset of the delta time, the event's first byte. */
	start: number
	/** Offset after the event's last byte. */
	end: number
	/** The absolute tick: the sum of the track's delta times up to and including this event's. */
	tick: number
	/** The event exactly as `parseMidi` decodes it. Its `deltaTime` is the delta time as written. */
	event: MidiEvent
}

/**
 * What the reader does with a chunk type other than `MTrk` before it has the header's track count of `MTrk` chunks:
 * `skip` keeps it as a skipped chunk, as the MIDI specification asks, and `reject` throws, as `parseMidi` does.
 */
export type MidiUnknownChunkPolicy = 'skip' | 'reject'

/**
 * Reads `data` as MIDI tokens. The header and the track chunks decode exactly as `parseMidi` from
 * `@geomitron/midi-file` decodes them, and the reader throws where it throws, with the same messages, as strings.
 *
 * Two things differ. With the `skip` policy, a whole chunk of another type with a 4-character ASCII id is kept and
 * skipped instead of rejected. And a chunk length of 2 GiB or more, which `parseMidi` reads as negative and then
 * steps backwards through the file, is rejected whenever `parseMidi` would read on from it.
 */
export function readMidiTokens(data: Uint8Array, unknownChunks: MidiUnknownChunkPolicy = 'skip'): MidiTokens {
	const headerFrame = readChunkFrame(data, 0)
	if (headerFrame.id !== 'MThd') {
		throw `Bad MIDI file.  Expected 'MHdr', got: '${headerFrame.id}'`
	}
	const header: MidiHeaderChunk = { ...headerFrame, header: readHeader(data.subarray(headerFrame.bodyStart, headerFrame.end)) }

	// parseMidi reads chunks until it has the header's track count or reaches the end of the file
	const chunks: MidiChunk[] = []
	let trackCount = 0
	let previous: MidiChunkFrame = header
	while (trackCount < header.header.numTracks) {
		if (Number.isNaN(previous.length)) {
			// parseMidi goes on reading at position `NaN`, where every chunk id decodes as ''
			throw `Bad MIDI file.  Expected 'MTrk', got: ''`
		}
		if (previous.length < 0) {
			throw `Bad MIDI file.  The '${previous.id}' chunk at byte ${previous.start} declares a negative length: ${previous.length}`
		}
		if (previous.end >= data.length) {
			break
		}
		const frame = readChunkFrame(data, previous.end)
		if (frame.id === 'MTrk') {
			chunks.push({ ...frame, kind: 'track', events: readTrackEvents(data.subarray(frame.bodyStart, frame.end), frame.bodyStart) })
			trackCount++
		} else if (unknownChunks === 'skip' && isWholeChunk(data, frame)) {
			chunks.push({ ...frame, kind: 'skipped' })
		} else {
			throw `Bad MIDI file.  Expected 'MTrk', got: '${frame.id}'`
		}
		previous = frame
	}

	// parseMidi reads nothing past the track count. Whole chunks there are kept as chunks, and anything else as trailing bytes.
	let trailingStart = previous.end
	while (trailingStart < data.length) {
		const frame = readChunkFrame(data, trailingStart)
		if (!isWholeChunk(data, frame)) {
			break
		}
		chunks.push({ ...frame, kind: 'skipped' })
		trailingStart = frame.end
	}

	return { data, header, chunks, trailingStart }
}

/**
 * The tokens of `tokens`' file with the track chunk at `chunkIndex` replaced by `chunkBytes`, a whole `MTrk` chunk.
 * Only the new chunk is read: the chunks before it are kept, and the chunks after it keep their decoded events at
 * shifted offsets. The result equals reading the edited file with `readMidiTokens`.
 */
export function replaceMidiTrackChunk(tokens: MidiTokens, chunkIndex: number, chunkBytes: Uint8Array): MidiTokens {
	const old = tokens.chunks[chunkIndex]
	if (old?.kind !== 'track') throw new RangeError('Only a MIDI track chunk can be replaced')
	const shift = chunkBytes.length - (old.end - old.start)
	const data = new Uint8Array(tokens.data.length + shift)
	data.set(tokens.data.subarray(0, old.start))
	data.set(chunkBytes, old.start)
	data.set(tokens.data.subarray(old.end), old.start + chunkBytes.length)

	const frame = readChunkFrame(data, old.start)
	const replaced: MidiTrackChunk = { ...frame, kind: 'track', events: readTrackEvents(data.subarray(frame.bodyStart, frame.end), frame.bodyStart) }
	const chunks = tokens.chunks.map((chunk, index): MidiChunk => index < chunkIndex ? chunk
		: index === chunkIndex ? replaced
		: shiftChunk(chunk, shift))
	return { data, header: tokens.header, chunks, trailingStart: tokens.trailingStart + shift }
}

/** A chunk moved `shift` bytes later in the file, with its events' offsets moved too. */
function shiftChunk(chunk: MidiChunk, shift: number): MidiChunk {
	const moved = { ...chunk, start: chunk.start + shift, lengthStart: chunk.lengthStart + shift, bodyStart: chunk.bodyStart + shift, end: chunk.end + shift }
	if (moved.kind === 'track') {
		moved.events = moved.events.map(token => ({ start: token.start + shift, end: token.end + shift, tick: token.tick, event: token.event }))
	}
	return moved
}

/** The file's bytes, chunk by chunk: the same bytes as `tokens.data` for tokens that are not edited. */
export function serializeMidiTokens(tokens: MidiTokens): Uint8Array {
	const { data } = tokens
	const parts = [tokens.header, ...tokens.chunks].map(chunk => data.subarray(chunk.start, chunk.end))
	parts.push(data.subarray(tokens.trailingStart))

	const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
	let offset = 0
	for (const part of parts) {
		bytes.set(part, offset)
		offset += part.length
	}
	return bytes
}

/**
 * The file as `parseMidi` returns it, with each event's `deltaTime` replaced by its absolute tick. Skipped chunks are
 * left out. The events are copies, so changing them leaves the tokens unchanged.
 */
export function midiTokensToMidiData(tokens: MidiTokens): MidiData {
	const tracks: MidiEvent[][] = []
	for (const chunk of tokens.chunks) {
		if (chunk.kind === 'track') {
			tracks.push(chunk.events.map(token => eventAtTick(token.event, token.tick)))
		}
	}
	return { header: { ...tokens.header.header }, tracks }
}

/**
 * A copy of `event` with `deltaTime` set to `tick`, keeping its keys in their order. Note events, most of any file,
 * are copied with literals, which is several times faster than a spread that sees every event shape.
 */
function eventAtTick(event: MidiEvent, tick: number): MidiEvent {
	if (event.type === 'noteOn' || event.type === 'noteOff') {
		const { channel, type, noteNumber, velocity } = event
		if (event.running) {
			return event.byte9
				? { deltaTime: tick, running: true, channel, type, noteNumber, velocity, byte9: true }
				: { deltaTime: tick, running: true, channel, type, noteNumber, velocity }
		}
		return event.byte9
			? { deltaTime: tick, channel, type, noteNumber, velocity, byte9: true }
			: { deltaTime: tick, channel, type, noteNumber, velocity }
	}
	const copy = { ...event }
	copy.deltaTime = tick
	return copy
}

/** Reads the chunk at `start` without its body. Past the end of the file a byte reads as `undefined`, as in `parseMidi`. */
function readChunkFrame(data: Uint8Array, start: number): MidiChunkFrame {
	const lengthStart = Math.min(start + 4, data.length)
	const bodyStart = Math.min(start + 8, data.length)
	const length = (data[start + 4] << 24) + (data[start + 5] << 16) + (data[start + 6] << 8) + data[start + 7]
	// `subarray` clamps the body to the file just as parseMidi's `slice` does, including for a `NaN` or negative length
	const end = bodyStart + data.subarray(start + 8, start + 8 + length).length
	return { id: decodeText(data.subarray(start, start + 4)), length, start, lengthStart, bodyStart, end }
}

/** Whether `frame` is a complete chunk with a 4-character ASCII id, as the MIDI specification describes chunks. */
function isWholeChunk(data: Uint8Array, frame: MidiChunkFrame): boolean {
	if (frame.bodyStart !== frame.start + 8 || !(frame.length >= 0) || frame.end !== frame.bodyStart + frame.length) {
		return false
	}
	for (let i = frame.start; i < frame.lengthStart; i++) {
		if (data[i] < 0x20 || data[i] > 0x7e) {
			return false
		}
	}
	return true
}

function readHeader(body: Uint8Array): MidiHeader {
	const reader = new ChunkReader(body)
	// A file can declare any format; `MidiHeader` types only the three the specification defines
	const format = reader.readUInt16() as MidiHeader['format']
	const numTracks = reader.readUInt16()
	const timeDivision = reader.readUInt16()
	return timeDivision & 0x8000
		? { format, numTracks, framesPerSecond: 0x100 - (timeDivision >> 8), ticksPerFrame: timeDivision & 0xff }
		: { format, numTracks, ticksPerBeat: timeDivision }
}

function readTrackEvents(body: Uint8Array, bodyStart: number): MidiEventToken[] {
	const reader = new ChunkReader(body)
	const tokens: MidiEventToken[] = []
	let tick = 0
	while (reader.pos < body.length) {
		const start = reader.pos
		const event = readEvent(reader)
		tick += event.deltaTime
		tokens.push({ start: bodyStart + start, end: bodyStart + Math.min(reader.pos, body.length), tick, event })
	}
	return tokens
}

/**
 * Reads one event as `parseMidi` does, building the same fields in the same order, so even the key order matches.
 * A field read past the end of a truncated track is `undefined` or `NaN`, as it is in `parseMidi`.
 */
function readEvent(reader: ChunkReader): MidiEvent {
	const deltaTime = reader.readVarInt()
	let status = reader.readUInt8()

	if ((status & 0xf0) === 0xf0) {
		if (status === 0xff) {
			return readMetaEvent(reader, deltaTime)
		} else if (status === 0xf0) {
			return { deltaTime, type: 'sysEx', data: reader.readBytes(reader.readVarInt()) }
		} else if (status === 0xf7) {
			return { deltaTime, type: 'endSysEx', data: reader.readBytes(reader.readVarInt()) }
		}
		throw `Unrecognised MIDI event type byte: ${status}`
	}

	let param1: number
	const running = (status & 0x80) === 0
	if (running) {
		// The byte is the first data byte, and the status is the last channel event's
		param1 = status
		status = reader.runningStatus
	} else {
		param1 = reader.readUInt8()
		reader.runningStatus = status
	}
	const channel = status & 0x0f
	// Each event type has a literal with `running` and one without, so that `running` comes before `channel`, as in parseMidi
	switch (status >> 4) {
		case 0x08: {
			const velocity = reader.readUInt8()
			return running
				? { deltaTime, running, channel, type: 'noteOff', noteNumber: param1, velocity }
				: { deltaTime, channel, type: 'noteOff', noteNumber: param1, velocity }
		}
		case 0x09: {
			const velocity = reader.readUInt8()
			if (velocity === 0) {
				return running
					? { deltaTime, running, channel, type: 'noteOff', noteNumber: param1, velocity, byte9: true }
					: { deltaTime, channel, type: 'noteOff', noteNumber: param1, velocity, byte9: true }
			}
			return running
				? { deltaTime, running, channel, type: 'noteOn', noteNumber: param1, velocity }
				: { deltaTime, channel, type: 'noteOn', noteNumber: param1, velocity }
		}
		case 0x0a: {
			const amount = reader.readUInt8()
			return running
				? { deltaTime, running, channel, type: 'noteAftertouch', noteNumber: param1, amount }
				: { deltaTime, channel, type: 'noteAftertouch', noteNumber: param1, amount }
		}
		case 0x0b: {
			const value = reader.readUInt8()
			return running
				? { deltaTime, running, channel, type: 'controller', controllerType: param1, value }
				: { deltaTime, channel, type: 'controller', controllerType: param1, value }
		}
		case 0x0c:
			return running
				? { deltaTime, running, channel, type: 'programChange', programNumber: param1 }
				: { deltaTime, channel, type: 'programChange', programNumber: param1 }
		case 0x0d:
			return running
				? { deltaTime, running, channel, type: 'channelAftertouch', amount: param1 }
				: { deltaTime, channel, type: 'channelAftertouch', amount: param1 }
		case 0x0e: {
			const value = param1 + (reader.readUInt8() << 7) - 0x2000
			return running
				? { deltaTime, running, channel, type: 'pitchBend', value }
				: { deltaTime, channel, type: 'pitchBend', value }
		}
		default:
			throw `Unrecognised MIDI event type: ${status >> 4}`
	}
}

const smpteFrameRates: { [rateBits: number]: MidiSmpteOffsetEvent['frameRate'] } = { 0x00: 24, 0x20: 25, 0x40: 29, 0x60: 30 }

function readMetaEvent(reader: ChunkReader, deltaTime: number): MidiEvent {
	const metatypeByte = reader.readUInt8()
	const length = reader.readVarInt()
	switch (metatypeByte) {
		case 0x00:
			if (length !== 2) throw `Expected length for sequenceNumber event is 2, got ${length}`
			return { deltaTime, meta: true, type: 'sequenceNumber', number: reader.readUInt16() }
		case 0x01:
			return { deltaTime, meta: true, type: 'text', text: reader.readString(length) }
		case 0x02:
			return { deltaTime, meta: true, type: 'copyrightNotice', text: reader.readString(length) }
		case 0x03:
			return { deltaTime, meta: true, type: 'trackName', text: reader.readString(length) }
		case 0x04:
			return { deltaTime, meta: true, type: 'instrumentName', text: reader.readString(length) }
		case 0x05:
			return { deltaTime, meta: true, type: 'lyrics', text: reader.readString(length) }
		case 0x06:
			return { deltaTime, meta: true, type: 'marker', text: reader.readString(length) }
		case 0x07:
			return { deltaTime, meta: true, type: 'cuePoint', text: reader.readString(length) }
		case 0x20:
			if (length !== 1) throw `Expected length for channelPrefix event is 1, got ${length}`
			return { deltaTime, meta: true, type: 'channelPrefix', channel: reader.readUInt8() }
		case 0x21:
			if (length !== 1) throw `Expected length for portPrefix event is 1, got ${length}`
			return { deltaTime, meta: true, type: 'portPrefix', port: reader.readUInt8() }
		case 0x2f:
			if (length !== 0) throw `Expected length for endOfTrack event is 0, got ${length}`
			return { deltaTime, meta: true, type: 'endOfTrack' }
		case 0x51:
			if (length !== 3) throw `Expected length for setTempo event is 3, got ${length}`
			return { deltaTime, meta: true, type: 'setTempo', microsecondsPerBeat: reader.readUInt24() }
		case 0x54: {
			if (length !== 5) throw `Expected length for smpteOffset event is 5, got ${length}`
			const hourByte = reader.readUInt8()
			return {
				deltaTime,
				meta: true,
				type: 'smpteOffset',
				frameRate: smpteFrameRates[hourByte & 0x60],
				hour: hourByte & 0x1f,
				min: reader.readUInt8(),
				sec: reader.readUInt8(),
				frame: reader.readUInt8(),
				subFrame: reader.readUInt8(),
			}
		}
		case 0x58: {
			if (length !== 2 && length !== 4) throw `Expected length for timeSignature event is 4 or 2, got ${length}`
			const numerator = reader.readUInt8()
			const denominator = 1 << reader.readUInt8()
			return length === 4
				? { deltaTime, meta: true, type: 'timeSignature', numerator, denominator, metronome: reader.readUInt8(), thirtyseconds: reader.readUInt8() }
				: { deltaTime, meta: true, type: 'timeSignature', numerator, denominator, metronome: 0x24, thirtyseconds: 0x08 }
		}
		case 0x59:
			if (length !== 2) throw `Expected length for keySignature event is 2, got ${length}`
			return { deltaTime, meta: true, type: 'keySignature', key: reader.readInt8(), scale: reader.readUInt8() }
		case 0x7f:
			return { deltaTime, meta: true, type: 'sequencerSpecific', data: reader.readBytes(length) }
		default:
			return { deltaTime, meta: true, type: 'unknownMeta', data: reader.readBytes(length), metatypeByte }
	}
}

/**
 * Reads a chunk body as `parseMidi`'s `Parser` does. Past the end a byte reads as `undefined`, so a number read across
 * the end comes out `NaN`, `undefined` or partial, exactly as it does there; the types don't show this.
 */
class ChunkReader {
	readonly bytes: Uint8Array
	pos = 0
	/**
	 * The status byte that running status repeats. parseMidi declares it after a `return`, so it starts `undefined`,
	 * which decodes as event type 0 and channel 0, just as this 0 does.
	 */
	runningStatus = 0

	constructor(bytes: Uint8Array) {
		this.bytes = bytes
	}

	readUInt8(): number {
		return this.bytes[this.pos++]
	}

	readInt8(): number {
		const u = this.readUInt8()
		return u & 0x80 ? u - 0x100 : u
	}

	readUInt16(): number {
		const b0 = this.readUInt8()
		const b1 = this.readUInt8()
		return (b0 << 8) + b1
	}

	readUInt24(): number {
		const b0 = this.readUInt8()
		const b1 = this.readUInt8()
		const b2 = this.readUInt8()
		return (b0 << 16) + (b1 << 8) + b2
	}

	/** Stops at the end of the body, returning the value so far, already shifted for a next byte that isn't there. */
	readVarInt(): number {
		let result = 0
		while (this.pos < this.bytes.length) {
			const b = this.readUInt8()
			if (b & 0x80) {
				result += b & 0x7f
				result <<= 7
			} else {
				return result + b
			}
		}
		return result
	}

	/** A copy made with the input's own `slice`, as in parseMidi, so a `Buffer` input gives `Buffer` data. */
	readBytes(length: number): Uint8Array {
		const bytes = this.bytes.slice(this.pos, this.pos + this.checkedLength(length))
		this.pos += length
		return bytes
	}

	readString(length: number): string {
		const bytes = this.bytes.subarray(this.pos, this.pos + this.checkedLength(length))
		this.pos += length
		return decodeText(bytes)
	}

	/** A variable-length number of five bytes or more can come out negative; parseMidi then steps backwards. */
	private checkedLength(length: number): number {
		if (length < 0) {
			throw `Bad MIDI file.  An event at byte ${this.pos} of its chunk declares a negative length: ${length}`
		}
		return length
	}
}

const utf8Decoder = new TextDecoder()

/**
 * Decodes text as `parseMidi` does: as UTF-8 when that gives fewer UTF-16 code units than there are bytes, otherwise
 * one character per byte. ASCII-only text gives the same string both ways, so it skips the UTF-8 decode.
 */
function decodeText(bytes: Uint8Array): string {
	// One argument per byte, as parseMidi calls it, so text too long for the call stack throws the same RangeError
	const singleByte = String.fromCharCode.apply(null, bytes as unknown as number[])
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] >= 0x80) {
			const multiByte = utf8Decoder.decode(bytes)
			return singleByte.length > multiByte.length ? multiByte : singleByte
		}
	}
	return singleByte
}
