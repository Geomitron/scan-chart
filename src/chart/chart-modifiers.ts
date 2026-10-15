import { ObjectCache } from '../shared/object-cache'
import type { Difficulty, Instrument } from '../types'
import {
	type ChartFileTokens,
	chartSectionTrack,
	forEachChartLine,
	getNEventType,
	isChartLineBlank,
	isStandardNoteLine,
	parseTrackLine,
} from './chart-file-parser'
import { type EventType, eventTypes } from './raw-types'

/** A line of a `.chart` file's text: where it starts, and where it ends, after its line feed. */
export interface ChartLineRange {
	readonly start: number
	readonly end: number
}

/**
 * A section's modifier lines with no note at their tick to apply to: those saving removes, and the cymbal markers it
 * keeps, which may decide the drum type.
 */
export interface ModifiersWithoutNotes {
	readonly removed: readonly ChartLineRange[]
	readonly kept: readonly ChartLineRange[]
}

/** The pad note each drum accent, ghost and cymbal marker applies to. */
const markerPads = new Map<EventType, EventType>([
	[eventTypes.redAccent, eventTypes.redDrum],
	[eventTypes.redGhost, eventTypes.redDrum],
	[eventTypes.yellowAccent, eventTypes.yellowDrum],
	[eventTypes.yellowGhost, eventTypes.yellowDrum],
	[eventTypes.yellowCymbalMarker, eventTypes.yellowDrum],
	[eventTypes.blueAccent, eventTypes.blueDrum],
	[eventTypes.blueGhost, eventTypes.blueDrum],
	[eventTypes.blueCymbalMarker, eventTypes.blueDrum],
	[eventTypes.fiveOrangeFourGreenAccent, eventTypes.fiveOrangeFourGreenDrum],
	[eventTypes.fiveOrangeFourGreenGhost, eventTypes.fiveOrangeFourGreenDrum],
	[eventTypes.greenCymbalMarker, eventTypes.fiveOrangeFourGreenDrum],
	[eventTypes.fiveGreenAccent, eventTypes.fiveGreenDrum],
	[eventTypes.fiveGreenGhost, eventTypes.fiveGreenDrum],
])
/** The modifiers that apply to every note at their tick: forced and tap on frets, and flam on drums. */
const tickModifiers = new Set<EventType>([eventTypes.forceUnnatural, eventTypes.forceTap, eventTypes.forceFlam])
const cymbalMarkers = new Set<EventType>([eventTypes.yellowCymbalMarker, eventTypes.blueCymbalMarker, eventTypes.greenCymbalMarker])

const noteBits = new Map<EventType, number>()

/** A note type's bit among a tick's notes, given in the order types are first met: there are fewer than 31. */
function noteBit(type: EventType): number {
	let bit = noteBits.get(type)
	if (bit === undefined) noteBits.set(type, bit = 1 << noteBits.size)
	return bit
}

/** What an `N` line is: a note, with its bit, or a modifier, with the bits of the notes it applies to. */
type NLine = { readonly type: EventType; readonly note: number } | { readonly type: EventType; readonly appliesTo: number; readonly cymbal: boolean }

/** What each `N` value up to 255 is on an instrument, as the parser reads it, and each of its `N` lines by event type. */
const nLineTables = new Map<Instrument, { readonly byValue: readonly (NLine | null)[]; readonly byType: ReadonlyMap<EventType, NLine> }>()

function nLines(instrument: Instrument) {
	let table = nLineTables.get(instrument)
	if (table === undefined) {
		const byValue = Array.from({ length: 256 }, (_, value): NLine | null => {
			const type = getNEventType(String(value), instrument)
			const pad = type === null ? undefined : markerPads.get(type)
			return type === null ? null
				: tickModifiers.has(type) ? { type, appliesTo: ~0, cymbal: false }
				: pad !== undefined ? { type, appliesTo: noteBit(pad), cymbal: cymbalMarkers.has(type) }
				: { type, note: noteBit(type) }
		})
		const byType = new Map(byValue.filter(nLine => nLine !== null).map(nLine => [nLine.type, nLine]))
		nLineTables.set(instrument, table = { byValue, byType })
	}
	return table
}

/** One instrument section's modifiers, as `scanSection` finds them. */
interface SectionModifiers {
	/** Whether it has a note: a section without one isn't a track. */
	readonly hasNotes: boolean
	/** The lines of its modifiers with no note at their tick to apply to: the cymbal markers', and the others'. */
	readonly cymbalLines: ChartLineRange[]
	readonly otherLines: ChartLineRange[]
	/** On drums, whether it has an `N 5`, and a cymbal marker on a tick with its note. */
	readonly hasFiveLaneGreen: boolean
	readonly hasCymbalWithNote: boolean
}

const isDigit = (code: number) => code >= 48 && code <= 57

/**
 * The modifiers of the section text from `start` to `end`, each line read as the parser reads it: a standard `N` line a
 * character at a time, and any other through `parseTrackLine`. `null` for a section whose lines aren't in tick order,
 * which is left as it is.
 */
