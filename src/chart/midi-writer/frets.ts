/**
 * PART GUITAR / BASS / GHL (5- and 6-fret) emission for the `.mid` writer.
 */
import type { MidiEvent } from '@geomitron/midi-file'

import { type Difficulty, getInstrumentType, instrumentTypes, instruments } from '../../types'
import type { NoteEvent, NoteType } from '../types'
import { noteFlags, noteTypes } from '../types'
import { fiveFretDiffStarts, fiveFretLaneOffsets, sixFretDiffStarts, sixFretLaneOffsets } from '../midi-note-numbers'
import { computeHopoThresholdTicks, isNaturalHopo } from '../natural-hopo'
import type { ParsedChart } from '../parse-chart-and-ini'
import { wrapEventBrackets } from '../writer-shared'
import {
	addNoteOnOff,
	addFlexLanes,
	addNoteOnOffWithChannel,
	addVerbatimEvents,
	addVersusPhrases,
	finalizeMidiTrack,
	instrumentSections,
	metaTextEvent,
	type MidiWriteOptions,
	noteOffEvent,
	noteOnEvent,
	stretchUnsustainedNotes,
	trackNameEvent,
} from './shared'
import type { AbsoluteEvent, ParsedTrack } from './shared'


// ---------------------------------------------------------------------------
// Fret / GHL track emission
// ---------------------------------------------------------------------------

/** NoteType → lane offset for 5-fret. `open` routes through forceOpen SysEx
 * or ENHANCED_OPENS mode (handled in emitFretNotes), not this map. */
const fiveFretNoteTypeToOffset: Partial<Record<NoteType, number>> = {
	[noteTypes.green]:  fiveFretLaneOffsets.green,
	[noteTypes.red]:    fiveFretLaneOffsets.red,
	[noteTypes.yellow]: fiveFretLaneOffsets.yellow,
	[noteTypes.blue]:   fiveFretLaneOffsets.blue,
	[noteTypes.orange]: fiveFretLaneOffsets.orange,
}

/** NoteType → lane offset for 6-fret (GHL). */
const sixFretNoteTypeToOffset: Partial<Record<NoteType, number>> = {
	[noteTypes.open]:   sixFretLaneOffsets.open,
	[noteTypes.white1]: sixFretLaneOffsets.white1,
	[noteTypes.white2]: sixFretLaneOffsets.white2,
	[noteTypes.white3]: sixFretLaneOffsets.white3,
	[noteTypes.black1]: sixFretLaneOffsets.black1,
	[noteTypes.black2]: sixFretLaneOffsets.black2,
	[noteTypes.black3]: sixFretLaneOffsets.black3,
}

/**
 * A fret instrument's note numbers: each difficulty's first, and each note type's offset from it. A 5-fret open has no
 * offset: it's on the open key with [ENHANCED_OPENS], else on green with a SysEx open.
 */
interface FretLayout {
	readonly diffStarts: Record<Difficulty, number>
	readonly noteTypeToOffset: Partial<Record<NoteType, number>>
}
const fiveFretLayout: FretLayout = { diffStarts: fiveFretDiffStarts, noteTypeToOffset: fiveFretNoteTypeToOffset }
const sixFretLayout: FretLayout = { diffStarts: sixFretDiffStarts, noteTypeToOffset: sixFretNoteTypeToOffset }

export const fiveFretInstruments = new Set<string>(instruments.filter(instrument => getInstrumentType(instrument) === instrumentTypes.fiveFret))
export const sixFretInstruments = new Set<string>(instruments.filter(instrument => getInstrumentType(instrument) === instrumentTypes.sixFret))

/** SysEx diff byte for Phase Shift modifier encoding. */
const sysExDiffMap: Record<Difficulty, number> = {
	easy: 0x00,
	medium: 0x01,
	hard: 0x02,
	expert: 0x03,
}

/**
 * Build a PART GUITAR / PART BASS / PART GUITAR GHL / etc. track. Single
 * MIDI track per instrument group; all difficulties merge into it.
 */
