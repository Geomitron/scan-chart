import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteFlags } from 'src/chart/types'

type MidiEvent = MidiData['tracks'][number][number]

const dynamicsText = (text = '[ENABLE_CHART_DYNAMICS]'): MidiEvent => ({ deltaTime: 0, type: 'text', text })
const noteOn = (noteNumber: number, velocity: number): MidiEvent => ({ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber, velocity })
const noteOff = (noteNumber: number): MidiEvent => ({ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber, velocity: 0 })

/** Builds a drums track from events listed in file order with absolute ticks. */
function drums(events: readonly [number, MidiEvent][]): Uint8Array {
	const track: MidiData['tracks'][number] = [{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' }]
	let previous = 0
	for (const [tick, event] of events) {
		track.push({ ...event, deltaTime: tick - previous })
		previous = tick
	}
	track.push({ deltaTime: 0, type: 'endOfTrack' })
	const conductor: MidiData['tracks'][number] = [{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }]
	return new Uint8Array(writeMidi({ header: { format: 1, numTracks: 2, ticksPerBeat: 480 }, tracks: [conductor, track] }))
}

/** Yellow expert (98) and yellow hard (86) notes at the given ticks and velocities, each 60 ticks long. */
function notes(ticks: readonly [number, number][], dynamicsAt: number | null, dynamicsBeforeNotes = true): [number, MidiEvent][] {
	const events: [number, MidiEvent][] = []
	for (const [tick, velocity] of ticks) {
		if (tick === dynamicsAt && dynamicsBeforeNotes) events.push([tick, dynamicsText()])
		events.push([tick, noteOn(98, velocity)], [tick, noteOn(86, velocity)])
		if (tick === dynamicsAt && !dynamicsBeforeNotes) events.push([tick, dynamicsText()])
		events.push([tick + 60, noteOff(98)], [tick + 60, noteOff(86)])
	}
	if (dynamicsAt !== null && !ticks.some(([tick]) => tick === dynamicsAt)) {
		const index = events.findIndex(([tick]) => tick > dynamicsAt)
		events.splice(index === -1 ? events.length : index, 0, [dynamicsAt, dynamicsText()])
	}
	return events
}

type Parse = typeof parseChartFile

function dynamicsByTick(parse: Parse, bytes: Uint8Array, format: 'chart' | 'mid' = 'mid') {
	const result: Record<string, Record<number, string>> = {}
	for (const track of parse(bytes, format).trackData) {
		result[track.difficulty] = Object.fromEntries(track.noteEventGroups.flat().map(note => [
			note.tick,
			note.flags & noteFlags.accent ? 'accent' : note.flags & noteFlags.ghost ? 'ghost' : '-',
		]))
	}
	return result
}

const lateTicks: [number, number][] = [[0, 127], [480, 1], [1920, 127], [2400, 1]]
const fromEvent = { 0: '-', 480: '-', 1920: 'accent', 2400: 'ghost' }

describe('[ENABLE_CHART_DYNAMICS] in MIDI', () => {
	it('applies from the event onward on every difficulty, as CH reads one time-ordered pass', () => {
		const bytes = drums(notes(lateTicks, 1440))
		for (const parse of [parseChartFile, parseChartFileCanonicalIdentity]) {
			expect(dynamicsByTick(parse, bytes)).toEqual({ expert: fromEvent, hard: fromEvent })
		}
	})

	it('keeps the frozen legacy behavior, which applies it to all of every difficulty after Expert', () => {
		expect(dynamicsByTick(parseChartFileFrozenLegacyIdentity, drums(notes(lateTicks, 1440)))).toEqual({
			expert: fromEvent,
			hard: { 0: 'accent', 480: 'ghost', 1920: 'accent', 2400: 'ghost' },
		})
	})

	it('includes a note on the event tick only when the event comes first in the file', () => {
		expect(dynamicsByTick(parseChartFileCanonicalIdentity, drums(notes(lateTicks, 1920, true))))
			.toEqual({ expert: fromEvent, hard: fromEvent })
		const after = { 0: '-', 480: '-', 1920: '-', 2400: 'ghost' }
		expect(dynamicsByTick(parseChartFileCanonicalIdentity, drums(notes(lateTicks, 1920, false))))
			.toEqual({ expert: after, hard: after })
	})

	it('accepts the event with or without brackets', () => {
		const bytes = drums([[0, dynamicsText('ENABLE_CHART_DYNAMICS')], [0, noteOn(98, 127)], [60, noteOff(98)]])
		expect(dynamicsByTick(parseChartFileCanonicalIdentity, bytes)).toEqual({ expert: { 0: 'accent' } })
	})
})

describe('[ENABLE_CHART_DYNAMICS] in .chart', () => {
	it('does not gate .chart accents and ghosts, which CH always applies', () => {
		const chart = (events: readonly string[]) => new TextEncoder().encode([
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[ExpertDrums]', '{', ...['0 = N 2 0', '0 = N 35 0', '1920 = N 2 0', '1920 = N 41 0', ...events].map(line => `  ${line}`), '}',
		].join('\r\n'))
		const expected = { expert: { 0: 'accent', 1920: 'ghost' } }
		for (const events of [[], ['1440 = E [ENABLE_CHART_DYNAMICS]'], ['0 = E ENABLE_CHART_DYNAMICS']]) {
			const bytes = chart(events)
			expect(dynamicsByTick(parseChartFile, bytes, 'chart')).toEqual(expected)
			expect(dynamicsByTick(parseChartFileCanonicalIdentity, bytes, 'chart')).toEqual(expected)
		}
	})
})
