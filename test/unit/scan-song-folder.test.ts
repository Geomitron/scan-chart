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

	it('names song.ini for its line and section issues, and the chart file when it can\'t be read or hashed', async () => {
		const fileOf = async (folder: { fileName: string; data: Uint8Array }[], code: string) =>
			(await scanSongFolder(folder, { competitiveHashes: true })).issues.filter(issue => issue.code === code).map(issue => issue.file)
		expect(await fileOf([files[0], { fileName: 'Song.ini', data: encode('[song]\r\nname = Song\r\nnot a line\r\n') }], 'badIniLine')).toEqual(['Song.ini'])
		expect(await fileOf([files[0], { fileName: 'song.ini', data: encode('[other]\r\nname = Song\r\n') }], 'invalidMetadata')).toEqual(['song.ini'])
		expect(await fileOf([{ fileName: 'notes.mid', data: new Uint8Array([1, 2, 3]) }], 'badChart')).toEqual(['notes.mid'])
		const unhashable = encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}',
			'[ExpertSingle]', '{', '  0 = N 0 0', '  9007199254740993 = N 1 0', '}'].join('\r\n') + '\r\n')
		expect(await fileOf([{ fileName: 'notes.chart', data: unhashable }], 'badChartIdentity')).toEqual(['notes.chart'])
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

describe('song.ini\'s ignored_issues', () => {
	const scan = (ini: string, options = {}) => scanSongFolder([files[0], { fileName: 'song.ini', data: encode(`[song]\r\nname = Song\r\n${ini}\r\n`) }, files[2],
		{ fileName: 'preview.ogg', data: new Uint8Array(1) }, { fileName: 'Album.png', data: new Uint8Array(1) }], options)
	const codes = (issues: readonly { code: string }[]) => [...new Set(issues.map(issue => issue.code))]

	it('moves the issues of the codes it lists to ignoredIssues, and is a tag scan-chart reads', async () => {
		const unignored = await scan('', { styleNotes: true })
		expect(codes(unignored.issues)).toEqual(expect.arrayContaining(['discouragedAudio', 'fileNameCase', 'audioFormat']))
		const scanned = await scan('ignored_issues = discouragedAudio ,fileNameCase,, audioFormat', { styleNotes: true })
		expect(codes(scanned.ignoredIssues)).toEqual(['audioFormat', 'discouragedAudio', 'fileNameCase'])
		expect(scanned.issues).toEqual(unignored.issues.filter(issue => !['discouragedAudio', 'fileNameCase', 'audioFormat'].includes(issue.code)))
		expect(codes((await scan('ignored_issues =', { styleNotes: true })).issues)).not.toContain('blankIniValue')
	})

	it('keeps an error listed, and reports it and a code that isn\'t one', async () => {
		const scanned = await scan('ignored_issues = missingValue, DiscouragedAudio, multipleChart')
		expect(codes(scanned.ignoredIssues)).toEqual(['missingValue'])
		expect(scanned.issues.filter(issue => issue.code === 'invalidValue').map(issue => issue.message)).toEqual([
			'The "ignored_issues" value in "song.ini" lists "DiscouragedAudio", which isn\'t an issue code.',
		])
		const error = await scanSongFolder([files[0], { fileName: 'song.ini', data: encode('[song]\r\nignored_issues = noAudio\r\n') }])
		expect(error.issues.map(issue => issue.code)).toContain('noAudio')
		expect(error.issues.filter(issue => issue.code === 'invalidValue').map(issue => issue.message)).toEqual([
			'The "ignored_issues" value in "song.ini" lists "noAudio", an error, which can\'t be ignored.',
		])
	})

	it('never hides its own issues, even when it lists invalidValue', async () => {
		const scanned = await scan('multiplier_note = 5\r\nignored_issues = invalidValue, noAudio, Unknown')
		expect(scanned.issues.filter(issue => issue.code === 'invalidValue').map(issue => issue.message)).toEqual([
			'The "ignored_issues" value in "song.ini" lists "noAudio", an error, which can\'t be ignored.',
			'The "ignored_issues" value in "song.ini" lists "Unknown", which isn\'t an issue code.',
		])
		expect(scanned.ignoredIssues.map(issue => issue.message)).toEqual(['The "multiplier_note" value in "song.ini" is "5", which is not a valid value.'])
	})
})
