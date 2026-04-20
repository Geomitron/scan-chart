/**
 * MIDI binary writer — serializes a ParsedChart back to a Format-1 `.mid` file.
 *
 * This PR establishes the writer infrastructure:
 *   - `writeMidiFile` entry point
 *   - TEMPO TRACK (tempo + time-signature meta events)
 *   - EVENTS track (sections + end events + unrecognized global events + coda)
 *   - Unrecognized MIDI tracks (verbatim pass-through)
 *   - `finalizeMidiTrack` shared helper (sort + absolute→delta time conversion)
 *
 * Instrument tracks (PART DRUMS, PART GUITAR, etc.) and vocal tracks
 * (PART VOCALS, HARM1/2/3) are emitted by follow-up PRs.
 */

import type { MidiData, MidiEvent } from '@geomitron/midi-file'
import { writeMidi } from '@geomitron/midi-file'

import type { ParsedChart } from './parse-chart-and-ini'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A MIDI event tagged with its absolute tick (for sort-then-delta finalization). */
export interface AbsoluteEvent {
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
 *   N — Unrecognized MIDI tracks (verbatim pass-through)
 *
 * Instrument tracks (PART DRUMS, PART GUITAR, …) and vocal tracks
 * (PART VOCALS, HARM1/2/3) are emitted by follow-up PRs — this entry point
 * currently skips `chart.trackData` and `chart.vocalTracks`.
 */
export function writeMidiFile(chart: ParsedChart): Uint8Array {
	const trackMap = new Map<string, MidiEvent[]>()

	trackMap.set('TEMPO TRACK', buildTempoTrack(chart))
	trackMap.set('EVENTS', buildEventsTrack(chart))

	// Unrecognized whole tracks (VENUE, BEAT, PART REAL_*, custom tracks) are
	// round-tripped verbatim.
	let dupSuffix = 0
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
export function finalizeMidiTrack(events: AbsoluteEvent[]): MidiEvent[] {
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
