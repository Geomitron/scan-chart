import { describe, expect, it } from 'vitest'

import { keyList } from 'src/ini/ini-checks'
import { scanSongFolder, type ScanOptions } from 'src/scan-song-folder'

const encode = (text: string) => new TextEncoder().encode(text)
const chartFile = (sections: string[] = [], song: string[] = []) => encode(['[Song]', '{', '  Resolution = 192', ...song.map(line => `  ${line}`), '}',
	'[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}',
	'[ExpertSingle]', '{', '  768 = N 0 0', '}', ...sections].join('\r\n') + '\r\n')

/** The song.ini issues of a `.chart` song whose song.ini has `lines`, as `[code, message]`, for the codes asked for. */
async function iniIssues(lines: string[], codes: readonly string[], options: ScanOptions = {}, chart = chartFile()) {
	const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: encode(lines.join('\r\n') + '\r\n') }], options)
	const issues = scanned.issues.filter(issue => codes.includes(issue.code))
	for (const issue of issues) expect(issue).toMatchObject({ scope: 'metadata', file: 'song.ini' })
	return issues.map(issue => [issue.code, issue.message])
}

describe('song.ini layout', () => {
	const codes = ['iniLayout']

	it('accepts [song] in any letter case, after comments and blank lines', async () => {
		expect(await iniIssues(['; A comment', '', '[Song]', 'name = Song'], codes)).toEqual([])
	})

	it('reports a line before [song], another section, and comments that don\'t start with ";"', async () => {
		expect(await iniIssues(['name = Song', '[song]', '# old', '// older', 'artist = Band', '[Other]', 'key = value'], codes)).toEqual([
			['iniLayout', 'Line 1 of "song.ini" comes before "[song]". Start the file with "[song]".'],
			['iniLayout', 'Line 3 of "song.ini" is a comment that starts with "#". Start comments with ";".'],
			['iniLayout', 'Line 4 of "song.ini" is a comment that starts with "//", which some readers read as a tag. Start comments with ";".'],
			['iniLayout', '"song.ini" has a "[Other]" section. Games read only "[song]": move its tags there, or remove it.'],
		])
	})
})

describe('song.ini tags', () => {
	it('reports the first tag out of the standard order', async () => {
		expect(await iniIssues(['[song]', 'name = Song', 'charter = Me', 'artist = Band', 'year = 2001'], ['iniTagOrder']))
			.toEqual([['iniTagOrder', 'In "song.ini", "artist" should come before "charter".']])
		expect(await iniIssues(['[song]', 'name = Song', 'rating = 1', 'artist = Band', 'pro_drums = True'], ['iniTagOrder'])).toEqual([])
	})

	it('reports blank and -1 values once, naming the tags', async () => {
		expect(await iniIssues(['[song]', 'name = Song', 'icon =', 'diff_keys = -1'], ['blankIniValue']))
			.toEqual([['blankIniValue', 'In "song.ini", "icon" and "diff_keys" are blank or -1. Remove those lines instead.']])
		expect(await iniIssues(['[song]', 'name = Song', 'loading_phrase ='], ['blankIniValue']))
			.toEqual([['blankIniValue', 'In "song.ini", "loading_phrase" is blank or -1. Remove that line instead.']])
	})

	it('reports a quoted value as a warning', async () => {
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chartFile() }, { fileName: 'song.ini', data: encode('[song]\r\nname = "Song"\r\ndiff_guitar = "4"\r\n') }])
		expect(scanned.issues.filter(issue => issue.code === 'quotedIniValue').map(issue => [issue.severity, issue.message])).toEqual([[
			'warning', 'In "song.ini", "name" and "diff_guitar" are in quotes. Games show the quotes, and don\'t read a number in quotes, so remove them.',
		]])
	})

	it('reports tags no reader documents, unless extraIniKeys lists them', async () => {
		const lines = ['[song]', 'name = Song', 'explicit_lyrics = True', 'video_loop = True', 'link_name_a = Site', 'banner_link_a = x', 'Custom = 1']
		expect(await iniIssues(lines, ['unknownIniTag'])).toEqual([['unknownIniTag',
			'"song.ini" has tags that aren\'t in the song.ini standard: "link_name_a", "banner_link_a" and "custom". Remove them, unless a game you chart for reads them.']])
		expect(await iniIssues(lines, ['unknownIniTag'], { extraIniKeys: ['CUSTOM', /^(link|banner)_/] })).toEqual([])
	})

	it('names up to four tags, then counts the rest', () => {
		expect(keyList(['a'])).toBe('"a"')
		expect(keyList(['a', 'b', 'c', 'd'])).toBe('"a", "b", "c" and "d"')
		expect(keyList(['a', 'b', 'c', 'd', 'e'])).toBe('"a", "b", "c" and 2 more')
	})
})
