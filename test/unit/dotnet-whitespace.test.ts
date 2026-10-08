import { describe, expect, it } from 'vitest'

import { parseIni } from 'src/ini/parse-ini'
import { scanIni } from 'src/ini/scan-ini'
import { isNullOrWhiteSpaceDotnet, removeStyleTags, toLowerInvariant, trimDotnet } from 'src/shared/text'

const dotnetWhitespace = [
	'\t', '\n', '\v', '\f', '\r', ' ', '\u0085', '\u00a0', '\u1680',
	'\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a',
	'\u2028', '\u2029', '\u202f', '\u205f', '\u3000',
]

function ini(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

describe('.NET text rules', () => {
	it.each(dotnetWhitespace.map(char => [char.codePointAt(0)!.toString(16).padStart(4, '0'), char]))('trims U+%s', (_code, char) => {
		expect(trimDotnet(`${char}${char}value${char}`)).toBe('value')
		expect(isNullOrWhiteSpaceDotnet(char)).toBe(true)
	})

	it('keeps U+FEFF and other characters that .NET does not treat as whitespace', () => {
		for (const char of ['\ufeff', '\u180e', '\u200b']) {
			expect(trimDotnet(`${char}value${char}`)).toBe(`${char}value${char}`)
			expect(isNullOrWhiteSpaceDotnet(char)).toBe(false)
		}
		expect(isNullOrWhiteSpaceDotnet('')).toBe(true)
		expect(isNullOrWhiteSpaceDotnet(null)).toBe(true)
	})

	it('trims song.ini lines, keys, and values with the .NET set', () => {
		const parsed = parseIni(ini('\u0085[song]\u00a0\n\u2003Artist\u0085=\u3000BEMANI Sound Team\u0085\nname = Name\ufeff\n')).iniObject
		expect(parsed.song).toEqual({ artist: 'BEMANI Sound Team', name: 'Name\ufeff' })
		expect(scanIni([{ fileName: 'song.ini', data: ini('[song]\nartist = BEMANI Sound Team\u0085\n') }]).metadata?.artist)
			.toBe('BEMANI Sound Team')
	})

	it('removes one byte order mark after decoding, as CH IniFile.Load does', () => {
		const bom = [0xef, 0xbb, 0xbf]
		const body = [...ini('[song]\nname = Name\n')]
		expect(parseIni(Uint8Array.from([...bom, ...bom, ...body])).iniObject.song).toEqual({ name: 'Name' })
		expect(parseIni(Uint8Array.from([...bom, ...bom, ...bom, ...body])).iniObject.song).toBeUndefined()
	})

	it('strips style tags and trims with the .NET set', () => {
		expect(removeStyleTags('<b>Name</b>\u0085')).toBe('Name')
		expect(removeStyleTags('<\u0085b>Name</\u2003b>')).toBe('Name')
		expect(removeStyleTags('Name\ufeff')).toBe('Name\ufeff')
		expect(removeStyleTags('<\ufeffb>Name')).toBe('<\ufeffb>Name')
	})

	it('lowercases each character by its simple case mapping, as ToLowerInvariant does', () => {
		expect(toLowerInvariant('MyIcon')).toBe('myicon')
		expect(toLowerInvariant('\u0391\u03a3')).toBe('\u03b1\u03c3')
		expect('\u0391\u03a3'.toLowerCase()).toBe('\u03b1\u03c2')
		expect(toLowerInvariant('PART GU\u0130TAR')).toBe('part guitar')
	})
})
