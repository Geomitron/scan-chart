import { describe, expect, it } from 'vitest'

import { chartAuthoredTracks } from 'src/chart/authored-view'
import { chartEventEdits, chartEventInsertEdit, editChartLines } from 'src/chart/chart-edit'
import { tokenizeChartFile } from 'src/chart/chart-file-parser'
import { eventTypes } from 'src/chart/raw-types'

const head = '[Song]\r\n{\r\n  Resolution = 192\r\n}\r\n[SyncTrack]\r\n{\r\n  0 = B 120000\r\n}\r\n'
const drums = (lines: string[]) => `${head}[ExpertDrums]\r\n{\r\n${lines.map(line => `  ${line}\r\n`).join('')}}\r\n`
const tokens = (text: string) => tokenizeChartFile(new TextEncoder().encode(text))
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const drumEvents = (file: ReturnType<typeof tokens>) => chartAuthoredTracks(file)[0].events

describe('.chart line edits', () => {
	it('change an event\'s length in place, keeping every other byte', () => {
		const file = tokens(drums(['0 = N 0 0', '192 = N 1 0', '384 = N 2 0']))
		const [, red] = drumEvents(file)
		const edited = editChartLines(file, chartEventEdits(file, red, { length: 96 }))
		expect(decode(edited.bytes)).toBe(drums(['0 = N 0 0', '192 = N 1 96', '384 = N 2 0']))
	})

	it('move an event to its place in tick order when its tick changes', () => {
		const file = tokens(drums(['0 = N 0 0', '192 = N 1 0', '384 = N 2 0']))
		const [, , yellow] = drumEvents(file)
		const edited = editChartLines(file, chartEventEdits(file, yellow, { tick: 96 }))
		expect(decode(edited.bytes)).toBe(drums(['0 = N 0 0', '96 = N 2 0', '192 = N 1 0']))
	})

	it('insert a new event in tick order with the section\'s indentation and line endings', () => {
		const file = tokens(drums(['0 = N 0 0', '384 = N 2 0']))
		const edited = editChartLines(file, [chartEventInsertEdit(file, 2, 192, eventTypes.redDrum, 0)])
		expect(decode(edited.bytes)).toBe(drums(['0 = N 0 0', '192 = N 1 0', '384 = N 2 0']))
		expect(drumEvents(edited).map(event => [event.tick, event.type])).toEqual([[0, eventTypes.kick], [192, eventTypes.redDrum], [384, eventTypes.yellowDrum]])
	})

	it('delete a line with its line ending', () => {
		const file = tokens(drums(['0 = N 0 0', '192 = N 1 0']))
		const edited = editChartLines(file, [{ kind: 'delete', section: 2, line: drumEvents(file)[0].source.line }])
		expect(decode(edited.bytes)).toBe(drums(['192 = N 1 0']))
	})

	it('edit a UTF-16 file in its own encoding', () => {
		const text = drums(['0 = N 0 0'])
		const bytes = new Uint8Array(2 + text.length * 2)
		bytes.set([0xff, 0xfe])
		for (let i = 0; i < text.length; i++) new DataView(bytes.buffer).setUint16(2 + i * 2, text.charCodeAt(i), true)
		const file = tokenizeChartFile(bytes)
		const edited = editChartLines(file, chartEventEdits(file, drumEvents(file)[0], { length: 48 }))
		expect(edited.encoding).toBe('utf-16le')
		expect(edited.text).toBe(drums(['0 = N 0 48']))
	})

	it('refuse a length for a text event, which .chart can\'t store', () => {
		const file = tokens(drums(['0 = E solo', '0 = N 0 0', '192 = E soloend']))
		expect(() => chartEventEdits(file, drumEvents(file)[0], { length: 96 })).toThrow('A .chart text event has no length')
	})

	it('refuse two edits of the same line', () => {
		const file = tokens(drums(['0 = N 0 0']))
		const line = drumEvents(file)[0].source.line
		expect(() => editChartLines(file, [{ kind: 'delete', section: 2, line }, { kind: 'replace', section: 2, line, text: '0 = N 1 0' }]))
			.toThrow('Two edits touch the same line')
	})
})
