import { editMidiTrack } from './midi-edit'
import { MidiTokens } from './midi-tokens'

/** A kind of nonstandard `.mid` spelling: several track names at tick 0, of which Clone Hero reads the last. */
export type MidiNormalizationKind = 'trackNames'

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
	return normalizations
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
