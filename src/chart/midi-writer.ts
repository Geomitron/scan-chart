/**
 * MIDI binary writer — serializes a ParsedChart back to a Format-1 `.mid` file.
 *
 * Emits:
 *   - TEMPO TRACK (tempo + time-signature meta events)
 *   - EVENTS track (sections + end events + unrecognized global events + coda)
 *   - PART DRUMS / GUITAR / GHL instrument tracks
 *   - PART VOCALS / HARM1 / HARM2 / HARM3 vocal tracks
 *   - Unrecognized MIDI tracks (verbatim pass-through)
 */

import type { MidiData, MidiEvent } from '@geomitron/midi-file'
import { writeMidi } from '@geomitron/midi-file'

import type { Difficulty } from '../interfaces'
import { drumsDiffStarts, fiveFretDiffStarts, fiveFretLaneOffsets, sixFretDiffStarts, sixFretLaneOffsets } from './midi-note-numbers'
import { computeHopoThresholdTicks, isNaturalHopo } from './natural-hopo'
import type { NoteEvent, NoteType } from './note-parsing-interfaces'
import { noteFlags, noteTypes } from './note-parsing-interfaces'
import type { NormalizedVocalPart, NormalizedVocalTrack } from './note-parsing-interfaces'
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
 *   N — Instrument tracks (PART DRUMS / GUITAR / GHL — one per group)
 *   N — Vocal tracks (PART VOCALS / HARM1 / HARM2 / HARM3)
 *   N — Unrecognized MIDI tracks (verbatim pass-through)
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
		let mapKey = g.trackName
		while (trackMap.has(mapKey)) mapKey = `${g.trackName}__dup${dupSuffix++}`
		if (g.instrument === 'drums') {
			trackMap.set(mapKey, buildDrumTrack(g.entries, chart, g.trackName))
		} else if (fiveFretInstruments.has(g.instrument) || sixFretInstruments.has(g.instrument)) {
			trackMap.set(mapKey, buildFretTrack(g.entries, chart, g.trackName))
		}
	}

	// Vocal tracks (PART VOCALS / HARM1-3). Emission order matches the
	// canonical ordering so re-parse → re-write is byte-stable.
	const vocalTracks = chart.vocalTracks
	if (vocalTracks) {
		for (const partName of ['vocals', 'harmony1', 'harmony2', 'harmony3']) {
			const part = vocalTracks.parts[partName]
			if (!part) continue
			const trackName = vocalPartToTrackName[partName]
			let mapKey = trackName
			while (trackMap.has(mapKey)) mapKey = `${trackName}__dup${dupSuffix++}`
			trackMap.set(mapKey, buildVocalPartTrack(partName, part, vocalTracks, trackName))
		}
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

	// Round-trip any non-text events that were on the EVENTS track in the
	// source `.mid` — most notably RB practice-mode assist sample notes
	// (note numbers 24/25/26), plus stray sysex / channel / meta events an
	// authoring tool happened to leave here. Events arrive with `deltaTime`
	// already expanded to absolute-tick (per scan-chart's post-process);
	// `finalizeMidiTrack` converts back to per-event delta below.
	for (const ev of chart.unrecognizedEventsTrackMidiEvents) {
		events.push({ tick: ev.deltaTime, event: { ...ev, deltaTime: 0 } })
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

// HARM1/2/3 (not PART HARM1/2/3) — matches the convention used by most MIDI
// chart files in the wild, including ones re-exported by YARG/ChartDump.
const vocalPartToTrackName: Record<string, string> = {
	vocals: 'PART VOCALS',
	harmony1: 'HARM1',
	harmony2: 'HARM2',
	harmony3: 'HARM3',
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

const fiveFretInstruments = new Set<string>(['guitar', 'guitarcoop', 'rhythm', 'bass', 'keys'])
const sixFretInstruments = new Set<string>(['guitarghl', 'guitarcoopghl', 'rhythmghl', 'bassghl'])

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
function buildFretTrack(
	trackDataEntries: ParsedTrack[],
	chart: ParsedChart,
	trackName: string,
): MidiEvent[] {
	const events: AbsoluteEvent[] = []
	const instrument = trackDataEntries[0].instrument
	const isGhl = sixFretInstruments.has(instrument)
	const sourceIsMidi = chart.format === 'mid'

	events.push({
		tick: 0,
		event: { deltaTime: 0, meta: true, type: 'trackName', text: trackName } as MidiEvent,
	})

	const allStarPower: { tick: number; length: number }[] = []
	const allSolo: { tick: number; length: number }[] = []
	const allActivation: { tick: number; length: number }[] = []
	const emittedFlexLane = new Map<string, number>()

	// Use ENHANCED_OPENS mode when:
	//   (a) any group contains both an open note AND a non-open fret note
	//       (a chord-with-open) — the SysEx encoding can't represent these,
	//   (b) any open note's tick range overlaps a green note's tick range in
	//       the same difficulty — both encode to MIDI 96 under SysEx, and
	//       overlapping noteOn/noteOff pairs would re-pair wrong on parse,
	//       swapping sustain lengths.
	// Otherwise use forceOpen SysEx, which collapses chords-with-open into
	// single opens but avoids conflicts with animations at easy diffStart.
	const useEnhancedOpens = trackDataEntries.some(td => {
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

	const diffVelocity: Record<Difficulty, number> = { easy: 25, medium: 35, hard: 45, expert: 100 }

	for (const td of trackDataEntries) {
		if (isGhl) {
			emitFretNotes(events, td, sixFretDiffStarts, sixFretNoteTypeToOffset, animMap, useEnhancedOpens, animSeqMap)
		} else {
			emitFretNotes(events, td, fiveFretDiffStarts, fiveFretNoteTypeToOffset, animMap, useEnhancedOpens, animSeqMap)
		}

		for (const sp of td.starPowerSections) allStarPower.push(sp)
		for (const solo of td.soloSections) allSolo.push(solo)
		// BRE / coda activation (MIDI 120) — fret tracks support this in
		// addition to drums.
		for (const fs of td.drumFreestyleSections) allActivation.push(fs)

		for (const fl of td.flexLanes) {
			const note = fl.isDouble ? 127 : 126
			const key = `${fl.tick}:${fl.length}:${note}`
			const thisVel = diffVelocity[td.difficulty] ?? 100
			const existing = emittedFlexLane.get(key)
			if (existing === undefined || thisVel < existing) emittedFlexLane.set(key, thisVel)
		}

		// First-difficulty extras: text events, versus phrases, animations,
		// per-track unrecognizedMidiEvents. scan-chart populates these
		// identically on all 4 difficulties; writing once avoids duplicates.
		if (td === firstTd) {
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

			let vpSeq = 0
			for (const vp of td.versusPhrases) {
				const note = vp.isPlayer2 ? 106 : 105
				events.push({
					tick: vp.tick,
					seq: vpSeq++,
					event: { deltaTime: 0, channel: 0, type: 'noteOn', noteNumber: note, velocity: 100 } as MidiEvent,
				})
				events.push({
					tick: vp.tick + vp.length,
					seq: vpSeq++,
					event: { deltaTime: 0, channel: 0, type: 'noteOff', noteNumber: note, velocity: 0 } as MidiEvent,
				})
			}

			// Animations: emit note-pair per animation unless the same
			// (tick, noteNumber) was already emitted by a fret note above (in
			// which case emitFretNotes coalesced the pair with the animation's
			// seq — no duplicate noteOn at this tick:noteNumber).
			const emittedNoteKeys = new Set<string>()
			const diffStarts2 = isGhl ? sixFretDiffStarts : fiveFretDiffStarts
			const offsetMap = isGhl ? sixFretNoteTypeToOffset : fiveFretNoteTypeToOffset
			for (const otherTd of trackDataEntries) {
				const diffStart = diffStarts2[otherTd.difficulty]
				for (const group of otherTd.noteEventGroups) {
					for (const n of group) {
						let noteNum: number
						if (n.type === noteTypes.open) {
							noteNum = useEnhancedOpens ? diffStart + 0 : diffStart + 1
						} else {
							const off = offsetMap[n.type]
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
					event: { deltaTime: 0, channel: 0, type: 'noteOn', noteNumber: anim.noteNumber, velocity: 100 } as MidiEvent,
				})
				events.push({
					tick: anim.tick + anim.length,
					seq: offSeq,
					event: { deltaTime: 0, channel: 0, type: 'noteOff', noteNumber: anim.noteNumber, velocity: 0 } as MidiEvent,
				})
			}

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

	// Instrument-wide sections. Star power = 116, solo = 103, BRE/coda = 120.
	for (const sp of deduplicateSections(allStarPower)) {
		const vel = (sp as { velocity?: number }).velocity ?? 100
		const ch = (sp as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, sp.tick, sp.length, 116, vel, ch)
	}
	for (const solo of deduplicateSections(allSolo)) {
		const vel = (solo as { velocity?: number }).velocity ?? 100
		const ch = (solo as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, solo.tick, solo.length, 103, vel, ch)
	}
	for (const fs of deduplicateSections(allActivation)) {
		const vel = (fs as { velocity?: number }).velocity ?? 100
		const ch = (fs as { channel?: number }).channel ?? 0
		addNoteOnOffWithChannel(events, fs.tick, fs.length, 120, vel, ch)
	}
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

	emitFretModifierRanges(events, trackDataEntries, isGhl, chart)

	if (useEnhancedOpens) {
		events.push({
			tick: 0,
			event: { deltaTime: 0, meta: true, type: 'text', text: '[ENHANCED_OPENS]' } as MidiEvent,
		})
	}

	return finalizeMidiTrack(events)
}

function emitFretNotes(
	events: AbsoluteEvent[],
	td: ParsedTrack,
	diffStarts: Record<Difficulty, number>,
	noteTypeToOffset: Partial<Record<NoteType, number>>,
	animMap: Map<string, number>,
	useEnhancedOpens: boolean,
	animSeqMap: Map<string, { onSeq: number; offSeq: number }>,
): void {
	const diffStart = diffStarts[td.difficulty]
	// Fret notes whose MIDI number would fall in the animation range (40-59)
	// skip the length-chain override — inflating their length would absorb the
	// corresponding animation pairing on re-parse.
	const lengthOverrides = computeLengthOverrides(td)
	const ANIMATION_NOTE_MIN = 40
	const ANIMATION_NOTE_MAX = 59

	const emitWithAnimSeq = (tick: number, length: number, noteNum: number): void => {
		const animSeqs = animSeqMap.get(`${tick}:${noteNum}`)
		if (!animSeqs) {
			addNoteOnOff(events, tick, length, noteNum, 100, true)
			return
		}
		const effectiveLength = Math.max(length, 1)
		events.push({
			tick,
			seq: animSeqs.onSeq,
			event: { deltaTime: 0, channel: 0, type: 'noteOn', noteNumber: noteNum, velocity: 100 } as MidiEvent,
		})
		events.push({
			tick: tick + effectiveLength,
			seq: animSeqs.offSeq,
			event: { deltaTime: 0, channel: 0, type: 'noteOff', noteNumber: noteNum, velocity: 0 } as MidiEvent,
		})
	}

	for (const group of td.noteEventGroups) {
		for (const note of group) {
			const offsetForOverride = note.type === noteTypes.open
				? (useEnhancedOpens ? 0 : 1)
				: (noteTypeToOffset[note.type] ?? 0)
			const noteNumForOverride = diffStart + offsetForOverride
			const inAnimationRange = noteNumForOverride >= ANIMATION_NOTE_MIN && noteNumForOverride <= ANIMATION_NOTE_MAX
			const baseLen = inAnimationRange
				? note.length
				: (lengthOverrides.get(`${note.tick}:${note.type}`) ?? note.length)

			if (note.type === noteTypes.open) {
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
		tick: tick + Math.max(length, 1),
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
		for (const range of reconstructModifierRanges(tapTicks, noteTicksInOrder)) {
			addSysExOnOff(events, range.tick, range.length, sysExDiffMap[difficulty], 0x04)
		}
	}
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

// ---------------------------------------------------------------------------
// Vocal tracks (PART VOCALS / HARM1 / HARM2 / HARM3)
// ---------------------------------------------------------------------------

/**
 * Build a PART VOCALS / HARM1-3 MIDI track from normalized vocal data.
 *
 * scan-chart separates note 105 (scoring phrases → `notePhrases`) from note 106
 * (static lyric phrases → `staticLyricPhrases`) at parse time. YARG's
 * CopyDownPhrases copies HARM1's `notePhrases` onto HARM2/HARM3 at parse
 * time — to avoid re-emitting those copies and double-counting on re-parse:
 *
 *   - PART VOCALS emits `notePhrases` at note 105 / 106 (player field decides)
 *   - HARM1 emits `notePhrases` as note 105, `staticLyricPhrases` as note 106
 *   - HARM2 emits only `staticLyricPhrases` as note 106 (note 105 comes from
 *     HARM1 via CopyDown on re-parse)
 *   - HARM3 emits no phrase markers at all
 *
 * Lyric and note events are union'd across both phrase sets (note 105 and
 * 106 can have different boundaries, so a lyric/note may appear in only one
 * set but still needs to be emitted).
 *
 * Zero-length vocal notes are preserved via per-event `seq` tags so
 * `finalizeMidiTrack` keeps noteOn immediately before its matching noteOff.
 *
 * Range shifts (note 0) and lyric shifts (note 1) are per-part for lossless
 * round-trip — PART VOCALS and HARM1 often have distinct marker sets.
 */
function buildVocalPartTrack(
	partName: string,
	part: NormalizedVocalPart,
	vocalTracks: NormalizedVocalTrack,
	trackName: string,
): MidiEvent[] {
	const events: AbsoluteEvent[] = []

	events.push({
		tick: 0,
		event: { deltaTime: 0, meta: true, type: 'trackName', text: trackName } as MidiEvent,
	})

	const isHarm3 = partName === 'harmony3'
	const isHarm2 = partName === 'harmony2'
	const isPartVocals = partName === 'vocals'

	// Phrase markers.
	if (isHarm3) {
		// no-op: all phrases come from CopyDown on re-parse.
	} else if (isHarm2) {
		for (const phrase of part.staticLyricPhrases) {
			addNoteOnOff(events, phrase.tick, Math.max(phrase.length, 1), 106, 100)
		}
	} else if (isPartVocals) {
		for (const phrase of part.notePhrases) {
			const noteNumber = phrase.player === 2 ? 106 : 105
			addNoteOnOff(events, phrase.tick, Math.max(phrase.length, 1), noteNumber, 100)
		}
	} else {
		// harmony1
		for (const phrase of part.notePhrases) {
			addNoteOnOff(events, phrase.tick, Math.max(phrase.length, 1), 105, 100)
		}
		for (const phrase of part.staticLyricPhrases) {
			addNoteOnOff(events, phrase.tick, Math.max(phrase.length, 1), 106, 100)
		}
	}

	// Union lyrics across notePhrases + staticLyricPhrases (different phrase
	// boundaries can place the same lyric in only one set — emitting the union
	// preserves all lyrics on the track).
	const seenLyricKeys = new Set<string>()
	const allLyrics: { tick: number; text: string }[] = []
	for (const phrases of [part.notePhrases, part.staticLyricPhrases]) {
		for (const phrase of phrases) {
			for (const lyric of phrase.lyrics) {
				const key = `${lyric.tick}:${lyric.text}`
				if (!seenLyricKeys.has(key)) {
					seenLyricKeys.add(key)
					allLyrics.push(lyric)
				}
			}
		}
	}
	allLyrics.sort((a, b) => a.tick - b.tick)
	for (const lyric of allLyrics) {
		events.push({
			tick: lyric.tick,
			event: { deltaTime: 0, meta: true, type: 'lyrics', text: lyric.text } as MidiEvent,
		})
	}

	// Union notes across the same two phrase sets.
	const seenNoteKeys = new Set<string>()
	const allNotes: { tick: number; length: number; pitch: number; type: 'pitched' | 'percussion' }[] = []
	for (const phrases of [part.notePhrases, part.staticLyricPhrases]) {
		for (const phrase of phrases) {
			for (const note of phrase.notes) {
				const key = `${note.tick}:${note.pitch}:${note.length}`
				if (!seenNoteKeys.has(key)) {
					seenNoteKeys.add(key)
					allNotes.push(note)
				}
			}
		}
	}
	allNotes.sort((a, b) => a.tick - b.tick)

	let vocalNoteSeq = 1_000_000
	for (const note of allNotes) {
		const midiPitch = note.type === 'pitched'
			? (note.pitch >= 36 && note.pitch <= 84 ? note.pitch : 60)
			: 96
		events.push({
			tick: note.tick,
			seq: vocalNoteSeq++,
			event: { deltaTime: 0, channel: 0, type: 'noteOn', noteNumber: midiPitch, velocity: 100 } as MidiEvent,
		})
		events.push({
			tick: note.tick + note.length,
			seq: vocalNoteSeq++,
			event: { deltaTime: 0, channel: 0, type: 'noteOff', noteNumber: midiPitch, velocity: 0 } as MidiEvent,
		})
	}

	// Star power sections → note 116. HARM2/HARM3 starPowerSections are also
	// copied from HARM1 by CopyDown on re-parse, so only HARM1 / PART VOCALS
	// need to emit them.
	if (!isHarm2 && !isHarm3) {
		for (const sp of part.starPowerSections) {
			addNoteOnOff(events, sp.tick, Math.max(sp.length, 1), 116, 100)
		}
	}

	// Vocal-track text events (stance markers, Band_PlayFacialAnim, etc.).
	// YARG marks a VocalsPart non-empty iff it has phrases or text events, so
	// emitting these is required for round-tripping stance-only tracks.
	for (const te of part.textEvents) {
		events.push({
			tick: te.tick,
			event: { deltaTime: 0, meta: true, type: 'text', text: te.text } as MidiEvent,
		})
	}

	// Per-part range shifts (note 0) and lyric shifts (note 1). Fall back to
	// the track-level arrays only if the per-part arrays are empty and this
	// part owns the track-level data (PART VOCALS, or HARM1 when PART VOCALS
	// is absent). YARG's GetRangeShifts reads these markers per-track.
	const partOwnsTrackLevel =
		partName === 'vocals' || (partName === 'harmony1' && !vocalTracks.parts.vocals)

	if (part.rangeShifts.length > 0) {
		for (const rs of part.rangeShifts) {
			addNoteOnOff(events, rs.tick, Math.max(rs.length, 1), 0, 100)
		}
	} else if (partOwnsTrackLevel) {
		for (const rs of vocalTracks.rangeShifts) {
			addNoteOnOff(events, rs.tick, Math.max(rs.length, 1), 0, 100)
		}
	}

	if (part.lyricShifts.length > 0) {
		for (const ls of part.lyricShifts) {
			addNoteOnOff(events, ls.tick, Math.max(ls.length, 1), 1, 100)
		}
	} else if (partOwnsTrackLevel) {
		for (const ls of vocalTracks.lyricShifts) {
			addNoteOnOff(events, ls.tick, Math.max(ls.length, 1), 1, 100)
		}
	}

	return finalizeMidiTrack(events)
}
