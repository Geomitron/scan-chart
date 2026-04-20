/**
 * Tests for writeMidiFile: header + TEMPO TRACK + EVENTS + unrecognized tracks.
 * Instrument/vocal track tests land with the follow-up PRs that port their
 * respective emitters.
 */

import { parseMidi } from 'midi-file'
import type { MidiEvent } from 'midi-file'
import { describe, expect, it } from 'vitest'

import { createEmptyChart } from '../chart/create-chart'
import { writeMidiFile } from '../chart/midi-writer'
import { parseChartAndIni } from '../chart/parse-chart-and-ini'

function parseBack(bytes: Uint8Array) {
	return parseMidi(bytes)
}

function findEvents(track: MidiEvent[], type: string): MidiEvent[] {
	return track.filter(e => e.type === type)
}

describe('writeMidiFile: header', () => {
	it('produces a Format 1 MIDI with the chart resolution', () => {
		const chart = createEmptyChart({ resolution: 480 })
		const midi = parseBack(writeMidiFile(chart))
		expect(midi.header.format).toBe(1)
		expect(midi.header.ticksPerBeat).toBe(480)
	})

	it('produces 2 tracks (TEMPO + EVENTS) for an empty chart', () => {
		const chart = createEmptyChart()
		const midi = parseBack(writeMidiFile(chart))
		expect(midi.header.numTracks).toBe(2)
		expect(midi.tracks.length).toBe(2)
	})
})

