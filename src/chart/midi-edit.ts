import type { AuthoredEvent, MidiAuthoredSource } from './authored-view'
import { MidiEventToken, MidiTokens, readMidiTokens } from './midi-tokens'

/** A new note-on or note-off for an edited MIDI track. */
export interface NewMidiNoteEvent {
	readonly type: 'noteOn' | 'noteOff'
	readonly channel: number
	readonly noteNumber: number
	readonly velocity: number
}

/** One edit of a MIDI track chunk's events. Event indices are positions in the chunk's original events. */
export type MidiTrackEdit =
	| { readonly kind: 'move'; readonly event: number; readonly tick: number }
	| { readonly kind: 'delete'; readonly event: number }
	| { readonly kind: 'insert'; readonly tick: number; readonly event: NewMidiNoteEvent }

type Item =
	| { readonly kind: 'original'; readonly index: number; readonly token: MidiEventToken; readonly tick: number; readonly moved: boolean }
	| { readonly kind: 'new'; readonly order: number; readonly event: NewMidiNoteEvent; readonly tick: number }

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

	// Unchanged events keep their order. At a shared tick, moved and new note-offs go first and note-ons last, so a
	// note ending where another starts pairs as before; the end of the track stays last.
	const isEndOfTrack = (item: Item) => item.kind === 'original' && item.token.event.type === 'endOfTrack'
	const rank = (item: Item) => isEndOfTrack(item) ? 3
		: item.kind === 'original' && !item.moved ? 1
		: isNoteOff(item) ? 0 : 2
	const endOfTrack = items.find(isEndOfTrack)
	if (endOfTrack?.kind === 'original') {
		const lastTick = items.reduce((last, item) => item === endOfTrack ? last : Math.max(last, item.tick), 0)
		if (lastTick > endOfTrack.tick) items[items.indexOf(endOfTrack)] = { ...endOfTrack, tick: lastTick, moved: true }
	}
	items.sort((a, b) => a.tick - b.tick || rank(a) - rank(b) || sequence(a) - sequence(b))

	const body: number[] = []
	let previousTick = 0
	let lastStatus: number | null = null
	for (const item of items) {
		const delta = item.tick - previousTick
		previousTick = item.tick
		if (item.kind === 'new') {
			const statusByte = (item.event.type === 'noteOn' ? 0x90 : 0x80) | item.event.channel
			body.push(...variableLength(delta), statusByte, item.event.noteNumber, item.event.velocity)
			lastStatus = statusByte
			continue
		}
		const { token } = item
		const eventStatus = status.of[item.index]
		const statusIsWritten = status.written[item.index]
		const runningHolds = statusIsWritten || eventStatus === null || lastStatus === eventStatus
		if (token.event.deltaTime === delta && runningHolds) {
			for (let i = token.start; i < token.end; i++) body.push(data[i])
		} else {
			body.push(...variableLength(delta))
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

function isNoteOff(item: Item): boolean {
	const event = item.kind === 'new' ? item.event : item.token.event
	return event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)
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