function scanSection(text: string, start: number, end: number, instrument: Instrument, difficulty: Difficulty): SectionModifiers | null {
	const { byValue, byType } = nLines(instrument)
	const cymbalLines: ChartLineRange[] = []
	const otherLines: ChartLineRange[] = []
	let hasNotes = false
	let hasFiveLaneGreen = false
	let hasCymbalWithNote = false
	let unsorted = false
	// The tick being read: its notes' bits, and its modifiers.
	let tick = -1
	let notes = 0
	const pending: { line: ChartLineRange; appliesTo: number; cymbal: boolean }[] = []
	const endTick = () => {
		for (const { line, appliesTo, cymbal } of pending) {
			const applies = (notes & appliesTo) !== 0
			if (!applies) (cymbal ? cymbalLines : otherLines).push(line)
			else if (cymbal) hasCymbalWithNote = true
		}
		pending.length = 0
		notes = 0
	}
	forEachChartLine(text, start, end, (lineStart, textStart, lineEnd) => {
		// Text before the section's `}` on its line is read as no line.
		if (lineEnd === end) return
		let index = textStart
		let lineTick = 0
		while (index < lineEnd && isDigit(text.charCodeAt(index))) lineTick = lineTick * 10 + text.charCodeAt(index++) - 48
		if (index === textStart || text.startsWith(' = E ', index)) return
		let nLine: NLine | null | undefined
		if (isStandardNoteLine(text, index, lineEnd)) {
			// An S line is a phrase.
			if (text.charCodeAt(index + 3) !== 78) return
			let value = 0
			for (let at = index + 5; isDigit(text.charCodeAt(at)) && value < 256; at++) value = value * 10 + text.charCodeAt(at) - 48
			nLine = value < 256 ? byValue[value] : null
		} else {
			let textEnd = lineEnd
			while (textEnd > textStart && isChartLineBlank(text.charCodeAt(textEnd - 1))) textEnd--
			const parsed = parseTrackLine(text.slice(textStart, textEnd), instrument, difficulty)
			if (parsed?.kind !== 'note') return
			lineTick = parsed.tick
			nLine = byType.get(parsed.type)
		}
		if (nLine === null || nLine === undefined) return
		if (lineTick < tick) {
			unsorted = true
			return false
		}
		if (lineTick !== tick) {
			endTick()
			tick = lineTick
		}
		if ('note' in nLine) {
			notes |= nLine.note
			hasNotes = true
			if (nLine.type === eventTypes.fiveGreenDrum) hasFiveLaneGreen = true
		} else {
			pending.push({ line: { start: lineStart, end: lineEnd + 1 }, appliesTo: nLine.appliesTo, cymbal: nLine.cymbal })
		}
	})
	if (unsorted) return null
	endTick()
	return { hasNotes, cymbalLines, otherLines, hasFiveLaneGreen, hasCymbalWithNote }
}

const fileModifiers = new ObjectCache<ChartFileTokens, ReadonlyMap<string, ModifiersWithoutNotes>>('chartModifiersWithoutNotes')

/**
 * The lines of each instrument section a reader reads, by name, that hold a modifier with no note to apply to: a forced,
 * tap or flam modifier on a tick with no note, and an accent, ghost or cymbal marker on a tick without its pad's note.
 * A section with no notes, which isn't a track, has none.
 *
 * Every reader ignores such a modifier, but for a cymbal marker, which still decides the drum type: Clone Hero and
 * scan-chart read a chart with any cymbal marker as pro, and YARG one whose first cymbal marker or `N 5` is a cymbal
 * marker. So saving keeps a cymbal marker without its note unless another cymbal marker has its note, no drums section
 * has an `N 5`, and every drums section's lines are in tick order.
 */
export function chartModifiersWithoutNotes(tokens: ChartFileTokens): ReadonlyMap<string, ModifiersWithoutNotes> {
	let byName = fileModifiers.get(tokens)
	if (byName !== undefined) return byName
	const sections = new Map<string, { instrument: Instrument; modifiers: SectionModifiers | null }>()
	for (const section of tokens.sections) {
		const track = chartSectionTrack(section.name)
		if (track === null || sections.has(section.name)) continue
		const modifiers = scanSection(tokens.text, section.bodyStart, section.bodyEnd, track.instrument, track.difficulty)
		sections.set(section.name, { instrument: track.instrument, modifiers })
	}
	const drums = [...sections.values()].filter(section => section.instrument === 'drums').map(section => section.modifiers)
	const keepCymbalMarkers = drums.some(modifiers => modifiers === null || modifiers.hasFiveLaneGreen) || !drums.some(modifiers => modifiers?.hasCymbalWithNote)
	const found = new Map<string, ModifiersWithoutNotes>()
	for (const [name, { modifiers }] of sections) {
		if (modifiers === null || !modifiers.hasNotes) continue
		const removed = [...modifiers.otherLines, ...keepCymbalMarkers ? [] : modifiers.cymbalLines].sort((a, b) => a.start - b.start)
		const kept = keepCymbalMarkers ? modifiers.cymbalLines : []
		if (removed.length + kept.length > 0) found.set(name, { removed, kept })
	}
	fileModifiers.set(tokens, byName = found)
	return byName
}
