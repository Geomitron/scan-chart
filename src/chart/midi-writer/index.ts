/**
 * MIDI binary writer — serializes a ParsedChart back to a Format-1 `.mid` file.
 *
 * Output track layout:
 *   0 — TEMPO TRACK (BPM + time signatures)
 *   1 — EVENTS (sections, end events, global events, coda)
 *   N — Instrument tracks (PART DRUMS / GUITAR / GHL — one per group)
 *   N — Vocal tracks (PART VOCALS / HARM1 / HARM2 / HARM3)
 *   N — Unrecognized MIDI tracks (verbatim pass-through)
 */
import type { MidiData, MidiEvent } from '@geomitron/midi-file'
import { writeMidi } from '@geomitron/midi-file'

import type { Instrument } from '../../types'
import type { ParsedChart } from '../parse-chart-and-ini'
import { midiInstrumentTrackNames } from '../midi-track-names'
import { buildDrumTrack } from './drums'
import { buildEventsTrack, buildTempoTrack, buildUnrecognizedTrack } from './events'
import { buildFretTrack, fiveFretInstruments, sixFretInstruments } from './frets'
import type { MidiWriteOptions, ParsedTrack } from './shared'
import { buildVocalPartTrack } from './vocals'


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
export function writeMidiFile(chart: ParsedChart, options: MidiWriteOptions = {}): Uint8Array {
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
		const trackName = midiInstrumentTrackNames[td.instrument]
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
			trackMap.set(mapKey, buildDrumTrack(g.entries, chart, g.trackName, options))
		} else if (fiveFretInstruments.has(g.instrument) || sixFretInstruments.has(g.instrument)) {
			trackMap.set(mapKey, buildFretTrack(g.entries, chart, g.trackName, options))
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
	for (const ut of chart.unrecognized.midiTracks) {
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

/**
 * The sustain cutoff a `.mid` file of `chart` is read with, and whether song.ini must say so (r4 Q5). The writer ends
 * each note before the next note-on of its pitch, so a sustain reads back only if it's longer than the cutoff:
 * song.ini's, or else a third of a beat and a tick. When a sustain of the chart isn't, such as one the overlap step left
 * shorter than song.ini's cutoff, the cutoff becomes the shortest such sustain less a tick, which keeps every sustain.
 */
export function midiSustainCutoff(chart: ParsedChart, setCutoff: number): { value: number; write: boolean } {
	const readCutoff = setCutoff >= 0 ? setCutoff : Math.floor(chart.resolution / 3) + 1
	let shortest = Infinity
	for (const track of chart.trackData) {
		for (const group of track.noteEventGroups) {
			for (const note of group) if (note.length > 0 && note.length <= readCutoff && note.length < shortest) shortest = note.length
		}
	}
	return shortest === Infinity ? { value: readCutoff, write: false } : { value: shortest - 1, write: true }
}

// ---------------------------------------------------------------------------
// Instrument → track name mapping
// ---------------------------------------------------------------------------


// HARM1/2/3 (not PART HARM1/2/3) — matches the convention used by most MIDI
// chart files in the wild, including ones re-exported by YARG/ChartDump.
const vocalPartToTrackName: Record<string, string> = {
	vocals: 'PART VOCALS',
	harmony1: 'HARM1',
	harmony2: 'HARM2',
	harmony3: 'HARM3',
}
