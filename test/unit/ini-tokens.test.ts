import { describe, expect, it } from 'vitest'

import { parseIniTokens, tokenizeIni } from 'src/ini/parse-ini'

describe('song.ini tokens', () => {
	it('keep the original bytes and the decoded text', () => {
		const bytes = new TextEncoder().encode('[song]\r\nname = Song\r\n')
		const tokens = tokenizeIni(bytes)
		expect(tokens.bytes).toBe(bytes)
		expect(parseIniTokens(tokens).iniObject.song).toEqual({ name: 'Song' })
	})

	it('tokenize a file that can\'t be decoded and report the error when it is parsed', () => {
		const utf7 = new TextEncoder().encode('+/v8[song]')
		const tokens = tokenizeIni(utf7)
		expect(tokens.text).toBeNull()
		expect(() => parseIniTokens(tokens)).toThrow('UTF-7 encoding is not supported')
	})
})
