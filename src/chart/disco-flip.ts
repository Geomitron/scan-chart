import { type Difficulty, difficulties } from '../types'
import { discoFlipDifficultyMap, parseTrackLine } from './chart-file-parser'
import { midiDiscoFlipRegex, midiInstrumentTracks } from './midi-file-parser'
import { drumsDiffStarts } from './midi-note-numbers'
import type { MidiTokens } from './midi-tokens'
import { type DrumMixEvent, eventTypes } from './raw-types'

/**
 * A `dnoflip` mix event that comes while a `d` flip of its difficulty is on, and where an event turning the flip off
 * goes before it.
 */
export interface NoflipDuringFlip {
	readonly noflipTick: number
	/** The tick before the `dnoflip`, or `null` when a red or yellow note or the event before it is there. */
	readonly offTick: number | null
	/** The drum stem configuration of the event before the `dnoflip`, which the off event keeps. */
	readonly configuration: number
}

/** The `dnoflip` events during a flip of each difficulty of the drums track a `.mid` file is read with, its first. */
export interface MidiDrumsNoflips {
	readonly name: string
	readonly chunkIndex: number
	readonly difficulties: ReadonlyMap<Difficulty, readonly NoflipDuringFlip[]>
}

/** How readers rank one difficulty's mix events at one tick: an event turning the flip off, then `d`, then `dnoflip`. */
const flagRank: { readonly [flag in DrumMixEvent['flag']]: number } = { '': 0, d: 1, dnoflip: 2 }

/** A mix event's text, as the writers write it: `mix <difficulty> drums<configuration><flag>`. `.mid` puts it in brackets. */
export function drumMixText(difficulty: Difficulty, { configuration, flag }: Pick<DrumMixEvent, 'configuration' | 'flag'>): string {
	return `mix ${discoFlipDifficultyMap.indexOf(difficulty)} drums${configuration}${flag}`
}

/**
 * Each `dnoflip` mix event that comes while a `d` flip of its difficulty is on, which Clone Hero 1.1 reads as the flip
 * staying on, and other readers as no-flip (review Q8 A). An event turning the flip off goes on the tick before it, when
 * that's after the mix event and the red or yellow note before it, so every note reads as before.
 *
 * `events` are one difficulty's mix events, and `flippedNoteTicks` the ticks of its red and yellow notes, which a flip
 * changes, in any order.
 */
export function noflipsDuringFlips(events: readonly DrumMixEvent[], flippedNoteTicks: readonly number[]): NoflipDuringFlip[] {
	const byTick = new Map<number, DrumMixEvent>()
	for (const event of events) {
		const atTick = byTick.get(event.tick)
		if (atTick === undefined || flagRank[event.flag] < flagRank[atTick.flag]) byTick.set(event.tick, event)
	}
	const noteTicks = [...flippedNoteTicks].sort((a, b) => a - b)
	const found: NoflipDuringFlip[] = []
	let previous: DrumMixEvent | null = null
	let noteIndex = 0
	let lastNoteTick = -1
	for (const event of [...byTick.values()].sort((a, b) => a.tick - b.tick)) {
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

/** `noflipsDuringFlips` for the lines of a `.chart` drums section of `difficulty`, as `chartSectionLines` gives them. */
export function chartSectionNoflips(lines: readonly string[], difficulty: Difficulty): NoflipDuringFlip[] {
	const events: DrumMixEvent[] = []
	const flippedTicks: number[] = []
	for (const line of lines) {
		const parsed = parseTrackLine(line, 'drums', difficulty)
		if (parsed?.kind !== 'note') continue
		if (parsed.drumMix !== undefined) events.push(parsed.drumMix)
		else if (parsed.type === eventTypes.redDrum || parsed.type === eventTypes.yellowDrum) flippedTicks.push(parsed.tick)
	}
	return noflipsDuringFlips(events, flippedTicks)
}

/** `noflipsDuringFlips` for each difficulty of the drums track a `.mid` file is read with, or `null` when it has none. */
export function midiTrackNoflips(tokens: MidiTokens): MidiDrumsNoflips | null {
	const track = midiInstrumentTracks(tokens).find(candidate => candidate.instrument === 'drums')
	const chunk = track === undefined ? undefined : tokens.chunks[track.chunkIndex]
	if (track === undefined || chunk?.kind !== 'track') return null
	const { name, chunkIndex } = track
	// Most drums tracks have no dnoflip event, and so nothing to find.
	if (!chunk.events.some(({ event }) => event.type === 'text' && event.text.includes('dnoflip'))) return { name, chunkIndex, difficulties: new Map() }
	const events = new Map<Difficulty, DrumMixEvent[]>(difficulties.map(difficulty => [difficulty, []]))
	const flippedTicks = new Map<Difficulty, number[]>(difficulties.map(difficulty => [difficulty, []]))
	for (const { tick, event } of chunk.events) {
		if (event.type === 'text') {
			const match = midiDiscoFlipRegex.exec(event.text)
			const flag = match?.[3]
			if (match !== null && (flag === '' || flag === 'd' || flag === 'dnoflip')) {
				events.get(discoFlipDifficultyMap[Number(match[1])])!.push({ tick, configuration: Number(match[2]), flag })
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
