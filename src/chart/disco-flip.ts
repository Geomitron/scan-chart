import { type Difficulty, difficulties } from '../types'
import { parseTrackLine } from './chart-file-parser'
import { midiDiscoFlipRegex, midiSourceTrackInstrument } from './midi-file-parser'
import { drumsDiffStarts } from './midi-note-numbers'
import type { MidiEventToken, MidiTokens } from './midi-tokens'
import { type DrumMixEvent, eventTypes } from './raw-types'

type NoflipDuringFlip = ReturnType<typeof noflipsDuringFlips>[number]

/** The difficulties in the order a mix event numbers them, from 0. */
export const mixDifficulties = ['easy', 'medium', 'hard', 'expert'] as const

/** How readers rank one difficulty's mix events at one tick: an event turning the flip off, then `d`, then `dnoflip`. */
const flagRank: { readonly [flag in DrumMixEvent['flag']]: number } = { '': 0, d: 1, dnoflip: 2 }

/**
 * Each `dnoflip` mix event that comes while a `d` flip of its difficulty is on, which Clone Hero 1.1 reads as the flip
 * staying on, and other readers as no-flip (review Q8 A), and where an event turning the flip off goes before it: the
 * tick before the `dnoflip`, when that's after the mix event and the red or yellow note before it, so every note reads
 * as before. `offTick` is `null` when there's no such tick. `configuration` is the drum stem configuration of the event
 * before it, which the off event keeps.
 *
 * `events` are one difficulty's mix events, and `flippedNoteTicks` the ticks of its red and yellow notes, which a flip
 * changes, in any order.
 */
export function noflipsDuringFlips(
	events: readonly DrumMixEvent[],
	flippedNoteTicks: readonly number[],
): { readonly noflipTick: number; readonly offTick: number | null; readonly configuration: number }[] {
	const read = new Map<number, DrumMixEvent>()
	for (const event of events) {
		const atTick = read.get(event.tick)
		if (atTick === undefined || flagRank[event.flag] < flagRank[atTick.flag]) read.set(event.tick, event)
	}
	const noteTicks = [...flippedNoteTicks].sort((a, b) => a - b)
	const found: { noflipTick: number; offTick: number | null; configuration: number }[] = []
	let previous: DrumMixEvent | null = null
	let noteIndex = 0
	let lastNoteTick = -1
	for (const event of [...read.values()].sort((a, b) => a.tick - b.tick)) {
		while (noteIndex < noteTicks.length && noteTicks[noteIndex] < event.tick) lastNoteTick = noteTicks[noteIndex++]
		if (event.flag === 'dnoflip' && previous?.flag === 'd') {
			const offTick = event.tick - 1
			const isFree = offTick > previous.tick && offTick > lastNoteTick
			found.push({ noflipTick: event.tick, offTick: isFree ? offTick : null, configuration: previous.configuration })
		}
		previous = event
	}
	return found
}

/** `noflipsDuringFlips` for the lines of a `.chart` drums section of `difficulty`, each read as scan-chart reads it. */
export function chartSectionNoflips(lines: readonly string[], difficulty: Difficulty): NoflipDuringFlip[] {
	const events: DrumMixEvent[] = []
	const flippedTicks: number[] = []
	for (const line of lines) {
		const read = parseTrackLine(line.replace(/^[ \t\r]+|[ \t\r]+$/g, ''), 'drums', difficulty)
		if (read?.kind !== 'note') continue
		if (read.drumMix !== undefined) events.push(read.drumMix)
		else if (read.type === eventTypes.redDrum || read.type === eventTypes.yellowDrum) flippedTicks.push(read.tick)
	}
	return noflipsDuringFlips(events, flippedTicks)
}

/**
 * `noflipsDuringFlips` for each difficulty of the drums track a `.mid` file is read with, its first, with the track's
 * name and chunk; `null` when it has none.
 */
export function midiTrackNoflips(tokens: MidiTokens): {
	readonly name: string
	readonly chunkIndex: number
	readonly difficulties: ReadonlyMap<Difficulty, NoflipDuringFlip[]>
} | null {
	// The first track is the conductor track.
	const chunkIndex = tokens.chunks.findIndex((chunk, index) => index > 0 && chunk.kind === 'track' && isDrumsTrack(chunk.events))
	const chunk = tokens.chunks[chunkIndex]
	if (chunk?.kind !== 'track') return null
	const name = trackName(chunk.events)!
	// Most drums tracks have no dnoflip event, and so nothing to find.
	if (!chunk.events.some(({ event }) => event.type === 'text' && event.text.includes('dnoflip'))) return { name, chunkIndex, difficulties: new Map() }
	const events = new Map<Difficulty, DrumMixEvent[]>(difficulties.map(difficulty => [difficulty, []]))
	const flippedTicks = new Map<Difficulty, number[]>(difficulties.map(difficulty => [difficulty, []]))
	for (const { tick, event } of chunk.events) {
		if (event.type === 'text') {
			const match = midiDiscoFlipRegex.exec(event.text)
			const flag = match?.[3]
			if (match !== null && (flag === '' || flag === 'd' || flag === 'dnoflip')) {
				events.get(mixDifficulties[Number(match[1])])!.push({ tick, configuration: Number(match[2]), flag })
			}
		} else if (event.type === 'noteOn' && event.velocity > 0) {
			// Red and yellow are the two notes after each difficulty's kick.
			const difficulty = difficulties.find(candidate => [1, 2].includes(event.noteNumber - drumsDiffStarts[candidate]))
			if (difficulty !== undefined) flippedTicks.get(difficulty)!.push(tick)
		}
	}
	return {
		name,
		chunkIndex,
		difficulties: new Map(difficulties.map(difficulty =>
			[difficulty, noflipsDuringFlips(events.get(difficulty)!, flippedTicks.get(difficulty)!)] as const)),
	}
}

/** A track's name: its last name at tick 0, or `null`. */
function trackName(events: readonly MidiEventToken[]): string | null {
	let name: string | null = null
	for (const { tick, event } of events) {
		if (tick !== 0) break
		if (event.type === 'trackName') name = event.text
	}
	return name
}

function isDrumsTrack(events: readonly MidiEventToken[]): boolean {
	const name = trackName(events)
	return name !== null && midiSourceTrackInstrument(name) === 'drums'
}
