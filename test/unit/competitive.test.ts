import { describe, expect, it } from 'vitest'

import { authoredSongEvents, chartAuthoredTracks } from 'src/chart/authored-view'
import { calculateCompetitiveHashes } from 'src/competitive'
import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { scanChart } from 'src/scan-chart'
import { editSong, parseSongFiles, serializeSong, SongDocument } from 'src/song-document'
import { fileBytes } from 'src/song-files'

const encode = (text: string) => new TextEncoder().encode(text)
const files = [
	{ fileName: 'notes.chart', data: encode([
		'[Song]', '{', '  Resolution = 192', '  Name = "From [Song]"', '}',
		'[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '  768 = B 140500', '}',
		'[Events]', '{', '}',
		'[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 96', '  384 = N 2 0', '}',
		'[HardDrums]', '{', '  0 = N 0 0', '  192 = N 2 0', '}',
	].join('\r\n') + '\r\n') },
	{ fileName: 'song.ini', data: encode('[song]\r\nname = Song\r\nartist = Artist\r\ncharter = Charter\r\n') },
]
const scanned = (song: SongDocument) => {
	const songFiles = serializeSong(song).map(file => ({ fileName: file.fileName, data: fileBytes(file) }))
	return scanChart(songFiles, parseChartAndIni(songFiles))
}

describe('competitive hashes from a song document', () => {
	it('equal the scanner\'s SongHash, duration and TrackHashes', () => {
		const song = parseSongFiles(files)
		const hashes = calculateCompetitiveHashes(song)
		const scan = scanned(song)
		if (!hashes.accepted) throw new Error(hashes.reason)
		expect(hashes.songHash).toBe(scan.songHash)
		expect(hashes.songDurationMs).toBe(scan.songDurationMs)
		expect(hashes.tracks.map(({ instrument, difficulty, trackHash }) => ({ instrument, difficulty, hash: trackHash })))
			.toEqual(scan.notesData!.trackHashes.map(({ instrument, difficulty, hash }) => ({ instrument, difficulty, hash })))
		expect(hashes.tracks.every(track => track.btrack === null)).toBe(true)
		expect(hashes.tempoMapHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
	})

	it('give an edited song the hashes of saving it and reading it back', () => {
		const song = parseSongFiles(files)
		calculateCompetitiveHashes(song)
		const [guitar] = chartAuthoredTracks(song.chart!.format === 'chart' ? song.chart!.tokens : null!)
		const [tempo] = authoredSongEvents({ format: 'chart', tokens: song.chart!.format === 'chart' ? song.chart!.tokens : null! }).tempos
		const edited = editSong(song, batch => {
			batch.setLength(guitar.events[0], 48)
			batch.setTempo(tempo, 150)
		})
		const hashes = calculateCompetitiveHashes(edited, { btracks: true })
		expect(hashes).toEqual(calculateCompetitiveHashes(parseSongFiles(serializeSong(edited)), { btracks: true }))
		expect(hashes).not.toEqual(calculateCompetitiveHashes(song, { btracks: true }))
	})

	it('refuse a song without a chart, and give the reason', () => {
		expect(calculateCompetitiveHashes(parseSongFiles([files[1]]))).toEqual({ accepted: false, reason: 'The song has no chart file.' })
	})
})
