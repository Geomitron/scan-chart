import { drumMixText, MidiDrumsNoflips, midiTrackNoflips } from './disco-flip'
import { editMidiTrack, MidiTrackEdit, midiTextEvent } from './midi-edit'
import { MidiTokens } from './midi-tokens'

/**
 * A kind of nonstandard `.mid` spelling: several track names at tick 0, of which Clone Hero reads the last, or a
 * `dnoflip` mix event while a `d` disco flip is on, which Clone Hero 1.1 reads as the flip staying on.
 */
export type MidiNormalizationKind = 'trackNames' | 'noflipDuringFlip'

/** One normalization of a `.mid` file. */
export interface MidiNormalization {
	readonly kind: MidiNormalizationKind
	/** The track it rewrites, by the name Clone Hero reads. */
	readonly section: string
	/** Rewrites the file as it is now. Returns `tokens` unchanged when there's nothing left to rewrite. */
	readonly apply: (tokens: MidiTokens) => MidiTokens
}

/**
 * Every normalization a `.mid` file needs. Like `.chart` normalizations, they keep the meaning, and saving decides
 * where each applies (E7). Overlapping notes of one pitch, which readers pair differently, aren't normalized yet.
 */
export function midiNormalizations(tokens: MidiTokens): MidiNormalization[] {
	const normalizations: MidiNormalization[] = []
	tokens.chunks.forEach((chunk, chunkIndex) => {
		const extra = extraTrackNames(tokens, chunkIndex)
		if (extra === null) return
		normalizations.push({
			kind: 'trackNames',
			section: extra.name,
			apply: current => {
				const found = extraTrackNames(current, chunkIndex)
				return found === null ? current : editMidiTrack(current, chunkIndex, found.events.map(event => ({ kind: 'delete', event })))
			},
		})
	})
	const drums = midiTrackNoflips(tokens)
	if (drums !== null && flipOffs(drums).length > 0) {
		normalizations.push({
			kind: 'noflipDuringFlip',
			section: drums.name,
			apply: current => {
				const found = midiTrackNoflips(current)
				const edits = found === null ? [] : flipOffs(found)
				return found === null || edits.length === 0 ? current : editMidiTrack(current, found.chunkIndex, edits)
			},
		})
	}
	return normalizations
}

/**
 * An event turning the flip off before each `dnoflip` mix event that comes while a `d` flip is on, where a tick is free,
 * as the writers write one (`noflipsDuringFlips`).
 */
function flipOffs(drums: MidiDrumsNoflips): MidiTrackEdit[] {
	return [...drums.difficulties].flatMap(([difficulty, found]) => found.flatMap(({ offTick, configuration }) => offTick === null ? []
		: [{ kind: 'insert' as const, tick: offTick, event: midiTextEvent(`[${drumMixText(difficulty, { configuration, flag: '' })}]`) }]))
}

/** The track names at tick 0 before the last one, which names the track, or `null` when there's only one. */
function extraTrackNames(tokens: MidiTokens, chunkIndex: number): { name: string; events: number[] } | null {
	const chunk = tokens.chunks[chunkIndex]
	if (chunk?.kind !== 'track') return null
	const names: number[] = []
	for (const [index, { tick, event }] of chunk.events.entries()) {
		if (tick !== 0) break
		if (event.type === 'trackName') names.push(index)
	}
	if (names.length < 2) return null
	const last = chunk.events[names[names.length - 1]].event
	return { name: last.type === 'trackName' ? last.text : '', events: names.slice(0, -1) }
}