describe('writeMidiFile: TEMPO TRACK', () => {
	it('emits a trackName="TEMPO TRACK" at tick 0', () => {
		const chart = createEmptyChart()
		const midi = parseBack(writeMidiFile(chart))
		const names = findEvents(midi.tracks[0], 'trackName')
		expect(names).toHaveLength(1)
		expect((names[0] as { text: string }).text).toBe('TEMPO TRACK')
	})

	it('emits setTempo with the right microsecondsPerBeat (120 BPM = 500000)', () => {
		const chart = createEmptyChart({ bpm: 120 })
		const midi = parseBack(writeMidiFile(chart))
		const tempos = findEvents(midi.tracks[0], 'setTempo')
		expect(tempos).toHaveLength(1)
		expect((tempos[0] as { microsecondsPerBeat: number }).microsecondsPerBeat).toBe(500_000)
	})

	it('rounds setTempo microsecondsPerBeat from non-integer BPM', () => {
		const chart = createEmptyChart({ bpm: 137.5 })
		const midi = parseBack(writeMidiFile(chart))
		const tempos = findEvents(midi.tracks[0], 'setTempo')
		// 60_000_000 / 137.5 = 436363.6363... → 436364
		expect((tempos[0] as { microsecondsPerBeat: number }).microsecondsPerBeat).toBe(436_364)
	})

	it('emits a timeSignature with the chart TS', () => {
		const chart = createEmptyChart({ timeSignature: { numerator: 6, denominator: 8 } })
		const midi = parseBack(writeMidiFile(chart))
		const ts = findEvents(midi.tracks[0], 'timeSignature')
		expect(ts).toHaveLength(1)
		expect(ts[0]).toMatchObject({ numerator: 6, denominator: 8 })
	})

	it('emits multiple tempo changes at their ticks', () => {
		const chart = createEmptyChart({ resolution: 480, bpm: 120 })
		chart.tempos.push({ tick: 960, beatsPerMinute: 180, msTime: 0 })
		const midi = parseBack(writeMidiFile(chart))
		const tempos = findEvents(midi.tracks[0], 'setTempo')
		expect(tempos).toHaveLength(2)
		// deltaTime of first tempo is 0, second is 960 (relative to first).
		expect(tempos[0].deltaTime).toBe(0)
		expect(tempos[1].deltaTime).toBe(960)
	})

	it('round-trips through parseChartAndIni', () => {
		const chart = createEmptyChart({ resolution: 480, bpm: 140, timeSignature: { numerator: 7, denominator: 8 } })
		chart.tempos.push({ tick: 1920, beatsPerMinute: 90, msTime: 0 })
		const re = parseChartAndIni([{ fileName: 'notes.mid', data: writeMidiFile(chart) }])
		const reChart = re.parsedChart!
		expect(reChart.tempos.map(t => ({ tick: t.tick, bpm: Math.round(t.beatsPerMinute) }))).toEqual([
			{ tick: 0, bpm: 140 },
			{ tick: 1920, bpm: 90 },
		])
		expect(reChart.timeSignatures.map(ts => ({ tick: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
			{ tick: 0, n: 7, d: 8 },
		])
	})
})

describe('writeMidiFile: EVENTS track', () => {
	it('emits a trackName="EVENTS" at tick 0', () => {
		const chart = createEmptyChart()
		const midi = parseBack(writeMidiFile(chart))
		const names = findEvents(midi.tracks[1], 'trackName')
		expect(names).toHaveLength(1)
		expect((names[0] as { text: string }).text).toBe('EVENTS')
	})

	it('emits sections as unwrapped `section name` text meta events', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: 'Intro', msTime: 0, msLength: 0 })
		chart.sections.push({ tick: 1920, name: 'Verse 1', msTime: 0, msLength: 0 })
		const midi = parseBack(writeMidiFile(chart))
		const texts = findEvents(midi.tracks[1], 'text').map(e => (e as { text: string }).text)
		expect(texts).toContain('section Intro')
		expect(texts).toContain('section Verse 1')
	})

	it('emits [end] text events for endEvents', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 9600, msTime: 0, msLength: 0 })
		const midi = parseBack(writeMidiFile(chart))
		const texts = findEvents(midi.tracks[1], 'text').map(e => (e as { text: string }).text)
		expect(texts).toContain('[end]')
	})

	it('passes MIDI-sourced unrecognizedEvents verbatim (preserves brackets)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.unrecognizedEvents.push({ tick: 480, text: '[crowd_noclap]', msTime: 0, msLength: 0 })
		const midi = parseBack(writeMidiFile(chart))
		const texts = findEvents(midi.tracks[1], 'text').map(e => (e as { text: string }).text)
		expect(texts).toContain('[crowd_noclap]')
	})

	it('wraps chart-sourced unrecognizedEvents in brackets on MIDI output', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.unrecognizedEvents.push({ tick: 480, text: 'music_start', msTime: 0, msLength: 0 })
		const midi = parseBack(writeMidiFile(chart))
		const texts = findEvents(midi.tracks[1], 'text').map(e => (e as { text: string }).text)
		expect(texts).toContain('[music_start]')
	})

	it('round-trips sections with special characters', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: '[BREAKDOWN]', msTime: 0, msLength: 0 })
		const re = parseChartAndIni([{ fileName: 'notes.mid', data: writeMidiFile(chart) }])
		// YARG normalization would strip the outer brackets from a wrapped form;
		// we emit unwrapped so the `]` in the name survives (though leading `[`
		// is still lost — that's a YARG-normalization issue, not writer).
		expect(re.parsedChart!.sections).toHaveLength(1)
	})

	it('round-trips end events through parseChartAndIni', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 1920, msTime: 0, msLength: 0 })
		const re = parseChartAndIni([{ fileName: 'notes.mid', data: writeMidiFile(chart) }])
		expect(re.parsedChart!.endEvents.map(e => e.tick)).toEqual([1920])
	})
})

