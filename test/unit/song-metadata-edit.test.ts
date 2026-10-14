import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { calculateCompetitiveHashes } from 'src/competitive'
import { appendSongIniSection, setSongIniValue } from 'src/ini/ini-edit'
import { tokenizeIni } from 'src/ini/parse-ini'
import { editSong, parseSongFiles, documentFiles, SongMetadataKey } from 'src/song-document'
import { fileBytes } from 'src/song-files'
import { songMetadata } from 'src/song-metadata'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const file = (fileName: string, text: string) => ({ fileName, data: encode(text) })
const iniText = (text: string, key: string, value: string | null) => {
	const edited = setSongIniValue(tokenizeIni(encode(text)), key, value)
	return edited === null ? null : edited.text
}

describe('song.ini edits', () => {
	it('change the key\'s last line in a [song] section of any letter case, keeping how it\'s written', () => {
		const text = '[Song]\r\nname=First\r\n[other]\r\nname = Other\r\n[song]\r\n  NAME =   Second\r\nartist = A\r\n'
		expect(iniText(text, 'name', 'New')).toBe('[Song]\r\nname=First\r\n[other]\r\nname = Other\r\n[song]\r\n  NAME =   New\r\nartist = A\r\n')
	})

	it('add a missing key after the last key line of the last [song] section, with the file\'s line ending', () => {
		expect(iniText('[song]\nname = A', 'artist', 'B')).toBe('[song]\nname = A\nartist = B\n')
		expect(iniText('[song]\r\nname = A\r\n\r\n; note\r\n', 'artist', 'B')).toBe('[song]\r\nname = A\r\nartist = B\r\n\r\n; note\r\n')
	})

	it('remove every line of a key in [song] sections only', () => {
		expect(iniText('[song]\nname = A\n[other]\nname = B\n[song]\nname = C\n', 'name', null)).toBe('[song]\n[other]\nname = B\n[song]\n')
	})

	it('need a [song] section, which can be appended', () => {
		expect(iniText('[other]\nx = 1\n', 'name', 'A')).toBeNull()
		expect(appendSongIniSection(tokenizeIni(encode('x = 1')), [['name', 'A']]).text).toBe('x = 1\r\n[song]\r\nname = A\r\n')
		expect(appendSongIniSection(tokenizeIni(new Uint8Array(0)), [['name', 'A']]).text).toBe('[song]\r\nname = A\r\n')
	})

	it('keep a UTF-8 byte order mark', () => {
		const edited = setSongIniValue(tokenizeIni(new Uint8Array([0xef, 0xbb, 0xbf, ...encode('[song]\r\nname = A\r\n')])), 'name', 'B')!
		expect([...edited.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
		expect(edited.text).toBe('[song]\r\nname = B\r\n')
	})

	it('refuse a file that isn\'t UTF-8, and a value song.ini can\'t hold as written', () => {
		expect(() => setSongIniValue(tokenizeIni(new Uint8Array([...encode('[song]\nname = Caf'), 0xe9])), 'name', 'B')).toThrow('isn\'t UTF-8')
		expect(() => iniText('[song]\n', 'name', 'two\nlines')).toThrow('can\'t hold')
		expect(() => iniText('[song]\n', 'name', ' padded')).toThrow('can\'t hold')
	})
})

const chartText = [
	'[Song]', '{', '  Name = "Chart <b>Name</b>"', '  Artist = "Chart Artist"', '  Year = ", 2002"', '  Difficulty = 4',
	'  Offset = 0.5604', '  PreviewStart = 45.28', '  Length = 200', '  Resolution = 192', '}',
	'[SyncTrack]', '{', '  0 = B 120000', '}',
	'[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}',
].join('\r\n') + '\r\n'

describe('setMetadata', () => {
	it('edits the song.ini Clone Hero reads, leaving the chart as it was', () => {
		const song = parseSongFiles([file('notes.chart', chartText), file('song.ini', '[song]\r\nname = Song\r\n')])
		const edited = editSong(song, batch => batch.setMetadata('artist', 'Band'))
		expect(edited.chart).toBe(song.chart)
		expect(documentFiles(edited).map(saved => [saved.fileName, decode(fileBytes(saved))]))
			.toEqual([['notes.chart', chartText], ['song.ini', '[song]\r\nname = Song\r\nartist = Band\r\n']])
		expect(songMetadata(edited).artist).toBe('Band')
		expect(decode(fileBytes(documentFiles(song)[1]))).toBe('[song]\r\nname = Song\r\n')
	})

	it('gives a song without song.ini one holding the [Song] values Clone Hero read, so only the edit reads differently', () => {
		const song = parseSongFiles([file('notes.chart', chartText), file('guitar.ogg', 'ogg')])
		const edited = editSong(song, batch => batch.setMetadata('loading_phrase', 'Hello'))
		expect(edited.files.map(saved => saved.fileName)).toEqual(['notes.chart', 'guitar.ogg', 'song.ini'])
		expect(edited.ini?.tokens.text).toBe('[song]\r\nname = Chart <b>Name</b>\r\nartist = Chart Artist\r\nyear = 2002\r\ndiff_guitar = 4\r\n'
			+ 'delay = 561\r\npreview_start_time = 45280\r\nloading_phrase = Hello\r\n')
		expect(songMetadata(edited)).toEqual({ ...songMetadata(song), loading_phrase: 'Hello' })
		const [before, after] = [calculateCompetitiveHashes(song), calculateCompetitiveHashes(edited)]
		if (!before.accepted || !after.accepted) throw new Error('not accepted')
		expect(after.songHash).toBe(before.songHash)
	})

	it('adds a [song] section to a song.ini without one, and edits a [Song] value it copies', () => {
		const song = parseSongFiles([file('notes.chart', chartText), file('song.ini', '; empty\n')])
		const edited = editSong(song, batch => batch.setMetadata('name', 'Renamed'))
		expect(edited.files).toBe(song.files)
		expect(edited.ini?.tokens.text).toBe('; empty\n[song]\nname = Renamed\nartist = Chart Artist\nyear = 2002\ndiff_guitar = 4\n'
			+ 'delay = 561\npreview_start_time = 45280\n')
	})

	it('creates song.ini for a .mid song with only the edit, and needs no chart', () => {
		const midi = writeMidi({ header: { format: 1, numTracks: 1, ticksPerBeat: 480 }, tracks: [[{ deltaTime: 0, type: 'endOfTrack' }]] })
		const midSong = editSong(parseSongFiles([{ fileName: 'notes.mid', data: new Uint8Array(midi) }]), batch => batch.setMetadata('genre', 'Rock'))
		expect(midSong.ini?.tokens.text).toBe('[song]\r\ngenre = Rock\r\n')
		const noChart = editSong(parseSongFiles([file('song.ini', '[song]\n')]), batch => batch.setMetadata('pro_drums', 'True'))
		expect(noChart.ini?.tokens.text).toBe('[song]\npro_drums = True\n')
	})

	it('removes a value with null, and refuses a key scan-chart doesn\'t read or a value song.ini can\'t hold', () => {
		const song = parseSongFiles([file('song.ini', '[song]\nname = A\nicon = x\n')])
		expect(editSong(song, batch => batch.setMetadata('icon', null)).ini?.tokens.text).toBe('[song]\nname = A\n')
		expect(() => editSong(song, batch => batch.setMetadata('toString' as SongMetadataKey, 'x'))).toThrow('isn\'t a song.ini key')
		expect(() => editSong(song, batch => batch.setMetadata('name', 'a\r\nb'))).toThrow('can\'t hold')
	})

	it('returns the song itself for an empty batch', () => {
		const song = parseSongFiles([file('song.ini', '[song]\n')])
		expect(editSong(song, () => undefined)).toBe(song)
	})
})
