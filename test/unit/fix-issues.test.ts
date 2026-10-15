import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { authoredTracks } from 'src/authored'
import { fixIssues, type FixOptions, issueFixes } from 'src/fix-issues'
import { resolveChart } from 'src/gameplay-chart'
import { serializeSong } from 'src/save-plan'
import { scanSongFolder } from 'src/scan-song-folder'
import { documentFiles, parseSong, type SongDocument } from 'src/song-document'
import type { SongFile } from 'src/song-files'
import type { IssueCode } from 'src/issues'
import { saveSong, songHashes } from 'src/song-save'

import { jpeg, opus, png, vorbis } from './helpers/media-files'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** A `.chart` file with a 120 BPM tempo map, and an Expert guitar track unless `sections` gives the tracks. */
const chartFile = (sections: string[] = ['[ExpertSingle]', '{', '  768 = N 0 0', '  960 = N 1 0', '}']) => encode([
	'[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}', ...sections,
].join('\r\n') + '\r\n')
const iniFile = (lines: readonly string[]) => encode(lines.join('\r\n') + '\r\n')
const folder = (iniLines: readonly string[], chart: Uint8Array = chartFile(), chartName = 'notes.chart'): SongFile[] =>
	[{ fileName: chartName, data: chart }, { fileName: 'song.ini', data: iniFile(iniLines) }, { fileName: 'song.opus', data: new Uint8Array(1) }]

type MidiTrack = MidiData['tracks'][number]