describe('writeMidiFile: unrecognized MIDI tracks', () => {
	it('preserves unrecognized tracks verbatim', () => {
		const chart = createEmptyChart()
		// Craft a minimal VENUE track: trackName + one text event + endOfTrack.
		// Events arrive at the writer with deltaTime = absolute tick (per
		// scan-chart's convertToAbsoluteTime post-processing).
		chart.unrecognizedMidiTracks.push({
			trackName: 'VENUE',
			events: [
				{ deltaTime: 0, meta: true, type: 'trackName', text: 'VENUE' } as MidiEvent,
				{ deltaTime: 480, meta: true, type: 'text', text: '[lighting (verse)]' } as MidiEvent,
				{ deltaTime: 480, meta: true, type: 'endOfTrack' } as MidiEvent,
			],
		})
		const midi = parseBack(writeMidiFile(chart))
		expect(midi.tracks).toHaveLength(3) // TEMPO + EVENTS + VENUE
		const venue = midi.tracks[2]
		const venueText = findEvents(venue, 'text').map(e => (e as { text: string }).text)
		expect(venueText).toContain('[lighting (verse)]')
	})

	it('round-trips unrecognized tracks through parseChartAndIni', () => {
		const chart = createEmptyChart()
		chart.unrecognizedMidiTracks.push({
			trackName: 'CUSTOM',
			events: [
				{ deltaTime: 0, meta: true, type: 'trackName', text: 'CUSTOM' } as MidiEvent,
				{ deltaTime: 240, meta: true, type: 'text', text: 'hello' } as MidiEvent,
				{ deltaTime: 240, meta: true, type: 'endOfTrack' } as MidiEvent,
			],
		})
		const re = parseChartAndIni([{ fileName: 'notes.mid', data: writeMidiFile(chart) }])
		expect(re.parsedChart!.unrecognizedMidiTracks.map(t => t.trackName)).toEqual(['CUSTOM'])
	})

	it('suffixes duplicate track names so trackMap keys stay unique', () => {
		const chart = createEmptyChart()
		for (let i = 0; i < 3; i++) {
			chart.unrecognizedMidiTracks.push({
				trackName: 'CUSTOM',
				events: [
					{ deltaTime: 0, meta: true, type: 'trackName', text: 'CUSTOM' } as MidiEvent,
					{ deltaTime: 0, meta: true, type: 'endOfTrack' } as MidiEvent,
				],
			})
		}
		// Should not throw despite duplicate trackName; all 3 tracks survive.
		const midi = parseBack(writeMidiFile(chart))
		expect(midi.tracks).toHaveLength(5) // TEMPO + EVENTS + 3 CUSTOM
	})
})

// ---------------------------------------------------------------------------
// Drum track tests
// ---------------------------------------------------------------------------

import type { ParsedChart } from '../chart/parse-chart-and-ini'
import { noteFlags, noteTypes } from '../chart/note-parsing-interfaces'

function emptyDrumTrack(
	difficulty: 'expert' | 'hard' | 'medium' | 'easy' = 'expert',
): ParsedChart['trackData'][number] {
	return {
		instrument: 'drums',
		difficulty,
		starPowerSections: [],
		rejectedStarPowerSections: [],
		soloSections: [],
		flexLanes: [],
		drumFreestyleSections: [],
		textEvents: [],
		versusPhrases: [],
		animations: [],
		unrecognizedMidiEvents: [],
		noteEventGroups: [],
	}
}

function note(tick: number, type: number, flags = 0, length = 0) {
	return { tick, type, flags, length, msTime: 0, msLength: 0 }
}

function findNoteOns(track: MidiEvent[], noteNumber: number): MidiEvent[] {
	return track.filter(e => e.type === 'noteOn' && (e as { noteNumber: number }).noteNumber === noteNumber)
}

describe('writeMidiFile: PART DRUMS track layout', () => {
	it('emits a PART DRUMS track when the chart has a drum track', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.trackData.push(emptyDrumTrack('expert'))
		const midi = parseBack(writeMidiFile(chart))
		const drumTrack = midi.tracks[2]
		const names = findEvents(drumTrack, 'trackName')
		expect((names[0] as { text: string }).text).toBe('PART DRUMS')
	})

	it('groups all drum difficulties into a single MIDI track', () => {
		const chart = createEmptyChart({ format: 'mid' })
		for (const d of ['expert', 'hard', 'medium', 'easy'] as const) {
			chart.trackData.push(emptyDrumTrack(d))
		}
		const midi = parseBack(writeMidiFile(chart))
		// 2 setup tracks + 1 PART DRUMS.
		expect(midi.tracks).toHaveLength(3)
	})
})

