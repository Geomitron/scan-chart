import { MidiData, writeMidi } from '@geomitron/midi-file'
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

type MidiTrack = MidiData['tracks'][number]

/** A `.mid` file with a 120 BPM conductor track and one track for each name, holding its notes. */
function midi(tracks: Record<string, readonly { tick: number; noteNumber: number }[]>): Uint8Array {
	const midiTracks = Object.entries(tracks).map(([name, notes]): MidiTrack => {
		const timed = notes.flatMap(note => [
			{ tick: note.tick, event: { type: 'noteOn', channel: 0, noteNumber: note.noteNumber, velocity: 100 } as const },
			{ tick: note.tick + 10, event: { type: 'noteOff', channel: 0, noteNumber: note.noteNumber, velocity: 0 } as const },
		]).sort((left, right) => left.tick - right.tick)
		const events: MidiTrack = [{ deltaTime: 0, type: 'trackName', text: name }]
		let previous = 0
		for (const { tick, event } of timed) {
			events.push({ ...event, deltaTime: tick - previous })
			previous = tick
		}
		return [...events, { deltaTime: 0, type: 'endOfTrack' }]
	})
	const conductor: MidiTrack = [{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }]
	return new Uint8Array(writeMidi({ header: { format: 1, numTracks: midiTracks.length + 1, ticksPerBeat: 480 }, tracks: [conductor, ...midiTracks] }))
}

