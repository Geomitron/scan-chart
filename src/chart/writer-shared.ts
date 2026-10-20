/**
 * Helpers shared between the `.chart` writer (`chart-writer.ts`) and the
 * `.mid` writer (`midi-writer/`), for the global-event concepts both formats
 * hold: coda markers and bracket-wrapped text events.
 */

import { noflipsDuringFlips } from './disco-flip'
import type { ParsedChart } from './parse-chart-and-ini'
import type { DrumMixEvent } from './raw-types'
import { noteFlags, noteTypes } from './types'

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

/**
 * The first of `forms` that holds no song-wide event, as `read` reads it, or `null` when each one holds one. A writer
 * offers the conventional form first, so text it converts can't become an event the source didn't have.
 */
export function firstFormHoldingNoEvent(forms: readonly string[], read: (text: string) => object | null): string | null {
	return forms.find(form => read(form) === null) ?? null
}

/**
 * The disco flip mix events (`mix <difficulty> drums<configuration><flag>`) both writers write for a drum track: each
 * one it was read with, at its tick, with its configuration and flag, and one at each tick whose red and yellow notes
 * need another flip than the last event gives, which replaces an event read at that tick. A `dnoflip` that comes while
 * a `d` flip is on gets an event turning the flip off before it, where a tick is free (`noflipsDuringFlips`). An added
 * event has the drum stem configuration of the last event before it, or else of the first one read, or 0.
 */
export function drumMixEvents(td: ParsedChart['trackData'][number]): DrumMixEvent[] {
	const read = td.drumMixes ?? []
	const written: DrumMixEvent[] = []
	let readIndex = 0
	let configuration = read[0]?.configuration ?? 0
	let flag: DrumMixEvent['flag'] = ''
	const write = (event: DrumMixEvent) => {
		configuration = event.configuration
		flag = event.flag
		if (written[written.length - 1]?.tick === event.tick) written[written.length - 1] = event
		else written.push(event)
	}
	for (const group of td.noteEventGroups) {
		// The flip of the group's red and yellow notes. A group without them reads no flip, and keeps the last one.
		let groupFlag: DrumMixEvent['flag'] | null = null
		for (const note of group) {
			if (note.type !== noteTypes.redDrum && note.type !== noteTypes.yellowDrum) continue
			groupFlag = note.flags & noteFlags.discoNoflip ? 'dnoflip' : note.flags & noteFlags.disco ? 'd' : ''
			if (groupFlag !== '') break
		}
		if (groupFlag === null) continue
		const tick = group[0].tick
		while (readIndex < read.length && read[readIndex].tick <= tick) write(read[readIndex++])
		if (groupFlag !== flag) write({ tick, configuration, flag: groupFlag })
	}
	while (readIndex < read.length) write(read[readIndex++])
	// A dnoflip while a d flip is on is invalid: the flip is turned off first.
	const flippedTicks = td.noteEventGroups.filter(group => group.some(note => note.type === noteTypes.redDrum || note.type === noteTypes.yellowDrum))
		.map(group => group[0].tick)
	for (const { offTick, configuration } of noflipsDuringFlips(written, flippedTicks)) {
		if (offTick !== null) written.splice(written.findIndex(event => event.tick > offTick), 0, { tick: offTick, configuration, flag: '' })
	}
	return written
}
