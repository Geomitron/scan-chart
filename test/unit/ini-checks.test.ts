import { describe, expect, it } from 'vitest'

import { defaultMetadata } from 'src/ini/metadata'
import { scanSongFolder, type ScanOptions } from 'src/scan-song-folder'

import { expertChart, midi } from './helpers/chart-files'

const encode = (text: string) => new TextEncoder().encode(text)
const chartFile = (sections: string[] = [], song: string[] = []) => encode(['[Song]', '{', '  Resolution = 192', ...song.map(line => `  ${line}`), '}',
	'[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}',
	'[ExpertSingle]', '{', '  768 = N 0 0', '}', ...sections].join('\r\n') + '\r\n')

/** The song.ini issues of a `.chart` song whose song.ini has `lines`, as `[code, message]`, for the codes asked for, with style notes. */
async function iniIssues(lines: string[], codes: readonly string[], options: ScanOptions = { styleNotes: true }, chart = chartFile()) {
	const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: encode(lines.join('\r\n') + '\r\n') }], options)
	const issues = scanned.issues.filter(issue => codes.includes(issue.code))
	for (const issue of issues) expect(issue).toMatchObject({ scope: 'metadata', file: 'song.ini' })
	return issues.map(issue => [issue.code, issue.message])
}

describe('song.ini layout', () => {
	const codes = ['iniLayout']

	it('accepts [song] in any letter case, after blank lines, with comments after it', async () => {
		expect(await iniIssues(['', '[Song]', '; A comment', 'name = Song'], codes)).toEqual([])
	})

	it('reports a line before [song], another section, and comments that don\'t start with ";"', async () => {
		expect(await iniIssues(['name = Song', '[song]', '# old', '// older', 'artist = Band', '[Other]', 'key = value'], codes)).toEqual([
			['iniLayout', 'Line 1 of "song.ini" comes before "[song]". Start the file with "[song]".'],
			['iniLayout', 'Line 3 of "song.ini" is a comment that starts with "#". Start comments with ";".'],
			['iniLayout', 'Line 4 of "song.ini" is a comment that starts with "//", which some readers read as a tag. Start comments with ";".'],
			['iniLayout', '"song.ini" has a "[Other]" section. Games read only "[song]": move its tags there, or remove it.'],
		])
	})

	it('reports a ";" comment before [song], since YARG then ignores the file', async () => {
		expect(await iniIssues(['', '; A comment', '[song]', 'name = Song'], codes))
			.toEqual([['iniLayout', 'Line 2 of "song.ini" comes before "[song]". Start the file with "[song]".']])
	})

	it('reports a second [song] section once, since YARG reads only the last', async () => {
		expect(await iniIssues(['[song]', 'name = Song', '[Other]', 'key = value', '[SONG]', 'artist = Band', '[song]', 'year = 2001'], codes)).toEqual([
			['iniLayout', '"song.ini" has a "[Other]" section. Games read only "[song]": move its tags there, or remove it.'],
			['iniLayout', 'Line 5 of "song.ini" starts a second "[song]" section. Clone Hero reads the sections as one, and YARG only the last: write every tag in one "[song]" section.'],
		])
	})
})

