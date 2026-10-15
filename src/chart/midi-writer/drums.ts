/**
 * PART DRUMS emission for the `.mid` writer.
 */
import type { MidiEvent } from '@geomitron/midi-file'

import type { Difficulty } from '../../types'
import { drumTypes } from '../../types'
import type { NoteType } from '../types'
import { noteFlags, noteTypes } from '../types'
import type { DrumMixEvent } from '../raw-types'
import { drumsDiffStarts } from '../midi-note-numbers'
import type { ParsedChart } from '../parse-chart-and-ini'
import { wrapEventBrackets } from '../writer-shared'
import {
	addNoteOnOff,
	addNoteOnOffWithChannel,
	addVerbatimEvents,
	addVersusPhrases,
	computeLengthOverrides,
	finalizeMidiTrack,
	instrumentSections,
	metaTextEvent,
	type MidiWriteOptions,
	noteOffEvent,
	noteOnEvent,
	readSustainCutoff,
	stretchUnsustainedNotes,
	trackNameEvent,
} from './shared'
import type { AbsoluteEvent, ParsedTrack } from './shared'


// ---------------------------------------------------------------------------
// Drum track emission
// ---------------------------------------------------------------------------

/** NoteType → offset from difficulty base for drum notes (4-lane / 4-lane-pro). */
const drumNoteTypeToOffset: Partial<Record<NoteType, number>> = {
	[noteTypes.kick]: 0,
	[noteTypes.redDrum]: 1,
	[noteTypes.yellowDrum]: 2,
	[noteTypes.blueDrum]: 3,
	[noteTypes.greenDrum]: 4,
}

/**
 * NoteType → offset for 5-lane drum notes. `greenDrum` is the 5th lane
 * (MIDI 101) and `orangeDrum` (the 4th lane) is represented as greenDrum +
 * cymbal flag — the writer remaps to offset 4 at emission time for those.
 */
const drumNoteTypeToOffsetFiveLane: Partial<Record<NoteType, number>> = {
	[noteTypes.kick]: 0,
	[noteTypes.redDrum]: 1,
	[noteTypes.yellowDrum]: 2,
	[noteTypes.blueDrum]: 3,
	[noteTypes.greenDrum]: 5,
}

/** NoteType → tom-marker MIDI note number. Only yellow/blue/green have markers. */
const drumTomMarkerNote: Partial<Record<NoteType, number>> = {
	[noteTypes.yellowDrum]: 110,
	[noteTypes.blueDrum]: 111,
	[noteTypes.greenDrum]: 112,
}

/**
 * Build a PART DRUMS track from one or more parsed drum tracks (one entry per
 * difficulty). All difficulties emit into the same MIDI track.
 */
