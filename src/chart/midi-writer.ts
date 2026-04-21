/**
 * MIDI binary writer — serializes a ParsedChart back to a Format-1 `.mid` file.
 *
 * Currently emits:
 *   - TEMPO TRACK (tempo + time-signature meta events)
 *   - EVENTS track (sections + end events + unrecognized global events + coda)
 *   - PART DRUMS instrument tracks (4-lane / 4-lane-pro / 5-lane with full
 *     modifier support)
 *   - Unrecognized MIDI tracks (verbatim pass-through)
 *
 * PART GUITAR / GHL / PART VOCALS / HARM1-3 land in follow-up PRs.
 */

import type { MidiData, MidiEvent } from '@geomitron/midi-file'
import { writeMidi } from '@geomitron/midi-file'

import type { Difficulty } from '../interfaces'
import { drumsDiffStarts } from './midi-note-numbers'
import type { NoteEvent, NoteType } from './note-parsing-interfaces'
import { noteFlags, noteTypes } from './note-parsing-interfaces'
import type { ParsedChart } from './parse-chart-and-ini'

type ParsedTrack = ParsedChart['trackData'][number]

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A MIDI event tagged with its absolute tick (for sort-then-delta finalization). */
interface AbsoluteEvent {
	tick: number
	event: MidiEvent
	/** Stable sort tiebreaker — preserves source ordering within the same tick. */
	seq?: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a {@link ParsedChart} to `.mid` bytes.
 *
 * Output track layout:
 *   0 — TEMPO TRACK (BPM + time signatures)
 *   1 — EVENTS (sections, end events, global events, coda)
 *   N — PART DRUMS (one track per drum instrument group, all difficulties)
 *   N — Unrecognized MIDI tracks (verbatim pass-through)
 *
 * Fret tracks (PART GUITAR, GHL) and vocal tracks (PART VOCALS, HARM1/2/3)
 * are emitted by follow-up PRs — this entry point skips them for now.
 */
export function writeMidiFile(chart: ParsedChart): Uint8Array {
	const trackMap = new Map<string, MidiEvent[]>()

	trackMap.set('TEMPO TRACK', buildTempoTrack(chart))
	trackMap.set('EVENTS', buildEventsTrack(chart))

	// Group trackData by instrument so a multi-difficulty instrument emits as
	// one MIDI track. A new group starts when an (instrument, difficulty) pair
	// repeats (rare — catches duplicate PART DRUMS tracks in malformed sources).
	interface TrackGroup {
		instrument: string
		trackName: string
		entries: ParsedTrack[]
		seenKeys: Set<string>
	}
	const groups: TrackGroup[] = []
	for (const td of chart.trackData) {
		const trackName = instrumentTrackNames[td.instrument]
		if (!trackName) continue
		const dupKey = `${td.instrument}:${td.difficulty}`
		let group: TrackGroup | undefined
		for (let i = groups.length - 1; i >= 0; i--) {
			const g = groups[i]
			if (g.instrument !== td.instrument || g.trackName !== trackName) break
			if (!g.seenKeys.has(dupKey)) { group = g; break }
		}
		if (!group) {
			group = { instrument: td.instrument, trackName, entries: [], seenKeys: new Set() }
			groups.push(group)
		}
		group.entries.push(td)
		group.seenKeys.add(dupKey)
	}

	let dupSuffix = 0
	for (const g of groups) {
		// Drums only in this PR; fret/vocal tracks land in PR #5c and #5d.
		if (g.instrument !== 'drums') continue
		let mapKey = g.trackName
		while (trackMap.has(mapKey)) mapKey = `${g.trackName}__dup${dupSuffix++}`
		trackMap.set(mapKey, buildDrumTrack(g.entries, chart, g.trackName))
	}

	// Unrecognized whole tracks (VENUE, BEAT, PART REAL_*, custom tracks) are
	// round-tripped verbatim.
	for (const ut of chart.unrecognizedMidiTracks) {
		let mapKey = ut.trackName
		while (trackMap.has(mapKey)) mapKey = `${ut.trackName}__dup${dupSuffix++}`
		trackMap.set(mapKey, buildUnrecognizedTrack(ut.events))
	}

	const tracks = [...trackMap.values()]
	const midiData: MidiData = {
		header: {
			format: 1,
			numTracks: tracks.length,
			ticksPerBeat: chart.resolution,
		},
		tracks,
	}
	return new Uint8Array(writeMidi(midiData))
}

// ---------------------------------------------------------------------------
// Track builders
// ---------------------------------------------------------------------------

function buildTempoTrack(chart: ParsedChart): MidiEvent[] {
	const events: AbsoluteEvent[] = []

	events.push({
		tick: 0,
		event: { deltaTime: 0, meta: true, type: 'trackName', text: 'TEMPO TRACK' } as MidiEvent,
	})

	for (const tempo of chart.tempos) {
		events.push({
			tick: tempo.tick,
			event: {
				deltaTime: 0,
				meta: true,
				type: 'setTempo',
				microsecondsPerBeat: Math.round(60_000_000 / tempo.beatsPerMinute),
			} as MidiEvent,
		})
	}

	for (const ts of chart.timeSignatures) {
		events.push({
			tick: ts.tick,
			event: {
				deltaTime: 0,
				meta: true,
				type: 'timeSignature',
				numerator: ts.numerator,
				denominator: ts.denominator,
				metronome: 24,
				thirtyseconds: 8,
			} as MidiEvent,
		})
	}

	return finalizeMidiTrack(events)
}

function buildEventsTrack(chart: ParsedChart): MidiEvent[] {
	const events: AbsoluteEvent[] = []

	events.push({
		tick: 0,
		event: { deltaTime: 0, meta: true, type: 'trackName', text: 'EVENTS' } as MidiEvent,
	})

	// Sections emit UNWRAPPED as `section name` (not `[section name]`). YARG's
	// NormalizeTextEvent strips content between the first `[` and first `]`,
	// which would lose data for names that contain `]`. Unwrapped form preserves
	// names with `]` and names starting with `[`. The only case that's inherently
	// lossy under YARG normalization is names containing both `[` and `]` —
	// those can't round-trip regardless of wrapping.
	for (const section of chart.sections) {
		events.push({
			tick: section.tick,
			event: { deltaTime: 0, meta: true, type: 'text', text: `section ${section.name}` } as MidiEvent,
		})
	}

	for (const endEvent of chart.endEvents) {
		events.push({
			tick: endEvent.tick,
			event: { deltaTime: 0, meta: true, type: 'text', text: '[end]' } as MidiEvent,
		})
	}

	// Global events (crowd events, music_start/end, coda, etc.). `.chart`
	// stores them unwrapped; `.mid` stores them bracket-wrapped. When the
	// source was `.chart`, wrap on output so the MIDI output follows convention.
	const sourceIsMidi = chart.format === 'mid'
	for (const ge of chart.unrecognizedEventsTrackTextEvents) {
		let text = ge.text
		if (!sourceIsMidi) {
			const trimmed = text.trimEnd()
			if (!(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
				text = `[${text}]`
			}
		}
		events.push({
			tick: ge.tick,
			event: { deltaTime: 0, meta: true, type: 'text', text } as MidiEvent,
		})
	}

	// Coda events: derive from drumFreestyleSections only if none already in
	// unrecognizedEventsTrackTextEvents. The parser splits [coda] into both
	// places, but we only need one.
	const hasCodaInGlobalEvents = chart.unrecognizedEventsTrackTextEvents.some(ge => {
		const trimmed = ge.text.trim()
		return trimmed === '[coda]' || trimmed === 'coda'
	})
	if (!hasCodaInGlobalEvents) {
		const codaTicks = new Set<number>()
		for (const track of chart.trackData) {
			for (const fs of track.drumFreestyleSections) {
				if (fs.isCoda) codaTicks.add(fs.tick)
			}
		}
		for (const tick of codaTicks) {
			events.push({
				tick,
				event: { deltaTime: 0, meta: true, type: 'text', text: '[coda]' } as MidiEvent,
			})
		}
	}

	return finalizeMidiTrack(events)
}

/**
 * Re-emit a parsed unrecognized track verbatim.
 *
 * Events arrive with `deltaTime = absolute tick` (scan-chart's
 * `convertToAbsoluteTime` post-processing). midi-file's writer expects delta
 * timing, so convert back here.
 *
 * If the input MIDI was malformed (non-monotonic absolute ticks → negative
 * deltas), midi-file's writeVarInt will throw. We let that bubble up so the
 * caller can record it as a per-chart failure rather than silently reorder
 * events to "fix" the malformed source.
 */
function buildUnrecognizedTrack(events: MidiEvent[]): MidiEvent[] {
	let prevTick = 0
	const out: MidiEvent[] = []
	for (const e of events) {
		const absTick = e.deltaTime
		out.push({ ...e, deltaTime: absTick - prevTick })
		prevTick = absTick
	}
	return out
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Sort events by absolute tick (with a type-priority tiebreaker) and convert
 * to delta-time encoding. Appends an `endOfTrack` meta event.
 *
 * Sort priority at the same tick: trackName → timeSignature → setTempo →
 * noteOff → sysEx → noteOn → text/lyrics → other → endOfTrack. This matches
 * Clone Hero's expected event ordering. Events with an explicit `seq` tag
 * sort AFTER untagged events at the same tick (so instrument-track emitters
 * can sequence paired events deterministically via `seq`).
 */
function finalizeMidiTrack(events: AbsoluteEvent[]): MidiEvent[] {
	const eventPriority = (e: MidiEvent): number => {
		switch (e.type) {
			case 'trackName': return 0
			case 'timeSignature': return 1
			case 'setTempo': return 2
			case 'noteOff': return 3
			case 'sysEx': case 'endSysEx': return 4
			case 'noteOn': return 5
			case 'text': case 'lyrics': return 6
			case 'endOfTrack': return 8
			default: return 7
		}
	}
	events.sort((a, b) => {
		if (a.tick !== b.tick) return a.tick - b.tick
		const aHasSeq = a.seq !== undefined
		const bHasSeq = b.seq !== undefined
		if (!aHasSeq && !bHasSeq) return eventPriority(a.event) - eventPriority(b.event)
		if (!aHasSeq) return -1
		if (!bHasSeq) return 1
		return (a.seq as number) - (b.seq as number)
	})

	let prevTick = 0
	const midiEvents: MidiEvent[] = []
	for (const { tick, event } of events) {
		event.deltaTime = tick - prevTick
		prevTick = tick
		midiEvents.push(event)
	}

	midiEvents.push({ deltaTime: 0, meta: true, type: 'endOfTrack' } as MidiEvent)
	return midiEvents
}

// ---------------------------------------------------------------------------
// Instrument → track name mapping
// ---------------------------------------------------------------------------

const instrumentTrackNames: Record<string, string> = {
	drums: 'PART DRUMS',
	guitar: 'PART GUITAR',
	guitarcoop: 'PART GUITAR COOP',
	rhythm: 'PART RHYTHM',
	bass: 'PART BASS',
	keys: 'PART KEYS',
	guitarghl: 'PART GUITAR GHL',
	guitarcoopghl: 'PART GUITAR COOP GHL',
	rhythmghl: 'PART RHYTHM GHL',
	bassghl: 'PART BASS GHL',
}

// ---------------------------------------------------------------------------
// Shared note / section helpers
// ---------------------------------------------------------------------------

/**
 * Monotonic counter used to seq-number zero-length noteOn/noteOff pairs so
 * their ordering survives `finalizeMidiTrack`'s event-priority sort. Without
 * explicit seq, the sort places noteOff BEFORE noteOn (noteOff has lower
 * priority), producing a bogus zero-length sequence that scan-chart re-parses
 * into extended sustains.
 */
let zeroLenSeq = 1_000_000

function addNoteOnOff(
	events: AbsoluteEvent[],
	tick: number,
	length: number,
	noteNumber: number,
	velocity: number,
	allowZeroLength = false,
): void {
	addNoteOnOffWithChannel(events, tick, length, noteNumber, velocity, 0, allowZeroLength)
}

function addNoteOnOffWithChannel(
	events: AbsoluteEvent[],
	tick: number,
	length: number,
	noteNumber: number,
	velocity: number,
	channel: number,
	allowZeroLength = false,
): void {
	const effectiveLength = allowZeroLength ? length : Math.max(length, 1)
	if (allowZeroLength && effectiveLength === 0) {
		const onSeq = zeroLenSeq++
		const offSeq = zeroLenSeq++
		events.push({
			tick,
			seq: onSeq,
			event: { deltaTime: 0, channel, type: 'noteOn', noteNumber, velocity } as MidiEvent,
		})
		events.push({
			tick,
			seq: offSeq,
			event: { deltaTime: 0, channel, type: 'noteOff', noteNumber, velocity: 0 } as MidiEvent,
		})
		return
	}
	events.push({
		tick,
		event: { deltaTime: 0, channel, type: 'noteOn', noteNumber, velocity } as MidiEvent,
	})
	events.push({
		tick: tick + effectiveLength,
		event: { deltaTime: 0, channel, type: 'noteOff', noteNumber, velocity: 0 } as MidiEvent,
	})
}

/** Dedupe by (tick, length) — source may carry multi-difficulty duplicates. */
function deduplicateSections<T extends { tick: number; length: number }>(sections: T[]): T[] {
	const seen = new Set<string>()
	const out: T[] = []
	for (const s of sections) {
		const key = `${s.tick}:${s.length}`
		if (!seen.has(key)) { seen.add(key); out.push(s) }
	}
	return out.sort((a, b) => a.tick - b.tick)
}

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
function buildDrumTrack(
	trackDataEntries: ParsedTrack[],
	chart: ParsedChart,
	trackName: string,
): MidiEvent[] {
	const events: AbsoluteEvent[] = []

	events.push({
		tick: 0,
		event: { deltaTime: 0, meta: true, type: 'trackName', text: trackName } as MidiEvent,
	})

	let hasAccentsOrGhosts = false
	const allStarPower: { tick: number; length: number }[] = []
	const allSolo: { tick: number; length: number }[] = []
	const allActivation: { tick: number; length: number }[] = []
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

	for (const td of trackDataEntries) {
		emitDrumNotes(events, td, chart, emittedTomMarker, emittedFlam, conflictedGreenTomTicks, hasAG => {
			if (hasAG) hasAccentsOrGhosts = true
		})

		// Collect instrument-wide sections (dedup after loop).
		for (const sp of td.starPowerSections) allStarPower.push(sp)
		for (const solo of td.soloSections) allSolo.push(solo)
		for (const fs of td.drumFreestyleSections) allActivation.push(fs)

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
				let text = te.text
				if (!sourceIsMidi) {
					const trimmed = text.trimEnd()
					if (!(trimmed.startsWith('[') && trimmed.endsWith(']'))) text = `[${text}]`
				}
				events.push({
					tick: te.tick,
					event: { deltaTime: 0, meta: true, type: 'text', text } as MidiEvent,
				})
			}
			// Per-track unrecognized MIDI events: absolute-tick deltaTime, seq-numbered
			// so they sort stably alongside other events at the same tick.
			let unrecSeq = 0
			const unrecSeqBase = 4_000_000_000
			for (const ev of td.unrecognizedMidiEvents) {
				events.push({
					tick: ev.deltaTime,
					seq: unrecSeqBase + unrecSeq++,
					event: { ...ev, deltaTime: 0 } as MidiEvent,
				})
			}
		}
	}

	// Instrument-wide sections. Preserve velocity/channel from source if the
	// parser attached them (MIDI-parsed sections carry raw MIDI properties).
	const soloNote = 103
	for (const sp of deduplicateSections(allStarPower)) {
		const vel = (sp as { velocity?: number }).velocity ?? 100
		const ch = (sp as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, sp.tick, sp.length, 116, vel, ch)
	}
	for (const solo of deduplicateSections(allSolo)) {
		const vel = (solo as { velocity?: number }).velocity ?? 100
		const ch = (solo as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, solo.tick, solo.length, soloNote, vel, ch)
	}
	for (const fs of deduplicateSections(allActivation)) {
		const vel = (fs as { velocity?: number }).velocity ?? 100
		const ch = (fs as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, fs.tick, fs.length, 120, vel, ch)
	}

	// Flex lanes (preserve length 0 — use seq to keep noteOn before noteOff).
	let flexSeq = 0
	for (const [key, velocity] of emittedFlexLane) {
		const [tickStr, lengthStr, noteStr] = key.split(':')
		const tick = Number(tickStr)
		const length = Number(lengthStr)
		const noteNumber = Number(noteStr)
		events.push({
			tick,
			seq: flexSeq++,
			event: { deltaTime: 0, channel: 0, type: 'noteOn', noteNumber, velocity } as MidiEvent,
		})
		events.push({
			tick: tick + length,
			seq: flexSeq++,
			event: { deltaTime: 0, channel: 0, type: 'noteOff', noteNumber, velocity: 0 } as MidiEvent,
		})
	}

	if (hasAccentsOrGhosts) {
		events.push({
			tick: 0,
			event: { deltaTime: 0, meta: true, type: 'text', text: '[ENABLE_CHART_DYNAMICS]' } as MidiEvent,
		})
	}

	// fourLanePro sentinel tom marker: if drumType=1 but no tom markers were
	// emitted (e.g. all yellow/blue defaulted to cymbal and green-toms used
	// the offset-5 encoding), scan-chart's drumType detection falls through
	// to fourLane. Emit a greenTomMarker at a tick where it attaches only to
	// non-affected notes (kick, red, or fiveGreenDrum — which are always tom).
	if (chart.drumType === 1 && emittedTomMarker.size === 0) {
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
		if (markerTick !== null) addNoteOnOff(events, markerTick, 1, 112, 100)
	}

	return finalizeMidiTrack(events)
}

/**
 * Precompute length overrides to prevent scan-chart's `trimSustains` from
 * collapsing short-sustain note chains. When N same-type drum notes are
 * directly adjacent (tick[i] + length[i] === tick[i+1]), we attribute the
 * combined chain length to the first note and set subsequent ones to 0 so
 * the trim threshold doesn't bite.
 */
function computeLengthOverrides(td: ParsedTrack): Map<string, number> {
	const overrides = new Map<string, number>()
	const byType = new Map<NoteType, { tick: number; length: number }[]>()
	for (const g of td.noteEventGroups) {
		for (const n of g) {
			let arr = byType.get(n.type)
			if (!arr) { arr = []; byType.set(n.type, arr) }
			arr.push({ tick: n.tick, length: n.length })
		}
	}
	for (const [type, notes] of byType) {
		notes.sort((a, b) => a.tick - b.tick)
		let i = 0
		while (i < notes.length) {
			let j = i
			let chainSum = notes[i].length
			while (j + 1 < notes.length
				&& notes[j].tick + notes[j].length === notes[j + 1].tick
				&& notes[j + 1].length > 0) {
				chainSum += notes[j + 1].length
				j++
			}
			if (j > i) {
				overrides.set(`${notes[i].tick}:${type}`, chainSum)
				for (let k = i + 1; k <= j; k++) overrides.set(`${notes[k].tick}:${type}`, 0)
			}
			i = j + 1
		}
	}
	return overrides
}

function emitDrumNotes(
	events: AbsoluteEvent[],
	td: ParsedTrack,
	chart: ParsedChart,
	emittedTomMarker: Set<string>,
	emittedFlam: Set<string>,
	conflictedGreenTomTicks: Set<number>,
	reportAccentGhost: (hasAG: boolean) => void,
): void {
	const base = drumsDiffStarts[td.difficulty]
	const diffIdx: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2, expert: 3 }
	const di = diffIdx[td.difficulty] ?? 3
	let currentDiscoState: 'off' | 'disco' | 'discoNoflip' = 'off'