describe('song.ini tags', () => {
	it('reports the first tag out of the standard order', async () => {
		expect(await iniIssues(['[song]', 'name = Song', 'charter = Me', 'artist = Band', 'year = 2001'], ['iniTagOrder']))
			.toEqual([['iniTagOrder', 'In "song.ini", "artist" should come before "charter".']])
		expect(await iniIssues(['[song]', 'name = Song', 'explicit_lyrics = True', 'playlist = Pack', 'modchart = True'], ['iniTagOrder']))
			.toEqual([['iniTagOrder', 'In "song.ini", "playlist" should come before "explicit_lyrics".']])
		expect(await iniIssues(['[song]', 'name = Song', 'link_name_a = Site', 'artist = Band', 'pro_drums = True'], ['iniTagOrder'])).toEqual([])
	})

	/** The keys only YARG reads, as the metadata page's "Read by YARG only" table lists them, with its "Part credits" for the charter_ keys. */
	const yargOnlyKeys = [
		'preview', 'video_end_time', 'video_loop', 'background', 'video', 'cover', 'rating', 'tags',
		'diff_vocals_harm', 'diff_guitar_real', 'diff_guitar_real_22', 'diff_bass_real', 'diff_bass_real_22', 'diff_keys_real', 'diff_elite_drums',
		'sub_genre', 'covered_by', 'date_released', 'location',
		'credit_album_art_designed_by', 'credit_arranged_by', 'credit_background', 'credit_composed_by', 'credit_courtesy_of', 'credit_engineered_by',
		'credit_license', 'credit_mastered_by', 'credit_mixed_by', 'credit_other', 'credit_performed_by', 'credit_produced_by', 'credit_published_by',
		'credit_written_by',
		'charter_guitar', 'charter_rhythm', 'charter_bass', 'charter_drums', 'charter_elite_drums', 'charter_keys', 'charter_pro_guitar', 'charter_pro_bass',
		'charter_pro_keys', 'charter_guitar_6f', 'charter_rhythm_6f', 'charter_bass_6f', 'charter_vocals', 'charter_lower_diff', 'charter_venue', 'charter_audio',
		'link_bandcamp', 'link_bluesky', 'link_facebook', 'link_instagram', 'link_spotify', 'link_twitter', 'link_other', 'link_youtube',
		'vocal_gender', 'vocal_scroll_speed', 'clean_vocals', 'venue_hint', 'vocal_character_hint', 'tuning_offset_cents',
	]

	it('orders the keys only YARG reads as the metadata page lists them, after explicit_lyrics and before the deprecated keys', async () => {
		const ordered = ['[song]', 'name = Song', 'explicit_lyrics = True', ...yargOnlyKeys.map(key => `${key} = 1`), 'delay = 50', 'pro_drums = True', 'link_name_a = Site']
		expect(await iniIssues(ordered, ['iniTagOrder'])).toEqual([])
		expect(Object.keys(defaultMetadata).filter(key => yargOnlyKeys.includes(key))).toHaveLength(yargOnlyKeys.length)
		expect(await iniIssues(['[song]', 'name = Song', 'rating = 1', 'artist = Band'], ['iniTagOrder']))
			.toEqual([['iniTagOrder', 'In "song.ini", "artist" should come before "rating".']])
		expect(await iniIssues(['[song]', 'name = Song', 'charter_audio = A', 'charter_guitar = B'], ['iniTagOrder']))
			.toEqual([['iniTagOrder', 'In "song.ini", "charter_guitar" should come before "charter_audio".']])
		expect(await iniIssues(['[song]', 'name = Song', 'delay = 50', 'covered_by = Band'], ['iniTagOrder']))
			.toEqual([['iniTagOrder', 'In "song.ini", "covered_by" should come before "delay".']])
	})

	it('knows the keys only YARG reads, and the older names', async () => {
		const lines = ['[song]', 'name = Song', ...yargOnlyKeys.map(key => `${key} = 1`), 'frets = 1', 'track = 1', 'pro_drum = 1', 'star_power_note = 1']
		expect(await iniIssues(lines, ['unknownIniTag'])).toEqual([])
	})

	it('reports blank values and quoted values of any tag, even one no game reads', async () => {
		expect(await iniIssues(['[song]', 'name = Song', 'link_name_b =', 'custom = "Text"'], ['blankIniValue', 'quotedIniValue'])).toEqual([
			['blankIniValue', 'In "song.ini", "link_name_b" is blank or -1. Remove that line instead.'],
			['quotedIniValue', 'In "song.ini", "custom" is in quotes. Games show the quotes, and don\'t read a number in quotes, so remove them.'],
		])
	})

	it('reports blank and -1 values once, naming the tags', async () => {
		expect(await iniIssues(['[song]', 'name = Song', 'icon =', 'diff_keys = -1'], ['blankIniValue']))
			.toEqual([['blankIniValue', 'In "song.ini", "icon" and "diff_keys" are blank or -1. Remove those lines instead.']])
		expect(await iniIssues(['[song]', 'name = Song', 'loading_phrase ='], ['blankIniValue']))
			.toEqual([['blankIniValue', 'In "song.ini", "loading_phrase" is blank or -1. Remove that line instead.']])
	})

	it('reports tag order, -1 and blank text values, and lines that change nothing only as style notes', async () => {
		const lines = ['[song]', 'name = Song', 'charter = Me', 'artist = Band', 'icon =', 'diff_keys = -1', 'delay = 0']
		const codes = ['iniTagOrder', 'blankIniValue', 'defaultIniValue']
		expect(await iniIssues(lines, codes, {})).toEqual([])
		expect((await iniIssues(lines, codes)).map(([code]) => code)).toEqual(codes)
	})

	it('reports a blank number without style notes, as a warning of its own', async () => {
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chartFile() },
			{ fileName: 'song.ini', data: encode('[song]\r\nname = Song\r\ndiff_bass =\r\ntrack =\r\nicon =\r\ndiff_drums = -1\r\n') }])
		expect(scanned.issues.filter(issue => issue.code.startsWith('blankIni')).map(issue => [issue.code, issue.severity, issue.message])).toEqual([[
			'blankIniNumber', 'warning',
			'In "song.ini", "diff_bass" and "track" are blank. Clone Hero reads them as not set, and YARG as 0: remove those lines, or give them values.',
		]])
		expect(await iniIssues(['[song]', 'name = Song', 'video_end_time =', 'icon ='], ['blankIniNumber', 'blankIniValue'])).toEqual([
			['blankIniNumber', 'In "song.ini", "video_end_time" is blank. Clone Hero reads it as not set, and YARG as 0: remove that line, or give it a value.'],
			['blankIniValue', 'In "song.ini", "icon" is blank or -1. Remove that line instead.'],
		])
	})

	it('reads text -1 as text, not blank', async () => {
		const lines = ['[song]', 'name = Song', 'artist = Band', 'album = Album', 'genre = Rock', 'year = 2001', 'charter = -1', 'diff_guitar = 4', 'loading_phrase = -1', 'diff_keys = -1']
		expect(await iniIssues(lines, ['blankIniValue', 'missingValue']))
			.toEqual([['blankIniValue', 'In "song.ini", "diff_keys" is blank or -1. Remove that line instead.']])
	})

	it('reads a -1 boolean as true, not blank', async () => {
		const lines = ['[song]', 'name = Song', 'pro_drums = -1', 'eighthnote_hopo = -1', 'end_events = -1', 'diff_keys = -1']
		expect((await iniIssues(lines, ['blankIniValue', 'deprecatedIniTag', 'defaultIniValue'])).map(([code, message]) => [code, message.slice(0, 40)])).toEqual([
			['blankIniValue', 'In "song.ini", "diff_keys" is blank or -'],
			['deprecatedIniTag', '"song.ini" sets "eighthnote_hopo", which'],
			['defaultIniValue', 'In "song.ini", "end_events = -1" changes'],
		])
	})

	it('reports a quoted value as a warning', async () => {
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chartFile() }, { fileName: 'song.ini', data: encode('[song]\r\nname = "Song"\r\ndiff_guitar = "4"\r\n') }])
		expect(scanned.issues.filter(issue => issue.code === 'quotedIniValue').map(issue => [issue.severity, issue.message])).toEqual([[
			'warning', 'In "song.ini", "name" and "diff_guitar" are in quotes. Games show the quotes, and don\'t read a number in quotes, so remove them.',
		]])
	})

	it('reports tags no game reads, unless extraIniKeys lists them', async () => {
		// explicit_lyrics is Clone Hero's, video_loop the standard's, and link_name_a and sysex_slider YARG's.
		const lines = ['[song]', 'name = Song', 'playlist = Pack', 'sub_playlist = Disc 1', 'explicit_lyrics = True', 'video_loop = True', 'link_name_a = Site', 'sysex_slider = 1', 'Custom = 1', 'last_play = 2']
		expect(await iniIssues(lines, ['unknownIniTag'])).toEqual([['unknownIniTag',
			'"song.ini" has tags no game reads: "custom" and "last_play". Remove them, unless your game reads them.']])
		expect(await iniIssues(lines, ['unknownIniTag'], { extraIniKeys: ['CUSTOM', /^last_/] })).toEqual([])
		expect(await iniIssues(lines, ['unknownIniTag'], { extraIniKeys: [/^last_/] })).toEqual([['unknownIniTag',
			'"song.ini" has a tag no game reads: "custom". Remove it, unless your game reads it.']])
	})

	it('names up to four tags, then counts the rest', async () => {
		const blank = (keys: string[]) => iniIssues(['[song]', 'name = Song', ...keys.map(key => `${key} =`)], ['blankIniValue'])
		expect(await blank(['icon', 'year', 'album', 'genre'])).toEqual([['blankIniValue', 'In "song.ini", "icon", "year", "album" and "genre" are blank or -1. Remove those lines instead.']])
		expect(await blank(['icon', 'year', 'album', 'genre', 'loading_phrase']))
			.toEqual([['blankIniValue', 'In "song.ini", "icon", "year", "album" and 2 more are blank or -1. Remove those lines instead.']])
	})
})

