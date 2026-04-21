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
		// setTempo is stored as integer microseconds/beat, so fractional BPM
		// round-trips with tiny quantization — check within 0.01 BPM.
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
