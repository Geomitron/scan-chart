import { describe, expect, it } from 'vitest'

import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { msToExactTime } from 'src/shared/time'
import { scanChart } from 'src/scan-chart'
import { byteSourceFromBlob } from 'src/song-files'
import { scanSongFolder } from 'src/scan-song-folder'

const encode = (text: string) => new TextEncoder().encode(text)
const notes = Array.from({ length: 30 }, (_, i) => `${i * 192} = N ${i % 3} 0`)
const chart = encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}',
	'[ExpertSingle]', '{', ...notes.map(line => `  ${line}`), '  5760 = N 0 10', '}', '[ExpertDrums]', '{', '  0 = N 0 0', '}'].join('\r\n') + '\r\n')
const files = [
	{ fileName: 'notes.chart', data: chart },
	{ fileName: 'song.ini', data: encode('[song]\r\nname = Song\r\nartist = Artist\r\ndiff_guitar = 3\r\ndiff_bass = 2\r\n') },
	{ fileName: 'song.ogg', data: new Uint8Array([1, 2, 3]) },
	{ fileName: 'album.png', data: new Uint8Array([4, 5, 6]) },
	{ fileName: 'video.mp4', data: new Uint8Array([7]) },
]

describe('scanning a song folder', () => {
	it('finds what 8.x scanChart found, in the one issue shape', async () => {
		const scanned = await scanSongFolder(files, { competitiveHashes: true, fileHashes: true, albumArt: true })
		const old = scanChart(files, parseChartAndIni(files))
		const description = (issue: { msTime: number | null; message: string }) => issue.msTime === null ? issue.message : `[${msToExactTime(issue.msTime)}]: ${issue.message}`
		// The codes 8.x had; 9.0 adds the charting recommendations.
		const oldCodes = [
			'noMetadata', 'invalidIni', 'invalidMetadata', 'badIniLine', 'multipleIniFiles', 'noAlbumArt', 'albumArtSize', 'badAlbumArt', 'multipleAlbumArt', 'noAudio',
			'invalidAudio', 'multipleAudio', 'noChart', 'invalidChart', 'badChart', 'badChartIdentity', 'multipleChart', 'badVideo', 'multipleVideo',
			'missingValue', 'invalidValue', 'extraValue',
		]
		const oldIssues = scanned.issues.filter(issue => oldCodes.includes(issue.code))
		expect(oldIssues.filter(issue => issue.scope === 'folder').map(issue => ({ folderIssue: issue.code, description: issue.message }))).toEqual(old.folderIssues)
		expect(oldIssues.filter(issue => issue.scope === 'metadata').map(issue => ({ metadataIssue: issue.code, description: issue.message }))).toEqual(old.metadataIssues)
		expect(scanned.issues.filter(issue => issue.scope === 'chart').map(issue => ({ instrument: issue.instrument, difficulty: issue.difficulty, noteIssue: issue.code, description: description(issue) })))
			.toEqual(old.notesData!.chartIssues)
		expect(scanned.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['badAlbumArt', 'missingValue', 'extraValue', 'badVideo']))
		expect(scanned.playable).toBe(old.playable)
		expect(scanned.hasVideoBackground).toBe(old.hasVideoBackground)
		expect(scanned.stats?.instruments).toEqual(old.notesData!.instruments)
		expect(scanned.fileHashes).toEqual({ folderHash: old.md5, chartHash: old.chartHash, albumArtHash: expect.any(String) })
		expect(scanned.competitive?.accepted && scanned.competitive.songHash).toBe(old.songHash)
		expect(scanned.albumArt).toBeNull() // the album art can't be decoded
	})

	it('names the file each folder and metadata issue is about', async () => {
		const scanned = await scanSongFolder([
			...files.slice(0, 2),
			{ fileName: 'Song.ini', data: encode('[song]\r\nname = Other\r\n') },
			{ fileName: 'notes (old).chart', data: chart },
			{ fileName: 'band.ogg', data: new Uint8Array(1) },
			{ fileName: 'album.png', data: new Uint8Array([4, 5, 6]) },
			{ fileName: 'video.avi', data: new Uint8Array(1) },
		], { albumArt: true })
		const fileOf = (code: string) => scanned.issues.filter(issue => issue.code === code).map(issue => issue.file)
		expect(fileOf('invalidIni')).toEqual(['Song.ini'])
		expect(fileOf('multipleIniFiles')).toEqual([null])
		expect(fileOf('invalidChart')).toEqual(['notes (old).chart'])
		expect(fileOf('invalidAudio')).toEqual(['band.ogg'])
		expect(fileOf('noAudio')).toEqual([null])
		expect(fileOf('badAlbumArt')).toEqual(['album.png'])
		expect(fileOf('badVideo')).toEqual(['video.avi'])
		expect(fileOf('extraValue')).toEqual(['song.ini'])
		expect(scanned.issues.filter(issue => issue.scope === 'chart').every(issue => issue.file === null)).toBe(true)
	})

	it('computes nothing that isn\'t asked for, and reads large files only to hash them', async () => {
		let reads = 0
		const source = byteSourceFromBlob(new Blob([new Uint8Array(100)]))
		const audio = { fileName: 'song.ogg', data: { size: source.size, read: (offset: number, length: number) => { reads++; return source.read(offset, length) } } }
		const scanned = await scanSongFolder([files[0], files[1], audio])
		expect(reads).toBe(0)
		expect(scanned).toMatchObject({ competitive: null, fileHashes: null, albumArt: null, playable: true })
		const hashed = await scanSongFolder([files[0], files[1], audio], { fileHashes: true })
		expect(reads).toBe(1)
		expect(hashed.fileHashes?.folderHash).toBe(scanChart([files[0], files[1], { fileName: 'song.ogg', data: new Uint8Array(100) }],
			parseChartAndIni([files[0], files[1]])).md5)
	})
})