export function buildFretTrack(
	trackDataEntries: ParsedTrack[],
	chart: ParsedChart,
	trackName: string,
	options: MidiWriteOptions = {},
): MidiEvent[] {
	const events: AbsoluteEvent[] = []
	const instrument = trackDataEntries[0].instrument
	const isGhl = sixFretInstruments.has(instrument)
	const layout = isGhl ? sixFretLayout : fiveFretLayout
	const sourceIsMidi = chart.format === 'mid'

	events.push({
		tick: 0,
		event: trackNameEvent(trackName),
	})

	const allStarPower: { tick: number; length: number }[][] = []
	const allSolo: { tick: number; length: number }[][] = []
	const allActivation: { tick: number; length: number }[][] = []

	// Use ENHANCED_OPENS mode when:
	//   (a) any group contains both an open note AND a non-open fret note
	//       (a chord-with-open) — the SysEx encoding can't represent these,
	//   (b) any open note's tick range overlaps a green note's tick range in
	//       the same difficulty — both encode to MIDI 96 under SysEx, and
	//       overlapping noteOn/noteOff pairs would re-pair wrong on parse,
	//       swapping sustain lengths.
	// Otherwise use forceOpen SysEx, which collapses chords-with-open into
	// single opens but avoids conflicts with animations at easy diffStart.
	// A 6-fret track has a key of its own for opens, and needs neither.
	const useEnhancedOpens = !isGhl && trackDataEntries.some(td => {
		if (td.noteEventGroups.some(group => {
			if (group.length < 2) return false
			const hasOpen = group.some(n => n.type === noteTypes.open)
			const hasOther = group.some(n => n.type !== noteTypes.open)
			return hasOpen && hasOther
		})) return true

		const opens: { tick: number; end: number }[] = []
		const greens: { tick: number; end: number }[] = []
		for (const group of td.noteEventGroups) {
			for (const n of group) {
				if (n.type === noteTypes.open) opens.push({ tick: n.tick, end: n.tick + n.length })
				else if (n.type === noteTypes.green) greens.push({ tick: n.tick, end: n.tick + n.length })
			}
		}
		if (opens.length === 0 || greens.length === 0) return false
		for (const o of opens) {
			for (const g of greens) {
				if (o.tick < g.end && g.tick < o.end) return true
			}
		}
		return false
	})

	// Build animation maps (MIDI note number → length) from the first-difficulty
	// data so emitFretNotes can coalesce its fret-note length with any animation
	// that overlaps at the same tick:noteNumber.
	const firstTd = trackDataEntries[0]
	const animMap = new Map<string, number>()
	for (const otherTd of trackDataEntries) {
		for (const anim of otherTd.animations) {
			const key = `${anim.tick}:${anim.noteNumber}`
			const existing = animMap.get(key) ?? 0
			if (anim.length > existing) animMap.set(key, anim.length)
		}
	}

	// Pre-compute seq slots for first-difficulty animations. emitFretNotes stamps
	// the matching seq onto fret-note pairs that overlap an animation so the
	// animation array's order survives re-parse.
	const animSeqMap = new Map<string, { onSeq: number; offSeq: number }>()
	const ANIM_SEQ_BASE = 1_000_000_000
	{
		let probe = 0
		for (const anim of firstTd.animations) {
			const key = `${anim.tick}:${anim.noteNumber}`
			const onSeq = ANIM_SEQ_BASE + probe++
			const offSeq = ANIM_SEQ_BASE + probe++
			if (!animSeqMap.has(key)) animSeqMap.set(key, { onSeq, offSeq })
		}
	}

	for (const td of trackDataEntries) {
		emitFretNotes(events, td, layout, animMap, useEnhancedOpens, animSeqMap)

		allStarPower.push(td.starPowerSections)
		allSolo.push(td.soloSections)
		// BRE / coda activation (MIDI 120) — fret tracks support this in
		// addition to drums.
		allActivation.push(td.drumFreestyleSections)

		// First-difficulty extras: text events, versus phrases, animations,
		// per-track unrecognizedMidiEvents. scan-chart populates these
		// identically on all 4 difficulties; writing once avoids duplicates.
		if (td === firstTd) {
			for (const te of td.textEvents) {
				const text = sourceIsMidi ? te.text : wrapEventBrackets(te.text)
				events.push({
					tick: te.tick,
					event: metaTextEvent(text),
				})
			}

			addVersusPhrases(events, td.versusPhrases)

			// Animations: emit note-pair per animation unless the same
			// (tick, noteNumber) was already emitted by a fret note above (in
			// which case emitFretNotes coalesced the pair with the animation's
			// seq — no duplicate noteOn at this tick:noteNumber).
			const emittedNoteKeys = new Set<string>()
			for (const otherTd of trackDataEntries) {
				const diffStart = layout.diffStarts[otherTd.difficulty]
				for (const group of otherTd.noteEventGroups) {
					for (const n of group) {
						let noteNum: number
						const off = layout.noteTypeToOffset[n.type]
						if (n.type === noteTypes.open && off === undefined) {
							noteNum = useEnhancedOpens ? diffStart + 0 : diffStart + 1
						} else {
							if (off === undefined) continue
							noteNum = diffStart + off
						}
						emittedNoteKeys.add(`${n.tick}:${noteNum}`)
					}
				}
			}
			let animSeq = 0
			for (const anim of td.animations) {
				const key = `${anim.tick}:${anim.noteNumber}`
				// Advance seq counter even on skip so it stays in lock-step with
				// emitFretNotes' stamped onSeq/offSeq.
				const onSeq = ANIM_SEQ_BASE + animSeq++
				const offSeq = ANIM_SEQ_BASE + animSeq++
				if (emittedNoteKeys.has(key)) continue
				events.push({
					tick: anim.tick,
					seq: onSeq,
					event: noteOnEvent(anim.noteNumber, 100),
				})
				events.push({
					tick: anim.tick + anim.length,
					seq: offSeq,
					event: noteOffEvent(anim.noteNumber),
				})
			}

			addVerbatimEvents(events, td.unrecognizedMidiEvents)
		}
	}

	// Instrument-wide sections. Star power = 116, solo = 103, BRE/coda = 120. With song.ini's `multiplier_note = 103`
	// (Guitar Hero 1 and 2), 103 is star power and 116 is star power the parser rejects; such a chart has no solos.
	const gh1StarPower = chart.iniChartModifiers.multiplier_note === 103
	const allRejectedStarPower = gh1StarPower ? trackDataEntries.map(td => td.rejectedStarPowerSections) : []
	for (const sp of instrumentSections(trackDataEntries, allStarPower, options)) {
		const vel = (sp as { velocity?: number }).velocity ?? 100
		const ch = (sp as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, sp.tick, sp.length, gh1StarPower ? 103 : 116, vel, ch, options.zeroLengthPhrases)
	}
	for (const sp of instrumentSections(trackDataEntries, allRejectedStarPower, options)) {
		addNoteOnOffWithChannel(events, sp.tick, sp.length, 116, 100, 0, options.zeroLengthPhrases)
	}
	for (const solo of gh1StarPower ? [] : instrumentSections(trackDataEntries, allSolo, options)) {
		const vel = (solo as { velocity?: number }).velocity ?? 100
		const ch = (solo as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, solo.tick, solo.length, 103, vel, ch, options.zeroLengthPhrases)
	}
	for (const fs of instrumentSections(trackDataEntries, allActivation, options)) {
		const vel = (fs as { velocity?: number }).velocity ?? 100
		const ch = (fs as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, fs.tick, fs.length, 120, vel, ch, options.zeroLengthPhrases)
	}
	addFlexLanes(events, trackDataEntries)

	emitFretModifierRanges(events, trackDataEntries, isGhl, chart)

	if (useEnhancedOpens) {
		events.push({
			tick: 0,
			event: metaTextEvent('[ENHANCED_OPENS]'),
		})
	}

	if (options.sustainCutoff !== undefined) stretchUnsustainedNotes(events, options.sustainCutoff)
	return finalizeMidiTrack(events)
}

