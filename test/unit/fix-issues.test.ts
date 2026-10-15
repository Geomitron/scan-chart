import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { fixIssues, type FixOptions } from 'src/fix-issues'
import { serializeSong } from 'src/save-plan'
import { scanSongFolder } from 'src/scan-song-folder'
import { documentFiles, parseSong } from 'src/song-document'
import type { SongFile } from 'src/song-files'
import { saveSong, songHashes } from 'src/song-save'

import { opus, vorbis } from './helpers/media-files'

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
	const rescan = await scanSongFolder(saved, { styleNotes: true })
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