describe('song.ini values', () => {
	const values = (lines: string[], codes: readonly string[], chart: Uint8Array = chartFile(), fileName = 'notes.chart') =>
		scanSongFolder([{ fileName, data: chart }, { fileName: 'song.ini', data: encode(['[song]', ...lines].join('\r\n') + '\r\n') }], { styleNotes: true })
			.then(scanned => scanned.issues.filter(issue => codes.includes(issue.code)).map(issue => [issue.code, issue.message]))

	it('recommends song_length, and reports a blank one as missing only', async () => {
		const codes = ['missingSongLength', 'blankIniValue']
		const missing = ['missingSongLength', 'Metadata is missing "song_length": set it to the length of the longest audio file, in milliseconds.']
		expect(await values(['name = Song'], codes)).toEqual([missing])
		expect(await values(['song_length = 0'], codes)).toEqual([missing])
		expect(await values(['song_length ='], codes)).toEqual([missing])
		expect(await values(['song_length = 200000'], codes)).toEqual([])
	})

	it('warns of a song_length shorter than the end of the chart\'s last note, sustain included', async () => {
		// The note starts at 2000 ms, and its sustain ends at 2500 ms.
		const chart = expertChart('768 = N 0 192')
		const short = (songLength: number, end = 2500) => ['shortSongLength',
			`The "song_length" value is ${songLength}, but the chart's last note ends ${end} ms into the audio. Set it to the length of the longest audio file, in milliseconds.`]
		const codes = ['shortSongLength', 'missingSongLength']
		expect(await values(['song_length = 2499'], codes, chart)).toEqual([short(2499)])
		expect(await values(['song_length = 2100'], codes, chart)).toEqual([short(2100)])
		expect(await values(['song_length = 2500'], codes, chart)).toEqual([])
		expect(await values(['song_length = 0'], codes, chart)).toEqual([['missingSongLength', expect.any(String)]])
		const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: encode('[song]\r\nsong_length = 2100\r\n') }])
		expect(scanned.issues.find(issue => issue.code === 'shortSongLength')?.severity).toBe('warning')
	})

	it('places the chart against the audio by delay, or by the .chart Offset without one, to compare song_length', async () => {
		const codes = ['shortSongLength']
		const short = (songLength: number, end: number) => [['shortSongLength',
			`The "song_length" value is ${songLength}, but the chart's last note ends ${end} ms into the audio. Set it to the length of the longest audio file, in milliseconds.`]]
		// The sustain ends at 2500 ms of the chart; a positive delay plays it later, and a negative one earlier.
		const chart = expertChart('768 = N 0 192')
		expect(await values(['song_length = 2600', 'delay = 200'], codes, chart)).toEqual(short(2600, 2700))
		expect(await values(['song_length = 2400', 'delay = -200'], codes, chart)).toEqual([])
		expect(await values(['song_length = 2200', 'delay = -200'], codes, chart)).toEqual(short(2200, 2300))
		// The note at 2000 ms, with Offset = 0.2 when song.ini has no delay.
		const offset = chartFile([], ['Offset = 0.2'])
		expect(await values(['song_length = 2100'], codes, offset)).toEqual(short(2100, 2200))
		expect(await values(['song_length = 2100', 'delay = -500'], codes, offset)).toEqual([])
	})

	it('recommends album_track, unless the album is a single', async () => {
		const codes = ['missingAlbumTrack']
		expect(await values(['album = Album'], codes)).toEqual([['missingAlbumTrack', 'Metadata is missing "album_track": set it to the song\'s position on its album.']])
		expect(await values(['album = Album', 'album_track = 3'], codes)).toEqual([])
		expect(await values(['album = Song - (Single)'], codes)).toEqual([])
		expect(await values(['album = N/A'], codes)).toEqual([])
		expect(await values(['album = Song - Single'], codes)).toEqual([])
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
		expect(await values(['frets = Someone'], codes)).toEqual([['deprecatedIniTag', '"song.ini" sets "charter" with "frets", its name in older charts. Write "charter" instead.']])
		expect(await values(['track = 3'], codes)).toEqual([['deprecatedIniTag', '"song.ini" sets "album_track" with "track", its name in older charts. Write "album_track" instead.']])
		expect(await values(['pro_drum = True', 'star_power_note = 116'], codes)).toEqual([
			['deprecatedIniTag', '"song.ini" sets "pro_drums" with "pro_drum", its name in older charts. Write "pro_drums" instead.'],
			['deprecatedIniTag', '"song.ini" sets "multiplier_note" with "star_power_note", its name in older charts. Write "multiplier_note" instead.'],
		])
		const unchanged = ['delay = 0', 'hopo_frequency = 0', 'eighthnote_hopo = 0', 'charter = Me', 'frets = Someone', 'album_track = 2', 'track = 3', 'multiplier_note = 103',
			'star_power_note = 116', 'pro_drums = False', 'pro_drum = True']
		expect(await values(unchanged, codes)).toEqual([])
		expect(await values(['charter =', 'frets = Someone', 'album_track = -1', 'track = 3', 'multiplier_note =', 'star_power_note = 116'], codes)).toEqual([])
	})

	it('reports multiplier_note = 103 in a .mid chart, or star_power_note = 103 without it', async () => {
		const mid = midi({ 'PART GUITAR': [{ tick: 1920, noteNumber: 96 }] })
		const message = (key: string) => ['deprecatedIniTag',
			`"song.ini" sets "${key}" to 103, which makes MIDI note 103 the star power note. Move the star power phrases to note 116 first. Then remove the tag.`]
		expect(await values(['multiplier_note = 103'], ['deprecatedIniTag'], mid, 'notes.mid')).toEqual([message('multiplier_note')])
		expect(await values(['star_power_note = 103'], ['deprecatedIniTag'], mid, 'notes.mid')).toEqual([message('star_power_note')])
		expect(await values(['multiplier_note = 103', 'star_power_note = 116'], ['deprecatedIniTag'], mid, 'notes.mid')).toEqual([message('multiplier_note')])
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

describe('song.ini default values', () => {
	const unneeded = async (lines: string[], chart: Uint8Array = chartFile(), fileName = 'notes.chart') => {
		const scanned = await scanSongFolder([{ fileName, data: chart }, { fileName: 'song.ini', data: encode(['[song]', ...lines].join('\r\n') + '\r\n') }], { styleNotes: true })
		return scanned.issues.filter(issue => issue.code === 'defaultIniValue').map(issue => issue.message)
	}

	it('reports values games read the same without, once', async () => {
		expect(await unneeded(['delay = 0'])).toEqual(['In "song.ini", "delay = 0" changes nothing: games read the song the same without it. Remove that line.'])
		expect(await unneeded(['charter = Me', 'delay = 0', 'modchart = False', 'video_start_time = 0', 'chord_snap_threshold = 0', 'explicit_lyrics = False'])).toEqual([
			'In "song.ini", "delay = 0", "modchart = False", "video_start_time = 0" and 2 more change nothing: games read the song the same without them. Remove those lines.',
		])
		expect(await unneeded(['delay = 50', 'modchart = True', 'video_start_time = 1000', 'chord_snap_threshold = 2', 'explicit_lyrics = True'])).toEqual([])
	})

	it('reports the values of the keys only YARG reads that it reads the same without', async () => {
		expect(await unneeded(['video_loop = False', 'rating = 0', 'clean_vocals = 0', 'tuning_offset_cents = 0'])).toEqual([
			'In "song.ini", "video_loop = False", "rating = 0", "clean_vocals = 0" and "tuning_offset_cents = 0" change nothing: games read the song the same without them. Remove those lines.',
		])
		expect(await unneeded(['video_loop = True', 'rating = 3', 'clean_vocals = True', 'tuning_offset_cents = -20'])).toEqual([])
	})

	it('reports the tags for older charts that change nothing', async () => {
		const keys = async (lines: string[], chart?: Uint8Array, fileName?: string) => (await unneeded(lines, chart, fileName)).map(message => message.match(/"\w+ = /g))
		expect(await keys(['charter = Me', 'frets = Someone', 'album_track = 2', 'track = 3', 'end_events = 0'])).toEqual([['"frets = ', '"track = ', '"end_events = ']])
		// Games read a tag whenever it's in the file, whatever its value.
		for (const value of ['', '0', '-1']) expect(await keys([`charter = ${value}`.trim(), 'frets = Someone', `album_track = ${value}`.trim(), 'track = 3'])).toEqual([['"frets = ', '"track = ']])
		expect(await keys(['pro_drums = True', 'pro_drum = False', 'multiplier_note = 116', 'star_power_note = 103'])).toEqual([['"pro_drum = ', '"multiplier_note = ', '"star_power_note = ']])
		expect(await keys(['hopo_frequency = 0', 'eighthnote_hopo = 0'])).toEqual([['"hopo_frequency = ', '"eighthnote_hopo = ']])
		// Without either line, YARG reads hopofreq.
		expect(await unneeded(['hopo_frequency = 0', 'eighthnote_hopo = False', 'hopofreq = 2'])).toEqual([])
		expect(await unneeded(['hopo_frequency = 170', 'eighthnote_hopo = True', 'hopofreq = 2'])).toEqual([])
		expect(await unneeded(['frets = Someone', 'track = 3', 'hopo_frequency = 170', 'delay = 50'])).toEqual([])
		// hopo_frequency comes before eighthnote_hopo.
		expect(await keys(['hopo_frequency = 170', 'eighthnote_hopo = True'])).toEqual([['"eighthnote_hopo = ']])
		expect(await keys(['multiplier_note = 103'])).toEqual([['"multiplier_note = ']])
		const mid = midi({ 'PART GUITAR': [{ tick: 1920, noteNumber: 96 }] })
		expect(await keys(['multiplier_note = 116'], mid, 'notes.mid')).toEqual([['"multiplier_note = ']])
		// Without 116, Clone Hero reads two solos and no star power as star power.
		const solos = midi({ 'PART GUITAR': [1920, 3840].flatMap(tick => [{ tick, noteNumber: 96 }, { tick, noteNumber: 103 }]) })
		expect(await keys(['multiplier_note = 116'], solos, 'notes.mid')).toEqual([])
		expect(await keys(['multiplier_note = 103'], mid, 'notes.mid')).toEqual([])
	})

	it('reports a format\'s default only where Clone Hero and YARG agree', async () => {
		const mid = midi({ 'PART GUITAR': [{ tick: 1920, noteNumber: 96 }], 'PART DRUMS': [{ tick: 1920, noteNumber: 97 }] })
		expect(await unneeded(['sustain_cutoff_threshold = 0', 'pro_drums = False'])).toHaveLength(1)
		expect(await unneeded(['sustain_cutoff_threshold = 0', 'pro_drums = False'], mid, 'notes.mid')).toEqual([])
		expect(await unneeded(['five_lane_drums = False'], mid, 'notes.mid')).toHaveLength(1)
		const fiveLane = chartFile(['[ExpertDrums]', '{', '  768 = N 5 0', '}'])
		expect(await unneeded(['five_lane_drums = False'], fiveLane)).toEqual([])
	})
})
