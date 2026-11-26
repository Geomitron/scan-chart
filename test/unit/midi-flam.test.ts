import { describe, expect, it } from 'vitest'

import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteFlags } from 'src/chart/types'

import { midiFile, midiNote } from './helpers/midi-files'

type Parse = typeof parseChartFile

/** The red drum of each difficulty: Easy 61, Medium 73, Hard 85, Expert 97. */
const reds = { easy: 61, medium: 73, hard: 85, expert: 97 } as const

/** Each of a difficulty's note groups, as its tick and whether it's a flam. */
const flams = (data: Uint8Array, parse: Parse, difficulty: keyof typeof reds) => parse(data, 'mid').trackData
	.find(track => track.instrument === 'drums' && track.difficulty === difficulty)!.noteEventGroups
	.map(group => [group[0].tick, (group[0].flags & noteFlags.flam) !== 0])

// A red note on every difficulty at each tick, under a zero-length flam of each velocity: both ends of each band.
const velocities = [1, 20, 21, 30, 31, 40, 41, 50, 51, 127]
const ticks = velocities.map((_, index) => index * 480)
const banded = midiFile([{ name: 'PART DRUMS', events: velocities.flatMap((velocity, index) => [
	...Object.values(reds).flatMap(noteNumber => midiNote(ticks[index], noteNumber)),
	...midiNote(ticks[index], 109, 0, { velocity }),
]) }])
const flammedOn = (...flammed: number[]) => ticks.map((tick, index) => [tick, flammed.includes(velocities[index])])

describe('a .mid flam (note 109) takes the lane velocities', () => {
	for (const [profile, parse] of [['scanner', parseChartFile], ['canonical', parseChartFileCanonicalIdentity]] as const) {
		it(`in the ${profile} profile: 21-30 every difficulty, 31-40 Medium and up, 41-50 Hard and up, any other Expert only`, () => {
			expect(flams(banded, parse, 'expert')).toEqual(flammedOn(...velocities))
			expect(flams(banded, parse, 'hard')).toEqual(flammedOn(21, 30, 31, 40, 41, 50))
			expect(flams(banded, parse, 'medium')).toEqual(flammedOn(21, 30, 31, 40))
			expect(flams(banded, parse, 'easy')).toEqual(flammedOn(21, 30))
		})
	}

	it('keeps Clone Hero 1.1\'s reading in the frozen profile: every flam on every difficulty, whatever its velocity', () => {
		for (const difficulty of ['expert', 'hard', 'medium', 'easy'] as const) {
			expect(flams(banded, parseChartFileFrozenLegacyIdentity, difficulty)).toEqual(flammedOn(...velocities))
		}
	})

	it('flams a note under flams of two velocities on every difficulty either one reaches', () => {
		// An Expert-only flam, then a Hard-and-up one, over the same two notes of Medium, Hard and Expert.
		const data = midiFile([{ name: 'PART DRUMS', events: [
			...[0, 240].flatMap(tick => [reds.medium, reds.hard, reds.expert].flatMap(noteNumber => midiNote(tick, noteNumber))),
			...midiNote(0, 109, 480, { velocity: 100 }), ...midiNote(0, 109, 480, { velocity: 45 }),
		] }])
		expect(flams(data, parseChartFile, 'expert')).toEqual([[0, true], [240, true]])
		expect(flams(data, parseChartFile, 'hard')).toEqual([[0, true], [240, true]])
		expect(flams(data, parseChartFile, 'medium')).toEqual([[0, false], [240, false]])
	})
})
