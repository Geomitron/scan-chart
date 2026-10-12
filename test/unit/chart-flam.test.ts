import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { canonical20260801 } from 'src/chart/identity/public'
import { parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { defaultIniChartModifiers, noteFlags } from 'src/chart/types'

type MidiEvent = MidiData['tracks'][number][number]

function chart(sections: Record<string, readonly string[]>): Uint8Array {
	const lines = ['[Song]', '{', '  Resolution = 480', '}', '[SyncTrack]', '{', '  0 = B 120000', '}', '[Events]', '{', '}']
	for (const [name, body] of Object.entries(sections)) lines.push(`[${name}]`, '{', ...body.map(line => `  ${line}`), '}')
	return new TextEncoder().encode(lines.join('\r\n') + '\r\n')
}

/** Each note group's ticks and whether every note in it is flammed. */
function flams(bytes: Uint8Array, parse = parseChartFileCanonicalIdentity, difficulty = 'expert') {
	const track = parse(bytes, 'chart').trackData.find(candidate => candidate.instrument === 'drums' && candidate.difficulty === difficulty)!
	return track.noteEventGroups.map(group => [group[0].tick, group.every(note => (note.flags & noteFlags.flam) !== 0)])
}

describe('flam in .chart (C18)', () => {
	it('flams every drum note on the tick of an N 109 marker, kicks included', () => {
		const bytes = chart({ ExpertDrums: ['0 = N 0 0', '0 = N 2 0', '0 = N 109 0', '480 = N 2 0'] })
		expect(flams(bytes)).toEqual([[0, true], [480, false]])
	})

	it('ignores the marker\'s length, as for the other note modifiers', () => {
		const bytes = chart({ ExpertDrums: ['0 = N 1 0', '0 = N 109 960', '480 = N 1 0'] })
		expect(flams(bytes)).toEqual([[0, true], [480, false]])
	})

	it('applies a marker to its own difficulty only', () => {
		const bytes = chart({ ExpertDrums: ['0 = N 1 0', '0 = N 109 0'], HardDrums: ['0 = N 1 0'] })
		expect(flams(bytes, parseChartFileCanonicalIdentity, 'hard')).toEqual([[0, false]])
	})

	it('is ignored by the frozen legacy profile, as Clone Hero 1.1.0.6142 ignores it', () => {
		const bytes = chart({ ExpertDrums: ['0 = N 1 0', '0 = N 109 0'] })
		expect(flams(bytes, parseChartFileFrozenLegacyIdentity)).toEqual([[0, false]])
	})

	it('gives the same canonical TrackHash as .mid flam over the same notes', () => {
		const chartBytes = chart({ ExpertDrums: ['0 = N 0 0', '0 = N 2 0', '0 = N 109 0', '480 = N 2 0'] })
		const at = (tick: number, event: Omit<MidiEvent, 'deltaTime'>) => ({ tick, event })
		const on = (noteNumber: number) => ({ type: 'noteOn', channel: 0, noteNumber, velocity: 100 }) as Omit<MidiEvent, 'deltaTime'>
		const off = (noteNumber: number) => ({ type: 'noteOff', channel: 0, noteNumber, velocity: 0 }) as Omit<MidiEvent, 'deltaTime'>
		const events = [
			at(0, on(96)), at(0, on(98)), at(0, on(109)), at(1, off(96)), at(1, off(98)), at(1, off(109)), at(480, on(98)), at(481, off(98)),
		]
		let previous = 0
		const drums: MidiData['tracks'][number] = [{ deltaTime: 0, type: 'trackName', text: 'PART DRUMS' }]
		for (const { tick, event } of events) {
			drums.push({ ...event, deltaTime: tick - previous } as MidiEvent)
			previous = tick
		}
		drums.push({ deltaTime: 0, type: 'endOfTrack' })
		const midiBytes = new Uint8Array(writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
			tracks: [[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }], drums],
		}))
		const trackHash = (format: 'chart' | 'mid', bytes: Uint8Array) => {
			const parsed = canonical20260801.parseSource({ source: { format, bytes }, modifiers: defaultIniChartModifiers })
			if (parsed.kind !== 'accepted') throw new Error(parsed.errors[0].message)
			return canonical20260801.calculateTrackIdentity(parsed.chart.tracks[0]).trackHash.value
		}
		expect(trackHash('chart', chartBytes)).toBe(trackHash('mid', midiBytes))
		expect(trackHash('chart', chartBytes)).not.toBe(trackHash('chart', chart({ ExpertDrums: ['0 = N 0 0', '0 = N 2 0', '480 = N 2 0'] })))
	})
})