describe('writeMidiFile: drum note-number mapping', () => {
	it('expert kick → MIDI 96; red → 97; yellow → 98; blue → 99; green → 100', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick)])
		td.noteEventGroups.push([note(120, noteTypes.redDrum)])
		td.noteEventGroups.push([note(240, noteTypes.yellowDrum)])
		td.noteEventGroups.push([note(360, noteTypes.blueDrum)])
		td.noteEventGroups.push([note(480, noteTypes.greenDrum)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 96)).toHaveLength(1)
		expect(findNoteOns(drumTrack, 97)).toHaveLength(1)
		expect(findNoteOns(drumTrack, 98)).toHaveLength(1)
		expect(findNoteOns(drumTrack, 99)).toHaveLength(1)
		expect(findNoteOns(drumTrack, 100)).toHaveLength(1)
	})

	it('hard base is MIDI 84 (drumDiffBases.hard)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('hard')
		td.noteEventGroups.push([note(0, noteTypes.kick)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 84)).toHaveLength(1)
	})

	it('double-kick flag emits MIDI 95 only (no MIDI 96)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick, noteFlags.doubleKick)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 95)).toHaveLength(1)
		expect(findNoteOns(drumTrack, 96)).toHaveLength(0)
	})

	it('regular kick emits BEFORE double kick at the same tick', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([
			note(0, noteTypes.kick, noteFlags.doubleKick),
			note(0, noteTypes.kick),
		])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		const noteOns = drumTrack.filter(e => e.type === 'noteOn' && ((e as { noteNumber: number }).noteNumber === 95 || (e as { noteNumber: number }).noteNumber === 96))
		expect(noteOns.map(e => (e as { noteNumber: number }).noteNumber)).toEqual([96, 95])
	})
})

describe('writeMidiFile: drum velocity (accent/ghost)', () => {
	it('accent flag → velocity 127', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.accent)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		const noteOn = findNoteOns(drumTrack, 97)[0]
		expect((noteOn as { velocity: number }).velocity).toBe(127)
	})

	it('ghost flag → velocity 1', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.ghost)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		const noteOn = findNoteOns(drumTrack, 97)[0]
		expect((noteOn as { velocity: number }).velocity).toBe(1)
	})

	it('plain note (no accent/ghost) → velocity 100', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.redDrum)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		const noteOn = findNoteOns(drumTrack, 97)[0]
		expect((noteOn as { velocity: number }).velocity).toBe(100)
	})

	it('any accent/ghost emits [ENABLE_CHART_DYNAMICS] text event at tick 0', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.accent)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		const texts = findEvents(drumTrack, 'text').map(e => (e as { text: string }).text)
		expect(texts).toContain('[ENABLE_CHART_DYNAMICS]')
	})
})

describe('writeMidiFile: tom markers (fourLanePro)', () => {
	it('emits MIDI 110/111/112 tom markers for yellow/blue/green with tom flag', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.drumType = 1 // fourLanePro
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.yellowDrum, noteFlags.tom)])
		td.noteEventGroups.push([note(120, noteTypes.blueDrum, noteFlags.tom)])
		td.noteEventGroups.push([note(240, noteTypes.greenDrum, noteFlags.tom)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 110)).toHaveLength(1)
		expect(findNoteOns(drumTrack, 111)).toHaveLength(1)
		expect(findNoteOns(drumTrack, 112)).toHaveLength(1)
	})

	it('does NOT emit tom markers when drumType is fourLane (no cymbals)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.drumType = 0 // fourLane
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.yellowDrum, noteFlags.tom)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 110)).toHaveLength(0)
	})

	it('fourLanePro with no tom markers emits a sentinel greenTomMarker', () => {
		// All yellow/blue default cymbal (no tom flag) and no green — so no
		// per-note tom markers. Chart is fourLanePro, so we need a sentinel at
		// a tick safe to mark.
		const chart = createEmptyChart({ format: 'mid' })
		chart.drumType = 1
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick)])              // safe
		td.noteEventGroups.push([note(480, noteTypes.yellowDrum, noteFlags.cymbal)])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 112)).toHaveLength(1)
	})
})

describe('writeMidiFile: flam', () => {
	it('emits one MIDI 109 flam marker per group regardless of notes', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([
			note(0, noteTypes.redDrum, noteFlags.flam),
			note(0, noteTypes.yellowDrum, noteFlags.flam),
		])
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 109)).toHaveLength(1)
	})
})