function emitFretNotes(
	events: AbsoluteEvent[],
	td: ParsedTrack,
	layout: FretLayout,
	animMap: Map<string, number>,
	useEnhancedOpens: boolean,
	animSeqMap: Map<string, { onSeq: number; offSeq: number }>,
): void {
	const diffStart = layout.diffStarts[td.difficulty]
	const { noteTypeToOffset } = layout

	const emitWithAnimSeq = (tick: number, length: number, noteNum: number): void => {
		const animSeqs = animSeqMap.get(`${tick}:${noteNum}`)
		if (!animSeqs) {
			addNoteOnOff(events, tick, length, noteNum, 100, true, true)
			return
		}
		const effectiveLength = Math.max(length, 1)
		events.push({
			tick,
			seq: animSeqs.onSeq,
			event: noteOnEvent(noteNum, 100),
		})
		events.push({
			tick: tick + effectiveLength,
			seq: animSeqs.offSeq,
			event: noteOffEvent(noteNum),
		})
	}

	for (const group of td.noteEventGroups) {
		for (const note of group) {
			const isFiveFretOpen = note.type === noteTypes.open && noteTypeToOffset[noteTypes.open] === undefined
			const baseLen = note.length

			if (isFiveFretOpen) {
				if (useEnhancedOpens) {
					const noteNum = diffStart + 0
					const animLength = animMap.get(`${note.tick}:${noteNum}`)
					const len = (animLength != null && animLength > baseLen) ? animLength : baseLen
					emitWithAnimSeq(note.tick, len, noteNum)
				} else {
					// forceOpen via SysEx (collapses chords — but useEnhancedOpens is only
					// false when no chord-with-open exists, so no info is lost).
					const noteNum = diffStart + 1
					const animLength = animMap.get(`${note.tick}:${noteNum}`)
					const len = (animLength != null && animLength > baseLen) ? animLength : baseLen
					emitWithAnimSeq(note.tick, len, noteNum)
					addSysExOnOff(events, note.tick, 1, sysExDiffMap[td.difficulty], 0x01)
				}
				continue
			}
			const offset = noteTypeToOffset[note.type]
			if (offset === undefined) continue
			const noteNum = diffStart + offset
			const animLength = animMap.get(`${note.tick}:${noteNum}`)
			const len = (animLength != null && animLength > baseLen) ? animLength : baseLen
			emitWithAnimSeq(note.tick, len, noteNum)
		}
	}
}

