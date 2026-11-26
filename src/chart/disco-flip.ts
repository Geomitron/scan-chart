import { type Difficulty, difficulties } from '../types'
import { type ChartLineToken, discoFlipDifficultyMap, parseTrackLine } from './chart-file-parser'
import { midiInstrumentTracks, type MidiTrackFinding } from './midi-file-parser'
import { drumsDiffStarts } from './midi-note-numbers'
import type { MidiTokens } from './midi-tokens'
import { isMixEventSpelledAnotherWay, readMixEvent } from './mix-event'
import { mixEventReadingRules } from './parse-rules'
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
const flagRank: { readonly [flag in DrumMixEvent['flag']]: number } = { '': 0, easy: 0, easynokick: 0, d: 1, dnoflip: 2 }

/** A mix event's text, as the writers write it in either format: `mix <difficulty> drums<configuration><flag>`, without brackets. */
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

/**
 * `noflipsDuringFlips` for each difficulty of the drums track a `.mid` file is read with, or `null` when it has none.
 * Only text events (`FF 01`) are read, not lyric events (`FF 05`): see `midiTrackMisspelledMixes`.
 */
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
			const mix = readMixEvent(event.text, 'cloneHero')
			if (mix !== null) events.get(mix.difficulty)!.push({ tick, configuration: mix.configuration, flag: mix.flag })
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

/** Whether the `.mid` export writes the `.chart` text event `text` with `chartMixTextEvents`, not as another text event. */
export function isChartMixText(text: string): boolean {
	return chartMixText(text) !== null
}

/** How the `.mid` export takes a `.chart` drums section's text: `read` for one a drums track would read as a mix event. */
function chartMixText(text: string): 'kept' | 'read' | null {
	if (readMixEvent(text, 'cloneHero') !== null) return 'read'
	const flag = readMixEvent(text, 'strict')?.flag
	return flag === 'easy' || flag === 'easynokick' ? 'kept' : null
}

/**
 * The mix events a `.chart` file's drums sections keep as text, which set no flip there, as the `.mid` export writes
 * them in the one drums track: `kept`, the ones with the flag `easy` or `easynokick` that only scan-chart 8 reads, such
 * as ` mix 3 drums0easy`, once for each tick and text, as written; and `leftOut`, the number of other difficulties' mix
 * events, which the `.chart` reader ignores and the drums track would read.
 */
export function chartMixTextEvents(tracks: readonly { readonly textEvents: readonly { tick: number; text: string }[] }[]): {
	kept: { tick: number; text: string }[]
	leftOut: number
} {
	const kept = new Map<string, { tick: number; text: string }>()
	let leftOut = 0
	for (const { textEvents } of tracks) {
		for (const event of textEvents) {
			const kind = chartMixText(event.text)
			if (kind === 'kept') kept.set(`${event.tick} ${event.text}`, event)
			else if (kind === 'read') leftOut++
		}
	}
	return { kept: [...kept.values()], leftOut }
}

/**
 * A mix event Clone Hero reads otherwise than scan-chart 8 did (C20: R2, R10), at `tick`, written as `text`. `standard`
 * writes what Clone Hero reads in the standard spelling, or, when Clone Hero reads nothing (`isRead` is `false`), what
 * scan-chart 8 read.
 */
export interface MisspelledMixEvent {
	readonly difficulty: Difficulty
	readonly tick: number
	readonly text: string
	readonly standard: string
	readonly isRead: boolean
}

/** The misspelled mix events among the lines of a `.chart` drums section of `difficulty`, with each line. */
export function chartSectionMisspelledMixes(lines: readonly ChartLineToken[], difficulty: Difficulty): (MisspelledMixEvent & { readonly line: ChartLineToken })[] {
	const found: (MisspelledMixEvent & { line: ChartLineToken })[] = []
	for (const line of lines) {
		if (!line.text.includes('mix')) continue
		const read = parseTrackLine(line.text, 'drums', difficulty, mixEventReadingRules.cloneHero)
		const strict = parseTrackLine(line.text, 'drums', difficulty, mixEventReadingRules.strict)
		const [mix, legacy] = [read?.kind === 'note' ? read.drumMix : undefined, strict?.kind === 'note' ? strict.drumMix : undefined]
		// scan-chart 8 kept an `easy` or `easynokick` event as text, and reads it as Clone Hero does.
		const isKeptEasyMix = mix !== undefined && strict?.kind === 'text' && !isMixEventSpelledAnotherWay(strict.text)
		if (isKeptEasyMix || (mix?.flag === legacy?.flag && mix?.configuration === legacy?.configuration)) continue
		const meant = (mix ?? legacy)!
		const text = read?.kind === 'text' ? read.text : strict?.kind === 'text' ? strict.text : line.text
		found.push({ difficulty, tick: meant.tick, text, standard: drumMixText(difficulty, meant), isRead: mix !== undefined, line })
	}
	return found
}

/**
 * The misspelled mix events of the drums track a `.mid` file is read with, its first, each with its index among the
 * chunk's events, or `null` when it has no drums track. Only text events (`FF 01`) are mix events here, not lyric events
 * (`FF 05`): the check's message says how Clone Hero 1.1 reads each event, and Clone Hero 1.1 ignores lyric events.
 */
export function midiTrackMisspelledMixes(tokens: MidiTokens): MidiTrackFinding<MisspelledMixEvent> | null {
	const track = midiInstrumentTracks(tokens).find(candidate => candidate.instrument === 'drums')
	const chunk = track === undefined ? undefined : tokens.chunks[track.chunkIndex]
	if (track === undefined || chunk?.kind !== 'track') return null
	const events: MidiTrackFinding<MisspelledMixEvent>['events'] = []
	chunk.events.forEach(({ tick, event }, eventIndex) => {
		if (event.type !== 'text' || !event.text.includes('mix') || !isMixEventSpelledAnotherWay(event.text)) return
		const mix = readMixEvent(event.text, 'cloneHero') ?? readMixEvent(event.text, 'strict')!
		events.push({ difficulty: mix.difficulty, tick, text: event.text, standard: drumMixText(mix.difficulty, mix), isRead: readMixEvent(event.text, 'cloneHero') !== null, eventIndex })
	})
	return { ...track, events }
}
