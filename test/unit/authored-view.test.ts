import { describe, expect, it } from 'vitest'

import { chartAuthoredTracks } from 'src/chart/authored-view'
import { tokenizeChartFile } from 'src/chart/chart-file-parser'
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