describe('song.ini values', () => {
	const values = (lines: string[], codes: readonly string[], chart: Uint8Array = chartFile(), fileName = 'notes.chart') =>
		scanSongFolder([{ fileName, data: chart }, { fileName: 'song.ini', data: encode(['[song]', ...lines].join('\r\n') + '\r\n') }])
			.then(scanned => scanned.issues.filter(issue => codes.includes(issue.code)).map(issue => [issue.code, issue.message]))

	it('recommends song_length, and reports a blank one as missing only', async () => {
		const codes = ['missingSongLength', 'blankIniValue']
		const missing = ['missingSongLength', 'Metadata is missing "song_length": set it to the length of the longest audio file, in milliseconds.']
		expect(await values(['name = Song'], codes)).toEqual([missing])
		expect(await values(['song_length = 0'], codes)).toEqual([missing])
		expect(await values(['song_length ='], codes)).toEqual([missing])
		expect(await values(['song_length = 200000'], codes)).toEqual([])
	})

	it('recommends album_track, unless the album is a single', async () => {
		const codes = ['missingAlbumTrack']
		expect(await values(['album = Album'], codes)).toEqual([['missingAlbumTrack', 'Metadata is missing "album_track": set it to the song\'s position on its album.']])
		expect(await values(['album = Album', 'album_track = 3'], codes)).toEqual([])
		expect(await values(['album = Song - (Single)'], codes)).toEqual([])
		expect(await values(['name = Song'], codes)).toEqual([])
	})

	it('reports a difficulty outside 0 to 10', async () => {
		expect(await values(['diff_guitar = 12', 'diff_drums = -2', 'diff_bass = -1', 'diff_keys = 6', 'diff_guitar_real = 11'], ['difficultyRange'])).toEqual([
			['difficultyRange', 'In "song.ini", "diff_guitar" is 12. Difficulties go from 0 to 6, or up to 10 for very hard charts.'],
			['difficultyRange', 'In "song.ini", "diff_drums" is -2. Difficulties go from 0 to 6, or up to 10 for very hard charts.'],
			['difficultyRange', 'In "song.ini", "diff_guitar_real" is 11. Difficulties go from 0 to 6, or up to 10 for very hard charts.'],
		])
	})

	it('reports an icon written as a file name, or with other characters than a-z, 0-9, "-" and "_"', async () => {
		const message = (icon: string) => ['iconName', `In "song.ini", "icon" is "${icon}". Write the icon's file name without its extension, in lowercase letters, numbers, "-" and "_".`]
		expect(await values(['icon = my_icon.png'], ['iconName'])).toEqual([message('my_icon.png')])
		expect(await values(['icon = Geo'], ['iconName'])).toEqual([message('Geo')])
		expect(await values(['icon = geo-charts_2'], ['iconName'])).toEqual([])
	})

	it('reports a tag for older charts that changes how the chart reads, saying to change the chart first', async () => {
		const codes = ['deprecatedIniTag']
		expect(await values(['delay = 90'], codes)).toEqual([['deprecatedIniTag', '"song.ini" sets "delay" to 90 ms, which only older charts need. '
			+ 'Change the chart first so it plays the same without it: start the audio 90 ms earlier, by removing its first 90 ms, or move every note 90 ms later. Then remove the tag.']])
		expect((await values(['delay = -50'], codes))[0][1]).toContain('add 50 ms of silence to the start of the audio, or move every note 50 ms earlier')
		const hopos = (key: string) => ['deprecatedIniTag', `"song.ini" sets "${key}", which changes which notes are HOPOs. `
			+ 'Change the chart first so it plays the same without it, by forcing the notes that change. Then remove the tag.']
		expect(await values(['hopo_frequency = 170', 'eighthnote_hopo = 1'], codes)).toEqual([hopos('hopo_frequency')])
		expect(await values(['eighthnote_hopo = True'], codes)).toEqual([hopos('eighthnote_hopo')])
		expect(await values(['frets = Someone'], codes)).toEqual([['deprecatedIniTag', '"song.ini" names the charter with "frets", a tag for older charts. Write "charter" instead.']])
		expect(await values(['track = 3'], codes)).toEqual([['deprecatedIniTag', '"song.ini" gives the album track with "track", a tag for older charts. Write "album_track" instead.']])
		const unchanged = ['delay = 0', 'hopo_frequency = 0', 'eighthnote_hopo = 0', 'charter = Me', 'frets = Someone', 'album_track = 2', 'track = 3', 'multiplier_note = 103']
		expect(await values(unchanged, codes)).toEqual([])
	})

	it('reports multiplier_note = 103 in a .mid chart', async () => {
		const mid = midi({ 'PART GUITAR': [{ tick: 1920, noteNumber: 96 }] })
		expect(await values(['multiplier_note = 103'], ['deprecatedIniTag'], mid, 'notes.mid')).toEqual([['deprecatedIniTag',
			'"song.ini" sets "multiplier_note" to 103, which makes MIDI note 103 the star power note. Move the star power phrases to note 116 first. Then remove the tag.']])
	})

	it('reports a drum type flag the chart doesn\'t need', async () => {
		const drums = (lines: string[]) => chartFile(['[ExpertDrums]', '{', ...lines.map(line => `  ${line}`), '}'])
		const codes = ['redundantDrumType']
		expect(await values(['pro_drums = True'], codes, drums(['768 = N 2 0', '768 = N 66 0']))).toEqual([['redundantDrumType',
			'"song.ini" sets "pro_drums", but games already read this drums chart as 4-lane pro. Remove the tag.']])
		expect(await values(['pro_drums = True'], codes, drums(['768 = N 2 0']))).toEqual([])
		expect(await values(['five_lane_drums = True'], codes, drums(['768 = N 5 0']))).toEqual([['redundantDrumType',
			'"song.ini" sets "five_lane_drums", but games already read this drums chart as 5-lane. Remove the tag.']])
		expect(await values(['pro_drums = True'], codes)).toEqual([['redundantDrumType', '"song.ini" sets "pro_drums", but the chart has no drums track. Remove the tag.']])
	})

	it('reports a charted instrument\'s -1 difficulty as missing, not blank', async () => {
		const issues = await values(['diff_guitar = -1', 'diff_keys = -1'], ['missingValue', 'blankIniValue'])
		expect(issues.filter(([, message]) => message.includes('diff_'))).toEqual([
			['missingValue', 'Metadata is missing a "diff_guitar" value.'],
			['blankIniValue', 'In "song.ini", "diff_keys" is blank or -1. Remove that line instead.'],
		])
	})
})
