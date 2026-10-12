import { describe, expect, it } from 'vitest'

import { chartAuthoredTracks } from 'src/chart/authored-view'
import { chartEventEdits, chartEventInsertEdit, editChartLines } from 'src/chart/chart-edit'
import { tokenizeChartFile } from 'src/chart/chart-file-parser'
import { parseChartFileCanonicalIdentity } from 'src/chart/parse-chart-file'
import { eventTypes } from 'src/chart/raw-types'
import { noteFlags } from 'src/chart/types'

const head = '[Song]\r\n{\r\n  Resolution = 192\r\n}\r\n[SyncTrack]\r\n{\r\n  0 = B 120000\r\n}\r\n'
const drums = (lines: string[]) => `${head}[ExpertDrums]\r\n{\r\n${lines.map(line => `  ${line}\r\n`).join('')}}\r\n`
const tokens = (text: string) => tokenizeChartFile(new TextEncoder().encode(text))
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const drumEvents = (file: ReturnType<typeof tokens>) => chartAuthoredTracks(file)[0].events

describe('tokens of an edited .chart', () => {
	const sample = '[Song]\r\n{\r\n  Resolution = 192\r\n  Name = "Café"\r\n}\r\n[SyncTrack]\r\n{\r\n  0 = B 120000\r\n}\r\n'
		+ '[Events]\r\n{\r\n  0 = E "section Café"\r\n}\r\n[ExpertSingle]\r\n{\r\n  0 = N 0 0\r\n  192 = N 1 0\r\n  384 = N 2 0\r\n}\r\n'
		+ '[HardSingle]\r\n{\r\n  0 = N 0 0\r\n}\r\n'
	const encodings: [string, (text: string) => Uint8Array][] = [
		['UTF-8 with a byte-order mark', text => new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)])],
		['UTF-16 LE', text => Uint8Array.from([0xff, 0xfe, ...[...text].flatMap(char => [char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8])])],
	]
	for (const [name, encode] of encodings) {
		it(`equal the edited bytes read again, in ${name}, and edit on correctly`, () => {
			const file = tokenizeChartFile(encode(sample))
			const [expert, hard] = chartAuthoredTracks(file)
			const once = editChartLines(file, [
				...chartEventEdits(file, expert.events[1], { tick: 300 }),
				{ kind: 'delete', section: expert.section, line: 1 },
				chartEventInsertEdit(file, hard.section, 96, eventTypes.red, 48),
			])
			const reread = tokenizeChartFile(once.bytes)
			expect(once).toEqual(reread)
			// A second edit maps text to bytes through the line index the first one derived, including after every
			// line the first one inserted.
			const secondEdit = (tokens: typeof once) => {
				const [expertAfter, hardAfter] = chartAuthoredTracks(tokens)
				return editChartLines(tokens, [
					...chartEventEdits(tokens, expertAfter.events[0], { length: 77 }),
					...chartEventEdits(tokens, hardAfter.events[hardAfter.events.length - 1], { length: 33 }),
				])
			}
			const twice = secondEdit(once)
			const fromReread = secondEdit(reread)
			expect(twice.bytes).toEqual(fromReread.bytes)
			expect(twice).toEqual(tokenizeChartFile(twice.bytes))
		})
	}
})

describe('a .chart flam marker', () => {
	it('is added as N 109 on its tick, and reads back as the flam of the notes there', () => {
		const file = tokens(drums(['0 = N 0 0', '0 = N 2 0']))
		const edited = editChartLines(file, [chartEventInsertEdit(file, 2, 0, eventTypes.forceFlam, 0)])
		expect(new TextDecoder().decode(edited.bytes)).toBe(drums(['0 = N 0 0', '0 = N 2 0', '0 = N 109 0']))
		const notes = parseChartFileCanonicalIdentity(edited.bytes, 'chart').trackData[0].noteEventGroups[0]
		expect(notes.every(note => (note.flags & noteFlags.flam) !== 0)).toBe(true)
	})
})

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

	it('move an event in front of a line that is edited too', () => {
		const file = tokens(drums(['0 = N 0 0', '192 = N 1 0', '384 = N 2 0']))
		const [kick, red] = drumEvents(file)
		const edited = editChartLines(file, [...chartEventEdits(file, red, { length: 96 }), ...chartEventEdits(file, kick, { tick: 96 })])
		expect(decode(edited.bytes)).toBe(drums(['96 = N 0 0', '192 = N 1 96', '384 = N 2 0']))
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
