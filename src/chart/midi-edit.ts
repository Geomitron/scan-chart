import type { MidiEvent } from '@geomitron/midi-file'

import { type Difficulty, type InstrumentType, instrumentTypes } from '../types'
import type { MidiAuthoredSource } from './authored-view'
import { get5FretNoteType, get6FretNoteType, getDrumsNoteType, getInstrumentEventType } from './midi-file-parser'
import { MidiEventToken, MidiTokens, replaceMidiTrackChunk } from './midi-tokens'
import { type EventType, eventTypes } from './raw-types'

/**
 * A new event for an edited MIDI track: a note-on or note-off, a Phase Shift sysex such as an open or tap marker, or a
 * meta event such as a tempo, time signature or text event.
 */
export type NewMidiEvent =
	| { readonly type: 'noteOn' | 'noteOff'; readonly channel: number; readonly noteNumber: number; readonly velocity: number }
	| { readonly type: 'sysEx'; readonly data: Uint8Array }
	| { readonly type: 'meta'; readonly metaType: number; readonly data: Uint8Array }

/**
 * One edit of a MIDI track chunk's events. Event indices are positions in the chunk's original events. A replaced
 * event keeps its place; only a meta event can be replaced.
 */
export type MidiTrackEdit =
	| { readonly kind: 'move'; readonly event: number; readonly tick: number }
	| { readonly kind: 'delete'; readonly event: number }
	| { readonly kind: 'insert'; readonly tick: number; readonly event: NewMidiEvent }
	| { readonly kind: 'replace'; readonly event: number; readonly with: NewMidiEvent & { readonly type: 'meta' } }

type NewItem = { readonly kind: 'new'; readonly order: number; readonly event: NewMidiEvent; readonly tick: number }

/** An event placed by rank: an edited event, an end an edit can give its start's tick, or the end of the track. */
type Placed =
	| { readonly kind: 'original'; readonly index: number; readonly tick: number; readonly rank: number; readonly replacement?: NewMidiEvent }
	| NewItem & { readonly rank: number }

/**
 * Applies edits to one MIDI track chunk and returns the edited file, tokenized. Every other chunk is copied unchanged.
 * In the edited chunk, each event whose delta time and running status are unchanged keeps its bytes; an event whose
 * delta time changes keeps its body; new events are written in full.
 */