describe('writeMidiFile: drum instrument-wide sections', () => {
	it('emits star power as MIDI 116', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.starPowerSections.push({ tick: 0, length: 1920, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 116)).toHaveLength(1)
	})

	it('emits solo sections as MIDI 103', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.soloSections.push({ tick: 0, length: 480, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 103)).toHaveLength(1)
	})

	it('emits activation/coda lanes as MIDI 120', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.drumFreestyleSections.push({ tick: 0, length: 480, isCoda: false, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 120)).toHaveLength(1)
	})

	it('emits flex lanes as MIDI 126 (single) / 127 (double)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.flexLanes.push({ tick: 0, length: 480, isDouble: false, msTime: 0, msLength: 0 })
		td.flexLanes.push({ tick: 480, length: 480, isDouble: true, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const drumTrack = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(drumTrack, 126)).toHaveLength(1)
		expect(findNoteOns(drumTrack, 127)).toHaveLength(1)
	})
})

describe('writeMidiFile: drum round-trip through parseChartAndIni', () => {
	it('round-trips base drum notes in fourLanePro', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		chart.drumType = 1
		chart.iniChartModifiers.pro_drums = true
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick)])
		td.noteEventGroups.push([note(480, noteTypes.redDrum)])
		td.noteEventGroups.push([note(960, noteTypes.yellowDrum, noteFlags.cymbal)])
		td.noteEventGroups.push([note(1440, noteTypes.blueDrum)])
		td.noteEventGroups.push([note(1920, noteTypes.greenDrum, noteFlags.cymbal)])
		chart.trackData.push(td)

		const re = parseChartAndIni([
			{ fileName: 'notes.mid', data: writeMidiFile(chart) },
			{ fileName: 'song.ini', data: new TextEncoder().encode('[Song]\npro_drums = True\n') },
		])
		const reTrack = re.parsedChart!.trackData.find(t => t.instrument === 'drums' && t.difficulty === 'expert')!
		const types = reTrack.noteEventGroups.flatMap(g => g.map(n => ({ tick: n.tick, type: n.type })))
		expect(types).toEqual([
			{ tick: 0, type: noteTypes.kick },
			{ tick: 480, type: noteTypes.redDrum },
			{ tick: 960, type: noteTypes.yellowDrum },
			{ tick: 1440, type: noteTypes.blueDrum },
			{ tick: 1920, type: noteTypes.greenDrum },
		])
	})

	it('round-trips accent / ghost / flam / doubleKick flags on drum notes', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		chart.drumType = 1
		chart.iniChartModifiers.pro_drums = true
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick, noteFlags.doubleKick)])
		td.noteEventGroups.push([note(480, noteTypes.redDrum, noteFlags.accent)])
		td.noteEventGroups.push([note(960, noteTypes.yellowDrum, noteFlags.ghost)])
		td.noteEventGroups.push([note(1440, noteTypes.redDrum, noteFlags.flam)])
		chart.trackData.push(td)

		const re = parseChartAndIni([
			{ fileName: 'notes.mid', data: writeMidiFile(chart) },
			{ fileName: 'song.ini', data: new TextEncoder().encode('[Song]\npro_drums = True\n') },
		])
		const reTrack = re.parsedChart!.trackData.find(t => t.instrument === 'drums' && t.difficulty === 'expert')!
		const flags = reTrack.noteEventGroups.map(g => g[0].flags)
		expect(flags[0] & noteFlags.doubleKick).toBeTruthy()
		expect(flags[1] & noteFlags.accent).toBeTruthy()
		expect(flags[2] & noteFlags.ghost).toBeTruthy()
		expect(flags[3] & noteFlags.flam).toBeTruthy()
	})
})

// ---------------------------------------------------------------------------
// Fret / GHL track tests
// ---------------------------------------------------------------------------

function emptyFretTrack(
	instrument: ParsedChart['trackData'][number]['instrument'] = 'guitar',
	difficulty: 'expert' | 'hard' | 'medium' | 'easy' = 'expert',
): ParsedChart['trackData'][number] {
	return {
		instrument,
		difficulty,
		starPowerSections: [],
		rejectedStarPowerSections: [],
		soloSections: [],
		flexLanes: [],
		drumFreestyleSections: [],
		textEvents: [],
		versusPhrases: [],
		animations: [],
		unrecognizedMidiEvents: [],
		noteEventGroups: [],
	}
}

