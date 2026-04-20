/**
 * Natural-HOPO helpers — shared by the parser, scanner, and writers.
 *
 * All three places need to answer the same structural questions about a fret
 * group (is it a chord? does it equal the previous group? is it a subset of
 * the previous group?) and whether the group is a "natural HOPO" (would
 * resolve to HOPO without any force modifiers):
 *
 *   - Parser (resolveFretModifiers in notes-parser.ts) decides the group's
 *     resolved hopo/strum flag at parse time. Operates on `TrackEvent[]`
 *     (pre-resolution; `.type` is `EventType`).
 *   - Scanner (chart-scanner.ts) re-derives `hasForcedNotes` after the
 *     fact. Operates on `NoteEvent[]` (post-resolution; `.type` is `NoteType`).
 *   - Writers (chart-writer.ts, midi-writer.ts) decide whether to emit a
 *     force-* modifier — only when the resolved flag disagrees with natural.
 *     Operates on `NoteEvent[]`.
 *
 * `NoteType` and `EventType` use different numeric values for the same fret
 * colors, so the helpers are parameterized over a per-enum "is this a fret
 * note?" predicate, with thin wrappers exported for each concrete type.
 */

import type { EventType, NoteEvent, RawChartData } from './note-parsing-interfaces'
import { eventTypes, noteTypes, NoteType } from './note-parsing-interfaces'

type TrackEvent = RawChartData['trackData'][number]['trackEvents'][number]

// ---------------------------------------------------------------------------
// Per-enum "is this a fret note?" predicates.
// ---------------------------------------------------------------------------

const fretNoteTypes = new Set<NoteType>([
	noteTypes.open, noteTypes.green, noteTypes.red, noteTypes.yellow, noteTypes.blue, noteTypes.orange,
	noteTypes.black1, noteTypes.black2, noteTypes.black3,
	noteTypes.white1, noteTypes.white2, noteTypes.white3,
])
const fretEventTypes = new Set<EventType>([
	eventTypes.open, eventTypes.green, eventTypes.red, eventTypes.yellow, eventTypes.blue, eventTypes.orange,
	eventTypes.black1, eventTypes.black2, eventTypes.black3,
	eventTypes.white1, eventTypes.white2, eventTypes.white3,
])

export const isFretNoteType = (t: NoteType): boolean => fretNoteTypes.has(t)
export const isFretEventType = (t: EventType): boolean => fretEventTypes.has(t)

// ---------------------------------------------------------------------------
// Generic fret-group helpers.
//
// Each takes the group plus an `isFret` predicate that matches the group's
// element-type enum. Internal — use the NoteEvent / TrackEvent specializations
// exported below.
// ---------------------------------------------------------------------------

function isFretChordGeneric<T, E extends { type: T }>(
	group: E[],
	isFret: (t: T) => boolean,
): boolean {
	let firstType: T | null = null
	for (const n of group) {
		if (!isFret(n.type)) continue
		if (firstType === null) firstType = n.type
		else if (firstType !== n.type) return true
	}
	return false
}

function isSameFretNoteGeneric<T, E extends { type: T }>(
	a: E[],
	b: E[],
	isFret: (t: T) => boolean,
): boolean {
	const aT: T[] = []
	for (const n of a) if (isFret(n.type)) aT.push(n.type)
	const bT: T[] = []
	for (const n of b) if (isFret(n.type)) bT.push(n.type)
	if (aT.length !== bT.length) return false
	const s = new Set(bT)
	for (const t of aT) if (!s.has(t)) return false
	return true
}

function isInFretNoteGeneric<T, E extends { type: T }>(
	inner: E[],
	outer: E[],
	isFret: (t: T) => boolean,
): boolean {
	const o = new Set<T>()
	for (const n of outer) if (isFret(n.type)) o.add(n.type)
	for (const n of inner) if (isFret(n.type) && !o.has(n.type)) return false
	return true
}

// ---------------------------------------------------------------------------
// NoteEvent specializations — used by the scanner and writers.
// ---------------------------------------------------------------------------

export function isFretChord(group: NoteEvent[]): boolean {
	return isFretChordGeneric(group, isFretNoteType)
}
export function isSameFretNote(a: NoteEvent[], b: NoteEvent[]): boolean {
	return isSameFretNoteGeneric(a, b, isFretNoteType)
}
export function isInFretNote(inner: NoteEvent[], outer: NoteEvent[]): boolean {
	return isInFretNoteGeneric(inner, outer, isFretNoteType)
}

// ---------------------------------------------------------------------------
// TrackEvent specializations — used by the parser's resolveFretModifiers.
// ---------------------------------------------------------------------------

export function isFretChordRawEvents(group: TrackEvent[]): boolean {
	return isFretChordGeneric(group, isFretEventType)
}
export function isSameFretNoteRawEvents(a: TrackEvent[], b: TrackEvent[]): boolean {
	return isSameFretNoteGeneric(a, b, isFretEventType)
}
export function isInFretNoteRawEvents(inner: TrackEvent[], outer: TrackEvent[]): boolean {
	return isInFretNoteGeneric(inner, outer, isFretEventType)
}

// ---------------------------------------------------------------------------
// HOPO threshold + NoteEvent-based natural-HOPO rule.
//
// The parser does its own natural-HOPO check inline (different variable
// shape — effectiveNotes vs events, etc.), and calls the individual
// *RawEvents helpers above. Scanner + writers use the NoteEvent form
// through this wrapper.
// ---------------------------------------------------------------------------

/**
 * Compute the natural-HOPO threshold in ticks. Mirrors the formula the parser
 * uses in `resolveFretModifiers`:
 *
 *   - if `iniHopoFreq` is set (non-zero), it wins outright
 *   - else if `eighthnoteHopo`, use `floor(1 + resolution/2)`
 *   - else, the default differs by format:
 *       - `.mid`  : `floor(1 + resolution/3)`
 *       - `.chart`: `floor((65/192) * resolution)`
 */
export function computeHopoThresholdTicks(
	resolution: number,
	iniHopoFreq: number,
	eighthnoteHopo: boolean,
	format: 'chart' | 'mid',
): number {
	if (iniHopoFreq) return iniHopoFreq
	if (eighthnoteHopo) return Math.floor(1 + resolution / 2)
	return Math.floor(format === 'mid' ? 1 + resolution / 3 : (65 / 192) * resolution)
}

/**
 * True if `current` would resolve to HOPO with no force modifiers. Rules:
 *
 *   1. No previous group → not a natural HOPO.
 *   2. Gap from previous group > threshold → strum.
 *   3. Current is a chord → strum.
 *   4. Previous is a single note and current is the same single note → strum.
 *   5. `.mid` only: previous is a chord and current is a subset of it → strum
 *      (back-compat exception for older games).
 *   6. Otherwise → natural HOPO.
 */
export function isNaturalHopo(
	current: NoteEvent[],
	last: NoteEvent[] | null,
	hopoThresholdTicks: number,
	format: 'chart' | 'mid',
): boolean {
	if (!last) return false
	if (current[0].tick - last[0].tick > hopoThresholdTicks) return false
	if (isFretChord(current)) return false
	if (!isFretChord(last) && isSameFretNote(current, last)) return false
	if (format === 'mid' && isFretChord(last) && isInFretNote(current, last)) return false
	return true
}
