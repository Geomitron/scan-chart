import { describe, expect, it } from 'vitest'

import { canonical20260801 } from 'src/chart/identity/public'
import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { scanChart } from 'src/scan-chart'
import { File } from 'src/types'

function chartFolder(sections: Record<string, readonly string[]>, ini = '[song]\nname = Song\nartist = Artist\ncharter = Charter\n'): File[] {
	const lines: string[] = []
	for (const [name, values] of Object.entries({ Song: ['Resolution = 192'], SyncTrack: ['0 = B 120000'], Events: [], ...sections })) {
		lines.push(`[${name}]`, '{', ...values.map(value => `  ${value}`), '}')
	}
	return [
		{ fileName: 'notes.chart', data: new TextEncoder().encode(lines.join('\r\n')) },
		{ fileName: 'song.ini', data: new TextEncoder().encode(ini) },
	]
}

function scan(files: File[], includeBTrack = false) {
	return scanChart(files, parseChartAndIni(files), { includeBTrack, includeMd5: false, includeAlbumArt: false })
}

const repeated = Array.from({ length: 21 }, (_, index) => `${index * 192} = N 0 0`)

describe('scanChart canonical identity', () => {
	const files = chartFolder({
		ExpertSingle: ['0 = N 0 0', '192 = N 1 96'],
		EasySingle: ['0 = N 0 0'],
		HardSingle: ['0 = S 2 192'],
		ExpertDrums: ['0 = N 0 0'],
	})

	it('reports the canonical TrackHashes, BTracks, SongHash, and song duration', () => {
		const scanned = scan(files, true)
		const parsedChart = parseChartAndIni(files).parsedChart!
		const parsed = canonical20260801.parseSource({ source: { format: 'chart', bytes: parsedChart.chartBytes }, modifiers: parsedChart.iniChartModifiers })
		if (parsed.kind !== 'accepted') throw new Error('Expected the canonical profile to accept the chart')
		const bundle = canonical20260801.calculateSongBundle({ chart: parsed.chart, metadata: parsedChart.songHashMetadata })

		expect(scanned.notesData!.trackHashes.map(track => ({ ...track, btrack: track.btrack && Buffer.from(track.btrack).toString('hex') })))
			.toEqual(bundle.tracks.map(track => ({
				instrument: track.instrument,
				difficulty: track.difficulty,
				hash: track.identity.trackHash.value,
				btrack: Buffer.from(track.identity.physicalBTrack.bytes).toString('hex'),
			})))
		expect(scanned.notesData!.trackHashes.map(track => `${track.instrument}:${track.difficulty}`))
			.toEqual(['guitar:easy', 'guitar:expert', 'drums:expert'])
		expect(scanned.songHash).toBe(bundle.song.songHash.value)
		expect(scanned.songDurationMs).toBe(Number(bundle.duration.durationMs))
		expect(scanned.songDurationMs).toBe(1250)
		for (const track of scanned.notesData!.trackHashes) {
			expect(canonical20260801.readBTrack(track.btrack!).kind).toBe('accepted')
		}
	})

	it('omits BTrack bytes unless includeBTrack is set', () => {
		expect(scan(files).notesData!.trackHashes.every(track => track.btrack === null)).toBe(true)
	})

	it('reports a canonical rejection as a folder issue instead of throwing', () => {
		const scanned = scan(chartFolder({ ExpertSingle: ['0 = N 0 0', '9007199254740993 = N 1 0'] }))
		expect(scanned.notesData).not.toBeNull()
		expect(scanned.notesData!.noteCounts).toEqual([{ instrument: 'guitar', difficulty: 'expert', count: 2 }])
		expect(scanned.notesData!.trackHashes).toEqual([])
		expect(scanned.songHash).toBeNull()
		expect(scanned.songDurationMs).toBeNull()
		expect(scanned.folderIssues).toContainEqual({
			folderIssue: 'badChartIdentity',
			description: expect.stringContaining('safe integer'),
		})
	})

	it('reports no song identity when the folder has no chart', () => {
		const scanned = scan([{ fileName: 'song.ini', data: new TextEncoder().encode('[song]\nname = Song\n') }])
		expect(scanned.songHash).toBeNull()
		expect(scanned.songDurationMs).toBeNull()
	})

	it('compares canonical hashes for difficultyNotReduced, skipping tracks without notes', () => {
		const issues = (sections: Record<string, readonly string[]>) => scan(chartFolder(sections)).notesData!.chartIssues
			.filter(issue => issue.noteIssue === 'difficultyNotReduced')
			.map(issue => issue.difficulty)
		expect(issues({ ExpertSingle: repeated, HardSingle: repeated })).toEqual(['hard'])
		expect(issues({ ExpertSingle: [], HardSingle: repeated })).toEqual([])
	})
})
