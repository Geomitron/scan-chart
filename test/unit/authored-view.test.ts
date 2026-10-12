import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { authoredTrack, chartAuthoredTracks, midiAuthoredTracks } from 'src/chart/authored-view'
import { tokenizeChartFile } from 'src/chart/chart-file-parser'
import { readMidiTokens } from 'src/chart/midi-tokens'
import { eventTypes } from 'src/chart/raw-types'

const chart = (text: string) => tokenizeChartFile(new TextEncoder().encode(text.replace(/\n/g, '\r\n')))

describe('.chart authored view', () => {
	it('lists each instrument section\'s lines in file order, with solos as written and each line as its source', () => {
		const [track] = chartAuthoredTracks(chart([
			'[Song]', '{', '  Resolution = 192', '}',
			'[ExpertSingle]', '{',
			'  384 = N 1 0',
			'  0 = N 0 96',
			'  0 = N 5 0',
			'  0 = S 2 192',
			'  0 = E solo',
			'  192 = E soloend',
			'  192 = E crowd_clap',
			'}',
		].join('\n')))
		expect(track).toMatchObject({ instrument: 'guitar', difficulty: 'expert', sectionName: 'ExpertSingle', section: 1, isRead: true })
		expect(track.events.map(event => [event.tick, event.type, event.length, event.source.line])).toEqual([
			[384, eventTypes.red, 0, 1],
			[0, eventTypes.green, 96, 2],
			[0, eventTypes.forceUnnatural, 0, 3],
			[0, eventTypes.starPower, 192, 4],
			[0, eventTypes.soloSectionStart, 0, 5],
			[192, eventTypes.soloSectionEnd, 0, 6],
		])
		expect(track.textEvents).toEqual([{ tick: 192, text: 'crowd_clap', source: { format: 'chart', section: 1, line: 7 } }])
	})

	it('keeps a repeated section and marks which one classification reads', () => {
		const tracks = chartAuthoredTracks(chart('[ExpertDrums]\n{\n  0 = N 0 0\n}\n[ExpertDrums]\n{\n  0 = N 1 0\n}\n'))
		expect(tracks.map(track => [track.section, track.isRead, track.events.length])).toEqual([[0, false, 1], [1, true, 1]])
	})
})

describe('.mid authored view', () => {
	it('pairs each note and phrase from its start and end events, with instrument-wide events in instrument scope', () => {
		const on = (deltaTime: number, noteNumber: number) => ({ deltaTime, type: 'noteOn' as const, channel: 0, noteNumber, velocity: 100 })
		const off = (deltaTime: number, noteNumber: number) => ({ deltaTime, type: 'noteOff' as const, channel: 0, noteNumber, velocity: 0 })
		const bytes = writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
			tracks: [
				[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
				[
					{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' }, // 0
					on(0, 116), // 1: star power, every difficulty
					on(0, 101), // 2: forced HOPO, Expert
					on(0, 96), // 3: Expert green
					off(10, 96), // 4
					off(0, 101), // 5
					on(470, 85), // 6: Hard red
					off(10, 85), // 7
					off(470, 116), // 8
					{ deltaTime: 0, type: 'endOfTrack' },
				],
			],
		})
		const [track] = midiAuthoredTracks(readMidiTokens(new Uint8Array(bytes)))
		expect(track).toMatchObject({ instrument: 'guitar', chunk: 1, isFirst: true })
		expect(track.events.map(event => [event.tick, event.type, event.length, event.scope, event.source.events])).toEqual([
			[0, eventTypes.starPower, 960, 'instrument', [1, 8]],
			[0, eventTypes.forceHopo, 10, 'expert', [2, 5]],
			[0, eventTypes.green, 10, 'expert', [3, 4]],
			[480, eventTypes.red, 10, 'hard', [6, 7]],
		])

		const tokens = readMidiTokens(new Uint8Array(bytes))
		expect(authoredTrack({ format: 'mid', tokens }, 'guitar', 'hard')?.map(event => [event.type, event.scope]))
			.toEqual([[eventTypes.starPower, 'instrument'], [eventTypes.red, 'hard']])
		expect(authoredTrack({ format: 'mid', tokens }, 'guitar', 'easy')).toBeNull()
	})
})

describe('authored tracks in either format', () => {
	it('give a .chart section\'s events in its difficulty\'s scope, reading the section Clone Hero reads', () => {
		const tokens = chart('[ExpertDrums]\n{\n  0 = N 0 0\n}\n[ExpertDrums]\n{\n  0 = N 1 0\n}\n')
		expect(authoredTrack({ format: 'chart', tokens }, 'drums', 'expert')?.map(event => [event.type, event.scope, event.source]))
			.toEqual([[eventTypes.redDrum, 'expert', { format: 'chart', section: 1, line: 1 }]])
		expect(authoredTrack({ format: 'chart', tokens }, 'drums', 'hard')).toBeNull()
	})
})
