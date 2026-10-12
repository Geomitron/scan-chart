import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { midiAuthoredTracks } from 'src/chart/authored-view'
import { editMidiTrack, midiEventEdits } from 'src/chart/midi-edit'
import { readMidiTokens, serializeMidiTokens } from 'src/chart/midi-tokens'
import { eventTypes } from 'src/chart/raw-types'

type Event = MidiData['tracks'][number][number]
const on = (deltaTime: number, noteNumber: number, running = false): Event =>
	({ deltaTime, type: 'noteOn', channel: 0, noteNumber, velocity: 100, ...(running ? { running: true } : {}) })
const off = (deltaTime: number, noteNumber: number, running = false): Event =>
	({ deltaTime, type: 'noteOff', channel: 0, noteNumber, velocity: 0, ...(running ? { running: true } : {}) })

function guitar(events: Event[]) {
	return readMidiTokens(new Uint8Array(writeMidi({
		header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
		tracks: [
			[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
			[{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' }, ...events, { deltaTime: 0, type: 'endOfTrack' }],
		],
	})))
}
const view = (tokens: ReturnType<typeof guitar>) => midiAuthoredTracks(tokens)[0].events.map(event => [event.tick, event.type, event.length])

describe('MIDI track edits', () => {
	it('give back every byte when nothing is edited', () => {
		const tokens = guitar([on(0, 96), off(10, 96), on(470, 97), off(10, 97)])
		expect(serializeMidiTokens(editMidiTrack(tokens, 1, []))).toEqual(tokens.data)
	})

	it('lengthen a note by moving its note-off, keeping the other chunks\' bytes', () => {
		const tokens = guitar([on(0, 96), off(10, 96), on(470, 97), off(10, 97)])
		const [green] = midiAuthoredTracks(tokens)[0].events
		const edited = editMidiTrack(tokens, 1, midiEventEdits(green, { length: 240 }))
		expect(view(edited)).toEqual([[0, eventTypes.green, 240], [480, eventTypes.red, 10]])
		expect(edited.data.subarray(0, tokens.chunks[1].start)).toEqual(tokens.data.subarray(0, tokens.chunks[1].start))
	})

	it('write a status byte when an edit breaks the running status an event relied on', () => {
		// The red note-off uses running status from the green note-off. Lengthening green moves its note-off after red's,
		// so red's note-off follows red's note-on and needs its own status byte.
		const tokens = guitar([on(0, 96), on(0, 97, true), off(10, 96), off(0, 97, true)])
		const redOff = tokens.chunks[1].kind === 'track' ? tokens.chunks[1].events[4] : undefined
		expect(tokens.data[redOff!.start + 1]).toBe(97) // written with running status: the note number follows the delta
		const green = midiAuthoredTracks(tokens)[0].events.find(event => event.type === eventTypes.green)!
		const edited = editMidiTrack(tokens, 1, midiEventEdits(green, { length: 20 }))
		expect(view(edited)).toEqual([[0, eventTypes.red, 10], [0, eventTypes.green, 20]])
		const editedRedOff = edited.chunks[1].kind === 'track' ? edited.chunks[1].events.find(token => token.event.type === 'noteOff' && token.event.noteNumber === 97) : undefined
		expect((editedRedOff!.event as { running?: boolean }).running).toBeUndefined() // its status byte is written again
	})

	it('insert a note and delete one', () => {
		const tokens = guitar([on(0, 96), off(10, 96)])
		const edited = editMidiTrack(tokens, 1, [
			{ kind: 'delete', event: 1 },
			{ kind: 'delete', event: 2 },
			{ kind: 'insert', tick: 480, event: { type: 'noteOn', channel: 0, noteNumber: 98, velocity: 100 } },
			{ kind: 'insert', tick: 600, event: { type: 'noteOff', channel: 0, noteNumber: 98, velocity: 0 } },
		])
		expect(view(edited)).toEqual([[480, eventTypes.yellow, 120]])
	})
})
