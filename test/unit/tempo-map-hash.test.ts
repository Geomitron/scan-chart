import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { canonical20260801 } from 'src/chart/identity/public'

const tempoMapHash = (format: 'chart' | 'mid', bytes: Uint8Array) => {
	const parsed = canonical20260801.parseSource({ source: { format, bytes }, modifiers: {} })
	if (parsed.kind !== 'accepted') throw new Error('expected the chart to parse')
	return canonical20260801.calculateTempoMapHash(parsed.chart)
}
const chart = (syncTrack: readonly string[], resolution = 192) => new TextEncoder().encode([
	'[Song]', '{', `  Resolution = ${resolution}`, '}',
	'[SyncTrack]', '{', ...syncTrack.map(line => `  ${line}`), '}',
	'[Events]', '{', '}',
	'[ExpertSingle]', '{', '  0 = N 0 0', '  384 = N 1 0', '}',
].join('\r\n') + '\r\n')

// The expected values are Clone Hero's `Song.ComputeTempoMapHash` for the same files (CH `20eb8fdac`, through
// review-2026-10/ch-mr/tools/hash-dump); its validator gets the same values from each track's BTrack read back.
describe('Clone Hero\'s tempo map hash', () => {
	it('covers every tempo and time signature, with the exact tempo', () => {
		expect(tempoMapHash('chart', chart(['0 = TS 4', '0 = B 120000', '768 = B 140500', '768 = TS 7 3'])))
			.toBe('L6yIfNwNVz_NTjyEJy4oI1T77lomAD1BrUri1jf4xiU')
	})

	it('includes the default tempo and time signature of a chart without them at tick 0', () => {
		expect(tempoMapHash('chart', chart(['192 = B 150000']))).toBe('4c6AX7i-6uVCC9hVsVrp4ukjrlgRwCk5juApJ26ROvM')
	})

	it('keeps a .mid tempo exact rather than rounding it to 0.001 BPM, as the TrackHash does', () => {
		const midi = writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
			tracks: [
				[
					{ deltaTime: 0, type: 'timeSignature', numerator: 6, denominator: 8, metronome: 24, thirtyseconds: 8 },
					{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 428571 },
					{ deltaTime: 960, type: 'setTempo', microsecondsPerBeat: 500000 },
					{ deltaTime: 0, type: 'endOfTrack' },
				],
				[
					{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
					{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
					{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
					{ deltaTime: 950, type: 'noteOn', channel: 0, noteNumber: 97, velocity: 100 },
					{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 97, velocity: 0 },
					{ deltaTime: 0, type: 'endOfTrack' },
				],
			],
		})
		expect(tempoMapHash('mid', new Uint8Array(midi))).toBe('6cVu3utKUQNlPaBfq1aaTLcaG2kh5FlajY0eXmYEIGU')
		// 428571 µs per beat is 140.00007 BPM. The same tempo map with the tempo rounded to 140 BPM has another hash.
		const rounded = tempoMapHash('chart', chart(['0 = TS 6 3', '0 = B 140000', '960 = B 120000'], 480))
		expect(rounded).not.toBe(tempoMapHash('mid', new Uint8Array(midi)))
	})
})