describe('writeMidiFile: PART GUITAR / GHL track layout', () => {
	it('emits a PART GUITAR track when the chart has a guitar track', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.trackData.push(emptyFretTrack('guitar', 'expert'))
		const midi = parseBack(writeMidiFile(chart))
		const track = midi.tracks[2]
		expect((findEvents(track, 'trackName')[0] as { text: string }).text).toBe('PART GUITAR')
	})

	it('emits a PART GUITAR GHL track when the chart has a guitarghl track', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.trackData.push(emptyFretTrack('guitarghl', 'expert'))
		const midi = parseBack(writeMidiFile(chart))
		const track = midi.tracks[2]
		expect((findEvents(track, 'trackName')[0] as { text: string }).text).toBe('PART GUITAR GHL')
	})
})

describe('writeMidiFile: 5-fret note-number mapping', () => {
	it('expert green→96, red→97, yellow→98, blue→99, orange→100 (5-fret 95+N)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.noteEventGroups.push([note(120, noteTypes.red)])
		td.noteEventGroups.push([note(240, noteTypes.yellow)])
		td.noteEventGroups.push([note(360, noteTypes.blue)])
		td.noteEventGroups.push([note(480, noteTypes.orange)])
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(track, 96)).toHaveLength(1)
		expect(findNoteOns(track, 97)).toHaveLength(1)
		expect(findNoteOns(track, 98)).toHaveLength(1)
		expect(findNoteOns(track, 99)).toHaveLength(1)
		expect(findNoteOns(track, 100)).toHaveLength(1)
	})

	it('hard base is 83, medium 71, easy 59', () => {
		const chart = createEmptyChart({ format: 'mid' })
		for (const d of ['hard', 'medium', 'easy'] as const) {
			const td = emptyFretTrack('guitar', d)
			td.noteEventGroups.push([note(0, noteTypes.green)])
			chart.trackData.push(td)
		}
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(track, 84)).toHaveLength(1) // hard 83+1
		expect(findNoteOns(track, 72)).toHaveLength(1) // medium 71+1
		expect(findNoteOns(track, 60)).toHaveLength(1) // easy 59+1
	})
})

describe('writeMidiFile: GHL note-number mapping', () => {
	it('expert white1→95, white2→96, white3→97, black1→98, black2→99, black3→100 (diffStart 94)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitarghl', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.white1)])
		td.noteEventGroups.push([note(120, noteTypes.white2)])
		td.noteEventGroups.push([note(240, noteTypes.white3)])
		td.noteEventGroups.push([note(360, noteTypes.black1)])
		td.noteEventGroups.push([note(480, noteTypes.black2)])
		td.noteEventGroups.push([note(600, noteTypes.black3)])
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(track, 95)).toHaveLength(1)
		expect(findNoteOns(track, 96)).toHaveLength(1)
		expect(findNoteOns(track, 97)).toHaveLength(1)
		expect(findNoteOns(track, 98)).toHaveLength(1)
		expect(findNoteOns(track, 99)).toHaveLength(1)
		expect(findNoteOns(track, 100)).toHaveLength(1) // 94 + 6
	})

	it('GHL open-in-chord emits at diffStart+0 = 94 (ENHANCED_OPENS mode)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitarghl', 'expert')
		// Chord of open + white1 triggers useEnhancedOpens → open emits at 94.
		td.noteEventGroups.push([
			note(0, noteTypes.open),
			note(0, noteTypes.white1),
		])
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(track, 94)).toHaveLength(1) // open
		expect(findNoteOns(track, 95)).toHaveLength(1) // white1
	})
})

