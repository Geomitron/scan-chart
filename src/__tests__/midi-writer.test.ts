/**
 * Round-trip tests for writeMidiFile.
 *
 * All tests exercise the writer only through parseChartAndIni: build a
 * ParsedChart, write it out as MIDI, re-parse, and assert on the resulting
 * ParsedChart. No assertions about the raw MIDI structure (track count,
 * track names, note numbers, setTempo microseconds, text-event brackets,
 * etc.) — the parser is the source of truth for observable behavior.
 */

import type { MidiEvent } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { createEmptyChart } from '../chart/create-chart'
import { writeMidiFile } from '../chart/midi-writer'
import { noteFlags, noteTypes } from '../chart/note-parsing-interfaces'
import { parseChartAndIni, type ParsedChart } from '../chart/parse-chart-and-ini'

function roundTrip(chart: ParsedChart, iniText?: string): ParsedChart {
	const files: { fileName: string; data: Uint8Array }[] = [
		{ fileName: 'notes.mid', data: writeMidiFile(chart) },
	]
	if (iniText !== undefined) {
		files.push({ fileName: 'song.ini', data: new TextEncoder().encode(iniText) })
	}
	const result = parseChartAndIni(files)
	if (!result.parsedChart) {
		throw new Error(`round-trip produced no parsedChart: ${JSON.stringify(result.chartFolderIssues)}`)
	}
	return result.parsedChart
}

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

function findTrack(
	chart: ParsedChart,
	instrument: ParsedChart['trackData'][number]['instrument'],
	difficulty = 'expert',
) {
	const t = chart.trackData.find(t => t.instrument === instrument && t.difficulty === difficulty)
	if (!t) throw new Error(`no ${difficulty} ${instrument} track in round-tripped chart`)
	return t
}

function flatNotes(track: ParsedChart['trackData'][number]) {
	return track.noteEventGroups.flatMap(g =>
		g.map(n => ({ tick: n.tick, type: n.type, flags: n.flags, length: n.length })),
	)
}

const PRO_DRUMS_INI = '[Song]\npro_drums = True\n'

describe('writeMidiFile round-trip: resolution + [SyncTrack]', () => {
	it('preserves chart resolution', () => {
		const re = roundTrip(createEmptyChart({ resolution: 192 }))
		expect(re.resolution).toBe(192)
	})

	it('preserves the default tempo on an empty chart', () => {
		const re = roundTrip(createEmptyChart({ bpm: 120 }))
		expect(re.tempos.map(t => ({ tick: t.tick, bpm: Math.round(t.beatsPerMinute) }))).toEqual([{ tick: 0, bpm: 120 }])
	})

	it('preserves fractional BPM within microsecondsPerBeat rounding', () => {
		const re = roundTrip(createEmptyChart({ bpm: 137.5 }))
		expect(re.tempos[0].beatsPerMinute).toBeCloseTo(137.5, 1)
	})

	it('preserves multiple tempo changes at their ticks', () => {
		const chart = createEmptyChart({ resolution: 480, bpm: 120 })
		chart.tempos.push({ tick: 960, beatsPerMinute: 180, msTime: 0 })
		const re = roundTrip(chart)
		expect(re.tempos.map(t => ({ tick: t.tick, bpm: Math.round(t.beatsPerMinute) }))).toEqual([
			{ tick: 0, bpm: 120 },
			{ tick: 960, bpm: 180 },
		])
	})

	it('preserves non-4/4 time signatures', () => {
		const chart = createEmptyChart({ timeSignature: { numerator: 6, denominator: 8 } })
		expect(roundTrip(chart).timeSignatures[0]).toMatchObject({ numerator: 6, denominator: 8 })
	})

	it('preserves multiple time-signature changes', () => {
		const chart = createEmptyChart({ timeSignature: { numerator: 7, denominator: 8 } })
		chart.timeSignatures.push({ tick: 3840, numerator: 3, denominator: 4, msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.timeSignatures.map(ts => ({ t: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
			{ t: 0, n: 7, d: 8 },
			{ t: 3840, n: 3, d: 4 },
		])
	})
})

describe('writeMidiFile round-trip: EVENTS track', () => {
	it('preserves sections at the right ticks with correct names', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: 'Intro', msTime: 0, msLength: 0 })
		chart.sections.push({ tick: 1920, name: 'Verse 1', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.sections.map(s => ({ tick: s.tick, name: s.name }))).toEqual([
			{ tick: 0, name: 'Intro' },
			{ tick: 1920, name: 'Verse 1' },
		])
	})

	it('preserves end events', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 1920, msTime: 0, msLength: 0 })
		expect(roundTrip(chart).endEvents.map(e => e.tick)).toEqual([1920])
	})

	it('preserves unrecognized EVENTS events on .mid source', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.unrecognizedEventsTrackTextEvents.push({ tick: 480, text: 'crowd_noclap', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.unrecognizedEventsTrackTextEvents.map(e => ({ tick: e.tick, text: e.text }))).toEqual([
			{ tick: 480, text: 'crowd_noclap' },
		])
	})
})