export function editMidiTrack(tokens: MidiTokens, chunkIndex: number, edits: readonly MidiTrackEdit[]): MidiTokens {
	const chunk = tokens.chunks[chunkIndex]
	if (chunk?.kind !== 'track') throw new RangeError('Only a MIDI track chunk can be edited')
	const { data } = tokens
	const status = effectiveStatusBytes(data, chunk.events)

	const deleted = new Set<number>()
	const moves = new Map<number, number>()
	const replacements = new Map<number, NewMidiEvent>()
	const inserted: NewItem[] = []
	edits.forEach((edit, order) => {
		if (edit.kind === 'delete') deleted.add(edit.event)
		else if (edit.kind === 'move') moves.set(edit.event, edit.tick)
		else if (edit.kind === 'replace') {
			if (data[status.bodyStart[edit.event]] !== 0xff) throw new RangeError('Only a meta event can be replaced')
			replacements.set(edit.event, edit.with)
		} else inserted.push({ kind: 'new', order, event: edit.event, tick: edit.tick })
	})
	const events = chunk.events
	const tickOf = (index: number) => moves.get(index) ?? events[index].tick

	// Unchanged events keep their order. At a shared tick, moved and new ends go first and moved and new starts after
	// them, so a note ending where another starts pairs as before. An edited note or phrase of zero length has its end
	// after its start, and the end of the track stays last. Only edited events, their partners and the end of the
	// track are placed by rank; every other event stays in its run of unchanged events, which is already in order.
	const placed: Placed[] = []
	const taken = new Set<number>()
	const place = (index: number, rank: number, tick = tickOf(index)) => {
		if (deleted.has(index) || taken.has(index)) return
		taken.add(index)
		placed.push({ kind: 'original', index, tick, rank, replacement: replacements.get(index) })
	}
	const endsOfTrack: number[] = []
	for (let index = 0; index < events.length; index++) {
		if (events[index].event.type === 'endOfTrack' && !deleted.has(index)) endsOfTrack.push(index)
	}
	if (endsOfTrack.length) {
		// The first end of the track moves to the last event's tick when an edit puts an event after it.
		let lastTick = 0
		for (let index = 0; index < events.length; index++) {
			if (index !== endsOfTrack[0] && !deleted.has(index)) lastTick = Math.max(lastTick, tickOf(index))
		}
		for (const item of inserted) lastTick = Math.max(lastTick, item.tick)
		place(endsOfTrack[0], 4, Math.max(tickOf(endsOfTrack[0]), lastTick))
		for (const index of endsOfTrack.slice(1)) place(index, 4)
	}
	for (const index of moves.keys()) {
		if (deleted.has(index)) continue
		const end = endpoint(events[index].event)
		if (!end) {
			place(index, 2)
			continue
		}
		// The start and end are paired as before the edit.
		const [startIndex, endIndex] = end.isStart ? [index, partnerEnd(events, index, deleted)] : [partnerStart(events, index, deleted), index]
		if (endIndex !== undefined) {
			const sharesTick = startIndex !== undefined && tickOf(startIndex) === tickOf(endIndex)
			place(endIndex, sharesTick ? 3 : moves.has(endIndex) ? 0 : 1)
		}
		if (startIndex !== undefined && moves.has(startIndex)) place(startIndex, 2)
	}
	// A malformed chunk can read with ticks that go back, from a delta time too long for 32 bits. Its unchanged events
	// aren't in order then, so every event is placed by rank, which puts them in order.
	if (events.some((token, index) => index > 0 && token.tick < events[index - 1].tick)) {
		for (let index = 0; index < events.length; index++) place(index, 1)
	}
	const newPartners = pairNewEvents(inserted)
	for (const item of inserted) {
		const end = endpoint(item.event)
		const start = end?.isStart === false ? newPartners.get(item) : undefined
		placed.push({ ...item, rank: start?.tick === item.tick ? 3 : end?.isStart === false ? 0 : 2 })
	}
	placed.sort(comparePlaced)

	const writer = new ChunkWriter(data)
	let previousTick = 0
	let lastStatus: number | null = null
	const writeOriginal = (index: number, tick: number, replacement: NewMidiEvent | undefined) => {
		const delta = tick - previousTick
		previousTick = tick
		if (replacement) {
			// A meta event replaced by a meta event: running status is as it was.
			writer.write([...variableLength(delta), ...encodeNewEvent(replacement)])
			return
		}
		const token = events[index]
		const eventStatus = status.of[index]
		const runningHolds = status.written[index] || eventStatus === null || lastStatus === eventStatus
		if (token.event.deltaTime === delta && runningHolds) {
			writer.copy(token.start, token.end)
		} else {
			writer.write([...variableLength(delta), ...(runningHolds ? [] : [eventStatus!])])
			writer.copy(status.bodyStart[index], token.end)
		}
		if (eventStatus !== null) lastStatus = eventStatus
	}
	let next = 0
	const writePlacedBefore = (tick: number, index: number) => {
		while (next < placed.length && comparePlaced(placed[next], { kind: 'original', index, tick, rank: 1 }) < 0) {
			const item = placed[next++]
			if (item.kind === 'original') {
				writeOriginal(item.index, item.tick, item.replacement)
				continue
			}
			const delta = item.tick - previousTick
			previousTick = item.tick
			const encoded = encodeNewEvent(item.event)
			writer.write([...variableLength(delta), ...encoded])
			// A note event sets running status. Some readers end it at a sysex or meta event, so the next channel event
			// after one of those writes its own status byte.
			lastStatus = item.event.type === 'noteOn' || item.event.type === 'noteOff' ? encoded[0] : null
		}
	}
	for (let index = 0; index < events.length; index++) {
		if (deleted.has(index) || taken.has(index)) continue
		writePlacedBefore(events[index].tick, index)
		writeOriginal(index, events[index].tick, replacements.get(index))
	}
	writePlacedBefore(Infinity, Infinity)

	const body = writer.bytes()
	const chunkBytes = new Uint8Array(8 + body.length)
	chunkBytes.set([0x4d, 0x54, 0x72, 0x6b]) // MTrk
	new DataView(chunkBytes.buffer).setUint32(4, body.length)
	chunkBytes.set(body, 8)
	return replaceMidiTrackChunk(tokens, chunkIndex, chunkBytes)
}

/** Events in written order: by tick, then rank, then file order, with new events after the file's in edit order. */
function comparePlaced(a: Placed, b: Placed): number {
	return a.tick - b.tick || a.rank - b.rank || (a.kind === 'original' ? a.index : 1e9 + a.order) - (b.kind === 'original' ? b.index : 1e9 + b.order)
}