/** A `.mid` file at 480 ticks per beat and 120 BPM, with a track for each name holding its notes. */
function midi(tracks: Record<string, readonly { tick: number; noteNumber: number; length?: number }[]>): Uint8Array {
	const midiTracks = Object.entries(tracks).map(([name, notes]): MidiTrack => {
		const timed = notes.flatMap(note => [
			{ tick: note.tick, order: 1, event: { type: 'noteOn', channel: 0, noteNumber: note.noteNumber, velocity: 100 } as const },
			{ tick: note.tick + (note.length ?? 10), order: 0, event: { type: 'noteOff', channel: 0, noteNumber: note.noteNumber, velocity: 0 } as const },
		]).sort((left, right) => left.tick - right.tick || left.order - right.order)
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

/**
 * Fixes the song of `files`, and gives the report, the canonical hashes before and after, the fixed song.ini's text,
 * and the codes a scan of the saved song still reports.
 */
async function fix(files: readonly SongFile[], options: FixOptions = {}) {
	const song = await parseSong(files)
	const { song: fixed, report } = await fixIssues(song, options)
	const saved = saveSong(song, fixed).files
	const rescan = await scanSongFolder(saved, { styleNotes: true, mediaIssues: true })
	return {
		song: fixed,
		report,
		before: songHashes(song),
		after: songHashes(fixed),
		ini: fixed.ini === null ? null : decode(fixed.ini.tokens.bytes),
		codes: rescan.issues.map(issue => issue.code),
	}
}

/** The hashes are kept: the song has hashes, and the fixed song has the same. */
function expectHashesKept(result: Awaited<ReturnType<typeof fix>>) {
	expect(result.before).not.toBeNull()
	expect(result.after).toEqual(result.before)
	expect(result.report.hashes).toEqual([])
}

describe('fixIssues: song.ini', () => {
	it('writes [song] first, comments with ";", and the lines games don\'t read as comments, keeping the hashes', async () => {
		const result = await fix(folder(['name = Early', '[Song]', '# A comment', 'name = Song', 'artist = Band', '// old', '[Other]', 'key = value']), { codes: ['iniLayout'] })
		expect(result.ini).toBe('; name = Early\r\n[song]\r\n; A comment\r\nname = Song\r\nartist = Band\r\n; old\r\n; [Other]\r\n; key = value\r\n')
		expect(result.report.fixed).toEqual([{ code: 'iniLayout', file: 'song.ini', description: 'Wrote "[song]" first, comments with ";", and the lines games don\'t read as comments.' }])
		expect(result.codes).not.toContain('iniLayout')
		expectHashesKept(result)
	})

	it('puts the tags in the standard order, then the other tags games read, then the rest, with each tag\'s comments', async () => {
		const result = await fix(folder(['[song]', 'charter = Me', 'last_play = 1', '; The name', 'name = Song', 'ignored_issues = noAlbumArt', 'artist = Band']), { codes: ['iniTagOrder'] })
		expect(result.ini).toBe('[song]\r\n; The name\r\nname = Song\r\nartist = Band\r\ncharter = Me\r\nignored_issues = noAlbumArt\r\nlast_play = 1\r\n')
		expect(result.codes).not.toContain('iniTagOrder')
		expectHashesKept(result)
	})

	it('removes blank, -1, unneeded and redundant lines, and quotes, keeping the hashes', async () => {
		const result = await fix(folder(['[song]', 'name = Song', 'icon =', 'diff_bass =', 'diff_keys = -1', 'loading_phrase = "Hi"', 'delay = 0', 'modchart = False', 'pro_drums = True']))
		expect(result.ini).toBe('[song]\r\nname = Song\r\nloading_phrase = Hi\r\n')
		expect(result.report.fixed.map(({ code, description }) => [code, description])).toEqual([
			['iniTagOrder', 'Put the tags in the standard order.'],
			['blankIniValue', 'Removed "icon" and "diff_keys", which were blank or -1.'],
			['blankIniNumber', 'Removed "diff_bass", which was blank.'],
			['quotedIniValue', 'Removed the quotes around "loading_phrase".'],
			['defaultIniValue', 'Removed "delay = 0" and "modchart = False", which changed nothing.'],
			['redundantDrumType', 'Removed "pro_drums", which games read the drums the same without.'],
		])
		for (const code of ['blankIniValue', 'blankIniNumber', 'quotedIniValue', 'defaultIniValue', 'redundantDrumType']) expect(result.codes).not.toContain(code)
		expectHashesKept(result)
	})

	it('renames frets and track to charter and album_track, in their place in the standard order', async () => {
		const result = await fix(folder(['[song]', 'name = Song', 'frets = Someone', 'track = 3', 'delay = 90']), { codes: ['deprecatedIniTag'] })
		expect(result.ini).toBe('[song]\r\nname = Song\r\ncharter = Someone\r\nalbum_track = 3\r\ndelay = 90\r\n')
		expect(result.report.fixed).toEqual([{ code: 'deprecatedIniTag', file: 'song.ini', description: 'Renamed "frets" to "charter" and "track" to "album_track".' }])
		expect(result.report.skipped).toEqual([{ code: 'deprecatedIniTag', file: 'song.ini',
			reason: 'Removing "delay" moves every note against the audio: the audio or the notes have to change first.' }])
		expect(result.codes).not.toContain('iniTagOrder')
		expectHashesKept(result)
	})

	it('writes the icon\'s name in lowercase, and drops a file extension only with changeHashes, since the SongHash reads it', async () => {
		const upper = await fix(folder(['[song]', 'name = Song', 'icon = Zancharted']), { codes: ['iconName'] })
		expect(upper.ini).toContain('icon = zancharted')
		expectHashesKept(upper)

		const named = folder(['[song]', 'name = Song', 'icon = my_icon.png'])
		const kept = await fix(named, { codes: ['iconName'] })
		expect(kept.ini).toContain('icon = my_icon.png')
		expect(kept.report.skipped).toEqual([{ code: 'iconName', file: 'song.ini', reason: 'Fixing "icon" changes the SongHash: fix it with changeHashes.' }])
		expectHashesKept(kept)
		const changed = await fix(named, { codes: ['iconName'], changeHashes: true })
		expect(changed.ini).toContain('icon = my_icon\r\n')
		expect(changed.report.hashes).toEqual([{ key: 'canonical:song', before: changed.before!.get('canonical:song'), after: changed.after!.get('canonical:song') }])
		expect(changed.after!.get('canonical:song')).not.toBe(changed.before!.get('canonical:song'))

		const spaced = await fix(folder(['[song]', 'name = Song', 'icon = Half Moon']), { codes: ['iconName'] })
		expect(spaced.report.skipped).toEqual([{ code: 'iconName', file: 'song.ini',
			reason: 'Without its extension and in lowercase, "Half Moon" has other characters than a-z, 0-9, "-" and "_": choose an icon name.' }])
	})

	it('unquotes a song name, which the SongHash reads, only with changeHashes', async () => {
		const quoted = folder(['[song]', 'name = "Song"', 'artist = Band'])
		const kept = await fix(quoted)
		expect(kept.ini).toContain('name = "Song"')
		expectHashesKept(kept)
		const changed = await fix(quoted, { changeHashes: true })
		expect(changed.ini).toBe('[song]\r\nname = Song\r\nartist = Band\r\n')
		expect(changed.report.hashes.map(change => change.key)).toEqual(['canonical:song'])
	})

	it('leaves out a fix that reads alike but would change a hash, even with changeHashes', async () => {
		// The SongHash reads a blank charter as no charter, and frets only when there's no charter line.
		const credited = await fix(folder(['[song]', 'name = Song', 'charter =', 'frets = Someone']), { codes: ['blankIniValue', 'deprecatedIniTag'], changeHashes: true })
		expect(credited.ini).toBe('[song]\r\nname = Song\r\ncharter =\r\nfrets = Someone\r\n')
		expect(credited.report.skipped).toEqual([
			{ code: 'blankIniValue', file: 'song.ini', reason: 'Fixing "charter" would change the SongHash, so games would read the song differently.' },
			{ code: 'deprecatedIniTag', file: 'song.ini', reason: 'Fixing "frets" would change the SongHash, so games would read the song differently.' },
		])
		expectHashesKept(credited)

		// Without multiplier_note = 116, Clone Hero reads two solos and no star power as star power.
		const solos = midi({ 'PART GUITAR': [
			...[96, 960, 1920, 2880].map(tick => ({ tick, noteNumber: 96 })), { tick: 900, noteNumber: 103, length: 200 }, { tick: 2800, noteNumber: 103, length: 200 },
		] })
		const multiplier = await fix(folder(['[song]', 'name = Song', 'multiplier_note = 116'], solos, 'notes.mid'), { codes: ['defaultIniValue'], changeHashes: true })
		expect(multiplier.ini).toContain('multiplier_note = 116')
		expect(multiplier.report.skipped).toEqual([{ code: 'defaultIniValue', file: 'song.ini',
			reason: 'Fixing "multiplier_note = 116" would change the SongHash and a TrackHash, so games would read the song differently.' }])
		expectHashesKept(multiplier)
	})

	it('fixes only the codes asked for, and none song.ini\'s ignored_issues lists', async () => {
		const lines = ['[song]', 'charter = Me', 'name = Song', 'icon =', 'ignored_issues = iniTagOrder']
		const result = await fix(folder(lines), { codes: ['iniTagOrder', 'blankIniValue'] })
		expect(result.ini).toBe('[song]\r\ncharter = Me\r\nname = Song\r\nignored_issues = iniTagOrder\r\n')
		expect(result.report.skipped).toEqual([{ code: 'iniTagOrder', file: 'song.ini', reason: 'song.ini\'s "ignored_issues" lists it.' }])
		const only = await fix(folder(lines), { codes: ['iconName', 'unknownIniTag', 'blankIniValue'] })
		expect(only.report.fixed.map(entry => entry.code)).toEqual(['blankIniValue'])
		expect(only.report.skipped).toEqual([])
		const unfixable = await fix(folder([...lines, 'secret = 1']), { codes: ['unknownIniTag'] })
		expect(unfixable.report.skipped).toEqual([{ code: 'unknownIniTag', file: 'song.ini', reason: 'fixIssues has no fix for it.' }])
	})

	it('writes a song.ini in another encoding as UTF-8, and keeps a UTF-8 byte order mark', async () => {
		const utf16 = new Uint8Array([0xff, 0xfe, ...[...'[song]\r\ncharter = Me\r\nname = Sóng\r\n'].flatMap(character => [character.charCodeAt(0), 0])])
		const converted = await fix([{ fileName: 'notes.chart', data: chartFile() }, { fileName: 'song.ini', data: utf16 }], { codes: ['iniTagOrder'] })
		expect(converted.ini).toBe('[song]\r\nname = Sóng\r\ncharter = Me\r\n')
		expectHashesKept(converted)
		const bom = await fix([{ fileName: 'notes.chart', data: chartFile() }, { fileName: 'song.ini', data: new Uint8Array([0xef, 0xbb, 0xbf, ...iniFile(['[song]', 'charter = Me', 'name = Song'])]) }])
		expect([...bom.song.ini!.tokens.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
	})

	it('gives a song that saves with the fixes and every hash they kept, leaving the song it was given as it was', async () => {
		const files = folder(['[song]', 'charter = Me', 'name = Song', 'delay = 0'])
		const song = await parseSong(files)
		const { song: fixed } = await fixIssues(song)
		expect(decode(song.ini!.tokens.bytes)).toBe('[song]\r\ncharter = Me\r\nname = Song\r\ndelay = 0\r\n')
		const plan = serializeSong(fixed)
		expect(plan.report.spentHashes).toEqual([])
		expect(decode(plan.files.find(file => file.fileName === 'song.ini')!.pieces[0] as Uint8Array)).toBe('[song]\r\nname = Song\r\ncharter = Me\r\n')
		expect(documentFiles(fixed).map(file => file.fileName)).toEqual(files.map(file => file.fileName))
	})
})

describe('fixIssues: song_length', () => {
	const audio = [{ fileName: 'song.opus', data: opus(80) }, { fileName: 'guitar.ogg', data: vorbis(192, 12) }, { fileName: 'preview.ogg', data: vorbis(192, 30) }]
	const song = (lines: readonly string[], files: readonly SongFile[] = audio) => [{ fileName: 'notes.chart', data: chartFile() }, { fileName: 'song.ini', data: iniFile(lines) }, ...files]

	it('sets a missing song_length to the longest audio file\'s length, from its headers, keeping the hashes', async () => {
		const result = await fix(song(['[song]', 'name = Song', 'song_length =']))
		expect(result.ini).toBe('[song]\r\nname = Song\r\nsong_length = 12000\r\n')
		expect(result.report.fixed).toContainEqual({ code: 'missingSongLength', file: 'song.ini',
			description: 'Set "song_length" to 12000, the length of the longest audio file in milliseconds.' })
		expect(result.codes).not.toContain('missingSongLength')
		expectHashesKept(result)
	})

	it('sets a song_length far from the longest audio file\'s length', async () => {
		const result = await fix(song(['[song]', 'name = Song', 'song_length = 200000']), { codes: ['songLengthMismatch'] })
		expect(result.ini).toBe('[song]\r\nname = Song\r\nsong_length = 12000\r\n')
		expectHashesKept(result)
	})

	it('leaves song_length when an audio file\'s length can\'t be read', async () => {
		const result = await fix(song(['[song]', 'name = Song'], [{ fileName: 'song.opus', data: opus(80) }, { fileName: 'drums.ogg', data: new Uint8Array(4) }]))
		expect(result.ini).toBe('[song]\r\nname = Song\r\n')
		expect(result.report.skipped).toEqual([{ code: 'missingSongLength', file: 'song.ini', reason: 'The length of "drums.ogg" can\'t be read from its headers.' }])
	})
})

describe('fixIssues: files', () => {
	const song = (files: readonly SongFile[], iniLines: readonly string[] = ['[song]', 'name = Song']) =>
		[{ fileName: 'notes.chart', data: chartFile() }, { fileName: 'song.ini', data: iniFile(iniLines) }, ...files]
	const names = (result: Awaited<ReturnType<typeof fix>>) => result.song.files.map(file => file.fileName)
	/** A resizer that returns a square PNG or JPEG of the size asked for, as an app's image library would. */
	const resizeTo = (format: 'png' | 'jpeg') => async (_image: Uint8Array, size: number) => format === 'png' ? png(size, size) : jpeg(size, size)

	it('renames a file named in another letter case, or with an extension its content doesn\'t match, keeping the hashes', async () => {
		const result = await fix(song([
			{ fileName: 'Album.PNG', data: jpeg(512, 512) }, { fileName: 'Video.mp4', data: new Uint8Array(1) }, { fileName: 'song.ogg', data: opus(80) },
		]), { codes: ['fileNameCase', 'extensionMismatch'] })
		expect(names(result)).toEqual(['notes.chart', 'song.ini', 'album.jpg', 'video.mp4', 'song.opus'])
		expect(result.report.renamed).toEqual([{ from: 'Album.PNG', to: 'album.jpg' }, { from: 'Video.mp4', to: 'video.mp4' }, { from: 'song.ogg', to: 'song.opus' }])
		expect(result.report.fixed).toEqual([
			{ code: 'fileNameCase', file: 'album.jpg', description: 'Renamed "Album.PNG" to "album.png".' },
			{ code: 'extensionMismatch', file: 'album.jpg', description: 'Renamed "album.png" to "album.jpg".' },
			{ code: 'fileNameCase', file: 'video.mp4', description: 'Renamed "Video.mp4" to "video.mp4".' },
			{ code: 'extensionMismatch', file: 'song.opus', description: 'Renamed "song.ogg" to "song.opus".' },
		])
		const rescan = await scanSongFolder(result.song.files, { mediaIssues: true })
		expect(rescan.issues.map(issue => issue.code)).not.toEqual(expect.arrayContaining(['fileNameCase']))
		expect(rescan.issues.map(issue => issue.code).filter(code => code === 'extensionMismatch' || code === 'audioFormat')).toEqual([])
		expectHashesKept(result)
	})

	it('doesn\'t rename a file to another file\'s name, or one song.ini names', async () => {
		const taken = await fix(song([{ fileName: 'album.png', data: jpeg(512, 512) }, { fileName: 'album.jpg', data: jpeg(512, 512) }]), { codes: ['extensionMismatch'] })
		expect(taken.report.renamed).toEqual([])
		expect(taken.report.skipped).toEqual([{ code: 'extensionMismatch', file: 'album.png', reason: '"album.jpg" already has the name "album.jpg".' }])
		const named = await fix(song([{ fileName: 'Video.mp4', data: new Uint8Array(1) }], ['[song]', 'name = Song', 'video = Video.mp4']), { codes: ['fileNameCase'] })
		expect(named.report.skipped).toEqual([{ code: 'fileNameCase', file: 'Video.mp4', reason: 'song.ini\'s "video" names it.' }])
	})

	it('resizes square album art with resizeImage, renaming it when the format it returns differs', async () => {
		const art = song([{ fileName: 'album.jpg', data: jpeg(600, 600) }])
		const same = await fix(art, { codes: ['albumArtSize'], resizeImage: resizeTo('jpeg') })
		expect(names(same)).toContain('album.jpg')
		expect(same.song.files.find(file => file.fileName === 'album.jpg')!.data).toEqual(jpeg(512, 512))
		expect(same.report.fixed).toEqual([{ code: 'albumArtSize', file: 'album.jpg', description: 'Resized "album.jpg" from 600x600 to 512x512.' }])
		expect(same.report.renamed).toEqual([])
		expectHashesKept(same)

		const png500 = await fix(art, { codes: ['albumArtSize'], resizeImage: resizeTo('png'), albumArtSizes: [500, 512] })
		expect(png500.report.renamed).toEqual([{ from: 'album.jpg', to: 'album.png' }])
		expect(png500.report.fixed[0].description).toBe('Resized "album.jpg" from 600x600 to 500x500, as "album.png".')
		expect((await scanSongFolder(png500.song.files, { mediaIssues: true, albumArtSizes: [500, 512] })).issues.map(issue => issue.code)).not.toContain('albumArtSize')
	})

	it('leaves album art that isn\'t square, or when there\'s no resizeImage', async () => {
		const wide = await fix(song([{ fileName: 'album.jpg', data: jpeg(600, 400) }]), { codes: ['albumArtSize'], resizeImage: resizeTo('jpeg') })
		expect(wide.report.skipped).toEqual([{ code: 'albumArtSize', file: 'album.jpg', reason: 'The album art is 600x400: making it square needs it cropped.' }])
		const square = await fix(song([{ fileName: 'album.jpg', data: jpeg(600, 600) }]), { codes: ['albumArtSize'] })
		expect(square.report.skipped).toEqual([{ code: 'albumArtSize', file: 'album.jpg', reason: 'Resizing album art needs resizeImage.' }])
		const wrong = await fix(song([{ fileName: 'album.jpg', data: jpeg(600, 600) }]), { codes: ['albumArtSize'], resizeImage: async () => jpeg(256, 256) })
		expect(wrong.report.skipped).toEqual([{ code: 'albumArtSize', file: 'album.jpg', reason: 'resizeImage didn\'t return a 512x512 PNG or JPEG image.' }])
	})
})

describe('fixIssues: empty tracks and phrases', () => {
	const ini = ['[song]', 'name = Song']
	const chartText = (result: Awaited<ReturnType<typeof fix>>) => decode((result.song.chart as { tokens: { bytes: Uint8Array } }).tokens.bytes)
	const expert = (...lines: string[]) => ['[ExpertSingle]', '{', '  768 = N 0 0', '  960 = N 1 0', ...lines.map(line => `  ${line}`), '}']

	it('removes .chart sections with no notes, keeping the hashes', async () => {
		const result = await fix(folder(ini, chartFile([...expert(), '[HardSingle]', '{', '}', '[EasyDrums]', '{', '  0 = S 2 192', '}'])), { codes: ['emptyTrack'] })
		expect(chartText(result)).not.toMatch(/HardSingle|EasyDrums/)
		expect(chartText(result)).toMatch(/\[ExpertSingle\]\r\n\{\r\n {2}768 = N 0 0\r\n {2}960 = N 1 0\r\n\}\r\n$/)
		expect(result.report.fixed.map(entry => entry.description)).toEqual(['Removed the [HardSingle] section, which has no notes.', 'Removed the [EasyDrums] section, which has no notes.'])
		expect(result.codes).not.toContain('emptyTrack')
		expectHashesKept(result)
	})

	it('keeps an empty section whose drum markers decide the drum type', async () => {
		const result = await fix(folder(ini, chartFile([...expert(), '[ExpertDrums]', '{', '  768 = N 2 0', '}', '[EasyDrums]', '{', '  0 = N 66 0', '}'])), { codes: ['emptyTrack'] })
		expect(chartText(result)).toContain('[EasyDrums]')
		expect(result.report.skipped).toEqual([{ code: 'emptyTrack', file: 'notes.chart', reason: 'Removing the [EasyDrums] section would change the drum type.' }])
		expectHashesKept(result)
	})

	it('removes .mid tracks with no notes, keeping the hashes', async () => {
		const result = await fix(folder(ini, midi({ 'PART GUITAR': [{ tick: 1920, noteNumber: 96 }], 'PART BASS': [], 'PART KEYS': [{ tick: 0, noteNumber: 116, length: 480 }] }), 'notes.mid'),
			{ codes: ['emptyTrack'] })
		expect(result.report.fixed.map(entry => entry.description)).toEqual(['Removed the "PART BASS" track, which has no notes.', 'Removed the "PART KEYS" track, which has no notes.'])
		const chart = result.song.chart as { tokens: { header: { header: { numTracks: number } } } }
		expect(chart.tokens.header.header.numTracks).toBe(2)
		expect(result.codes).not.toContain('emptyTrack')
		expectHashesKept(result)
	})

	it('removes .chart star power, solo and flex lane phrases with no notes, keeping the hashes', async () => {
		const result = await fix(folder(ini, chartFile(expert('768 = S 2 100', '1536 = S 2 192', '1536 = E solo', '1700 = E soloend', '1800 = S 65 100'))))
		expect(chartText(result)).toContain('768 = S 2 100')
		expect(chartText(result)).not.toMatch(/1536 = S 2|E solo|1800 = S 65/)
		expect(result.report.fixed.filter(entry => entry.code.startsWith('empty')).map(entry => entry.description)).toEqual([
			'Removed the expert guitar star power phrase with no notes at tick 1536.',
			'Removed the expert guitar solo phrase with no notes at tick 1536.',
			'Removed the expert guitar flex lane phrase with no notes at tick 1800.',
		])
		for (const code of ['emptyStarPower', 'emptySoloSection', 'emptyFlexLane']) expect(result.codes).not.toContain(code)
		expectHashesKept(result)
	})

	it('keeps a flex lane that ends on a note, which the hashes count as in it', async () => {
		const result = await fix(folder(ini, chartFile(expert('800 = S 65 160'))), { codes: ['emptyFlexLane'] })
		expect(chartText(result)).toContain('800 = S 65 160')
		expect(result.report.skipped).toEqual([{ code: 'emptyFlexLane', file: 'notes.chart',
			reason: 'Removing the expert guitar flex lane phrase at tick 800 would change the SongHash and a TrackHash.' }])
		expectHashesKept(result)
	})

	it('removes a .mid phrase only when no difficulty has notes in it', async () => {
		const notes = [{ tick: 0, noteNumber: 96 }, { tick: 960, noteNumber: 96 }, { tick: 0, noteNumber: 84 }, { tick: 1920, noteNumber: 84 }]
		const result = await fix(folder(ini, midi({ 'PART GUITAR': [...notes, { tick: 900, noteNumber: 116, length: 120 }, { tick: 2400, noteNumber: 116, length: 120 }] }), 'notes.mid'),
			{ codes: ['emptyStarPower'] })
		expect(result.report.fixed.map(entry => entry.description)).toEqual(['Removed the guitar star power phrase with no notes at tick 2400.'])
		expect(result.report.skipped).toEqual([{ code: 'emptyStarPower', file: 'notes.mid', reason: 'The guitar star power phrase at tick 900 has notes on another difficulty.' }])
		expectHashesKept(result)
	})
})

describe('fixIssues: sustains', () => {
	const ini = ['[song]', 'name = Song']
	const chartText = (result: Awaited<ReturnType<typeof fix>>) => decode((result.song.chart as { tokens: { bytes: Uint8Array } }).tokens.bytes)
	const expert = (...lines: string[]) => chartFile(['[ExpertSingle]', '{', ...lines.map(line => `  ${line}`), '}'])
	const hashKeys = (result: Awaited<ReturnType<typeof fix>>) => result.report.hashes.map(change => change.key)

	it('removes sustains shorter than 200 ms only with changeHashes, changing the TrackHash', async () => {
		const short = folder(ini, expert('768 = N 0 30', '960 = N 1 60', '1152 = N 2 96'))
		const kept = await fix(short, { codes: ['babySustain'] })
		expect(kept.report.skipped).toEqual([{ code: 'babySustain', file: null, reason: 'Its fix changes a canonical hash: fix it with changeHashes.' }])
		expectHashesKept(kept)

		const removed = await fix(short, { codes: ['babySustain'], changeHashes: true })
		expect(chartText(removed)).toContain('768 = N 0 0\r\n  960 = N 1 0\r\n  1152 = N 2 96')
		expect(removed.report.fixed).toEqual([{ code: 'babySustain', file: 'notes.chart', description: 'Removed 2 expert guitar sustains shorter than 200 ms.' }])
		expect(hashKeys(removed)).toEqual(['canonical:guitar:expert', 'canonical:song'])
		expect(removed.codes).not.toContain('babySustain')

		const under100 = await fix(short, { codes: ['babySustain'], changeHashes: true, minSustainMs: 100 })
		expect(chartText(under100)).toContain('768 = N 0 0\r\n  960 = N 1 60')
	})

	it('shortens a sustain to end 60 ms before the next note, and removes it when that leaves it too short', async () => {
		// At 120 BPM and 192 ticks per beat, a tick is 2.6 ms: the sustain ends 57 ms before the next note.
		const gap = await fix(folder(ini, expert('768 = N 0 170', '960 = N 1 0')), { codes: ['badSustainGap'], changeHashes: true })
		expect(chartText(gap)).toContain('768 = N 0 168\r\n')
		expect(gap.report.fixed).toEqual([{ code: 'badSustainGap', file: 'notes.chart', description: 'Shortened 1 expert guitar sustain to end 60 ms before the next note.' }])
		expect(gap.codes).not.toContain('badSustainGap')
		expect(hashKeys(gap)).toEqual(['canonical:guitar:expert', 'canonical:song'])

		const tight = folder(ini, expert('768 = N 0 80', '864 = N 1 0'))
		expect(chartText(await fix(tight, { codes: ['badSustainGap'], changeHashes: true }))).toContain('768 = N 0 72\r\n')
		const both = await fix(tight, { codes: ['badSustainGap', 'babySustain'], changeHashes: true })
		expect(chartText(both)).toContain('768 = N 0 0\r\n')
		expect(both.codes.filter(code => code === 'badSustainGap' || code === 'babySustain')).toEqual([])
	})

	it('removes a short .mid sustain on its difficulty', async () => {
		const mid = midi({ 'PART GUITAR': [{ tick: 0, noteNumber: 96, length: 180 }, { tick: 960, noteNumber: 97 }, { tick: 0, noteNumber: 84, length: 180 }, { tick: 960, noteNumber: 85 }] })
		const result = await fix(folder(ini, mid, 'notes.mid'), { codes: ['babySustain'], changeHashes: true })
		expect(result.report.fixed.map(entry => entry.description)).toEqual(['Removed 1 expert guitar sustain shorter than 200 ms.', 'Removed 1 hard guitar sustain shorter than 200 ms.'])
		const notes = resolveChart(result.song).tracks.flatMap(track => track.noteGroups.flat().map(note => [track.difficulty, note.tick, note.length]))
		expect(notes).toEqual([['expert', 0, 0], ['expert', 960, 0], ['hard', 0, 0], ['hard', 960, 0]])
		expect(hashKeys(result)).toEqual(['canonical:guitar:expert', 'canonical:guitar:hard', 'canonical:song'])
	})
})

describe('fixIssues: the HOPO threshold tags', () => {
	const chartText = (result: Awaited<ReturnType<typeof fix>>) => decode((result.song.chart as { tokens: { bytes: Uint8Array } }).tokens.bytes)
	const expert = (...lines: string[]) => chartFile(['[ExpertSingle]', '{', ...lines.map(line => `  ${line}`), '}'])
	/** Each note as Clone Hero plays it: tick, length, type and flags. */
	const played = async (files: readonly SongFile[]) => notesOf(await parseSong(files))
	const notesOf = (song: SongDocument) => resolveChart(song).tracks.map(track => [track.instrument, track.difficulty, track.noteGroups.flat().map(note => [note.tick, note.length, note.type, note.flags])])

	it('forces the .chart notes hopo_frequency makes HOPOs or strums, then removes it, so every note and hash stays', async () => {
		// At 192 ticks per beat, a .chart's own threshold is 65 ticks. 150 ticks apart is a HOPO with 170 and a strum without.
		const files = folder(['[song]', 'name = Song', 'hopo_frequency = 170'], expert('0 = N 0 0', '150 = N 1 0', '300 = N 2 0', '300 = N 5 0', '340 = N 3 0'))
		const result = await fix(files, { codes: ['deprecatedIniTag'] })
		expect(chartText(result)).toContain('  0 = N 0 0\r\n  150 = N 1 0\r\n  150 = N 5 0\r\n  300 = N 2 0\r\n  340 = N 3 0\r\n')
		expect(result.ini).toBe('[song]\r\nname = Song\r\n')
		expect(result.report.fixed).toEqual([{ code: 'deprecatedIniTag', file: 'notes.chart', description: 'Forced 2 notes to play the same without "hopo_frequency", and removed it.' }])
		expect(notesOf(result.song)).toEqual(await played(files))
		expect(result.codes).not.toContain('deprecatedIniTag')
		expectHashesKept(result)
	})

	it('removes eighthnote_hopo, and with hopo_frequency both, which would otherwise apply', async () => {
		const files = folder(['[song]', 'name = Song', 'eighthnote_hopo = True'], expert('0 = N 0 0', '90 = N 1 0'))
		const result = await fix(files, { codes: ['deprecatedIniTag'] })
		expect(chartText(result)).toContain('90 = N 5 0')
		expect(notesOf(result.song)).toEqual(await played(files))
		expectHashesKept(result)
		const both = await fix(folder(['[song]', 'name = Song', 'hopo_frequency = 170', 'eighthnote_hopo = 1'], expert('0 = N 0 0', '150 = N 1 0')), { codes: ['deprecatedIniTag'] })
		expect(both.ini).toBe('[song]\r\nname = Song\r\n')
		expect(both.report.fixed[0].description).toBe('Forced 1 note to play the same without "hopo_frequency" and "eighthnote_hopo", and removed them.')
		expectHashesKept(both)
	})

	it('forces .mid notes with a one-tick force note on their difficulty', async () => {
		// At 480 ticks per beat, a .mid's own threshold is 161 ticks.
		const mid = midi({ 'PART GUITAR': [{ tick: 0, noteNumber: 96 }, { tick: 240, noteNumber: 97 }, { tick: 0, noteNumber: 84 }, { tick: 240, noteNumber: 85 }] })
		const files = folder(['[song]', 'name = Song', 'hopo_frequency = 300'], mid, 'notes.mid')
		const result = await fix(files, { codes: ['deprecatedIniTag'] })
		expect(result.report.fixed[0].description).toBe('Forced 2 notes to play the same without "hopo_frequency", and removed it.')
		expect(notesOf(result.song)).toEqual(await played(files))
		const forceNotes = authoredTracks(result.song.chart!)[0].events.filter(event => event.type === 'forceHopo').map(event => [event.scope, event.tick, event.length])
		expect(forceNotes).toEqual([['expert', 240, 1], ['hard', 240, 1]])
		expectHashesKept(result)
	})
})

describe('fixIssues: multiplier_note = 103', () => {
	const phrases = (song: SongDocument) => resolveChart(song).tracks.map(track => [track.instrument, track.difficulty,
		track.noteGroups.flat().map(note => [note.tick, note.length, note.type, note.flags]),
		track.starPower.map(phrase => [phrase.tick, phrase.length]), track.solos.map(phrase => [phrase.tick, phrase.length])])

	it('moves guitar and keys star power from note 103 to 116, dropping the notes 116 the tag ignores, and keeps the drums solos', async () => {
		const guitar = [0, 960, 1920].map(tick => ({ tick, noteNumber: 96 }))
		const mid = midi({
			'PART GUITAR': [...guitar, { tick: 900, noteNumber: 103, length: 120 }, { tick: 1900, noteNumber: 103, length: 100 }, { tick: 0, noteNumber: 116, length: 60 }],
			'PART DRUMS': [{ tick: 0, noteNumber: 96 }, { tick: 960, noteNumber: 97 }, { tick: 0, noteNumber: 103, length: 1000 }],
		})
		const files = folder(['[song]', 'name = Song', 'multiplier_note = 103'], mid, 'notes.mid')
		const original = await parseSong(files)
		const result = await fix(files, { codes: ['deprecatedIniTag'] })
		expect(result.ini).toBe('[song]\r\nname = Song\r\n')
		expect(result.report.fixed).toEqual([{ code: 'deprecatedIniTag', file: 'notes.mid',
			description: 'Moved 2 star power phrases from note 103 to note 116, removed 1 note 116 that "multiplier_note = 103" made games ignore, and removed "multiplier_note".' }])
		expect(phrases(result.song)).toEqual(phrases(original))
		const [guitarTrack, drumsTrack] = authoredTracks(result.song.chart!)
		expect(guitarTrack.events.filter(event => event.scope === 'instrument').map(event => [event.type, event.tick, event.length]))
			.toEqual([['starPower', 900, 120], ['starPower', 1900, 100]])
		expect(drumsTrack.events.filter(event => event.scope === 'instrument').map(event => [event.type, event.tick])).toEqual([['soloSection', 0]])
		expect(result.codes.filter(code => code === 'deprecatedIniTag' || code === 'badStarPower')).toEqual([])
		expectHashesKept(result)
	})
})

describe('issueFixes', () => {
	const audio = { fileName: 'song.opus', data: opus(80) }
	const songOf = (ini: readonly string[], expert: readonly string[] = ['768 = N 0 0', '960 = N 1 0'], files: readonly SongFile[] = [], sections: readonly string[] = []) => [
		{ fileName: 'notes.chart', data: chartFile(['[ExpertSingle]', '{', ...expert.map(line => `  ${line}`), '}', ...sections]) },
		{ fileName: 'song.ini', data: iniFile(['[song]', 'name = Song', ...ini]) },
		audio,
		...files,
	]
	const length = 'song_length = 10000'
	const fixtures: { readonly [code: string]: SongFile[] } = {
		fileNameCase: songOf([length], undefined, [{ fileName: 'Album.png', data: png(512, 512) }]),
		extensionMismatch: songOf([length], undefined, [{ fileName: 'album.png', data: jpeg(512, 512) }]),
		albumArtSize: songOf([length], undefined, [{ fileName: 'album.jpg', data: jpeg(600, 600) }]),
		iniLayout: songOf([length, '# A comment']),
		iniTagOrder: songOf([length, 'artist = Band']),
		blankIniValue: songOf([length, 'icon =']),
		blankIniNumber: songOf([length, 'diff_bass =']),
		quotedIniValue: songOf([length, 'loading_phrase = "Hi"']),
		defaultIniValue: songOf([length, 'delay = 0']),
		iconName: songOf([length, 'icon = Geo']),
		deprecatedIniTag: songOf([length, 'frets = Someone']),
		redundantDrumType: songOf([length, 'pro_drums = True']),
		missingSongLength: songOf([]),
		songLengthMismatch: songOf(['song_length = 200000']),
		emptyTrack: songOf([length], undefined, [], ['[HardSingle]', '{', '}']),
		emptyStarPower: songOf([length], ['768 = N 0 0', '960 = N 1 0', '1536 = S 2 192']),
		emptySoloSection: songOf([length], ['768 = N 0 0', '960 = N 1 0', '1536 = E solo', '1700 = E soloend']),
		emptyFlexLane: songOf([length], ['768 = N 0 0', '960 = N 1 0', '1800 = S 65 100']),
		badSustainGap: songOf([length], ['768 = N 0 170', '960 = N 1 0']),
		babySustain: songOf([length], ['768 = N 0 30', '960 = N 1 0']),
	}

	it('keeps or changes the canonical hashes as each entry says, which hashing a song before and after its fix shows', async () => {
		expect(Object.keys(fixtures).sort()).toEqual(Object.keys(issueFixes).sort())
		for (const [code, files] of Object.entries(fixtures)) {
			const result = await fix(files, { codes: [code as IssueCode], changeHashes: true, resizeImage: async (_image, size) => jpeg(size, size) })
			expect(result.report.fixed.map(entry => entry.code), code).toContain(code)
			expect(result.codes, code).not.toContain(code)
			expect(result.before, code).not.toBeNull()
			expect(result.report.hashes.length > 0, code).toBe(issueFixes[code as IssueCode] === 'changesHashes')
			expect(result.after!.get('canonical:song') !== result.before!.get('canonical:song'), code).toBe(issueFixes[code as IssueCode] === 'changesHashes')
		}
	})
})