describe('writeMidiFile: 5-fret open notes', () => {
	it('plain open (no chord) → forceOpen SysEx + noteOn at diffStart+1', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.open)])
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(track, 96)).toHaveLength(1) // written as green (diffStart+1)
		expect(findEvents(track, 'sysEx').length).toBeGreaterThanOrEqual(2) // on + off
	})

	it('open-in-chord triggers ENHANCED_OPENS text event + MIDI 95 (diffStart+0) for open', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([
			note(0, noteTypes.open),
			note(0, noteTypes.red),
		])
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		const texts = findEvents(track, 'text').map(e => (e as { text: string }).text)
		expect(texts).toContain('[ENHANCED_OPENS]')
		expect(findNoteOns(track, 95)).toHaveLength(1) // open at diffStart+0
		expect(findNoteOns(track, 97)).toHaveLength(1) // red at diffStart+2
	})
})

describe('writeMidiFile: fret force modifiers', () => {
	it('hopo flag disagreeing with natural state emits forceHopo marker', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyFretTrack('guitar', 'expert')
		// Two identical notes with large gap: natural = strum. Flagging hopo
		// creates a mismatch that needs forceHopo (offset 6, expert 95+6=101).
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.noteEventGroups.push([note(1920, noteTypes.green, noteFlags.hopo)])
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(track, 101)).toHaveLength(1)
	})

	it('strum flag disagreeing with natural HOPO emits forceStrum marker', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyFretTrack('guitar', 'expert')
		// Two different notes close together: natural = hopo. Flagging strum
		// creates a mismatch that needs forceStrum (offset 7, expert 95+7=102).
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.noteEventGroups.push([note(120, noteTypes.red, noteFlags.strum)])
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(track, 102)).toHaveLength(1)
	})

	it('tap flag emits forceTap SysEx', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green, noteFlags.tap)])
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		const sysExEvents = findEvents(track, 'sysEx')
		// forceTap SysEx has typeByte = 0x04
		const tapOn = sysExEvents.find(e => (e as { data: Uint8Array }).data[5] === 0x04 && (e as { data: Uint8Array }).data[6] === 0x01)
		expect(tapOn).toBeDefined()
	})

	it('does NOT emit force markers when flags match natural state', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyFretTrack('guitar', 'expert')
		// Two different notes close together: natural hopo; flag hopo → natural, no force.
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.noteEventGroups.push([note(120, noteTypes.red, noteFlags.hopo)])
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(track, 101)).toHaveLength(0)
		expect(findNoteOns(track, 102)).toHaveLength(0)
	})
})

describe('writeMidiFile: fret instrument-wide sections', () => {
	it('emits star power as MIDI 116 and solo as MIDI 103', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.starPowerSections.push({ tick: 0, length: 480, msTime: 0, msLength: 0 })
		td.soloSections.push({ tick: 480, length: 240, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const track = parseBack(writeMidiFile(chart)).tracks[2]
		expect(findNoteOns(track, 116)).toHaveLength(1)
		expect(findNoteOns(track, 103)).toHaveLength(1)
	})
})

describe('writeMidiFile: fret round-trip through parseChartAndIni', () => {
	it('round-trips 5-fret notes + hopo/tap modifiers', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.noteEventGroups.push([note(1920, noteTypes.green, noteFlags.hopo)]) // forceHopo
		td.noteEventGroups.push([note(3840, noteTypes.red, noteFlags.tap)])    // forceTap
		chart.trackData.push(td)

		const re = parseChartAndIni([{ fileName: 'notes.mid', data: writeMidiFile(chart) }])
		const reTrack = re.parsedChart!.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
		const groups = reTrack.noteEventGroups
		expect(groups).toHaveLength(3)
		expect(groups[1][0].flags & noteFlags.hopo).toBeTruthy()
		expect(groups[2][0].flags & noteFlags.tap).toBeTruthy()
	})

	it('round-trips GHL open + chord-with-open (ENHANCED_OPENS path)', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyFretTrack('guitarghl', 'expert')
		td.noteEventGroups.push([
			note(0, noteTypes.open),
			note(0, noteTypes.white1),
		])
		chart.trackData.push(td)

		const re = parseChartAndIni([{ fileName: 'notes.mid', data: writeMidiFile(chart) }])
		const reTrack = re.parsedChart!.trackData.find(t => t.instrument === 'guitarghl')!
		const types = reTrack.noteEventGroups[0].map(n => n.type).sort()
		expect(types).toEqual([noteTypes.open, noteTypes.white1].sort())
	})
})