/** A Phase Shift SysEx range. At one tick, a zero-length range's start sorts before its end, as they are added. */
function addSysExOnOff(
	events: AbsoluteEvent[],
	tick: number,
	length: number,
	diffByte: number,
	typeByte: number,
): void {
	events.push({
		tick,
		event: {
			deltaTime: 0,
			type: 'sysEx',
			data: new Uint8Array([0x50, 0x53, 0x00, 0x00, diffByte, typeByte, 0x01, 0xF7]),
		} as MidiEvent,
	})
	events.push({
		tick: tick + length,
		event: {
			deltaTime: 0,
			type: 'sysEx',
			data: new Uint8Array([0x50, 0x53, 0x00, 0x00, diffByte, typeByte, 0x00, 0xF7]),
		} as MidiEvent,
	})
}

// ---------------------------------------------------------------------------
// Force modifier range emission (forceHopo / forceStrum / forceTap)
// ---------------------------------------------------------------------------

/**
 * Emit force-modifier ranges (forceHopo / forceStrum / forceTap) when a
 * note's resolved flag disagrees with the natural HOPO state the parser
 * would pick without modifiers. Natural state is re-derived here so the
 * output round-trips scan-chart's resolveFretModifiers.
 */
function emitFretModifierRanges(
	events: AbsoluteEvent[],
	trackDataEntries: ParsedTrack[],
	isGhl: boolean,
	chart: ParsedChart,
): void {
	const diffStarts = isGhl ? sixFretDiffStarts : fiveFretDiffStarts
	const hopoThreshold = computeHopoThresholdTicks(
		chart.resolution,
		chart.iniChartModifiers.hopo_frequency,
		chart.iniChartModifiers.eighthnote_hopo,
		'mid',
	)

	for (const td of trackDataEntries) {
		const difficulty = td.difficulty
		const noteTicksInOrder: number[] = []
		const hopoTicks = new Set<number>()
		const strumTicks = new Set<number>()
		const tapTicks = new Set<number>()

		let lastGroup: NoteEvent[] | null = null
		for (const group of td.noteEventGroups) {
			if (group.length === 0) continue
			const tick = group[0].tick
			noteTicksInOrder.push(tick)

			const flags = group[0].flags
			const wantHopo = (flags & noteFlags.hopo) !== 0
			const wantStrum = (flags & noteFlags.strum) !== 0

			const isNatHopo = isNaturalHopo(group, lastGroup, hopoThreshold, 'mid')

			if (wantHopo && !isNatHopo) hopoTicks.add(tick)
			if (wantStrum && isNatHopo) strumTicks.add(tick)
			if (flags & noteFlags.tap) tapTicks.add(tick)

			lastGroup = group
		}

		const laneOffsets = isGhl ? sixFretLaneOffsets : fiveFretLaneOffsets
		for (const range of reconstructModifierRanges(hopoTicks, noteTicksInOrder)) {
			addNoteOnOff(events, range.tick, range.length, diffStarts[difficulty] + laneOffsets.forceHopo, 100)
		}
		for (const range of reconstructModifierRanges(strumTicks, noteTicksInOrder)) {
			addNoteOnOff(events, range.tick, range.length, diffStarts[difficulty] + laneOffsets.forceStrum, 100)
		}
		for (const range of tapRanges(tapTicks, noteTicksInOrder)) {
			addSysExOnOff(events, range.tick, range.length, sysExDiffMap[difficulty], 0x04)
		}
	}
}

