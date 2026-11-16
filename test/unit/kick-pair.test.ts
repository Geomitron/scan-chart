import { describe, expect, it } from 'vitest'

import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteFlags, noteTypes } from 'src/chart/types'

import { chartFile } from './helpers/chart-files'
import { midiFile, midiNote } from './helpers/midi-files'

type Parse = typeof parseChartFile

/** The Expert drum kicks' ticks, lengths, and whether each is a double kick. */
const expertKicks = (data: Uint8Array, format: 'chart' | 'mid', parse: Parse, modifiers: Parameters<Parse>[2] = {}) => parse(data, format, modifiers).trackData
	.find(track => track.instrument === 'drums' && track.difficulty === 'expert')!.noteEventGroups
	.flatMap(group => group.filter(note => note.type === noteTypes.kick))
	.map(note => [note.tick, note.length, (note.flags & noteFlags.doubleKick) !== 0])

// A kick and a double kick on each of three ticks: the double kick longer, the kick longer, and the two the same length.
const chart = chartFile(['[ExpertDrums]', '{', '  0 = N 0 240', '  0 = N 32 480', '  480 = N 0 480', '  480 = N 32 240', '  960 = N 0 240', '  960 = N 32 240', '}'])
const mid = midiFile([{ name: 'PART DRUMS', events: [
	...midiNote(0, 96, 240), ...midiNote(0, 95, 480), ...midiNote(480, 96, 480), ...midiNote(480, 95, 240), ...midiNote(960, 96, 240), ...midiNote(960, 95, 240),
] }])

describe('a kick and a double kick on one tick', () => {
	for (const [format, data] of [['chart', chart], ['mid', mid]] as const) {
		it(`reads the kick with its own length, whatever the lengths, in the scanner and canonical profiles (.${format})`, () => {
			const kicks = [[0, 240, false], [480, 480, false], [960, 240, false]]
			expect(expertKicks(data, format, parseChartFile)).toEqual(kicks)
			expect(expertKicks(data, format, parseChartFileCanonicalIdentity)).toEqual(kicks)
		})

		it(`keeps Clone Hero 1.1's reading in the frozen profile: the longer, or the double kick on a tie (.${format})`, () => {
			expect(expertKicks(data, format, parseChartFileFrozenLegacyIdentity)).toEqual([[0, 480, true], [480, 480, false], [960, 240, true]])
		})
	}
})

describe('a kick snapping onto a chord with a kick and a double kick', () => {
	// chord_snap_threshold 2: a 192-tick kick or double kick at tick 1 snaps onto the pair at tick 0, written in either order.
	const snap = { chord_snap_threshold: 2 }
	const pairs = { 'kick first': ['  0 = N 0 0', '  0 = N 32 0'], 'double kick first': ['  0 = N 32 0', '  0 = N 0 0'] } as const
	const midiPairs = { 'kick first': [...midiNote(0, 96, 0), ...midiNote(0, 95, 0)], 'double kick first': [...midiNote(0, 95, 0), ...midiNote(0, 96, 0)] } as const
	for (const order of ['kick first', 'double kick first'] as const) {
		for (const [moved, chartLine, midiNumber] of [['kick', '  1 = N 0 192', 96], ['double kick', '  1 = N 32 192', 95]] as const) {
			it(`joins the kick the chord keeps, with the longer length: a moved ${moved}, the pair written ${order}`, () => {
				const chart = chartFile(['[ExpertDrums]', '{', ...pairs[order], chartLine, '}'])
				const mid = midiFile([{ name: 'PART DRUMS', events: [...midiPairs[order], ...midiNote(1, midiNumber, 192)] }])
				for (const parse of [parseChartFile, parseChartFileCanonicalIdentity]) {
					expect(expertKicks(chart, 'chart', parse, snap)).toEqual([[0, 192, false]])
					expect(expertKicks(mid, 'mid', parse, snap)).toEqual([[0, 192, false]])
				}
				// The frozen profile keeps Clone Hero 1.1's reading: the flags of the kick the chord lists first, which in a
				// .chart file follows the order the pair is written in, and in a .mid file is the double kick.
				expect(expertKicks(chart, 'chart', parseChartFileFrozenLegacyIdentity, snap)).toEqual([[0, 192, order === 'double kick first']])
				expect(expertKicks(mid, 'mid', parseChartFileFrozenLegacyIdentity, snap)).toEqual([[0, 192, true]])
			})
		}
	}

	it('drops the written double kick with its length', () => {
		const chart = chartFile(['[ExpertDrums]', '{', '  0 = N 0 0', '  0 = N 32 480', '  1 = N 0 192', '}'])
		const mid = midiFile([{ name: 'PART DRUMS', events: [...midiNote(0, 96, 0), ...midiNote(0, 95, 480), ...midiNote(1, 96, 192)] }])
		for (const parse of [parseChartFile, parseChartFileCanonicalIdentity]) {
			expect(expertKicks(chart, 'chart', parse, snap)).toEqual([[0, 192, false]])
			expect(expertKicks(mid, 'mid', parse, snap)).toEqual([[0, 192, false]])
		}
	})
})