/** Collects a chunk body from runs of the file's bytes and newly written bytes. */
class ChunkWriter {
	private readonly parts: Uint8Array[] = []
	private runStart = -1
	private runEnd = -1

	constructor(private readonly data: Uint8Array) {}

	copy(start: number, end: number): void {
		if (this.runStart >= 0 && this.runEnd === start) {
			this.runEnd = end
			return
		}
		this.endRun()
		this.runStart = start
		this.runEnd = end
	}

	write(bytes: readonly number[]): void {
		this.endRun()
		this.parts.push(Uint8Array.from(bytes))
	}

	bytes(): Uint8Array {
		this.endRun()
		const out = new Uint8Array(this.parts.reduce((total, part) => total + part.length, 0))
		let at = 0
		for (const part of this.parts) {
			out.set(part, at)
			at += part.length
		}
		return out
	}

	private endRun(): void {
		if (this.runStart >= 0) this.parts.push(this.data.subarray(this.runStart, this.runEnd))
		this.runStart = -1
	}
}

/**
 * The end paired with the start at `index`, as parsing pairs them: each end takes the most recent unpaired start of its
 * key. Deleted events don't take part.
 */
function partnerEnd(events: readonly MidiEventToken[], index: number, deleted: ReadonlySet<number>): number | undefined {
	const key = endpoint(events[index].event)!.key
	let depth = 0
	for (let i = index + 1; i < events.length; i++) {
		const other = deleted.has(i) ? null : endpoint(events[i].event)
		if (other?.key !== key) continue
		if (other.isStart) depth++
		else if (depth === 0) return i
		else depth--
	}
	return undefined
}

/** The start paired with the end at `index`, as parsing pairs them. Deleted events don't take part. */
function partnerStart(events: readonly MidiEventToken[], index: number, deleted: ReadonlySet<number>): number | undefined {
	const key = endpoint(events[index].event)!.key
	let depth = 0
	for (let i = index - 1; i >= 0; i--) {
		const other = deleted.has(i) ? null : endpoint(events[i].event)
		if (other?.key !== key) continue
		if (!other.isStart) depth++
		else if (depth === 0) return i
		else depth--
	}
	return undefined
}

/** Each new end's start among the new events, pairing them in edit order as parsing would. */
function pairNewEvents(inserted: readonly NewItem[]): Map<NewItem, NewItem> {
	const partners = new Map<NewItem, NewItem>()
	const unpaired = new Map<string, NewItem[]>()
	for (const item of inserted) {
		const end = endpoint(item.event)
		if (!end) continue
		let starts = unpaired.get(end.key)
		if (!starts) unpaired.set(end.key, starts = [])
		if (end.isStart) starts.push(item)
		else if (starts.length) partners.set(item, starts.pop()!)
	}
	return partners
}

/**
 * The track edits that change an authored MIDI element's tick or length: its start and end events move. An element
 * written as one event, such as a tempo, has no length.
 */
export function midiEventEdits(
	event: { readonly tick: number; readonly length?: number; readonly source: MidiAuthoredSource },
	change: { readonly tick?: number; readonly length?: number },
): MidiTrackEdit[] {
	const tick = change.tick ?? event.tick
	const length = change.length ?? event.length ?? 0
	const [start, end] = event.source.events
	// An element written as one event, such as a disco flip or a tempo, has no end to move.
	if (start === end && length !== (event.length ?? 0)) throw new RangeError('The event has no length')
	if (length < 0) throw new RangeError('A length can\'t be negative')
	return [
		...(tick === event.tick ? [] : [{ kind: 'move' as const, event: start, tick }]),
		...(end === start || tick + length === event.tick + (event.length ?? 0) ? [] : [{ kind: 'move' as const, event: end, tick: tick + length }]),
	]
}

/** A tempo meta event. Throws if the tempo can't be written as whole microseconds per beat in three bytes. */
export function midiTempoEvent(beatsPerMinute: number): NewMidiEvent & { readonly type: 'meta' } {
	const microsecondsPerBeat = Math.round(60000000 / beatsPerMinute)
	if (!(microsecondsPerBeat >= 1 && microsecondsPerBeat <= 0xffffff)) throw new RangeError('A .mid tempo must be between 3.58 and 60,000,000 BPM')
	return { type: 'meta', metaType: 0x51, data: new Uint8Array([microsecondsPerBeat >> 16, (microsecondsPerBeat >> 8) & 0xff, microsecondsPerBeat & 0xff]) }
}