/**
 * The tap ranges for `tapTicks`, each ending before the next note. A tap range includes its end tick under the canonical
 * rules and excludes it in Clone Hero 1.1 and YARG, so no note may sit on it. When the next note is one tick after the
 * last tapped note, the range ends on that note, and a zero-length range, which every reader reads as its own tick, taps
 * it.
 */
function tapRanges(tapTicks: Set<number>, noteTicksInOrder: number[]): { tick: number; length: number }[] {
	const noteTicks = new Set(noteTicksInOrder)
	const ranges: { tick: number; length: number }[] = []
	for (const range of reconstructModifierRanges(tapTicks, noteTicksInOrder)) {
		const lastTap = range.tick + range.length - 1
		if (!noteTicks.has(lastTap + 1)) {
			ranges.push(range)
			continue
		}
		if (lastTap > range.tick) ranges.push({ tick: range.tick, length: lastTap - range.tick })
		ranges.push({ tick: lastTap, length: 0 })
	}
	return ranges
}

/**
 * Collapse a set of tick-keyed modifier hits into minimal covering ranges
 * (contiguous runs over `noteTicksInOrder`). A range's length is
 * `lastModifiedTick - rangeStart + 1`.
 */
function reconstructModifierRanges(
	modifiedTicks: Set<number>,
	noteTicksInOrder: number[],
): { tick: number; length: number }[] {
	if (modifiedTicks.size === 0) return []

	const sorted = [...new Set(noteTicksInOrder)].sort((a, b) => a - b)
	const ranges: { tick: number; length: number }[] = []
	let rangeStart: number | null = null
	let lastModifiedTick: number | null = null

	for (const tick of sorted) {
		if (modifiedTicks.has(tick)) {
			if (rangeStart === null) rangeStart = tick
			lastModifiedTick = tick
		} else if (rangeStart !== null && lastModifiedTick !== null) {
			ranges.push({ tick: rangeStart, length: lastModifiedTick - rangeStart + 1 })
			rangeStart = null
			lastModifiedTick = null
		}
	}
	if (rangeStart !== null && lastModifiedTick !== null) {
		ranges.push({ tick: rangeStart, length: lastModifiedTick - rangeStart + 1 })
	}
	return ranges
}
