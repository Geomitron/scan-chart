import { ObjectCache } from '../shared/object-cache'
import type { Instrument } from '../types'
import { type ChartFileTokens, chartSectionTrack, getNEventType } from './chart-file-parser'
import { type EventType, eventTypes } from './raw-types'

/** A line of a `.chart` file's text: where it starts, and where it ends, after its line feed. */
export interface ChartLineRange {
	readonly start: number
	readonly end: number
}

/** The `N` value of each drum pad note. */
const padValues = new Map<EventType, number>([
	[eventTypes.redDrum, 1],
	[eventTypes.yellowDrum, 2],
	[eventTypes.blueDrum, 3],
	[eventTypes.fiveOrangeFourGreenDrum, 4],
	[eventTypes.fiveGreenDrum, 5],
])
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

/** A note value's bit among a tick's notes: notes are `N 0` to `N 8`, and a double kick is `N 32`. */
const noteBit = (value: number) => 1 << (value === 32 ? 30 : value)

/** What an `N` value is on an instrument: a note, with its bit, or a modifier, with the bits of the notes it applies to. */
type NValue = { readonly note: number } | { readonly appliesTo: number; readonly cymbal: boolean } | null

const nValueTables = new Map<Instrument, readonly NValue[]>()

/** What each `N` value up to 255 is on `instrument`, as `getNEventType` reads it. */
function nValues(instrument: Instrument): readonly NValue[] {
	let table = nValueTables.get(instrument)
	if (table === undefined) {
		table = Array.from({ length: 256 }, (_, value): NValue => {
			const type = getNEventType(String(value), instrument)
			const pad = type === null ? undefined : markerPads.get(type)
			return type === null ? null
				: tickModifiers.has(type) ? { appliesTo: ~0, cymbal: false }
				: pad !== undefined ? { appliesTo: noteBit(padValues.get(pad)!), cymbal: cymbalMarkers.has(type) }
				: { note: noteBit(value) }
		})
		nValueTables.set(instrument, table)
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

const isBlank = (code: number) => code === 32 || code === 9
const isDigit = (code: number) => code >= 48 && code <= 57

/**
 * The modifiers of the section text from `start` to `end`, read a character at a time: every instrument section is
 * read on every analysis. Each `N` line is read in any spacing scan-chart reads, and a tick's lines from where they
 * are. `null` for a section whose lines aren't in tick order, which is left as it is.
 */
function scanSection(text: string, start: number, end: number, instrument: Instrument): SectionModifiers | null {
	const values = nValues(instrument)
	const cymbalLines: ChartLineRange[] = []
	const otherLines: ChartLineRange[] = []
	let hasNotes = false
	let hasFiveLaneGreen = false
	let hasCymbalWithNote = false
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
	for (let position = start; position < end;) {
		const lineFeed = text.indexOf('\n', position)
		// Text before the section's `}` on its line is read as no line.
		if (lineFeed === -1 || lineFeed >= end) break
		const lineEnd = lineFeed + 1
		let index = position
		while (index < lineEnd && isBlank(text.charCodeAt(index))) index++
		let lineTick = 0
		const tickStart = index
		while (index < lineEnd && isDigit(text.charCodeAt(index))) lineTick = lineTick * 10 + text.charCodeAt(index++) - 48
		const hasTick = index > tickStart
		while (index < lineEnd && isBlank(text.charCodeAt(index))) index++
		if (index < lineEnd && text.charCodeAt(index) === 61) index++ // =
		while (index < lineEnd && isBlank(text.charCodeAt(index))) index++
		const isN = hasTick && index + 1 < lineEnd && text.charCodeAt(index) === 78 && isBlank(text.charCodeAt(index + 1)) // N
		index++
		while (isN && index < lineEnd && isBlank(text.charCodeAt(index))) index++
		let value = 0
		const valueStart = index
		while (isN && index < lineEnd && isDigit(text.charCodeAt(index)) && value < 256) value = value * 10 + text.charCodeAt(index++) - 48
		const read = isN && index > valueStart && value < 256 ? values[value] : null
		if (read !== null) {
			if (lineTick < tick) return null
			if (lineTick !== tick) {
				endTick()
				tick = lineTick
			}
			if ('note' in read) {
				notes |= read.note
				hasNotes = true
				if (instrument === 'drums' && value === 5) hasFiveLaneGreen = true
			} else {
				pending.push({ line: { start: position, end: lineEnd }, appliesTo: read.appliesTo, cymbal: read.cymbal })
			}
		}
		position = lineEnd
	}
	endTick()
	return { hasNotes, cymbalLines, otherLines, hasFiveLaneGreen, hasCymbalWithNote }
}

const fileModifiers = new ObjectCache<ChartFileTokens, ReadonlyMap<string, readonly ChartLineRange[]>>('chartModifiersWithoutNotes')

/**
 * The lines of each instrument section a reader reads, by name, that hold a modifier with no note to apply to, which
 * every reader ignores: a forced, tap or flam modifier on a tick with no note, and an accent, ghost or cymbal marker on
 * a tick without its pad's note. A section with no notes, which isn't a track, has none.
 *
 * A cymbal marker without its note still decides the drum type: Clone Hero and scan-chart read a chart with any cymbal
 * marker as pro, and YARG one whose first cymbal marker or `N 5` is a cymbal marker. So such a marker counts only when
 * another cymbal marker has its note, no drums section has an `N 5`, and every drums section's lines are in tick order.
 */
export function chartModifiersWithoutNotes(tokens: ChartFileTokens): ReadonlyMap<string, readonly ChartLineRange[]> {
	let byName = fileModifiers.get(tokens)
	if (byName !== undefined) return byName
	const sections = new Map<string, { instrument: Instrument; modifiers: SectionModifiers | null }>()
	for (const section of tokens.sections) {
		const track = chartSectionTrack(section.name)
		if (track === null || sections.has(section.name)) continue
		sections.set(section.name, { instrument: track.instrument, modifiers: scanSection(tokens.text, section.bodyStart, section.bodyEnd, track.instrument) })
	}
	const drums = [...sections.values()].filter(section => section.instrument === 'drums').map(section => section.modifiers)
	const keepCymbalMarkers = drums.some(modifiers => modifiers === null || modifiers.hasFiveLaneGreen) || !drums.some(modifiers => modifiers?.hasCymbalWithNote)
	const found = new Map<string, readonly ChartLineRange[]>()
	for (const [name, { modifiers }] of sections) {
		if (modifiers === null || !modifiers.hasNotes) continue
		const lines = [...modifiers.otherLines, ...keepCymbalMarkers ? [] : modifiers.cymbalLines].sort((a, b) => a.start - b.start)
		if (lines.length > 0) found.set(name, lines)
	}
	fileModifiers.set(tokens, byName = found)
	return byName
}
