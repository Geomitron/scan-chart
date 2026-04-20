/**
 * Tests for writeIniFile: serializing IniMetadata back to song.ini text.
 */

import { describe, expect, it } from 'vitest'

import { defaultMetadata, scanIni } from '../ini/ini-scanner'
import { writeIniFile } from '../ini/ini-writer'

function parseOutput(out: string): { lines: string[]; headerIndex: number } {
	const lines = out.split('\r\n').filter(l => l.length > 0)
	return { lines, headerIndex: lines.indexOf('[song]') }
}

describe('writeIniFile', () => {
	it('writes a [song] header even for empty metadata', () => {
		const out = writeIniFile({})
		const { lines, headerIndex } = parseOutput(out)
		expect(headerIndex).toBe(0)
		expect(lines).toHaveLength(1)
	})

	it('uses CRLF line endings and terminates with a newline', () => {
		const out = writeIniFile({ name: 'Song', artist: 'Artist' })
		expect(out).toMatch(/\r\n$/)
		expect(out.split('\r\n')).toEqual(['[song]', 'name = Song', 'artist = Artist', ''])
	})

	it('skips fields whose value is undefined', () => {
		const out = writeIniFile({ name: 'Song', artist: undefined, album: 'Album' })
		const { lines } = parseOutput(out)
		expect(lines).toEqual(['[song]', 'name = Song', 'album = Album'])
	})

	it('emits booleans as "True"/"False"', () => {
		const out = writeIniFile({ pro_drums: true, modchart: false, five_lane_drums: true })
		expect(out).toContain('pro_drums = True')
		expect(out).toContain('modchart = False')
		expect(out).toContain('five_lane_drums = True')
	})

	it('emits numbers without quoting', () => {
		const out = writeIniFile({ diff_drums: 5, delay: -250 })
		expect(out).toContain('diff_drums = 5')
		expect(out).toContain('delay = -250')
	})

	it('emits known fields in the canonical defaultMetadata order', () => {
		// Provide fields in a shuffled order to confirm output order is driven by defaultMetadata.
		const out = writeIniFile({
			pro_drums: true,
			artist: 'A',
			name: 'N',
			diff_guitar: 1,
			year: '2020',
		})
		const { lines } = parseOutput(out)
		const bodyLines = lines.slice(1) // drop [song]
		const expectedOrder = ['name = N', 'artist = A', 'year = 2020', 'diff_guitar = 1', 'pro_drums = True']
		expect(bodyLines).toEqual(expectedOrder)
	})

	it('appends extraIniFields after known fields', () => {
		const out = writeIniFile({
			name: 'N',
			extraIniFields: { rating: '1', vocal_gender: 'male' },
		})
		const { lines } = parseOutput(out)
		expect(lines).toEqual(['[song]', 'name = N', 'rating = 1', 'vocal_gender = male'])
	})

	it('round-trips through scanIni for all known field types', () => {
		const metadata = {
			name: 'Round Trip',
			artist: 'Tester',
			album: 'Test Album',
			genre: 'Rock',
			year: '2023',
			charter: 'Me',
			song_length: 180000,
			diff_guitar: 3,
			diff_drums: 5,
			delay: -50,
			hopo_frequency: 170,
			eighthnote_hopo: true,
			multiplier_note: 116,
			modchart: false,
			pro_drums: true,
			five_lane_drums: false,
			end_events: true,
			extraIniFields: { rating: '2', playlist: 'Test' },
		}
		const out = writeIniFile(metadata)
		const parsed = scanIni([{ fileName: 'song.ini', data: new TextEncoder().encode(out) }])

		expect(parsed.metadata).not.toBeNull()
		for (const key of Object.keys(metadata) as (keyof typeof metadata)[]) {
			if (key === 'extraIniFields') continue
			expect(parsed.metadata![key as keyof typeof defaultMetadata]).toEqual(metadata[key])
		}
		expect(parsed.unknownIniValues).toEqual(metadata.extraIniFields)
	})
})
