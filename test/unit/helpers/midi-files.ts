import { type MidiData, writeMidi } from '@geomitron/midi-file'

type MidiEvent = MidiData['tracks'][number][number]

/** A MIDI event at an absolute tick; its `deltaTime` is worked out when the file is built. */
export interface TimedMidiEvent {
	readonly tick: number
	readonly event: Omit<MidiEvent, 'deltaTime'>
}

/**
 * A format-1 `.mid` file: a tempo track with `tempos` (microseconds per beat, 120 BPM at tick 0 by default), then each
 * track, named `name`, with its events in tick order. Events of one tick keep the order given.
 */
export function midiFile(
	tracks: readonly { readonly name: string; readonly events: readonly TimedMidiEvent[] }[],
	options: { readonly resolution?: number; readonly tempos?: readonly { tick: number; microsecondsPerBeat: number }[] } = {},
): Uint8Array {
	const { resolution = 480, tempos = [{ tick: 0, microsecondsPerBeat: 500000 }] } = options
	const conductor = tempos.map(({ tick, microsecondsPerBeat }) => ({ tick, event: { type: 'setTempo', microsecondsPerBeat } as Omit<MidiEvent, 'deltaTime'> }))
	const built = [trackEvents(conductor), ...tracks.map(({ name, events }) => trackEvents([{ tick: 0, event: { type: 'trackName', text: name } as Omit<MidiEvent, 'deltaTime'> }, ...events]))]
	return new Uint8Array(writeMidi({ header: { format: 1, numTracks: built.length, ticksPerBeat: resolution }, tracks: built }))
}

function trackEvents(events: readonly TimedMidiEvent[]): MidiEvent[] {
	const ordered = events.map((entry, order) => ({ ...entry, order })).sort((a, b) => a.tick - b.tick || a.order - b.order)
	let previousTick = 0
	const result: MidiEvent[] = []
	for (const { tick, event } of ordered) {
		result.push({ ...event, deltaTime: tick - previousTick } as MidiEvent)
		previousTick = tick
	}
	result.push({ deltaTime: 0, type: 'endOfTrack' } as MidiEvent)
	return result
}

/** A parsed track's text events (`FF 01`) and lyric events (`FF 05`), each as its absolute tick, type and text. */
export function trackTextAndLyricEvents(track: readonly MidiEvent[]): [tick: number, type: 'text' | 'lyrics', text: string][] {
	let tick = 0
	return track.flatMap(event => {
		tick += event.deltaTime
		return event.type === 'text' || event.type === 'lyrics' ? [[tick, event.type, event.text] as [number, 'text' | 'lyrics', string]] : []
	})
}

/** A parsed track's text events (`FF 01`), each as its absolute tick and text. */
export function trackTexts(track: readonly MidiEvent[]): [tick: number, text: string][] {
	return trackTextAndLyricEvents(track).flatMap(([tick, type, text]) => type === 'text' ? [[tick, text] as [number, string]] : [])
}

/** The track's note-ons of `noteNumber`, each with its tick and velocity, in track order. */
export function trackNoteOns(track: readonly MidiEvent[], noteNumber: number): [tick: number, velocity: number][] {
	let tick = 0
	return track.flatMap(event => {
		tick += event.deltaTime
		return event.type === 'noteOn' && event.noteNumber === noteNumber ? [[tick, event.velocity] as [number, number]] : []
	})
}

/** A note-on at `tick`, of velocity 100 unless given, and its note-off `length` ticks later; at length 0, the note-on comes first. */
export function midiNote(tick: number, noteNumber: number, length = 0, { channel = 0, velocity = 100 } = {}): TimedMidiEvent[] {
	return [
		{ tick, event: { type: 'noteOn', channel, noteNumber, velocity } as Omit<MidiEvent, 'deltaTime'> },
		{ tick: tick + length, event: { type: 'noteOff', channel, noteNumber, velocity: 0 } as Omit<MidiEvent, 'deltaTime'> },
	]
}

/** A text event (`FF 01`), or a lyric event (`FF 05`). */
export function midiText(tick: number, text: string, type: 'text' | 'lyrics' = 'text'): TimedMidiEvent {
	return { tick, event: { type, text } as Omit<MidiEvent, 'deltaTime'> }
}

/** An end of track at `tick`, before the one each track ends with. */
export function midiEndOfTrack(tick: number): TimedMidiEvent {
	return { tick, event: { type: 'endOfTrack' } as Omit<MidiEvent, 'deltaTime'> }
}

/** A Phase Shift SysEx event: `50 53 00 00 <difficulty> <phrase> <1 to start, 0 to end> F7`. */
export function phaseShiftSysEx(tick: number, difficulty: number, phrase: number, isStart: boolean): TimedMidiEvent {
	return { tick, event: { type: 'sysEx', data: new Uint8Array([0x50, 0x53, 0, 0, difficulty, phrase, isStart ? 1 : 0, 0xf7]) } as Omit<MidiEvent, 'deltaTime'> }
}
