import { join } from 'node:path'

import { scanChartFolder } from 'scan-chart-baseline'
import { parseChartAndIni, scanChart } from 'src'
import { BTRACK_SCAN_CONFIG } from '../shared/constants'
import { loadChartFolderFiles } from '../shared/files'

/** Returns baseline btrack bytes keyed by instrument and difficulty. */
export async function getBaselineBTracks(inputRoot: string, relPath: string): Promise<Map<string, Uint8Array>> {
	const files = await loadChartFolderFiles(join(inputRoot, relPath))
	const scanned = scanChartFolder(files, BTRACK_SCAN_CONFIG)
	const tracks = scanned.notesData?.trackHashes ?? []
	return new Map(tracks.flatMap(track => (track.btrack ? [[`${track.instrument}|${track.difficulty}`, track.btrack] as const] : [])))
}

/** Returns working-tree btrack bytes keyed by instrument and difficulty. */
export async function getWorkingTreeBTracks(inputRoot: string, relPath: string): Promise<Map<string, Uint8Array>> {
	const files = await loadChartFolderFiles(join(inputRoot, relPath))
	const scanned = scanChart(files, parseChartAndIni(files), BTRACK_SCAN_CONFIG)
	const tracks = scanned.notesData?.trackHashes ?? []
	return new Map(tracks.flatMap(track => (track.btrack ? [[`${track.instrument}|${track.difficulty}`, track.btrack] as const] : [])))
}