/**
 * A time signature meta event. Its metronome fields are copied from `original` when it replaces one, or are the usual
 * 24 clocks per click and 8 thirty-second notes per quarter note.
 */
export function midiTimeSignatureEvent(
	numerator: number,
	denominator: number,
	original?: { readonly metronome: number; readonly thirtyseconds: number },
): NewMidiEvent & { readonly type: 'meta' } {
	const exponent = Math.log2(denominator)
	if (!Number.isInteger(numerator) || numerator < 1 || numerator > 255 || !Number.isInteger(exponent) || exponent < 0 || exponent > 31) {
		throw new RangeError('A time signature needs a numerator from 1 to 255 and a power-of-two denominator')
	}
	return { type: 'meta', metaType: 0x58, data: new Uint8Array([numerator, exponent, original?.metronome ?? 24, original?.thirtyseconds ?? 8]) }
}

/** A text meta event, of the original's kind (text, lyric, marker or cue point) when it replaces one. */
export function midiTextEvent(text: string, original?: MidiEvent): NewMidiEvent & { readonly type: 'meta' } {
	const metaType = original?.type === 'lyrics' ? 0x05 : original?.type === 'marker' ? 0x06 : original?.type === 'cuePoint' ? 0x07 : 0x01
	const data = new TextEncoder().encode(text)
	// Readers decode MIDI text as UTF-8 when that gives fewer characters than bytes, and byte by byte otherwise; both
	// give back text written as UTF-8, except a lone surrogate, which UTF-8 can't hold.
	if (new TextDecoder().decode(data) !== text) throw new RangeError('The text can\'t be written to a .mid file')
	return { type: 'meta', metaType, data }
}

function encodeNewEvent(event: NewMidiEvent): number[] {
	switch (event.type) {
		case 'noteOn':
		case 'noteOff':
			return [(event.type === 'noteOn' ? 0x90 : 0x80) | event.channel, event.noteNumber, event.velocity]
		case 'sysEx':
			return [0xf0, ...variableLength(event.data.length), ...event.data]
		case 'meta':
			return [0xff, event.metaType, ...variableLength(event.data.length), ...event.data]
	}
}

/** How a `.mid` instrument track writes an event type: a note number, or a Phase Shift sysex for open and tap markers. */
export type MidiEventEncoding =
	| { readonly kind: 'note'; readonly noteNumber: number }
	| { readonly kind: 'sysEx'; readonly difficultyByte: number; readonly typeByte: number }

/**
 * How a `.mid` instrument track of `instrumentType` writes an event of `type` for `scope`, and the scope it's stored
 * for, or `null` when the format can't hold it. The note numbers are the inverse of the ones parsing reads. An event
 * type the format stores only once for the instrument, such as star power, is written for the instrument whichever
 * difficulty asks for it (r4 Q3). An open note on five-fret needs `enhancedOpens`, the track's `ENHANCED_OPENS`.
 */
export function midiEventEncoding(
	instrumentType: InstrumentType,
	scope: Difficulty | 'instrument',
	type: EventType,
	enhancedOpens: boolean,
): { readonly scope: Difficulty | 'instrument'; readonly encoding: MidiEventEncoding } | null {
	const noteNumber = noteNumbersOf(instrumentType, enhancedOpens).get(`${scope}:${type}`)
	if (noteNumber !== undefined) return { scope, encoding: { kind: 'note', noteNumber } }
	const typeByte = type === eventTypes.forceOpen && instrumentType === instrumentTypes.fiveFret ? 0x01
		: type === eventTypes.forceTap && instrumentType !== instrumentTypes.drums ? 0x04
		: null
	if (typeByte !== null) {
		const difficultyByte = scope === 'instrument' ? 0xff : ['easy', 'medium', 'hard', 'expert'].indexOf(scope)
		return { scope, encoding: { kind: 'sysEx', difficultyByte, typeByte } }
	}
	return scope === 'instrument' ? null : midiEventEncoding(instrumentType, 'instrument', type, enhancedOpens)
}

