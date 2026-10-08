import { describe, expect, it } from 'vitest'

import { decodeIni } from 'src/ini/decode-ini'
import { parseIni } from 'src/ini/parse-ini'
import { scanIni } from 'src/ini/scan-ini'
import { parseHistoricalDuration } from '../../tools/ch-identity/duration'

function utf32(text: string, littleEndian: boolean): Uint8Array {
	const points = [0xfeff, ...Array.from(text, char => char.codePointAt(0) ?? 0)]
	const bytes = new Uint8Array(points.length * 4)
	const view = new DataView(bytes.buffer)
	points.forEach((point, index) => view.setUint32(index * 4, point, littleEndian))
	return bytes
}

describe('CH INI identity parsing', () => {
	it('treats prototype property names as INI data without contaminating other songs', () => {
		const first = new TextEncoder().encode('[__PROTO__]\nsong_length = 1234\n[constructor]\nname = inherited\n[song]\n__proto__ = value')
		const parsed = parseIni(first).iniObject
		expect(Object.getPrototypeOf(parsed)).toBeNull()
		expect(Object.getPrototypeOf(parsed.song)).toBeNull()
		expect(parsed.song.__proto__).toBe('value')
		expect(parseHistoricalDuration(new TextEncoder().encode('[song]\nname = next')))
			.toEqual({ kind: 'unavailable', reason: 'missingSongLength' })
		expect(Reflect.get(Object.prototype, 'song_length')).toBeUndefined()
	})

	it('lowercases before resolving duplicates, including repeated section casing', () => {
		const data = new TextEncoder().encode(
			'[Song]\nNAME = old\nname = middle\nSong_Length = 1\n[SONG]\nNaMe = final\nSONG_LENGTH = 2345\n#name = ignored',
		)
		expect(parseIni(data).iniObject.song).toEqual({ name: 'final', song_length: '2345' })
		expect(scanIni([{ fileName: 'song.ini', data }]).metadata).toMatchObject({ name: 'final', song_length: 2345 })
		expect(parseHistoricalDuration(data)).toMatchObject({ kind: 'available', durationMs: 2345n })
	})

	it.each(['0', 'invalid', '2147483648'])('does not resurrect a prior valid length when the last value is %s', value => {
		expect(parseHistoricalDuration(new TextEncoder().encode(`[song]\nsong_length = 1234\nSONG_LENGTH = ${value}`))).toMatchObject({
			kind: 'unavailable',
			reason: value === '0' ? 'zeroSongLength' : 'invalidSongLength',
		})
	})

	const text = '[song]\nname = Café 🎸\nsong_length = 2345\n'
	const utf16be = Buffer.from(`\ufeff${text}`, 'utf16le').swap16()
	it.each([
		['UTF-8', new TextEncoder().encode(text)],
		['UTF-8 BOM', new TextEncoder().encode(`\ufeff${text}`)],
		['UTF-16 LE', Buffer.from(`\ufeff${text}`, 'utf16le')],
		['UTF-16 BE', utf16be],
		['UTF-32 LE', utf32(text, true)],
		['UTF-32 BE', utf32(text, false)],
	] satisfies [string, Uint8Array][])('reads %s before extracting metadata or legacy length', (_label, data) => {
		expect(decodeIni(data)).toBe(text)
		expect(parseHistoricalDuration(data)).toMatchObject({ kind: 'available', durationMs: 2345n })
		expect(scanIni([{ fileName: 'song.ini', data }]).metadata?.name).toBe('Café 🎸')
	})

	it('falls back to ISO-8859-1, including control bytes that Windows-1252 maps differently', () => {
		const data = Buffer.from('[song]\nname = Café\nartist = \x80\nsong_length = 2345', 'latin1')
		expect(parseIni(data).iniObject.song).toMatchObject({ name: 'Café', artist: '\x80' })
		expect(parseHistoricalDuration(data)).toMatchObject({ kind: 'available', durationMs: 2345n })
	})

	it('does not guess BOM-less UTF-16, which CH sees as UTF-8 with embedded NULs', () => {
		const data = Buffer.from('[song]\nsong_length = 2345', 'utf16le')
		expect(parseHistoricalDuration(data)).toEqual({ kind: 'unavailable', reason: 'missingSongLength' })
	})

	it('rejects invalid BOM-tagged Unicode instead of applying Latin-1 fallback', () => {
		expect(() => decodeIni(Uint8Array.of(0xef, 0xbb, 0xbf, 0xff))).toThrow()
		expect(() => decodeIni(Uint8Array.of(0xff, 0xfe, 0x61))).toThrow()
		expect(() => decodeIni(Uint8Array.of(0xff, 0xfe, 0, 0, 0))).toThrow()
		expect(() => decodeIni(Uint8Array.of(0xff, 0xfe, 0, 0, 0, 0xd8, 0, 0))).toThrow()
	})

	it('reports undecodable song.ini files as a folder issue when scanning', () => {
		const result = scanIni([{ fileName: 'song.ini', data: Uint8Array.of(0xff, 0xfe, 0x61) }])
		expect(result.metadata).toBeNull()
		expect(result.folderIssues).toEqual([expect.objectContaining({ folderIssue: 'invalidMetadata' })])
	})
})
