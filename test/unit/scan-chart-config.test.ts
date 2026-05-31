import { describe, expect, it } from 'vitest'

import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { scanChart } from 'src/scan-chart'
import { File } from 'src/types'

function buildChart(body: string): File[] {
	return [{ fileName: 'notes.chart', data: new TextEncoder().encode(body) }]
}

function buildMinimalChart() {
	return [
		'[Song]', '{', '  Resolution = 480', '}',
		'[SyncTrack]', '{', '  0 = B 120000', '}',
		'[Events]', '{', '}',
		'[ExpertSingle]', '{', '  0 = N 0 0', '}',
	].join('\r\n')
}

function buildUnreadableAlbumArt(): File {
	const file = { fileName: 'album.jpg' } as File
	Object.defineProperty(file, 'data', {
		get: () => {
			throw new Error('album art data should not be read')
		},
	})
	return file
}

function buildAlbumArtWithDataGetter(onRead: () => void, data = new Uint8Array([1, 2, 3])): File {
	const file = { fileName: 'album.jpg' } as File
	Object.defineProperty(file, 'data', {
		get: () => {
			onRead()
			return data
		},
	})
	return file
}

describe('scanChart config', () => {
	it('skips reading and parsing album art when includeAlbumArt and includeMd5 are false', () => {
		const files = [...buildChart(buildMinimalChart()), buildUnreadableAlbumArt()]
		const scanned = scanChart(files, parseChartAndIni(files), { includeAlbumArt: false, includeMd5: false })

		expect(scanned.albumArt).toBeNull()
		expect(scanned.folderIssues.map(i => i.folderIssue)).not.toContain('badAlbumArt')
	})

	it('still reads album art for md5 when includeAlbumArt is false', () => {
		let albumArtReadCount = 0
		const albumArtData = new Uint8Array([1, 2, 3])
		const files = [...buildChart(buildMinimalChart()), buildAlbumArtWithDataGetter(() => albumArtReadCount++, albumArtData)]
		const scanned = scanChart(files, parseChartAndIni(files), { includeAlbumArt: false })
		const scannedWithAlbumArtParsing = scanChart(
			[...buildChart(buildMinimalChart()), { fileName: 'album.jpg', data: albumArtData }],
			parseChartAndIni(files),
		)

		expect(albumArtReadCount).toBe(1)
		expect(scanned.md5).toBe(scannedWithAlbumArtParsing.md5)
		expect(scanned.albumArt).toBeNull()
		expect(scanned.folderIssues.map(i => i.folderIssue)).not.toContain('badAlbumArt')
	})

	it('parses album art by default', () => {
		const files = [...buildChart(buildMinimalChart()), { fileName: 'album.jpg', data: new Uint8Array([1, 2, 3]) }]
		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false })

		expect(scanned.albumArt).toBeNull()
		expect(scanned.folderIssues.map(i => i.folderIssue)).toContain('badAlbumArt')
	})
})