/** The start and end events that write a new event at `tick` for `length` ticks. */
export function midiEventInserts(
	encoding: MidiEventEncoding,
	tick: number,
	length: number,
	note: { readonly velocity: number; readonly channel: number } = { velocity: 100, channel: 0 },
): MidiTrackEdit[] {
	if (length < 0) throw new RangeError('A length can\'t be negative')
	const events: [NewMidiEvent, NewMidiEvent] = encoding.kind === 'note'
		? [
			{ type: 'noteOn', channel: note.channel, noteNumber: encoding.noteNumber, velocity: note.velocity },
			{ type: 'noteOff', channel: note.channel, noteNumber: encoding.noteNumber, velocity: 0 },
		]
		: [true, false].map(isStart => ({
			type: 'sysEx' as const,
			data: new Uint8Array([0x50, 0x53, 0x00, 0x00, encoding.difficultyByte, encoding.typeByte, isStart ? 0x01 : 0x00, 0xf7]),
		})) as [NewMidiEvent, NewMidiEvent]
	return [{ kind: 'insert', tick, event: events[0] }, { kind: 'insert', tick: tick + length, event: events[1] }]
}

const noteNumberTables = new Map<string, Map<string, number>>()

/** Each `scope:type` an instrument track's note numbers are read as, mapped back to its note number. */
function noteNumbersOf(instrumentType: InstrumentType, enhancedOpens: boolean): Map<string, number> {
	const tableKey = `${instrumentType}:${enhancedOpens}`
	let table = noteNumberTables.get(tableKey)
	if (table) return table
	table = new Map()
	for (let noteNumber = 0; noteNumber <= 127; noteNumber++) {
		// The ranges are the ones parsing reads each difficulty from.
		const scope: Difficulty | 'instrument' = noteNumber <= 66 ? 'easy' : noteNumber <= 78 ? 'medium' : noteNumber <= 90 ? 'hard'
			: noteNumber <= 102 ? 'expert' : 'instrument'
		const type = scope === 'instrument' ? getInstrumentEventType(noteNumber)
			: instrumentType === instrumentTypes.sixFret ? get6FretNoteType(noteNumber, scope)
			: instrumentType === instrumentTypes.drums ? getDrumsNoteType(noteNumber, scope)
			: instrumentType === instrumentTypes.fiveFret ? get5FretNoteType(noteNumber, scope, enhancedOpens)
			: null
		if (type !== null && !table.has(`${scope}:${type}`)) table.set(`${scope}:${type}`, noteNumber)
	}
	noteNumberTables.set(tableKey, table)
	return table
}

/** Whether an event starts or ends a note or a Phase Shift sysex phrase, and the key parsing pairs it by. */
function endpoint(event: MidiEvent | NewMidiEvent): { readonly key: string; readonly isStart: boolean } | null {
	if (event.type === 'noteOn' || event.type === 'noteOff') {
		return { key: `n${event.channel}:${event.noteNumber}`, isStart: event.type === 'noteOn' && event.velocity > 0 }
	}
	if ((event.type === 'sysEx' || event.type === 'endSysEx') && event.data.length > 6
		&& event.data[0] === 0x50 && event.data[1] === 0x53 && event.data[2] === 0x00 && event.data[3] === 0x00) {
		const difficulty = event.data[4] === 0xff ? 'all' : Math.min(event.data[4], 3)
		return { key: `s${difficulty}:${event.data[5]}`, isStart: event.data[6] === 0x01 }
	}
	return null
}

/**
 * Each event's channel status byte, whether it writes it or relies on running status, and where its body starts after
 * the delta time. Running status follows `parseMidi`: only a written channel status byte sets it.
 */
function effectiveStatusBytes(data: Uint8Array, events: readonly MidiEventToken[]) {
	const of: (number | null)[] = [], written: boolean[] = [], bodyStart: number[] = []
	let last: number | null = null
	for (const token of events) {
		let at = token.start
		while (data[at] & 0x80) at++
		at++ // past the delta time
		bodyStart.push(at)
		const first = data[at]
		if (first === 0xff || first === 0xf0 || first === 0xf7) {
			of.push(null)
			written.push(false)
		} else if (first & 0x80) {
			of.push(first)
			written.push(true)
			last = first
		} else {
			of.push(last)
			written.push(false)
		}
	}
	return { of, written, bodyStart }
}

function variableLength(value: number): number[] {
	const bytes = [value & 0x7f]
	for (value = Math.floor(value / 128); value > 0; value = Math.floor(value / 128)) bytes.unshift((value & 0x7f) | 0x80)
	return bytes
}
