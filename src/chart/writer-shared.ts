/**
 * Helpers shared between the `.chart` writer (`chart-writer.ts`) and the
 * `.mid` writer (`midi-writer/`). Both formats surface the same global-event
 * concepts (coda markers, bracket-wrapped text events) and previously
 * re-implemented them independently.
 */

import type { ParsedChart } from './parse-chart-and-ini'

/**
 * Ticks where a drum freestyle (BRE) section is flagged as a coda, deduped.
 * Both writers derive coda events from the per-track freestyle sections; this
 * is the single source of truth for that derivation.
 */
export function codaTicksFromFreestyle(trackData: ParsedChart['trackData']): Set<number> {
	const ticks = new Set<number>()
	for (const track of trackData) {
		for (const fs of track.drumFreestyleSections) {
			if (fs.isCoda) ticks.add(fs.tick)
		}
	}
	return ticks
}

/** True if `text` (ignoring trailing whitespace) is wrapped in `[...]`. */
export function isBracketed(text: string): boolean {
	const trimmed = text.trimEnd()
	return trimmed.startsWith('[') && trimmed.endsWith(']')
}

/**
 * Wrap a global text event in `[...]` unless it already is — the `.mid`/RBN
 * convention. A `.chart`-sourced event (`crowd_noclap`) becomes `[crowd_noclap]`.
 */
export function wrapEventBrackets(text: string): string {
	return isBracketed(text) ? text : `[${text}]`
}

/**
 * Strip one outer pair of brackets from a global text event — the `.chart`
 * convention (E-event payloads are stored unwrapped). A `.mid`-sourced
 * `[crowd_noclap]` becomes `crowd_noclap`.
 */
export function unwrapEventBrackets(text: string): string {
	const trimmed = text.trimEnd()
	return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : text
}
