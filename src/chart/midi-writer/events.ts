/**
 * EVENTS / TEMPO / unrecognized-track emission for the `.mid` writer.
 */
import type { MidiEvent } from '@geomitron/midi-file'

import type { ParsedChart } from '../parse-chart-and-ini'
import { codaTicksFromFreestyle, wrapEventBrackets } from '../writer-shared'
import { finalizeMidiTrack, metaTextEvent, trackNameEvent } from './shared'
import type { AbsoluteEvent } from './shared'


// ---------------------------------------------------------------------------
// Track builders
// ---------------------------------------------------------------------------

export function buildTempoTrack(chart: ParsedChart): MidiEvent[] {
	const events: AbsoluteEvent[] = []

	events.push({
		tick: 0,
		event: trackNameEvent('TEMPO TRACK'),
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

export function buildEventsTrack(chart: ParsedChart): MidiEvent[] {
	const events: AbsoluteEvent[] = []

	events.push({
		tick: 0,
		event: trackNameEvent('EVENTS'),
	})

	// Sections emit WRAPPED as `[section name]` to match the .chart writer and
	// the RBN/Rock Band MIDI convention. Moonscraper/Clone Hero require the
	// bracketed form (their reader matches the literal prefix `[section `) and
	// silently drop sections written as plain `section name`. YARG accepts both
	// forms via NormalizeTextEvent + TryParseSectionEvent. Names containing `]`
	// are still lossy under YARG normalization, but that's a rare edge case
	// compared to losing every section in CH for ordinary charts.
	for (const section of chart.sections) {
		events.push({
			tick: section.tick,
			event: metaTextEvent(`[section ${section.name}]`),
		})
	}

	for (const endEvent of chart.endEvents) {
		events.push({
			tick: endEvent.tick,
			event: metaTextEvent('[end]'),
		})
	}

	// Global events (crowd events, music_start/end, coda, etc.). `.chart`
	// stores them unwrapped; `.mid` stores them bracket-wrapped. When the
	// source was `.chart`, wrap on output so the MIDI output follows convention.
	const sourceIsMidi = chart.format === 'mid'
	for (const ge of chart.unrecognized.eventsTrackTextEvents) {
		// `.chart`-sourced events are stored unwrapped; emit them bracket-wrapped.
		const text = sourceIsMidi ? ge.text : wrapEventBrackets(ge.text)
		events.push({
			tick: ge.tick,
			event: metaTextEvent(text),
		})
	}

	// Coda events: derive from drumFreestyleSections only if none already in
	// the global text events. The parser splits [coda] into both places, but
	// we only need one.
	const hasCodaInGlobalEvents = chart.unrecognized.eventsTrackTextEvents.some(ge => {
		const trimmed = ge.text.trim()
		return trimmed === '[coda]' || trimmed === 'coda'
	})
	if (!hasCodaInGlobalEvents) {
		for (const tick of codaTicksFromFreestyle(chart.trackData)) {
			events.push({
				tick,
				event: metaTextEvent('[coda]'),
			})
		}
	}

	// Round-trip any non-text events that were on the EVENTS track in the
	// source `.mid` — most notably RB practice-mode assist sample notes
	// (note numbers 24/25/26), plus stray sysex / channel / meta events an
	// authoring tool happened to leave here. Events arrive with `deltaTime`
	// already expanded to absolute-tick (per scan-chart's post-process);
	// `finalizeMidiTrack` converts back to per-event delta below.
	for (const ev of chart.unrecognized.eventsTrackMidiEvents) {
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
 * A handful of real-world `.mid` files carry malformed passthrough tracks
 * (e.g. a `BEAT` track whose events are not in tick order). Naively
 * delta-encoding those produces negative deltas, which makes midi-file's
 * `writeVarInt` throw and fails the entire write. We stable-sort by absolute
 * tick first: the source was already malformed, and a monotonic re-encoding
 * that preserves same-tick ordering is strictly better than crashing. The sort
 * is a no-op for the common (already-monotonic) case.
 */
export function buildUnrecognizedTrack(events: MidiEvent[]): MidiEvent[] {
	// Stable sort by absolute tick (index tiebreaker keeps same-tick order,
	// which is load-bearing for noteOn/noteOff pairing).
	const ordered = events
		.map((event, index) => ({ event, index }))
		.sort((a, b) => a.event.deltaTime - b.event.deltaTime || a.index - b.index)

	let prevTick = 0
	const out: MidiEvent[] = []
	for (const { event } of ordered) {
		const absTick = event.deltaTime
		out.push({ ...event, deltaTime: absTick - prevTick })
		prevTick = absTick
	}
	return out
}