export function buildDrumTrack(
	trackDataEntries: ParsedTrack[],
	chart: ParsedChart,
	trackName: string,
	options: MidiWriteOptions = {},
): MidiEvent[] {
	const events: AbsoluteEvent[] = []

	events.push({
		tick: 0,
		event: trackNameEvent(trackName),
	})

	let hasAccentsOrGhosts = false
	const allStarPower: { tick: number; length: number }[][] = []
	const allSolo: { tick: number; length: number }[][] = []
	const allActivation: { tick: number; length: number }[][] = []
	const emittedFlexLane = new Map<string, number>()
	const emittedTomMarker = new Set<string>()
	const emittedFlam = new Set<string>()

	// In fourLanePro, a green-drum that has BOTH tom and cymbal flags at the
	// same tick across difficulties would get forced to tom by a global
	// greenTomMarker. Detect those ticks up-front so emitDrumNotes can fall
	// back to MIDI 101 (offset 5) for the tom note instead of emitting a
	// conflicting marker.
	const conflictedGreenTomTicks = new Set<number>()
	{
		const greenTickFlags = new Map<number, { tom: boolean; cymbal: boolean }>()
		for (const td of trackDataEntries) {
			for (const group of td.noteEventGroups) {
				for (const n of group) {
					if (n.type !== noteTypes.greenDrum) continue
					const isTom = (n.flags & noteFlags.tom) !== 0
					const isCym = (n.flags & noteFlags.cymbal) !== 0
					if (!isTom && !isCym) continue
					const cur = greenTickFlags.get(n.tick) ?? { tom: false, cymbal: false }
					if (isTom) cur.tom = true
					if (isCym) cur.cymbal = true
					greenTickFlags.set(n.tick, cur)
				}
			}
		}
		for (const [tick, f] of greenTickFlags) {
			if (f.tom && f.cymbal) conflictedGreenTomTicks.add(tick)
		}
	}

	const diffVelocity: Record<Difficulty, number> = { easy: 25, medium: 35, hard: 45, expert: 100 }
	const cutoff = readSustainCutoff(chart, options)

	for (const td of trackDataEntries) {
		emitDrumNotes(events, td, chart, cutoff, emittedTomMarker, emittedFlam, conflictedGreenTomTicks, hasAG => {
			if (hasAG) hasAccentsOrGhosts = true
		})

		// Collect instrument-wide sections (dedup after loop).
		allStarPower.push(td.starPowerSections)
		allSolo.push(td.soloSections)
		allActivation.push(td.drumFreestyleSections)

		// Flex lanes: pick the minimum-velocity entry across difficulties so
		// scan-chart's fixFlexLaneLds assigns it to the right difficulty.
		for (const fl of td.flexLanes) {
			const note = fl.isDouble ? 127 : 126
			const key = `${fl.tick}:${fl.length}:${note}`
			const thisVel = diffVelocity[td.difficulty] ?? 100
			const existing = emittedFlexLane.get(key)
			if (existing === undefined || thisVel < existing) emittedFlexLane.set(key, thisVel)
		}

		// Per-track extras — emit once from the first difficulty (scan-chart
		// populates textEvents / versusPhrases / animations / unrecognizedMidiEvents
		// identically across all 4 difficulties; writing them 4× would duplicate).
		if (td === trackDataEntries[0]) {
			const sourceIsMidi = chart.format === 'mid'
			for (const te of td.textEvents) {
				const text = sourceIsMidi ? te.text : wrapEventBrackets(te.text)
				events.push({
					tick: te.tick,
					event: metaTextEvent(text),
				})
			}
			addVersusPhrases(events, td.versusPhrases)
			addVerbatimEvents(events, td.unrecognizedMidiEvents)
		}
	}

	// Instrument-wide sections. Preserve velocity/channel from source if the
	// parser attached them (MIDI-parsed sections carry raw MIDI properties).
	const soloNote = 103
	for (const sp of instrumentSections(trackDataEntries, allStarPower, options)) {
		const vel = (sp as { velocity?: number }).velocity ?? 100
		const ch = (sp as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, sp.tick, sp.length, 116, vel, ch, options.zeroLengthPhrases)
	}
	for (const solo of instrumentSections(trackDataEntries, allSolo, options)) {
		const vel = (solo as { velocity?: number }).velocity ?? 100
		const ch = (solo as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, solo.tick, solo.length, soloNote, vel, ch, options.zeroLengthPhrases)
	}
	for (const fs of instrumentSections(trackDataEntries, allActivation, options)) {
		const vel = (fs as { velocity?: number }).velocity ?? 100
		const ch = (fs as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, fs.tick, fs.length, 120, vel, ch, options.zeroLengthPhrases)
	}

	// Lanes are written with addNoteOnOff, so a lane that ends where another of its number starts ends first.
	for (const [key, velocity] of emittedFlexLane) {
		const [tick, length, noteNumber] = key.split(':').map(Number)
		addNoteOnOff(events, tick, length, noteNumber, velocity, true)
	}

	if (hasAccentsOrGhosts) {
		events.push({
			tick: 0,
			event: metaTextEvent('[ENABLE_CHART_DYNAMICS]'),
		})
	}

	// fourLanePro sentinel tom marker: if drumType=1 but no tom markers were
	// emitted (e.g. all yellow/blue defaulted to cymbal and green-toms used
	// the offset-5 encoding), scan-chart's drumType detection falls through
	// to fourLane. Emit a greenTomMarker at a tick where it attaches only to
	// non-affected notes (kick, red, or fiveGreenDrum — which are always tom),
	// or else a marker of a color no note at its tick is a cymbal of.
	if (chart.drumType === drumTypes.fourLanePro && emittedTomMarker.size === 0) {
		let markerTick: number | null = null
		// Prefer a green-tom tick.
		for (const td of trackDataEntries) {
			for (const g of td.noteEventGroups) {
				for (const n of g) {
					if (n.type === noteTypes.greenDrum && (n.flags & noteFlags.tom)) {
						if (conflictedGreenTomTicks.has(n.tick)) continue
						if (markerTick === null || n.tick < markerTick) markerTick = n.tick
					}
				}
			}
		}
		if (markerTick === null) {
			// Fall back: pick a tick with only kick/red (no yellow/blue/green drum)
			// across ALL difficulties — tom markers apply to the whole track.
			const unsafeTicks = new Set<number>()
			for (const td of trackDataEntries) {
				for (const g of td.noteEventGroups) {
					if (g.some(n =>
						n.type === noteTypes.yellowDrum ||
						n.type === noteTypes.blueDrum ||
						n.type === noteTypes.greenDrum,
					)) unsafeTicks.add(g[0].tick)
				}
			}
			for (const td of trackDataEntries) {
				for (const g of td.noteEventGroups) {
					if (unsafeTicks.has(g[0].tick)) continue
					const hasKickOrRed = g.some(n => n.type === noteTypes.kick || n.type === noteTypes.redDrum)
					if (hasKickOrRed && (markerTick === null || g[0].tick < markerTick)) {
						markerTick = g[0].tick
					}
				}
			}
		}
		let markerNote = 112
		if (markerTick === null) {
			// Last: a marker of a color none of the tick's notes on any difficulty is a cymbal of, which turns no note
			// into a tom, at the first tick with a note.
			const cymbalColors = new Map<number, Set<NoteType>>()
			for (const td of trackDataEntries) {
				for (const g of td.noteEventGroups) {
					const colors = cymbalColors.get(g[0].tick) ?? new Set<NoteType>()
					cymbalColors.set(g[0].tick, colors)
					for (const n of g) if (n.flags & noteFlags.cymbal) colors.add(n.type)
				}
			}
			for (const [tick, colors] of [...cymbalColors].sort(([a], [b]) => a - b)) {
				const color = ([noteTypes.greenDrum, noteTypes.blueDrum, noteTypes.yellowDrum] as const).find(type => !colors.has(type))
				if (color !== undefined) {
					markerTick = tick
					markerNote = drumTomMarkerNote[color]!
					break
				}
			}
		}
		if (markerTick !== null) addNoteOnOff(events, markerTick, 1, markerNote, 100)
	}

	if (options.sustainCutoff !== undefined) stretchUnsustainedNotes(events, options.sustainCutoff)
	return finalizeMidiTrack(events)
}

