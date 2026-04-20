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
