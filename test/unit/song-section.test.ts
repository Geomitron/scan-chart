import { describe, expect, it } from 'vitest'

import { editSong, parseSongFiles, SongDocument } from 'src/song-document'
import { songSectionAgreement } from 'src/song-section'
import { saveSong } from 'src/song-save'
import { fileBytes } from 'src/song-files'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const notes = '[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[Events]\n{\n}\n[ExpertSingle]\n{\n  0 = N 0 0\n  192 = N 1 0\n}\n'
const song = (songLines: string[], ini: string | null) => parseSongFiles([
	{ fileName: 'notes.chart', data: encode(`[Song]\n{\n${songLines.map(line => `  ${line}\n`).join('')}}\n${notes}`) },
	...(ini === null ? [] : [{ fileName: 'song.ini', data: encode(ini) }]),
])
const songLines = (document: SongDocument | null) =>
	document?.chart?.format === 'chart' ? decode(document.chart.tokens.bytes).split('}\n')[0].split('\n').slice(2, -1).map(line => line.trim()) : null

describe('the [Song] normalization', () => {
	it('gives [Song] song.ini\'s value where both set one, keeping the line\'s quoting and Year style', () => {
		const normalized = songSectionAgreement(song(['Name = "Old"', 'Year = ", 2001"', 'Genre = Rock', 'Resolution = 192'], '[song]\nname = New\nyear = 2002\ngenre = Metal\n'))
		expect(songLines(normalized)).toEqual(['Name = "New"', 'Year = ", 2002"', 'Genre = Metal', 'Resolution = 192'])
		expect(songLines(songSectionAgreement(song(['Year = 2001'], '[song]\nyear = 2002\n')))).toEqual(['Year = 2002'])
	})

	it('adds a key only song.ini sets, as scan-chart writes [Song]', () => {
		const normalized = songSectionAgreement(song(['Resolution = 192'],
			'[song]\nartist = Band\nyear = 2002\ndiff_band = 4\nsong_length = 200000\npreview_end_time = 61500\nicon = x\n'))
		expect(songLines(normalized)).toEqual(['Resolution = 192', 'Artist = "Band"', 'Year = ", 2002"', 'Difficulty = 4', 'Length = 200', 'PreviewEnd = 61.5'])
	})

	it('copies Offset and PreviewStart into song.ini when it doesn\'t set them, and removes other keys only [Song] sets', () => {
		const normalized = songSectionAgreement(song(['Album = "Record"', 'Offset = 0.5604', 'PreviewStart = 45.28', 'Resolution = 192'],
			'[song]\nname = Song\ndelay = 0\npreview_start_time = -1\n'))
		expect(songLines(normalized)).toEqual(['Offset = 0.5604', 'PreviewStart = 45.28', 'Resolution = 192', 'Name = "Song"'])
		expect(normalized?.ini?.tokens.text).toBe('[song]\nname = Song\ndelay = 561\npreview_start_time = 45280\n')
	})

	it('copies a value into its place in song.ini\'s standard order, changing no other line', () => {
		const ini = '[song]\nname = Song\ncharter = Me\nicon = me\nalbum_track = 2\nlast_play = 1\n'
		const normalized = songSectionAgreement(song(['PreviewStart = 45.28', 'Offset = 0.5'], ini))
		expect(normalized?.ini?.tokens.text).toBe('[song]\nname = Song\ncharter = Me\npreview_start_time = 45280\nicon = me\nalbum_track = 2\ndelay = 500\nlast_play = 1\n')
	})

	it('copies PreviewEnd into song.ini when it doesn\'t set preview_end_time, and leaves Moonscraper\'s PreviewEnd = 0 alone', () => {
		const normalized = songSectionAgreement(song(['PreviewEnd = 75.5', 'Resolution = 192'], '[song]\nname = Song\n'))
		expect(songLines(normalized)).toEqual(['PreviewEnd = 75.5', 'Resolution = 192', 'Name = "Song"'])
		expect(normalized?.ini?.tokens.text).toBe('[song]\nname = Song\npreview_end_time = 75500\n')
		// A preview can't end at the song's start, so 0 isn't set on either side.
		expect(songSectionAgreement(song(['Name = "Song"', 'PreviewEnd = 0'], '[song]\nname = Song\n'))).toBeNull()
		expect(songSectionAgreement(song(['Name = "Song"'], '[song]\nname = Song\npreview_end_time = 0\n'))).toBeNull()
	})

	it('compares times as the milliseconds Clone Hero rounds them to, and writes one that reads back exactly', () => {
		expect(songSectionAgreement(song(['Offset = 0.5604', 'Name = "Song"'], '[song]\nname = Song\ndelay = 561\n'))).toBeNull()
		expect(songLines(songSectionAgreement(song(['Offset = 0.25'], '[song]\ndelay = 500\n')))).toEqual(['Offset = 0.5'])
		// Clone Hero reads -4.095 seconds as -4094 ms. An Offset of 0 isn't set, so it takes song.ini's.
		expect(songLines(songSectionAgreement(song(['Offset = 0'], '[song]\ndelay = -4095\n')))).toEqual(['Offset = -4.0955'])
		// Single precision: 0.5604 seconds and 561 ms agree, and so do -2.046 seconds and -2046 ms.
		expect(songSectionAgreement(song(['Offset = -2.046'], '[song]\ndelay = -2046\n'))).toBeNull()
	})

	it('treats a Difficulty of 0 as a difficulty, and only song.ini\'s -1 as none (Geo, 2026-10-12)', () => {
		expect(songLines(songSectionAgreement(song(['Resolution = 192'], '[song]\ndiff_band = 0\n')))).toEqual(['Resolution = 192', 'Difficulty = 0'])
		expect(songLines(songSectionAgreement(song(['Difficulty = 4'], '[song]\ndiff_band = 0\n')))).toEqual(['Difficulty = 0'])
		expect(songSectionAgreement(song(['Difficulty = 0'], '[song]\ndiff_band = 0\n'))).toBeNull()
		// A value only [Song] sets is removed, as the other keys Clone Hero doesn't read from [Song] are.
		expect(songLines(songSectionAgreement(song(['Difficulty = 0', 'Resolution = 192'], '[song]\nname = Song\n')))).toEqual(['Resolution = 192', 'Name = "Song"'])
		expect(songLines(songSectionAgreement(song(['Difficulty = 0', 'Resolution = 192'], '[song]\ndiff_band = -1\n')))).toEqual(['Resolution = 192'])
	})

	it('leaves each key on the line Clone Hero reads', () => {
		const normalized = songSectionAgreement(song(['Name = ""', 'Name = "Old"', 'Name = "Older"'], '[song]\nname = New\n'))
		expect(songLines(normalized)).toEqual(['Name = "New"'])
	})

	it('applies only to a .chart song with a song.ini holding a [song] section', () => {
		expect(songSectionAgreement(song(['Name = "Old"'], null))).toBeNull()
		expect(songSectionAgreement(song(['Name = "Old"'], '[other]\nname = New\n'))).toBeNull()
		const otherIni = parseSongFiles([{ fileName: 'notes.chart', data: encode(`[Song]\n{\n  Name = "Old"\n}\n${notes}`) }, { fileName: 'other.ini', data: encode('[song]\nname = New\n') }])
		expect(songSectionAgreement(otherIni)).toBeNull()
	})

	it('runs when an edited song is saved, and not on an unedited one', () => {
		const original = song(['Name = "Old"', 'Resolution = 192'], '[song]\nname = Song\n')
		expect(saveSong(original, original).report.normalized).toEqual([])
		const { files, report } = saveSong(original, editSong(original, batch => batch.setMetadata('name', 'New')))
		expect(report.normalized).toEqual([{ kind: 'lineEndings', section: null }, { kind: 'songSection', section: 'Song' }])
		expect(decode(fileBytes(files[0]))).toBe(`[Song]\n{\n  Name = "New"\n  Resolution = 192\n}\n${notes}`.replace(/\n/g, '\r\n'))
		expect(decode(fileBytes(files[1]))).toBe('[song]\nname = New\n')
	})
})
