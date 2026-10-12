import { describe, expect, it } from 'vitest'

import { chartFileSections, tokenizeChartFile } from 'src/chart/chart-file-parser'

const encode = (text: string) => new TextEncoder().encode(text)

function utf16le(text: string): Uint8Array {
	const bytes = new Uint8Array(2 + text.length * 2)
	bytes.set([0xff, 0xfe])
	for (let i = 0; i < text.length; i++) new DataView(bytes.buffer).setUint16(2 + i * 2, text.charCodeAt(i), true)
	return bytes
}

const twoSongSections = '[Song]\r\n{\r\n  Resolution = 192\r\n}\r\n[Song]\r\n{\r\n  Resolution = 480\r\n}\r\n'

describe('.chart tokens', () => {
	it('keep every section in file order, duplicates included, while reading by name takes the last', () => {
		const tokens = tokenizeChartFile(encode(twoSongSections))
		expect(tokens.sections.map(section => section.name)).toEqual(['Song', 'Song'])
		expect(tokens.sections.map(section => tokens.text.slice(section.bodyStart, section.bodyEnd))).toEqual([
			'\r\n  Resolution = 192\r\n',
			'\r\n  Resolution = 480\r\n',
		])
		expect(chartFileSections(tokens)).toEqual({ Song: ['Resolution = 480'] })
	})

	it('keep the original bytes and decode without the byte-order mark', () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(twoSongSections)])
		const tokens = tokenizeChartFile(bytes)
		expect(tokens.bytes).toBe(bytes)
		expect(tokens.encoding).toBe('utf-8')
		expect(tokens.text).toBe(twoSongSections)
	})

	it('decode UTF-16 files marked by their byte-order mark', () => {
		const tokens = tokenizeChartFile(utf16le(twoSongSections))
		expect(tokens.encoding).toBe('utf-16le')
		expect(chartFileSections(tokens)).toEqual({ Song: ['Resolution = 480'] })
	})

	it('tokenize a malformed file and report its error when its sections are read', () => {
		const tokens = tokenizeChartFile(encode('}\n[Song]\n{\n}\n'))
		expect(tokens.structureError).toBe('Invalid .chart file: end of section reached before a section name was found at index 0')
		expect(() => chartFileSections(tokens)).toThrow(tokens.structureError!)
		expect(() => chartFileSections(tokenizeChartFile(encode('no sections here')))).toThrow('Invalid .chart file: no sections were found.')
	})
})
