import type { MidiEvent } from '@geomitron/midi-file'

import { type Difficulty, type InstrumentType, instrumentTypes } from '../types'
import type { AuthoredEvent, MidiAuthoredSource } from './authored-view'
import { get5FretNoteType, get6FretNoteType, getDrumsNoteType, getInstrumentEventType } from './midi-file-parser'
import { MidiEventToken, MidiTokens, readMidiTokens } from './midi-tokens'
import { type EventType, eventTypes } from './raw-types'

/** A new event for an edited MIDI track: a note-on or note-off, or a Phase Shift sysex such as an open or tap marker. */
export type NewMidiEvent =
	| { readonly type: 'noteOn' | 'noteOff'; readonly channel: number; readonly noteNumber: number; readonly velocity: number }
	| { readonly type: 'sysEx'; readonly data: Uint8Array }

/** One edit of a MIDI track chunk's events. Event indices are positions in the chunk's original events. */
export type MidiTrackEdit =
	| { readonly kind: 'move'; readonly event: number; readonly tick: number }
	| { readonly kind: 'delete'; readonly event: number }
	| { readonly kind: 'insert'; readonly tick: number; readonly event: NewMidiEvent }

type Item =
	| { readonly kind: 'original'; readonly index: number; readonly token: MidiEventToken; readonly tick: number; readonly moved: boolean }
	| { readonly kind: 'new'; readonly order: number; readonly event: NewMidiEvent; readonly tick: number }

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
	const inserted: Item[] = []
	edits.forEach((edit, order) => {
		if (edit.kind === 'delete') deleted.add(edit.event)
		else if (edit.kind === 'move') moves.set(edit.event, edit.tick)
		else inserted.push({ kind: 'new', order, event: edit.event, tick: edit.tick })
	})
	const items: Item[] = chunk.events.flatMap((token, index): Item[] => deleted.has(index) ? [] : [{
		kind: 'original', index, token, tick: moves.get(index) ?? token.tick, moved: moves.has(index),
	}])
	for (const item of inserted) items.push(item)

	// Unchanged events keep their order. At a shared tick, moved and new ends go first and moved and new starts after
	// them, so a note ending where another starts pairs as before. An edited note or phrase of zero length has its end
	// after its start, and the end of the track stays last.
	const partners = pairStartsAndEnds(items)
	const isEndOfTrack = (item: Item) => item.kind === 'original' && item.token.event.type === 'endOfTrack'
	const isEdited = (item: Item) => item.kind === 'new' || item.moved
	const rank = (item: Item) => {
		if (isEndOfTrack(item)) return 4
		const end = endpointOf(item)
		const start = end?.isStart === false ? partners.get(item) : undefined
		if (start && start.tick === item.tick && (isEdited(item) || isEdited(start))) return 3
		if (!isEdited(item)) return 1
		return end?.isStart === false ? 0 : 2
	}
	const endOfTrack = items.find(isEndOfTrack)
	if (endOfTrack?.kind === 'original') {
		const lastTick = items.reduce((last, item) => item === endOfTrack ? last : Math.max(last, item.tick), 0)
		if (lastTick > endOfTrack.tick) items[items.indexOf(endOfTrack)] = { ...endOfTrack, tick: lastTick, moved: true }
	}
	const ranks = new Map(items.map(item => [item, rank(item)]))
	items.sort((a, b) => a.tick - b.tick || ranks.get(a)! - ranks.get(b)! || sequence(a) - sequence(b))

	const body: number[] = []
	let previousTick = 0
	let lastStatus: number | null = null
	for (const item of items) {
		const delta = item.tick - previousTick
		previousTick = item.tick
		if (item.kind === 'new') {
			for (const byte of variableLength(delta)) body.push(byte)
			if (item.event.type === 'sysEx') {
				body.push(0xf0)
				for (const byte of variableLength(item.event.data.length)) body.push(byte)
				for (const byte of item.event.data) body.push(byte)
				lastStatus = null // Some readers end running status at a sysex, so the next channel event writes its own
			} else {
				const statusByte = (item.event.type === 'noteOn' ? 0x90 : 0x80) | item.event.channel
				body.push(statusByte, item.event.noteNumber, item.event.velocity)
				lastStatus = statusByte
			}
			continue
		}
		const { token } = item
		const eventStatus = status.of[item.index]
		const statusIsWritten = status.written[item.index]
		const runningHolds = statusIsWritten || eventStatus === null || lastStatus === eventStatus
		if (token.event.deltaTime === delta && runningHolds) {
			for (let i = token.start; i < token.end; i++) body.push(data[i])
		} else {
			for (const byte of variableLength(delta)) body.push(byte)
			if (!runningHolds) body.push(eventStatus!)
			for (let i = status.bodyStart[item.index]; i < token.end; i++) body.push(data[i])
		}
		if (eventStatus !== null) lastStatus = eventStatus
	}

	const chunkBytes = new Uint8Array(8 + body.length)
	chunkBytes.set([0x4d, 0x54, 0x72, 0x6b]) // MTrk
	new DataView(chunkBytes.buffer).setUint32(4, body.length)
	chunkBytes.set(body, 8)
	const edited = new Uint8Array(data.length - (chunk.end - chunk.start) + chunkBytes.length)
	edited.set(data.subarray(0, chunk.start))
	edited.set(chunkBytes, chunk.start)
	edited.set(data.subarray(chunk.end), chunk.start + chunkBytes.length)
	return readMidiTokens(edited, 'skip')
}

/** The track edits that change an authored MIDI event's tick or length: its start and end events move. */
export function midiEventEdits(
	event: AuthoredEvent & { readonly source: MidiAuthoredSource },
	change: { readonly tick?: number; readonly length?: number },
): MidiTrackEdit[] {
	const tick = change.tick ?? event.tick
	const length = change.length ?? event.length
	if (length < 0) throw new RangeError('A length can\'t be negative')
	const [start, end] = event.source.events
	return [
		...(tick === event.tick ? [] : [{ kind: 'move' as const, event: start, tick }]),
		...(tick + length === event.tick + event.length ? [] : [{ kind: 'move' as const, event: end, tick: tick + length }]),
	]
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

function endpointOf(item: Item) {
	return endpoint(item.kind === 'new' ? item.event : item.token.event)
}

/**
 * Each end item's start, paired as parsing pairs them: with the most recent unpaired start of its key. Unedited events
 * pair in file order; an edited end pairs with its start from before the edit, and a new end with the new start
 * inserted before it.
 */
function pairStartsAndEnds(items: readonly Item[]): Map<Item, Item> {
	const partners = new Map<Item, Item>()
	const pair = (ordered: readonly Item[]) => {
		const unpaired = new Map<string, Item[]>()
		for (const item of ordered) {
			const end = endpointOf(item)
			if (!end) continue
			let starts = unpaired.get(end.key)
			if (!starts) unpaired.set(end.key, starts = [])
			if (end.isStart) starts.push(item)
			else if (starts.length) partners.set(item, starts.pop()!)
		}
	}
	pair(items.filter(item => item.kind === 'original').sort((a, b) => sequence(a) - sequence(b)))
	pair(items.filter(item => item.kind === 'new').sort((a, b) => sequence(a) - sequence(b)))
	return partners
}

function sequence(item: Item): number {
	return item.kind === 'original' ? item.index : 1e9 + item.order
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
