import { MidiData, writeMidi } from '@geomitron/midi-file'

import type { SongDocument } from 'src/song-document'

const encode = (text: string) => new TextEncoder().encode(text)

/** An Expert guitar `.chart` section holding `lines`. */
export const expertSection = (...lines: string[]) => ['[ExpertSingle]', '{', ...lines.map(line => `  ${line}`), '}']

/**
 * A `.chart` file at 192 ticks per beat and 120 BPM, with the sections given, or an Expert guitar track of two notes,
 * and the `[Events]` lines given.
 */
export const chartFile = (sections: readonly string[] = expertSection('768 = N 0 0', '960 = N 1 0'), events: readonly string[] = []) => encode([
	'[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', ...events.map(line => `  ${line}`), '}', ...sections,
].join('\r\n') + '\r\n')

/** A `.chart` file whose only track is Expert guitar, holding `lines`. */
export const expertChart = (...lines: string[]) => chartFile(expertSection(...lines))

/** The text of a song's `.chart` file. */
export const chartText = (song: SongDocument) => song.chart?.format === 'chart' ? new TextDecoder().decode(song.chart.tokens.bytes) : null

type MidiTrack = MidiData['tracks'][number]

/** A `.mid` file at 480 ticks per beat and 120 BPM, with a track for each name holding its notes, 10 ticks long by default. */
export function midi(tracks: Record<string, readonly { tick: number; noteNumber: number; length?: number }[]>): Uint8Array {
	const midiTracks = Object.entries(tracks).map(([name, notes]): MidiTrack => {
		const timed = notes.flatMap(note => [
			{ tick: note.tick, order: 1, event: { type: 'noteOn', channel: 0, noteNumber: note.noteNumber, velocity: 100 } as const },
			{ tick: note.tick + (note.length ?? 10), order: 0, event: { type: 'noteOff', channel: 0, noteNumber: note.noteNumber, velocity: 0 } as const },
		]).sort((left, right) => left.tick - right.tick || left.order - right.order)
		const events: MidiTrack = [{ deltaTime: 0, type: 'trackName', text: name }]
		let previous = 0
		for (const { tick, event } of timed) {
			events.push({ ...event, deltaTime: tick - previous })
			previous = tick
		}
		return [...events, { deltaTime: 0, type: 'endOfTrack' }]
	})
	const conductor: MidiTrack = [{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }]
	return new Uint8Array(writeMidi({ header: { format: 1, numTracks: midiTracks.length + 1, ticksPerBeat: 480 }, tracks: [conductor, ...midiTracks] }))
}