/**
 * The disco flip mix events to write for a drum track: each one it was read with, as written, and one at each tick
 * whose red and yellow notes need another flip than the last event gives, which replaces an event read at that tick. An
 * added event has the stem configuration of the last event read before it, or else of the first one, or 0.
 */
function drumMixEvents(td: ParsedTrack): DrumMixEvent[] {
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
	return written
}

function emitDrumNotes(
	events: AbsoluteEvent[],
	td: ParsedTrack,
	chart: ParsedChart,
	cutoff: number,
	emittedTomMarker: Set<string>,
	emittedFlam: Set<string>,
	conflictedGreenTomTicks: Set<number>,
	reportAccentGhost: (hasAG: boolean) => void,
): void {
	const base = drumsDiffStarts[td.difficulty]
	const diffIdx: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2, expert: 3 }
	const di = diffIdx[td.difficulty] ?? 3
	for (const { tick, configuration, flag } of drumMixEvents(td)) {
		events.push({ tick, event: metaTextEvent(`[mix ${di} drums${configuration}${flag}]`) })
	}

	const drumType = chart.drumType
	const isFiveLaneTrack = drumType === drumTypes.fiveLane
	const isFourLanePro = drumType === drumTypes.fourLanePro
	const offsetTable = isFiveLaneTrack ? drumNoteTypeToOffsetFiveLane : drumNoteTypeToOffset
	const lengthOverrides = computeLengthOverrides(td, cutoff)

	for (const group of td.noteEventGroups) {
		let hasFlamInGroup = false

		// Ensure regular kicks emit BEFORE double kicks at the same tick — YARG's
		// MoonNote insertion dedupes by (tick, rawNote), so if both a regular kick
		// and a 2x-kick pedal exist at the same tick, whichever is inserted second
		// is dropped. Emitting the regular kick first keeps Expert playable when
		// the non-Expert+ pass filters out the 2x kicks.
		const orderedGroup = group.slice().sort((a, b) => {
			const aIsDK = a.type === noteTypes.kick && (a.flags & noteFlags.doubleKick) ? 1 : 0
			const bIsDK = b.type === noteTypes.kick && (b.flags & noteFlags.doubleKick) ? 1 : 0
			return aIsDK - bIsDK
		})

		for (const note of orderedGroup) {
			let offset = offsetTable[note.type]
			if (offset === undefined) continue

			// Velocity encoding for accent/ghost.
			let velocity = 100
			if (note.flags & noteFlags.accent) {
				velocity = 127
				reportAccentGhost(true)
			} else if (note.flags & noteFlags.ghost) {
				velocity = 1
				reportAccentGhost(true)
			}

			const emitLength = lengthOverrides.get(`${note.tick}:${note.type}`) ?? note.length

			// fourLanePro green-tom conflict handling: if another difficulty at
			// the same tick has greenDrum+cymbal, emitting a global tom marker
			// would flip that cymbal note to tom. Fall back to offset 5 (MIDI
			// 101 = fiveGreenDrum, always tom) instead.
			const isGreenDrumTom = note.type === noteTypes.greenDrum && (note.flags & noteFlags.tom) !== 0
			const useOffset5Fallback = isFourLanePro && isGreenDrumTom && conflictedGreenTomTicks.has(note.tick)
			if (useOffset5Fallback) offset = 5

			// 5-lane green-drum+cymbal → emit at offset 4 (MIDI 100, orange pad).
			if (isFiveLaneTrack && note.type === noteTypes.greenDrum && (note.flags & noteFlags.cymbal)) {
				offset = 4
			}
			// 5-lane detection requires at least one fiveGreenDrum (MIDI 101).
			// Blue at the same tick as green+cymbal gets emitted as MIDI 101 to
			// restore the MIDI 100 + 101 pair the parser collapsed into blue.
			if (
				isFiveLaneTrack &&
				note.type === noteTypes.blueDrum &&
				group.some(n => n.type === noteTypes.greenDrum && (n.flags & noteFlags.cymbal))
			) {
				offset = 5
			}

			const isDoubleKick = note.type === noteTypes.kick && (note.flags & noteFlags.doubleKick)
			if (isDoubleKick) {
				addNoteOnOff(events, note.tick, emitLength, base - 1, velocity, true, true)
			} else {
				addNoteOnOff(events, note.tick, emitLength, base + offset, velocity, true, true)
			}

			// Tom markers only emit in fourLanePro. Skip the offset-5 fallback
			// ticks (MIDI 101 already conveys tom for fiveGreenDrum).
			if ((note.flags & noteFlags.tom) && isFourLanePro && !useOffset5Fallback) {
				const tomNote = drumTomMarkerNote[note.type]
				if (tomNote !== undefined) {
					const key = `${note.tick}:1:${tomNote}`
					if (!emittedTomMarker.has(key)) {
						emittedTomMarker.add(key)
						addNoteOnOff(events, note.tick, 1, tomNote, 100)
					}
				}
			}

			if (note.flags & noteFlags.flam) hasFlamInGroup = true
		}

		// One flam marker (MIDI 109) per group, shared across all notes at this tick.
		if (hasFlamInGroup && group.length > 0) {
			const key = `${group[0].tick}:1`
			if (!emittedFlam.has(key)) {
				emittedFlam.add(key)
				addNoteOnOff(events, group[0].tick, 1, 109, 100)
			}
		}
	}
}
