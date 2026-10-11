import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { canonical20260801, type ChartSource } from 'src/chart/identity/public'
import { roundBpm } from 'src/chart/identity/btrack-20260801'
import { defaultMetadata } from 'src/ini/metadata'

const resolution = 192
const noteTicks = [0, 384, 768, 1920]

function chartSource(chartTempo: number) {
	const notes = noteTicks.map(tick => `  ${tick} = N 0 0`).join('\r\n')
	const text = `[Song]\r\n{\r\n  Resolution = ${resolution}\r\n}\r\n[SyncTrack]\r\n{\r\n  0 = TS 4\r\n  0 = B ${chartTempo}\r\n}\r\n`
		+ `[Events]\r\n{\r\n}\r\n[ExpertSingle]\r\n{\r\n${notes}\r\n}\r\n`
	return { format: 'chart' as const, bytes: new TextEncoder().encode(text) }
}

function midiSource(microsecondsPerBeat: number) {
	let previous = 0
	const guitar = [{ deltaTime: 0, type: 'trackName' as const, text: 'PART GUITAR' }, ...noteTicks.flatMap(tick => {
		const events = [
			{ deltaTime: tick - previous, type: 'noteOn' as const, channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 0, type: 'noteOff' as const, channel: 0, noteNumber: 96, velocity: 0 },
		]
		previous = tick
		return events
	}), { deltaTime: 0, type: 'endOfTrack' as const }]
	const conductor = [
		{ deltaTime: 0, type: 'setTempo' as const, microsecondsPerBeat },
		{ deltaTime: 0, type: 'timeSignature' as const, numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
		{ deltaTime: 0, type: 'endOfTrack' as const },
	]
	const bytes = new Uint8Array(writeMidi({ header: { format: 1, numTracks: 2, ticksPerBeat: resolution }, tracks: [conductor, guitar] }))
	return { format: 'mid' as const, bytes }
}

function identity(source: ChartSource) {
	const parsed = canonical20260801.parseSource({ source, modifiers: defaultMetadata })
	if (parsed.kind !== 'accepted') throw new Error('rejected')
	const metadata = { name: 'Song', artist: null, album: null, genre: null, year: null, charter: null, icon: null }
	return canonical20260801.calculateSongBundle({ chart: parsed.chart, metadata })
}

describe('tempo rounding in the TrackHash', () => {
	it('gives a .chart tempo and the nearest .mid tempo the same hashes and durations', () => {
		// 428571 microseconds per beat is the .mid tempo closest to the .chart tempo B 140000
		const fromChart = identity(chartSource(140000))
		const fromMidi = identity(midiSource(428571))
		const [chartTrack] = fromChart.tracks
		const [midiTrack] = fromMidi.tracks

		expect(midiTrack.identity.trackHash.value).toBe(chartTrack.identity.trackHash.value)
		expect(midiTrack.duration.durationMs).toBe(chartTrack.duration.durationMs)
		expect(fromMidi.duration.durationMs).toBe(fromChart.duration.durationMs)
		expect(fromMidi.song.songHash.value).toBe(fromChart.song.songHash.value)
		expect(midiTrack.identity.physicalBTrack.bytes).not.toEqual(chartTrack.identity.physicalBTrack.bytes)
	})

	it('keeps tempos that differ by 0.001 BPM apart', () => {
		expect(identity(chartSource(140001)).tracks[0].identity.trackHash.value)
			.not.toBe(identity(chartSource(140000)).tracks[0].identity.trackHash.value)
	})

	// .chart tempos are whole thousandths of a BPM, so rounding leaves them, and their TrackHashes, unchanged
	it.each([1, 3576, 120000, 143587, 999999, 2400000])('keeps the .chart tempo B %i', chartTempo => {
		expect(roundBpm(chartTempo / 1000)).toBe(chartTempo / 1000)
	})
})