describe('writeMidiFile round-trip: unrecognized MIDI tracks', () => {
	it('preserves an unrecognized track by name', () => {
		const chart = createEmptyChart()
		chart.unrecognizedMidiTracks.push({
			trackName: 'CUSTOM',
			events: [
				{ deltaTime: 0, meta: true, type: 'trackName', text: 'CUSTOM' } as MidiEvent,
				{ deltaTime: 240, meta: true, type: 'text', text: 'hello' } as MidiEvent,
				{ deltaTime: 240, meta: true, type: 'endOfTrack' } as MidiEvent,
			],
		})
		expect(roundTrip(chart).unrecognizedMidiTracks.map(t => t.trackName)).toEqual(['CUSTOM'])
	})

	it('preserves multiple unrecognized tracks with the same name', () => {
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
		expect(roundTrip(chart).unrecognizedMidiTracks).toHaveLength(3)
	})
})

describe('writeMidiFile round-trip: drum tracks', () => {
	it('preserves base 4-lane drum notes at the right ticks', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick)])
		td.noteEventGroups.push([note(120, noteTypes.redDrum)])
		td.noteEventGroups.push([note(240, noteTypes.yellowDrum)])
		td.noteEventGroups.push([note(360, noteTypes.blueDrum)])
		td.noteEventGroups.push([note(480, noteTypes.greenDrum)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'drums'))
		expect(notes.map(n => ({ tick: n.tick, type: n.type }))).toEqual([
			{ tick: 0, type: noteTypes.kick },
			{ tick: 120, type: noteTypes.redDrum },
			{ tick: 240, type: noteTypes.yellowDrum },
			{ tick: 360, type: noteTypes.blueDrum },
			{ tick: 480, type: noteTypes.greenDrum },
		])
	})

	it('preserves tracks across all difficulties on a single chart', () => {
		const chart = createEmptyChart({ format: 'mid' })
		for (const d of ['expert', 'hard', 'medium', 'easy'] as const) {
			const td = emptyDrumTrack(d)
			td.noteEventGroups.push([note(0, noteTypes.kick)])
			chart.trackData.push(td)
		}
		const re = roundTrip(chart)
		for (const d of ['expert', 'hard', 'medium', 'easy'] as const) {
			expect(findTrack(re, 'drums', d).noteEventGroups).toHaveLength(1)
		}
	})

	it('preserves double-kick (not as a regular kick)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick, noteFlags.doubleKick)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'drums'))
		expect(notes).toHaveLength(1)
		expect(notes[0].flags & noteFlags.doubleKick).toBeTruthy()
	})

	it('preserves accent and ghost flags', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.accent)])
		td.noteEventGroups.push([note(240, noteTypes.yellowDrum, noteFlags.ghost)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'drums'))
		expect(notes[0].flags & noteFlags.accent).toBeTruthy()
		expect(notes[1].flags & noteFlags.ghost).toBeTruthy()
	})

	it('preserves cymbal/tom distinction in fourLanePro', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.drumType = 1 // fourLanePro
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.yellowDrum, noteFlags.cymbal)])
		td.noteEventGroups.push([note(120, noteTypes.yellowDrum, noteFlags.tom)])
		td.noteEventGroups.push([note(240, noteTypes.blueDrum, noteFlags.cymbal)])
		td.noteEventGroups.push([note(360, noteTypes.blueDrum, noteFlags.tom)])
		td.noteEventGroups.push([note(480, noteTypes.greenDrum, noteFlags.cymbal)])
		td.noteEventGroups.push([note(600, noteTypes.greenDrum, noteFlags.tom)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart, PRO_DRUMS_INI), 'drums'))
		expect(notes[0].flags & noteFlags.cymbal).toBeTruthy()
		expect(notes[1].flags & noteFlags.tom).toBeTruthy()
		expect(notes[2].flags & noteFlags.cymbal).toBeTruthy()
		expect(notes[3].flags & noteFlags.tom).toBeTruthy()
		expect(notes[4].flags & noteFlags.cymbal).toBeTruthy()
		expect(notes[5].flags & noteFlags.tom).toBeTruthy()
	})

	it('preserves the flam flag on a chord group', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([
			note(0, noteTypes.redDrum, noteFlags.flam),
			note(0, noteTypes.yellowDrum, noteFlags.flam),
		])
		chart.trackData.push(td)
		const group = findTrack(roundTrip(chart), 'drums').noteEventGroups[0]
		expect(group.some(n => (n.flags & noteFlags.flam) !== 0)).toBe(true)
	})

	it('preserves star power, solo sections, flex lanes, and activation lanes', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick)])
		td.starPowerSections.push({ tick: 0, length: 960, msTime: 0, msLength: 0 })
		td.soloSections.push({ tick: 480, length: 480, msTime: 0, msLength: 0 })
		td.flexLanes.push({ tick: 960, length: 480, isDouble: false, msTime: 0, msLength: 0 })
		td.flexLanes.push({ tick: 1440, length: 480, isDouble: true, msTime: 0, msLength: 0 })
		td.drumFreestyleSections.push({ tick: 1920, length: 480, isCoda: false, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const reTrack = findTrack(roundTrip(chart), 'drums')
		expect(reTrack.starPowerSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 0, l: 960 }])
		expect(reTrack.soloSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 480, l: 480 }])
		expect(reTrack.flexLanes.map(f => ({ t: f.tick, l: f.length, d: f.isDouble }))).toEqual([
			{ t: 960, l: 480, d: false },
			{ t: 1440, l: 480, d: true },
		])
		expect(reTrack.drumFreestyleSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 1920, l: 480 }])
	})
})
