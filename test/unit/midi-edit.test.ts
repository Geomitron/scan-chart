import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { midiAuthoredTracks } from 'src/chart/authored-view'
import { editMidiTrack, midiEventEdits, midiEventEncoding, midiEventInserts } from 'src/chart/midi-edit'
import { readMidiTokens, serializeMidiTokens } from 'src/chart/midi-tokens'
import { eventTypes } from 'src/chart/raw-types'
import { difficulties, instrumentTypes } from 'src/types'

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

	it('keep a note made zero-length in order: its note-off follows its note-on', () => {
		const tokens = guitar([on(0, 96), off(10, 96), on(470, 97), off(10, 97)])
		const [green, red] = midiAuthoredTracks(tokens)[0].events
		const shortened = editMidiTrack(tokens, 1, midiEventEdits(green, { length: 0 }))
		expect(view(shortened)).toEqual([[0, eventTypes.green, 0], [480, eventTypes.red, 10]])
		// Moving the start onto the end, which stays where it is.
		const collapsed = editMidiTrack(tokens, 1, midiEventEdits(red, { tick: 490, length: 0 }))
		expect(view(collapsed)).toEqual([[0, eventTypes.green, 10], [490, eventTypes.red, 0]])
	})

	it('order a moved sysex end before a sysex start at the same tick, as with note-offs', () => {
		const sysEx = (deltaTime: number, isStart: boolean): Event =>
			({ deltaTime, type: 'sysEx', data: new Uint8Array([0x50, 0x53, 0x00, 0x00, 0x03, 0x04, isStart ? 1 : 0, 0xf7]) })
		const tokens = guitar([on(0, 96), sysEx(0, true), off(10, 96), sysEx(0, false), on(470, 97), sysEx(0, true), off(10, 97), sysEx(0, false)])
		const [firstTap] = midiAuthoredTracks(tokens)[0].events.filter(event => event.type === eventTypes.forceTap)
		const edited = editMidiTrack(tokens, 1, midiEventEdits(firstTap, { length: 480 }))
		expect(midiAuthoredTracks(edited)[0].events.filter(event => event.type === eventTypes.forceTap).map(event => [event.tick, event.length]))
			.toEqual([[0, 480], [480, 10]])
	})

	it('edit a track with more events than a function call can take as arguments', () => {
		const notes = Array.from({ length: 100_000 }, (_, i) => [on(i === 0 ? 0 : 470, 96 + (i % 5)), off(10, 96 + (i % 5))]).flat()
		const tokens = guitar(notes)
		const [first] = midiAuthoredTracks(tokens)[0].events
		const edited = editMidiTrack(tokens, 1, midiEventEdits(first, { length: 20 }))
		expect(midiAuthoredTracks(edited)[0].events[0].length).toBe(20)
	})

	describe('event encodings', () => {
		const instrumentTracks = [
			{ name: 'PART GUITAR', instrumentType: instrumentTypes.fiveFret },
			{ name: 'PART GUITAR GHL', instrumentType: instrumentTypes.sixFret },
			{ name: 'PART DRUMS', instrumentType: instrumentTypes.drums },
		]
		const track = (name: string, enhancedOpens: boolean, events: Event[]) => readMidiTokens(new Uint8Array(writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
			tracks: [
				[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
				[
					{ deltaTime: 0, type: 'trackName', text: name },
					...(enhancedOpens ? [{ deltaTime: 0, type: 'text', text: '[ENHANCED_OPENS]' } as Event] : []),
					...events,
					{ deltaTime: 0, type: 'endOfTrack' },
				],
			],
		})))

		it('give back the note number of every note an instrument track reads', () => {
			for (const { name, instrumentType } of instrumentTracks) {
				for (const enhancedOpens of [false, true]) {
					for (let noteNumber = 0; noteNumber <= 127; noteNumber++) {
						const [event] = midiAuthoredTracks(track(name, enhancedOpens, [on(480, noteNumber), off(10, noteNumber)]))[0]?.events ?? []
						if (!event) continue
						expect(midiEventEncoding(instrumentType, event.scope, event.type, enhancedOpens), `${name} ${noteNumber}`)
							.toEqual({ scope: event.scope, encoding: { kind: 'note', noteNumber } })
					}
				}
			}
		})

		it('write every encodable event so it reads back as its type and scope', () => {
			for (const { name, instrumentType } of instrumentTracks) {
				for (const enhancedOpens of [false, true]) {
					for (const scope of [...difficulties, 'instrument'] as const) {
						for (const type of Object.values(eventTypes)) {
							const encoded = midiEventEncoding(instrumentType, scope, type, enhancedOpens)
							if (!encoded) continue
							const tokens = track(name, enhancedOpens, [])
							const edited = editMidiTrack(tokens, 1, midiEventInserts(encoded.encoding, 480, 120))
							const events = midiAuthoredTracks(edited)[0].events.map(event => [event.tick, event.length, event.type, event.scope])
							expect(events, `${name} ${scope} ${type}`).toEqual([[480, 120, type, encoded.scope]])
						}
					}
				}
			}
		})

		it('write an event the format stores once for the instrument for the instrument, whichever difficulty asks', () => {
			expect(midiEventEncoding(instrumentTypes.fiveFret, 'hard', eventTypes.starPower, false))
				.toEqual({ scope: 'instrument', encoding: { kind: 'note', noteNumber: 116 } })
			expect(midiEventEncoding(instrumentTypes.fiveFret, 'hard', eventTypes.forceTap, false))
				.toEqual({ scope: 'hard', encoding: { kind: 'sysEx', difficultyByte: 2, typeByte: 4 } })
			expect(midiEventEncoding(instrumentTypes.fiveFret, 'expert', eventTypes.open, false)).toBeNull() // needs ENHANCED_OPENS
			expect(midiEventEncoding(instrumentTypes.drums, 'expert', eventTypes.green, false)).toBeNull()
		})
	})

	it('refuse a length for an element written as one event, such as a disco flip', () => {
		const tokens = readMidiTokens(new Uint8Array(writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
			tracks: [
				[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
				[
					{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' },
					{ deltaTime: 0, type: 'text', text: '[mix 3 drums0d]' },
					on(0, 96), off(10, 96),
					{ deltaTime: 0, type: 'endOfTrack' },
				],
			],
		})))
		const discoFlip = midiAuthoredTracks(tokens)[0].events.find(event => event.type === eventTypes.discoFlipOn)!
		expect(() => midiEventEdits(discoFlip, { length: 7 })).toThrow('The event has no length')
		expect(view(editMidiTrack(tokens, 1, midiEventEdits(discoFlip, { tick: 5 })))).toContainEqual([5, eventTypes.discoFlipOn, 0])
	})

	it('read and edit a file whose conductor track can\'t be parsed, so it can be fixed', () => {
		const tokens = readMidiTokens(new Uint8Array(writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
			tracks: [
				[{ deltaTime: 0, type: 'timeSignature', numerator: 0, denominator: 4, metronome: 24, thirtyseconds: 8 }, { deltaTime: 0, type: 'endOfTrack' }],
				[{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' }, on(0, 96), off(10, 96), { deltaTime: 0, type: 'endOfTrack' }],
			],
		})))
		const [green] = midiAuthoredTracks(tokens)[0].events
		expect(view(editMidiTrack(tokens, 1, midiEventEdits(green, { length: 240 })))).toEqual([[0, eventTypes.green, 240]])
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