	const drumType = chart.drumType
	const isFiveLaneTrack = drumType === 2
	const isFourLanePro = drumType === 1
	const offsetTable = isFiveLaneTrack ? drumNoteTypeToOffsetFiveLane : drumNoteTypeToOffset
	const lengthOverrides = computeLengthOverrides(td)

	for (const group of td.noteEventGroups) {
		let hasFlamInGroup = false

		// Disco flip state transitions → `[mix <diff> drums0[d|dnoflip]]` text events.
		if (group.length > 0) {
			let newState: 'off' | 'disco' | 'discoNoflip' = 'off'
			for (const note of group) {
				if (note.type === noteTypes.redDrum || note.type === noteTypes.yellowDrum) {
					if (note.flags & noteFlags.discoNoflip) { newState = 'discoNoflip'; break }
					if (note.flags & noteFlags.disco) { newState = 'disco'; break }
				}
			}
			if (newState !== currentDiscoState) {
				const suffix = newState === 'off' ? 'drums0' : newState === 'disco' ? 'drums0d' : 'drums0dnoflip'
				events.push({
					tick: group[0].tick,
					event: { deltaTime: 0, meta: true, type: 'text', text: `[mix ${di} ${suffix}]` } as MidiEvent,
				})
				currentDiscoState = newState
			}
		}

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
				addNoteOnOff(events, note.tick, emitLength, base - 1, velocity, true)
			} else {
				addNoteOnOff(events, note.tick, emitLength, base + offset, velocity, true)
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
