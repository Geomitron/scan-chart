import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { parseRules } from 'src/chart/parse-rules'
import { noteFlags } from 'src/chart/types'

describe('parse profiles', () => {
	it('keeps every profile rule visible in review', () => {
		expect(parseRules).toMatchInlineSnapshot(`
			{
			  "canonical20260801": {
			    "chartFlam": "read",
			    "chartNonstandardLines": "read",
			    "chartTrackAllocation": "sectionsWithNotes",
			    "midiChartDynamics": "fromEvent",
			    "midiDuplicateInstrumentTracks": "firstWins",
			    "midiKickDynamics": "ignored",
			    "midiTapEnd": "inclusive",
			    "midiTrackAllocation": "difficultiesWithNotes",
			    "profile": "canonical20260801",
			  },
			  "frozenLegacy6142": {
			    "chartFlam": "ignored",
			    "chartNonstandardLines": "ignored",
			    "chartTrackAllocation": "everySection",
			    "midiChartDynamics": "leaksAcrossDifficulties",
			    "midiDuplicateInstrumentTracks": "keepAll",
			    "midiKickDynamics": "applied",
			    "midiTapEnd": "exclusive",
			    "midiTrackAllocation": "difficultiesWithNotesAndExpert",
			    "profile": "frozenLegacy6142",
			  },
			  "scanner": {
			    "chartFlam": "read",
			    "chartNonstandardLines": "read",
			    "chartTrackAllocation": "everySection",
			    "midiChartDynamics": "fromEvent",
			    "midiDuplicateInstrumentTracks": "keepAll",
			    "midiKickDynamics": "ignored",
			    "midiTapEnd": "exclusive",
			    "midiTrackAllocation": "difficultiesWithNotes",
			    "profile": "scanner",
			  },
			}
		`)
	})

	it('cannot be modified at runtime', () => {
		expect(Object.isFrozen(parseRules)).toBe(true)
		for (const rules of Object.values(parseRules)) expect(Object.isFrozen(rules)).toBe(true)
	})
})

describe('the gameplay view (E2)', () => {
	const encode = (text: string) => new TextEncoder().encode(text)
	const tracksOf = (files: { fileName: string; data: Uint8Array }[]) =>
		parseChartAndIni(files).parsedChart!.trackData.map(track => `${track.instrument}:${track.difficulty}`)

	it('reads a .chart file with Clone Hero\'s rules: a section with no notes isn\'t a track', () => {
		const chart = '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  0 = N 0 0\n}\n[HardSingle]\n{\n  0 = E solo\n}\n'
		expect(tracksOf([{ fileName: 'notes.chart', data: encode(chart) }])).toEqual(['guitar:expert'])
	})

	it('reads only the first of several .mid tracks for one instrument, and a tap phrase includes its end tick', () => {
		const guitar = (notes: number[]) => [
			{ deltaTime: 0, type: 'trackName' as const, text: 'PART GUITAR' },
			...notes.flatMap(noteNumber => [
				{ deltaTime: 0, type: 'noteOn' as const, channel: 0, noteNumber, velocity: 100 },
				{ deltaTime: 0, type: 'noteOn' as const, channel: 0, noteNumber: 104, velocity: 100 },
				{ deltaTime: 240, type: 'noteOff' as const, channel: 0, noteNumber: 104, velocity: 0 },
				{ deltaTime: 0, type: 'noteOn' as const, channel: 0, noteNumber: noteNumber + 1, velocity: 100 }, // on the tap's end tick
				{ deltaTime: 10, type: 'noteOff' as const, channel: 0, noteNumber, velocity: 0 },
				{ deltaTime: 0, type: 'noteOff' as const, channel: 0, noteNumber: noteNumber + 1, velocity: 0 },
			]),
			{ deltaTime: 0, type: 'endOfTrack' as const },
		]
		const midi = new Uint8Array(writeMidi({
			header: { format: 1, numTracks: 3, ticksPerBeat: 480 },
			tracks: [[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }], guitar([96]), guitar([84])],
		}))
		const parsed = parseChartAndIni([{ fileName: 'notes.mid', data: midi }]).parsedChart!
		expect(parsed.trackData.map(track => `${track.instrument}:${track.difficulty}`)).toEqual(['guitar:expert'])
		const [, endTickGroup] = parsed.trackData[0].noteEventGroups
		expect(endTickGroup[0].flags & noteFlags.tap).toBeTruthy()
	})
})
