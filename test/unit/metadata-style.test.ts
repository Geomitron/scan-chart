import { describe, expect, it } from 'vitest'

import { defaultMetadata } from 'src/ini/metadata'
import { metadataStyleIssues } from 'src/ini/metadata-style'
import { scanSongFolder } from 'src/scan-song-folder'

const style = (values: Partial<typeof defaultMetadata>) => metadataStyleIssues({ ...defaultMetadata, ...values }).map(issue => [issue.metadataIssue, issue.description])
const codes = (values: Partial<typeof defaultMetadata>) => style(values).map(([code]) => code)
const encode = (text: string) => new TextEncoder().encode(text)
const chart = encode('[Song]\r\n{\r\n  Resolution = 192\r\n}\r\n[SyncTrack]\r\n{\r\n  0 = B 120000\r\n}\r\n[ExpertSingle]\r\n{\r\n  768 = N 0 0\r\n}\r\n')

describe('metadata style', () => {
	it('is reported only when metadataStyle asks for it', async () => {
		const files = [{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: encode('[song]\r\ngenre = Rock/Metal\r\n') }]
		expect((await scanSongFolder(files)).issues.map(issue => issue.code)).not.toContain('multipleGenres')
		const scanned = await scanSongFolder(files, { metadataStyle: true })
		expect(scanned.issues.filter(issue => issue.code === 'multipleGenres').map(issue => [issue.severity, issue.file])).toEqual([['recommendation', 'song.ini']])
	})

	it('reports credits joined with something other than " & "', () => {
		expect(style({ charter: 'A, B' })).toEqual([['creditSeparator', 'The charter value "A, B" lists several names. Join them with " & ".']])
		expect(codes({ charter: 'A and B' })).toEqual(['creditSeparator'])
		expect(codes({ charter: 'A & B (Drums)' })).toEqual([])
	})

	it('reports a part credit\'s name that charter doesn\'t hold', () => {
		expect(style({ charter: 'Charter A', charter_drums: 'Charter B' }))
			.toEqual([['uncreditedPartCharter', 'The charter value "Charter A" doesn\'t name "Charter B" (charter_drums). Name every part\'s charters in charter.']])
		// Each name once, in the part credits table's order.
		expect(style({ charter: 'A', charter_vocals: 'C & B', charter_guitar: 'B', charter_bass: 'A' }).map(([, description]) => description))
			.toEqual(['The charter value "A" doesn\'t name "B" (charter_guitar) or "C" (charter_vocals). Name every part\'s charters in charter.'])
	})

	it('reads a name in charter the same with its part in parentheses, in another letter case or spacing', () => {
		const uncredited = (values: Partial<typeof defaultMetadata>) => codes(values).filter(code => code === 'uncreditedPartCharter')
		expect(uncredited({ charter: 'Charter A (Guitar) & charter  b (Drums)', charter_guitar: 'Charter A', charter_drums: 'Charter B (Pro)' })).toEqual([])
		expect(uncredited({ charter: 'A & B', charter_vocals: 'A & B', charter_audio: 'B, A' })).toEqual([])
		expect(uncredited({ charter: 'Charter A (Guitar & Bass) & Charter B (Drums)', charter_guitar: 'Charter A', charter_bass: 'Charter A' })).toEqual([])
	})

	it('splits a credit at the separators creditSeparator reports, so a name isn\'t reported twice', () => {
		expect(codes({ charter: 'A / B', charter_drums: 'B' })).toEqual(['creditSeparator'])
		expect(codes({ charter: 'A and B', charter_drums: 'B' })).toEqual(['creditSeparator'])
	})

	it('compares part credits from song.ini without their style tags', async () => {
		const ini = encode('[song]\r\ncharter = <color=#ff0000>Charter A</color>\r\ncharter_guitar = <b>Charter A</b>\r\ncharter_drums = <b>Charter B</b>\r\n')
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: ini }], { metadataStyle: true })
		expect(scanned.issues.filter(issue => issue.code === 'uncreditedPartCharter').map(issue => [issue.severity, issue.file, issue.message]))
			.toEqual([['recommendation', 'song.ini', 'The charter value "Charter A" doesn\'t name "Charter B" (charter_drums). Name every part\'s charters in charter.']])
	})

	it('leaves part credits to the missing charter report when charter isn\'t set', () => {
		expect(codes({ charter_drums: 'Charter B' })).toEqual([])
	})

	it('reports two spaces in a row, but not the artist\'s own styling', () => {
		expect(style({ name: 'Song  Name' })).toEqual([['textSpacing', 'The name value "Song  Name" has two spaces in a row.']])
		expect(codes({ name: 'Come What(ever) May', artist: 'Y&T', genre: 'R&B' })).toEqual([])
	})

	it('reports a featured artist outside a title tag', () => {
		expect(style({ name: 'Song ft. Other' })).toEqual([['featuringFormat', 'The song name "Song ft. Other" names a featured artist outside a title tag. Write it as "Song (ft. Artist)".']])
		expect(codes({ artist: 'Band feat. Other' })).toEqual(['featuringFormat'])
		expect(codes({ name: 'Song (feat. Other)', artist: 'Band' })).toEqual([])
	})

	it('reports a title tag that tells charts apart before one that belongs to the song', () => {
		expect(style({ name: 'Song (Overchart) (Live)' }))
			.toEqual([['titleTagOrder', 'In the song name "Song (Overchart) (Live)", "(Overchart)" tells charts apart, so it goes after "(Live)".']])
		expect(codes({ name: 'Song (Live) (Overchart)' })).toEqual([])
	})

	it('reports a title tag in brackets, but not brackets inside a word', () => {
		expect(codes({ name: 'Song [Live]' })).toEqual(['bracketTitleTag'])
		expect(codes({ name: '[re]connect' })).toEqual([])
	})

	it('reports several genres, a year that isn\'t four digits, and a single\'s album written another way', () => {
		expect(codes({ genre: 'Rock, Metal' })).toEqual(['multipleGenres'])
		expect(style({ year: '2004-05-12' })).toEqual([['yearFormat', 'The year value "2004-05-12" should be only the year, such as "2004".']])
		expect(codes({ year: '2004' })).toEqual([])
		expect(style({ name: 'Song', album: 'Song - Single' }))
			.toEqual([['singleAlbum', 'The album value "Song - Single" marks a single. A single\'s album is its name followed by " - (Single)": "Song - (Single)".']])
		expect(codes({ name: 'Song', album: 'N/A' })).toEqual(['singleAlbum'])
		expect(codes({ name: 'Song', album: 'Song - (Single)' })).toEqual([])
		expect(style({ name: 'Song (Band cover)', album: 'Song (Single)' }))
			.toEqual([['singleAlbum', 'The album value "Song (Single)" marks a single. A single\'s album is its name followed by " - (Single)": "Song - (Single)".']])
		expect(codes({ name: 'Song (Band cover)', album: 'Song - (Single)' })).toEqual([])
	})
})
