/**
 * Tests for the MIDI token reader. Every file is checked two ways: its tokens serialize back to the same bytes, and
 * they decode to exactly what `parseMidi` returns, or the reader throws exactly what `parseMidi` throws.
 */

import { describe, expect, it } from 'vitest'
import { MidiData, parseMidi } from '@geomitron/midi-file'

import { MidiTokens, midiTokensToMidiData, MidiUnknownChunkPolicy, readMidiTokens, serializeMidiTokens } from 'src/chart/midi-tokens'

type ByteSource = number | string | number[]

/** Concatenates bytes, with a string read as ASCII bytes. */
function bytes(...parts: ByteSource[]): number[] {
	return parts.flatMap(part => typeof part === 'number' ? [part] : typeof part === 'string' ? [...part].map(c => c.charCodeAt(0)) : part)
}

function uint32(n: number): number[] {
	return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function chunk(id: string, ...body: ByteSource[]): number[] {
	const bodyBytes = bytes(...body)
	return bytes(id, uint32(bodyBytes.length), bodyBytes)
}

function headerChunk(format: number, numTracks: number, division: number): number[] {
	return chunk('MThd', format >> 8, format & 0xff, numTracks >> 8, numTracks & 0xff, division >> 8, division & 0xff)
}

function file(...parts: ByteSource[]): Uint8Array {
	return new Uint8Array(bytes(...parts))
}

const endOfTrack = [0x00, 0xff, 0x2f, 0x00]
const tempoTrack = chunk('MTrk', 0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, endOfTrack)

/** What `parseMidi` throws, or `undefined` when it returns. */
function thrownBy(read: () => unknown): unknown {
	try {
		read()
	} catch (error) {
		return error
	}
	return undefined
}

/** `parseMidi` followed by `readMidiFile`'s conversion of delta times to absolute ticks. */
function parseMidiWithTicks(data: Uint8Array): MidiData {
	const midiData = parseMidi(data)
	for (const track of midiData.tracks) {
		let tick = 0
		for (const event of track) {
			tick += event.deltaTime
			event.deltaTime = tick
		}
	}
	return midiData
}

/** Checks that the tokens serialize to `data` and decode to what `parseMidi` returns, key order included. */
function expectDecodesLikeParseMidi(data: Uint8Array, unknownChunks: MidiUnknownChunkPolicy = 'skip'): MidiTokens {
	const tokens = readMidiTokens(data, unknownChunks)
	expect(serializeMidiTokens(tokens)).toEqual(new Uint8Array(data))
	const expected = parseMidiWithTicks(data)
	const actual = midiTokensToMidiData(tokens)
	expect(actual).toStrictEqual(expected)
	expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
	return tokens
}

/** Checks that the reader throws what `parseMidi` throws, or decodes like it when it returns. */
function expectReadsLikeParseMidi(data: Uint8Array, unknownChunks: MidiUnknownChunkPolicy = 'skip') {
	const expectedError = thrownBy(() => parseMidi(data))
	if (expectedError === undefined) {
		expectDecodesLikeParseMidi(data, unknownChunks)
	} else {
		expect(thrownBy(() => readMidiTokens(data, unknownChunks))).toBe(expectedError)
	}
}

function trackEvents(tokens: MidiTokens, trackIndex: number) {
	const tracks = tokens.chunks.filter(chunk => chunk.kind === 'track')
	return tracks[trackIndex].events
}

/** A file with every kind of event, whose high-bit bytes are sparse enough that one changed byte can't make a negative length. */
const everyEventFile = file(
	headerChunk(1, 2, 480),
	chunk('MTrk',
		0x00, 0xff, 0x03, 0x05, 'TEMPO',
		0x00, 0xff, 0x00, 0x02, 0x00, 0x07,
		tempoTrack.slice(8, -4),
		0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
		0x00, 0xff, 0x58, 0x02, 0x03, 0x03,
		0x00, 0xff, 0x59, 0x02, 0x7e, 0x00,
		0x00, 0xff, 0x54, 0x05, 0x21, 0x02, 0x03, 0x04, 0x05,
		endOfTrack,
	),
	chunk('MTrk',
		0x00, 0xff, 0x03, 0x0b, 'PART GUITAR',
		0x00, 0xff, 0x20, 0x01, 0x00,
		0x00, 0xff, 0x21, 0x01, 0x01,
		0x00, 0xff, 0x01, 0x06, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x21,
		0x00, 0xff, 0x05, 0x03, 0x6e, 0xf3, 0x6e,
		0x00, 0x90, 0x60, 0x64,
		0x83, 0x60, 0x61, 0x64,
		0x00, 0x60, 0x00,
		0x00, 0x80, 0x61, 0x40,
		0x00, 0xb0, 0x07, 0x64,
		0x00, 0x0a, 0x50,
		0x00, 0xc0, 0x05,
		0x00, 0xd0, 0x30,
		0x00, 0xa0, 0x60, 0x20,
		0x00, 0xe0, 0x00, 0x40,
		0x00, 0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7,
		0x00, 0xf7, 0x02, 0x43, 0x10,
		0x00, 0xff, 0x7f, 0x03, 0x00, 0x00, 0x41,
		0x00, 0xff, 0x60, 0x02, 0x01, 0x02,
		endOfTrack,
	),
	chunk('XFIH', 0x01, 0x02, 0x03),
)

describe('readMidiTokens', () => {
	it('decodes every kind of event as parseMidi does', () => {
		const tokens = expectDecodesLikeParseMidi(everyEventFile)
		expect(tokens.chunks.map(chunk => [chunk.kind, chunk.id])).toEqual([['track', 'MTrk'], ['track', 'MTrk'], ['skipped', 'XFIH']])
	})

	it('gives each event its bytes, tick and delta time', () => {
		const data = file(headerChunk(1, 1, 480), chunk('MTrk', 0x00, 0x90, 0x3c, 0x64, 0x83, 0x60, 0x3c, 0x00, endOfTrack))
		const events = trackEvents(readMidiTokens(data), 0)
		expect(events.map(token => [...data.subarray(token.start, token.end)])).toEqual([
			[0x00, 0x90, 0x3c, 0x64],
			[0x83, 0x60, 0x3c, 0x00],
			endOfTrack,
		])
		expect(events.map(token => [token.tick, token.event.deltaTime])).toEqual([[0, 0], [480, 480], [480, 0]])
	})

	it('locates the header, chunk ids, length fields and bodies', () => {
		const tokens = readMidiTokens(everyEventFile)
		expect(tokens.header).toMatchObject({ id: 'MThd', length: 6, start: 0, lengthStart: 4, bodyStart: 8, end: 14 })
		const [first] = tokens.chunks
		expect(first).toMatchObject({ id: 'MTrk', start: 14, lengthStart: 18, bodyStart: 22, end: 22 + first.length })
		expect(tokens.trailingStart).toBe(everyEventFile.length)
	})

	it('keeps running status', () => {
		const data = file(headerChunk(1, 1, 480), chunk('MTrk', 0x00, 0x90, 0x3c, 0x64, 0x60, 0x3e, 0x64, 0x60, 0x3c, 0x00, endOfTrack))
		const events = trackEvents(expectDecodesLikeParseMidi(data), 0)
		expect(events.map(token => token.event)).toEqual([
			{ deltaTime: 0, channel: 0, type: 'noteOn', noteNumber: 0x3c, velocity: 0x64 },
			{ deltaTime: 0x60, running: true, channel: 0, type: 'noteOn', noteNumber: 0x3e, velocity: 0x64 },
			{ deltaTime: 0x60, running: true, channel: 0, type: 'noteOff', noteNumber: 0x3c, velocity: 0, byte9: true },
			{ deltaTime: 0, meta: true, type: 'endOfTrack' },
		])
		expect([...data.subarray(events[1].start, events[1].end)]).toEqual([0x60, 0x3e, 0x64])
	})

	it('reads a velocity-0 note-on as a note-off marked byte9', () => {
		const data = file(headerChunk(1, 1, 480), chunk('MTrk', 0x00, 0x91, 0x3c, 0x64, 0x10, 0x91, 0x3c, 0x00, 0x10, 0x81, 0x3c, 0x00, endOfTrack))
		const events = trackEvents(expectDecodesLikeParseMidi(data), 0).map(token => token.event)
		expect(events[1]).toEqual({ deltaTime: 0x10, channel: 1, type: 'noteOff', noteNumber: 0x3c, velocity: 0, byte9: true })
		expect(events[2]).toEqual({ deltaTime: 0x10, channel: 1, type: 'noteOff', noteNumber: 0x3c, velocity: 0 })
	})

	it('reads sysex and escape events', () => {
		const data = file(headerChunk(1, 1, 480), chunk('MTrk',
			0x00, 0xf0, 0x08, 0x50, 0x53, 0x00, 0x00, 0x03, 0x04, 0x01, 0xf7,
			0x00, 0xf7, 0x02, 0xf3, 0x01,
			endOfTrack,
		))
		const events = trackEvents(expectDecodesLikeParseMidi(data), 0).map(token => token.event)
		expect(events[0]).toEqual({ deltaTime: 0, type: 'sysEx', data: new Uint8Array([0x50, 0x53, 0x00, 0x00, 0x03, 0x04, 0x01, 0xf7]) })
		expect(events[1]).toEqual({ deltaTime: 0, type: 'endSysEx', data: new Uint8Array([0xf3, 0x01]) })
	})

	it('reads unknown meta events', () => {
		const data = file(headerChunk(1, 1, 480), chunk('MTrk', 0x00, 0xff, 0x60, 0x03, 0x01, 0x02, 0x03, 0x00, 0xff, 0x0a, 0x00, endOfTrack))
		const events = trackEvents(expectDecodesLikeParseMidi(data), 0).map(token => token.event)
		expect(events[0]).toEqual({ deltaTime: 0, meta: true, type: 'unknownMeta', data: new Uint8Array([1, 2, 3]), metatypeByte: 0x60 })
		expect(events[1]).toEqual({ deltaTime: 0, meta: true, type: 'unknownMeta', data: new Uint8Array([]), metatypeByte: 0x0a })
	})

	it('decodes text as UTF-8 only when that shortens it, and strips a UTF-8 byte order mark, as parseMidi does', () => {
		const texts = [[0x63, 0xc3, 0xa9], [0x6e, 0xf3, 0x6e], [0xef, 0xbb, 0xbf, 0x41], [0xe3, 0x81], [0xf0, 0x9f, 0x8e, 0xb8], [0x80, 0x9f]]
		const data = file(headerChunk(1, 1, 480), chunk('MTrk', texts.flatMap(text => [0x00, 0xff, 0x05, text.length, ...text]), endOfTrack))
		const lyrics = trackEvents(expectDecodesLikeParseMidi(data), 0).map(token => 'text' in token.event ? token.event.text : null)
		expect(lyrics).toEqual(['cé', 'nón', 'A', '�', '\u{1f3b8}', '\x80\x9f', null])
	})

	it('keeps parseMidi data types for a Buffer input', () => {
		expectDecodesLikeParseMidi(Buffer.from(everyEventFile))
	})

	describe('chunks', () => {
		const unknownChunk = chunk('XFKM', 0x00, 0x01, 0x02)
		const track = chunk('MTrk', 0x00, 0x90, 0x3c, 0x64, 0x60, 0x80, 0x3c, 0x00, endOfTrack)

		it('skips unknown chunks before, between and after the track chunks', () => {
			const data = file(headerChunk(1, 2, 480), unknownChunk, tempoTrack, unknownChunk, track, unknownChunk)
			const tokens = readMidiTokens(data)
			expect(serializeMidiTokens(tokens)).toEqual(data)
			expect(tokens.chunks.map(chunk => chunk.kind)).toEqual(['skipped', 'track', 'skipped', 'track', 'skipped'])
			expect(midiTokensToMidiData(tokens)).toStrictEqual(parseMidiWithTicks(file(headerChunk(1, 2, 480), tempoTrack, track)))
		})

		it('rejects unknown chunks among the track chunks with the reject policy, as parseMidi does', () => {
			for (const data of [
				file(headerChunk(1, 2, 480), unknownChunk, tempoTrack, track),
				file(headerChunk(1, 2, 480), tempoTrack, unknownChunk, track),
			]) {
				const expectedError = thrownBy(() => parseMidi(data))
				expect(expectedError).toBe(`Bad MIDI file.  Expected 'MTrk', got: 'XFKM'`)
				expect(thrownBy(() => readMidiTokens(data, 'reject'))).toBe(expectedError)
			}
			expectDecodesLikeParseMidi(file(headerChunk(1, 2, 480), tempoTrack, track, unknownChunk))
		})

		it('rejects a chunk that is not whole or has no ASCII id as parseMidi does', () => {
			for (const data of [
				file(headerChunk(1, 2, 480), tempoTrack, bytes('XFKM', uint32(9), 0x00)),
				file(headerChunk(1, 2, 480), tempoTrack, bytes('XFK')),
				file(headerChunk(1, 2, 480), tempoTrack, chunk('\x00\x01XY', 0x00), track),
			]) {
				expect(thrownBy(() => readMidiTokens(data))).toBe(thrownBy(() => parseMidi(data)))
			}
		})

		it('keeps a track chunk past the header track count as a skipped chunk', () => {
			const tokens = expectDecodesLikeParseMidi(file(headerChunk(1, 1, 480), tempoTrack, track))
			expect(tokens.chunks.map(chunk => [chunk.kind, chunk.id])).toEqual([['track', 'MTrk'], ['skipped', 'MTrk']])
		})

		it('keeps trailing bytes after the last chunk', () => {
			const data = file(headerChunk(1, 2, 480), tempoTrack, track, 0x00, 0x00, 0x0a, 'MTrk', 0x00)
			const tokens = expectDecodesLikeParseMidi(data)
			expect(tokens.trailingStart).toBe(data.length - 8)
			expect(tokens.chunks).toHaveLength(2)
		})
	})

	describe('header', () => {
		it('reads an SMPTE time division', () => {
			const tokens = expectDecodesLikeParseMidi(file(headerChunk(1, 1, 0xe728), tempoTrack))
			expect(tokens.header.header).toEqual({ format: 1, numTracks: 1, framesPerSecond: 25, ticksPerFrame: 40 })
		})

		it('reads format 0 and format 2 headers', () => {
			expect(expectDecodesLikeParseMidi(file(headerChunk(0, 1, 96), tempoTrack)).header.header).toEqual({ format: 0, numTracks: 1, ticksPerBeat: 96 })
			expect(expectDecodesLikeParseMidi(file(headerChunk(2, 2, 96), tempoTrack, tempoTrack)).header.header)
				.toEqual({ format: 2, numTracks: 2, ticksPerBeat: 96 })
		})

		it('keeps header bytes past the time division', () => {
			const data = file(chunk('MThd', 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0, 0xab, 0xcd), tempoTrack)
			expect(expectDecodesLikeParseMidi(data).header.length).toBe(8)
		})

		it('rejects a file that does not start with a header chunk as parseMidi does', () => {
			for (const data of [file(), file(tempoTrack), file('RIFF', uint32(4), 'RMID')]) {
				expect(thrownBy(() => readMidiTokens(data))).toBe(thrownBy(() => parseMidi(data)))
			}
		})
	})

	describe('malformed files', () => {
		it('reads every truncation of a file as parseMidi does', () => {
			for (let length = 0; length <= everyEventFile.length; length++) {
				expectReadsLikeParseMidi(everyEventFile.subarray(0, length))
			}
		})

		it('decodes an event cut short at the end of the file as parseMidi does', () => {
			const tokens = expectDecodesLikeParseMidi(file(headerChunk(1, 1, 480), bytes('MTrk', uint32(6), 0x00, 0x90, 0x3c, 0x64, 0x00, 0x3e)))
			expect(trackEvents(tokens, 0).map(token => token.event)).toEqual([
				{ deltaTime: 0, channel: 0, type: 'noteOn', noteNumber: 0x3c, velocity: 0x64 },
				{ deltaTime: 0, running: true, channel: 0, type: 'noteOn', noteNumber: 0x3e, velocity: undefined },
			])
		})

		it('rejects running status before any status byte with parseMidi\'s message', () => {
			const data = file(headerChunk(1, 1, 480), chunk('MTrk', 0x00, 0x3c, 0x64, endOfTrack))
			expect(thrownBy(() => parseMidi(data))).toBe('Unrecognised MIDI event type: 0')
			expect(thrownBy(() => readMidiTokens(data))).toBe('Unrecognised MIDI event type: 0')
		})

		it('rejects bad event lengths and status bytes as parseMidi does', () => {
			for (const event of [
				[0x00, 0xff, 0x51, 0x02, 0x07, 0xa1],
				[0x00, 0xff, 0x58, 0x03, 0x04, 0x02, 0x18],
				[0x00, 0xff, 0x00, 0x01, 0x00],
				[0x00, 0xff, 0x2f, 0x01, 0x00],
				[0x00, 0xf1, 0x00],
			]) {
				const data = file(headerChunk(1, 1, 480), chunk('MTrk', event, endOfTrack))
				expect(thrownBy(() => parseMidi(data))).toBeTypeOf('string')
				expect(thrownBy(() => readMidiTokens(data))).toBe(thrownBy(() => parseMidi(data)))
			}
		})

		it('reads every one-byte change of a file as parseMidi does with the reject policy', () => {
			// Four high-bit bytes in a row can make a negative length, where parseMidi steps backwards and can loop forever
			for (let i = 0; i + 4 <= everyEventFile.length; i++) {
				expect(everyEventFile.subarray(i, i + 4).filter(b => b >= 0x80).length).toBeLessThan(3)
			}
			for (let i = 0; i < everyEventFile.length; i++) {
				for (const value of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
					const data = everyEventFile.slice()
					data[i] = value
					const expectedError = thrownBy(() => parseMidi(data))
					const error = thrownBy(() => readMidiTokens(data, 'reject'))
					if (typeof error === 'string' && error.includes('negative length')) {
						// The reader rejects a negative chunk length that parseMidi reads on from
						expect(expectedError).not.toBeUndefined()
					} else {
						expectReadsLikeParseMidi(data, 'reject')
					}
				}
			}
		})
	})
})
